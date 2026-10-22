// MariaDB (10.5+: Ubuntu 22.04/24.04, CentOS Stream 9/10) statement builders. Identifiers
// are validated then backtick-quoted; values go through quoteString. Database names in
// GRANT/REVOKE are patterns, so their `_` is escaped (core's dbGrantPattern).
import type { HostAction } from '@xpanel/core'
import { DB_NAME_MAX, DB_USER_MAX, assertDbNameOwned, dbGrantPattern, parseIp } from '@xpanel/core'
import { createHash } from 'node:crypto'
import { assertDate, assertInt, assertString, assertUsername, invalid, ipText, labeled, normalizeHostname } from './validate.ts'

export const MAX_DB_HOSTS = 20

/** Database-level privileges an account may hand out. GRANT OPTION and global privileges never. */
export const MARIADB_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'REFERENCES',
  'INDEX',
  'ALTER',
  'CREATE TEMPORARY TABLES',
  'LOCK TABLES',
  'EXECUTE',
  'CREATE VIEW',
  'SHOW VIEW',
  'CREATE ROUTINE',
  'ALTER ROUTINE',
  'EVENT',
  'TRIGGER',
  'DELETE HISTORY',
] as const

export type MariadbPrivilege = (typeof MARIADB_PRIVILEGES)[number]

export const quoteIdent = (name: string): string => {
  if (typeof name !== 'string' || name.length === 0 || name.length > DB_NAME_MAX || name.includes('\u0000')) {
    return invalid('SQL identifier', name, `must be 1..${DB_NAME_MAX} characters without NUL`)
  }
  return `\`${name.replace(/`/g, '``')}\``
}

/**
 * String literal that stays inert under any sql_mode: `'` is doubled (so
 * NO_BACKSLASH_ESCAPES cannot turn `\'` into a terminator); backslash, NUL, CR, LF and ^Z
 * are backslash-escaped.
 */
export const quoteString = (v: string): string => {
  if (typeof v !== 'string') return invalid('SQL string', v, 'must be a string')
  let r = "'"
  for (const ch of v) {
    if (ch === "'") r += "''"
    else if (ch === '\\') r += '\\\\'
    else if (ch === '\u0000') r += '\\0'
    else if (ch === '\n') r += '\\n'
    else if (ch === '\r') r += '\\r'
    else if (ch === '\u001a') r += '\\Z'
    else r += ch
  }
  return `${r}'`
}

const ownedName = (what: string, name: unknown, username: string): string => {
  const u = assertUsername(username)
  const s = assertString(what, name, 128)
  return labeled(what, s, () => assertDbNameOwned(u, s))
}

/**
 * `<username>_<suffix>` by core's naming rule. GRANT stores the escaped pattern in
 * mysql.db.Db (CHAR(64)), so the name must also fit once every `_` is escaped: a longer
 * pattern would be cut and could then match other databases.
 */
export const assertDatabaseName = (name: unknown, username: string): string => {
  const s = ownedName('database name', name, username)
  if (dbGrantPattern(s).length > DB_NAME_MAX) return invalid('database name', s, `is longer than ${DB_NAME_MAX} characters once "_" is escaped for GRANT`)
  return s
}

/** The account's own user (`<username>`) or `<username>_<suffix>`, at most 32 characters. */
export const assertDbUser = (name: unknown, username: string): string => {
  const u = assertUsername(username)
  if (name === u) return u
  const s = ownedName('database user', name, u)
  if (s.length > DB_USER_MAX) return invalid('database user', s, `longer than ${DB_USER_MAX} characters`)
  return s
}

const wildOctets = (s: string): boolean => {
  const m = /^((?:\d{1,3}\.){1,3})%$/.exec(s)
  if (!m) return false
  const parts = (m[1] as string).slice(0, -1).split('.')
  return parts.every((p) => Number(p) <= 255 && !(p.length > 1 && p.startsWith('0')))
}

export interface DbHostOptions {
  /** allow the bare `%` (any host); remote MySQL from anywhere is opt-in */
  allowAnyHost?: boolean
}

/** localhost, an IP, `192.168.1.%`, `10.0.0.0/255.255.255.0` or a hostname. */
export const assertDbHost = (host: unknown, o: DbHostOptions = {}): string => {
  const s = assertString('database host', host, 255)
  if (s === 'localhost') return s
  if (s === '%') return o.allowAnyHost ? s : invalid('database host', s, 'any-host access must be enabled explicitly')
  const ip = parseIp(s)
  if (ip) return ipText(ip)
  if (wildOctets(s)) return s
  const mask = /^([\d.]+)\/([\d.]+)$/.exec(s)
  if (mask) {
    const isV4 = (x: string): boolean => parseIp(x)?.version === 4
    if (!isV4(mask[1] as string) || !isV4(mask[2] as string)) return invalid('database host', s, 'must be ip/netmask')
    return s
  }
  return normalizeHostname(s, 'database host')
}

const hostsOf = (hosts: unknown, o: DbHostOptions): string[] => {
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > MAX_DB_HOSTS) {
    return invalid('database hosts', hosts, `need 1 to ${MAX_DB_HOSTS} hosts`)
  }
  return [...new Set(hosts.map((h) => assertDbHost(h, o)))]
}

const account = (user: string, host: string): string => `${quoteString(user)}@${quoteString(host)}`

/** Normalize a requested privilege list against the allowlist; `ALL` expands to the allowlist. */
export const normalizePrivileges = (privs: unknown): MariadbPrivilege[] => {
  if (!Array.isArray(privs) || privs.length === 0) return invalid('privileges', privs, 'need at least one privilege')
  const out = new Set<MariadbPrivilege>()
  for (const p of privs) {
    const s = typeof p === 'string' ? p.trim().toUpperCase().replace(/\s+/g, ' ') : ''
    if (s === 'ALL' || s === 'ALL PRIVILEGES') MARIADB_PRIVILEGES.forEach((x) => out.add(x))
    else if ((MARIADB_PRIVILEGES as readonly string[]).includes(s)) out.add(s as MariadbPrivilege)
    else invalid('privilege', p, 'is not an allowed database privilege')
  }
  return MARIADB_PRIVILEGES.filter((p) => out.has(p))
}

export type DbAuth = { plugin: 'mysql_native_password'; hash: string } | { plugin: 'ed25519'; hash: string }

/** `*` + HEX(SHA1(SHA1(pw))): lets statements carry a hash, never the password. */
export const mysqlNativePasswordHash = (password: string): string => {
  const pw = assertString('password', password, 1024)
  if (pw.length === 0) return invalid('password', '', 'is empty')
  const inner = createHash('sha1').update(pw, 'utf8').digest()
  return `*${createHash('sha1').update(inner).digest('hex').toUpperCase()}`
}

const authClause = (a: DbAuth): string => {
  if (!a || typeof a !== 'object') return invalid('database auth', a, 'is required')
  if (a.plugin === 'mysql_native_password') {
    if (!/^\*[0-9A-F]{40}$/.test(a.hash)) return invalid('password hash', '[redacted]', 'must be *<40 uppercase hex>')
    return `IDENTIFIED BY PASSWORD ${quoteString(a.hash)}`
  }
  if (a.plugin === 'ed25519') {
    if (!/^[A-Za-z0-9+/]{43}$/.test(a.hash)) return invalid('password hash', '[redacted]', 'must be a 43-character ed25519 hash')
    return `IDENTIFIED VIA ed25519 USING ${quoteString(a.hash)}`
  }
  return invalid('auth plugin', (a as { plugin: unknown }).plugin, 'must be mysql_native_password or ed25519')
}

export interface DbUserOptions extends DbHostOptions {
  maxConnections?: number
}

const withClause = (o: DbUserOptions): string =>
  o.maxConnections === undefined ? '' : ` WITH MAX_USER_CONNECTIONS ${assertInt('max connections', o.maxConnections, 1, 10000)}`

export const createDatabase = (name: string, username: string): string[] => [
  `CREATE DATABASE IF NOT EXISTS ${quoteIdent(assertDatabaseName(name, username))} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
]

/** Idempotent: create if missing, then ALTER so an existing user converges to the same password. */
export const createUser = (user: string, username: string, hosts: string[], auth: DbAuth, o: DbUserOptions = {}): string[] => {
  const u = assertDbUser(user, username)
  const clause = authClause(auth)
  const w = withClause(o)
  return hostsOf(hosts, o).flatMap((h) => [`CREATE USER IF NOT EXISTS ${account(u, h)} ${clause}${w}`, `ALTER USER ${account(u, h)} ${clause}${w}`])
}

export const setUserPassword = (user: string, username: string, hosts: string[], auth: DbAuth, o: DbHostOptions = {}): string[] => {
  const u = assertDbUser(user, username)
  const clause = authClause(auth)
  return hostsOf(hosts, o).map((h) => `ALTER USER ${account(u, h)} ${clause}`)
}

export const dropUser = (user: string, username: string, hosts: string[], o: DbHostOptions = {}): string[] => {
  const u = assertDbUser(user, username)
  return hostsOf(hosts, o).map((h) => `DROP USER IF EXISTS ${account(u, h)}`)
}

const dbPattern = (db: string): string => `${quoteIdent(dbGrantPattern(db))}.*`

/** GRANT on exactly one of the account's databases. */
export const grantPrivileges = (user: string, username: string, hosts: string[], database: string, privileges: string[], o: DbHostOptions = {}): string[] => {
  const u = assertDbUser(user, username)
  const db = assertDatabaseName(database, username)
  const privs = normalizePrivileges(privileges).join(', ')
  return hostsOf(hosts, o).map((h) => `GRANT ${privs} ON ${dbPattern(db)} TO ${account(u, h)}`)
}

/** Fails with ER_NONEXISTING_GRANT when nothing was granted: issue only for grants that exist. */
export const revokePrivileges = (user: string, username: string, hosts: string[], database: string, o: DbHostOptions = {}): string[] => {
  const u = assertDbUser(user, username)
  const db = assertDatabaseName(database, username)
  return hostsOf(hosts, o).map((h) => `REVOKE ALL PRIVILEGES ON ${dbPattern(db)} FROM ${account(u, h)}`)
}

/** `alice\_%`: every database of the account and nothing of `alicex_*` or `alice2_*` (usernames hold no wildcard). */
export const accountDatabasePattern = (username: string): string => `${assertUsername(username)}\\_%`

/**
 * Wildcard grant for the account's own user. It also covers trashed databases, and its
 * CREATE lets the user `CREATE DATABASE alice_x` outside the plan's database cap, so the
 * reconciler should prefer accountUserGrants, which trash can revoke per database.
 */
export const accountWildcardGrant = (username: string, hosts: string[], privileges: string[] = ['ALL'], o: DbHostOptions = {}): string[] => {
  const u = assertUsername(username)
  const privs = normalizePrivileges(privileges).join(', ')
  return hostsOf(hosts, o).map((h) => `GRANT ${privs} ON ${quoteIdent(accountDatabasePattern(u))}.* TO ${account(u, h)}`)
}

/** Explicit per-database grants for the account's own user. */
export const accountUserGrants = (username: string, hosts: string[], databases: string[], privileges: string[] = ['ALL'], o: DbHostOptions = {}): string[] =>
  databases.flatMap((d) => grantPrivileges(username, username, hosts, d, privileges, o))

// ---- trash ------------------------------------------------------------------------------------

export const TRASH_COMMENT_PREFIX = 'xpanel-trash:'
export const DEFAULT_TRASH_RETENTION_DAYS = 30

export interface DbGrant {
  user: string
  hosts: string[]
  privileges: string[]
}

const assertIsoInstant = (what: string, v: unknown): string => {
  const s = assertString(what, v, 40)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(s) || Number.isNaN(Date.parse(s))) {
    return invalid(what, s, 'must be an ISO-8601 UTC instant')
  }
  return s
}

/**
 * Move to the MariaDB trash without renaming: revoke every grant on it, then stamp the
 * database comment. The reconciler drops it once retention has passed (isTrashDue).
 */
export const trashDatabase = (database: string, username: string, grants: DbGrant[], trashedAt: string, o: DbHostOptions = {}): string[] => {
  const db = assertDatabaseName(database, username)
  const at = assertIsoInstant('trashedAt', trashedAt)
  return [
    ...grants.flatMap((g) => revokePrivileges(g.user, username, g.hosts, db, o)),
    `ALTER DATABASE ${quoteIdent(db)} COMMENT = ${quoteString(`${TRASH_COMMENT_PREFIX}${at}`)}`,
  ]
}

/** Give back the grants recorded at trash time and clear the stamp. */
export const restoreDatabase = (database: string, username: string, grants: DbGrant[], o: DbHostOptions = {}): string[] => {
  const db = assertDatabaseName(database, username)
  return [...grants.flatMap((g) => grantPrivileges(g.user, username, g.hosts, db, g.privileges, o)), `ALTER DATABASE ${quoteIdent(db)} COMMENT = ''`]
}

export const dropDatabase = (database: string, username: string): string[] => [`DROP DATABASE IF EXISTS ${quoteIdent(assertDatabaseName(database, username))}`]

export const parseTrashComment = (comment: string | null | undefined): string | null => {
  if (!comment?.startsWith(TRASH_COMMENT_PREFIX)) return null
  const at = comment.slice(TRASH_COMMENT_PREFIX.length)
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at) && !Number.isNaN(Date.parse(at)) ? at : null
}

export const isTrashDue = (trashedAt: string, now: Date, retentionDays = DEFAULT_TRASH_RETENTION_DAYS): boolean => {
  const at = Date.parse(assertIsoInstant('trashedAt', trashedAt))
  const days = assertInt('retention days', retentionDays, 0, 3650)
  return assertDate('now', now).getTime() - at >= days * 86400000
}

export const sqlAction = (statements: string[]): HostAction => {
  if (statements.length === 0) return invalid('SQL action', '', 'has no statements')
  return { kind: 'sql', engine: 'mariadb', statements }
}
