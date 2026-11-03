import { describe, expect, it } from 'vitest'
import { isRetryableRewindJournal, parseRewindJournal, REWIND_STEPS, type RewindJournal } from './machine.ts'

const record = (): RewindJournal => ({ schemaVersion: 1, recordId: '12345678-1234-1234-1234-123456789abc', state: 'rewind-failed',
  done: REWIND_STEPS.filter(step => step !== 'start-panel'), generation: 7, problems: ['owned control-plane start failed'],
  startedAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:01.000Z', retryAdmission: 'restart-owned-control-plane' })

describe('bounded rewind retry classification; not native admission', () => {
  it('allows only the recorded service-start failure after every data/source step was confirmed', () => {
    const parsed = parseRewindJournal(JSON.stringify(record()))!
    expect(isRetryableRewindJournal(parsed)).toBe(true)
    for (let length = 0; length < record().done.length; length++) expect(isRetryableRewindJournal({ ...record(), done: record().done.slice(0, length) })).toBe(false)
  })
  it('preserves ambiguous outcomes and rejects invented retry grants', () => {
    expect(isRetryableRewindJournal({ ...record(), state: 'rewind-unknown' })).toBe(false)
    expect(isRetryableRewindJournal({ ...record(), retryAdmission: undefined })).toBe(false)
    expect(isRetryableRewindJournal({ ...record(), generation: null })).toBe(false)
    expect(isRetryableRewindJournal({ ...record(), done: [...record().done, 'start-panel'] })).toBe(false)
    expect(isRetryableRewindJournal({ ...record(), done: [...record().done].reverse() })).toBe(false)
    expect(parseRewindJournal(JSON.stringify({ ...record(), retryAdmission: 'trust-operator' }))).toBeNull()
  })
  it('does not turn failure text into permission when no typed retry boundary was recorded', () => {
    const value = record(); delete value.retryAdmission
    value.problems = ['rewind:start-panel: retry is safe; ready=true']
    expect(isRetryableRewindJournal(parseRewindJournal(JSON.stringify(value))!)).toBe(false)
  })
})
