import { describe, expect, it } from 'vitest'
import {
  classifyAncestorStatChange, classifyDatabaseStatChange, getReadonlyOperationDatabaseOrigin,
  readonlyOperationSelect, REOBSERVED_DATABASE_MAX_ATTEMPTS, reobservedDatabaseBackoffMs,
  withReadonlyClosedOperationDatabase,
} from './readonly-operation-database.ts'
import { assertReadonlyLifecycleIntentObservationCurrent, assertReadonlyLifecycleIntentFileObservationCurrent,
  getReadonlyLifecycleIntentFileObservationInfo, withReadonlyLifecycleIntentObservation } from './repos/operation-audit-authority.ts'

describe('read-only operation database syntax and capability boundary', () => {
  it('rewrites only positional parameters in SELECT code', () => {
    const sql = "SELECT '$1; DELETE' AS literal, $1 AS value /* $2; UPDATE */ -- $3\n"
    expect(readonlyOperationSelect(sql)).toBe("SELECT '$1; DELETE' AS literal, ?1 AS value /* $2; UPDATE */ -- $3\n")
  })
  it.each([
    'UPDATE jobs SET actor=$1', 'SELECT 1; SELECT 2', 'PRAGMA journal_mode',
    'WITH v AS (SELECT 1) SELECT * FROM v', 'SELECT load_extension($1)',
    'SELECT "load_extension"($1)', 'SELECT * FROM pragma_table_info($1)',
    'SELECT * FROM "pragma_table_info"($1)', 'SELECT writefile($1,$2)',
    'SELECT $$unreviewed body$$', 'SELECT 1\0', '',
  ])('rejects unsupported query %s', sql => expect(() => readonlyOperationSelect(sql)).toThrow())
  it('rejects copied readers without consulting caller methods or getters', async () => {
    let invoked = false
    const fake = Object.defineProperty({}, 'query', { get() { invoked = true; throw new Error('untrusted getter') } })
    expect(() => getReadonlyOperationDatabaseOrigin(fake)).toThrow()
    await expect(withReadonlyLifecycleIntentObservation(fake as never, {} as never, async () => undefined)).rejects.toThrow()
    await expect(assertReadonlyLifecycleIntentObservationCurrent({ assertCurrent() { invoked = true } })).rejects.toThrow()
    expect(invoked).toBe(false)
  })
  it('does not turn absent WAL flags or supplied callbacks into closed-database authority', async () => {
    for (const value of [null, {}, { stopped: true, exclusive: true, immutable: true }, {
      purpose: 'closed-database-observation', database: { file: '/var/lib/xpanel/control.db' }, assertCurrent: async () => undefined,
    }]) {
      let called = false
      await expect(withReadonlyClosedOperationDatabase(value, async () => { called = true })).rejects.toThrow()
      expect(called).toBe(false)
      expect(() => getReadonlyLifecycleIntentFileObservationInfo(value)).toThrow()
      await expect(assertReadonlyLifecycleIntentFileObservationCurrent(value)).rejects.toThrow()
    }
  })
  it('classifies live auto-checkpoint and database-directory contention separately from identity drift', () => {
    expect(REOBSERVED_DATABASE_MAX_ATTEMPTS).toBe(12)
    expect(reobservedDatabaseBackoffMs(1)).toBe(20)
    expect(reobservedDatabaseBackoffMs(10)).toBe(150)

    expect(classifyDatabaseStatChange({ closed: false, sameIdentity: true, sameContents: true })).toBe('ok')
    expect(classifyDatabaseStatChange({ closed: false, sameIdentity: true, sameContents: false })).toBe('wal_collision')
    expect(classifyDatabaseStatChange({ closed: true, sameIdentity: true, sameContents: false })).toBe('refused')
    expect(classifyDatabaseStatChange({ closed: false, sameIdentity: false, sameContents: false })).toBe('refused')

    expect(classifyAncestorStatChange({ isDatabaseDirectory: false, sameIdentity: true, sameContents: false, checkClosedTimestamps: false })).toBe('ok')
    expect(classifyAncestorStatChange({ isDatabaseDirectory: true, sameIdentity: true, sameContents: false, checkClosedTimestamps: false })).toBe('wal_collision')
    expect(classifyAncestorStatChange({ isDatabaseDirectory: false, sameIdentity: true, sameContents: false, checkClosedTimestamps: true })).toBe('refused')
    expect(classifyAncestorStatChange({ isDatabaseDirectory: true, sameIdentity: false, sameContents: false, checkClosedTimestamps: false })).toBe('refused')
  })
})
