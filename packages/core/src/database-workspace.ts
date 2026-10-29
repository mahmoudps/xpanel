import { fail } from './errors.ts'
import { assertDbNameOwned, dbName, dbUserName } from './rules/naming.ts'
import { assertDbPrivileges, assertId, type DbPrivilege } from './schemas.ts'
import type { DatabaseUser, Id } from './types.ts'

export interface OwnerDatabaseCreateRequest { name: string }
export type OwnerDatabaseUserCreateRequest = { name: string; password: string } & (
  | { databaseId?: never; privileges?: never }
  | { databaseId: Id; privileges: DbPrivilege[] }
)
export interface OwnerDatabaseGrantRequest {
  databaseId: Id
  privileges: DbPrivilege[]
  expectedPrivileges: DbPrivilege[] | null
}
export type DatabaseWorkspaceUser = Pick<DatabaseUser, 'id' | 'name' | 'grants'>

export interface OwnerDatabaseStateRequest { expectedTrashedAt: string | null; confirmation: string }

const requestObject = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('VALIDATION', 'database request must be an object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return fail('VALIDATION', 'database request must be a plain object')
  const extra = Object.keys(value).filter(key => !fields.includes(key))
  if (extra.length > 0) return fail('VALIDATION', 'unsupported database request fields', { fields: extra })
  return value as Record<string, unknown>
}

export const parseOwnerDatabaseCreateRequest = (value: unknown, username: string): OwnerDatabaseCreateRequest => {
  const body = requestObject(value, ['name'])
  // Existing database creation accepts the complete owned name without repairing it.
  if (typeof body.name !== 'string' || body.name.trim() !== body.name) return fail('VALIDATION', 'database name must be a complete owned name')
  return { name: assertDbNameOwned(username, body.name) }
}

export const parseOwnerDatabaseUserCreateRequest = (value: unknown, username: string): OwnerDatabaseUserCreateRequest => {
  const body = requestObject(value, ['name', 'password', 'databaseId', 'privileges'])
  if (typeof body.name !== 'string' || body.name.trim().length === 0) return fail('VALIDATION', 'database user name is required')
  const submitted = body.name.trim().toLowerCase()
  const owned = submitted.startsWith(`${username}_`) ? assertDbNameOwned(username, submitted) : dbName(username, submitted)
  const name = dbUserName(username, owned.slice(username.length + 1))
  // Preserve the existing API's primitive string/UTF-16 length policy. Never trim a password.
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) {
    return fail('VALIDATION', 'database password must be 8 to 256 characters')
  }
  const password = body.password
  const hasDatabase = Object.hasOwn(body, 'databaseId')
  const hasPrivileges = Object.hasOwn(body, 'privileges')
  if (!hasDatabase) {
    if (hasPrivileges) return fail('VALIDATION', 'privileges require a databaseId')
    return { name, password }
  }
  // assertId supplies the existing UUID grammar/canonical case; exact length also excludes a trailing newline.
  if (typeof body.databaseId !== 'string' || body.databaseId.length !== 36) return fail('VALIDATION', 'invalid databaseId')
  const databaseId = assertId(body.databaseId, 'databaseId')
  const inputPrivileges = hasPrivileges ? body.privileges : ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
  if (!Array.isArray(inputPrivileges) || inputPrivileges.some(privilege => typeof privilege !== 'string')) {
    return fail('VALIDATION', 'privileges must be a non-empty list of known privileges')
  }
  return { name, password, databaseId, privileges: assertDbPrivileges(inputPrivileges) }
}

export const parseOwnerDatabaseGrantRequest = (value: unknown): OwnerDatabaseGrantRequest => {
  const body = requestObject(value, ['databaseId', 'privileges', 'expectedPrivileges'])
  if (typeof body.databaseId !== 'string' || body.databaseId.length !== 36) return fail('VALIDATION', 'invalid databaseId')
  const databaseId = assertId(body.databaseId, 'databaseId')
  if (!Object.hasOwn(body, 'expectedPrivileges')) return fail('VALIDATION', 'expectedPrivileges is required')
  const privileges = (input: unknown): DbPrivilege[] => {
    if (!Array.isArray(input) || input.some(privilege => typeof privilege !== 'string')) {
      return fail('VALIDATION', 'privileges must be a non-empty list of known privileges')
    }
    return assertDbPrivileges(input)
  }
  return {
    databaseId,
    privileges: privileges(body.privileges),
    expectedPrivileges: body.expectedPrivileges === null ? null : privileges(body.expectedPrivileges),
  }
}

export const parseOwnerDatabaseStateRequest = (value: unknown, action: 'trash' | 'restore'): OwnerDatabaseStateRequest => {
  const body = requestObject(value, ['expectedTrashedAt', 'confirmation'])
  if (!Object.hasOwn(body, 'expectedTrashedAt')) return fail('VALIDATION', 'expectedTrashedAt is required')
  const expected = body.expectedTrashedAt
  if (action === 'trash' ? expected !== null : typeof expected !== 'string'
    || !Number.isFinite(Date.parse(expected)) || new Date(expected).toISOString() !== expected) {
    return fail('VALIDATION', 'expectedTrashedAt must identify the selected database state')
  }
  if (typeof body.confirmation !== 'string' || body.confirmation.length === 0 || body.confirmation.trim() !== body.confirmation
    || /[\u0000-\u001f\u007f]/.test(body.confirmation)) return fail('VALIDATION', 'database name confirmation is required')
  return { expectedTrashedAt: expected as string | null, confirmation: body.confirmation }
}

/** Explicit projection prevents stored authentication fields from entering workspace responses. */
export const projectDatabaseWorkspaceUser = (user: DatabaseUser): DatabaseWorkspaceUser => ({
  id: user.id,
  name: user.name,
  grants: user.grants.map(grant => ({ databaseId: grant.databaseId, privileges: [...grant.privileges] })),
})
