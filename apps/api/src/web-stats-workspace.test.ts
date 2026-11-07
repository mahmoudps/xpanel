import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import type { Account, Domain, Plan } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ReadAgent } from './account-ssh-workspace.ts'
import { handleWebStatsServerRoute, handleWebStatsWorkspaceRoute, WEBALIZER_PAGE_CSP } from './web-stats-workspace.ts'
import type { WebStatsPorts } from './web-stats-workspace.ts'
import { policyForRequest } from './authorization.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'
import { handleWebStatsRoute } from '../../agent/src/web-stats-route.ts'
import { WEB_STATS_CONFIG_STATE, defaultWebStatsPolicy, parseWebStatsConfig, webStatsRevision } from '../../agent/src/web-stats-config.ts'
import type { WebStatsConfig } from '../../agent/src/web-stats-config.ts'
import type { WebStats } from '../../agent/src/web-stats.ts'

// The agent route is the actual handler; only the statistics store and the transport are doubles.
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const account = { id: ACCOUNT, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: 'plan', primaryDomain: 'example.test' } as Account
const main = { id: '22222222-2222-4222-8222-222222222222', accountId: ACCOUNT, name: 'example.test', kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3' }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' } as unknown as Domain
const owner = { principal: { kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT }, apiTokenId: null, scopes: [], principalRecord: { forcePasswordChange: false } } as unknown as AuthenticatedCaller
const stats = {
  reports: async () => null, status: async () => ({ lastRunAt: null, nextRunAt: null, running: false, accounts: {}, spools: {} }), geoipStatus: async () => null, config: async () => parseWebStatsConfig(null),
  engines: () => ({ awstats: '/usr/lib/cgi-bin/awstats.pl', webalizer: '/usr/bin/webalizer' }),
  readWebalizerFile: async (_: Account, _site: string, _scheme: string, file: string) => file === 'usage.png' ? Buffer.from([0x89, 0x50, 0x4e, 0x47]) : Buffer.from('<p>report</p>'),
} as unknown as WebStats

function setup(options: { disabled?: string[]; reply?: (value: Record<string, unknown>) => unknown } = {}) {
  const readAgent = vi.fn(async (_caller: AuthenticatedCaller, path: string) => {
    const url = new URL('http://agent.local' + path)
    const response = await handleWebStatsRoute(new Request(url), url, 'GET', { caller: { principalId: 'p-alice', actor: 'alice', role: 'user', accountId: ACCOUNT, resellerId: null }, stats,
      store: { getAccountByUsername: async () => account, listDomains: async () => [main], getPlan: async () => ({ featureListId: 'list' }) as Plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: [] }) },
      currentPrincipal: async () => ({ kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT, disabled: false }), now: () => new Date('2026-11-07T12:00:00.000Z') })
    const value = await response!.json() as Record<string, unknown>
    return options.reply ? options.reply(value) : value
  })
  const store = { getAccount: async (id: string) => id === ACCOUNT ? account : null, getPlan: async () => ({ featureListId: 'list' }), getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: options.disabled ?? [] }) } as unknown as StateStore
  const ports = { store, requireCaller: async () => owner, readAgent: readAgent as unknown as ReadAgent, assertRoot: async () => undefined, emitAudit: async () => undefined, toolQualified: async () => true } as unknown as WebStatsPorts
  const route = async (path: string, method = 'GET'): Promise<Response> => {
    const url = new URL('http://panel.test' + path)
    try { return (await handleWebStatsWorkspaceRoute(new Request(url, { method }), url, method, ports))! } catch (error) { if (isXpanelError(error)) return new Response(error.code, { status: error.status }); throw error }
  }
  return { route, readAgent }
}

describe('web statistics workspace', () => {
  it('passes only the known selectors to the agent and returns the owner view', async () => {
    const t = setup(), body = await (await t.route('/api/account/web-stats?site=example.test&scheme=https&month=2026-10')).json()
    expect(t.readAgent.mock.calls[0]![1]).toBe('/accounts/alice/web-stats?site=example.test&scheme=https&month=2026-10')
    expect(body).toMatchObject({ context: { accountId: ACCOUNT, username: 'alice' }, selection: { site: 'example.test', scheme: 'https', month: '2026-10' }, report: null, sites: [{ site: 'example.test' }] })
    expect((await t.route('/api/account/web-stats?path=/etc')).status).toBe(400)
    expect((await t.route('/api/account/web-stats', 'POST')).status).toBe(405)
  })

  it('refuses a reply that belongs to another account or is malformed', async () => {
    const foreign = setup({ reply: value => ({ ...value, context: { accountId: 'other', username: 'bob' } }) })
    expect((await foreign.route('/api/account/web-stats')).status).toBe(503)
    const malformed = setup({ reply: value => ({ ...value, months: [{ month: '2026-13' }] }) })
    expect((await malformed.route('/api/account/web-stats')).status).toBe(503)
  })

  it('serves Webalizer pages as sandboxed documents and their graphs as images', async () => {
    const t = setup()
    const page = await t.route('/api/account/web-stats/webalizer/https/example.test/index.html')
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('content-security-policy')).toBe(WEBALIZER_PAGE_CSP)
    expect(WEBALIZER_PAGE_CSP).toMatch(/^sandbox allow-same-origin; default-src 'none'/)
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await page.text()).toBe('<p>report</p>')
    const image = await t.route('/api/account/web-stats/webalizer/http/example.test/usage.png')
    expect(image.headers.get('content-type')).toBe('image/png')
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect((await setup({ disabled: ['Webalizer'] }).route('/api/account/web-stats/webalizer/http/example.test/index.html')).status).toBe(403)
    expect((await t.route('/api/account/web-stats/webalizer/http/example.test/index.html?x=1')).status).toBe(400)
  })

  it('is admitted on the xPanel listener only, for GET', () => {
    expect(entryPointAllowsApiRoute('xpanel', '/api/account/web-stats', 'GET')).toBe(true)
    expect(entryPointAllowsApiRoute('xpanel', '/api/account/web-stats/webalizer/https/example.test/usage_202611.html', 'GET')).toBe(true)
    expect(entryPointAllowsApiRoute('xpanel', '/api/account/web-stats', 'PUT')).toBe(true)
    expect(entryPointAllowsApiRoute('xpanel', '/api/account/web-stats', 'POST')).toBe(false)
    expect(entryPointAllowsApiRoute('xwhm', '/api/account/web-stats', 'GET')).toBe(false)
    for (const [path, method] of [['/api/server/web-stats', 'GET'], ['/api/server/web-stats', 'PUT'], ['/api/server/web-stats/process', 'POST']] as const) {
      expect(entryPointAllowsApiRoute('xwhm', path, method)).toBe(true)
      expect(entryPointAllowsApiRoute('xpanel', path, method)).toBe(false)
    }
  })

  it('declares an authorization policy for every statistics route', () => {
    expect(policyForRequest('/api/account/web-stats', 'GET')).toMatchObject({ resource: 'analytics', acl: 'list-accounts', toolIds: [] })
    expect(policyForRequest('/api/account/web-stats', 'PUT')).toMatchObject({ resource: 'analytics', acl: 'edit-account', toolIds: ['metrics-editor'] })
    expect(policyForRequest('/api/account/web-stats/webalizer/http/example.test/index.html', 'GET')).toMatchObject({ toolIds: ['web-stats-webalizer'] })
    for (const [path, method] of [['/api/server/web-stats', 'GET'], ['/api/server/web-stats', 'PUT'], ['/api/server/web-stats/process', 'POST']] as const) expect(policyForRequest(path, method)).toMatchObject({ resource: 'server', rootOnly: true })
  })
})

describe('saved statistics configuration', () => {
  const roots: string[] = []
  afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }) })
  const root = { principal: { kind: 'root', id: 'p-root', username: 'root' }, apiTokenId: null, scopes: [], principalRecord: { forcePasswordChange: false } } as unknown as AuthenticatedCaller
  const setup = async (options: { caller?: AuthenticatedCaller; saved?: WebStatsConfig; qualified?: boolean; agent?: (path: string, input?: unknown) => unknown; acl?: string[]; account?: Account } = {}) => {
    const rootDir = await mkdtemp(join(tmpdir(), 'xpanel-web-stats-api-')), path = join(rootDir, WEB_STATS_CONFIG_STATE), audit = vi.fn(async () => undefined)
    roots.push(rootDir)
    if (options.saved) { await mkdir(join(rootDir, 'extended/server'), { recursive: true }); await writeFile(path, JSON.stringify(options.saved)) }
    const store = { rootDir, getReseller: async (id: string) => ({ id, acl: options.acl ?? ['edit-account'] }), getAccount: async (id: string) => id === ACCOUNT ? options.account ?? account : null, getPlan: async () => ({ featureListId: 'list' }), getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: [] }), listDomains: async () => [main],
      getWriterLock: () => ({ acquire: async () => ({ assertFencingToken: async () => undefined, release: async () => undefined }) }) }
    const ports = { store, requireCaller: async () => options.caller ?? owner, assertRoot: async () => undefined, emitAudit: audit, toolQualified: async () => options.qualified ?? true,
      readAgent: vi.fn(async (_: AuthenticatedCaller, agentPath: string, input?: unknown) => options.agent?.(agentPath, input)) } as unknown as WebStatsPorts
    const send = async (route: 'owner' | 'server', target: string, method: string, body?: unknown): Promise<Response> => {
      const url = new URL('http://panel.test' + target), req = new Request(url, body === undefined ? { method } : { method, body: JSON.stringify(body) })
      try { return (await (route === 'owner' ? handleWebStatsWorkspaceRoute : handleWebStatsServerRoute)(req, url, method, ports))! } catch (error) { if (isXpanelError(error)) return new Response(JSON.stringify({ code: error.code, detail: error.detail }), { status: error.status }); throw error }
    }
    return { send, path, audit, ports }
  }
  const initial = parseWebStatsConfig(null)!, revision = webStatsRevision(initial)
  const reason = async (response: Response) => (await response.json() as { detail: { reason?: string; field?: string } }).detail

  it('saves a Metrics Editor choice for an owned site and records it', async () => {
    const t = await setup(), response = await t.send('owner', '/api/account/web-stats', 'PUT', { revision, sites: { 'example.test': ['awstats'] } })
    expect(response.status).toBe(200)
    const saved = JSON.parse(await readFile(t.path, 'utf8'))
    expect(saved.choices).toEqual({ [ACCOUNT]: { 'example.test': ['awstats'] } })
    expect((await response.json() as { revision: string }).revision).toBe(webStatsRevision(saved))
    expect((await stat(t.path)).mode & 0o777).toBe(0o640)
    expect(t.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.web_stats.metrics_saved', target: 'account:alice', outcome: 'ok' }))
  })

  it('refuses a locked engine with FORBIDDEN and changes nothing', async () => {
    const saved = { policy: { ...defaultWebStatsPolicy(), users: 'listed' as const, allowed: { alice: ['awstats' as const] } }, choices: {}, resellerLocks: {} }
    const t = await setup({ saved }), response = await t.send('owner', '/api/account/web-stats', 'PUT', { revision: webStatsRevision(saved), sites: { 'example.test': ['analog', 'awstats'] } })
    expect(response.status).toBe(403)
    expect((await reason(response)).reason).toBe('web_stats_choice_locked')
    expect(JSON.parse(await readFile(t.path, 'utf8'))).toEqual(saved)
    const allowed = await t.send('owner', '/api/account/web-stats', 'PUT', { revision: webStatsRevision(saved), sites: { 'example.test': ['analog', 'webalizer'] } })
    expect(allowed.status).toBe(200)
    expect(JSON.parse(await readFile(t.path, 'utf8')).choices[ACCOUNT]['example.test']).toEqual([])
  })

  it('refuses a foreign site, a stale revision, an unknown engine and an unverified tool', async () => {
    const t = await setup()
    expect((await t.send('owner', '/api/account/web-stats', 'PUT', { revision, sites: { 'other.test': [] } })).status).toBe(404)
    expect((await t.send('owner', '/api/account/web-stats', 'PUT', { revision: 'a'.repeat(64), sites: {} })).status).toBe(409)
    expect((await t.send('owner', '/api/account/web-stats', 'PUT', { revision, sites: { 'example.test': ['goaccess'] } })).status).toBe(400)
    expect((await t.send('owner', '/api/account/web-stats', 'PUT', { sites: {} })).status).toBe(400)
    const closed = await (await setup({ qualified: false })).send('owner', '/api/account/web-stats', 'PUT', { revision, sites: {} })
    expect((await reason(closed)).reason).toBe('web_stats_tool_unqualified')
  })

  it('reads and saves the root policy, keeping owner choices and refusing an interval off the 0.25 step', async () => {
    const saved = { policy: defaultWebStatsPolicy(), choices: { [ACCOUNT]: { 'example.test': ['awstats' as const] } }, resellerLocks: {} }
    const status = { engines: { awstats: true, webalizer: false }, geoip: { installed: false, month: null }, lastRunAt: null, nextRunAt: null, running: false, bandwidth: { lastCollectedAt: null, pendingBytes: 0 }, behind: [] }
    const t = await setup({ caller: root, saved, agent: () => status }), current = webStatsRevision(saved)
    expect(await (await t.send('server', '/api/server/web-stats', 'GET')).json()).toEqual({ policy: saved.policy, revision: current, host: status, actions: { save: true } })
    const bad = await t.send('server', '/api/server/web-stats', 'PUT', { revision: current, policy: { ...saved.policy, intervalHours: 0.3 } })
    expect(bad.status).toBe(400)
    expect((await reason(bad)).field).toBe('intervalHours')
    expect((await t.send('server', '/api/server/web-stats', 'PUT', { revision: current, policy: { ...saved.policy, blackoutHours: [2] } })).status).toBe(200)
    expect(JSON.parse(await readFile(t.path, 'utf8'))).toEqual({ policy: { ...saved.policy, blackoutHours: [2] }, choices: saved.choices, resellerLocks: {} })
    expect(t.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.web_stats.saved', outcome: 'ok' }))
  })

  it('saves a reseller lock that owners cannot change and root policy stays above, and refuses everyone else', async () => {
    const reseller = { principal: { kind: 'reseller', id: 'r-one', username: 'one' }, apiTokenId: null, scopes: [], principalRecord: { forcePasswordChange: false } } as unknown as AuthenticatedCaller
    const t = await setup({ caller: reseller, saved: { policy: defaultWebStatsPolicy(), choices: {}, resellerLocks: { 'r-two': { analog: true } } } })
    const read = await (await t.send('server', '/api/resellers/web-stats', 'GET')).json() as { revision: string; locks: object; available: string[]; actions: { save: boolean } }
    expect(read).toMatchObject({ locks: {}, available: ['analog', 'awstats', 'webalizer'], actions: { save: true } })
    expect((await t.send('server', '/api/resellers/web-stats', 'PUT', { revision: read.revision, locks: { goaccess: true } })).status).toBe(400)
    expect((await t.send('server', '/api/resellers/web-stats', 'PUT', { revision: 'a'.repeat(64), locks: {} })).status).toBe(409)
    expect((await t.send('server', '/api/resellers/web-stats', 'PUT', { revision: read.revision, locks: { awstats: false } })).status).toBe(200)
    expect(JSON.parse(await readFile(t.path, 'utf8')).resellerLocks).toEqual({ 'r-two': { analog: true }, 'r-one': { awstats: false } })
    expect(t.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.web_stats.reseller_locks_saved', target: 'reseller:one' }))
    expect((await (await setup({ caller: root })).send('server', '/api/resellers/web-stats', 'GET')).status).toBe(403)
    expect((await (await setup()).send('server', '/api/resellers/web-stats', 'GET')).status).toBe(403)
    expect((await (await setup({ caller: reseller, acl: [] })).send('server', '/api/resellers/web-stats', 'GET')).status).toBe(403)
    const closed = await (await setup({ caller: reseller, qualified: false })).send('server', '/api/resellers/web-stats', 'PUT', { revision: 'a'.repeat(64), locks: {} })
    expect((await reason(closed)).reason).toBe('web_stats_tool_unqualified')
  })

  it('refuses an owner change of a reseller-locked engine', async () => {
    const owned = { ...account, ownerId: 'r-one' }, saved = { policy: defaultWebStatsPolicy(), choices: {}, resellerLocks: { 'r-one': { awstats: true } } }
    const t = await setup({ saved, account: owned }), current = webStatsRevision(saved)
    const refused = await t.send('owner', '/api/account/web-stats', 'PUT', { revision: current, sites: { 'example.test': ['analog', 'webalizer'] } })
    expect(refused.status).toBe(403)
    expect((await reason(refused)).reason).toBe('web_stats_choice_locked')
    expect((await t.send('owner', '/api/account/web-stats', 'PUT', { revision: current, sites: { 'example.test': ['awstats'] } })).status).toBe(200)
  })

  it('reports a host it cannot read as no status, never as an empty one', async () => {
    const t = await setup({ caller: root, agent: () => { throw new Error('offline') } })
    expect(await (await t.send('server', '/api/server/web-stats', 'GET')).json()).toMatchObject({ host: null })
    const malformed = await setup({ caller: root, agent: () => ({ running: true }) })
    expect(await (await malformed.send('server', '/api/server/web-stats', 'GET')).json()).toMatchObject({ host: null })
  })

  it('passes process-now for one account to the agent and records it', async () => {
    const t = await setup({ caller: root, agent: () => ({ username: 'alice', state: 'started' }) })
    expect((await t.send('server', '/api/server/web-stats/process', 'POST', { username: 'alice' })).status).toBe(202)
    expect(t.ports.readAgent).toHaveBeenCalledWith(root, '/host/web-stats/process', { username: 'alice' }, true)
    expect(t.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.web_stats.process_requested', target: 'account:alice' }))
    expect((await t.send('server', '/api/server/web-stats/process', 'POST', { username: '../x' })).status).toBe(400)
    expect((await t.send('server', '/api/server/web-stats/process', 'GET')).status).toBe(405)
    expect((await t.send('server', '/api/server/web-stats?x=1', 'GET')).status).toBe(400)
  })

  it('refuses a non-root caller on every server route', async () => {
    const t = await setup()
    for (const [target, method, body] of [['/api/server/web-stats', 'GET', undefined], ['/api/server/web-stats', 'PUT', {}], ['/api/server/web-stats/process', 'POST', {}]] as const) expect((await t.send('server', target, method, body)).status).toBe(403)
  })
})
