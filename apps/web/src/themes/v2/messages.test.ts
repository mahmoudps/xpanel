import { describe, expect, it } from 'vitest'
import { v2Messages } from './messages.ts'

describe('v2 isolated messages', () => {
  it('uses its Arabic catalog and ICU values with ASCII digits', () => {
    expect(v2Messages.translator('ar')(msgctxt('theme:v2', 'Search accounts and settings'))).toBe('ابحث في الحسابات والإعدادات')
    expect(v2Messages.translator('ar')(msgctxt('theme:v2', 'Step {current} of {total}'), { current: 2, total: 4 })).toBe('الخطوة 2 من 4')
    expect(v2Messages.translator('en')(msgctxt('theme:v2', 'Step {current} of {total}'), { current: 2, total: 4 })).toBe('Step 2 of 4')
  })

  it('keeps core copy on the core fallback and refuses another theme namespace', () => {
    const t = v2Messages.translator('ar')
    expect(t('Cancel')).toBe('إلغاء')
    expect(t('Interface theme')).toBe('ثيم الواجهة')
    expect(t(msgctxt('theme:v2', 'Interface theme'))).toBe(t('Interface theme'))
    expect(t('Changing the interface choice is unavailable for this session.')).toBe('تغيير ثيم الواجهة غير متاح لهذه الجلسة.')
    expect(() => t(msgctxt('theme:classic', 'Cancel'))).toThrow('theme_message_scope')
  })

  it('translates page states and tool counts without Arabic digit glyphs', () => {
    const t = v2Messages.translator('ar')
    expect(t(msgctxt('theme:v2', 'Stored certificate'))).toBe('شهادة محفوظة')
    expect(t(msgctxt('theme:v2', 'No installation result has been read.'))).toBe('لم تُقرأ نتيجة للتثبيت.')
    expect(t(msgctxt('theme:v2', 'Slice limits'))).toBe('حدود شريحة الحساب')
    expect(t(msgctxt('theme:v2', 'Account quotas'))).toBe('حصص الحساب')
    const tools = msgctxt('theme:v2', '{count, plural, one {# tool} other {# tools}} in {groups, plural, one {# group} other {# groups}}')
    expect(t(tools, { count: 2, groups: 1 })).toBe('أداتان ضمن مجموعة واحدة')
    expect(t(tools, { count: 3, groups: 2 })).toBe('3 أدوات ضمن مجموعتين')
    for (const value of v2Messages.forClient('ar').messages.values()) {
      expect(value.trim()).not.toBe('')
      expect(value).not.toMatch(/[\u0660-\u0669\u06F0-\u06F9]/)
    }
  })

  it('preserves privilege names, disable semantics and handed-off security states', () => {
    const t = v2Messages.translator('ar')
    const privileges = msgctxt('theme:v2', '{count, plural, one {Other counts DROP, INDEX, REFERENCES and # advanced privilege.} other {Other counts DROP, INDEX, REFERENCES and # advanced privileges.}}')
    expect(t(privileges, { count: 9 })).toBe('يشمل «أخرى» DROP وINDEX وREFERENCES و9 صلاحيات متقدمة.')
    expect(t(msgctxt('theme:v2', 'Disable {tool} in {list}'), { tool: 'FTP', list: 'Starter' })).toBe('تعطيل FTP في Starter')
    expect(t(msgctxt('account-security', 'Password sign-in is active.'))).toBe('تسجيل الدخول بكلمة المرور مفعّل.')
    expect(t(msgctxt('account-security', 'Two-factor settings cannot be changed from a handed-off session.'))).toBe('لا يمكن تغيير إعدادات التحقق بخطوتين من جلسة مفتوحة نيابةً عن الحساب.')
  })

  it('keeps boot behavior, deployment scope and public-key requirements precise', () => {
    const t = v2Messages.translator('ar')
    expect(t(msgctxt('theme:v2', 'Start at boot'))).toBe('التشغيل عند الإقلاع')
    expect(t(msgctxt('theme:v2', 'Application deployments'))).toBe('عمليات نشر التطبيقات')
    expect(t(msgctxt('theme:v2', 'Latest recorded scan.'))).toBe('آخر فحص مسجّل.')
    const keyRequirements = t(msgctxt('theme:v2', 'Paste one Ed25519, ECDSA or RSA public key line. RSA requires at least 3072 bits. Key option prefixes are refused.'))
    for (const token of ['Ed25519', 'ECDSA', 'RSA', '3072']) expect(keyRequirements).toContain(token)
    expect(keyRequirements).not.toMatch(/[\u0660-\u0669\u06F0-\u06F9]/)
  })

  it('gives each response an owned copy of only the v2 overlay', () => {
    const first = v2Messages.forClient('ar')
    expect(first.themeId).toBe('v2')
    expect(first.locale).toBe('ar')
    expect([...first.messages.keys()].every(key => key.startsWith('theme:v2\u0004'))).toBe(true)
    const originalSize = first.messages.size
    ;(first.messages as Map<string, string>).clear()
    expect(originalSize).toBeGreaterThan(0)
    expect(v2Messages.forClient('ar').messages.size).toBe(originalSize)
  })
})
