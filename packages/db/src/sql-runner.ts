import type { PGlite, Transaction } from '@electric-sql/pglite'
import type { Pool, PoolClient } from 'pg'

export type Row = Record<string, unknown>

/**
 * Minimal raw SQL surface shared by node-postgres and PGlite.
 * Used by the migration runner and for ad-hoc queries; repos use Drizzle.
 * Raw values are driver-native (e.g. int8 arrives as a string on node-postgres).
 */
export interface SqlRunner {
  /** one parameterised statement ($1, $2, ...) */
  query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<T[]>
  /** a multi-statement script without parameters (migrations) */
  exec(script: string): Promise<void>
  /** runs fn in one transaction; rolls back when fn throws */
  transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>
}

const nested = (): Promise<never> => Promise.reject(new Error('nested transactions are not supported'))

type PgliteTx = Pick<Transaction, 'query' | 'exec'>

const pgliteTxRunner = (tx: PgliteTx): SqlRunner => ({
  async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await tx.query<T>(text, [...params])).rows
  },
  async exec(script: string): Promise<void> {
    await tx.exec(script)
  },
  transaction: nested,
})

export const pgliteRunner = (pg: Pick<PGlite, 'query' | 'exec' | 'transaction'>): SqlRunner => ({
  async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await pg.query<T>(text, [...params])).rows
  },
  async exec(script: string): Promise<void> {
    await pg.exec(script)
  },
  transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
    return pg.transaction((tx) => fn(pgliteTxRunner(tx)))
  },
})

type Queryable = Pick<PoolClient, 'query'>

const clientRunner = (client: Queryable): SqlRunner => ({
  async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await client.query<T>(text, [...params])).rows
  },
  async exec(script: string): Promise<void> {
    // no parameters: node-postgres uses the simple protocol, which runs several statements
    await client.query(script)
  },
  transaction: nested,
})

/** node-postgres pool. A transaction holds one pooled client from BEGIN to COMMIT/ROLLBACK. */
export const pgRunner = (pool: Pick<Pool, 'query' | 'connect'>): SqlRunner => ({
  async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await pool.query<T>(text, [...params])).rows
  },
  async exec(script: string): Promise<void> {
    await pool.query(script)
  },
  async transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    let broken: Error | undefined
    try {
      await client.query('BEGIN')
      const result = await fn(clientRunner(client))
      await client.query('COMMIT')
      return result
    } catch (e) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        // the connection is unusable; destroy it instead of returning it to the pool
        broken = rollbackError as Error
      }
      throw e
    } finally {
      client.release(broken)
    }
  },
})
