import { DatabaseSync } from 'node:sqlite'
import { fail } from '@xpanel/core'
import { migrate, type MigrateResult } from './migrate.ts'
import { assertSqliteConnectionSetupAllowed, canonicalSqliteFilename, closeSqliteRunner, sqliteRunner, type Row, type SqlRunner } from './sql-runner.ts'
import { initializeOperationalMetadata } from './repos/official-references.ts'

const nativeExec = DatabaseSync.prototype.exec
const nativeClose = DatabaseSync.prototype.close

/** SQL runner (or transaction runner) passed to repository functions. */
export type Db = SqlRunner

export interface DbHandle {
  db: Db
  sqlite: DatabaseSync
  query: <T extends Row = Row>(text: string, params?: readonly unknown[]) => Promise<T[]>
  runner: SqlRunner
  close: () => Promise<void>
}

export interface CreateDbOptions {
  /** Strict operation acknowledgements require verified file-backed WAL + synchronous FULL. */
  durability?: 'normal' | 'strict'
  /** SQLite busy timeout in milliseconds, default 5000 (0..600000). */
  busyTimeoutMs?: number
  /** Enable WAL journal mode (default true for file databases). */
  wal?: boolean
}

const resolveSqlitePath = (pathOrUrl: string): string => {
  if (typeof pathOrUrl !== 'string' || pathOrUrl.trim().length === 0 || pathOrUrl.includes('\0')) {
    return fail('VALIDATION', 'database path must be a non-empty file path or :memory:')
  }
  if (/^(postgres(?:ql)?|mysql|mariadb|http|https):\/\//i.test(pathOrUrl)) {
    return fail('VALIDATION', 'database path must be a SQLite file path or :memory:')
  }
  if (pathOrUrl.startsWith('sqlite://')) {
    const rest = pathOrUrl.slice('sqlite://'.length)
    return rest.length > 0 ? rest : fail('VALIDATION', 'invalid sqlite:// URL')
  }
  return pathOrUrl
}

const checkBusyTimeout = (ms: number | undefined): number => {
  if (ms === undefined) return 5000
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 600_000) {
    return fail('VALIDATION', 'busyTimeoutMs must be an integer in 0..600000')
  }
  return ms
}

/**
 * Opens a Node `node:sqlite` (`DatabaseSync`) database with `foreign_keys = ON`
 * and `journal_mode = WAL`. Call `migrate(handle.runner)` at startup.
 */
export const createDb = (pathOrUrl: string, opts: CreateDbOptions = {}): DbHandle => {
  const filename = canonicalSqliteFilename(resolveSqlitePath(pathOrUrl))
  if (opts.durability !== undefined && opts.durability !== 'normal' && opts.durability !== 'strict') {
    fail('VALIDATION', 'durability must be normal or strict')
  }
  if (opts.durability === 'strict' && (filename === ':memory:' || opts.wal === false)) {
    fail('PRECONDITION_FAILED', 'strict durability requires a file-backed WAL database')
  }
  const busyTimeoutMs = checkBusyTimeout(opts.busyTimeoutMs)
  assertSqliteConnectionSetupAllowed(filename)
  const sqlite = new DatabaseSync(filename)
  let runner: SqlRunner
  try {
    Reflect.apply(nativeExec, sqlite, ['PRAGMA foreign_keys = ON'])
    Reflect.apply(nativeExec, sqlite, [`PRAGMA busy_timeout = ${busyTimeoutMs}`])
    if (filename !== ':memory:' && opts.wal !== false) {
      Reflect.apply(nativeExec, sqlite, ['PRAGMA journal_mode = WAL'])
      Reflect.apply(nativeExec, sqlite, [opts.durability === 'strict' ? 'PRAGMA synchronous = FULL' : 'PRAGMA synchronous = NORMAL'])
    }
    runner = sqliteRunner(sqlite, { strictDurability: opts.durability === 'strict' })
  } catch (error) {
    Reflect.apply(nativeClose, sqlite, [])
    throw error
  }
  return {
    db: runner,
    sqlite,
    query: (text, params) => runner.query(text, params),
    runner,
    close: () => closeSqliteRunner(runner),
  }
}

export interface TestDbHandle extends DbHandle {
  migration: MigrateResult
}

/** In-memory diagnostic database with explicit migration and initialization. */
export const createTestDb = async (opts: { migrate?: boolean } = {}): Promise<TestDbHandle> => {
  const handle = createDb(':memory:')
  try {
    const migration = opts.migrate === false
      ? { applied: [], alreadyApplied: [], unknownApplied: [], version: 0 }
      : await migrate(handle.runner)
    if (opts.migrate !== false) await initializeOperationalMetadata(handle.db)
    return { ...handle, migration }
  } catch (error) {
    await handle.close()
    throw error
  }
}
