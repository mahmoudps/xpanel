// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { renderWhmPanelNotificationsWorkspace } from './board-port/whm-panel-notifications-workspace.ts'
import { readPanelNotificationsView, WHM_PANEL_NOTIFICATIONS_CLIENT_BINDING } from './whm-panel-notifications-client.ts'

const EVENTS = ['monitoring.alert', 'auth.lockout', 'auth.login_failed', 'auth.2fa_disabled', 'reconcile.failed', 'reconcile.rolled_back', 'upgrade.handoff_failed', 'agent.internal_error', 'api.internal_error']
const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64), HOOK = 'https://hooks.example.com/xpanel'
const KEY = { fingerprint: '0123456789abcdef', createdAt: '2026-10-27T09:00:00.000Z', createdBy: 'root' }
const delivery = { events: ['monitoring.alert'], email: 'local_mta', webhook: 'https_signed', test: 'available' }
const view = (overrides: Record<string, unknown> = {}) => ({ state: 'default', settings: null, revision: R1, events: EVENTS, delivery, signingKey: null, ...overrides })
const saved = (settings: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => view({ state: 'saved', revision: R2,
  settings: { recipients: ['ops@example.com'], events: ['monitoring.alert'], webhook: null, updatedAt: '2026-10-27T10:00:00.000Z', updatedBy: 'root', ...settings }, ...overrides })
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = (send?: Send, locale: 'en' | 'ar' = 'en', canManage = true) => {
  document.body.innerHTML = renderWhmPanelNotificationsWorkspace({ locale, canManage })
  if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  new Function('return ' + WHM_PANEL_NOTIFICATIONS_CLIENT_BINDING)()()
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const submit = () => $<HTMLFormElement>('[data-whm-notifications-form]').dispatchEvent(new Event('submit', { cancelable: true }))
const click = (selector: string) => $<HTMLButtonElement>(selector).click()

beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
afterEach(() => { document.body.innerHTML = ''; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; vi.restoreAllMocks() })

describe('WHM notifications client parser', () => {
  it('accepts only the delivery contract the API serves and consistent settings', () => {
    expect(readPanelNotificationsView(view()).settings).toBeNull()
    expect(readPanelNotificationsView(saved({ webhook: { url: HOOK, enabled: true } }, { signingKey: KEY })).settings?.webhook).toEqual({ url: HOOK, enabled: true })
    expect(readPanelNotificationsView(view({ createdSigningKey: 'whsec_' + 'a'.repeat(43) })).createdSigningKey).toBe('whsec_' + 'a'.repeat(43))
    for (const bad of [view({ delivery: { ...delivery, test: 'unavailable' } }), view({ delivery: { ...delivery, events: ['not.listed'] } }), view({ state: 'saved' }),
      saved({ events: ['not.listed'] }), saved({ recipients: ['<b>@x'] }), saved({ webhook: { url: 'http://hooks.example.com', enabled: true } }), view({ revision: 'x' }),
      view({ signingKey: { ...KEY, fingerprint: 'zz' } }), view({ createdSigningKey: 'secret' }), view({ test: { at: KEY.createdAt, results: [{ channel: 'sms', error: null, status: null }] } })])
      expect(() => readPanelNotificationsView(bad), JSON.stringify(bad).slice(0, 120)).toThrow()
  })
})

describe('WHM notifications client binding', () => {
  it('sends nothing without transport or admission and keeps every control disabled', async () => {
    const send = vi.fn<Send>()
    boot(send, 'en', false)
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect($('[data-whm-notifications-status]').dataset.state).toBe('unavailable')
    for (const selector of ['[data-whm-notifications-test]', '[data-whm-notifications-key]', '[data-whm-notifications-webhook-url]']) expect($<HTMLButtonElement>(selector).disabled).toBe(true)
    expect(WHM_PANEL_NOTIFICATIONS_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_PANEL_NOTIFICATIONS_CLIENT_BINDING).not.toContain('fetch(')
  })

  it('reads saved settings, saves recipients, events and the webhook under the observed revision', async () => {
    const send: Mock<Send> = vi.fn<Send>(async (method) => method === 'GET' ? saved({}, { signingKey: KEY }) : saved({ recipients: ['ops@example.com', 'noc@example.com'], events: ['monitoring.alert', 'auth.lockout'], webhook: { url: HOOK, enabled: true } }, { signingKey: KEY }))
    boot(send)
    await flush()
    expect($<HTMLTextAreaElement>('[data-whm-notifications-recipients]').value).toBe('ops@example.com')
    expect($<HTMLInputElement>('input[value="monitoring.alert"]').checked).toBe(true)
    expect($('[data-whm-notifications-field="updated"]').textContent).toBe('2026-10-27 10:00 UTC')
    expect($('[data-whm-notifications-field="signingKey"]').textContent).toBe('Fingerprint 0123456789abcdef, created 2026-10-27 09:00 UTC by root')
    expect($('[data-whm-notifications-key]').textContent).toBe('Replace signing key')
    expect($<HTMLButtonElement>('[data-whm-notifications-test]').disabled).toBe(false)
    $<HTMLTextAreaElement>('[data-whm-notifications-recipients]').value = 'ops@example.com\nnoc@example.com'
    $<HTMLInputElement>('input[value="auth.lockout"]').checked = true
    $<HTMLInputElement>('[data-whm-notifications-webhook-enabled]').checked = true
    $<HTMLInputElement>('[data-whm-notifications-webhook-url]').value = HOOK
    submit(); await flush()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/panel/notifications', { recipients: ['ops@example.com', 'noc@example.com'], events: ['monitoring.alert', 'auth.lockout'], webhook: { url: HOOK, enabled: true }, expectedRevision: R2 })
    expect($('[data-whm-notifications-save-status]').textContent).toBe('Settings saved. Monitoring alerts are sent to the saved channels from the next evaluation.')
    expect($<HTMLInputElement>('[data-whm-notifications-webhook-enabled]').checked).toBe(true)
  })

  it('validates recipients and the webhook locally, and explains a conflict', async () => {
    const send: Mock<Send> = vi.fn<Send>(async (method) => { if (method === 'GET') return view(); throw Object.assign(new Error('changed'), { status: 409 }) })
    boot(send)
    await flush()
    expect($<HTMLButtonElement>('[data-whm-notifications-test]').disabled).toBe(true)
    $<HTMLInputElement>('input[value="auth.lockout"]').checked = true
    submit(); await flush()
    expect($('[data-whm-notifications-recipients]').getAttribute('aria-invalid')).toBe('true')
    $<HTMLInputElement>('[data-whm-notifications-webhook-url]').value = 'http://hooks.example.com'
    submit(); await flush()
    expect($('[data-whm-notifications-webhook-url]').getAttribute('aria-invalid')).toBe('true')
    $<HTMLInputElement>('[data-whm-notifications-webhook-url]').value = HOOK
    $<HTMLInputElement>('[data-whm-notifications-webhook-enabled]').checked = true
    submit(); await flush()
    expect($('[data-whm-notifications-save-status]').textContent).toBe('Create a signing key before enabling the webhook.')
    expect(send.mock.calls.some(([method]) => method === 'PUT')).toBe(false)
    $<HTMLInputElement>('[data-whm-notifications-webhook-enabled]').checked = false
    $<HTMLTextAreaElement>('[data-whm-notifications-recipients]').value = 'ops@example.com'
    submit(); await flush()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/panel/notifications', { recipients: ['ops@example.com'], events: ['auth.lockout'], webhook: { url: HOOK, enabled: false }, expectedRevision: R1 })
    expect($('[data-whm-notifications-save-status]').textContent).toBe('The settings changed since they were read. Reload them before saving.')
  })

  it('creates a signing key and shows it once', async () => {
    const created = 'whsec_' + 'Z'.repeat(43)
    const send: Mock<Send> = vi.fn<Send>(async (method) => method === 'GET' ? view() : view({ signingKey: KEY, createdSigningKey: created }))
    boot(send); await flush()
    expect($('[data-whm-notifications-key]').textContent).toBe('Create signing key')
    click('[data-whm-notifications-key]'); await flush()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/panel/notifications/webhook-key')
    expect($('[data-whm-notifications-key-status] code').textContent).toBe(created)
    expect($('[data-whm-notifications-key-status]').textContent).toContain('It is not shown again.')
    expect($('[data-whm-notifications-field="signingKey"]').textContent).toContain('0123456789abcdef')
    expect(document.body.textContent!.split(created)).toHaveLength(2)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    click('[data-whm-notifications-key]'); await flush()
    expect(send.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1)
  })

  it('sends a test message and reports each channel', async () => {
    const send: Mock<Send> = vi.fn<Send>(async (method) => method === 'GET' ? saved({ webhook: { url: HOOK, enabled: true } }, { signingKey: KEY })
      : saved({ webhook: { url: HOOK, enabled: true } }, { signingKey: KEY, test: { at: KEY.createdAt, results: [{ channel: 'email', error: null, status: null }, { channel: 'webhook', error: 'rejected_status', status: 503 }] } }))
    boot(send); await flush()
    click('[data-whm-notifications-test]'); await flush()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/panel/notifications/test')
    expect($('[data-whm-notifications-test-status]').textContent).toBe('Email: sent. Webhook: not sent: the receiver answered with status 503.')
    expect($('[data-whm-notifications-test-status]').dataset.state).toBe('failed')
  })

  it('reports an invalid saved file and a failed read truthfully, in Arabic too', async () => {
    boot(vi.fn<Send>(async () => view({ state: 'invalid' })), 'ar')
    await flush()
    expect($('[data-whm-notifications-status]').dataset.state).toBe('failed')
    expect($('[data-whm-notifications-status]').textContent).toMatch(/[؀-ۿ]/)
    boot(vi.fn<Send>(async () => ({ state: 'saved' })))
    await flush()
    expect($('[data-whm-notifications-status]').dataset.state).toBe('failed')
    expect($<HTMLButtonElement>('[data-whm-notifications-save]').disabled).toBe(true)
  })
})

describe('complete notification timestamps', () => {
  it.each(['en', 'ar'] as const)('preserves the complete saved instant in %s', async locale => {
    const instant = '2026-10-27T10:11:12.345Z'
    const send = vi.fn<Send>(async () => saved({ updatedAt: instant }))
    boot(send, locale); await flush()
    const timestamp = $('[data-whm-notifications-field="updated"] bdi')
    expect(timestamp.textContent).toBe('2026-10-27 10:11 UTC')
    expect(timestamp.getAttribute('dir')).toBe('ltr')
    expect(send.mock.calls).toEqual([['GET', '/api/server/panel/notifications']])
  })
})
