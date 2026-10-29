import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createSession, createTestDb, createUserPrincipal, type TestDbHandle } from '../../../packages/db/src/index.ts'
import { createTestStateStore, type TestStateStoreHandle } from '../../../packages/state/src/index.ts'
import type { Account, Domain, Plan, WebsiteAnalyticsSnapshot } from '@xpanel/core'
import { SESSION_COOKIE_NAME, sha256Hex } from '../../api/src/auth.ts'
import { createDefaultWebRenderer } from '../../api/src/main.ts'

// The hydrated render state is captured before the real web renderer runs, so these
// assertions cover the actual SSR prop plumbing and the rendered truthful states.
const capture = vi.hoisted(() => ({ hydration: [] as Record<string, unknown>[] }))
vi.mock('./index.ts', async importOriginal => {
  const web = await importOriginal<typeof import('./index.ts')>()
  type RenderState = import('./app.ts').WebAppRenderState
  return {
    ...web,
    serveWebUi: async (request: Request, provider?: (url: URL, req: Request) => RenderState | Promise<RenderState>) => {
      if (!provider) return web.serveWebUi(request)
      const data = await provider(new URL(request.url), request)
      capture.hydration.push(data as unknown as Record<string, unknown>)
      return web.serveWebUi(request, () => data)
    },
  }
})
// Qualification is supplied only to reach the production hydration boundary. No host executor is created.
vi.mock('../../api/src/host-catalog.ts', async () => {
  const { tools } = await import('@xpanel/catalog')
  return {
    loadQualifiedCatalog: async () => tools.map(tool => ({
      ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const },
    })),
  }
})

const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SERVER_SECRET = 'resources-traffic-ssr-fixture-secret-only'
const AGENT_TOKEN = randomBytes(32).toString('hex')

interface Workspace {
  database: TestDbHandle
  state: TestStateStoreHandle
  account: Account
  plan: Plan
  primary: Domain
  cookie: string
}

const php = {
  version: '8.3' as const,
  handler: 'fpm' as const,
  fpm: { mode: 'ondemand' as const, maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 },
  ini: {},
}

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  capture.hydration.length = 0
  vi.restoreAllMocks()
})

const makeWorkspace = async (): Promise<Workspace> => {
  const database = await createTestDb()
  const state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const features = await state.store.createFeatureList({ name: 'SSR fixture features', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({
    name: 'SSR fixture plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 5120, bandwidthMbMonth: 51200, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 512, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 },
    dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await state.store.saveServerIp({ address: '192.0.2.77', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = await state.store.createAccount({
    username: 'ssruser', primaryDomain: 'ssr-fixture.example.test', passwordHash: PASSWORD_HASH, planId: plan.id, ownerId: null,
    contactEmail: 'ssr@example.test', ipv4: '192.0.2.77', shell: 'none', php,
  })
  const principal = await createUserPrincipal(database.db, { username: account.username, accountId: account.id, passwordHash: PASSWORD_HASH })
  const token = `ssr-fixture-session-${principal.id}`
  await createSession(database.db, { principalId: principal.id, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 60_000).toISOString(), mfaVerified: true })
  const domains = await state.store.listDomains({ accountId: account.id })
  const primary = domains.find(domain => domain.kind === 'primary') ?? domains[0]
  if (!primary) throw new Error('fixture account has no primary domain')
  return { database, state, account, plan, primary, cookie: `${SESSION_COOKIE_NAME}=${token}` }
}

type AgentReply = { usage?: unknown; analytics?: unknown }

/** A synthetic agent transport only; it records the exact existing read contracts the SSR used. */
const agentFetch = (calls: string[], replies: AgentReply) => async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  calls.push(`${url.pathname}${url.search}`)
  if (url.pathname === '/host/account-usage') {
    return replies.usage === undefined ? new Response('{}', { status: 503 }) : new Response(JSON.stringify(replies.usage))
  }
  if (url.pathname.startsWith('/analytics/websites/')) {
    return replies.analytics === undefined ? new Response('{}', { status: 503 }) : new Response(JSON.stringify(replies.analytics))
  }
  return new Response('{}', { status: 404 })
}

const renderer = async (workspace: Workspace, calls?: string[], replies?: AgentReply) =>
  createDefaultWebRenderer({
    store: workspace.state.store, db: workspace.database.db, serverSecret: SERVER_SECRET,
    ...(calls && replies ? { agent: { fetch: agentFetch(calls, replies), token: AGENT_TOKEN } } : {}),
  })

const get = (workspace: Workspace, path: string) =>
  new Request(`http://localhost${path}`, { headers: { cookie: workspace.cookie } })

const lastPanel = (): Record<string, unknown> => {
  const panel = capture.hydration.at(-1)?.panel
  if (typeof panel !== 'object' || panel === null) throw new Error('no panel hydration was captured')
  return panel as Record<string, unknown>
}

/** Scripts are client code, not rendered observations; strip them before absence assertions. */
const renderedHtml = async (response: Response): Promise<string> =>
  (await response.text()).replace(/<script\b[\s\S]*?<\/script>/g, '')

const usageReply = { phpVersion: '8.3', diskBytes: 1_500_000_000, memoryBytes: 120_000_000, processCount: 4, bandwidth: 'unmeasured', ioEnforced: false }

const trafficSnapshot = (workspace: Workspace, overrides: Partial<WebsiteAnalyticsSnapshot> = {}): WebsiteAnalyticsSnapshot => ({
  domain: workspace.primary.name,
  accountId: workspace.account.id,
  at: '2026-10-26T10:00:00.000Z',
  totals: {
    requests: 900, bytes: 9_000_000, uniqueVisitors: 40, cacheHitRatioPercent: 80, errorRatePercent: 1.5,
    avgRequestTimeMs: 12.5, p95RequestTimeMs: 42.5, avgUpstreamTimeMs: 8.25,
    status2xx: 800, status3xx: 50, status4xx: 36, status5xx: 14,
  },
  series: [
    { at: '2026-10-26T09:00:00.000Z', requests: 400, bytes: 4_000_000, status2xx: 360, status3xx: 20, status4xx: 14, status5xx: 6, cacheHit: 320, cacheMiss: 70, cacheBypass: 10, avgRequestTimeMs: 12, p95RequestTimeMs: 40, avgUpstreamTimeMs: 8 },
    { at: '2026-10-26T10:00:00.000Z', requests: 500, bytes: 5_000_000, status2xx: 440, status3xx: 30, status4xx: 22, status5xx: 8, cacheHit: 400, cacheMiss: 85, cacheBypass: 15, avgRequestTimeMs: 13, p95RequestTimeMs: 45, avgUpstreamTimeMs: 8.5 },
  ],
  topPaths: [{ key: '/index.php', requests: 700, bytes: 7_000_000, errors5xx: 10 }],
  topReferrers: [{ key: 'direct', requests: 600, bytes: 6_000_000, errors5xx: 0 }],
  topClientIps: [{ key: '198.51.100.7', requests: 120, bytes: 1_200_000, errors5xx: 1 }],
  ...overrides,
})

const emptyTrafficSnapshot = (workspace: Workspace): WebsiteAnalyticsSnapshot => trafficSnapshot(workspace, {
  totals: {
    requests: 0, bytes: 0, uniqueVisitors: 0, cacheHitRatioPercent: 0, errorRatePercent: 0,
    avgRequestTimeMs: 0, p95RequestTimeMs: 0, avgUpstreamTimeMs: 0,
    status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0,
  },
  series: [], topPaths: [], topReferrers: [], topClientIps: [],
})

describe('SSR wiring for account resources and traffic analytics', () => {
  it('keeps the shared account-usage contract for the /home dashboard', async () => {
    const workspace = await makeWorkspace()
    const calls: string[] = []
    const render = await renderer(workspace, calls, { usage: usageReply })
    const response = await render(get(workspace, '/home'))
    expect(response.status).toBe(200)
    expect(calls).toEqual([`/host/account-usage?username=${workspace.account.username}`])
    expect(lastPanel().usage).toEqual(usageReply)
  })

  it('passes the existing account-usage observation to /resources and keeps it distinct from stored plan limits', async () => {
    const workspace = await makeWorkspace()
    const calls: string[] = []
    const render = await renderer(workspace, calls, { usage: usageReply })
    const response = await render(get(workspace, '/resources'))
    expect(response.status).toBe(200)
    expect(calls).toEqual([`/host/account-usage?username=${workspace.account.username}`])
    expect(calls.some(call => call.startsWith('/analytics/io'))).toBe(false)
    expect(lastPanel().usage).toEqual(usageReply)
    const html = await response.text()
    expect(html).toContain('data-resource-reading="read"')
    expect(html).toContain('1430.51 MiB')
    expect(html).toContain('Stored plan limit')
    expect(html).toContain('Current reading')
    expect(html).toContain('Not reported by the agent')
    expect(html).not.toContain('Resource measurements are not available yet')
    expect(html).not.toContain('data-resource-metrics="unavailable"')
    expect(html.match(/<h1\b/g)).toHaveLength(1)
  })

  it.each(['en', 'ar'] as const)('keeps /resources explicitly unavailable without an agent observation in %s', async locale => {
    const workspace = await makeWorkspace()
    const render = await renderer(workspace)
    const response = await render(get(workspace, `/resources?lang=${locale}`))
    expect(response.status).toBe(200)
    expect(lastPanel()).not.toHaveProperty('usage')
    const html = await response.text()
    expect(html).toContain('data-resource-metrics="unavailable"')
    expect(html).toContain('data-resource-reading="unread"')
    expect(html).not.toContain('data-resource-reading="read"')
    expect(html).not.toContain('data-resource-state="measured"')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it('drops a failed account-usage reply and nulls unread fields instead of inventing a sample', async () => {
    const workspace = await makeWorkspace()
    const failure = await renderer(workspace, [], {})
    expect((await failure(get(workspace, '/resources'))).status).toBe(200)
    expect(lastPanel()).not.toHaveProperty('usage')
    expect(await (await failure(get(workspace, '/resources'))).text()).toContain('data-resource-metrics="unavailable"')
    for (const malformed of [
      { ...usageReply, bandwidth: 'measured' },
      { ...usageReply, diskBytes: -1 },
      { ...usageReply, memoryBytes: 'unmeasured' },
      { ...usageReply, phpVersion: 'not-a-version' },
    ]) {
      capture.hydration.length = 0
      const render = await renderer(workspace, [], { usage: malformed })
      expect((await render(get(workspace, '/resources'))).status).toBe(200)
      if (malformed.bandwidth !== 'unmeasured') {
        expect(lastPanel()).not.toHaveProperty('usage')
        continue
      }
      const usage = lastPanel().usage as Record<string, unknown>
      expect(usage.bandwidth).toBe('unmeasured')
      expect(usage.ioEnforced).toBe(false)
      if (malformed.diskBytes === -1) expect(usage.diskBytes).toBeNull()
      if (malformed.memoryBytes === 'unmeasured') expect(usage.memoryBytes).toBeNull()
      if (malformed.phpVersion === 'not-a-version') expect(usage.phpVersion).toBeNull()
      expect(usage.processCount).toBe(4)
    }
  })

  it('passes the account-scoped website analytics series to /metrics/traffic', async () => {
    const workspace = await makeWorkspace()
    const calls: string[] = []
    const snapshot = trafficSnapshot(workspace)
    const render = await renderer(workspace, calls, { analytics: snapshot })
    const response = await render(get(workspace, '/metrics/traffic'))
    expect(response.status).toBe(200)
    expect(calls).toEqual([`/analytics/websites/${workspace.primary.id}?window=24h`])
    expect(calls.some(call => call.startsWith('/analytics/io'))).toBe(false)
    expect(lastPanel().websiteAnalytics).toEqual(snapshot)
    expect(lastPanel().websiteAnalyticsWindow).toBe('24h')
    const html = await response.text()
    expect(html).toContain('data-chart-state="loaded"')
    expect(html).toContain('<svg class="xp-chart-svg"')
    expect(html).toContain('data-analytics-range="24h"')
    expect(html).toContain('Range: last 24 hours.')
    expect(html).not.toContain('data-screen="unavailable"')
    const range = await render(get(workspace, '/metrics/traffic?window=7d'))
    expect(range.status).toBe(200)
    expect(calls.at(-1)).toBe(`/analytics/websites/${workspace.primary.id}?window=7d`)
    expect(await range.text()).toContain('Range: last 7 days.')
  })

  it('renders an explicit empty traffic state with no synthetic series points', async () => {
    const workspace = await makeWorkspace()
    const calls: string[] = []
    const render = await renderer(workspace, calls, { analytics: emptyTrafficSnapshot(workspace) })
    const response = await render(get(workspace, '/metrics/traffic'))
    expect(response.status).toBe(200)
    expect(lastPanel().websiteAnalytics).toEqual(emptyTrafficSnapshot(workspace))
    const html = await renderedHtml(response)
    expect(html).toContain('data-chart-state="empty"')
    expect(html).toContain('data-analytics-empty="true"')
    expect(html).toContain('No traffic rows were observed')
    expect(html).not.toContain('class="xp-chart-svg"')
    expect(html).not.toContain('data-live-kpi="web-requests"')
    expect(html).not.toContain('data-chart-state="loaded"')
  })

  it('keeps /metrics/traffic unavailable when the scoped read fails, returns a foreign domain or is malformed', async () => {
    const workspace = await makeWorkspace()
    const cases: AgentReply[] = [
      {},
      { analytics: trafficSnapshot(workspace, { domain: 'neighbor.example.test' }) },
      { analytics: trafficSnapshot(workspace, { accountId: '10000000-0000-4000-8000-000000000001' }) },
      { analytics: trafficSnapshot(workspace, { totals: { ...trafficSnapshot(workspace).totals, requests: -1 } as never }) },
      { analytics: trafficSnapshot(workspace, { series: [{ at: 'not-a-date' } as never] }) },
    ]
    for (const reply of cases) {
      capture.hydration.length = 0
      const render = await renderer(workspace, [], reply)
      const response = await render(get(workspace, '/metrics/traffic'))
      expect(response.status).toBe(200)
      expect(lastPanel()).not.toHaveProperty('websiteAnalytics')
      expect(lastPanel().websiteAnalyticsUnavailable).toBe(true)
      const html = await renderedHtml(response)
      expect(html).toContain('Website traffic data is unavailable')
      expect(html).not.toContain('class="xp-chart-svg"')
      expect(html).not.toMatch(/data-chart-state="(?:loaded|empty)"/)
    }
  })
})
