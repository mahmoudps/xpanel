import { describe, expect, it } from 'vitest'
import { assertFits, fits, limitLte, parseLimit, sumLimits } from './limits.ts'
import { XpanelError } from './errors.ts'

describe('limits', () => {
  it('treats unlimited as explicit top value', () => {
    expect(fits('unlimited', 1e9)).toBe(true)
    expect(fits(2, 2)).toBe(false)
    expect(limitLte(5, 'unlimited')).toBe(true)
    expect(limitLte('unlimited', 5)).toBe(false)
    expect(sumLimits([1, 2, 'unlimited'])).toBe('unlimited')
    expect(sumLimits([1, 2])).toBe(3)
  })
  it('throws LIMIT_EXCEEDED past the cap', () => {
    expect(() => assertFits('addon domains', 1, 1)).toThrowError(XpanelError)
    try { assertFits('addon domains', 1, 1) } catch (e) { expect((e as XpanelError).code).toBe('LIMIT_EXCEEDED') }
  })
  it('parses limits strictly', () => {
    expect(parseLimit('10')).toBe(10)
    expect(() => parseLimit(-1)).toThrow()
    expect(() => parseLimit('1e3')).toThrow()
  })
})
