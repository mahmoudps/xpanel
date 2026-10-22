import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import { lexSql } from './sql-lexer.ts'

export type Row = Record<string, unknown>

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
}

const transactionScopes = new AsyncLocalStorage<ReadonlyMap<symbol, TransactionScope>>()

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
  const stmt = db.prepare(sql)
  const bound = params.map(bindParam)
  if (stmt.columns().length > 0) {
    const rows = stmt.all(...bound) as Record<string, unknown>[]
    return rows.map((r) => ({ ...r }) as T)
  }
  stmt.run(...bound)
  return []
}

export const sqliteRunner = (db: DatabaseSync): SqlRunner => {
  let tail: Promise<void> = Promise.resolve()
  const owner = Symbol('SQLite connection')

  const assertPublicAccess = (): void => {
    if (transactionScopes.getStore()?.get(owner)?.active) {
      throw new Error('use the provided transaction runner inside a transaction')
    }
  }

  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const prev = tail
    tail = prev.then(() => next)
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  const createTransactionRunner = (scope: TransactionScope): SqlRunner => {
    const assertActive = (): void => {
      if (!scope.active || transactionScopes.getStore()?.get(owner) !== scope) {
        throw new Error('transaction runner is not active in this transaction')
      }
    }
    return {
      async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
        assertActive()
        return runQuery<T>(db, text, params)
      },
      async exec(script: string): Promise<void> {
        assertActive()
        db.exec(script)
      },
      transaction: nested,
    }
  }

  return {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      assertPublicAccess()
      return withLock(async () => runQuery<T>(db, text, params))
    },
    async exec(script: string): Promise<void> {
      assertPublicAccess()
      return withLock(async () => { db.exec(script) })
    },
    transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
      if (transactionScopes.getStore()?.get(owner)?.active) return nested()
      return withLock(async () => {
        db.exec('BEGIN IMMEDIATE')
        const scope: TransactionScope = { active: true }
        const scopes = new Map(transactionScopes.getStore())
        scopes.set(owner, scope)
        const txRunner = createTransactionRunner(scope)
        try {
          const result = await transactionScopes.run(scopes, () => fn(txRunner))
          db.exec('COMMIT')
          return result
        } catch (e) {
          try {
            db.exec('ROLLBACK')
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
}
