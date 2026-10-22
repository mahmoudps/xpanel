import { describe, expect, it } from 'vitest'
import { parseGrants, splitSql, unescapeDbPattern } from './grants.ts'
import { cpDomains, parseCpUserFile, parseMailPasswd, parseMailQuota, parseSafeYaml, parseUserdataDomain, parseUserdataMain, parseValiases, phpVersionHint } from './parsers.ts'

describe('grants', () => {
  it('splits statements outside quotes and comments', () => {
    expect(splitSql("GRANT SELECT ON `a;b`.* TO 'u;x'@'h'; -- c;\n/* x; */ CREATE USER 'v'@'h' IDENTIFIED BY PASSWORD '*AB;'; # tail;\n")).toEqual([
      "GRANT SELECT ON `a;b`.* TO 'u;x'@'h'",
      "CREATE USER 'v'@'h' IDENTIFIED BY PASSWORD '*AB;'",
    ])
    expect(splitSql("SELECT 'it\\'s; fine'; SELECT 2")).toEqual(["SELECT 'it\\'s; fine'", 'SELECT 2'])
  })

  it('parses targets, accounts and options', () => {
    const r = parseGrants([
      "GRANT SELECT, INSERT (col1, col2), UPDATE ON `bob\\_db`.* TO 'bob_u'@'localhost' WITH GRANT OPTION",
      "GRANT ALL ON bob_plain.* TO bob_v@'%'",
      "GRANT EXECUTE ON PROCEDURE `bob\\_db`.`p` TO 'bob_u'@'localhost'",
      "CREATE USER IF NOT EXISTS 'bob_w'@'localhost' IDENTIFIED WITH 'mysql_native_password' AS '*HASH'",
      "SET PASSWORD FOR 'bob_u'@'localhost' = '*HASH'",
      'GRANT garbage',
    ].join(';\n'))
    expect(r.grants).toEqual([
      { user: 'bob_u', host: 'localhost', privileges: ['SELECT', 'INSERT (COL1, COL2)', 'UPDATE'], database: 'bob_db', pattern: 'bob\\_db', table: '*', withGrantOption: true },
      { user: 'bob_v', host: '%', privileges: ['ALL'], database: 'bob_plain', pattern: 'bob_plain', table: '*', withGrantOption: false },
    ])
    expect(r.users).toEqual([{ user: 'bob_u', host: 'localhost' }, { user: 'bob_v', host: '%' }, { user: 'bob_w', host: 'localhost' }])
    expect(r.ignored).toBe(3)
    expect(JSON.stringify(r)).not.toContain('HASH')
  })

  it('treats unescaped % as a wildcard pattern', () => {
    expect(unescapeDbPattern('bob\\_db')).toBe('bob_db')
    expect(unescapeDbPattern('bob\\_%')).toBeNull()
    expect(unescapeDbPattern('bob\\%x')).toBe('bob%x')
  })
})

describe('cpmove parsers', () => {
  it('reads cp files strictly', () => {
    const cp = parseCpUserFile('DNS=a.example\nDNS2=c.example\nDNS1=b.example\nlower=x\nCONTACTEMAIL= x@y.example \nBAD=\u0007\nNOEQUALS\n')
    expect(cpDomains(cp)).toEqual(['a.example', 'b.example', 'c.example'])
    expect(cp.get('CONTACTEMAIL')).toBe('x@y.example')
    expect(cp.has('lower')).toBe(false)
    expect(cp.has('BAD')).toBe(false)
  })

  it('reads YAML as strings only, without tags or alias bombs', () => {
    expect(parseSafeYaml('a: 1\nb: true\nc: !!js/function x')).toEqual({ a: '1', b: 'true', c: 'x' })
    const bomb = `a: &a [x,x,x,x,x,x,x,x,x]\nb: &b [${'*a,'.repeat(9)}*a]\nc: &c [${'*b,'.repeat(9)}*b]\nd: [${'*c,'.repeat(9)}*c]\n`
    expect(() => parseSafeYaml(bomb)).toThrow()
    const main = parseUserdataMain('main_domain: Bob.Example\naddon_domains:\n  Shop.Example: shop.bob.example\nparked_domains: []\nsub_domains:\n  - x.bob.example\n')
    expect(main).toEqual({ mainDomain: 'bob.example', addonDomains: new Map([['shop.example', 'shop.bob.example']]), parkedDomains: [], subDomains: ['x.bob.example'] })
  })

  it('classifies valias destinations', () => {
    expect(parseValiases('# c\na@x.example: b@y.example, "|/bin/evil", /var/mail/f, bob, :blackhole:, not an address\n*: :fail: no, really\n')).toEqual([
      { source: 'a@x.example', dests: [{ kind: 'address', address: 'b@y.example' }, { kind: 'pipe' }, { kind: 'file' }, { kind: 'local-user', user: 'bob' }, { kind: 'blackhole' }, { kind: 'invalid', raw: 'not an address' }] },
      { source: '*', dests: [{ kind: 'fail', message: 'no, really' }] },
    ])
  })

  it('maps PHP versions and quotas', () => {
    expect(phpVersionHint('ea-php81')).toBe('8.1')
    expect(phpVersionHint('alt-php74')).toBe('7.4')
    expect(phpVersionHint('php8.2')).toBe('8.2')
    expect(phpVersionHint('inherit')).toBeNull()
    expect(phpVersionHint(null)).toBeNull()
    expect(parseMailQuota('a:100\nb:x\nc:\nd:99999999999999999999\n')).toEqual(new Map([['a', 100]]))
  })

  it('keeps only mailbox names the core rule allows, and never the hash fields', () => {
    const r = parseMailPasswd('info:x:1001:1001::/home/bob/mail/bob.example/info:/home/bob\nInfo2:x:1:1::/x:/y\nsales+eu:x:1:1::/x:/y\na..b:x:1:1::/x:/y\n\ninfo:x:dup\n')
    expect(r).toEqual({ locals: ['info'], rejected: ['Info2', 'sales+eu', 'a..b'] })
  })

  it('reads userdata domain files as strings', () => {
    expect(parseUserdataDomain('documentroot: /home/bob/public_html\nserveralias: www.Bob.example  mail.bob.example\nphpversion: ea-php82\nhomedir: /home/bob\n')).toEqual({
      servername: null, documentroot: '/home/bob/public_html', homedir: '/home/bob', serveralias: ['www.bob.example', 'mail.bob.example'], phpversion: 'ea-php82',
    })
    expect(() => parseUserdataDomain('- a\n- b\n')).toThrow()
  })
})
