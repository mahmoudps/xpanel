import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { fail } from '@xpanel/core'
import { migrate, type MigrateResult } from './migrate.ts'
import { toXpanelError } from './pg-errors.ts'
import { schema, type Schema } from './schema.ts'
import { pgliteRunner, pgRunner, type Row, type SqlRunner } from './sql-runner.ts'

/** Drizzle database (or transaction) over either driver. Repos take this. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>

export interface DbHandle {
  db: Db
  /** raw parameterised query; values are driver-native */
  query: <T extends Row = Row>(text: string, params?: readonly unknown[]) => Promise<T[]>
  runner: SqlRunner
  close: () => Promise<void>
}

export interface CreateDbOptions {
  /** pool size, default 4: the control Postgres runs with max_connections = 20 (STANDARDS resource budget) */
  max?: number
  /** application_name reported to Postgres */
  applicationName?: string
  /** default 10 s */
  connectionTimeoutMs?: number
  /** server-side statement_timeout, default 30 s; 0 disables */
  statementTimeoutMs?: number
  /**
   * An idle pooled connection failed (server restart, network cut). The pool already
   * discarded it and the next query opens a new one; the error carries no query text.
   */
  onIdleError?: (e: unknown) => void
}

export const DB_URL_RE = /^postgres(?:ql)?:\/\/[^\s]+$/

const positiveInt = (v: number | undefined, def: number, min: number, max: number, what: string): number => {
  if (v === undefined) return def
  return Number.isSafeInteger(v) && v >= min && v <= max ? v : fail('VALIDATION', `${what} must be an integer in ${min}..${max}`)
}

const APP_NAME_RE = /^[A-Za-z0-9._-]{1,63}$/

/** Production client (node-postgres pool). Connects lazily and does not migrate: call `migrate(handle.runner)` at startup. */
export const createDb = (url: string, opts: CreateDbOptions = {}): DbHandle => {
  // never echo the URL: it carries the password
  if (typeof url !== 'string' || !DB_URL_RE.test(url)) return fail('VALIDATION', 'database url must be postgres://...')
  const applicationName = opts.applicationName ?? 'xpanel'
  if (!APP_NAME_RE.test(applicationName)) fail('VALIDATION', 'applicationName must be 1-63 of A-Z a-z 0-9 . _ -')
  const pool = new pg.Pool({
    connectionString: url,
    max: positiveInt(opts.max, 4, 1, 20, 'max'),
    application_name: applicationName,
    connectionTimeoutMillis: positiveInt(opts.connectionTimeoutMs, 10_000, 1, 600_000, 'connectionTimeoutMs'),
    statement_timeout: positiveInt(opts.statementTimeoutMs, 30_000, 0, 3_600_000, 'statementTimeoutMs'),
    idleTimeoutMillis: 30_000,
  })
  // without a listener an idle-client error would crash the process
  pool.on('error', (e) => opts.onIdleError?.(toXpanelError(e)))
  const runner = pgRunner(pool)
  return {
    db: drizzleNodePg({ client: pool, schema }),
    query: (text, params) => runner.query(text, params),
    runner,
    close: () => pool.end(),
  }
}

export interface TestDbHandle extends DbHandle {
  migration: MigrateResult
}

/**
 * In-memory PGlite with all migrations applied. Test/dev only: PGlite is a dev
 * dependency and is loaded lazily so production never imports it.
 */
export const createTestDb = async (opts: { migrate?: boolean } = {}): Promise<TestDbHandle> => {
  const [{ PGlite }, { drizzle: drizzlePglite }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('drizzle-orm/pglite'),
  ])
  const pglite = new PGlite()
  await pglite.waitReady
  const runner = pgliteRunner(pglite)
  const migration =
    opts.migrate === false ? { applied: [], alreadyApplied: [], unknownApplied: [], version: 0 } : await migrate(runner)
  return {
    db: drizzlePglite({ client: pglite, schema }),
    query: (text, params) => runner.query(text, params),
    runner,
    migration,
    close: () => pglite.close(),
  }
}
