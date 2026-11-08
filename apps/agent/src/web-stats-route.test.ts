import { describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import type { AgentCallerIdentity } from './server.ts'
import type { WebStats } from './web-stats.ts'
import { handleWebStatsHostRoute, handleWebStatsRoute } from './web-stats-route.ts'
import { defaultWebStatsPolicy } from './web-stats-config.ts'
import type { WebStatsConfig } from './web-stats-config.ts'

const ACCOUNT = '0f8c9a52-6c55-4a43-9f1e-3b2a1c4d5e6f'
const account = { id: ACCOUNT, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', primaryDomain: 'alice.test', status: 'active', planId: 'basic' } as Account
const domain = (id: string, name: string): Domain => ({ id, accountId: ACCOUNT, name, kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3' }, wildcard: false, suspended: false } as Domain)
const caller: AgentCallerIdentity = { principalId: 'p1', actor: 'alice', role: 'user', accountId: ACCOUNT, resellerId: null }
const month = { month: '2026-11', lastUpdate: null, visits: 3, unique: 2, pages: 2, hits: 2, bytes: 20, days: [], hours: [], countries: [], os: [], browsers: [], status: [], urls: [], referrers: [], robots: [] }
const stats = (webalizer: string | null = '/usr/bin/webalizer', config: WebStatsConfig | null = { policy: defaultWebStatsPolicy(), choices: { [ACCOUNT]: { 'shop.test': ['webalizer'] } }, resellerLocks: {} }) => ({
  config: async () => config, processNow: (id: string) => id === ACCOUNT,
  reports: async () => ({ accountId: ACCOUNT, updatedAt: '2026-11-07T12:00:00.000Z', sites: { 'alice.test': { http: { awstats: { state: 'updated', at: '2026-11-07T12:00:00.000Z' }, webalizer: null, droppedLines: 0, lostBytes: 0, months: { '2026-11': month } } } } }),
  status: async () => ({ lastRunAt: '2026-11-07T12:00:00.000Z', nextRunAt: '2026-11-08T12:00:00.000Z', running: false, accounts: { [ACCOUNT]: '2026-11-05T12:00:00.000Z' }, spools: { [`${ACCOUNT}/alice.test/http`]: { bytes: 80, dropped: 1, lostBytes: 0, months: ['2026-11'] } } }),
  engines: () => ({ awstats: '/usr/lib/cgi-bin/awstats.pl', webalizer }),
  geoipStatus: async () => ({ installed: true, month: '2026-11', sha256: 'a'.repeat(64), installedAt: '2026-11-02T00:00:00.000Z' }),
  readWebalizerFile: async (_: Account, site: string, scheme: string, file: string) => site === 'alice.test' && scheme === 'https' && file === 'index.html' ? Buffer.from('<html>') : null,
}) as unknown as WebStats
const deps = (over: { disabled?: string[]; caller?: AgentCallerIdentity; stats?: WebStats | null } = {}) => ({
  caller: over.caller ?? caller,
  store: { getAccountByUsername: async (name: string) => name === 'alice' ? account : null, listDomains: async () => [domain('d1', 'alice.test'), domain('d2', 'shop.test')],
    getPlan: async () => ({ id: 'basic', featureListId: 'f' } as Plan), getFeatureList: async () => ({ id: 'f', name: 'f', ownerId: null, disabled: over.disabled ?? [] } as FeatureList) },
  currentPrincipal: async () => ({ kind: 'user', id: 'p1', username: 'alice', accountId: ACCOUNT, disabled: false }),
  stats: over.stats === undefined ? stats() : over.stats, now: () => new Date('2026-11-07T13:00:00Z'),
})
const get = async (path: string, d = deps()): Promise<Response> => {
  const url = new URL('http://agent.local' + path)
  try { return (await handleWebStatsRoute(new Request(url), url, 'GET', d))! } catch (error) { if (isXpanelError(error)) return new Response(error.code, { status: error.status }); throw error }
}

const json = async (response: Response): Promise<any> => response.json()

describe('agent web statistics route', () => {
  it('lists the owner sites with both schemes and the selected AWStats month', async () => {
    const response = await get('/accounts/alice/web-stats?site=alice.test&scheme=http&month=2026-11')
    expect(response.status).toBe(200)
    const view = await json(response)
    expect(view.sites.map((s: { site: string }) => s.site)).toEqual(['alice.test', 'shop.test'])
    expect(view.sites[0].schemes.http).toMatchObject({ awstats: { state: 'updated' }, pendingBytes: 80, droppedLines: 1 })
    expect(view.sites[1].schemes.https).toMatchObject({ awstats: null, webalizer: null })
    expect(view.months).toEqual([{ month: '2026-11', visits: 3, unique: 2, pages: 2, hits: 2, bytes: 20, lastUpdate: null }])
    expect(view).toMatchObject({ selection: { site: 'alice.test', scheme: 'http', month: '2026-11' }, report: { visits: 3 }, geoip: { installed: true, month: '2026-11' }, engines: { webalizer: { installed: true, entitled: true } }, schedule: { intervalHours: 24 } })
  })

  it('defaults to the first site, this month and the non-SSL entry, and reports a month it has not read as null', async () => {
    const view = await json(await get('/accounts/alice/web-stats'))
    expect(view.selection).toEqual({ site: 'alice.test', scheme: 'http', month: '2026-11' })
    expect((await json(await get('/accounts/alice/web-stats?month=2026-05'))).report).toBeNull()
  })

  it('refuses other callers, other accounts, a plan without either engine and selectors it does not know', async () => {
    expect((await get('/accounts/alice/web-stats', deps({ caller: { ...caller, role: 'root' } as AgentCallerIdentity }))).status).toBe(403)
    expect((await get('/accounts/bob/web-stats')).status).toBe(403)
    expect((await get('/accounts/alice/web-stats', deps({ disabled: ['Awstats', 'web-stats-webalizer'] }))).status).toBe(403)
    expect((await get('/accounts/alice/web-stats?site=other.test')).status).toBe(404)
    for (const query of ['?scheme=ftp', '?month=2026-13', '?path=/etc', '?site=alice.test&site=shop.test']) expect((await get('/accounts/alice/web-stats' + query)).status, query).toBe(400)
  })

  it('serves only named Webalizer files of an owned site, as stored', async () => {
    const response = await get('/accounts/alice/web-stats/webalizer/https/alice.test/index.html')
    expect(await json(response)).toMatchObject({ contentType: 'text/html; charset=utf-8', base64: Buffer.from('<html>').toString('base64'), context: { site: 'alice.test', scheme: 'https', file: 'index.html' } })
    expect((await get('/accounts/alice/web-stats/webalizer/https/alice.test/webalizer.hist')).status).toBe(404)
    expect((await get('/accounts/alice/web-stats/webalizer/https/other.test/index.html')).status).toBe(404)
    expect((await get('/accounts/alice/web-stats/webalizer/http/alice.test/index.html')).status).toBe(404)
    expect((await get('/accounts/alice/web-stats/webalizer/https/alice.test/index.html', deps({ stats: stats(null) }))).status).toBe(412)
    expect((await get('/accounts/alice/web-stats/webalizer/https/alice.test/index.html', deps({ disabled: ['Webalizer'] }))).status).toBe(403)
  })

  it('reports the status of the bandwidth meter, or no reading when it cannot be read', async () => {
    const reading = async (bandwidth: unknown) => (await json(await handleWebStatsHostRoute(new Request('http://agent.local/host/web-stats/status'), new URL('http://agent.local/host/web-stats/status'), 'GET', { assertRoot: async () => undefined, store: { listAccounts: async () => [account], getAccountByUsername: async () => account }, stats: stats(), bandwidth } as never) as Response)).bandwidth
    expect(await reading({ report: async () => ({ updatedAt: '2026-11-07T12:00:00.000Z', pendingBytes: 7 }) })).toEqual({ lastCollectedAt: '2026-11-07T12:00:00.000Z', pendingBytes: 7 })
    expect(await reading({ report: async () => { throw new Error('unreadable') } })).toBeNull()
    expect(await reading(null)).toBeNull()
  })

  it('reports the engines of each site, the choosable engines and the saved interval', async () => {
    const view = await json(await get('/accounts/alice/web-stats'))
    expect(view.sites.map((s: { selected: string[] }) => s.selected)).toEqual([['analog', 'awstats', 'webalizer'], ['webalizer']])
    expect(view.choice.choosable).toEqual(['analog', 'awstats', 'webalizer'])
    expect(view.choice.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(view.schedule.intervalHours).toBe(24)
    const damaged = await json(await get('/accounts/alice/web-stats', deps({ stats: stats('/usr/bin/webalizer', null) })))
    expect(damaged).toMatchObject({ choice: { choosable: [], revision: null }, schedule: { intervalHours: null } })
  })
})

describe('agent web statistics host routes', () => {
  const host = async (path: string, method = 'GET', body?: unknown, over: { stats?: WebStats | null; root?: boolean; status?: string } = {}) => {
    const url = new URL('http://agent.local' + path), request = new Request(url, body === undefined ? { method } : { method, body: JSON.stringify(body) })
    const active = { ...account, status: over.status ?? 'active' } as Account
    const route = handleWebStatsHostRoute(request, url, method, { assertRoot: async action => { if (over.root === false) throw new Error('denied ' + action) }, stats: over.stats === undefined ? stats() : over.stats, bandwidth: null,
      store: { listAccounts: async () => [active], getAccountByUsername: async name => name === 'alice' ? active : null }, now: () => new Date('2026-11-07T13:00:00Z') })
    try { return (await route)! } catch (error) { if (isXpanelError(error)) return new Response(JSON.stringify({ code: error.code, detail: error.detail }), { status: error.status }); throw error }
  }

  it('lists accounts behind schedule with the minutes past the interval', async () => {
    const view = await json(await host('/host/web-stats/status'))
    expect(view).toMatchObject({ engines: { awstats: true, webalizer: true }, geoip: { installed: true, month: '2026-11' }, running: false })
    expect(view.behind).toEqual([{ username: 'alice', minutes: 1500, pendingBytes: 80 }])
    expect((await json(await host('/host/web-stats/status', 'GET', undefined, { status: 'suspended' }))).behind).toEqual([])
  })

  it('starts one saved active account and refuses everything else with a stable reason', async () => {
    const started = await host('/host/web-stats/process', 'POST', { username: 'alice' })
    expect(started.status).toBe(202)
    expect((await host('/host/web-stats/process', 'POST', { username: 'bob' })).status).toBe(404)
    expect((await json(await host('/host/web-stats/process', 'POST', { username: 'alice' }, { status: 'suspended' }))).detail.reason).toBe('web_stats_account_inactive')
    const busy = { ...stats(), processNow: () => false } as unknown as WebStats
    expect((await json(await host('/host/web-stats/process', 'POST', { username: 'alice' }, { stats: busy }))).detail.reason).toBe('web_stats_run_active')
    expect((await json(await host('/host/web-stats/status', 'GET', undefined, { stats: null }))).detail.reason).toBe('web_stats_engine_unavailable')
    expect((await json(await host('/host/web-stats/process', 'POST', { username: 'alice' }, { stats: stats('/usr/bin/webalizer', null) }))).detail.reason).toBe('web_stats_config_review')
  })

  it('requires root, the fixed method and no selectors', async () => {
    await expect(host('/host/web-stats/status', 'GET', undefined, { root: false })).rejects.toThrow('denied statistics.read')
    expect((await host('/host/web-stats/status', 'POST', {})).status).toBe(405)
    expect((await host('/host/web-stats/process')).status).toBe(405)
    expect((await host('/host/web-stats/status?user=alice')).status).toBe(400)
  })
})
