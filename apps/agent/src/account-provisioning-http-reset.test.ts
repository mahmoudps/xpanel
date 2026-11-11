import { describe, expect, it } from 'vitest'
import { shouldQuarantineCorrelationFailure, transportResetDetail } from './account-provisioning-http.ts'

describe('held exchange transport reset', { tags: ['unit'] }, () => {
  const failure = (code: string) => Object.assign(new Error(`read ${code}`), { code })
  it.each(['ECONNRESET', 'EPIPE'])('marks %s once cleanup settled', code => {
    expect(transportResetDetail(failure(code), true)).toEqual({ transportReset: true })
  })
  it('keeps the plain refusal when cleanup left anything behind', () => {
    expect(transportResetDetail(failure('ECONNRESET'), false)).toEqual({})
  })
  it.each([['a refused connection', failure('ECONNREFUSED')], ['a deadline', new Error('held account HTTP deadline')], ['no failure', undefined]])('keeps the plain refusal for %s', (_name, value) => {
    expect(transportResetDetail(value, true)).toEqual({})
  })
  it('does not quarantine settled pre-exchange source refusals', () => {
    expect(shouldQuarantineCorrelationFailure(false, true)).toBe(false)
    expect(shouldQuarantineCorrelationFailure(false, false)).toBe(true)
    expect(shouldQuarantineCorrelationFailure(true, true)).toBe(true)
    expect(shouldQuarantineCorrelationFailure(true, false)).toBe(true)
  })
})
