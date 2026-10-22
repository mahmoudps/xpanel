import { and, asc, count, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm'
import { assertCapAvailable, assertDbNameOwned, dbUserName, fail } from '@xpanel/core'
import type { Database, DatabaseUser, Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withPgErrors } from '../pg-errors.ts'
import { databaseGrants, databases, databaseUsers } from '../schema.ts'
import { lockAccount, lockPlan } from './accounts.ts'
import { assertId, first, isUuid, mustExist } from './util.ts'

/** Mirrors the database_grants CHECK in 0001_init.sql (MariaDB database-level privileges). */
export const DB_PRIVILEGES = [
  'ALL PRIVILEGES',
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
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
  'REFERENCES',
] as const

export type DbPrivilege = (typeof DB_PRIVILEGES)[number]

type DbRow = typeof databases.$inferSelect

const dbFromRow = (r: DbRow): Database => ({
  id: r.id,
  accountId: r.accountId,
  engine: r.engine,
  name: r.name,
  trashedAt: r.trashedAt ? r.trashedAt.toISOString() : null,
})

/** Live databases count against caps.databases; trashed ones are on their way out. */
const assertDatabaseCap = async (tx: Db, accountId: Id, planId: Id): Promise<void> => {
  const plan = await lockPlan(tx, planId)
  const [row] = await tx
    .select({ n: count() })
    .from(databases)
    .where(and(eq(databases.accountId, accountId), isNull(databases.trashedAt)))
  assertCapAvailable(plan, { databases: row?.n ?? 0 }, 'databases')
}

/** `<username>_<suffix>` by core's naming rules; refused past the plan's database cap. */
export const createDatabase = (db: Db, input: { accountId: Id; name: string }): Promise<Database> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      const account = await lockAccount(tx, input.accountId)
      const name = assertDbNameOwned(account.username, input.name)
      await assertDatabaseCap(tx, account.id, account.planId)
      const [row] = await tx.insert(databases).values({ accountId: account.id, name, engine: 'mariadb' }).returning()
      return dbFromRow(mustExist(row, 'database', name))
    }),
  )

export const getDatabase = async (db: Db, id: Id): Promise<Database | null> => {
  if (!isUuid(id)) return null
  const row = first(await db.select().from(databases).where(eq(databases.id, id)))
  return row ? dbFromRow(row) : null
}

export const listDatabases = async (db: Db, accountId: Id, opts: { includeTrashed?: boolean } = {}): Promise<Database[]> => {
  if (!isUuid(accountId)) return []
  const rows = await db
    .select()
    .from(databases)
    .where(and(eq(databases.accountId, accountId), opts.includeTrashed ? undefined : isNull(databases.trashedAt)))
    .orderBy(asc(databases.name))
  return rows.map(dbFromRow)
}

/** Moves a database to the MariaDB trash; it is dropped only after retention. */
export const trashDatabase = (db: Db, id: Id): Promise<Database> =>
  withPgErrors(async () => {
    const [row] = await db
      .update(databases)
      .set({ trashedAt: new Date() })
      .where(and(eq(databases.id, assertId(id, 'id')), isNull(databases.trashedAt)))
      .returning()
    return row ? dbFromRow(row) : mustExist(await getDatabase(db, id), 'database', id)
  })

/** Back from the trash; it counts against the database cap again. */
export const restoreDatabase = (db: Db, id: Id): Promise<Database> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      const found = mustExist(await getDatabase(tx, assertId(id, 'id')), 'database', id)
      const account = await lockAccount(tx, found.accountId)
      const current = mustExist(await getDatabase(tx, found.id), 'database', id)
      if (current.trashedAt === null) return current
      await assertDatabaseCap(tx, account.id, account.planId)
      const [row] = await tx.update(databases).set({ trashedAt: null }).where(eq(databases.id, current.id)).returning()
      return dbFromRow(mustExist(row, 'database', id))
    }),
  )

/** Trashed databases whose retention ended, for the purge job. */
export const listTrashedDatabasesBefore = async (db: Db, cutoff: Date): Promise<Database[]> =>
  (await db.select().from(databases).where(and(isNotNull(databases.trashedAt), lt(databases.trashedAt, cutoff)))).map(dbFromRow)

/** Final removal: only a database already in the trash. */
export const purgeDatabase = (db: Db, id: Id): Promise<boolean> =>
  withPgErrors(async () => {
    const current = await getDatabase(db, id)
    if (!current) return false
    if (current.trashedAt === null) fail('PRECONDITION_FAILED', 'move the database to the trash first')
    const rows = await db.delete(databases).where(and(eq(databases.id, current.id), isNotNull(databases.trashedAt))).returning({ id: databases.id })
    return rows.length > 0
  })

// ---------------------------------------------------------------- users and grants

export interface NewDatabaseUser {
  accountId: Id
  name: string
  /** MariaDB authentication string (hash) */
  authString: string
  authPlugin?: 'mysql_native_password' | 'ed25519'
}

const AUTH_RE = /^[A-Za-z0-9*+/=]{1,128}$/

const assertAuth = (plugin: unknown, auth: unknown): { authPlugin: 'mysql_native_password' | 'ed25519'; authString: string } => {
  const p = plugin ?? 'mysql_native_password'
  if (p !== 'mysql_native_password' && p !== 'ed25519') return fail('VALIDATION', 'authPlugin must be mysql_native_password or ed25519')
  if (typeof auth !== 'string' || !AUTH_RE.test(auth)) return fail('VALIDATION', 'authString must be a MariaDB hash')
  if (p === 'mysql_native_password' && !/^\*[0-9A-F]{40}$/.test(auth)) return fail('VALIDATION', 'mysql_native_password hash is * + 40 hex')
  return { authPlugin: p, authString: auth }
}

const assertPrivileges = (privs: unknown): DbPrivilege[] => {
  if (!Array.isArray(privs) || privs.length === 0) return fail('VALIDATION', 'privileges must be a non-empty list')
  for (const p of privs) if (!(DB_PRIVILEGES as readonly string[]).includes(p as string)) fail('VALIDATION', 'unknown privilege', { privilege: String(p) })
  const set = [...new Set(privs as DbPrivilege[])]
  return set.includes('ALL PRIVILEGES') ? ['ALL PRIVILEGES'] : set.sort()
}

const loadGrants = async (db: Db, userIds: string[]) =>
  userIds.length === 0 ? [] : db.select().from(databaseGrants).where(inArray(databaseGrants.databaseUserId, userIds))

const usersWithGrants = async (db: Db, rows: (typeof databaseUsers.$inferSelect)[]): Promise<DatabaseUser[]> => {
  const grants = await loadGrants(db, rows.map((r) => r.id))
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    name: r.name,
    grants: grants
      .filter((g) => g.databaseUserId === r.id)
      .map((g) => ({ databaseId: g.databaseId, privileges: g.privileges }))
      .sort((a, b) => a.databaseId.localeCompare(b.databaseId)),
  }))
}

/** `<username>_<suffix>` within the MySQL-compatible user-name limit (core's dbUserName). */
export const createDatabaseUser = (db: Db, input: NewDatabaseUser): Promise<DatabaseUser> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      const account = await lockAccount(tx, input.accountId)
      const owned = assertDbNameOwned(account.username, input.name)
      const name = dbUserName(account.username, owned.slice(account.username.length + 1))
      const auth = assertAuth(input.authPlugin, input.authString)
      const [row] = await tx.insert(databaseUsers).values({ accountId: account.id, name, ...auth }).returning()
      return { id: mustExist(row, 'database user', name).id, accountId: account.id, name, grants: [] }
    }),
  )

export const getDatabaseUser = async (db: Db, id: Id): Promise<DatabaseUser | null> => {
  if (!isUuid(id)) return null
  const rows = await db.select().from(databaseUsers).where(eq(databaseUsers.id, id))
  return (await usersWithGrants(db, rows))[0] ?? null
}

export const listDatabaseUsers = async (db: Db, accountId: Id): Promise<DatabaseUser[]> => {
  if (!isUuid(accountId)) return []
  const rows = await db.select().from(databaseUsers).where(eq(databaseUsers.accountId, accountId)).orderBy(asc(databaseUsers.name))
  return usersWithGrants(db, rows)
}

export const setDatabaseUserAuth = (db: Db, id: Id, authString: string, authPlugin?: 'mysql_native_password' | 'ed25519'): Promise<void> =>
  withPgErrors(async () => {
    const rows = await db
      .update(databaseUsers)
      .set(assertAuth(authPlugin, authString))
      .where(eq(databaseUsers.id, assertId(id, 'id')))
      .returning({ id: databaseUsers.id })
    mustExist(rows[0], 'database user', id)
  })

/** Grants (or replaces) privileges; the composite keys reject a database of another account. */
export const setGrant = (db: Db, input: { databaseUserId: Id; databaseId: Id; privileges: string[] }): Promise<DatabaseUser> =>
  withPgErrors(async () => {
    const userId = assertId(input.databaseUserId, 'databaseUserId')
    const databaseId = assertId(input.databaseId, 'databaseId')
    const privileges = assertPrivileges(input.privileges)
    const user = mustExist(first(await db.select().from(databaseUsers).where(eq(databaseUsers.id, userId))), 'database user', userId)
    const target = mustExist(await getDatabase(db, databaseId), 'database', databaseId)
    if (target.accountId !== user.accountId) fail('FORBIDDEN', 'database belongs to another account')
    if (target.trashedAt !== null) fail('PRECONDITION_FAILED', 'database is in the trash')
    await db
      .insert(databaseGrants)
      .values({ databaseUserId: userId, databaseId, accountId: user.accountId, privileges })
      .onConflictDoUpdate({ target: [databaseGrants.databaseUserId, databaseGrants.databaseId], set: { privileges } })
    return mustExist(await getDatabaseUser(db, userId), 'database user', userId)
  })

export const revokeGrant = (db: Db, databaseUserId: Id, databaseId: Id): Promise<boolean> =>
  withPgErrors(async () => {
    if (!isUuid(databaseUserId) || !isUuid(databaseId)) return false
    const rows = await db
      .delete(databaseGrants)
      .where(and(eq(databaseGrants.databaseUserId, databaseUserId), eq(databaseGrants.databaseId, databaseId)))
      .returning({ id: databaseGrants.databaseId })
    return rows.length > 0
  })

export const deleteDatabaseUser = (db: Db, id: Id): Promise<boolean> =>
  withPgErrors(async () => {
    if (!isUuid(id)) return false
    const rows = await db.delete(databaseUsers).where(eq(databaseUsers.id, id)).returning({ id: databaseUsers.id })
    return rows.length > 0
  })
