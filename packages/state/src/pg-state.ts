// PostgreSQL desired state: account databases (`Database` with engine 'postgresql' and a fixed owner role)
// under accounts/<user>/postgresql/databases, and login roles under accounts/<user>/postgresql/users that
// keep a SCRAM-SHA-256 verifier, never the password.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { assertDbNameOwned, assertId, assertIsoDate, dbUserName, fail } from '@xpanel/core'
import type { Database, Id } from '@xpanel/core'
import type { StoredAccount } from './types.ts'

export interface PostgresqlUser { id: Id; accountId: Id; name: string }
export interface StoredPostgresqlUser extends PostgresqlUser { authPlugin: 'scram-sha-256'; authString: string }

/** Login roles follow the database user rule (`<username>_<suffix>`, 32 characters); PostgreSQL reserves `pg_` role names. */
export const assertPostgresqlRoleName = (username: string, name: unknown): string => {
  const owned = assertDbNameOwned(username, name)
  const role = dbUserName(username, owned.slice(username.length + 1))
  return role.startsWith('pg_') ? fail('VALIDATION', 'PostgreSQL reserves role names that start with pg_') : role
}

// shortcut: printable ASCII only, so SASLprep (RFC 4013) leaves the password unchanged; widen once SASLprep is implemented.
const PASSWORD = /^[\x20-\x7e]{8,256}$/
export const assertPostgresqlPassword = (password: unknown): string =>
  typeof password === 'string' && PASSWORD.test(password) ? password : fail('VALIDATION', 'PostgreSQL passwords must be 8 to 256 printable ASCII characters', { stateChanged: false })

/** The form PostgreSQL stores in pg_authid.rolpassword: SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>. */
const VERIFIER = /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/
export const assertPostgresqlVerifier = (value: unknown): string =>
  typeof value === 'string' && VERIFIER.test(value) ? value : fail('VALIDATION', 'PostgreSQL authentication must be a SCRAM-SHA-256 verifier')

/** RFC 5802 / RFC 7677 keys with 4096 iterations and a 16-byte salt, as PostgreSQL computes them itself. */
export const scramSha256Verifier = (password: string, salt: Buffer): string => {
  if (salt.length !== 16) return fail('VALIDATION', 'SCRAM salt must be 16 bytes')
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256')
  const hmac = (text: string): Buffer => createHmac('sha256', salted).update(text).digest()
  const storedKey = createHash('sha256').update(hmac('Client Key')).digest()
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey.toString('base64')}:${hmac('Server Key').toString('base64')}`
}
export const postgresqlScramVerifier = (password: unknown, salt: Buffer = randomBytes(16)): string => scramSha256Verifier(assertPostgresqlPassword(password), salt)

const record = (value: unknown, what: string): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('VALIDATION', what + ' must be an object')

export const validatePostgresqlUserFile = (value: unknown, account: StoredAccount): StoredPostgresqlUser => {
  const user = record(value, 'PostgreSQL user')
  if (assertId(user.accountId, 'accountId') !== account.id || user.authPlugin !== 'scram-sha-256') fail('VALIDATION', 'PostgreSQL user does not match its account')
  return { id: assertId(user.id, 'id'), accountId: account.id, name: assertPostgresqlRoleName(account.username, user.name), authPlugin: 'scram-sha-256', authString: assertPostgresqlVerifier(user.authString) }
}

/** `owners` are the account's saved PostgreSQL user names; the owner is fixed when the database is created. */
export const validatePostgresqlDatabaseFile = (value: unknown, account: StoredAccount, owners: ReadonlySet<string>): Database => {
  const database = record(value, 'PostgreSQL database')
  if (assertId(database.accountId, 'accountId') !== account.id || database.engine !== 'postgresql') fail('VALIDATION', 'PostgreSQL database does not match its account')
  const owner = assertPostgresqlRoleName(account.username, database.owner)
  if (!owners.has(owner)) fail('VALIDATION', 'PostgreSQL database owner is not a saved PostgreSQL user of the account')
  return {
    id: assertId(database.id, 'id'), accountId: account.id, engine: 'postgresql', name: assertDbNameOwned(account.username, database.name), owner,
    trashedAt: database.trashedAt == null ? null : assertIsoDate(database.trashedAt, 'trashedAt').toISOString(),
  }
}

export const toPublicPostgresqlUser = (user: StoredPostgresqlUser): PostgresqlUser => ({ id: user.id, accountId: user.accountId, name: user.name })
