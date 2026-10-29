// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMailPreferences } from './board-port/xmail-mailbox-preferences.ts'
import { MAIL_MAILBOX_PREFERENCES_CLIENT_BINDING, readMailboxPreferences } from './mail-mailbox-preferences-client.ts'

const MAILBOX = 'alice@example.com', R1 = 'a'.repeat(64), R2 = 'b'.repeat(64), ID = '33333333-3333-4333-8333-333333333333'
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const saved = { mailbox: MAILBOX, density: 'compact', messagesPerPage: 100, replyIdentityId: ID, dateFormat: 'local', updatedAt: '2026-10-27T12:00:00.000Z' }
const view = (over: Record<string, unknown> = {}) => ({ context: { mailbox: MAILBOX }, preferences: null, revision: R1, identities: [{ id: ID, displayName: 'Alice Sales', email: 'sales@example.com' }],
  plusAddressing: { state: 'not-supported', delimiter: null, source: 'rendered-postfix-local-delivery' }, application: { status: 'saved_only', applied: false }, review: null, ...over })
const boot = (html: string, request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ask = vi.fn(async () => true), ar = false) => {
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  document.body.innerHTML = html
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + MAIL_MAILBOX_PREFERENCES_CLIENT_BINDING)()(ask)
  return ask
}
const status = () => document.querySelector<HTMLElement>('[data-preferences-status]')!
const select = (name: string) => document.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!
const button = (name: string) => document.querySelector<HTMLButtonElement>(`[data-preferences-${name}]`)!
const choose = (name: string, value: string) => { select(name).value = value; select(name).dispatchEvent(new Event('change')) }
beforeEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('mailbox preferences reader', () => {
  it('accepts the sealed mailbox record and refuses ownership internals or foreign context', () => {
    expect(readMailboxPreferences(view({ preferences: saved }), MAILBOX).preferences).toEqual({ density: 'compact', messagesPerPage: 100, replyIdentityId: ID, dateFormat: 'local', updatedAt: saved.updatedAt })
    for (const value of [view({ context: { mailbox: 'bob@example.com' } }), view({ preferences: { ...saved, ownerAuthority: {} } }), view({ preferences: { ...saved, messagesPerPage: 30 } }),
      view({ preferences: { ...saved, mailbox: 'bob@example.com' } }), view({ application: { status: 'applied', applied: true } }), view({ plusAddressing: { state: 'supported', delimiter: null, source: 'rendered-postfix-local-delivery' } }),
      view({ review: 'mailbox_metadata_binding_unverified', preferences: saved }), view({ identities: [{ id: ID, displayName: 'x', email: 'x@example.com', mailbox: 'bob@example.com' }] }), view({ extra: true })])
      expect(() => readMailboxPreferences(value, MAILBOX)).toThrow()
  })
})

describe('mailbox preferences workspace', () => {
  it('renders English and Arabic with ASCII digits and the LTR mailbox', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderMailPreferences({ locale, mailbox: MAILBOX, canManage: true })
      expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).toContain('<bdi dir="ltr">alice@example.com</bdi>')
      expect(html).toContain(locale === 'ar' ? 'عدد الرسائل في الصفحة' : 'Messages per page'); expect(html).not.toMatch(/[٠-٩۰-۹]/)
      expect(html).toContain('<option value="25">25</option><option value="50">50</option><option value="100">100</option>')
      expect(html).toContain(locale === 'ar' ? 'تُحفظ هذه التفضيلات للصندوق <bdi dir="ltr">alice@example.com</bdi> فقط.' : 'These preferences are saved for <bdi dir="ltr">alice@example.com</bdi> only.')
    }
  })
  it('stays inert without admission', async () => {
    const send = vi.fn()
    boot(renderMailPreferences({ locale: 'en', mailbox: MAILBOX, canManage: false }), send); await tick()
    expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable'); expect(select('density').disabled).toBe(true); expect(button('save').disabled).toBe(true)
  })
  it('shows defaults, saves a changed draft with the captured revision and verifies the read-back', async () => {
    const after = view({ preferences: saved, revision: R2 })
    const send = vi.fn(async (method: string) => method === 'GET' ? (send.mock.calls.some(call => call[0] === 'PUT') ? after : view()) : { ...after, stateChanged: true })
    boot(renderMailPreferences({ locale: 'en', mailbox: MAILBOX, canManage: true }), send); await tick()
    expect([select('density').value, select('messagesPerPage').value, select('replyIdentityId').value, select('dateFormat').value]).toEqual(['comfortable', '50', '', 'utc'])
    expect([...select('replyIdentityId').options].map(option => option.textContent)).toEqual(['This mailbox address (alice@example.com)', 'Alice Sales <sales@example.com>'])
    expect(document.querySelector('[data-preferences-plus]')!.getAttribute('data-state')).toBe('not-supported')
    expect(button('save').disabled).toBe(true)
    choose('density', 'compact'); choose('messagesPerPage', '100'); choose('replyIdentityId', ID); choose('dateFormat', 'local')
    expect(button('save').disabled).toBe(false)
    button('save').click(); await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/webmail/preferences', { density: 'compact', messagesPerPage: 100, replyIdentityId: ID, dateFormat: 'local', expectedRevision: R1 })
    expect(status().dataset.state).toBe('saved'); expect(button('save').disabled).toBe(true)
    expect(document.querySelector('[data-preferences-record]')!.textContent).toBe('Saved for this mailbox at 2026-10-27 12:00 UTC')
  })
  it('locks on 409 until an explicit reload and explains supported plus addressing in Arabic', async () => {
    let put: unknown = Object.assign(new Error('conflict'), { status: 409, details: { stateChanged: false } })
    const send = vi.fn(async (method: string) => { if (method === 'GET') return view({ plusAddressing: { state: 'supported', delimiter: '+', source: 'rendered-postfix-local-delivery' } }); throw put })
    const ask = boot(renderMailPreferences({ locale: 'ar', mailbox: MAILBOX, canManage: true }), send, vi.fn(async () => true), true); await tick()
    expect(document.querySelector('[data-preferences-plus] bdi')!.textContent).toBe('alice+news@example.com')
    expect(select('replyIdentityId').options[0]!.textContent).toBe('عنوان هذا الصندوق (alice@example.com)')
    expect(document.querySelector('[data-preferences-plus]')!.textContent).toBe('يدعمها إعداد خادم البريد. البريد المرسل إلى عنوان بوسم، مثل alice+news@example.com، يُسلَّم إلى هذا الصندوق. هذه الصفحة للشرح فقط ولا تغيّر التسليم.')
    choose('density', 'compact'); button('save').click(); await tick()
    expect(status().dataset.state).toBe('stale'); expect(select('density').disabled).toBe(true)
    button('refresh').click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1); expect(status().dataset.state).toBe('read'); expect(select('density').value).toBe('comfortable')
    put = Object.assign(new Error('gone'), { status: 503, details: { stateChanged: true, verificationRequired: true } })
    choose('dateFormat', 'local'); button('save').click(); await tick()
    expect(status().dataset.state).toBe('uncertain'); expect(status().textContent).toBe('نتيجة الحفظ تتطلب مراجعة. لا تكرر الطلب؛ أعد تحميل التفضيلات المحفوظة للمتابعة.')
  })
  it('shows a record needing review as read-only', async () => {
    boot(renderMailPreferences({ locale: 'en', mailbox: MAILBOX, canManage: true }), vi.fn(async () => view({ review: 'mailbox_metadata_binding_unverified' }))); await tick()
    expect(status().dataset.state).toBe('review'); expect(select('density').disabled).toBe(true)
    expect(document.querySelector('[data-preferences-record]')!.textContent).toContain('need review by your provider')
  })
})

describe('mailbox preference timestamp precision', () => {
  it.each(['en', 'ar'] as const)('preserves and isolates the complete saved UTC timestamp in %s', async locale => {
    const updatedAt = '2026-10-27T12:34:56.789Z'
    const send = vi.fn(async (_method: string, _path: string) => view({ preferences: { ...saved, updatedAt } }))
    boot(renderMailPreferences({ locale, mailbox: MAILBOX, canManage: true }), send, vi.fn(async () => true), locale === 'ar')
    await tick()
    const record = document.querySelector<HTMLElement>('[data-preferences-record]')!
    expect(record.textContent).toContain('2026-10-27 12:34 UTC')
    expect(record.querySelector('bdi[dir="ltr"]')?.textContent).toBe('2026-10-27 12:34 UTC')
    expect(record.textContent).not.toMatch(/[٠-٩۰-۹]/)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GET', '/api/webmail/preferences')
    expect(button('save').disabled).toBe(true)
  })
})
