// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceUser } from '@xpanel/core'
import { v2Messages } from './themes/v2/messages.ts'
import { renderV2EmailAccountsPage } from './themes/v2/pages/xpanel/email/accounts.ts'
import { ACCOUNT_CONNECT_DEVICES_CLIENT_BINDING, readAccountConnectDevicesView } from './account-connect-devices-client.ts'

const t = v2Messages.translator('en')
const users: ServiceUser[] = [
  { id: 'u1', accountId: 'acc1', login: 'info@alice.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 256, ftpDir: '' },
  { id: 'u2', accountId: 'acc1', login: 'sales@alice.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 256, ftpDir: '' },
]

const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const viewFor = (mailbox: string, hostname: string | null = 'mail.alice.example.test') => ({
  context: { username: 'alice', mailboxes: users.map(u => u.login) },
  mailbox,
  username: mailbox,
  hostname,
  incoming: [{ protocol: 'imap', port: 993, security: 'implicit-tls' }, { protocol: 'imap', port: 143, security: 'starttls' }],
  outgoing: [{ protocol: 'smtp', port: 465, security: 'implicit-tls' }, { protocol: 'smtp', port: 587, security: 'starttls' }],
  pop3: 'not-offered',
  authentication: 'password',
  passwordIncluded: false,
  certificate: 'not-verified-by-this-page',
  downloads: hostname ? [
    { kind: 'autoconfig', path: '/api/account/email/connect-devices/autoconfig.xml?mailbox=' + encodeURIComponent(mailbox), filename: 'config-v1.1.xml' },
    { kind: 'apple', path: '/api/account/email/connect-devices/apple.mobileconfig?mailbox=' + encodeURIComponent(mailbox), filename: 'mail-account.mobileconfig' },
  ] : [],
})

beforeEach(() => {
  document.documentElement.lang = 'en'
  document.documentElement.dir = 'ltr'
  document.body.innerHTML = renderV2EmailAccountsPage(t, {
    account: { username: 'alice', primaryDomain: 'alice.example.test' },
    domains: { state: 'read', items: [{ id: 'd1', name: 'alice.example.test' }] },
    users: { state: 'read', items: users },
    canManage: true,
  })
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})

afterEach(() => {
  document.body.replaceChildren()
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})

describe('account connect devices client binding', () => {
  it('compiles cleanly without innerHTML, fetch, or dynamic querySelector calls', () => {
    expect(() => new Function('return ' + ACCOUNT_CONNECT_DEVICES_CLIENT_BINDING)()).not.toThrow()
    expect(ACCOUNT_CONNECT_DEVICES_CLIENT_BINDING).not.toContain('innerHTML')
    expect(ACCOUNT_CONNECT_DEVICES_CLIENT_BINDING).not.toContain('fetch(')
  })

  it('switches mailboxes, updates download links, and sends instructions for the selected mailbox', async () => {
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET') {
        const mailbox = new URL('http://x.test' + path).searchParams.get('mailbox') ?? 'info@alice.example.test'
        return viewFor(mailbox)
      }
      expect(path).toBe('/api/account/email/connect-devices/send-instructions')
      expect(body).toEqual({ mailbox: 'sales@alice.example.test', email: 'me@external.test' })
      return { sent: true, mailbox: 'sales@alice.example.test' }
    })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    new Function('return ' + ACCOUNT_CONNECT_DEVICES_CLIENT_BINDING)()
    await tick()

    expect(document.querySelector('[data-account-devices-hostname]')!.textContent).toBe('mail.alice.example.test')
    const select = document.querySelector<HTMLSelectElement>('[data-account-devices-mailbox]')!
    select.value = 'sales@alice.example.test'
    select.dispatchEvent(new Event('change'))
    await tick()

    const autoconfig = document.querySelector<HTMLAnchorElement>('[data-account-devices-download="autoconfig"]')!
    expect(autoconfig.getAttribute('href')).toBe('/api/account/email/connect-devices/autoconfig.xml?mailbox=sales%40alice.example.test')

    const emailInput = document.querySelector<HTMLInputElement>('[data-account-devices-send-email]')!
    emailInput.value = 'me@external.test'
    document.querySelector<HTMLFormElement>('[data-account-devices-send-form]')!.requestSubmit()
    await tick()
    expect(document.querySelector('[data-account-devices-send-status]')!.getAttribute('data-state')).toBe('read')
    expect(readAccountConnectDevicesView(viewFor('sales@alice.example.test'), 'sales@alice.example.test').mailbox).toBe('sales@alice.example.test')
  })
})
