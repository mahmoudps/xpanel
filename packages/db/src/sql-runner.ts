import { DatabaseSync, StatementSync, type SQLInputValue } from 'node:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { assertId, fail } from '@xpanel/core'
import { lexSql } from './sql-lexer.ts'
import { matchesReviewedOperationalMigrations, OPERATIONAL_SCHEMA_VERSION } from './schema.ts'

export type Row = Record<string, unknown>

// Native internal-slot checks and transaction semantics cannot be supplied by a raw driver object.
const nativePrepare = DatabaseSync.prototype.prepare
const nativeExec = DatabaseSync.prototype.exec
const nativeClose = DatabaseSync.prototype.close
const nativeColumns = StatementSync.prototype.columns
const nativeAll = StatementSync.prototype.all
const nativeRun = StatementSync.prototype.run
const executeNative = (db: DatabaseSync, sql: string): void => { Reflect.apply(nativeExec, db, [sql]) }

/**
 * Minimal SQL surface over Node's built-in `node:sqlite` (`DatabaseSync`).
 * Supports both `?` (`?1, ?2`) and `$1, $2` positional placeholders.
 */
export interface SqlRunner {
  /** One parameterised statement, serialized with public scripts and transactions. */
  query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<T[]>
  /** A multi-statement script without parameters (migrations). */
  exec(script: string): Promise<void>
  /** Runs fn in one `BEGIN IMMEDIATE`; use its runner, not the outer runner, inside fn. */
  transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>
}

const nested = (): Promise<never> => Promise.reject(new Error('nested transactions are not supported'))

interface TransactionScope {
  active: boolean
  strict: boolean
}

const transactionScopes = new AsyncLocalStorage<ReadonlyMap<symbol, TransactionScope>>()
export interface StrictDatabaseIdentity { readonly file: string; readonly device: string; readonly inode: string }
export interface StrictOperationDatabaseOrigin extends StrictDatabaseIdentity { readonly issuerId: string }
const strictTransactions = new WeakMap<SqlRunner, () => StrictDatabaseIdentity>()
const strictOrigins = new WeakMap<SqlRunner, () => StrictOperationDatabaseOrigin>()
const activeTransactions = new WeakMap<SqlRunner, () => void>()
interface Scheduler { tail: Promise<void>; pending: number; references: number; owner: symbol }
const fileSchedulers = new Map<string, Scheduler>()
const registeredRunners = new WeakMap<DatabaseSync, { runner: SqlRunner; strict: boolean }>()
const runnerClosers = new WeakMap<SqlRunner, () => Promise<void>>()
const publicRunnerRegistrations = new WeakMap<object, () => void>()
const physicalKey = (identity: StrictDatabaseIdentity): string => `${identity.device}:${identity.inode}`

export const assertNoActiveDatabaseTransaction = (): void => {
  if ([...(transactionScopes.getStore()?.values() ?? [])].some(scope => scope.active)) fail('PRECONDITION_FAILED', 'no active outer database transaction is allowed for this operation')
}

/** Exact public runner identity, never a structural transaction provider or a transaction runner. */
export function assertRegisteredDatabaseRunner(runner: unknown): asserts runner is SqlRunner {
  const verify = typeof runner === 'object' && runner !== null ? publicRunnerRegistrations.get(runner) : undefined
  if (!verify) return fail('PRECONDITION_FAILED', 'a registered public database runner is required')
  verify()
}

/** Resolves aliases before opening SQLite, so all admitted handles use one WAL basename. */
export const canonicalSqliteFilename = (filename: string): string => {
  if (filename === ':memory:') return filename
  const absolute = resolve(filename)
  try {
    const canonical = realpathSync.native(absolute)
    captureFileIdentity(canonical)
    return canonical
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const existing = lstatSync(absolute, { throwIfNoEntry: false })
    if (existing) return fail('PRECONDITION_FAILED', 'database path is a dangling or unresolved alias')
    return join(realpathSync.native(dirname(absolute)), basename(absolute))
  }
}

const captureFileIdentity = (filename: string): StrictDatabaseIdentity => {
  const file = realpathSync.native(filename)
  const info = statSync(file, { bigint: true })
  if (!info.isFile() || info.nlink !== 1n) return fail('PRECONDITION_FAILED', 'database must be a regular file with exactly one hard link')
  return Object.freeze({ file, device: String(info.dev), inode: String(info.ino) })
}

/** Synchronous setup must refuse contention instead of blocking its incumbent event loop. */
export const assertSqliteConnectionSetupAllowed = (filename: string): void => {
  if (filename === ':memory:') return
  let identity: StrictDatabaseIdentity
  try { identity = captureFileIdentity(filename) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if ((fileSchedulers.get(physicalKey(identity))?.pending ?? 0) > 0) fail('CONFLICT', 'database connection setup must wait for admitted operations to finish')
}

export const assertDatabaseTransaction = (tx: SqlRunner): void => {
  const verify = activeTransactions.get(tx)
  if (!verify) return fail('PRECONDITION_FAILED', 'an active database transaction is required')
  verify()
}

/** Only a genuine, active transaction on a verified strict connection is accepted. */
export const assertStrictDurableTransaction = (tx: SqlRunner): void => {
  getStrictDatabaseIdentity(tx)
}

export const getStrictDatabaseIdentity = (tx: SqlRunner): StrictDatabaseIdentity => {
  const verify = strictTransactions.get(tx)
  if (!verify) return fail('PRECONDITION_FAILED', 'a verified strict file-backed database transaction is required')
  return verify()
}

/** Synchronous physical + issuer origin read from the actual registered strict transaction. */
export const getStrictOperationDatabaseOrigin = (tx: SqlRunner): StrictOperationDatabaseOrigin => {
  const verify = strictOrigins.get(tx)
  if (!verify) return fail('PRECONDITION_FAILED', 'a verified strict operation database transaction is required')
  return verify()
}

export const closeSqliteRunner = (runner: SqlRunner): Promise<void> => {
  const close = runnerClosers.get(runner)
  if (!close) return Promise.reject(new Error('unregistered database runner'))
  return close()
}

const verifyStrictConnection = (db: DatabaseSync, identity: StrictDatabaseIdentity | null): StrictDatabaseIdentity => {
  const main = runQuery(db, 'PRAGMA database_list').find(row => row.name === 'main')
  const journal = runQuery(db, 'PRAGMA main.journal_mode')[0]
  const synchronous = runQuery(db, 'PRAGMA main.synchronous')[0]
  const foreignKeys = runQuery(db, 'PRAGMA foreign_keys')[0]
  const normalizePath = (value: string): string => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  if (!identity || typeof main?.file !== 'string' || main.file.length === 0 || normalizePath(main.file) !== normalizePath(identity.file) || journal?.journal_mode !== 'wal' || synchronous?.synchronous !== 2 || foreignKeys?.foreign_keys !== 1) {
    return fail('PRECONDITION_FAILED', 'strict durability requires a file database with WAL, synchronous FULL and foreign keys enabled')
  }
  return identity
}

/** Converts `$1, $2` in code segments to `?1, ?2` so positional binding works for both styles. */
const toPositionalSql = (sql: string): string => {
  if (!sql.includes('$')) return sql
  try {
    return lexSql(sql)
      .map((s) => (s.kind === 'code' ? s.text.replace(/\$(\d+)\b/g, '?$1') : s.text))
      .join('')
  } catch {
    return sql
  }
}

const bindParam = (v: unknown): SQLInputValue => {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v
  if (v instanceof Uint8Array) return v
  return JSON.stringify(v)
}

const runQuery = <T extends Row = Row>(db: DatabaseSync, text: string, params: readonly unknown[] = []): T[] => {
  const sql = toPositionalSql(text)
  const stmt = Reflect.apply(nativePrepare, db, [sql]) as ReturnType<DatabaseSync['prepare']>
  const bound = params.map(bindParam)
  if (Reflect.apply(nativeColumns, stmt, []).length > 0) {
    const rows = Reflect.apply(nativeAll, stmt, bound) as Record<string, unknown>[]
    return rows.map((r) => ({ ...r }) as T)
  }
  // Mutation metadata is discarded. Read its rowid as bigint so a previous
  // 64-bit insert cannot make otherwise successful non-returning DML throw.
  stmt.setReadBigInts(true)
  Reflect.apply(nativeRun, stmt, bound)
  return []
}

export const sqliteRunner = (db: DatabaseSync, opts: { strictDurability?: boolean } = {}): SqlRunner => {
  const strictDurability = opts.strictDurability === true
  const registered = registeredRunners.get(db)
  if (registered) {
    if (registered.strict !== strictDurability) return fail('PRECONDITION_FAILED', 'database connection already has a different registered durability policy')
    return registered.runner
  }
  let main: Row | undefined
  try { main = runQuery(db, 'PRAGMA database_list').find(row => row.name === 'main') } catch {
    return fail('PRECONDITION_FAILED', 'a genuine open native SQLite connection is required')
  }
  const identity = typeof main?.file === 'string' && main.file.length > 0 ? captureFileIdentity(main.file) : null
  if (identity) assertSqliteConnectionSetupAllowed(identity.file)
  if (strictDurability) verifyStrictConnection(db, identity)
  const key = identity ? physicalKey(identity) : null
  const scheduler = (key ? fileSchedulers.get(key) : undefined) ?? { tail: Promise.resolve(), pending: 0, references: 0, owner: Symbol('SQLite file admission') }
  scheduler.references++
  if (key) fileSchedulers.set(key, scheduler)
  const owner = scheduler.owner
  let closing = false
  let closePromise: Promise<void> | null = null

  const assertPublicAccess = (): void => {
    if (transactionScopes.getStore()?.get(owner)?.active || [...(transactionScopes.getStore()?.values() ?? [])].some(scope => scope.active && scope.strict)) {
      throw new Error('use the provided transaction runner inside a transaction')
    }
    if (closing) throw new Error('database connection is closing or closed')
  }

  const withLock = async <T>(fn: () => Promise<T>, verifyFile = true): Promise<T> => {
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const prev = scheduler.tail
    scheduler.tail = prev.then(() => next)
    scheduler.pending++
    await prev
    try {
      if (verifyFile && identity) {
        const actual = captureFileIdentity(identity.file)
        if (actual.file !== identity.file || actual.device !== identity.device || actual.inode !== identity.inode) return fail('PRECONDITION_FAILED', 'database file identity changed; close and perform explicit recovery before reopening')
      }
      return await fn()
    } finally {
      scheduler.pending--
      release()
    }
  }

  const createTransactionRunner = (scope: TransactionScope): SqlRunner => {
    const assertActive = (): void => {
      if (!scope.active || transactionScopes.getStore()?.get(owner) !== scope) {
        throw new Error('transaction runner is not active in this transaction')
      }
    }
    const transactionRunner: SqlRunner = {
      async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
        assertActive()
        return runQuery<T>(db, text, params)
      },
      async exec(script: string): Promise<void> {
        assertActive()
        executeNative(db, script)
      },
      transaction: nested,
    }
    activeTransactions.set(transactionRunner, assertActive)
    if (strictDurability) {
      strictTransactions.set(transactionRunner, () => { assertActive(); return verifyStrictConnection(db, identity) })
      strictOrigins.set(transactionRunner, () => {
        assertActive()
        const physical = verifyStrictConnection(db, identity)
        const issuer = runQuery(db, 'SELECT issuer_id,schema_version,migration_checksums_json FROM operational_identity WHERE singleton=1')[0]
        if (!issuer || issuer.schema_version !== OPERATIONAL_SCHEMA_VERSION || !matchesReviewedOperationalMigrations(issuer.migration_checksums_json, runQuery(db, 'SELECT version,name,checksum FROM xpanel_schema_migrations ORDER BY version'))) return fail('PRECONDITION_FAILED', 'reviewed operational database initialization and migration set are required')
        return Object.freeze({ ...physical, issuerId: assertId(issuer.issuer_id, 'issuerId') })
      })
    }
    return Object.freeze(transactionRunner)
  }

  const publicRunner: SqlRunner = {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      assertPublicAccess()
      return withLock(async () => runQuery<T>(db, text, params))
    },
    async exec(script: string): Promise<void> {
      assertPublicAccess()
      return withLock(async () => { executeNative(db, script) })
    },
    transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
      if (transactionScopes.getStore()?.get(owner)?.active || [...(transactionScopes.getStore()?.values() ?? [])].some(scope => scope.active && scope.strict)) return nested()
      try { assertPublicAccess() } catch (error) { return Promise.reject(error) }
      return withLock(async () => {
        if (strictDurability) verifyStrictConnection(db, identity)
        executeNative(db, 'BEGIN IMMEDIATE')
        const scope: TransactionScope = { active: true, strict: strictDurability }
        const scopes = new Map(transactionScopes.getStore())
        scopes.set(owner, scope)
        const txRunner = createTransactionRunner(scope)
        try {
          const result = await transactionScopes.run(scopes, () => fn(txRunner))
          if (strictDurability) verifyStrictConnection(db, identity)
          executeNative(db, 'COMMIT')
          return result
        } catch (e) {
          try {
            executeNative(db, 'ROLLBACK')
          } catch {
            // transaction may have already been aborted by SQLite
          }
          throw e
        } finally {
          scope.active = false
        }
      })
    },
  }
  registeredRunners.set(db, { runner: publicRunner, strict: strictDurability })
  publicRunnerRegistrations.set(publicRunner, () => {
    if (closing) fail('PRECONDITION_FAILED', 'database connection is closing or closed')
  })
  runnerClosers.set(publicRunner, () => {
    if (transactionScopes.getStore()?.get(owner)?.active || [...(transactionScopes.getStore()?.values() ?? [])].some(scope => scope.active && scope.strict)) return Promise.reject(new Error('cannot close a connection from an active database transaction'))
    if (closePromise) return closePromise
    closing = true
    closePromise = withLock(async () => {
      try { Reflect.apply(nativeClose, db, []) } finally {
        scheduler.references--
        if (key && scheduler.references === 0 && fileSchedulers.get(key) === scheduler) fileSchedulers.delete(key)
      }
    }, false)
    return closePromise
  })
  return Object.freeze(publicRunner)
}
