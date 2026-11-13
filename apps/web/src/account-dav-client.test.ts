// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account, Domain } from '@xpanel/core'
import { ACCOUNT_DAV_CLIENT_BINDING, davOutcomeUncertain, readDavClientView, readMailDavClientView, readWebDiskClientView } from './account-dav-client.ts'
import { renderAccountWebDiskWorkspace, renderDavConnectionWorkspace } from './board-port/account-dav-workspace.ts'
import { renderApprovedXpanelWorkspace } from './board-port/approved-xpanel-workspaces.ts'
import { renderV2WebDiskPage } from './themes/v2/pages/xpanel/files/web-disk.ts'

const accountId = '10000000-0000-4000-8000-000000000001', userId = '20000000-0000-4000-8000-000000000001'
const account = { id: accountId, username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.test', status: 'active' } as Account
const domain = { id: 'd', accountId, name: 'alice.test' } as Domain
const main = { kind: 'main', id: null, login: 'alice', directory: '', access: 'read-write', otherServices: [] }
const disk = { kind: 'user', id: userId, login: 'zed@alice.test', directory: 'public_html/docs', access: 'read-only', otherServices: [] }
const webDisk = (...users: unknown[]) => ({ context: { accountId, username: 'alice' }, port: 2078, addresses: [{ domain: 'alice.test', url: 'https://alice.test:2078/' }], unsecuredDomains: ['plain.test'], logins: [main, ...users], authentication: 'basic-over-tls' })
const principal = { kind: 'mailbox', login: 'info@alice.test', server: 'https://alice.test:2080/', principal: 'https://alice.test:2080/info%40alice.test/', calendar: 'https://alice.test:2080/info%40alice.test/calendar/', addressBook: 'https://alice.test:2080/info%40alice.test/addressbook/', profile: '/api/account/calendars-contacts/connection/apple.mobileconfig?principal=main' }
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const install = async (html: string, request: (method: string, path: string, body?: unknown) => Promise<unknown>, confirm: unknown = async () => true) => {
  document.body.innerHTML = html
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  ;(new Function('return ' + ACCOUNT_DAV_CLIENT_BINDING)() as (ask: unknown) => void)(confirm)
  await tick()
}
const fill = (selector: string, value: string) => {
  const control = $<HTMLInputElement>(selector)
  control.value = value
  control.dispatchEvent(new Event('input', { bubbles: true }))
}
const classic = (canManage = true) => renderAccountWebDiskWorkspace({ lang: 'en', accountId, home: '/home/alice', canManage })
const v2 = () => renderV2WebDiskPage({ account, domains: [domain], locale: 'en', activeRoute: '/files/web-disk' }, { canRead: true, canManage: true })
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); vi.restoreAllMocks() })


describe('Web Disk and device connection readers', { tags: ['unit'] }, () => {
  it('binds every view to the document account or mailbox', () => {
    expect(readWebDiskClientView(webDisk(disk), accountId).logins).toHaveLength(2)
    expect(() => readWebDiskClientView(webDisk(), '10000000-0000-4000-8000-000000000002')).toThrow()
    expect(() => readWebDiskClientView({ ...webDisk(), logins: [disk] }, accountId)).toThrow()
    expect(() => readWebDiskClientView(webDisk({ ...disk, otherServices: ['root'] }), accountId)).toThrow()
    expect(() => readWebDiskClientView({ ...webDisk(), addresses: [{ domain: 'alice.test', url: 'http://alice.test/' }] }, accountId)).toThrow()
    expect(readDavClientView({ context: { accountId }, unsecuredDomains: [], principals: [principal] }, accountId).principals[0]?.calendar).toBe(principal.calendar)
    expect(() => readDavClientView({ context: { accountId }, unsecuredDomains: [], principals: [{ ...principal, calendar: null }] }, accountId)).toThrow()
    expect(() => readDavClientView({ context: { accountId }, unsecuredDomains: [], principals: [{ ...principal, profile: 'https://evil.test/x.mobileconfig' }] }, accountId)).toThrow()
    expect(() => readDavClientView({ context: { accountId }, unsecuredDomains: [], principals: [{ ...principal, profile: null }] }, accountId)).toThrow()
    expect(readMailDavClientView({ mailbox: 'Info@alice.test', ...principal }, 'info@alice.test').principals).toHaveLength(1)
    expect(() => readMailDavClientView({ mailbox: 'other@alice.test', ...principal, login: 'other@alice.test' }, 'info@alice.test')).toThrow()
  })

  it('treats only an explicit no-change refusal as certain', () => {
    expect(davOutcomeUncertain({ status: 409, details: { stateChanged: false } })).toBe(false)
    expect(davOutcomeUncertain({ status: 403 })).toBe(false)
    expect(davOutcomeUncertain({ status: 500 })).toBe(true)
    expect(davOutcomeUncertain({ status: 400, details: { unknownOutcome: true } })).toBe(true)
    expect(davOutcomeUncertain(new Error('network'))).toBe(true)
  })
})

describe('Web Disk controller', { tags: ['feature'] }, () => {
  it.each([['classic', classic], ['v2', v2]])('adds a login and reads it back in the %s theme', async (_theme, html) => {
    let saved = false
    const request = vi.fn(async (method: string, path: string, _body?: unknown) => {
      if (method === 'POST' && path === '/api/service-users') { saved = true; return { serviceUser: {} } }
      return webDisk(...(saved ? [disk] : []))
    })
    await install(html(), request)
    expect($('[data-web-disk-status]').textContent).toBe('Web Disk logins read from the account.')
    expect($('[data-web-disk-rows]').textContent).toContain('Uses the account password')
    expect($('[data-web-disk-addresses]').textContent).toContain('https://alice.test:2078/')
    expect($<HTMLElement>('[data-web-disk-unsecured]').hidden).toBe(false)
    expect([...$<HTMLSelectElement>('[data-web-disk-domain]').options].map(option => option.value)).toEqual(['alice.test', 'plain.test'])
    expect($<HTMLButtonElement>('[data-web-disk-save]').disabled).toBe(true)
    fill('[data-web-disk-local]', 'Zed')
    fill('[data-web-disk-password]', 'long enough')
    fill('[data-web-disk-directory]', 'public_html/docs')
    $<HTMLInputElement>('[data-web-disk-read-only]').checked = true
    $<HTMLButtonElement>('[data-web-disk-save]').click()
    await tick()
    expect(request).toHaveBeenCalledWith('POST', '/api/service-users', { login: 'zed@alice.test', password: 'long enough', services: { email: false, ftp: false, webdisk: true }, mailboxQuotaMb: 1, ftpDir: 'public_html/docs', webdiskReadOnly: true })
    expect($('[data-web-disk-status]').textContent).toBe('The login was saved and read back.')
    expect($('[data-web-disk-rows]').textContent).toContain('zed@alice.test')
    expect($('[data-web-disk-rows]').textContent).toContain('Read only')
    expect($<HTMLInputElement>('[data-web-disk-password]').value).toBe('')
  })

  it('reports a read-back that disagrees instead of a saved login', async () => {
    const request = vi.fn(async (method: string) => method === 'POST' ? { serviceUser: {} } : webDisk())
    await install(classic(), request)
    fill('[data-web-disk-local]', 'zed')
    fill('[data-web-disk-password]', 'long enough')
    $<HTMLButtonElement>('[data-web-disk-save]').click()
    await tick()
    expect($<HTMLElement>('[data-web-disk-status]').dataset).toMatchObject({ state: 'uncertain' })
    expect($<HTMLButtonElement>('[data-web-disk-save]').disabled).toBe(true)
  })

  it('explains an address that is already taken', async () => {
    const request = vi.fn(async (method: string) => { if (method === 'POST') throw { status: 409, details: { stateChanged: false } }; return webDisk() })
    await install(classic(), request)
    fill('[data-web-disk-local]', 'zed')
    fill('[data-web-disk-password]', 'long enough')
    $<HTMLButtonElement>('[data-web-disk-save]').click()
    await tick()
    expect($('[data-web-disk-status]').textContent).toBe('A login with this address already exists. Manage it under Service users.')
  })

  it('changes the access of a login without sending an empty password', async () => {
    let access = 'read-only'
    const request = vi.fn(async (method: string, _path: string, body?: unknown) => {
      if (method === 'PATCH') access = (body as { webdiskReadOnly: boolean }).webdiskReadOnly ? 'read-only' : 'read-write'
      return webDisk({ ...disk, access })
    })
    await install(classic(), request)
    $<HTMLButtonElement>('[data-web-disk-rows] button').click()
    await tick()
    expect($('[data-web-disk-form-title]').textContent).toBe('Change zed@alice.test')
    expect($<HTMLInputElement>('[data-web-disk-local]').disabled).toBe(true)
    $<HTMLInputElement>('[data-web-disk-read-only]').checked = false
    $<HTMLButtonElement>('[data-web-disk-save]').click()
    await tick()
    expect(request).toHaveBeenCalledWith('PATCH', `/api/service-users/${userId}`, { ftpDir: 'public_html/docs', webdiskReadOnly: false })
    expect($('[data-web-disk-rows]').textContent).toContain('Read and write')
  })

  it('removes Web Disk only from a login that keeps a mailbox, and deletes a Web Disk only login', async () => {
    const both = { ...disk, login: 'both@alice.test', otherServices: ['email'] }
    let present = true
    const request = vi.fn(async (method: string, _path: string, _body?: unknown) => { if (method !== 'GET') present = false; return webDisk(...(present ? [both] : [])) })
    await install(classic(), request)
    $<HTMLButtonElement>('[data-web-disk-rows] button[aria-label^="Remove"]').click()
    await tick()
    expect(request).toHaveBeenCalledWith('PATCH', `/api/service-users/${userId}`, { services: { email: true, ftp: false, webdisk: false } })
    expect(request).not.toHaveBeenCalledWith('DELETE', expect.anything())

    present = true
    const onlyDisk = vi.fn(async (method: string, _path: string) => { if (method !== 'GET') present = false; return webDisk(...(present ? [disk] : [])) })
    await install(classic(), onlyDisk)
    $<HTMLButtonElement>('[data-web-disk-rows] button[aria-label^="Remove"]').click()
    await tick()
    expect(onlyDisk).toHaveBeenCalledWith('DELETE', `/api/service-users/${userId}`)
    expect($('[data-web-disk-status]').textContent).toBe('Web Disk was removed from this login and read back.')
  })

  it('sends nothing without a confirmation or without the right to manage', async () => {
    const request = vi.fn(async () => webDisk(disk))
    await install(classic(), request, async () => false)
    $<HTMLButtonElement>('[data-web-disk-rows] button[aria-label^="Remove"]').click()
    await tick()
    expect(request).toHaveBeenCalledTimes(1)
    const refused = vi.fn(async () => webDisk())
    await install(classic(false), refused)
    expect(refused).not.toHaveBeenCalled()
    expect($('[data-web-disk-status]').textContent).toBe('Web Disk is unavailable here. Nothing was read or changed.')
  })
})

describe('classic Web Disk route', { tags: ['feature'] }, () => {
  const page = (status: string) => renderApprovedXpanelWorkspace({ route: '/files/web-disk', locale: 'en', readOnly: false, account, domains: [domain], catalog: [{ id: 'web-disk', status }],
    visibility: { principal: { kind: 'user', id: accountId, username: 'alice', accountId }, disabledFeatures: new Set() } } as never)

  it('opens for the owner only once the tool is verified', () => {
    expect(page('verified')).toContain('data-web-disk-manage="true"')
    expect(page('verified')).toContain('data-web-disk-home="/home/alice"')
    expect(page('researched')).toContain('data-wiring="soon"')
    expect(page('researched')).toContain('data-web-disk-manage="false"')
  })
})

describe('device connection controller', { tags: ['feature'] }, () => {
  it('shows every login of the account and names domains that are not served', async () => {
    const request = vi.fn(async () => ({ context: { accountId }, unsecuredDomains: ['plain.test'], principals: [principal] }))
    await install(renderDavConnectionWorkspace({ locale: 'en', accountId, canRead: true }), request)
    expect(request).toHaveBeenCalledWith('GET', '/api/account/calendars-contacts/connection')
    expect($('[data-dav-rows]').textContent).toContain('https://alice.test:2080/info%40alice.test/addressbook/')
    expect($('[data-dav-unsecured]').textContent).toContain('plain.test')
    expect($<HTMLAnchorElement>('[data-dav-rows] a[download]').getAttribute('href')).toBe(principal.profile)
  })

  it('reads only the signed-in mailbox in xMail and says when no address exists', async () => {
    const request = vi.fn(async () => ({ mailbox: 'info@alice.test', ...principal, server: null, principal: null, calendar: null, addressBook: null, profile: null }))
    await install(renderDavConnectionWorkspace({ locale: 'en', mailbox: 'info@alice.test', canRead: true }), request)
    expect(request).toHaveBeenCalledWith('GET', '/api/webmail/dav-config')
    expect($('[data-dav-rows]').textContent).toContain('Not available')
    expect($('[data-dav-unsecured]').textContent).toContain('devices cannot connect yet')
    expect($('[data-dav-rows] a[download]')).toBeNull()
  })

  it('reads nothing on a server where the tool is not qualified', async () => {
    const request = vi.fn()
    await install(renderDavConnectionWorkspace({ locale: 'en', accountId, canRead: false }), request)
    expect(request).not.toHaveBeenCalled()
    expect($('[data-dav-status]').textContent).toBe('Device sync is not available on this server yet. Nothing was read.')
  })

  it('renders without inline HTML writes', () => {
    expect(ACCOUNT_DAV_CLIENT_BINDING).not.toContain('innerHTML')
  })
})
