import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAgentApp, FakeHostExecutor, HostReconciler, IoAnalyticsEngine, WebsiteAnalyticsEngine } from '@xpanel/agent'
import type { PhpSettings } from '@xpanel/core'
import { createRootPrincipal, createTestDb, createUserPrincipal } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { services } from '@xpanel/render'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { CSRF_HEADER_NAME, hashPasswordArgon2id, HOST_SESSION_COOKIE_NAME, parseCookies, SESSION_COOKIE_NAME } from './auth.ts'
import { createApiApp } from './server.ts'
import type { ApiApp } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

// Feature layer: the mounted API and agent with a fake host executor. One fixture per file; tests run in order.
const OS_RELEASE = ['ID=ubuntu', 'VERSION_ID="24.04"', 'VERSION_CODENAME=noble', 'NAME="Ubuntu"'].join('\n')
const OS = profileFor(OS_RELEASE)
const php: PhpSettings = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts), length: number[] = []
  if (body.length > 127) for (let value = body.length; value; value >>>= 8) length.unshift(value & 255)
  return Buffer.concat([Buffer.from([tag]), Buffer.from(length.length ? [128 | length.length, ...length] : [body.length]), body])
}
const seq = (...parts: Buffer[]) => der(0x30, ...parts)
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'))
/** Runtime-generated self-signed EC P-256 leaf; a portable fixture, not a real authority. */
const selfSigned = (names: string[]) => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), alg = seq(oid('2a8648ce3d040302'))
  const name = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from('Portable upload fixture')))))
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([7])), alg, name,
    seq(der(0x17, Buffer.from('250101000000Z')), der(0x17, Buffer.from('280101000000Z'))), name,
    pair.publicKey.export({ format: 'der', type: 'spki' }), der(0xa3, seq(seq(oid('551d11'), der(0x04, seq(...names.map(host => der(0x82, Buffer.from(host)))))))))
  const bytes = seq(tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, pair.privateKey)])))
  return { fullchainPem: '-----BEGIN CERTIFICATE-----\n' + bytes.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END CERTIFICATE-----\n',
    privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }
}
type Call = (method: string, path: string, payload?: unknown) => Promise<Response>

describe('account certificate lifecycle: upload, list and remove', () => {
  let tmpDir: string, db: TestDbHandle, state: TestStateStoreHandle, executor: FakeHostExecutor, app: ApiApp
  let alice: Call, bobby: Call, installedId = ''
  const upload = selfSigned(['alice.example.test'])

  beforeAll(async () => {
    const passwordHash = await hashPasswordArgon2id('CertificatePassword!2026')
    tmpDir = await mkdtemp(join(tmpdir(), 'xpanel-cert-life-'))
    db = await createTestDb(); state = await createTestStateStore(); executor = new FakeHostExecutor()
    await executor.writeFile({ path: '/etc/os-release', content: OS_RELEASE, mode: 0o644, owner: 'root', group: 'root' })
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os: OS, quotaFilesystem: '/home', ioDevices: ['/dev/nvme0n1'] })
    const agentApp = createAgentApp({ agentToken: TEST_AGENT_TOKEN, reconciler, store: state.store, db: db.db, executor, ioAnalytics: new IoAnalyticsEngine(),
      websiteAnalytics: new WebsiteAnalyticsEngine(), os: { id: OS.id, versionId: OS.versionId, family: OS.family }, homeBaseDir: join(tmpDir, 'host') })
    await createRootPrincipal(db.db, { username: 'root', passwordHash, forcePasswordChange: false })
    const features = await state.store.createFeatureList({ name: 'Cert features', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({ name: 'Cert plan', ownerId: null, featureListId: features.id,
      resources: { diskMb: 5000, bandwidthMbMonth: 50000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
      caps: { addonDomains: 10, aliasDomains: 10, subdomains: 10, mailboxes: 10, forwarders: 10, mailingLists: 10, ftpAccounts: 10, databases: 10, phpWorkers: 8 },
      dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 250 })
    await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    for (const username of ['alice', 'bobby']) {
      const account = await state.store.createAccount({ username, passwordHash, primaryDomain: username + '.example.test', planId: plan.id, ownerId: null,
        contactEmail: 'owner@' + username + '.example.test', ipv4: '192.0.2.10', shell: 'jailed', php })
      await createUserPrincipal(db.db, { username, accountId: account.id, passwordHash })
    }
    app = createApiApp({ agentToken: TEST_AGENT_TOKEN, serverSecret: TEST_SERVER_SECRET, db: db.db, store: state.store, agentApp, os: OS })
    const session = async (username: string): Promise<Call> => {
      const login = await app.fetch(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'CertificatePassword!2026' }) }), { remoteAddress: '192.0.2.5' })
      expect(login.status).toBe(200)
      const csrf = (await login.json() as { csrfToken?: string }).csrfToken ?? ''
      const cookies = parseCookies(login.headers.get('set-cookie')?.split(',').map(part => part.split(';')[0]?.trim()).filter(Boolean).join('; ') ?? null)
      const name = cookies[HOST_SESSION_COOKIE_NAME] ? HOST_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME
      return (method, path, payload) => app.fetch(new Request('http://localhost' + path, { method,
        headers: { cookie: name + '=' + cookies[name], [CSRF_HEADER_NAME]: csrf, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), { remoteAddress: '192.0.2.5' })
    }
    alice = await session('alice'); bobby = await session('bobby')
  })
  afterAll(async () => { await state?.close(); await db?.close(); if (tmpDir) await rm(tmpDir, { recursive: true, force: true }) })

  const revision = async (call: Call, username: string): Promise<number> => (await (await call('GET', '/api/accounts/' + username + '/certificates')).json() as { revision: number }).revision

  it('lists only the caller account and states that automatic renewal is not scheduled', async () => {
    const response = await alice('GET', '/api/accounts/alice/certificates')
    expect(response.status).toBe(200)
    const body = await response.json() as { accounts: { username: string }[]; domains: { name: string }[]; capabilities: Record<string, boolean>; renewalScheduler: { state: string } }
    expect(body.accounts.map(account => account.username)).toEqual(['alice'])
    expect(body.domains.map(domain => domain.name)).toEqual(['alice.example.test'])
    expect(body.capabilities).toMatchObject({ install: true, remove: true })
    expect(body.renewalScheduler.state).toBe('unavailable')
  })

  it('refuses another tenant for read, upload and selector smuggling without host writes', async () => {
    const before = executor.files.size
    expect((await bobby('GET', '/api/accounts/alice/certificates')).status).toBe(404)
    const rev = await revision(alice, 'alice')
    expect((await bobby('POST', '/api/accounts/alice/certificates/install', { domain: 'alice.example.test', expectedRevision: rev, ...upload })).status).toBe(404)
    expect((await alice('POST', '/api/accounts/alice/certificates/install', { username: 'bobby', domain: 'alice.example.test', expectedRevision: rev, ...upload })).status).toBe(422)
    expect((await alice('POST', '/api/accounts/alice/certificates/install', { domain: 'bob.example.test', expectedRevision: rev, ...selfSigned(['bob.example.test']) })).status).toBe(404)
    expect((await alice('GET', '/api/accounts/alice/certificates?accountId=x')).status).toBe(422)
    expect(executor.files.size).toBe(before)
  })

  it('refuses a key that does not match the certificate and a stale revision before any host write', async () => {
    const before = executor.files.size, rev = await revision(alice, 'alice')
    const mismatch = await alice('POST', '/api/accounts/alice/certificates/install', { domain: 'alice.example.test', expectedRevision: rev,
      fullchainPem: upload.fullchainPem, privateKeyPem: selfSigned(['alice.example.test']).privateKeyPem })
    expect(mismatch.status).toBe(422)
    const problem = await mismatch.text()
    expect(problem).toContain('key_mismatch')
    expect(problem).not.toContain('PRIVATE KEY')
    expect((await alice('POST', '/api/accounts/alice/certificates/install', { domain: 'alice.example.test', expectedRevision: rev - 1, ...upload })).status).toBe(409)
    expect(executor.files.size).toBe(before)
  })

  it('installs an owner upload as a manual-renewal certificate bound to the domain, without echoing key material', async () => {
    const response = await alice('POST', '/api/accounts/alice/certificates/install', { domain: 'alice.example.test', expectedRevision: await revision(alice, 'alice'), ...upload })
    const text = await response.text()
    expect(response.status, text).toBe(200)
    expect(text).not.toContain('PRIVATE KEY')
    const body = JSON.parse(text) as { certificate: { id: string; source: string; autoRenew: boolean; assignedDomains: string[]; names: string[] } }
    expect(body.certificate).toMatchObject({ source: 'upload', autoRenew: false, names: ['alice.example.test'], assignedDomains: ['alice.example.test'] })
    installedId = body.certificate.id
    const paths = services.certFiles(installedId)
    expect(executor.files.get(paths.privkey)).toMatchObject({ mode: 0o600, owner: 'root', group: 'root' })
    expect((await state.store.listDomains()).find(domain => domain.name === 'alice.example.test')?.certificateId).toBe(installedId)
  })

  it('refuses removal by another tenant and of a foreign certificate id', async () => {
    expect((await bobby('DELETE', '/api/accounts/alice/certificates/' + installedId, { expectedRevision: await revision(alice, 'alice') })).status).toBe(404)
    expect((await bobby('DELETE', '/api/accounts/bobby/certificates/' + installedId, { expectedRevision: await revision(bobby, 'bobby') })).status).toBe(404)
    expect((await state.store.listCertificates()).map(certificate => certificate.id)).toEqual([installedId])
  })

  it('removes the owner certificate and reverts the domain to its fallback', async () => {
    const response = await alice('DELETE', '/api/accounts/alice/certificates/' + installedId, { expectedRevision: await revision(alice, 'alice') })
    const text = await response.text()
    expect(response.status, text).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ ok: true, removedCertificateId: installedId, application: { revocationPerformed: false } })
    expect(await state.store.listCertificates()).toEqual([])
    expect((await state.store.listDomains()).find(domain => domain.name === 'alice.example.test')?.certificateId).toBeNull()
  })
})
