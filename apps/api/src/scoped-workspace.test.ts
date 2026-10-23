import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as catalog from '@xpanel/catalog'
import type { CatalogTool } from '@xpanel/catalog'
import { createTestDb, createRootPrincipal, createUserPrincipal, createResellerPrincipal, createSession, revokeSession, setTotpSecret } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { createDefaultWebRenderer } from './main.ts'
import { createApiApp, INGRESS_SECRET_HEADER, listenApiServer } from './server.ts'
import { sessionCookieName, sessionTokenHash, type EntryPoint } from './entry-points.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'synthetic-scoped-renderer-secret-at-least-32-bytes'
const INGRESS = 'synthetic-scoped-renderer-ingress-at-least-32-bytes'
const profiles: EntryPoint[] = ['xpanel', 'xwhm', 'xmail']
const origins = { xpanel: 'https://panel.example.test:2083', xwhm: 'https://whm.example.test:2087', xmail: 'https://mail.example.test:2096' }
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

const fixture = async () => {
  const database = await createTestDb()
  const state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const feature = await state.store.createFeatureList({ name: 'Scoped features', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Scoped plan', ownerId: null, featureListId: feature.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  const input = { passwordHash: HASH, planId: plan.id, ownerId: null, contactEmail: 'private-scoped-contact@example.test', ipv4: '192.0.2.10', shell: 'none' as const,
    php: { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
  }
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = await state.store.createAccount({ ...input, username: 'owner7', primaryDomain: 'owner7.example.test' })
  const other = await state.store.createAccount({ ...input, username: 'other7', primaryDomain: 'private-other-scoped.example.test' })
  const owner = await createUserPrincipal(database.db, { username: account.username, accountId: account.id, passwordHash: HASH })
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  await setTotpSecret(database.db, root.id, new Uint8Array(32))
  const reseller = await state.store.createReseller({ username: 'reseller7', passwordHash: HASH, acl: ['list-accounts'], maxAccounts: 10, totalDiskMb: 10000, totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [] })
  const resellerPrincipal = await createResellerPrincipal(database.db, { id: reseller.id, username: reseller.username, passwordHash: HASH })
  const sessions = new Map<EntryPoint, { cookie: string; id: string }>()
  const servers = new Map<EntryPoint, Awaited<ReturnType<typeof listenApiServer>>>()
  const session = async (profile: EntryPoint, principalId: string) => {
    const token = randomUUID()
    const record = await createSession(database.db, { principalId, tokenHash: sessionTokenHash(token, profile), mfaVerified: true, expiresAt: new Date(Date.now() + 60_000).toISOString() })
    return { cookie: sessionCookieName(profile, true) + '=' + token, id: record.id }
  }
  for (const profile of profiles) {
    sessions.set(profile, await session(profile, profile === 'xwhm' ? root.id : owner.id))
    const renderer = await createDefaultWebRenderer({ store: state.store, db: database.db, serverSecret: SECRET, entryPoint: profile })
    const app = createApiApp({ db: database.db, store: state.store, webRenderer: renderer, serverSecret: SECRET, entryPoint: profile, publicOrigin: origins[profile], allowedOrigins: [origins[profile]], ingressSecret: INGRESS, requireSecureCookies: true, requireOriginHeader: true })
    const server = await listenApiServer(app, { host: '127.0.0.1', port: 0 })
    servers.set(profile, server)
    cleanup.push(() => { server.server.closeAllConnections(); return server.close() })
  }
  const request = (profile: EntryPoint, path: string, cookie = sessions.get(profile)!.cookie, method = 'GET', body?: unknown): Promise<Response> => new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port: servers.get(profile)!.port, path, method,
      headers: { host: new URL(origins[profile]).host, origin: origins[profile], ...(body !== undefined ? { 'content-type': 'application/json' } : {}), [INGRESS_SECRET_HEADER]: INGRESS, 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.20', ...(cookie ? { cookie } : {}) },
    }, incoming => {
      const chunks: Buffer[] = []
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
      incoming.once('error', reject)
      incoming.once('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: incoming.headers as Record<string, string> })))
    })
    outgoing.once('error', reject)
    outgoing.end(body !== undefined ? JSON.stringify(body) : undefined)
  })
  return { database, state, feature, plan, account, other, owner, root, reseller, resellerPrincipal, sessions, session, request }
}

describe('authenticated bounded workspace HTTP reads', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })

  it('serves actual owner summary and root identity without a full state snapshot', async () => {
    const snapshot = vi.spyOn(f.state.store, 'readSnapshot').mockRejectedValue(new Error('Unexpected global read'))
    const panel = await f.request('xpanel', '/panel')
    expect(panel.status).toBe(200)
    const html = await panel.text()
    for (const value of [f.account.username, f.account.primaryDomain, f.plan.name, f.account.home, f.account.ipv4]) expect(html).toContain(value)
    for (const value of [f.account.id, f.other.primaryDomain, f.account.contactEmail, HASH]) expect(html).not.toContain(value)
    expect(html).toContain('data-board-port="xpanel-home"')
    expect(html).toContain('data-action="logout"')
    expect(html).not.toContain('data-tool-availability="unverified"')
    const whm = await f.request('xwhm', '/whm')
    expect(whm.status).toBe(200)
    expect(await whm.text()).not.toContain(f.account.primaryDomain)
    expect((await f.request('xmail', '/mail/inbox')).status).toBe(200)
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('does not scan unrelated account files for normal identity and workspace requests', async () => {
    const path = join(f.state.store.rootDir, 'accounts', 'unrelated7')
    await mkdir(path)
    await writeFile(join(path, 'account.json'), '{corrupt unrelated synthetic state')
    expect((await f.request('xpanel', '/api/auth/me')).status).toBe(200)
    expect((await f.request('xpanel', '/panel')).status).toBe(200)
    expect((await f.request('xwhm', '/whm')).status).toBe(200)
  })

  it.each(['alias7', 'other7'])('retains accountId authority during real password login with trusted hint %s', async username => {
    await createUserPrincipal(f.database.db, { username, accountId: f.account.id, passwordHash: HASH })
    const login = await f.request('xpanel', '/api/auth/login', '', 'POST', { username, password: 'correct horse battery staple' })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    expect((await f.request('xpanel', '/api/auth/me', cookie)).status).toBe(200)
    const response = await f.request('xpanel', '/panel', cookie)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain(f.account.primaryDomain)
    expect(html).not.toContain(f.other.primaryDomain)
  })

  it('never selects another account from query parameters or a misleading username hint', async () => {
    expect((await f.request('xpanel', '/panel?accountId=' + f.other.id + '&username=' + f.other.username)).status).toBe(404)
    expect((await f.request('xpanel', '/panel?accountId=' + randomUUID())).status).toBe(404)
    expect((await f.request('xpanel', '/panel?username=../../outside')).status).toBe(200)
    expect((await f.request('xpanel', '/panel?accountId=' + f.account.id)).status).toBe(200)
    const misleading = await createUserPrincipal(f.database.db, { username: 'different7', accountId: f.other.id, passwordHash: HASH })
    const session = await f.session('xpanel', misleading.id)
    const response = await f.request('xpanel', '/panel', session.cookie)
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain(f.other.primaryDomain)
    expect(html).not.toContain(f.account.primaryDomain)
  })

  it('observes suspension immediately while preserving me and logout recovery policy', async () => {
    expect((await f.request('xpanel', '/panel')).status).toBe(200)
    await f.state.store.suspendAccount(f.account.id, 'Scoped fixture suspension')
    expect((await f.request('xpanel', '/panel')).status).toBe(403)
    expect((await f.request('xmail', '/mail/inbox')).status).toBe(403)
    expect((await f.request('xpanel', '/api/auth/me')).status).toBe(200)
    await f.state.store.unsuspendAccount(f.account.id)
    expect((await f.request('xpanel', '/panel')).status).toBe(200)
  })

  it('does not cache sessions after revocation', async () => {
    expect((await f.request('xpanel', '/panel')).status).toBe(200)
    await revokeSession(f.database.db, f.sessions.get('xpanel')!.id)
    const snapshot = vi.spyOn(f.state.store, 'readAccountWorkspace')
    expect((await f.request('xpanel', '/panel')).status).toBe(303)
    expect((await f.request('xpanel', '/api/auth/me')).status).toBe(401)
    expect(snapshot).not.toHaveBeenCalled()
  })

  it.each(['missing-plan', 'wrong-plan-id', 'missing-features', 'wrong-feature-id'] as const)('fails closed on %s', async condition => {
    const path = condition.includes('plan') ? join(f.state.store.rootDir, 'plans', f.plan.id + '.json') : join(f.state.store.rootDir, 'feature-lists', f.feature.id + '.json')
    if (condition.startsWith('missing')) await rm(path)
    else { const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; await writeFile(path, JSON.stringify({ ...value, id: randomUUID() })) }
    expect((await f.request('xpanel', '/panel')).status).toBe(403)
    expect((await f.request('xmail', '/mail/inbox')).status).toBe(403)
  })

  it('rechecks reseller ACLs before an identity-only response', async () => {
    const session = await f.session('xwhm', f.resellerPrincipal.id)
    expect((await f.request('xwhm', '/whm', session.cookie)).status).toBe(200)
    await f.state.store.updateReseller(f.reseller.id, { acl: [] })
    expect((await f.request('xwhm', '/whm', session.cookie)).status).toBe(403)
  })

  it('keeps the full-snapshot path when the fixture qualifies a real route and rechecks changed feature visibility', async () => {
    const actualNavigation = catalog.visibleNavigation
    const qualified: CatalogTool[] = catalog.tools.map(tool => tool.status === 'out-of-scope' ? tool : ({ ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Synthetic qualified-branch regression only.', evidence: [] } }))
    vi.spyOn(catalog, 'visibleNavigation').mockImplementation(ctx => actualNavigation(ctx, qualified))
    const page = catalog.navigation.find(surface => surface.surface === 'xpanel')!.sections.flatMap(section => section.pages).find(page => page.route === '/files/manager')!
    const featureKey = qualified.find(tool => tool.id === page.tools[0])!.featureKey!
    expect(featureKey).toBeTruthy()
    const originalSnapshot = f.state.store.readSnapshot.bind(f.state.store)
    const snapshot = vi.spyOn(f.state.store, 'readSnapshot').mockImplementationOnce(async () => {
      await f.state.store.updateFeatureList(f.feature.id, { disabled: [featureKey] })
      return originalSnapshot()
    })
    const response = await f.request('xpanel', '/panel/files/manager')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('data-tool-availability="unverified"')
    expect(snapshot).toHaveBeenCalledTimes(1)
  })

  it('rechecks account status from the full snapshot after the route qualification decision', async () => {
    const actualNavigation = catalog.visibleNavigation
    const qualified: CatalogTool[] = catalog.tools.map(tool => tool.status === 'out-of-scope' ? tool : ({ ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Synthetic qualified-branch regression only.', evidence: [] } }))
    vi.spyOn(catalog, 'visibleNavigation').mockImplementation(ctx => actualNavigation(ctx, qualified))
    const originalSnapshot = f.state.store.readSnapshot.bind(f.state.store)
    vi.spyOn(f.state.store, 'readSnapshot').mockImplementationOnce(async () => {
      await f.state.store.suspendAccount(f.account.id, 'Intervening state mutation')
      return originalSnapshot()
    })
    expect((await f.request('xpanel', '/panel/files/manager')).status).toBe(403)
  })
})
