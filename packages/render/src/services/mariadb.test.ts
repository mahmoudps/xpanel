import { describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import {
  MARIADB_PRIVILEGES,
  accountDatabasePattern,
  accountUserGrants,
  accountWildcardGrant,
  assertDatabaseName,
  assertDbHost,
  assertDbUser,
  createDatabase,
  createUser,
  dropDatabase,
  dropUser,
  grantPrivileges,
  isTrashDue,
  mysqlNativePasswordHash,
  normalizePrivileges,
  parseTrashComment,
  quoteIdent,
  quoteString,
  restoreDatabase,
  revokePrivileges,
  setUserPassword,
  sqlAction,
  trashDatabase,
  type DbAuth,
} from './mariadb.ts'

const rejects = (fn: () => unknown, pattern?: RegExp): void => {
  let err: unknown
  try {
    fn()
  } catch (e) {
    err = e
  }
  expect(isXpanelError(err), `expected VALIDATION, got ${String(err)}`).toBe(true)
  if (isXpanelError(err)) {
    expect(err.code).toBe('VALIDATION')
    if (pattern) expect(err.message).toMatch(pattern)
  }
}

const native: DbAuth = { plugin: 'mysql_native_password', hash: mysqlNativePasswordHash('password') }

describe('quoting', () => {
  it('quoteString escapes backslash, quote, NUL, CR, LF and ^Z, doubling quotes for NO_BACKSLASH_ESCAPES', () => {
    expect(quoteString("it's")).toBe("'it''s'")
    expect(quoteString('a\\b')).toBe("'a\\\\b'")
    expect(quoteString('nul\u0000x')).toBe("'nul\\0x'")
    expect(quoteString('l1\nl2\r\u001a')).toBe("'l1\\nl2\\r\\Z'")
    expect(quoteString("\\'; DROP DATABASE mysql; -- ")).toBe("'\\\\''; DROP DATABASE mysql; -- '")
  })

  it('quoteIdent backtick-quotes and doubles embedded backticks', () => {
    expect(quoteIdent('alice_wp')).toBe('`alice_wp`')
    expect(quoteIdent('a`b')).toBe('`a``b`')
    rejects(() => quoteIdent(''))
    rejects(() => quoteIdent('a\u0000b'))
    rejects(() => quoteIdent('x'.repeat(65)))
  })

  it('escapes every _ of the database name in GRANT patterns', () => {
    expect(grantPrivileges('alice', 'alice', ['localhost'], 'alice_wp_1', ['SELECT'])).toEqual(["GRANT SELECT ON `alice\\_wp\\_1`.* TO 'alice'@'localhost'"])
  })
})

describe('names', () => {
  it('requires the account prefix on databases and users', () => {
    expect(assertDatabaseName('alice_wp', 'alice')).toBe('alice_wp')
    expect(assertDbUser('alice', 'alice')).toBe('alice')
    expect(assertDbUser('alice_ro', 'alice')).toBe('alice_ro')
    rejects(() => assertDatabaseName('bob_wp', 'alice'), /alice_/)
    rejects(() => assertDatabaseName('alicewp', 'alice'))
    rejects(() => assertDatabaseName('alice_', 'alice'))
    rejects(() => assertDatabaseName('alice_WP', 'alice'))
    rejects(() => assertDatabaseName('alice_w`p', 'alice'))
    rejects(() => assertDatabaseName("alice_w'p", 'alice'))
    rejects(() => assertDatabaseName('alice_w%', 'alice'))
    rejects(() => assertDatabaseName('alice_db.x', 'alice'))
    expect(assertDatabaseName(`alice_${'a'.repeat(57)}`, 'alice')).toHaveLength(63)
    rejects(() => assertDatabaseName(`alice_${'a'.repeat(58)}`, 'alice'), /escaped/)
    rejects(() => assertDatabaseName(`alice_${'a'.repeat(59)}`, 'alice'), /64/)
    // core's suffix rule: starts with a letter or digit
    rejects(() => assertDatabaseName('alice__x', 'alice'))
    rejects(() => assertDbUser('alice__x', 'alice'))
    rejects(() => assertDatabaseName('admin_wp', 'admin'), /reserved/)
    rejects(() => assertDbUser('bob', 'alice'))
    expect(assertDbUser(`alice_${'x'.repeat(26)}`, 'alice')).toHaveLength(32)
    rejects(() => assertDbUser(`alice_${'x'.repeat(27)}`, 'alice'), /32/)
    rejects(() => assertDbUser('alice_x', 'Alice'), /username/)
  })

  it('refuses names that only fit before GRANT escaping', () => {
    const name = `alice_${'a_'.repeat(28)}a`
    expect(name.length).toBeLessThanOrEqual(64)
    rejects(() => assertDatabaseName(name, 'alice'), /escaped/)
  })

  it('validates hosts and makes any-host access explicit', () => {
    expect(assertDbHost('localhost')).toBe('localhost')
    expect(assertDbHost('192.0.2.10')).toBe('192.0.2.10')
    expect(assertDbHost('2001:DB8::1')).toBe('2001:db8::1')
    expect(assertDbHost('::ffff:192.0.2.10')).toBe('192.0.2.10')
    expect(assertDbHost('192.168.1.%')).toBe('192.168.1.%')
    expect(assertDbHost('10.0.0.0/255.255.255.0')).toBe('10.0.0.0/255.255.255.0')
    expect(assertDbHost('App.Example.com')).toBe('app.example.com')
    expect(assertDbHost('%', { allowAnyHost: true })).toBe('%')
    rejects(() => assertDbHost('%'), /explicitly/)
    rejects(() => assertDbHost("localhost' IDENTIFIED BY 'x"))
    rejects(() => assertDbHost('192.168.%.1'))
    rejects(() => assertDbHost('300.1.1.%'))
    rejects(() => assertDbHost('10.0.0.0/garbage'))
    rejects(() => assertDbHost('host_name.example.com'))
  })
})

describe('privileges', () => {
  it('normalizes against the allowlist and expands ALL to it', () => {
    expect(normalizePrivileges(['select', ' insert ', 'Create  Temporary   Tables', 'SELECT'])).toEqual(['SELECT', 'INSERT', 'CREATE TEMPORARY TABLES'])
    expect(normalizePrivileges(['ALL PRIVILEGES'])).toEqual([...MARIADB_PRIVILEGES])
  })

  it('rejects global, grant and unknown privileges', () => {
    for (const p of ['GRANT OPTION', 'FILE', 'SUPER', 'PROCESS', 'CREATE USER', 'RELOAD', 'SHUTDOWN', 'SELECT, FILE', 'SELECT ON *.* TO x', '']) {
      rejects(() => normalizePrivileges([p]), /privilege/)
    }
    rejects(() => normalizePrivileges([]))
    rejects(() => normalizePrivileges([42]))
  })
})

describe('statements', () => {
  it('creates utf8mb4 databases', () => {
    expect(createDatabase('alice_wp', 'alice')).toEqual(['CREATE DATABASE IF NOT EXISTS `alice_wp` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'])
  })

  it('creates users per host from a hash, converging an existing user with ALTER', () => {
    expect(native.hash).toBe('*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19')
    expect(createUser('alice_wp', 'alice', ['localhost', '192.0.2.5'], native, { maxConnections: 20 })).toEqual([
      "CREATE USER IF NOT EXISTS 'alice_wp'@'localhost' IDENTIFIED BY PASSWORD '*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19' WITH MAX_USER_CONNECTIONS 20",
      "ALTER USER 'alice_wp'@'localhost' IDENTIFIED BY PASSWORD '*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19' WITH MAX_USER_CONNECTIONS 20",
      "CREATE USER IF NOT EXISTS 'alice_wp'@'192.0.2.5' IDENTIFIED BY PASSWORD '*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19' WITH MAX_USER_CONNECTIONS 20",
      "ALTER USER 'alice_wp'@'192.0.2.5' IDENTIFIED BY PASSWORD '*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19' WITH MAX_USER_CONNECTIONS 20",
    ])
    const ed: DbAuth = { plugin: 'ed25519', hash: 'A'.repeat(43) }
    expect(setUserPassword('alice', 'alice', ['localhost'], ed)).toEqual([`ALTER USER 'alice'@'localhost' IDENTIFIED VIA ed25519 USING '${'A'.repeat(43)}'`])
  })

  it('never accepts a plaintext or malformed hash', () => {
    rejects(() => createUser('alice_wp', 'alice', ['localhost'], { plugin: 'mysql_native_password', hash: "secret' OR '1" }))
    rejects(() => createUser('alice_wp', 'alice', ['localhost'], { plugin: 'ed25519', hash: 'short' }))
    rejects(() => createUser('alice_wp', 'alice', ['localhost'], { plugin: 'pam', hash: 'x' } as unknown as DbAuth))
    rejects(() => createUser('alice_wp', 'alice', [], native), /hosts/)
    rejects(() => createUser('alice_wp', 'alice', ['localhost'], native, { maxConnections: 0 }))
    rejects(() => mysqlNativePasswordHash(''))
  })

  it('GRANT escapes _ in the database pattern so alice_wp never matches aliceXwp', () => {
    expect(grantPrivileges('alice_wp', 'alice', ['localhost'], 'alice_wp', ['SELECT', 'insert'])).toEqual(["GRANT SELECT, INSERT ON `alice\\_wp`.* TO 'alice_wp'@'localhost'"])
    expect(revokePrivileges('alice_wp', 'alice', ['localhost'], 'alice_wp')).toEqual(["REVOKE ALL PRIVILEGES ON `alice\\_wp`.* FROM 'alice_wp'@'localhost'"])
  })

  it('refuses grants across accounts', () => {
    rejects(() => grantPrivileges('alice_wp', 'alice', ['localhost'], 'bob_wp', ['SELECT']))
    rejects(() => grantPrivileges('bob_wp', 'alice', ['localhost'], 'alice_wp', ['SELECT']))
    rejects(() => grantPrivileges('alice_wp', 'alice', ['localhost'], 'alice_%', ['SELECT']))
    rejects(() => grantPrivileges('alice_wp', 'alice', ['localhost'], '*', ['SELECT']))
  })

  it('confines the account user to <username>\\_% with escaped wildcards', () => {
    expect(accountDatabasePattern('alice')).toBe('alice\\_%')
    expect(accountWildcardGrant('alice', ['localhost'], ['SELECT'])).toEqual(["GRANT SELECT ON `alice\\_%`.* TO 'alice'@'localhost'"])
    expect(accountUserGrants('alice', ['localhost'], ['alice_wp', 'alice_shop'], ['SELECT'])).toEqual([
      "GRANT SELECT ON `alice\\_wp`.* TO 'alice'@'localhost'",
      "GRANT SELECT ON `alice\\_shop`.* TO 'alice'@'localhost'",
    ])
    rejects(() => accountWildcardGrant('a_b', ['localhost']))
    rejects(() => accountWildcardGrant('%', ['localhost']))
  })

  it('drops users and databases idempotently', () => {
    expect(dropUser('alice_wp', 'alice', ['localhost', 'localhost'])).toEqual(["DROP USER IF EXISTS 'alice_wp'@'localhost'"])
    expect(dropDatabase('alice_wp', 'alice')).toEqual(['DROP DATABASE IF EXISTS `alice_wp`'])
    rejects(() => dropDatabase('mysql', 'alice'))
  })
})

describe('trash', () => {
  const grants = [
    { user: 'alice_wp', hosts: ['localhost'], privileges: ['ALL'] },
    { user: 'alice', hosts: ['localhost', '192.0.2.5'], privileges: ['SELECT'] },
  ]
  const at = '2026-10-22T08:00:00.000Z'

  it('revokes every grant and stamps the database comment, without renaming', () => {
    expect(trashDatabase('alice_wp', 'alice', grants, at)).toEqual([
      "REVOKE ALL PRIVILEGES ON `alice\\_wp`.* FROM 'alice_wp'@'localhost'",
      "REVOKE ALL PRIVILEGES ON `alice\\_wp`.* FROM 'alice'@'localhost'",
      "REVOKE ALL PRIVILEGES ON `alice\\_wp`.* FROM 'alice'@'192.0.2.5'",
      "ALTER DATABASE `alice_wp` COMMENT = 'xpanel-trash:2026-10-22T08:00:00.000Z'",
    ])
    rejects(() => trashDatabase('alice_wp', 'alice', grants, "2026-10-22'; DROP"))
  })

  it('restores the grants and clears the stamp', () => {
    const r = restoreDatabase('alice_wp', 'alice', grants)
    expect(r[0]).toBe(`GRANT ${MARIADB_PRIVILEGES.join(', ')} ON \`alice\\_wp\`.* TO 'alice_wp'@'localhost'`)
    expect(r.slice(1)).toEqual([
      "GRANT SELECT ON `alice\\_wp`.* TO 'alice'@'localhost'",
      "GRANT SELECT ON `alice\\_wp`.* TO 'alice'@'192.0.2.5'",
      "ALTER DATABASE `alice_wp` COMMENT = ''",
    ])
  })

  it('knows when retention has passed', () => {
    expect(parseTrashComment(`xpanel-trash:${at}`)).toBe(at)
    expect(parseTrashComment('customer comment')).toBeNull()
    expect(parseTrashComment('xpanel-trash:yesterday')).toBeNull()
    expect(isTrashDue(at, new Date('2026-11-21T07:59:59Z'))).toBe(false)
    expect(isTrashDue(at, new Date('2026-11-21T08:00:00Z'))).toBe(true)
    expect(isTrashDue(at, new Date('2026-10-22T08:00:00Z'), 0)).toBe(true)
    rejects(() => isTrashDue(at, new Date(), -1))
    rejects(() => isTrashDue(at, new Date('nope')), /now/)
  })

  it('wraps statements in the sql HostAction', () => {
    expect(sqlAction(createDatabase('alice_wp', 'alice'))).toEqual({ kind: 'sql', engine: 'mariadb', statements: createDatabase('alice_wp', 'alice') })
    rejects(() => sqlAction([]))
  })
})
