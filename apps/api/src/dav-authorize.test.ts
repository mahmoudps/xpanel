import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, ServiceUser } from '@xpanel/core'
import { system } from '@xpanel/render'
import { createDavAuthorizer, parseBasicCredentials } from './dav-authorize.ts'
import type { DavAuthorizeDeps } from './dav-authorize.ts'

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'
const account = { id: ACCOUNT_ID, username: 'alice', uid: 20014, status: 'active' } as Account
const disk: ServiceUser = { id: '22222222-2222-4222-8222-222222222222', accountId: ACCOUNT_ID, login: 'docs@alice.test', services: { email: false, ftp: false, webdisk: true }, mailboxQuotaMb: 100, ftpDir: 'public_html/docs', webdiskReadOnly: true }
const box: ServiceUser = { id: '33333333-3333-4333-8333-333333333333', accountId: ACCOUNT_ID, login: 'Info@alice.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: '' }
const foreign: ServiceUser = { ...box, id: '44444444-4444-4444-8444-444444444444', accountId: '55555555-5555-4555-8555-555555555555', login: 'x@bob.test' }
const HASHES: Record<string, string> = { main: 'h-main', [disk.id]: 'h-disk', [box.id]: 'h-box', [foreign.id]: 'h-foreign' }
const PASSWORDS: Record<string, string> = { 'h-main': 'owner-secret', 'h-disk': 'disk-secret', 'h-box': 'box-secret', 'h-foreign': 'foreign-secret' }

const setup = (over: Partial<DavAuthorizeDeps> = {}) => {
  const users = [disk, box, foreign]
  const deps: DavAuthorizeDeps = {
    getAccountByUsername: async username => username === 'alice' ? account : null,
    getServiceUserByLogin: async login => users.find(u => u.login.toLowerCase() === login) ?? null,
    getServiceUserHash: async id => `{ARGON2ID}${HASHES[id]}`,
    findPrincipal: async username => username === 'alice' ? { kind: 'user', accountId: ACCOUNT_ID, disabled: false, passwordHash: HASHES.main! } : null,
    assertFeature: async () => undefined,
    isLockedOut: async () => false,
    recordFailure: vi.fn(async () => undefined),
    verify: vi.fn(async (password: string, hash: string) => PASSWORDS[hash] === password),
    ...over,
  }
  const authorize = createDavAuthorizer(deps)
  const ask = (service: string, login: string | null, password = '', accountName = 'alice') => authorize(new Request('http://panel.test/api/dav/authorize', {
    headers: { 'x-xpanel-dav-service': service, 'x-xpanel-dav-account': accountName, ...(login === null ? {} : { authorization: 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64') }) },
  }), '198.51.100.7')
  return { ask, verify: deps.verify as ReturnType<typeof vi.fn>, recordFailure: deps.recordFailure as ReturnType<typeof vi.fn> }
}

describe('parseBasicCredentials', { tags: ['unit'] }, () => {
  it('reads RFC 7617 credentials and refuses malformed or oversized logins', () => {
    expect(parseBasicCredentials('Basic ' + Buffer.from('Alice:pa:ss').toString('base64'))).toEqual({ login: 'alice', password: 'pa:ss' })
    for (const header of [null, '', 'Bearer abc', 'Basic !!!', 'Basic ' + Buffer.from('nocolon').toString('base64'), 'Basic ' + Buffer.from(':pw').toString('base64'), 'Basic ' + Buffer.from(`${'a'.repeat(129)}:pw`).toString('base64'), 'Basic ' + Buffer.from('a\nb:pw').toString('base64')]) {
      expect(parseBasicCredentials(header)).toBeNull()
    }
  })
})

describe('DAV edge verification', { tags: ['unit'] }, () => {
  it('challenges without credentials and refuses a request the ingress did not shape', async () => {
    const { ask } = setup()
    const missing = await ask('webdisk', null)
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toBe('Basic realm="Web Disk", charset="UTF-8"')
    expect((await ask('caldav', null)).headers.get('www-authenticate')).toBe('Basic realm="Calendars and Contacts", charset="UTF-8"')
    expect((await ask('ftp', 'alice', 'owner-secret')).status).toBe(400)
    expect((await ask('webdisk', 'alice', 'owner-secret', 'Alice; x')).status).toBe(400)
  })

  it('admits the account owner with the account password to the whole home and to its own calendars', async () => {
    const { ask } = setup()
    const disk = await ask('webdisk', 'alice', 'owner-secret')
    expect(disk.status).toBe(204)
    expect(disk.headers.get('x-xpanel-dav-instance')).toBe(system.webDiskInstance({ subject: 'main', dir: '', readOnly: false }))
    const cal = await ask('caldav', 'ALICE', 'owner-secret')
    expect([cal.status, cal.headers.get('x-xpanel-dav-user')]).toEqual([204, 'main'])
  })

  it('admits a Web Disk user to its own directory and right, and a mailbox to its own principal', async () => {
    const { ask } = setup()
    const docs = await ask('webdisk', 'docs@alice.test', 'disk-secret')
    expect(docs.headers.get('x-xpanel-dav-instance')).toBe(system.webDiskInstance({ subject: disk.id, dir: 'public_html/docs', readOnly: true }))
    const mail = await ask('caldav', 'info@alice.test', 'box-secret')
    expect([mail.status, mail.headers.get('x-xpanel-dav-user')]).toEqual([204, box.id])
  })

  it('refuses a wrong password, another account, a missing service right and counts each failure', async () => {
    const { ask, recordFailure, verify } = setup()
    for (const [service, login, password] of [['webdisk', 'alice', 'wrong'], ['webdisk', 'x@bob.test', 'foreign-secret'], ['webdisk', 'info@alice.test', 'box-secret'], ['caldav', 'docs@alice.test', 'disk-secret'], ['webdisk', 'nobody@alice.test', 'x']] as const) {
      const response = await ask(service, login, password)
      expect([login, response.status]).toEqual([login, 401])
    }
    expect(recordFailure).toHaveBeenCalledTimes(5)
    // an unknown or unusable login still costs one derivation against the dummy hash
    expect(verify).toHaveBeenCalledTimes(5)
  })

  it('stops at the shared lockout before any derivation and when this failure engages it', async () => {
    const locked = setup({ isLockedOut: async () => true })
    expect((await locked.ask('webdisk', 'alice', 'owner-secret')).status).toBe(403)
    expect(locked.verify).not.toHaveBeenCalled()
    const engaging = setup({ recordFailure: async () => fail('FORBIDDEN', 'too many failed authentication attempts') })
    expect((await engaging.ask('webdisk', 'alice', 'wrong')).status).toBe(403)
  })

  it('refuses a suspended account or a disabled feature only after the password matched', async () => {
    const suspended = setup({ getAccountByUsername: async () => ({ ...account, status: 'suspended' }) })
    expect((await suspended.ask('webdisk', 'alice', 'owner-secret')).status).toBe(403)
    expect((await suspended.ask('webdisk', 'alice', 'wrong')).status).toBe(401)
    const off = setup({ assertFeature: async () => fail('FORBIDDEN', 'this feature is disabled by the account plan') })
    expect((await off.ask('caldav', 'info@alice.test', 'box-secret')).status).toBe(403)
  })

  it('caches a verification for five minutes and drops it when the stored hash changes', async () => {
    let now = 1_000_000, hash = 'h-box'
    const { ask, verify } = setup({ now: () => now, getServiceUserHash: async () => `{ARGON2ID}${hash}`, verify: vi.fn(async (password: string, value: string) => (value === 'h-box' && password === 'box-secret') || (value === 'h-new' && password === 'box-secret')) })
    for (let i = 0; i < 3; i++) expect((await ask('caldav', 'info@alice.test', 'box-secret')).status).toBe(204)
    expect(verify).toHaveBeenCalledTimes(1)
    hash = 'h-new'
    expect((await ask('caldav', 'info@alice.test', 'box-secret')).status).toBe(204)
    expect(verify).toHaveBeenCalledTimes(2)
    now += 5 * 60_000 + 1
    expect((await ask('caldav', 'info@alice.test', 'box-secret')).status).toBe(204)
    expect(verify).toHaveBeenCalledTimes(3)
    expect((await ask('caldav', 'info@alice.test', 'other')).status).toBe(401)
  })
})
