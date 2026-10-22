import { DatabaseSync } from 'node:sqlite'
import { fail } from '@xpanel/core'
import { migrate, type MigrateResult } from './migrate.ts'
import { sqliteRunner, type Row, type SqlRunner } from './sql-runner.ts'

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
  const filename = resolveSqlitePath(pathOrUrl)
  const busyTimeoutMs = checkBusyTimeout(opts.busyTimeoutMs)
  const sqlite = new DatabaseSync(filename)
  sqlite.exec('PRAGMA foreign_keys = ON')
  sqlite.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
  if (filename !== ':memory:' && opts.wal !== false) {
    sqlite.exec('PRAGMA journal_mode = WAL')
    sqlite.exec('PRAGMA synchronous = NORMAL')
  }
  const runner = sqliteRunner(sqlite)
  let closed = false
  return {
    db: runner,
    sqlite,
    query: (text, params) => runner.query(text, params),
    runner,
    async close(): Promise<void> {
      if (!closed) {
        closed = true
        sqlite.close()
      }
    },
  }
}

export interface TestDbHandle extends DbHandle {
  migration: MigrateResult
}

/** In-memory SQLite database with all migrations applied. */
export const createTestDb = async (opts: { migrate?: boolean } = {}): Promise<TestDbHandle> => {
  const handle = createDb(':memory:')
  const migration =
    opts.migrate === false
      ? { applied: [], alreadyApplied: [], unknownApplied: [], version: 0 }
      : await migrate(handle.runner)
  return {
    ...handle,
    migration,
  }
}
