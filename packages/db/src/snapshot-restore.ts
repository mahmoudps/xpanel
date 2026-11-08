import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, open, rm } from 'node:fs/promises'
import { backup, DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fail } from '@xpanel/core'
import type { Db } from './client.ts'
import { markOperationalMigrationsRestored } from './migration-mode.ts'
import { assertNoActiveDatabaseTransaction, assertRegisteredDatabaseRunner, getStrictDatabaseIdentity, type Row } from './sql-runner.ts'

// Values that must never rewind keep their highest value; append-only history keeps every row.
const WATERMARKS = [
  { table: 'official_reference_counters', keys: ['issuer_id', 'kind', 'issued_year'], value: 'last_sequence' },
  { table: 'reconcile_host_epochs', keys: ['issuer_id'], value: 'last_epoch' },
  { table: 'sqlite_sequence', keys: ['name'], value: 'seq' },
] as const
const HISTORY = [{ table: 'audit_log', order: 'id' }, { table: 'official_reference_ledger', order: 'rowid' }] as const

const refused = (reason: string, stateChanged = false): never => fail('PRECONDITION_FAILED', 'database snapshot restore refused', { reason, stateChanged })

const sha256Of = async (path: string): Promise<string> => {
  let handle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return refused('database_snapshot_missing')
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) return refused('database_snapshot_changed')
    return createHash('sha256').update(await handle.readFile()).digest('hex')
  } finally { await handle.close() }
}
const removeImage = (path: string): Promise<void[]> => Promise.all(['', '-wal', '-shm', '-journal'].map(suffix => rm(path + suffix, { force: true })))
const value = (input: unknown): SQLInputValue => input as SQLInputValue

/** Writes the never-rewind values and history read from the live database into the restored image. */
const carryForward = (image: DatabaseSync, watermarks: Row[][], history: Row[][]): void => {
  image.exec('BEGIN IMMEDIATE')
  try {
    WATERMARKS.forEach(({ table, keys, value: column }, index) => {
      const where = keys.map(key => `${key}=?`).join(' AND ')
      for (const row of watermarks[index]!) {
        if (table === 'sqlite_sequence' && !image.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(value(row.name))) continue
        const key = keys.map(name => value(row[name])), current = image.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${where}`).get(...key)
        if (!current) image.prepare(`INSERT INTO ${table}(${[...keys, column].join(',')}) VALUES(${[...keys, column].map(() => '?').join(',')})`).run(...key, value(row[column]))
        else if (Number(current.value) < Number(row[column])) image.prepare(`UPDATE ${table} SET ${column}=? WHERE ${where}`).run(value(row[column]), ...key)
      }
    })
    const now = new Date().toISOString(), jobExists = image.prepare('SELECT 1 FROM jobs WHERE id=?')
    HISTORY.forEach(({ table }, index) => {
      const columns = image.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(column => String(column.name))
      const insert = image.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
      for (const row of history[index]!) {
        // A reference issued after the snapshot keeps its permanent record; its job is gone, so its identity is tombstoned.
        const carried = table === 'official_reference_ledger' && row.tombstoned_at === null && !jobExists.get(value(row.entity_id)) ? { ...row, tombstoned_at: now } : row
        insert.run(...columns.map(column => value(carried[column] ?? null)))
      }
    })
    image.exec('COMMIT')
  } catch (error) { image.exec('ROLLBACK'); throw error }
}

/**
 * Rollback only, writers stopped: return a strict connection's database, in place on the same inode, to the
 * pre-migration snapshot bound to `sha256`. Restoring re-admits this process's `pre-migration` reads.
 */
export const restoreOperationalDatabaseSnapshot = async (db: Db, snapshot: { path: string; sha256: string }): Promise<void> => {
  assertRegisteredDatabaseRunner(db)
  assertNoActiveDatabaseTransaction()
  if (!/^[a-f0-9]{64}$/.test(snapshot?.sha256)) return refused('database_snapshot_unbound')
  if (await sha256Of(snapshot.path) !== snapshot.sha256) return refused('database_snapshot_changed')
  const imagePath = snapshot.path + '.restore'
  await removeImage(imagePath)
  try {
    await copyFile(snapshot.path, imagePath, constants.COPYFILE_EXCL)
    if (await sha256Of(imagePath) !== snapshot.sha256) return refused('database_snapshot_changed')
    const image = new DatabaseSync(imagePath)
    let expected = ''
    try {
      const marks = HISTORY.map(({ table, order }) => image.prepare(`SELECT coalesce(max(${order}),0) AS last FROM ${table}`).get()!.last)
      const live = await db.transaction(async tx => ({
        file: getStrictDatabaseIdentity(tx).file,
        watermarks: await Promise.all(WATERMARKS.map(({ table, keys, value: column }) => tx.query(`SELECT ${[...keys, column].join(',')} FROM ${table}`))),
        history: await Promise.all(HISTORY.map(({ table, order }, index) => tx.query(`SELECT * FROM ${table} WHERE ${order} > $1 ORDER BY ${order}`, [marks[index]]))),
      }))
      carryForward(image, live.watermarks, live.history)
      expected = JSON.stringify(image.prepare('SELECT version,name,checksum FROM xpanel_schema_migrations ORDER BY version').all())
      // One backup transaction rewrites the live pages; the file, its inode and its WAL mode stay.
      await backup(image, live.file)
    } finally { image.close() }
    const restored = await db.transaction(async tx => JSON.stringify(await tx.query('SELECT version,name,checksum FROM xpanel_schema_migrations ORDER BY version')))
    if (restored !== expected) return refused('database_snapshot_not_restored', true)
  } finally { await removeImage(imagePath) }
  markOperationalMigrationsRestored()
}
