import { randomUUID } from 'node:crypto'
import { cp } from 'node:fs/promises'
import { sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultPlan, type Account, type Domain, type PhpSettings, type WebsiteAnalyticsSnapshot } from '@xpanel/core'
import { createSession, createTestDb, createUserPrincipal, type PrincipalRecord, type Row, type TestDbHandle } from '@xpanel/db'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { SESSION_COOKIE_NAME, sha256Hex } from './auth.ts'
import { createDefaultWebRenderer } from './main.ts'

const capture = vi.hoisted(() => ({ states: [] as Record<string, unknown>[] }))
// Observe the production hydration boundary and then run the real document
// renderer, preserving its response status and normal presentation behavior.
vi.mock('../../web/src/index.ts', async importOriginal => {
  const web = await importOriginal<typeof import('../../web/src/index.ts')>()
  return { ...web, serveWebUi: async (...args: Parameters<typeof web.serveWebUi>) => {
    const [request, provider] = args
    if (!provider) return web.serveWebUi(request)
    const state = await provider(new URL(request.url), request)
    capture.states.push(state as unknown as Record<string, unknown>)
    return web.serveWebUi(request, () => state)
  } }
})
// Synthetic qualification reaches the SSR selection boundary only. These tests
// do not create a host executor or claim native analytics qualification.
vi.mock('./host-catalog.ts', async () => {
  const { tools } = await import('@xpanel/catalog')
  return { loadQualifiedCatalog: async () => tools.map(tool => ({ ...tool, status: 'verified' as const,
    delivery: { ...tool.delivery, status: 'verified' as const, reason: 'Synthetic SSR traffic selection fixture only.' },
  })) }
})

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'website-traffic-selection-fixture-secret'
const AGENT_TOKEN = 'a'.repeat(64)
const PRIMARY_NAME = 'owner-traffic.example.test'
const ADDON_NAME = 'addon.owner-traffic.example.test'
const FOREIGN_NAME = 'other-traffic.example.test'
const php: PhpSettings = { version: '8.3', handler: 'fpm',
  fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
let database: TestDbHandle, baseline: TestStateStoreHandle
let account: Account, other: Account, primary: Domain, addon: Domain, foreign: Domain, principal: PrincipalRecord
let principalSnapshot: Row[], auditSnapshot: Row[]

beforeAll(async () => {
  database = await createTestDb()
  baseline = await createTestStateStore()
  const feature = await baseline.store.createFeatureList({ name: 'Traffic selection fixture', ownerId: null, disabled: [] })
  const defaults = defaultPlan({ featureListId: feature.id, name: 'Traffic selection fixture' })
  const plan = await baseline.store.createPlan({ name: defaults.name, featureListId: feature.id, ownerId: null,
    resources: defaults.resources, caps: defaults.caps, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: defaults.defaultMailboxQuotaMb })
  await baseline.store.saveServerIp({ address: '192.0.2.77', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared',
    ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const makeAccount = (username: string, primaryDomain: string) => baseline.store.createAccount({ username, primaryDomain,
    passwordHash: HASH, planId: plan.id, ownerId: null, contactEmail: username + '@example.test', ipv4: '192.0.2.77', shell: 'none', php })
  account = await makeAccount('trafficowner', PRIMARY_NAME)
  other = await makeAccount('trafficother', FOREIGN_NAME)
  addon = await baseline.store.createDomain({ accountId: account.id, name: ADDON_NAME, kind: 'addon', parentId: null,
    docRoot: account.home + '/addon', siteType: 'php', upstream: null, redirect: null, php, wildcard: false,
    certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' })
  primary = (await baseline.store.listDomains({ accountId: account.id })).find(domain => domain.kind === 'primary')!
  foreign = (await baseline.store.listDomains({ accountId: other.id })).find(domain => domain.kind === 'primary')!
  if (!primary || !foreign) throw new Error('Traffic fixture is missing a primary domain')
  principal = await createUserPrincipal(database.db, { username: account.username, accountId: account.id, passwordHash: HASH })
  principalSnapshot = await database.db.query('SELECT * FROM principals ORDER BY id')
  auditSnapshot = await database.db.query('SELECT * FROM audit_log ORDER BY id')
})
afterAll(async () => {
  try { await database?.close() }
  finally { await baseline?.close() }
})

interface Fixture { state: TestStateStoreHandle; cookie: string }
/** One prepared state snapshot; actual session creation/touches reset in one SQL transaction per case. */
async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const state = await createTestStateStore()
  capture.states.length = 0
  try {
    const mutex = baseline.store.getWriterLock().mutexFilePath
    const lockDirectory = baseline.store.getWriterLock().lockDirPath
    await cp(baseline.rootDir, state.rootDir, { recursive: true, filter: source =>
      source !== mutex && !source.startsWith(mutex + '-') && source !== lockDirectory && !source.startsWith(lockDirectory + sep),
    })
    expect(await database.db.query('SELECT id FROM sessions')).toEqual([])
    const raw = 'traffic-selection-session-' + randomUUID()
    await createSession(database.db, { principalId: principal.id, tokenHash: sha256Hex(raw), mfaVerified: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString() })
    await run({ state, cookie: `${SESSION_COOKIE_NAME}=${raw}` })
  } finally {
    try {
      // HTTP executes outside this transaction: its state guard must precede SQL.
      // Reset the actual session row, never a symbolic empty transaction.
      await database.db.transaction(async db => {
        expect((await db.query('SELECT id FROM sessions')).length).toBe(1)
        await db.query('DELETE FROM sessions')
        expect(await db.query('SELECT id FROM sessions')).toEqual([])
        expect(await db.query('SELECT * FROM principals ORDER BY id')).toEqual(principalSnapshot)
        expect(await db.query('SELECT * FROM audit_log ORDER BY id')).toEqual(auditSnapshot)
        expect(await db.query('PRAGMA foreign_key_check')).toEqual([])
      })
    } finally { await state.close(); capture.states.length = 0 }
  }
}

const observation = (domain: Domain = addon, overrides: Partial<WebsiteAnalyticsSnapshot> = {}): WebsiteAnalyticsSnapshot => ({
  domain: domain.name, accountId: domain.accountId, at: '2026-10-29T18:00:00.000Z',
  totals: { requests: 12, bytes: 1200, uniqueVisitors: 3, cacheHitRatioPercent: 50, errorRatePercent: 0,
    avgRequestTimeMs: 10, p95RequestTimeMs: 20, avgUpstreamTimeMs: 5, status2xx: 12, status3xx: 0, status4xx: 0, status5xx: 0 },
  series: [{ at: '2026-10-29T18:00:00.000Z', requests: 12, bytes: 1200, status2xx: 12, status3xx: 0, status4xx: 0, status5xx: 0,
    cacheHit: 6, cacheMiss: 6, cacheBypass: 0, avgRequestTimeMs: 10, p95RequestTimeMs: 20, avgUpstreamTimeMs: 5 }],
  topPaths: [{ key: '/owned-addon', requests: 12, bytes: 1200, errors5xx: 0 }], topReferrers: [], topClientIps: [],
  ...overrides,
})

async function renderer(fixture: Fixture, calls: Request[], payload: unknown = observation(), status = 200) {
  return createDefaultWebRenderer({ db: database.db, store: fixture.state.store, serverSecret: SECRET,
    agent: { token: AGENT_TOKEN, fetch: async request => {
      calls.push(request)
      if (!new URL(request.url).pathname.startsWith('/analytics/websites/')) return new Response('{}', { status: 404 })
      return Response.json(payload, { status })
    } },
  })
}
const request = (fixture: Fixture, path: string) => new Request('http://localhost' + path, { headers: { cookie: fixture.cookie } })
const lastState = (): Record<string, unknown> => {
  const state = capture.states.at(-1)
  if (!state) throw new Error('No document render state was captured')
  return state
}
const lastPanel = (): Record<string, unknown> => {
  const panel = lastState().panel
  if (!panel || typeof panel !== 'object') throw new Error('No panel render state was captured')
  return panel as Record<string, unknown>
}

describe('owned website traffic selection at the production document boundary', () => {
  it.each([
    ['/metrics/traffic', '7d', ADDON_NAME.toUpperCase()],
    ['/metrics/web-stats', '30d', ADDON_NAME],
  ] as const)('selects the owned addon on %s with the exact %s agent request', { tags: ['feature'] }, (route, window, selected) => withFixture(async fixture => {
    const calls: Request[] = [], snapshot = observation()
    const render = await renderer(fixture, calls, snapshot)
    const response = await render(request(fixture, `${route}?domain=${encodeURIComponent(selected)}&window=${window}`))
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`http://agent.local/analytics/websites/${addon.id}?window=${window}`)
    expect(calls[0]!.headers.get('x-xpanel-agent-token')).toBe(AGENT_TOKEN)
    expect(calls[0]!.headers.get('x-xpanel-principal-id')).toBe(principal.id)
    expect(lastPanel()).toMatchObject({ activeDomain: addon.name, websiteAnalyticsWindow: window,
      websiteAnalyticsDomainSelectionAvailable: true, websiteAnalytics: snapshot })
    expect(lastPanel()).not.toHaveProperty('websiteAnalyticsUnavailable')
    expect((lastPanel().domains as Domain[]).every(domain => domain.accountId === account.id)).toBe(true)
  }))

  it('refuses another account\'s real domain before any agent read or foreign-state disclosure', { tags: ['feature'] }, () => withFixture(async fixture => {
    const calls: Request[] = []
    const render = await renderer(fixture, calls)
    const response = await render(request(fixture, '/metrics/traffic?domain=' + encodeURIComponent(foreign.name)))
    expect(response.status).toBe(404)
    expect(lastState()).toMatchObject({ error: { status: 404 } })
    expect(calls).toEqual([])
    const props = JSON.stringify(lastState())
    for (const value of [foreign.id, foreign.name, other.id]) expect(props).not.toContain(value)
    expect(lastState()).not.toHaveProperty('panel')
  }))

  it.each([
    'domain=',
    'domain=invalid%2Fname',
    'domain=https%3A%2F%2Fowner-traffic.example.test',
    `domain=${ADDON_NAME}&domain=${ADDON_NAME}`,
  ])('rejects invalid or duplicate domain selectors before an observation: %s', { tags: ['feature'] }, selector => withFixture(async fixture => {
    const calls: Request[] = []
    const render = await renderer(fixture, calls)
    const response = await render(request(fixture, '/metrics/traffic?' + selector))
    expect(response.status).toBe(400)
    expect(lastState()).toMatchObject({ error: { status: 400 } })
    expect(calls).toEqual([])
    expect(lastState()).not.toHaveProperty('panel')
  }))

  it.each(['', '?window=unsupported'])('uses the owned primary and the existing 24h default when no domain is supplied: %s', { tags: ['feature'] }, query => withFixture(async fixture => {
    const calls: Request[] = [], snapshot = observation(primary)
    const render = await renderer(fixture, calls, snapshot)
    expect((await render(request(fixture, '/metrics/traffic' + query))).status).toBe(200)
    expect(calls.map(call => call.url)).toEqual([`http://agent.local/analytics/websites/${primary.id}?window=24h`])
    expect(lastPanel()).toMatchObject({ activeDomain: primary.name, websiteAnalyticsWindow: '24h',
      websiteAnalyticsDomainSelectionAvailable: true, websiteAnalytics: snapshot })
  }))

  it('keeps the selected addon and window explicit when the agent read fails', { tags: ['feature'] }, () => withFixture(async fixture => {
    const calls: Request[] = []
    const render = await renderer(fixture, calls, { error: 'synthetic observation unavailable' }, 503)
    expect((await render(request(fixture, `/metrics/web-stats?domain=${ADDON_NAME}&window=7d`))).status).toBe(200)
    expect(calls.map(call => call.url)).toEqual([`http://agent.local/analytics/websites/${addon.id}?window=7d`])
    expect(lastPanel()).toMatchObject({ activeDomain: addon.name, websiteAnalyticsWindow: '7d',
      websiteAnalyticsDomainSelectionAvailable: true, websiteAnalyticsUnavailable: true })
    expect(lastPanel()).not.toHaveProperty('websiteAnalytics')
  }))

  it.each(['domain', 'accountId'] as const)('drops a response with a foreign %s while preserving the requested owned selection', { tags: ['feature'] }, key => withFixture(async fixture => {
    const calls: Request[] = []
    const payload = observation(addon, key === 'domain' ? { domain: foreign.name } : { accountId: other.id })
    const render = await renderer(fixture, calls, payload)
    expect((await render(request(fixture, `/metrics/traffic?domain=${ADDON_NAME}&window=30d`))).status).toBe(200)
    expect(calls.map(call => call.url)).toEqual([`http://agent.local/analytics/websites/${addon.id}?window=30d`])
    expect(lastPanel()).toMatchObject({ activeDomain: addon.name, websiteAnalyticsWindow: '30d',
      websiteAnalyticsDomainSelectionAvailable: true, websiteAnalyticsUnavailable: true })
    expect(lastPanel()).not.toHaveProperty('websiteAnalytics')
    expect(JSON.stringify(lastPanel())).not.toContain(foreign.name)
    expect(JSON.stringify(lastPanel())).not.toContain(other.id)
  }))
})
