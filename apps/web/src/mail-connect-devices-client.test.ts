// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMailConnectDevices } from './board-port/xmail-connect-devices.ts'
import { MAIL_CONNECT_DEVICES_CLIENT_BINDING, readDeviceSetupView } from './mail-connect-devices-client.ts'

const MAILBOX = 'alice@example.com'
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const view = (over: Record<string, unknown> = {}) => ({ mailbox: MAILBOX, username: MAILBOX, hostname: 'server1.example.com',
  incoming: [{ protocol: 'imap', port: 993, security: 'implicit-tls' }, { protocol: 'imap', port: 143, security: 'starttls' }],
  outgoing: [{ protocol: 'smtp', port: 465, security: 'implicit-tls' }, { protocol: 'smtp', port: 587, security: 'starttls' }],
  pop3: 'not-offered', authentication: 'password', passwordIncluded: false, certificate: 'not-verified-by-this-page',
  downloads: [{ kind: 'autoconfig', path: '/api/webmail/connect-devices/autoconfig.xml', filename: 'config-v1.1.xml', contentType: 'application/xml; charset=utf-8' },
    { kind: 'apple', path: '/api/webmail/connect-devices/apple.mobileconfig', filename: 'mail-account.mobileconfig', contentType: 'application/x-apple-aspen-config' }], ...over })
const boot = (html: string, request?: (method: string, path: string) => Promise<unknown>, ar = false) => {
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  document.body.innerHTML = html
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + MAIL_CONNECT_DEVICES_CLIENT_BINDING)()()
}
const status = () => document.querySelector<HTMLElement>('[data-mail-devices-status]')!
beforeEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('xMail connect devices reader', () => {
  it('accepts only the sealed mailbox, rendered ports and passwordless files', () => {
    expect(readDeviceSetupView(view(), MAILBOX).incoming.map(item => item.port)).toEqual([993, 143])
    for (const value of [view({ username: 'bob@example.com' }), view({ mailbox: 'bob@example.com' }), view({ password: 'x' }), view({ passwordIncluded: true }), view({ pop3: 'offered' }),
      view({ incoming: [{ protocol: 'imap', port: 110, security: 'starttls' }, { protocol: 'imap', port: 143, security: 'starttls' }] }), view({ certificate: 'valid' }),
      view({ downloads: [{ kind: 'apple', path: 'https://evil.test/p.mobileconfig', filename: 'p.mobileconfig' }] }), view({ hostname: null }), view({ hostname: 'evil.test/x' })]) expect(() => readDeviceSetupView(value, MAILBOX)).toThrow()
    expect(readDeviceSetupView(view({ hostname: null, downloads: [] }), MAILBOX).hostname).toBeNull()
  })
})

describe('xMail connect devices workspace', () => {
  it('renders English and Arabic with ASCII digits, the LTR mailbox and hidden downloads', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderMailConnectDevices({ locale, mailbox: MAILBOX, canManage: true })
      expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).toContain('<bdi dir="ltr">alice@example.com</bdi>')
      expect(html).toContain(locale === 'ar' ? 'لم تتحقق منها هذه الصفحة' : 'Not verified by this page'); expect(html).not.toMatch(/[٠-٩۰-۹]/)
      expect(html).not.toMatch(/href=/)
    }
  })
  it('makes no request without admission and keeps downloads disabled', async () => {
    const send = vi.fn()
    boot(renderMailConnectDevices({ locale: 'en', mailbox: MAILBOX, canManage: false }), send); await tick()
    expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
    expect([...document.querySelectorAll<HTMLAnchorElement>('[data-mail-devices-download]')].every(link => link.hidden && !link.href)).toBe(true)
  })
  it('shows rendered ports, POP3 not offered and enables both setup files', async () => {
    const send = vi.fn(async () => view())
    boot(renderMailConnectDevices({ locale: 'en', mailbox: MAILBOX, canManage: true }), send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/webmail/connect-devices')
    const rows = [...document.querySelectorAll('[data-mail-devices-rows] tr')].map(row => row.textContent)
    expect(rows).toEqual(['Incoming (IMAP)server1.example.com993SSL/TLSalice@example.com', 'Incoming (IMAP)server1.example.com143STARTTLSalice@example.com', 'Outgoing (SMTP)server1.example.com465SSL/TLSalice@example.com', 'Outgoing (SMTP)server1.example.com587STARTTLSalice@example.com', 'POP3Not offered by this server'])
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-mail-devices-download]')]
    expect(links.map(link => [link.getAttribute('href'), link.getAttribute('download'), link.hidden])).toEqual([['/api/webmail/connect-devices/autoconfig.xml', 'config-v1.1.xml', false], ['/api/webmail/connect-devices/apple.mobileconfig', 'mail-account.mobileconfig', false]])
    expect(MAIL_CONNECT_DEVICES_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('keeps files hidden without a saved hostname and reports failures in Arabic', async () => {
    boot(renderMailConnectDevices({ locale: 'en', mailbox: MAILBOX, canManage: true }), vi.fn(async () => view({ hostname: null, downloads: [] }))); await tick()
    expect(document.querySelector('[data-mail-devices-fact="hostname"]')!.textContent).toBe('Server hostname not saved')
    expect([...document.querySelectorAll<HTMLAnchorElement>('[data-mail-devices-download]')].every(link => link.hidden)).toBe(true)
    boot(renderMailConnectDevices({ locale: 'ar', mailbox: MAILBOX, canManage: true }), vi.fn(async () => { throw Object.assign(new Error('forbidden'), { status: 403 }) }), true); await tick()
    expect(status().textContent).toBe('إعداد تطبيقات البريد غير متاح لهذا الصندوق. لا يُعرض شيء.')
  })
  it('sends the instructions to one address and reports refusals without a false success', async () => {
    const replies: unknown[] = [{ sent: true }, Object.assign(new Error('x'), { code: 'LIMIT_EXCEEDED', details: { stateChanged: false } }), Object.assign(new Error('x'), { code: 'VALIDATION', details: { stateChanged: false } }), Object.assign(new Error('x'), { details: { unknownOutcome: true } })]
    const request = vi.fn(async (method: string, _path: string, _body?: unknown) => { if (method === 'GET') return view(); const next = replies.shift(); if (next instanceof Error) throw next; return next })
    boot(renderMailConnectDevices({ locale: 'en', mailbox: MAILBOX, canManage: true }), request); await tick()
    const email = document.querySelector<HTMLInputElement>('[data-mail-devices-send-email]')!, form = document.querySelector<HTMLFormElement>('[data-mail-devices-send-form]')!
    const status = () => document.querySelector('[data-mail-devices-send-status]')!.textContent
    const submit = async (value: string) => { email.value = value; form.dispatchEvent(new Event('submit', { cancelable: true })); await tick() }
    expect(email.disabled).toBe(false)
    await submit('')
    expect(request).toHaveBeenCalledTimes(1); expect(status()).toContain('Enter an email address')
    await submit(' bob@example.net ')
    expect(request).toHaveBeenLastCalledWith('POST', '/api/webmail/connect-devices/send-instructions', { email: 'bob@example.net' })
    expect(status()).toContain('Delivery is not confirmed')
    await submit('bob@example.net'); expect(status()).toContain('At most 5')
    await submit('nope'); expect(status()).toContain('valid email')
    await submit('bob@example.net'); expect(status()).toContain('could not be confirmed')
    expect(document.querySelector<HTMLButtonElement>('[data-mail-devices-send]')!.disabled).toBe(false)
  })
  it('keeps the send form closed without a saved hostname or admission', async () => {
    boot(renderMailConnectDevices({ locale: 'en', mailbox: MAILBOX, canManage: true }), vi.fn(async () => view({ hostname: null, downloads: [] }))); await tick()
    expect(document.querySelector<HTMLButtonElement>('[data-mail-devices-send]')!.disabled).toBe(true)
    boot(renderMailConnectDevices({ locale: 'en', mailbox: MAILBOX, canManage: false }), vi.fn(async () => view())); await tick()
    expect(document.querySelector<HTMLInputElement>('[data-mail-devices-send-email]')!.disabled).toBe(true)
  })
})
