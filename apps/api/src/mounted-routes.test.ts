import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as db from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { createAgentApp } from '../../agent/src/server.ts'
import type { AgentServerDeps } from '../../agent/src/server.ts'
import { FakeHostExecutor } from '../../agent/src/executor.ts'
import { deriveCsrfToken, sha256Hex as dbTokenHash } from './auth.ts'
import { sessionCookieName, sessionTokenHash } from './entry-points.ts'
import type { EntryPoint } from './entry-points.ts'
import { createApiApp } from './server.ts'
import type { ApiServerDeps } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'
import { establishMailboxSession } from './mail/inbox.ts'
import type { MailboxTransport } from './mail/inbox.ts'

// Real listeners' admission, persisted identities, StateStore and API -> agent routing.
// These tests never activate Linux/native providers or execute their commands.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
const subscriptionOnlyReconciler = (): AgentServerDeps['reconciler'] => {
  const boundary: Pick<AgentServerDeps['reconciler'], 'subscribe'> = { subscribe: () => () => {} }
  return boundary as unknown as AgentServerDeps['reconciler']
}
afterEach(async () => {
  vi.restoreAllMocks()
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Mounted-route fixture cleanup failed')
})
async function fixture(options: { agent?: Partial<AgentServerDeps>; api?: Partial<ApiServerDeps> } = {}) {
  const database = await db.createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Mounted-route fixture', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Mounted-route fixture', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 4, aliasDomains: 4, subdomains: 4, mailboxes: 4, forwarders: 4, mailingLists: 4, ftpAccounts: 4, databases: 4, phpWorkers: 4 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.64', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const makeAccount = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: username + '.example.test', planId: plan.id, ownerId: null,
    contactEmail: 'owner@' + username + '.example.test', ipv4: '192.0.2.64', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const account = await makeAccount('mountowner'), other = await makeAccount('mountother')
  const root = await db.createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const owner = await db.createUserPrincipal(database.db, { username: account.username, accountId: account.id, passwordHash: HASH })
  const neighbor = await db.createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: HASH })
  const executor = new FakeHostExecutor(), nativeRun = vi.spyOn(executor, 'runCommand'), nativeRead = vi.spyOn(executor, 'readFile')
  const agent = createAgentApp({ db: database.db, store: state.store, executor, os: profileFor('ID=ubuntu\nVERSION_ID="24.04"\n'), agentToken: TEST_AGENT_TOKEN,
    reconciler: subscriptionOnlyReconciler(), ...options.agent })
  let hostReply: ((request: Request) => Promise<Response>) | undefined
  const hostCalls: Request[] = []
  const transport = { subscribe: agent.subscribe, fetch: async (request: Request) => { hostCalls.push(request.clone()); return hostReply ? hostReply(request) : agent.fetch(request) } }
  const session = async (principalId: string, surface: EntryPoint = 'xwhm', issued?: { raw: string; record: Awaited<ReturnType<typeof db.createSession>> }) => {
    const raw = issued?.raw ?? randomUUID() + randomUUID(), origin = surface === 'xwhm' ? 'https://whm.example.test:2087' : surface === 'xmail' ? 'https://mail.example.test:2096' : 'https://panel.example.test:2083'
    const record = issued?.record ?? await db.createSession(database.db, { principalId, tokenHash: sessionTokenHash(raw, surface), expiresAt: new Date(Date.now() + 3600000).toISOString(), mfaVerified: true })
    const app = createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET, entryPoint: surface, publicOrigin: origin, allowedOrigins: [origin], secureCookies: true, requireSecureCookies: true,
      agentApp: transport, agentToken: TEST_AGENT_TOKEN, ...options.api })
    const headers = { origin, cookie: sessionCookieName(surface, true) + '=' + raw, 'x-csrf-token': deriveCsrfToken(raw, TEST_SERVER_SECRET, surface) }
    const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => app.fetch(new Request(origin + path, { method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { tls: true, remoteAddress: '198.51.100.9' })
    return { app, request, record, origin, headers }
  }
  return { database, state, account, other, root, owner, neighbor, features, plan, agent, nativeRun, nativeRead, hostCalls, session,
    setHostReply: (reply: typeof hostReply) => { hostReply = reply } }
}

describe('mounted system update exclusion', () => {
  it.each(['', '?excludeKernel=true'])('forwards the exact observed plan option %s while native updates stay unavailable', async suffix => {
    const f = await fixture(), s = await f.session(f.root.id)
    const response = await s.request('/api/server/updates/plan' + suffix)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ plan: { state: 'unavailable', packages: [], reason: 'unsupported-host' }, actions: { refresh: false, apply: false } })
    if (suffix) expect(body.plan.excludeKernel).toBe(true)
    else expect(body.plan).not.toHaveProperty('excludeKernel')
    expect(f.hostCalls).toHaveLength(1); expect(f.hostCalls[0]!.method).toBe('GET')
    expect(new URL(f.hostCalls[0]!.url).pathname + new URL(f.hostCalls[0]!.url).search).toBe('/host/system-updates/plan' + suffix)
    expect(f.nativeRun).not.toHaveBeenCalled(); expect(f.nativeRead).not.toHaveBeenCalled()
  })

  it.each(['?excludeKernel=false', '?excludeKernel=TRUE', '?excludeKernel=true&excludeKernel=true', '?excludeKernel=true&command=id'])('rejects update selector pollution %s before host dispatch', async suffix => {
    const f = await fixture(), s = await f.session(f.root.id)
    expect((await s.request('/api/server/updates/plan' + suffix)).status).toBe(422)
    expect(f.hostCalls).toHaveLength(0)
  })

  it.each([{ excludeKernel: 'true' }, { exclude: ['linux-*'] }, { command: '/bin/sh' }, { packages: ['curl'] }])('rejects malformed exclusion body %j before host dispatch', async extra => {
    const f = await fixture(), s = await f.session(f.root.id)
    expect((await s.request('/api/server/updates/apply', 'POST', { mode: 'all', expectedRevision: 'a'.repeat(64), ...extra })).status).toBe(422)
    expect(f.hostCalls).toHaveLength(0)
  })

  it.each([true, false])('forwards canonical excludeKernel=%s without request-controlled command selectors', async excludeKernel => {
    const f = await fixture(), s = await f.session(f.root.id)
    const body = { mode: 'all', expectedRevision: 'a'.repeat(64), excludeKernel }
    const response = await s.request('/api/server/updates/apply', 'POST', body)
    expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    expect(f.hostCalls).toHaveLength(1)
    expect(await f.hostCalls[0]!.json()).toEqual({ mode: 'all', expectedRevision: body.expectedRevision, ...(excludeKernel ? { excludeKernel: true } : {}) })
    expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it.each(['session', 'principal'] as const)('discards the excluded plan after %s revocation during the host await', async kind => {
    const f = await fixture(), s = await f.session(f.root.id)
    f.setHostReply(async request => { const response = await f.agent.fetch(request); if (kind === 'session') await db.revokeSession(f.database.db, s.record.id); else await db.deletePrincipal(f.database.db, f.root.id); return response })
    const response = await s.request('/api/server/updates/plan?excludeKernel=true')
    expect(response.status).toBe(401); expect(await response.text()).not.toContain('unsupported-host')
    expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it('marks a malformed update job acknowledgement as uncertain rather than successful', async () => {
    const f = await fixture(), s = await f.session(f.root.id)
    f.setHostReply(async () => Response.json({ job: { id: randomUUID(), status: 'not-a-job-state' } }))
    const response = await s.request('/api/server/updates/apply', 'POST', { mode: 'all', expectedRevision: 'a'.repeat(64), excludeKernel: true })
    expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
    expect(f.hostCalls).toHaveLength(1); expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it('requires actual cookie CSRF and keeps administrator update reads off the owner listener', async () => {
    const f = await fixture(), root = await f.session(f.root.id), owner = await f.session(f.owner.id, 'xpanel')
    expect((await root.request('/api/server/updates/apply', 'POST', { mode: 'all', expectedRevision: 'a'.repeat(64), excludeKernel: true }, { 'x-csrf-token': '' })).status).toBe(403)
    expect((await owner.request('/api/server/updates/plan?excludeKernel=true')).status).toBe(404)
    expect(f.hostCalls).toHaveLength(0)
  })
})

const repairIntent = { target: 'a'.repeat(64), expectedRevision: 'b'.repeat(64), expectedGenerationId: 1, expectedGenerationChecksum: 'c'.repeat(64), confirmation: 'REPAIR CONFIGURATION' }
describe('mounted configuration health', () => {
  it('returns explicit unavailable observations without native readers or any broad reconciliation effect', async () => {
    const f = await fixture(), s = await f.session(f.root.id), response = await s.request('/api/server/configuration-health')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'unavailable', generation: null, targets: [], tests: [], canRepair: false, repairReason: 'observation_unavailable' })
    expect(f.hostCalls).toHaveLength(1); expect(new URL(f.hostCalls[0]!.url).pathname).toBe('/host/configuration-health')
    expect(f.nativeRun).not.toHaveBeenCalled(); expect(f.nativeRead).not.toHaveBeenCalled()
  })

  it('rejects configuration selectors and target path injection before forwarding', async () => {
    const f = await fixture(), s = await f.session(f.root.id)
    expect((await s.request('/api/server/configuration-health?path=/etc/shadow')).status).toBe(422)
    expect((await s.request('/api/server/configuration-health/repair', 'POST', { ...repairIntent, path: '/etc/shadow' })).status).toBe(422)
    expect(f.hostCalls).toHaveLength(0)
  })

  it('preserves unchanged refusal when no targeted recoverable repair provider exists', async () => {
    const f = await fixture(), s = await f.session(f.root.id), revision = await f.state.store.getRevision()
    const response = await s.request('/api/server/configuration-health/repair', 'POST', repairIntent)
    expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    expect(await f.state.store.getRevision()).toBe(revision)
    expect(f.hostCalls).toHaveLength(1); expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it('discards configuration observations after real session revocation during transport', async () => {
    const f = await fixture(), s = await f.session(f.root.id)
    f.setHostReply(async request => { const response = await f.agent.fetch(request); await db.revokeSession(f.database.db, s.record.id); return response })
    const response = await s.request('/api/server/configuration-health')
    expect(response.status).toBe(401); expect(await response.text()).not.toContain('observation_unavailable')
  })

  it('refuses a repair acknowledgement without exact recovery proof and retains uncertainty', async () => {
    const f = await fixture(), s = await f.session(f.root.id)
    f.setHostReply(async () => Response.json({ outcome: 'verified', target: repairIntent.target, recoveryVerified: false, verificationRequired: false }))
    const response = await s.request('/api/server/configuration-health/repair', 'POST', repairIntent)
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ details: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
    expect(f.hostCalls).toHaveLength(1); expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it('requires root for configuration health despite an interactive reseller listener session', async () => {
    const f = await fixture(), reseller = await f.state.store.createReseller({ username: 'mounthealth', passwordHash: HASH, acl: ['list-accounts', 'edit-account'], maxAccounts: 10,
      totalDiskMb: 10000, totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [] })
    const principal = await db.createResellerPrincipal(f.database.db, { id: reseller.id, username: reseller.username, passwordHash: HASH }), s = await f.session(principal.id)
    expect((await s.request('/api/server/configuration-health')).status).toBe(403)
    expect((await s.request('/api/server/configuration-health/repair', 'POST', repairIntent)).status).toBe(403)
    expect(f.hostCalls).toHaveLength(0)
  })
})

async function collaborationFixture() {
  const f = await fixture()
  const mailbox = (accountId: string, login: string) => f.state.store.createServiceUser({ accountId, login, passwordHash: HASH,
    services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const own = await mailbox(f.account.id, 'inbox@' + f.account.primaryDomain), sibling = await mailbox(f.account.id, 'support@' + f.account.primaryDomain), foreign = await mailbox(f.other.id, 'private@' + f.other.primaryDomain)
  const calendarsPath = join(f.state.store.rootDir, 'extended', 'webmail', 'calendars.json')
  const contactsPath = join(f.state.store.rootDir, 'extended', 'webmail', 'contacts.json')
  const authority = (service: typeof own) => ({ accountId: service.accountId, serviceUserId: service.id, mailbox: service.login })
  const calendar = (service: typeof own, name: string) => ({ id: randomUUID(), owner: service.login, ownerAuthority: authority(service), name, color: '#123456', timezone: 'UTC', shares: [], events: [], createdAt: new Date().toISOString() })
  await atomicWriteJson(calendarsPath, [])
  await atomicWriteJson(contactsPath, [])
  return { ...f, own, sibling, foreign, authority, calendar, calendarsPath, contactsPath }
}
describe('mounted account collaboration', () => {
  it('projects only current own mailbox metadata from the canonical calendar/contact collections', async () => {
    const f = await collaborationFixture(), s = await f.session(f.owner.id, 'xpanel')
    const ownCalendar = f.calendar(f.own, 'Operations'), foreignCalendar = f.calendar(f.foreign, 'FOREIGN_CALENDAR_MARKER')
    await atomicWriteJson(f.calendarsPath, [ownCalendar, foreignCalendar, { ...f.calendar(f.own, 'UNBOUND_OLD_MARKER'), ownerAuthority: undefined }])
    await atomicWriteJson(f.contactsPath, [{ id: randomUUID(), owner: f.own.login, ownerAuthority: f.authority(f.own), fullName: 'OWN_CONTACT_CONTENT_MARKER', groups: ['Work'] }, { id: randomUUID(), owner: f.foreign.login, ownerAuthority: f.authority(f.foreign), fullName: 'FOREIGN_CONTACT_MARKER', groups: [] }])
    const response = await s.request('/api/account/collaboration')
    expect(response.status).toBe(200)
    const view = await response.json()
    expect(view).toMatchObject({ context: { account: f.account.username }, source: 'saved-mailbox-metadata', application: { nativeApplied: false, syncVerified: false } })
    expect(view.mailboxes.map((row: { mailbox: string }) => row.mailbox).sort()).toEqual([f.own.login, f.sibling.login].sort())
    expect(view.mailboxes.find((row: { mailbox: string }) => row.mailbox === f.own.login)).toMatchObject({ calendars: [{ name: 'Operations' }], contacts: { count: 1, groupCount: 1 } })
    const serialized = JSON.stringify(view)
    for (const value of ['FOREIGN_CALENDAR_MARKER', 'FOREIGN_CONTACT_MARKER', 'OWN_CONTACT_CONTENT_MARKER', 'UNBOUND_OLD_MARKER', f.foreign.login, f.account.id, f.own.id, ownCalendar.id]) expect(serialized).not.toContain(value)
    expect(f.hostCalls).toHaveLength(0)
  })

  it('creates through the existing calendar writer with immutable ownership and rejects the stale public revision', async () => {
    const f = await collaborationFixture(), s = await f.session(f.owner.id, 'xpanel'), before = await (await s.request('/api/account/collaboration')).json()
    const selected = before.mailboxes.find((row: { mailbox: string }) => row.mailbox === f.own.login)
    const body = { mailbox: f.own.login, name: 'Operations', color: '#123456', timezone: 'UTC', expectedRevision: selected.revision }
    const response = await s.request('/api/account/collaboration/calendars', 'POST', body)
    expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ stateChanged: true, created: { mailbox: f.own.login, name: 'Operations' }, application: { nativeApplied: false } })
    const rows = JSON.parse(await readFile(f.calendarsPath, 'utf8'))
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ owner: f.own.login, ownerAuthority: f.authority(f.own), name: 'Operations', shares: [], events: [] })
    expect((await s.request('/api/account/collaboration/calendars', 'POST', body)).status).toBe(409)
    expect(JSON.parse(await readFile(f.calendarsPath, 'utf8'))).toEqual(rows)
    expect(f.hostCalls).toHaveLength(0)
  })

  it('refuses foreign mailbox creation and account/query injection without altering canonical collections', async () => {
    const f = await collaborationFixture(), s = await f.session(f.owner.id, 'xpanel'), view = await (await s.request('/api/account/collaboration')).json()
    const body = { mailbox: f.foreign.login, name: 'Injected', color: '#123456', timezone: 'UTC', expectedRevision: view.mailboxes[0].revision }
    expect((await s.request('/api/account/collaboration/calendars', 'POST', body)).status).toBe(404)
    expect((await s.request('/api/account/collaboration/calendars', 'POST', { ...body, accountId: f.other.id })).status).toBe(422)
    expect((await s.request('/api/account/collaboration?mailbox=' + f.foreign.login)).status).toBe(422)
    expect(JSON.parse(await readFile(f.calendarsPath, 'utf8'))).toEqual([])
  })

  it('rechecks the real owner session after awaiting the canonical collaboration lifecycle lease', async () => {
    const f = await collaborationFixture(), s = await f.session(f.owner.id, 'xpanel'), lock = f.state.store.getWriterLock(), acquire = lock.acquire.bind(lock)
    vi.spyOn(lock, 'acquire').mockImplementationOnce(async (...args) => { await db.revokeSession(f.database.db, s.record.id); return acquire(...args) })
    const response = await s.request('/api/account/collaboration')
    expect(response.status).toBe(401); expect(await response.text()).not.toContain(f.own.login)
    expect(JSON.parse(await readFile(f.calendarsPath, 'utf8'))).toEqual([])
  })

  it('checks current collaboration features before the existing calendar writer runs', async () => {
    const f = await collaborationFixture(), s = await f.session(f.owner.id, 'xpanel'), view = await (await s.request('/api/account/collaboration')).json()
    await f.state.store.updateFeatureList(f.features.id, { disabled: ['calendars-contacts-management'] })
    expect((await s.request('/api/account/collaboration')).status).toBe(403)
    expect((await s.request('/api/account/collaboration/calendars', 'POST', { mailbox: f.own.login, name: 'Blocked', color: '#123456', timezone: 'UTC', expectedRevision: view.mailboxes[0].revision })).status).toBe(403)
    expect(JSON.parse(await readFile(f.calendarsPath, 'utf8'))).toEqual([])
  })
})

describe('mounted owner package and remote database boundaries', () => {
  it('reads an empty private library with an explicit read-only file fixture and refuses unqualified package mutation', async () => {
    const files = vi.fn(async (_context: unknown, request: { op: string }) => { if (request.op === 'list') return []; throw new Error('Unexpected file effect: ' + request.op) })
    const f = await fixture({ agent: { accountFileRunner: { run: files } } }), s = await f.session(f.owner.id, 'xpanel')
    const response = await s.request('/api/account/packages')
    expect(response.status).toBe(200)
    const view = await response.json()
    expect(view).toMatchObject({ context: { accountId: f.account.id, username: f.account.username }, ecosystem: 'pear', packages: [], available: [], catalogRevision: null, capabilities: { install: false, remove: false, recover: false } })
    expect((await s.request('/api/account/packages', 'POST', { op: 'install', name: 'HTTP_Request2', expectedRevision: view.revision })).status).toBe(412)
    expect(files.mock.calls.every(([, request]) => request.op === 'list')).toBe(true)
    expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it('rejects package account selectors and forged admission before protected transport', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel')
    expect((await s.request('/api/account/packages?accountId=' + f.other.id)).status).toBe(422)
    expect((await s.request('/api/account/packages', 'POST', { op: 'install', name: 'HTTP_Request2', expectedRevision: 'a'.repeat(64), qualified: true })).status).toBe(422)
    expect(f.hostCalls).toHaveLength(0)
  })

  it('discards a private package read after its real owner session is revoked during transport', async () => {
    const files = { run: async (_context: unknown, request: { op: string }) => { if (request.op === 'list') return []; throw new Error('Unexpected file effect') } }
    const f = await fixture({ agent: { accountFileRunner: files } }), s = await f.session(f.owner.id, 'xpanel')
    f.setHostReply(async request => { const response = await f.agent.fetch(request); await db.revokeSession(f.database.db, s.record.id); return response })
    const response = await s.request('/api/account/packages')
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
  })

  it('reads canonical remote-host policy but refuses native grant/firewall writes without qualified recovery', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel'), before = await f.state.store.getAccount(f.account.id)
    const response = await s.request('/api/account/database-remote-access')
    expect(response.status).toBe(200)
    const view = await response.json()
    expect(view).toMatchObject({ context: { accountId: f.account.id }, entries: [], capability: { canChange: false, reason: 'native_provider_unavailable' }, application: { status: 'read', nativeQualified: false } })
    const refused = await s.request('/api/account/database-remote-access', 'POST', { action: 'add', expectedRevision: view.revision, host: '203.0.113.7', comment: 'Office' })
    expect(refused.status).toBe(412); expect(await refused.json()).toMatchObject({ details: { stateChanged: false } })
    expect(await f.state.store.getAccount(f.account.id)).toEqual(before); expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it('rejects remote SQL/account injection and requires real cookie CSRF before dispatch', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel')
    const body = { action: 'add', expectedRevision: 'a'.repeat(64), host: '203.0.113.7', comment: '' }
    expect((await s.request('/api/account/database-remote-access?accountId=' + f.other.id)).status).toBe(422)
    expect((await s.request('/api/account/database-remote-access', 'POST', { ...body, sql: 'GRANT ALL' })).status).toBe(422)
    expect((await s.request('/api/account/database-remote-access', 'POST', body, { 'x-csrf-token': '' })).status).toBe(403)
    expect(f.hostCalls).toHaveLength(0)
  })

  it('rechecks remote-access session authority after a protected read and preserves the auth refusal', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel')
    f.setHostReply(async request => { const response = await f.agent.fetch(request); await db.revokeSession(f.database.db, s.record.id); return response })
    const response = await s.request('/api/account/database-remote-access')
    expect(response.status).toBe(401); expect(await response.text()).not.toContain('native_provider_unavailable')
  })

  it('marks wrong-tenant remote mutation acknowledgements as unknown and never retries', async () => {
    const f = await fixture(), s = await f.session(f.owner.id, 'xpanel')
    f.setHostReply(async () => Response.json({ context: { accountId: f.other.id, username: f.other.username }, application: { status: 'applied', nativeQualified: true } }))
    const response = await s.request('/api/account/database-remote-access', 'POST', { action: 'add', expectedRevision: 'a'.repeat(64), host: '203.0.113.7', comment: '' })
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ details: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
    expect(f.hostCalls).toHaveLength(1); expect(f.nativeRun).not.toHaveBeenCalled()
  })
})

describe('mounted trusted proxies and destination lifecycle', () => {
  it('saves proxy metadata with CAS while live startup trust and native activation stay unavailable', async () => {
    const f = await fixture(), s = await f.session(f.root.id), initial = await (await s.request('/api/server/trusted-proxies')).json()
    const body = { policy: { cidrs: ['203.0.113.0/24'], header: 'X-Forwarded-For' }, expectedRevision: initial.revision }
    const response = await s.request('/api/server/trusted-proxies', 'PUT', body)
    expect(response.status).toBe(200)
    const saved = await response.json()
    expect(saved).toMatchObject({ state: 'saved', policy: body.policy, observation: { state: 'unavailable', active: null }, application: 'saved_only' })
    expect((await s.request('/api/server/trusted-proxies', 'PUT', body)).status).toBe(409)
    const apply = await s.request('/api/server/trusted-proxies/apply', 'POST', { expectedRevision: saved.revision, expectedActiveRevision: 'a'.repeat(64) })
    expect(apply.status).toBe(412); expect(await apply.json()).toMatchObject({ details: { stateChanged: false } })
    expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it('rejects trusting the actual management client or private networks despite forged forwarding headers', async () => {
    const f = await fixture(), s = await f.session(f.root.id), initial = await (await s.request('/api/server/trusted-proxies')).json()
    for (const cidr of ['198.51.100.9/32', '127.0.0.1/32', '10.0.0.0/24']) {
      expect((await s.request('/api/server/trusted-proxies', 'PUT', { policy: { cidrs: [cidr], header: 'X-Forwarded-For' }, expectedRevision: initial.revision }, { 'x-forwarded-for': '203.0.113.77', 'x-forwarded-proto': 'https' })).status).toBe(422)
    }
    const stored = await s.request('/api/server/trusted-proxies')
    expect(await stored.json()).toMatchObject({ state: 'default', policy: { cidrs: [] } })
  })

  it('does not return trusted proxy observations after session revocation during the agent await', async () => {
    const f = await fixture(), s = await f.session(f.root.id)
    f.setHostReply(async request => { const response = await f.agent.fetch(request); await db.revokeSession(f.database.db, s.record.id); return response })
    expect((await s.request('/api/server/trusted-proxies')).status).toBe(401)
  })

  it('marks an invalid active-proxy acknowledgement uncertain after dispatch', async () => {
    const f = await fixture(), s = await f.session(f.root.id), initial = await (await s.request('/api/server/trusted-proxies')).json()
    const saved = await (await s.request('/api/server/trusted-proxies', 'PUT', { policy: { cidrs: ['203.0.113.0/24'], header: 'X-Forwarded-For' }, expectedRevision: initial.revision })).json()
    f.setHostReply(async () => Response.json({ savedRevision: saved.revision, stateChanged: true, verificationRequired: false, active: { state: 'read', policy: { cidrs: ['203.0.113.0/24'], header: 'X-Forwarded-For' }, revision: 'a'.repeat(64) } }))
    const response = await s.request('/api/server/trusted-proxies/apply', 'POST', { expectedRevision: saved.revision, expectedActiveRevision: 'b'.repeat(64) })
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ details: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
  })

  it('creates destinations inactive and never fabricates activation without a current remote proof', async () => {
    const f = await fixture(), s = await f.session(f.root.id), first = await (await s.request('/api/backups/workspace/destination-lifecycle')).json()
    const created = await s.request('/api/backups/workspace/destinations', 'POST', { name: 'Fixture remote', kind: 'sftp', endpoint: 'sftp://backup.example.test', pathPrefix: '/daily', username: 'backup', enabled: true, credentialRef: 'fixture-profile', expectedRevision: first.revision })
    expect(created.status).toBe(201)
    const body = await created.json()
    expect(body.destination).toMatchObject({ enabled: false, credentialRef: 'fixture-profile', verification: null })
    const view = await (await s.request('/api/backups/workspace/destination-lifecycle')).json()
    expect(view.destinations).toHaveLength(1); expect(view.destinations[0]).toMatchObject({ effectiveActive: false, state: 'unavailable' })
    for (const action of ['test', 'activate']) {
      const response = await s.request('/api/backups/workspace/destinations/' + body.destination.id + '/' + action, 'POST', { expectedRevision: view.revision })
      expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    }
    expect(f.nativeRun).not.toHaveBeenCalled()
  })

  it('rejects destination proof and arbitrary target injection before any protected probe', async () => {
    const f = await fixture(), s = await f.session(f.root.id)
    const response = await s.request('/api/backups/workspace/destinations/' + randomUUID() + '/test', 'POST', { expectedRevision: 'a'.repeat(64), url: 'http://127.0.0.1/', verification: { outcome: 'verified' } })
    expect(response.status).toBe(422); expect(f.hostCalls).toHaveLength(0)
    expect((await s.request('/api/backups/workspace/destination-lifecycle?credentialRef=foreign')).status).toBe(422)
  })

  it('reauthenticates root after destination capability reads before exposing metadata', async () => {
    const f = await fixture(), s = await f.session(f.root.id)
    f.setHostReply(async request => { const response = await f.agent.fetch(request); await db.revokeSession(f.database.db, s.record.id); return response })
    expect((await s.request('/api/backups/workspace/destination-lifecycle')).status).toBe(401)
  })
})

describe('mounted finite developer dispatch', () => {
  it('re-enters real guarded identity/preferences reads with the original TLS and session provenance', async () => {
    const f = await fixture(), root = await f.session(f.root.id), owner = await f.session(f.owner.id, 'xpanel')
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external network call'))
    const response = await root.request('/api/server/panel/developer', 'POST', { operation: 'identity' })
    expect(response.status).toBe(200)
    const view = await response.json()
    expect(view).toMatchObject({ state: 'read', status: 200, request: { method: 'GET', path: '/api/auth/me' }, fields: [{ key: 'username', value: 'root' }, { key: 'role', value: 'root' }] })
    expect(JSON.stringify(view)).not.toMatch(/csrf|tokenHash|principalId/); expect(JSON.stringify(view)).not.toContain(f.root.id)
    const preferences = await owner.request('/api/account/developer', 'POST', { operation: 'preferences' })
    expect(preferences.status).toBe(200); expect(await preferences.json()).toMatchObject({ fields: [{ key: 'contactEmail', value: f.account.contactEmail }] })
    expect(network).not.toHaveBeenCalled(); expect(f.hostCalls).toHaveLength(0)
  })

  it('projects only the signed-in root token inventory without secrets or foreign credentials', async () => {
    const f = await fixture(), s = await f.session(f.root.id), foreign = await db.createRootPrincipal(f.database.db, { username: 'other-root', passwordHash: HASH, forcePasswordChange: false })
    const ownSecret = 'xp_' + randomUUID(), foreignSecret = 'xp_' + randomUUID(), expiresAt = new Date(Date.now() + 3600000).toISOString()
    await db.createApiToken(f.database.db, { principalId: f.root.id, name: 'own-token', tokenHash: dbTokenHash(ownSecret), scopes: ['server:read'], expiresAt })
    await db.createApiToken(f.database.db, { principalId: foreign.id, name: 'foreign-token', tokenHash: dbTokenHash(foreignSecret), scopes: ['*'], expiresAt })
    const response = await s.request('/api/server/panel/integrations', 'POST', { operation: 'tokens' })
    expect(response.status).toBe(200)
    const view = await response.json()
    expect(view.tokens.map((token: { name: string }) => token.name)).toEqual(['own-token'])
    for (const value of [ownSecret, foreignSecret, f.root.id, foreign.id, 'foreign-token', 'tokenHash']) expect(JSON.stringify(view)).not.toContain(value)
    expect(f.hostCalls).toHaveLength(0)
  })

  it('refuses arbitrary executor selectors and operations outside the current explorer surface', async () => {
    const f = await fixture(), root = await f.session(f.root.id), owner = await f.session(f.owner.id, 'xpanel')
    expect((await root.request('/api/server/panel/developer', 'POST', { operation: 'identity', url: 'http://127.0.0.1/' })).status).toBe(422)
    expect((await root.request('/api/server/panel/integrations', 'POST', { operation: 'identity' })).status).toBe(403)
    expect((await owner.request('/api/account/developer', 'POST', { operation: 'tokens' })).status).toBe(403)
    expect((await owner.request('/api/account/developer?accountId=' + f.other.id)).status).toBe(422)
    expect(f.hostCalls).toHaveLength(0)
  })

  it('does not allow a root bearer credential to become an interactive explorer session', async () => {
    const f = await fixture(), secret = 'xp_' + randomUUID()
    await db.createApiToken(f.database.db, { principalId: f.root.id, name: 'explorer-bearer', tokenHash: dbTokenHash(secret), scopes: ['*'], expiresAt: new Date(Date.now() + 3600000).toISOString() })
    const app = createApiApp({ db: f.database.db, store: f.state.store, serverSecret: TEST_SERVER_SECRET })
    const response = await app.fetch(new Request('http://localhost/api/server/panel/developer', { headers: { authorization: 'Bearer ' + secret } }))
    expect(response.status).toBe(403)
  })
})

async function sealedToolsFixture() {
  const f = await collaborationFixture()
  const transport: MailboxTransport = { verify: async () => {}, list: async () => [], read: async () => { throw new Error('No message reads in this fixture') }, remove: async () => {}, send: async () => ({ messageId: '<unused@example.test>' }) }
  const issued = await establishMailboxSession({ db: f.database.db, store: f.state.store, serverSecret: TEST_SERVER_SECRET, transport, entryPoint: 'xmail', mailbox: f.own.login, password: 'synthetic-sealed-fixture-only', ip: '198.51.100.9', userAgent: 'Mounted metadata fixture' })
  const sealed = await f.session(issued.principal.id, 'xmail', { raw: issued.rawToken, record: issued.session })
  return { ...f, sealed }
}
describe('mounted sealed mailbox tools', () => {
  const spamFields = { inherit: false, enabled: true, addHeaderScore: 6, spamBoxEnabled: true, allowlist: ['safe@example.test'], blocklist: [] }
  it('saves mailbox spam preferences with CAS without changing account policy or claiming native application', async () => {
    const f = await sealedToolsFixture(), accountPath = join(f.state.store.rootDir, 'extended', 'mail', 'accounts', f.account.id, 'spam-settings.json')
    await atomicWriteJson(accountPath, { enabled: true, addHeaderScore: 5, spamBoxEnabled: true, allowlist: ['private-account-list@example.test'], blocklist: [] })
    const before = await readFile(accountPath, 'utf8'), initial = await (await f.sealed.request('/api/webmail/spam-preferences')).json()
    expect(JSON.stringify(initial)).not.toContain('private-account-list@example.test')
    const response = await f.sealed.request('/api/webmail/spam-preferences', 'PUT', { ...spamFields, expectedRevision: initial.revision })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ context: { mailbox: f.own.login }, preferences: spamFields, capabilities: { mta: 'unverified', sieve: 'unverified', boxTrapper: false }, application: { status: 'saved_only', applied: false } })
    expect((await f.sealed.request('/api/webmail/spam-preferences', 'PUT', { ...spamFields, expectedRevision: initial.revision })).status).toBe(409)
    expect(await readFile(accountPath, 'utf8')).toBe(before); expect(f.hostCalls).toHaveLength(0)
  })

  it('rejects mailbox selectors and hosting-owner impersonation without metadata writes', async () => {
    const f = await sealedToolsFixture(), owner = await f.session(f.owner.id, 'xmail')
    expect((await f.sealed.request('/api/webmail/spam-preferences?mailbox=' + f.sibling.login)).status).toBe(422)
    expect((await f.sealed.request('/api/webmail/spam-preferences', 'PUT', { ...spamFields, expectedRevision: 'a'.repeat(64), mailbox: f.sibling.login })).status).toBe(422)
    // xMail never authenticates a hosting-owner session at all.
    expect((await owner.request('/api/webmail/spam-preferences')).status).toBe(401)
    expect(f.hostCalls).toHaveLength(0)
  })

  it('changes only the current bound member on the canonical list and rejects stale subscription CAS', async () => {
    const f = await sealedToolsFixture(), path = join(f.state.store.rootDir, 'extended', 'mail', 'mailing-lists.json'), id = randomUUID()
    const foreign = { id: randomUUID(), accountId: f.other.id, name: 'Private foreign list', domain: f.other.primaryDomain, address: 'private@' + f.other.primaryDomain, members: [], moderation: 'members', archiveEnabled: false, selfSubscription: 'open', createdAt: new Date().toISOString() }
    await atomicWriteJson(path, [{ id, accountId: f.account.id, name: 'News', domain: f.account.primaryDomain, address: 'news@' + f.account.primaryDomain, members: [], moderation: 'members', archiveEnabled: false, selfSubscription: 'open', createdAt: new Date().toISOString() }, foreign])
    const initial = await (await f.sealed.request('/api/webmail/mailing-lists')).json()
    expect(initial.lists).toHaveLength(1); expect(JSON.stringify(initial)).not.toContain(foreign.address)
    const response = await f.sealed.request('/api/webmail/mailing-lists/' + id + '/subscription', 'PUT', { subscribed: true, expectedRevision: initial.lists[0].revision })
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ stateChanged: true, lists: [{ membership: 'subscribed' }], application: { nativeApplied: false } })
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved[0].members).toEqual([f.own.login]); expect(saved[0].memberAuthorities[f.own.login]).toEqual(f.authority(f.own)); expect(saved[1]).toEqual(foreign)
    expect((await f.sealed.request('/api/webmail/mailing-lists/' + id + '/subscription', 'PUT', { subscribed: false, expectedRevision: initial.lists[0].revision })).status).toBe(409)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved)
  })

  it('hides private unbound membership and cannot mutate a foreign account list', async () => {
    const f = await sealedToolsFixture(), path = join(f.state.store.rootDir, 'extended', 'mail', 'mailing-lists.json'), privateId = randomUUID(), foreignId = randomUUID()
    const rows = [{ id: privateId, accountId: f.account.id, name: 'PRIVATE_UNBOUND_MARKER', domain: f.account.primaryDomain, address: 'private@' + f.account.primaryDomain, members: [f.own.login], moderation: 'members', archiveEnabled: false, createdAt: new Date().toISOString() }, { id: foreignId, accountId: f.other.id, name: 'FOREIGN_LIST_MARKER', domain: f.other.primaryDomain, address: 'private@' + f.other.primaryDomain, members: [], moderation: 'open', archiveEnabled: false, selfSubscription: 'open', createdAt: new Date().toISOString() }]
    await atomicWriteJson(path, rows)
    const response = await f.sealed.request('/api/webmail/mailing-lists')
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ lists: [] })
    expect((await f.sealed.request('/api/webmail/mailing-lists/' + foreignId + '/subscription', 'PUT', { subscribed: true, expectedRevision: 'a'.repeat(64) })).status).toBe(404)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(rows)
  })

  it('rechecks sealed session revocation while waiting for the mailbox metadata writer lease', async () => {
    const f = await sealedToolsFixture(), first = await (await f.sealed.request('/api/webmail/spam-preferences')).json(), lock = f.state.store.getWriterLock(), acquire = lock.acquire.bind(lock)
    vi.spyOn(lock, 'acquire').mockImplementationOnce(async (...args) => { await db.revokeSession(f.database.db, f.sealed.record.id); return acquire(...args) })
    expect((await f.sealed.request('/api/webmail/spam-preferences', 'PUT', { ...spamFields, expectedRevision: first.revision })).status).toBe(401)
    expect(f.hostCalls).toHaveLength(0)
  })
})
