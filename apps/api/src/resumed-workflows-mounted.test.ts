import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import * as db from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { createAgentApp } from '../../agent/src/server.ts'
import type { AgentServerDeps } from '../../agent/src/server.ts'
import { FakeHostExecutor } from '../../agent/src/executor.ts'
import { pgpRevision } from '../../agent/src/account-pgp.ts'
import { deriveCsrfToken } from './auth.ts'
import { sessionCookieName, sessionTokenHash } from './entry-points.ts'
import { createApiApp } from './server.ts'
import { createDefaultWebRenderer } from './main.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

// Real SQLite, StateStore, listener admission, sessions, API routing and agent routing.
// Only the confined file reader is synthetic; no native provider is activated here.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
// This boundary exercises route subscriptions only; reconciliation is never dispatched.
const subscriptionOnlyReconciler = (): AgentServerDeps['reconciler'] => {
  const boundary: Pick<AgentServerDeps['reconciler'], 'subscribe'> = { subscribe: () => () => {} }
  return boundary as unknown as AgentServerDeps['reconciler']
}
afterEach(async () => {
  vi.restoreAllMocks()
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Mounted workflow cleanup failed')
})

async function fixture() {
  const database = await db.createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Mounted workflows', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Mounted workflows', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 4, aliasDomains: 4, subdomains: 4, mailboxes: 4, forwarders: 4, mailingLists: 4, ftpAccounts: 4, databases: 4, phpWorkers: 4 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.64', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = await state.store.createAccount({ username: 'mountowner', passwordHash: HASH, primaryDomain: 'mount.example.test', planId: plan.id, ownerId: null,
    contactEmail: 'owner@mount.example.test', ipv4: '192.0.2.64', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const root = await db.createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const owner = await db.createUserPrincipal(database.db, { username: account.username, accountId: account.id, passwordHash: HASH })
  const executor = new FakeHostExecutor(), nativeRun = vi.spyOn(executor, 'runCommand')
  const files = vi.fn(async (_context: unknown, request: { op: string }) => {
    if (request.op === 'read' || request.op === 'get-bytes') return fail('NOT_FOUND', 'Synthetic empty account file')
    if (request.op === 'list') return []
    throw new Error('Unexpected account file effect: ' + request.op)
  })
  const agent = createAgentApp({ db: database.db, store: state.store, executor, os: { id: 'ubuntu', versionId: '24.04', family: 'debian' }, agentToken: TEST_AGENT_TOKEN,
    reconciler: subscriptionOnlyReconciler(), accountFileRunner: { run: files } })
  let hostReply: ((request: Request) => Promise<Response>) | undefined
  const hostCalls: Request[] = []
  const transport = { subscribe: agent.subscribe, fetch: async (request: Request) => { hostCalls.push(request); return hostReply ? hostReply(request) : agent.fetch(request) } }
  async function session(principalId: string, surface: 'xwhm' | 'xpanel', documents = false) {
    const raw = randomUUID() + randomUUID(), origin = surface === 'xwhm' ? 'https://whm.example.test:2087' : 'https://panel.example.test:2083'
    const record = await db.createSession(database.db, { principalId, tokenHash: sessionTokenHash(raw, surface), expiresAt: new Date(Date.now() + 3600000).toISOString(), mfaVerified: true })
    const app = createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET, entryPoint: surface, publicOrigin: origin, allowedOrigins: [origin], secureCookies: true, requireSecureCookies: true,
      ...(documents ? { webRenderer: await createDefaultWebRenderer({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET, entryPoint: surface }) } : {}),
      agentApp: transport, agentToken: TEST_AGENT_TOKEN })
    const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => app.fetch(new Request(origin + path, { method,
      headers: { origin, cookie: sessionCookieName(surface, true) + '=' + raw, 'x-csrf-token': deriveCsrfToken(raw, TEST_SERVER_SECRET, surface), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { tls: true, remoteAddress: '198.51.100.9' })
    return { app, request, record, origin }
  }
  return { database, state, account, root, owner, features, files, nativeRun, hostCalls, session, agent,
    setHostReply: (reply: typeof hostReply) => { hostReply = reply } }
}

describe('resumed workflows through real API and agent mounts', () => {
  it.each([
    ['/api/server/databases/tuning', { state: 'unavailable', capabilities: { apply: false }, plan: { kind: 'advisory', state: 'unavailable' } }],
    ['/api/server/monitoring/benchmark', { history: { state: 'unavailable', results: [] }, jobsAvailable: false, network: 'not_measured' }],
    ['/api/server/monitoring/traffic', { interfaces: { state: 'unavailable', items: [] }, http: { state: 'unavailable' }, history: { state: 'unavailable' } }],
  ])('mounts %s and reports absent providers without native effects', async (path, expected) => {
    const f = await fixture(), s = await f.session(f.root.id, 'xwhm')
    const response = await s.request(path as string)
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject(expected)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(f.hostCalls).toHaveLength(1); expect(f.hostCalls[0]!.method).toBe('GET')
    expect(f.nativeRun).not.toHaveBeenCalled(); expect(f.files).not.toHaveBeenCalled()
  })

  it('mounts service management and preserves the unavailable Linux provider refusal', async () => {
    const f = await fixture(), s = await f.session(f.root.id, 'xwhm'), response = await s.request('/api/server/service-manager')
    expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    expect(f.hostCalls).toHaveLength(1); expect(f.hostCalls[0]!.method).toBe('GET'); expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it.each(['/api/server/service-manager', '/api/server/databases/tuning', '/api/server/monitoring/benchmark', '/api/server/monitoring/traffic'])('rejects query pollution at %s before host dispatch', async path => {
    const f = await fixture(), s = await f.session(f.root.id, 'xwhm')
    expect((await s.request(path + '?accountId=foreign')).status).toBe(422)
    expect(f.hostCalls).toHaveLength(0)
  })

  it.each(['/api/server/service-manager', '/api/server/databases/tuning', '/api/server/monitoring/benchmark', '/api/server/monitoring/traffic', '/api/admin/preferences'])('confines owner sessions away from administrator %s', async path => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel')
    expect((await s.request(path)).status).toBe(404); expect(f.hostCalls).toHaveLength(0)
  })

  it('saves root preferences using its own revision and refuses stale or injected updates', async () => {
    const f = await fixture(), s = await f.session(f.root.id, 'xwhm')
    const initial = await (await s.request('/api/admin/preferences')).json()
    const body = { language: 'ar', theme: 'dark', density: 'compact', expectedRevision: initial.revision }
    expect((await s.request('/api/admin/preferences', 'PUT', { ...body, principalId: f.owner.id })).status).toBe(422)
    const saved = await s.request('/api/admin/preferences', 'PUT', body)
    expect(saved.status).toBe(200); expect(await saved.json()).toMatchObject({ state: 'saved', preferences: { language: 'ar', theme: 'dark', density: 'compact' } })
    expect((await s.request('/api/admin/preferences', 'PUT', body)).status).toBe(409)
    expect(f.hostCalls).toHaveLength(0)
  })

  it('rechecks a revoked session while preferences wait for the real writer lease', async () => {
    const f = await fixture(), s = await f.session(f.root.id, 'xwhm'), first = await (await s.request('/api/admin/preferences')).json()
    const lock = f.state.store.getWriterLock(), acquire = lock.acquire.bind(lock)
    vi.spyOn(lock, 'acquire').mockImplementationOnce(async (...args) => { await db.revokeSession(f.database.db, s.record.id); return acquire(...args) })
    const response = await s.request('/api/admin/preferences', 'PUT', { language: 'ar', theme: 'dark', density: 'compact', expectedRevision: first.revision })
    expect(response.status).toBe(401)
    const fresh = await f.session(f.root.id, 'xwhm')
    expect(await (await fresh.request('/api/admin/preferences')).json()).toMatchObject({ state: 'default' })
  })

  it('hydrates saved appearance and explicit URL overrides through the production document renderer', async () => {
    const f = await fixture(), s = await f.session(f.root.id, 'xwhm', true), initial = await (await s.request('/api/admin/preferences')).json()
    expect((await s.request('/api/admin/preferences', 'PUT', { language: 'ar', theme: 'dark', density: 'compact', expectedRevision: initial.revision })).status).toBe(200)
    const saved = await s.request('/whm/preferences')
    expect(saved.status).toBe(200); expect(await saved.text()).toContain('<html lang="ar" dir="rtl" data-theme="dark" data-density="compact"')
    const explicit = await s.request('/whm/preferences?lang=en&theme=light&density=comfortable')
    expect(explicit.status).toBe(200); expect(await explicit.text()).toContain('<html lang="en" dir="ltr" data-theme="light" data-density="comfortable"')
    expect((await s.request('/whm/preferences?accountId=' + f.account.id)).status).toBe(400)
    expect(f.hostCalls).toHaveLength(0)
  })

  it('permits reseller own preferences with empty ACL while preserving administrative page denial', async () => {
    const f = await fixture(), reseller = await f.state.store.createReseller({ username: 'prefreseller', passwordHash: HASH, acl: [], maxAccounts: 10,
      totalDiskMb: 10000, totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [] })
    const principal = await db.createResellerPrincipal(f.database.db, { id: reseller.id, username: reseller.username, passwordHash: HASH })
    const s = await f.session(principal.id, 'xwhm', true), initial = await s.request('/api/admin/preferences')
    expect(initial.status).toBe(200)
    const view = await initial.json()
    expect((await s.request('/api/admin/preferences', 'PUT', { language: 'ar', theme: 'dark', density: 'compact', expectedRevision: view.revision })).status).toBe(200)
    const page = await s.request('/whm/preferences')
    expect(page.status).toBe(200); expect(await page.text()).toContain('<html lang="ar" dir="rtl" data-theme="dark" data-density="compact"')
    expect((await s.request('/whm/accounts')).status).toBe(403)
    const root = await f.session(f.root.id, 'xwhm')
    expect(await (await root.request('/api/admin/preferences')).json()).toMatchObject({ state: 'default' })
    expect(f.hostCalls).toHaveLength(0)
  })

  it.each(['root', 'reseller'] as const)('rejects generic domain indexFiles injection for %s before forwarding', async role => {
    const f = await fixture()
    let principalId = f.root.id
    if (role === 'reseller') {
      const reseller = await f.state.store.createReseller({ username: 'indexreseller', passwordHash: HASH, acl: ['list-accounts', 'edit-account'], maxAccounts: 10,
        totalDiskMb: 10000, totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [] })
      await f.state.store.changeOwner(f.account.id, reseller.id)
      principalId = (await db.createResellerPrincipal(f.database.db, { id: reseller.id, username: reseller.username, passwordHash: HASH })).id
    }
    const s = await f.session(principalId, 'xwhm'), domain = (await f.state.store.listDomains({ accountId: f.account.id }))[0]!
    const response = await s.request('/api/domains/' + domain.id, 'PATCH', { indexFiles: ['secret.php'] })
    expect(response.status).toBe(422)
    expect(await f.state.store.getDomain(domain.id)).toEqual(domain)
    expect(f.hostCalls).toHaveLength(0); expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it.each(['session', 'password'] as const)('discards host observations when the %s is revoked during transport', async transition => {
    const f = await fixture(), s = await f.session(f.root.id, 'xwhm')
    f.setHostReply(async () => {
      if (transition === 'session') await db.revokeSession(f.database.db, s.record.id)
      else await db.setPasswordHash(f.database.db, f.root.id, HASH.replace('YfwJ', 'ZfwJ'))
      return Response.json({ history: { state: 'unavailable', results: [] }, jobsAvailable: false, limits: { cpuSeconds: 5, diskBytes: 67108864, maxRuntimeSeconds: 60 }, network: 'not_measured' })
    })
    expect((await s.request('/api/server/monitoring/benchmark')).status).toBe(401)
    expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it.each([
    ['/api/server/service-manager/action', { action: 'restart', unit: 'ssh.service', expectedRevision: 'a'.repeat(64) }],
    ['/api/server/monitoring/benchmark/jobs', { confirm: 'RUN' }],
  ])('marks an unexpected native acknowledgement at %s as uncertain', async (path, body) => {
    const f = await fixture(), s = await f.session(f.root.id, 'xwhm')
    f.setHostReply(async () => Response.json({ job: { id: randomUUID(), kind: 'wrong.kind', status: 'succeeded' } }))
    const response = await s.request(path as string, 'POST', body), problem = await response.json()
    expect(response.status).toBe(path === '/api/server/service-manager/action' ? 503 : 412)
    expect(problem.details).toMatchObject({ stateChanged: true, unknownOutcome: true, verificationRequired: true })
    expect(f.hostCalls).toHaveLength(1); expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it.each([
    ['/api/server/service-manager/action', { action: 'restart', unit: 'ssh.service', expectedRevision: 'a'.repeat(64), command: '/bin/sh' }],
    ['/api/server/monitoring/benchmark/jobs', { confirm: 'RUN', seconds: 100 }],
  ])('rejects extra mutation fields at %s before transport', async (path, body) => {
    const f = await fixture(), s = await f.session(f.root.id, 'xwhm')
    expect((await s.request(path as string, 'POST', body)).status).toBe(422); expect(f.hostCalls).toHaveLength(0)
  })

  it('lists Git metadata truthfully and refuses absent Git/OpenPGP native providers', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel')
    const git = await s.request('/api/account/git')
    expect(git.status).toBe(200)
    const initial = await git.json()
    expect(initial).toMatchObject({ context: { accountId: f.account.id, username: f.account.username }, repositories: [], selected: null, nativeAvailable: false })
    expect((await s.request('/api/account/git', 'POST', { op: 'init', path: 'repo', branch: 'main', expectedRevision: initial.revision })).status).toBe(412)
    expect((await s.request('/api/account/pgp')).status).toBe(412)
    expect(f.files.mock.calls.every(([, request]) => ['read', 'list', 'get-bytes'].includes(request.op))).toBe(true)
    expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it('projects a pinned synthetic OpenPGP reply then discards it after session revocation during transport', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel')
    const view = { context: { accountId: f.account.id, username: f.account.username }, revision: pgpRevision(f.account.id, []), keys: [], mailboxes: [],
      application: { status: 'read', fingerprint: null }, capabilities: { generate: false, import: false, export: false, delete: false }, scope: 'account-keyring', messageEncryption: false }
    f.setHostReply(async () => Response.json(view))
    const initial = await s.request('/api/account/pgp')
    expect(initial.status).toBe(200); expect(await initial.json()).toEqual(view)
    f.setHostReply(async () => { await db.revokeSession(f.database.db, s.record.id); return Response.json(view) })
    const response = await s.request('/api/account/pgp')
    expect(response.status).toBe(401); expect(await response.text()).not.toContain('account-keyring')
    expect(f.files).not.toHaveBeenCalled(); expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it.each(['/api/account/git', '/api/account/pgp', '/api/account/dynamic-dns'])('rejects owner query selectors at %s without transport', async path => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel')
    expect((await s.request(path + '?accountId=foreign')).status).toBe(422); expect(f.hostCalls).toHaveLength(0)
  })

  it('discards a Git observation when account lifecycle authority changes during transport', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel')
    f.setHostReply(async request => {
      const initial = await f.agent.fetch(request)
      await f.state.store.suspendAccount(f.account.id, 'Synthetic mounted lifecycle revocation')
      return initial
    })
    const response = await s.request('/api/account/git')
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it('mounts domain-pinned site inspection and preview without account file effects', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel'), domain = (await f.state.store.listDomains({ accountId: f.account.id }))[0]!
    const path = '/api/domains/' + domain.id + '/site-publisher'
    const response = await s.request(path)
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ context: { accountId: f.account.id, domainId: domain.id }, application: { status: 'read', nativeQualified: false } })
    f.files.mockClear()
    const preview = await s.request(path + '/preview', 'POST', { template: 'coming-soon', lang: 'ar', title: 'Coming soon', message: 'Welcome', email: '', phone: '' })
    expect(preview.status).toBe(200); expect(await preview.json()).toMatchObject({ html: expect.stringContaining('Coming soon'), hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(f.files).not.toHaveBeenCalled(); expect(f.nativeRun).not.toHaveBeenCalled()
    expect(f.hostCalls.map(request => new URL(request.url).pathname)).toEqual(['/accounts/' + f.account.username + '/site-publisher/' + domain.id, '/accounts/' + f.account.username + '/site-publisher/' + domain.id + '/preview'])
  })

  it('rejects foreign site targets and injected preview fields before transport', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel'), domain = (await f.state.store.listDomains({ accountId: f.account.id }))[0]!
    expect((await s.request('/api/domains/' + randomUUID() + '/site-publisher')).status).toBe(404)
    expect((await s.request('/api/domains/' + domain.id + '/site-publisher/preview', 'POST', { template: 'coming-soon', lang: 'en', title: 'Title', message: 'Welcome', email: '', phone: '', path: '/etc' })).status).toBe(422)
    expect(f.hostCalls).toHaveLength(0)
  })

  it('discards site preview content after session revocation during the host await', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel'), domain = (await f.state.store.listDomains({ accountId: f.account.id }))[0]!
    f.setHostReply(async request => { const response = await f.agent.fetch(request); await db.revokeSession(f.database.db, s.record.id); return response })
    const response = await s.request('/api/domains/' + domain.id + '/site-publisher/preview', 'POST', { template: 'coming-soon', lang: 'en', title: 'Private preview', message: 'Welcome', email: '', phone: '' })
    expect(response.status).toBe(401); expect(await response.text()).not.toContain('Private preview')
    expect(f.files).not.toHaveBeenCalled(); expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it('locks an unverified site publication acknowledgement without a retry', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel'), domain = (await f.state.store.listDomains({ accountId: f.account.id }))[0]!
    f.setHostReply(async () => Response.json({ ok: true }))
    const response = await s.request('/api/domains/' + domain.id + '/site-publisher/publish', 'POST', { expectedRevision: 'a'.repeat(64), draft: { template: 'coming-soon', lang: 'en', title: 'Title', message: 'Welcome', email: '', phone: '' } })
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ details: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
    expect(f.hostCalls).toHaveLength(1); expect(f.files).not.toHaveBeenCalled()
  })

  it('creates, rotates and revokes DDNS credentials while DNS stays unchanged without qualified publication', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel')
    await f.state.store.saveDnsZone({ id: randomUUID(), accountId: f.account.id, name: f.account.primaryDomain, serial: 1, records: [] })
    const before = await f.state.store.getDnsZone(f.account.primaryDomain)
    const initial = await (await s.request('/api/account/dynamic-dns')).json()
    const created = await s.request('/api/account/dynamic-dns', 'POST', { hostname: 'home.' + f.account.primaryDomain, zone: f.account.primaryDomain, type: 'A', description: 'Router', expectedRevision: initial.revision })
    expect(created.status).toBe(201)
    const issued = await created.json()
    const update = (secret = issued.issued.secret, suffix = '') => s.app.fetch(new Request(s.origin + '/nic/update?hostname=home.' + f.account.primaryDomain + '&myip=203.0.113.7' + suffix,
      { headers: { authorization: 'Basic ' + Buffer.from(issued.issued.id + ':' + secret).toString('base64') } }), { tls: true, remoteAddress: '198.51.100.9' })
    expect(await (await update(undefined, '&ignored=1')).text()).toBe('notfqdn\n')
    expect(await (await update()).text()).toBe('911\n')
    expect(await f.state.store.getDnsZone(f.account.primaryDomain)).toEqual(before)
    const rotated = await (await s.request('/api/account/dynamic-dns/' + issued.issued.id + '/rotate', 'POST', { expectedRevision: issued.revision })).json()
    expect(rotated.issued.secret).not.toBe(issued.issued.secret)
    expect(await (await update()).text()).toBe('badauth\n')
    expect((await s.request('/api/account/dynamic-dns/' + issued.issued.id, 'DELETE', { expectedRevision: rotated.revision })).status).toBe(200)
    expect(await (await update(rotated.issued.secret)).text()).toBe('badauth\n')
    expect(f.hostCalls.every(request => !new URL(request.url).pathname.includes('apply'))).toBe(true)
    expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it('keeps DDNS protocol behind its exact xPanel host and verified TLS before credentials', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel'), admin = await f.session(f.root.id, 'xwhm')
    expect((await s.app.fetch(new Request('https://foreign.test/nic/update'), { tls: true })).status).toBe(421)
    expect((await s.app.fetch(new Request(s.origin + '/nic/update'))).status).toBe(403)
    expect((await admin.app.fetch(new Request(admin.origin + '/nic/update'), { tls: true })).status).toBe(404)
    const unauthenticated = await s.app.fetch(new Request(s.origin + '/nic/update'), { tls: true })
    expect(unauthenticated.status).toBe(401); expect(await unauthenticated.text()).toBe('badauth\n')
    expect(f.hostCalls).toHaveLength(0)
  })
})
