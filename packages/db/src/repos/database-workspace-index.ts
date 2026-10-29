import { assertDbNameOwned, assertId, fail, type Account, type Database } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'

const databaseColumns = ['id', 'account_id', 'engine', 'name', 'trashed_at', 'created_at'] as const
const searchColumns = ['kind', 'entity_id', 'account_id', 'owner_id', 'title', 'subtitle', 'keywords'] as const
type DatabaseRow = Record<(typeof databaseColumns)[number], unknown> & { checkpoint_rowid: string }
type SearchRow = Record<(typeof searchColumns)[number], unknown> & { checkpoint_rowid: string }
interface Snapshot { databases: DatabaseRow[]; search: SearchRow[] }
const absent = (snapshot: Snapshot): boolean => snapshot.databases.length === 0 && snapshot.search.length === 0
const same = (left: Snapshot, right: Snapshot): boolean => JSON.stringify(left) === JSON.stringify(right)
const captureDatabaseIndex = async (tx: Db, id: string, name: string): Promise<Snapshot> => ({
  databases: await tx.query<DatabaseRow>(
    `SELECT CAST(rowid AS TEXT) AS checkpoint_rowid, ${databaseColumns.join(', ')}
     FROM idx_databases WHERE id = $1 OR lower(name) = lower($2) ORDER BY rowid`, [id, name],
  ),
  search: await tx.query<SearchRow>(
    `SELECT CAST(rowid AS TEXT) AS checkpoint_rowid, ${searchColumns.join(', ')}
     FROM search_fts WHERE kind = 'database' AND (entity_id = $1 OR lower(title) = lower($2)) ORDER BY rowid`, [id, name],
  ),
})

/** Creation-only projection prepared read-only under the caller's trusted state lease. */
export const prepareDatabaseIndexCreation = async (
  db: Db, account: Account, database: Database,
): Promise<{ apply(): Promise<void>; rollback(): Promise<void> }> => {
  const accountId = assertId(account.id, 'accountId')
  const id = assertId(database.id, 'databaseId')
  if (assertId(database.accountId, 'accountId') !== accountId) fail('FORBIDDEN', 'database projection scope is unavailable')
  if (database.engine !== 'mariadb') fail('VALIDATION', 'database projection engine is unsupported')
  if (database.trashedAt !== null) fail('PRECONDITION_FAILED', 'database creation projection requires a live new database')
  if (typeof database.name !== 'string' || database.name.trim() !== database.name) fail('VALIDATION', 'database projection name is invalid')
  const name = assertDbNameOwned(account.username, database.name)
  // Pin every scalar before the first await; later caller changes cannot alter the accepted projection.
  const values = [id, accountId, database.engine, name, null, account.createdAt]
  const search = ['database', id, accountId, account.ownerId ?? '', name, account.username, database.engine]
  const capture = (tx: Db): Promise<Snapshot> => captureDatabaseIndex(tx, id, name)
  await withSqliteErrors(() => db.transaction(async tx => {
    if (!absent(await capture(tx))) fail('CONFLICT', 'database projection conflicts with an existing index entry')
  }))

  let attempted = false
  let postimage: Snapshot | null = null
  return {
    async apply(): Promise<void> {
      if (attempted) fail('PRECONDITION_FAILED', 'database projection was already attempted')
      attempted = true
      await withSqliteErrors(() => db.transaction(async tx => {
        if (!absent(await capture(tx))) fail('CONFLICT', 'database projection changed after preparation')
        await tx.query(
          `INSERT INTO idx_databases (${databaseColumns.join(', ')}) VALUES ($1, $2, $3, $4, $5, $6)`, values,
        )
        await tx.query(
          `INSERT INTO search_fts (${searchColumns.join(', ')}) VALUES ($1, $2, $3, $4, $5, $6, $7)`, search,
        )
        const written = await capture(tx)
        if (written.databases.length !== 1 || written.search.length !== 1) fail('CONFLICT', 'database projection requires verification')
        // Kept even if COMMIT acknowledgement fails, allowing only an exact current-postimage rollback.
        postimage = written
      }))
    },
    async rollback(): Promise<void> {
      if (!attempted) return
      const acceptedPostimage = postimage
      await withSqliteErrors(() => db.transaction(async tx => {
        const current = await capture(tx)
        if (absent(current)) return
        if (!acceptedPostimage || !same(current, acceptedPostimage)) return fail('CONFLICT', 'database projection rollback requires verification')
        await tx.query('DELETE FROM search_fts WHERE rowid = $1', [acceptedPostimage.search[0]!.checkpoint_rowid])
        await tx.query('DELETE FROM idx_databases WHERE rowid = $1 AND id = $2', [acceptedPostimage.databases[0]!.checkpoint_rowid, id])
        if (!absent(await capture(tx))) fail('CONFLICT', 'database projection rollback requires verification')
      }))
      // Do not clear the checkpoint after an uncertain rollback acknowledgement.
      attempted = false
      postimage = null
    },
  }
}

/** Soft-trash/restore projection only; existing search rows are preserved, never repaired. */
export const prepareDatabaseIndexTransition = async (
  db: Db, account: Account, before: Database, after: Database,
): Promise<{ apply(): Promise<void>; rollback(): Promise<void> }> => {
  const accountId = assertId(account.id, 'accountId')
  const validate = (value: Database): { id: string; name: string; trashedAt: string | null } => {
    if (typeof value !== 'object' || value === null) return fail('VALIDATION', 'database projection is invalid')
    const id = assertId(value.id, 'databaseId')
    if (assertId(value.accountId, 'accountId') !== accountId) return fail('FORBIDDEN', 'database projection scope is unavailable')
    if (value.engine !== 'mariadb') return fail('VALIDATION', 'database projection engine is unsupported')
    if (typeof value.name !== 'string' || value.name.trim() !== value.name) return fail('VALIDATION', 'database projection name is invalid')
    const name = assertDbNameOwned(account.username, value.name)
    const trashedAt = value.trashedAt
    if (trashedAt !== null && (typeof trashedAt !== 'string' || !Number.isFinite(Date.parse(trashedAt)) || new Date(trashedAt).toISOString() !== trashedAt)) {
      return fail('VALIDATION', 'database trash timestamp is invalid')
    }
    return { id, name, trashedAt }
  }
  const previous = validate(before), next = validate(after)
  if (previous.id !== next.id || previous.name !== next.name) return fail('VALIDATION', 'database transition identity must remain unchanged')
  if ((previous.trashedAt === null) === (next.trashedAt === null)) return fail('PRECONDITION_FAILED', 'database projection requires a trash or restore transition')
  const capture = (tx: Db): Promise<Snapshot> => captureDatabaseIndex(tx, previous.id, previous.name)
  const preimage = await withSqliteErrors(() => db.transaction(async tx => {
    const current = await capture(tx), row = current.databases[0]
    if (current.databases.length !== 1 || !row || row.id !== previous.id || row.account_id !== accountId || row.engine !== 'mariadb' || row.name !== previous.name || row.trashed_at !== previous.trashedAt) {
      return fail('CONFLICT', 'database transition index does not match its accepted state')
    }
    if (current.search.length > 1 || current.search.some(entry => entry.entity_id !== previous.id || entry.account_id !== accountId || entry.title !== previous.name)) {
      return fail('CONFLICT', 'database transition search index conflicts with its accepted scope')
    }
    return current
  }))
  const expected: Snapshot = {
    databases: preimage.databases.map(row => ({ ...row, trashed_at: next.trashedAt })),
    search: preimage.search,
  }
  let attempted = false
  let postimage: Snapshot | null = null
  return {
    async apply(): Promise<void> {
      if (attempted) return fail('PRECONDITION_FAILED', 'database transition was already attempted')
      attempted = true
      await withSqliteErrors(() => db.transaction(async tx => {
        if (!same(await capture(tx), preimage)) return fail('CONFLICT', 'database transition index changed after preparation')
        await tx.query('UPDATE idx_databases SET trashed_at = $1 WHERE rowid = $2 AND id = $3', [next.trashedAt, preimage.databases[0]!.checkpoint_rowid, previous.id])
        const written = await capture(tx)
        if (!same(written, expected)) return fail('CONFLICT', 'database transition requires verification')
        // Retain across uncertain COMMIT acknowledgement, just as creation checkpoints do.
        postimage = written
      }))
    },
    async rollback(): Promise<void> {
      if (!attempted) return
      const acceptedPostimage = postimage
      await withSqliteErrors(() => db.transaction(async tx => {
        const current = await capture(tx)
        if (same(current, preimage)) return
        if (!acceptedPostimage || !same(current, acceptedPostimage)) return fail('CONFLICT', 'database transition rollback requires verification')
        await tx.query('UPDATE idx_databases SET trashed_at = $1 WHERE rowid = $2 AND id = $3', [previous.trashedAt, acceptedPostimage.databases[0]!.checkpoint_rowid, previous.id])
        if (!same(await capture(tx), preimage)) return fail('CONFLICT', 'database transition rollback requires verification')
      }))
      attempted = false
      postimage = null
    },
  }
}
