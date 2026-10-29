// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMailForwarders } from './board-port/xmail-mailbox-forwarders.ts'
import { MAIL_MAILBOX_FORWARDERS_CLIENT_BINDING, forwardAddress, readMailboxForwarders } from './mail-mailbox-forwarders-client.ts'

const MAILBOX = 'alice@example.com', R1 = 'a'.repeat(64), R2 = 'b'.repeat(64)
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const view = (destinations: string[] = [], over: Record<string, unknown> = {}) => ({ context: { mailbox: MAILBOX }, revision: R1, limit: 10, review: null,
  forwarding: destinations.length ? { id: 'r1', destinations, keepCopy: true, createdAt: '2026-10-27T12:00:00.000Z' } : null, application: { status: 'configuration_only', nativeApplied: false }, ...over })
const boot = (html: string, request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ask = vi.fn(async () => true), ar = false) => {
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  document.body.innerHTML = html
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + MAIL_MAILBOX_FORWARDERS_CLIENT_BINDING)()(ask)
  return ask
}
const status = () => document.querySelector<HTMLElement>('[data-forwarders-status]')!
const input = () => document.querySelector<HTMLInputElement>('input[name="destination"]')!
const rows = () => [...document.querySelectorAll('[data-forwarders-rows] tr')].map(row => row.textContent)
beforeEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('mailbox forwarders reader', () => {
  it('accepts only the sealed mailbox and configuration-only application', () => {
    expect(readMailboxForwarders(view(['ext@remote.test']), MAILBOX).destinations).toEqual(['ext@remote.test'])
    for (const value of [view([], { context: { mailbox: 'bob@example.com' } }), view([], { application: { status: 'applied', nativeApplied: true } }), view(['alice@example.com']),
      view(['EXT@remote.test']), view(['a@remote.test', 'a@remote.test']), view([], { revision: 'x' }), view([], { limit: 50 }), view(['ext@remote.test'], { review: 'managed_elsewhere' }),
      view([], { context: { mailbox: MAILBOX, accountId: 'x' } }), { ...view(['ext@remote.test']), forwarding: { id: 'r1', destinations: ['ext@remote.test'], keepCopy: false, createdAt: 'x' } }])
      expect(() => readMailboxForwarders(value, MAILBOX)).toThrow()
    expect(forwardAddress(' Ext@Remote.Test ')).toBe('ext@remote.test')
    for (const value of ['a b@remote.test', '|cmd@remote.test', 'no-at', 'a@b@remote.test', 'a@remote', '"q"@remote.test']) expect(forwardAddress(value)).toBeNull()
  })
})

describe('mailbox forwarders workspace', () => {
  it('renders English and Arabic with ASCII digits, the LTR mailbox and a fixed keep-a-copy choice', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderMailForwarders({ locale, mailbox: MAILBOX, canManage: true })
      expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).toContain('<bdi dir="ltr">alice@example.com</bdi>')
      expect(html).toContain(locale === 'ar' ? 'الاحتفاظ بنسخة في هذا الصندوق' : 'Keep a copy in this mailbox'); expect(html).not.toMatch(/[٠-٩۰-۹]/)
      expect(html).toMatch(/name="keepCopy" checked disabled/)
      expect(html).toContain(locale === 'ar' ? 'أرسل نسخة من البريد الذي يصل إلى <bdi dir="ltr">alice@example.com</bdi> إلى ما يصل إلى 10 عناوين أخرى.' : 'Send a copy of mail that arrives at <bdi dir="ltr">alice@example.com</bdi> to up to 10 other addresses.')
    }
  })
  it('stays inert without admission or inside a read-only ancestor', async () => {
    const send = vi.fn()
    boot(renderMailForwarders({ locale: 'en', mailbox: MAILBOX, canManage: false }), send); await tick()
    expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable'); expect(input().disabled).toBe(true)
    boot(`<div data-read-only="true">${renderMailForwarders({ locale: 'en', mailbox: MAILBOX, canManage: true })}</div>`, send); await tick()
    expect(send).not.toHaveBeenCalled()
    document.querySelector<HTMLButtonElement>('[data-forwarders-add]')!.click(); await tick()
    expect(send).not.toHaveBeenCalled()
  })
  it('adds a destination with the captured revision and verifies the read-back', async () => {
    const saved = view(['ext@remote.test'], { revision: R2 })
    const send = vi.fn(async (method: string) => method === 'GET' ? (send.mock.calls.length > 1 ? saved : view()) : { ...saved, stateChanged: true, operation: 'created' })
    boot(renderMailForwarders({ locale: 'en', mailbox: MAILBOX, canManage: true }), send); await tick()
    expect(rows()).toEqual(['No forwarders. Mail stays in this mailbox only.'])
    input().value = 'Ext@Remote.test'; document.querySelector<HTMLButtonElement>('[data-forwarders-add]')!.click(); await tick()
    expect(send).toHaveBeenNthCalledWith(2, 'PUT', '/api/webmail/forwarders', { destinations: ['ext@remote.test'], keepCopy: true, expectedRevision: R1 })
    expect(status().dataset.state).toBe('saved'); expect(rows()).toEqual(['ext@remote.testRemove']); expect(input().value).toBe('')
    expect(document.querySelector('[data-forwarders-count]')!.textContent).toBe('1 of 10 addresses')
    expect(MAIL_MAILBOX_FORWARDERS_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('refuses its own address locally and removes only after confirmation', async () => {
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => method === 'GET'
      ? (send.mock.calls.some(call => call[0] === 'PUT') ? view(['b@remote.test'], { revision: R2 }) : view(['a@remote.test', 'b@remote.test']))
      : { ...view((body as { destinations: string[] }).destinations, { revision: R2 }), stateChanged: true })
    const ask = boot(renderMailForwarders({ locale: 'en', mailbox: MAILBOX, canManage: true }), send, vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)); await tick()
    input().value = MAILBOX; document.querySelector<HTMLButtonElement>('[data-forwarders-add]')!.click(); await tick()
    expect(status().textContent).toContain('send mail back to this mailbox'); expect(send).toHaveBeenCalledTimes(1)
    const remove = () => document.querySelector<HTMLButtonElement>('[data-forwarders-remove="a@remote.test"]')!.click()
    remove(); await tick(); expect(send).toHaveBeenCalledTimes(1)
    remove(); await tick()
    expect(ask).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith('PUT', '/api/webmail/forwarders', { destinations: ['b@remote.test'], keepCopy: true, expectedRevision: R1 })
    expect(rows()).toEqual(['b@remote.testRemove'])
  })
  it('locks on 409 and on unknown outcomes, and explains a server loop refusal', async () => {
    const reject = (status: number, details: Record<string, unknown>) => Object.assign(new Error('refused'), { status, details })
    let outcome: unknown = reject(409, { stateChanged: false })
    const send = vi.fn(async (method: string) => { if (method === 'GET') return view(); throw outcome })
    boot(renderMailForwarders({ locale: 'en', mailbox: MAILBOX, canManage: true }), send); await tick()
    const add = (value: string) => { input().value = value; document.querySelector<HTMLButtonElement>('[data-forwarders-add]')!.click() }
    add('x@remote.test'); await tick()
    expect(status().dataset.state).toBe('stale'); expect(input().disabled).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-forwarders-refresh]')!.click(); await tick()
    expect(status().dataset.state).toBe('read'); expect(input().disabled).toBe(false)
    outcome = reject(422, { stateChanged: false, reason: 'FORWARD_LOOP' }); add('bob@example.com'); await tick()
    expect(status().textContent).toBe('That address would send mail back to this mailbox, so it was refused. Nothing changed.'); expect(input().disabled).toBe(false)
    outcome = reject(503, { stateChanged: true, verificationRequired: true }); add('y@remote.test'); await tick()
    expect(status().dataset.state).toBe('uncertain'); expect(document.querySelector<HTMLButtonElement>('[data-forwarders-add]')!.disabled).toBe(true)
  })
  it('shows a managed-elsewhere record as read-only and reports failures in Arabic', async () => {
    boot(renderMailForwarders({ locale: 'en', mailbox: MAILBOX, canManage: true }), vi.fn(async () => view([], { review: 'managed_elsewhere' }))); await tick()
    expect(status().dataset.state).toBe('review'); expect(input().disabled).toBe(true)
    boot(renderMailForwarders({ locale: 'ar', mailbox: MAILBOX, canManage: true }), vi.fn(async () => { throw Object.assign(new Error('forbidden'), { status: 403 }) }), undefined, true); await tick()
    expect(status().textContent).toBe('التحويل غير متاح لهذا الصندوق. لا يُعرض شيء.')
  })
})
