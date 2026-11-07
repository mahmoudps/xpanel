import { describe, expect, it } from 'vitest'
import type { Account, Certificate, Domain, Plan, ServiceUser } from '@xpanel/core'
import { DAV_PROFILE_PATH, davPrincipal, handleDavWorkspaceRoute, handleWebmailDavConfigRoute, readDavConfigView, readWebDiskView, WEBMAIL_DAV_CONFIG_PATH, WEBMAIL_DAV_PROFILE_PATH } from './dav-workspace.ts'

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'
const account = { id: ACCOUNT_ID, username: 'alice' } as Account
const cert = { id: '22222222-2222-4222-8222-222222222222', accountId: ACCOUNT_ID, names: ['alice.test', 'www.alice.test'] } as Certificate
const domain = (name: string, extra: Partial<Domain> = {}) => ({ id: name, accountId: ACCOUNT_ID, name, suspended: false, certificateId: null, ...extra } as Domain)
const user = (login: string, services: ServiceUser['services'], extra: Partial<ServiceUser> = {}): ServiceUser =>
  ({ id: `00000000-0000-4000-8000-${login.length.toString().padStart(12, '0')}`, accountId: ACCOUNT_ID, login, services, mailboxQuotaMb: 100, ftpDir: 'public_html', ...extra })

describe('Web Disk view', { tags: ['unit'] }, () => {
  it('lists the main login and Web Disk users, and serves only names with a certificate', () => {
    const view = readWebDiskView(account, [domain('alice.test'), domain('plain.test')], [cert], [
      user('zed@alice.test', { email: false, ftp: false, webdisk: true }, { webdiskReadOnly: true, ftpDir: 'public_html/docs' }),
      user('mail@alice.test', { email: true, ftp: false, webdisk: false }),
    ])
    expect(view.addresses).toEqual([{ domain: 'alice.test', url: 'https://alice.test:2078/' }])
    expect(view.unsecuredDomains).toEqual(['plain.test'])
    expect(view.logins).toEqual([
      { kind: 'main', id: null, login: 'alice', directory: '', access: 'read-write', otherServices: [] },
      { kind: 'user', id: expect.any(String), login: 'zed@alice.test', directory: 'public_html/docs', access: 'read-only', otherServices: [] },
    ])
    expect(view.authentication).toBe('basic-over-tls')
  })

  it('names the other services of a login, so removing Web Disk never deletes its mailbox', () => {
    const view = readWebDiskView(account, [domain('alice.test')], [cert], [user('both@alice.test', { email: true, ftp: true, webdisk: true })])
    expect(view.logins[1]?.otherServices).toEqual(['email', 'ftp'])
  })
})

describe('calendars and contacts connection', { tags: ['unit'] }, () => {
  it('gives each mailbox its own domain when served, and the account login the first served one', () => {
    const view = readDavConfigView(account, [domain('alice.test'), domain('other.test')], [cert], [user('Info@alice.test', { email: true, ftp: false, webdisk: false }), user('x@other.test', { email: true, ftp: false, webdisk: false })])
    expect(view.principals[0]).toEqual({ kind: 'main', login: 'alice', server: 'https://alice.test:2080/', principal: 'https://alice.test:2080/main/', calendar: 'https://alice.test:2080/main/calendar/', addressBook: 'https://alice.test:2080/main/addressbook/', profile: DAV_PROFILE_PATH + '?principal=main' })
    expect(view.principals[1]).toMatchObject({ kind: 'mailbox', login: 'info@alice.test', principal: `https://alice.test:2080/${user('Info@alice.test', { email: true, ftp: false, webdisk: false }).id}/` })
    // other.test has no certificate, so its mailbox connects through a served name of the same account
    expect(view.principals[2]).toMatchObject({ login: 'x@other.test', server: 'https://alice.test:2080/' })
  })

  it('reports no address at all when no name of the account has a certificate', () => {
    expect(davPrincipal('mailbox', 'info@alice.test', 'main', [])).toEqual({ kind: 'mailbox', login: 'info@alice.test', server: null, principal: null, calendar: null, addressBook: null, profile: null })
  })
})

describe('device profile of an account login', { tags: ['unit'] }, () => {
  const mailbox = user('info@alice.test', { email: true, ftp: false, webdisk: false })
  const store = (certs: Certificate[]) => ({ getAccount: async () => ({ ...account, status: 'active', planId: 'plan' }), getPlan: async () => ({ id: 'plan', featureListId: 'list' }) as Plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: [] }),
    listDomains: async () => [domain('alice.test')], listCertificates: async () => certs, listServiceUsers: async () => [mailbox] })
  const ask = (query: string, certs = [cert], method = 'GET') => {
    const url = new URL('https://panel.example.test' + DAV_PROFILE_PATH + query)
    return handleDavWorkspaceRoute(new Request(url, { method }), url, method, { store: store(certs) as never, requireCaller: async () => ({ principal: { kind: 'user', id: 'p', username: 'alice', accountId: ACCOUNT_ID }, scopes: [] }) as never })
  }

  it('serves only the links the view gave out, for the login each one names', async () => {
    expect(await (await ask('?principal=main'))!.text()).toContain('<key>CalDAVUsername</key>\n\t\t\t<string>alice</string>')
    expect(await (await ask('?principal=' + mailbox.id))!.text()).toContain('<key>CardDAVUsername</key>\n\t\t\t<string>info@alice.test</string>')
    for (const query of ['', '?principal=other', '?principal=main&x=1']) await expect(ask(query)).rejects.toMatchObject({ code: 'NOT_FOUND', detail: { reason: 'dav_not_served' } })
    expect((await ask('?principal=main', [cert], 'POST'))?.status).toBe(405)
  })

  it('refuses while no name of the account is served', async () => {
    await expect(ask('?principal=main', [])).rejects.toMatchObject({ code: 'NOT_FOUND', detail: { reason: 'dav_not_served' } })
  })
})

describe('mailbox connection in xMail', { tags: ['unit'] }, () => {
  const ports = { open: async () => ({ mailbox: 'Info@alice.test', accountId: ACCOUNT_ID, serviceUserId: '33333333-3333-4333-8333-333333333333' }), store: { getAccount: async () => account, listDomains: async () => [domain('alice.test')], listCertificates: async () => [cert] } } as never
  const ask = (path: string, method = 'GET') => { const url = new URL('https://mail.example.test' + path); return handleWebmailDavConfigRoute(new Request(url, { method }), url, method, ports) }

  it('answers only for the sealed mailbox and takes no selector', async () => {
    const response = await ask(WEBMAIL_DAV_CONFIG_PATH)
    expect(await response?.json()).toMatchObject({ mailbox: 'Info@alice.test', login: 'info@alice.test', principal: 'https://alice.test:2080/33333333-3333-4333-8333-333333333333/', authentication: 'basic-over-tls' })
    expect((await ask(WEBMAIL_DAV_CONFIG_PATH, 'POST'))?.status).toBe(405)
    await expect(ask(WEBMAIL_DAV_CONFIG_PATH + '?mailbox=other@alice.test')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await ask('/api/webmail/other')).toBeNull()
  })

  it('downloads a calendar and contacts profile of that mailbox, without any password', async () => {
    const view = await (await ask(WEBMAIL_DAV_CONFIG_PATH))!.json() as { profile: string }
    expect(view.profile).toBe(WEBMAIL_DAV_PROFILE_PATH)
    const response = (await ask(WEBMAIL_DAV_PROFILE_PATH))!, text = await response.text()
    expect(response.headers.get('content-type')).toBe('application/x-apple-aspen-config')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="calendars-contacts.mobileconfig"')
    expect(text).toContain('<string>com.apple.caldav.account</string>')
    expect(text).toContain('<string>com.apple.carddav.account</string>')
    expect(text).toContain('<key>CalDAVPrincipalURL</key>\n\t\t\t<string>https://alice.test:2080/33333333-3333-4333-8333-333333333333/</string>')
    expect(text).toContain('<key>CardDAVHostName</key>\n\t\t\t<string>alice.test</string>')
    expect(text).toContain('<key>CardDAVPort</key>\n\t\t\t<integer>2080</integer>')
    expect(text).toContain('<key>CalDAVUsername</key>\n\t\t\t<string>info@alice.test</string>')
    expect(text).not.toMatch(/Password/)
    await expect(ask(WEBMAIL_DAV_PROFILE_PATH + '?mailbox=other@alice.test')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
