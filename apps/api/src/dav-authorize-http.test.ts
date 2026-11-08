import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb, createUserPrincipal } from '@xpanel/db'
import { system } from '@xpanel/render'
import { createTestStateStore } from '@xpanel/state'
import { createApiApp } from './server.ts'

// Public independent libargon2 vector of 'correct horse battery staple'; these identities exist only in this test.
const PASSWORD = 'correct horse battery staple'
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'dav-authorize-fixture-secret-32-bytes-minimum'
const INGRESS = 'dav_authorize_ingress_credential_32_bytes_min'
const ORIGIN = 'https://panel.example.test:2083'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const fixture = async () => {
  const database = await createTestDb(), state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const features = await state.store.createFeatureList({ name: 'Standard', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Standard', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 10000000, ioWriteBps: 10000000, ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 5, forwarders: 5, mailingLists: 2, ftpAccounts: 5, databases: 5, phpWorkers: 4 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 512 })
  await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = await state.store.createAccount({ username: 'alice', passwordHash: HASH, primaryDomain: 'alice.example.test', planId: plan.id, ownerId: null, contactEmail: 'alice@example.test', ipv4: '203.0.113.10', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
  await createUserPrincipal(database.db, { username: 'alice', passwordHash: HASH, accountId: account.id })
  const disk = await state.store.createServiceUser({ accountId: account.id, login: 'docs@alice.example.test', services: { email: false, ftp: false, webdisk: true }, mailboxQuotaMb: 100, ftpDir: 'public_html', webdiskReadOnly: true, passwordHash: `{ARGON2ID}${HASH}` })
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, entryPoint: 'xpanel', publicOrigin: ORIGIN, allowedOrigins: [ORIGIN], requireSecureCookies: true, secureCookies: true, ingressSecret: INGRESS })
  const ask = (headers: Record<string, string>) => app.fetch(new Request(`${ORIGIN}/api/dav/authorize`, { headers }), { remoteAddress: '127.0.0.1' })
  const basic = (login: string, password: string) => 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64')
  const edge = { 'x-xpanel-ingress-secret': INGRESS, 'x-forwarded-proto': 'https', 'x-real-ip': '198.51.100.7', 'x-xpanel-dav-service': 'webdisk', 'x-xpanel-dav-account': 'alice' }
  return { ask, basic, edge, disk, state, account }
}

describe('DAV verification on the real xPanel listener', { tags: ['feature'] }, () => {
  it('answers only the authenticated management ingress', async () => {
    const f = await fixture()
    const credentials = { authorization: f.basic('alice', PASSWORD), 'x-xpanel-dav-service': 'webdisk', 'x-xpanel-dav-account': 'alice' }
    expect((await f.ask(credentials)).status).toBe(403)
    expect((await f.ask({ ...credentials, 'x-forwarded-proto': 'https' })).status).toBe(403)
    expect((await f.ask({ ...credentials, 'x-forwarded-proto': 'https', 'x-xpanel-ingress-secret': 'not-the-ingress-credential-of-this-panel' })).status).toBe(401)
  })

  it('admits the account password and a read-only Web Disk user, and challenges a wrong password', async () => {
    const f = await fixture()
    const main = await f.ask({ ...f.edge, authorization: f.basic('alice', PASSWORD) })
    expect(main.status).toBe(204)
    expect(main.headers.get('x-xpanel-dav-instance')).toBe(system.webDiskInstance({ subject: 'main', dir: '', readOnly: false }))
    const docs = await f.ask({ ...f.edge, authorization: f.basic('docs@alice.example.test', PASSWORD) })
    expect(docs.headers.get('x-xpanel-dav-instance')).toBe(system.webDiskInstance({ subject: f.disk.id, dir: 'public_html', readOnly: true }))
    const wrong = await f.ask({ ...f.edge, authorization: f.basic('alice', 'not the password') })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('www-authenticate')).toBe('Basic realm="Web Disk", charset="UTF-8"')
    expect(wrong.headers.get('set-cookie')).toBeNull()
  })

  it('never hands a recreated address the principal of the mailbox it replaces', async () => {
    const f = await fixture()
    const service = { accountId: f.account.id, login: 'info@alice.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: '{ARGON2ID}' + HASH }
    const ask = () => f.ask({ ...f.edge, 'x-xpanel-dav-service': 'caldav', authorization: f.basic('info@alice.example.test', PASSWORD) })
    const first = await f.state.store.createServiceUser(service)
    const before = await ask()
    expect(before.headers.get('x-xpanel-dav-user')).toBe(first.id)
    await f.state.store.deleteServiceUser(first.id)
    expect((await ask()).status).toBe(401)
    const second = await f.state.store.createServiceUser(service)
    const after = await ask()
    expect(after.headers.get('x-xpanel-dav-user')).toBe(second.id)
    expect(second.id).not.toBe(first.id)
  })
})
