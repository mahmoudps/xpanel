import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteRunner } from './sql-runner.ts'
import type { SqlRunner } from './sql-runner.ts'

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('SQLite public runner transaction isolation', () => {
  let database: DatabaseSync
  let runner: SqlRunner

  beforeEach(async () => {
    database = new DatabaseSync(':memory:')
    runner = sqliteRunner(database)
    await runner.exec(`
      CREATE TABLE identity_state (id INTEGER PRIMARY KEY, mfa_enabled INTEGER NOT NULL);
      CREATE TABLE session_state (id INTEGER PRIMARY KEY, revoked INTEGER NOT NULL);
      INSERT INTO identity_state VALUES (1, 0);
      INSERT INTO session_state VALUES (1, 0);
    `)
  })

  afterEach(() => database.close())

  it('does not disclose enabled MFA before sibling sessions are revoked and committed', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const transition = runner.transaction(async (tx) => {
      await tx.exec('UPDATE identity_state SET mfa_enabled = 1 WHERE id = 1')
      entered.resolve()
      await release.promise
      await tx.exec('UPDATE session_state SET revoked = 1 WHERE id = 1')
    })
    await entered.promise
    let settled = false
    const observed = runner.query('SELECT mfa_enabled, (SELECT revoked FROM session_state WHERE id = 1) AS revoked FROM identity_state WHERE id = 1')
      .then((rows) => { settled = true; return rows })
    await nextTurn()
    const settledBeforeCommit = settled
    release.resolve()
    await transition
    expect(await observed).toEqual([{ mfa_enabled: 1, revoked: 1 }])
    expect(settledBeforeCommit).toBe(false)
  })

  it('does not absorb an external exec into a transaction that subsequently rolls back', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const transition = runner.transaction(async (tx) => {
      await tx.exec('UPDATE identity_state SET mfa_enabled = 1 WHERE id = 1')
      entered.resolve()
      await release.promise
      throw new Error('transition failed')
    }).catch((error: unknown) => error)
    await entered.promise
    const externalWrite = runner.exec('UPDATE session_state SET revoked = 1 WHERE id = 1')
    await nextTurn()
    release.resolve()
    expect(await transition).toBeInstanceOf(Error)
    await externalWrite
    expect(await runner.query('SELECT mfa_enabled, (SELECT revoked FROM session_state WHERE id = 1) AS revoked FROM identity_state WHERE id = 1'))
      .toEqual([{ mfa_enabled: 0, revoked: 1 }])
  })

  it('keeps query, exec and transaction operations in invocation order', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const events: string[] = []
    const first = runner.transaction(async () => {
      events.push('first transaction entered')
      entered.resolve()
      await release.promise
      events.push('first transaction complete')
    })
    await entered.promise
    const read = runner.query('SELECT 1 AS value').then(() => events.push('query'))
    const write = runner.exec('UPDATE identity_state SET mfa_enabled = 1').then(() => events.push('exec'))
    const second = runner.transaction(async (tx) => {
      expect(await tx.query('SELECT mfa_enabled FROM identity_state')).toEqual([{ mfa_enabled: 1 }])
      events.push('second transaction')
    })
    await nextTurn()
    const beforeRelease = [...events]
    release.resolve()
    await Promise.all([first, read, write, second])
    expect(beforeRelease).toEqual(['first transaction entered'])
    expect(events).toEqual(['first transaction entered', 'first transaction complete', 'query', 'exec', 'second transaction'])
  })

  it('never returns intermediate data from a transaction that rolls back', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const transition = runner.transaction(async (tx) => {
      await tx.exec('UPDATE identity_state SET mfa_enabled = 1')
      entered.resolve()
      await release.promise
      throw new Error('rollback')
    }).catch(() => undefined)
    await entered.promise
    const read = runner.query('SELECT mfa_enabled FROM identity_state')
    await nextTurn()
    release.resolve()
    await transition
    expect(await read).toEqual([{ mfa_enabled: 0 }])
  })

  it('releases the queue after a failed public query or exec', async () => {
    await expect(runner.query('SELECT missing_column FROM identity_state')).rejects.toThrow()
    await expect(runner.exec('INVALID SQL')).rejects.toThrow()
    await runner.exec('UPDATE identity_state SET mfa_enabled = 1')
    expect(await runner.query('SELECT mfa_enabled FROM identity_state')).toEqual([{ mfa_enabled: 1 }])
  })

  it('preserves explicit nested-transaction rejection and releases the outer queue', async () => {
    await expect(runner.transaction(async (tx) => {
      await tx.exec('UPDATE identity_state SET mfa_enabled = 1')
      await tx.transaction(async () => undefined)
    })).rejects.toThrow('nested transactions are not supported')
    expect(await runner.query('SELECT mfa_enabled FROM identity_state')).toEqual([{ mfa_enabled: 0 }])
  })

  it('rejects accidental use of the outer runner inside a transaction without deadlocking', async () => {
    await runner.transaction(async (tx) => {
      await expect(runner.query('SELECT mfa_enabled FROM identity_state')).rejects.toThrow('use the provided transaction runner')
      await expect(runner.exec('UPDATE identity_state SET mfa_enabled = 1')).rejects.toThrow('use the provided transaction runner')
      await expect(runner.transaction(async () => undefined)).rejects.toThrow('nested transactions are not supported')
      expect(await tx.query('SELECT mfa_enabled FROM identity_state')).toEqual([{ mfa_enabled: 0 }])
    })
  })

  it('rejects an escaped transaction runner after commit', async () => {
    let escaped: SqlRunner | undefined
    await runner.transaction(async (tx) => { escaped = tx })
    await expect(escaped!.query('SELECT mfa_enabled FROM identity_state')).rejects.toThrow('transaction runner is not active')
    await expect(escaped!.exec('UPDATE identity_state SET mfa_enabled = 1')).rejects.toThrow('transaction runner is not active')
    expect(await runner.query('SELECT mfa_enabled FROM identity_state')).toEqual([{ mfa_enabled: 0 }])
  })

  it('does not block another connection used inside the same asynchronous callback', async () => {
    const other = new DatabaseSync(':memory:')
    const otherRunner = sqliteRunner(other)
    try {
      await runner.transaction(async (tx) => {
        await otherRunner.transaction(async (otherTx) => {
          expect(await otherTx.query('SELECT 2 AS value')).toEqual([{ value: 2 }])
          expect(await tx.query('SELECT mfa_enabled FROM identity_state')).toEqual([{ mfa_enabled: 0 }])
          await expect(runner.query('SELECT 1')).rejects.toThrow('use the provided transaction runner')
        })
      })
    } finally {
      other.close()
    }
  })
})
