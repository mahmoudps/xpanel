import { describe, expect, it, vi } from 'vitest'
import type { Account, ServiceUser } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from '../auth.ts'
import { renderAppleMailProfile, renderMailAutoconfig } from './device-setup.ts'
import { handleAccountConnectDevicesRoute, type AccountConnectDevicesPorts } from './account-device-setup.ts'

const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_ACCOUNT_ID = '99999999-9999-4999-8999-999999999999'
const HOST = 'mail1.example.test'

const account = { id: ACCOUNT_ID, username: 'alice', status: 'active', planId: 'plan', primaryDomain: 'alice.example.test' } as Account
const ownerCaller = { principal: { kind: 'user', id: 'user-1', username: 'alice', accountId: ACCOUNT_ID }, sessionId: 's1', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const rootCaller = { principal: { kind: 'root', id: 'root', username: 'root' }, sessionId: 's2', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const mailboxCaller = { principal: { kind: 'mailbox', id: 'mb-1', username: 'info@alice.example.test', accountId: ACCOUNT_ID, mailbox: 'info@alice.example.test' }, sessionId: 's3', apiTokenId: null, scopes: ['mailbox:info@alice.example.test'], principalRecord: {} } as unknown as AuthenticatedCaller

const aliceMailboxes: ServiceUser[] = [
  { id: 'u1', accountId: ACCOUNT_ID, login: 'info@alice.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: '' },
  { id: 'u2', accountId: ACCOUNT_ID, login: 'support@alice.example.test', services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 100, ftpDir: '' },
  { id: 'u3', accountId: ACCOUNT_ID, login: 'ftp@alice.example.test', services: { email: false, ftp: true, webdisk: false }, mailboxQuotaMb: 0, ftpDir: 'public_html' },
  { id: 'u4', accountId: OTHER_ACCOUNT_ID, login: 'secret@other.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: '' },
]

function setup(options: { caller?: AuthenticatedCaller; account?: Account; disabled?: string[]; users?: ServiceUser[]; hostname?: string | null } = {}) {
  const sent: { to: string[]; subject: string; text: string }[] = []
  const emitAudit = vi.fn(async () => undefined)
  const currentAccount = options.account ?? account
  const users = options.users ?? aliceMailboxes
  const ports: AccountConnectDevicesPorts = {
    store: {
      getAccount: async (id: string) => id === currentAccount.id ? currentAccount : null,
      getPlan: async () => ({ featureListId: 'fl-1' }),
      getFeatureList: async () => ({ disabled: options.disabled ?? [] }),
      listServiceUsers: async (id: string) => users.filter(u => u.accountId === id),
    } as unknown as StateStore,
    requireCaller: async () => options.caller ?? ownerCaller,
    readHostname: async () => options.hostname === undefined ? HOST : options.hostname,
    sendEmail: async message => { sent.push(message) },
    emitAudit,
    now: () => 1_700_000_000_000,
  }
  const call = (path: string, method = 'GET', body?: unknown) => {
    const url = new URL('http://xpanel.test' + path)
    return handleAccountConnectDevicesRoute(
      new Request(url, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      }),
      url,
      method,
      ports,
    )
  }
  return { call, sent, emitAudit }
}

describe('account-level connect devices bridge', () => {
  it('returns settings and download links for any selected owned mailbox and reuses device-setup renderers', async () => {
    const h = setup()
    const view = await (await h.call('/api/account/email/connect-devices?mailbox=support@alice.example.test'))!.json() as Record<string, any>
    expect(view).toMatchObject({
      context: { username: 'alice', mailboxes: ['info@alice.example.test', 'support@alice.example.test'] },
      mailbox: 'support@alice.example.test',
      username: 'support@alice.example.test',
      hostname: HOST,
      pop3: 'not-offered',
      passwordIncluded: false,
    })
    expect(view.downloads.map((d: { path: string }) => d.path)).toEqual([
      '/api/account/email/connect-devices/autoconfig.xml?mailbox=support%40alice.example.test',
      '/api/account/email/connect-devices/apple.mobileconfig?mailbox=support%40alice.example.test',
    ])

    const xmlRes = (await h.call('/api/account/email/connect-devices/autoconfig.xml?mailbox=support@alice.example.test'))!
    expect(xmlRes.headers.get('content-type')).toBe('application/xml; charset=utf-8')
    expect(await xmlRes.text()).toBe(renderMailAutoconfig('support@alice.example.test', HOST))

    const appleRes = (await h.call('/api/account/email/connect-devices/apple.mobileconfig?mailbox=support@alice.example.test'))!
    expect(appleRes.headers.get('content-type')).toBe('application/x-apple-aspen-config')
    expect(await appleRes.text()).toBe(renderAppleMailProfile('support@alice.example.test', HOST))
  })

  it('refuses foreign mailboxes, FTP-only users, mailbox principals, root, inactive accounts, and disabled features', async () => {
    const h = setup()
    await expect(h.call('/api/account/email/connect-devices?mailbox=secret@other.example.test')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(h.call('/api/account/email/connect-devices?mailbox=ftp@alice.example.test')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(h.call('/api/account/email/connect-devices?mailbox=info@alice.example.test&extra=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(setup({ caller: mailboxCaller }).call('/api/account/email/connect-devices')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setup({ caller: rootCaller }).call('/api/account/email/connect-devices')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setup({ account: { ...account, status: 'suspended' } }).call('/api/account/email/connect-devices')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setup({ disabled: ['connect-devices'] }).call('/api/account/email/connect-devices')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await h.call('/api/account/email/connect-devices', 'POST'))!.status).toBe(405)
  })

  it('sends fixed instructions for an owned mailbox with audit and rate limiting', async () => {
    const h = setup()
    const res = await h.call('/api/account/email/connect-devices/send-instructions', 'POST', { mailbox: 'info@alice.example.test', email: 'me@external.test' })
    expect(res!.status).toBe(200)
    expect(await res!.json()).toEqual({ sent: true, mailbox: 'info@alice.example.test' })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.subject).toBe('Mail client settings for info@alice.example.test')
    expect(h.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.email.connect_devices_sent', target: 'mailbox:info@alice.example.test' }))

    await expect(h.call('/api/account/email/connect-devices/send-instructions', 'POST', { mailbox: 'secret@other.example.test', email: 'me@external.test' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(h.call('/api/account/email/connect-devices/send-instructions', 'POST', { mailbox: 'info@alice.example.test', email: 'invalid' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
