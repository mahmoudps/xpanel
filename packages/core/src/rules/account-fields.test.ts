import { describe, expect, it } from 'vitest'
import { XpanelError } from '../errors.ts'
import { assertUtcDay, validateAccountLogSettings } from './account-fields.ts'

const code = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
}

describe('account field validators', { tags: ['unit'] }, () => {
  it('takes log settings with a bounded or open retention', () => {
    expect(validateAccountLogSettings({ archive: true, removePreviousMonthArchive: false, retentionDays: 7 })).toEqual({ archive: true, removePreviousMonthArchive: false, retentionDays: 7 })
    expect(validateAccountLogSettings({ archive: false, removePreviousMonthArchive: true, retentionDays: null }).retentionDays).toBeNull()
    for (const bad of [null, {}, { archive: 'yes', removePreviousMonthArchive: false, retentionDays: 7 }, { archive: true, removePreviousMonthArchive: false, retentionDays: 0 },
      { archive: true, removePreviousMonthArchive: false, retentionDays: 3651 }, { archive: true, removePreviousMonthArchive: false, retentionDays: 7, path: '/tmp' }]) {
      expect(code(() => validateAccountLogSettings(bad))).toBe('VALIDATION')
    }
  })

  it('takes only real calendar days', () => {
    expect(assertUtcDay('2026-11-06', 'day')).toBe('2026-11-06')
    expect(assertUtcDay('2028-02-29', 'day')).toBe('2028-02-29')
    for (const bad of ['2026-02-30', '2026-13-01', '2026-11-6', '2026-11-06T00:00:00Z', 20261106, null]) expect(code(() => assertUtcDay(bad, 'day'))).toBe('VALIDATION')
  })
})
