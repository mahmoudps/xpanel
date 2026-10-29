import { describe, expect, it } from 'vitest'
import { v2Messages } from './messages.ts'

describe('v2 isolated messages', () => {
  it('uses its Arabic catalog and ICU values with ASCII digits', () => {
    expect(v2Messages.translator('ar')(msgctxt('theme:v2', 'Search accounts and settings'))).toBe('ابحث في الحسابات والإعدادات')
    expect(v2Messages.translator('ar')(msgctxt('theme:v2', 'Step {current} of {total}'), { current: 2, total: 4 })).toBe('الخطوة 2 من 4')
    expect(v2Messages.translator('en')(msgctxt('theme:v2', 'Step {current} of {total}'), { current: 2, total: 4 })).toBe('Step 2 of 4')
  })

  it('keeps core copy on the core fallback and refuses another theme namespace', () => {
    expect(v2Messages.translator('ar')('Cancel')).toBe('إلغاء')
    expect(() => v2Messages.translator('ar')(msgctxt('theme:classic', 'Cancel'))).toThrow('theme_message_scope')
  })

  it('gives each response an owned copy of only the v2 overlay', () => {
    const first = v2Messages.forClient('ar')
    expect(first.themeId).toBe('v2')
    expect(first.locale).toBe('ar')
    expect([...first.messages.keys()].every(key => key.startsWith('theme:v2\u0004'))).toBe(true)
    ;(first.messages as Map<string, string>).clear()
    expect(v2Messages.forClient('ar').messages.size).toBe(37)
  })
})
