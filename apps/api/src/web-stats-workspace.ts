import { join } from 'node:path'
import { assertAcl, fail } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { parseWebStatsHostStatus, parseWebStatsView } from '../../web/src/models/web-stats.ts'
import { WEB_STATS_CONFIG_STATE, choosableEngines, parseWebStatsConfig, selectedEngines, validateWebStatsLocks, validateWebStatsPolicy, webStatsRevision } from '../../agent/src/web-stats-config.ts'
import type { WebStatsConfig } from '../../agent/src/web-stats-config.ts'
import { WEB_STATS_GENERATORS, isStatsSiteName } from '../../agent/src/web-stats-format.ts'
import type { WebStatsGenerator } from '../../agent/src/web-stats-format.ts'

export const WEB_STATS_ROUTE = '/api/account/web-stats'
export const WEB_STATS_FILE_ROUTE = /^\/api\/account\/web-stats\/webalizer\/(https?)\/([a-z0-9.-]{1,253})\/([a-z_0-9.]{1,40})$/
export const WEB_STATS_SERVER_ROUTE = '/api/server/web-stats'
const WEB_STATS_PROCESS_ROUTE = '/api/server/web-stats/process'
const WEB_STATS_LOCKS_ROUTE = '/api/resellers/web-stats'
const SELECTORS = new Set(['site', 'scheme', 'month'])
const unchanged = { stateChanged: false }
const BODY_MAX_BYTES = 256 * 1024
// Webalizer pages are files the account can edit: no script, form, plugin or frame; the origin stays so their own graphs load with the session.
export const WEBALIZER_PAGE_CSP = "sandbox allow-same-origin; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export interface WebStatsPorts extends AccountSshPorts, Pick<ExtendedRouteHelpers, 'assertRoot' | 'emitAudit'> {
  /** True once the catalog has verified the tool, so a saved choice reaches a real run. */
  toolQualified: (toolId: string) => Promise<boolean>
}
const qualified = async (ports: WebStatsPorts, toolId: string): Promise<void> => {
  if (!await ports.toolQualified(toolId)) fail('PRECONDITION_FAILED', 'this statistics tool is not verified on this server', { ...unchanged, reason: 'web_stats_tool_unqualified' })
}
const readConfig = async (store: StateStore): Promise<WebStatsConfig> => {
  let raw: unknown
  try { raw = await readJsonIfExists<unknown>(join(store.rootDir, WEB_STATS_CONFIG_STATE)) } catch { return fail('PRECONDITION_FAILED', 'saved statistics configuration is unreadable; review it before changing it', unchanged) }
  return parseWebStatsConfig(raw) ?? fail('PRECONDITION_FAILED', 'saved statistics configuration requires review before changing it', unchanged)
}
const jsonBody = async (req: Request): Promise<Record<string, unknown>> => {
  const text = await req.text()
  if (Buffer.byteLength(text) > BODY_MAX_BYTES) return fail('VALIDATION', 'request is too large', unchanged)
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return fail('VALIDATION', 'valid JSON is required', unchanged) }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : fail('VALIDATION', 'a JSON object is required', unchanged)
}
const revisionOf = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : fail('VALIDATION', 'the exact observed revision is required', unchanged)

/** Revision-bound write of the one desired-state file; the saved effect is proven by a re-read before it is reported. */
async function writeConfig(store: StateStore, expected: string, build: (config: WebStatsConfig) => WebStatsConfig, fresh: () => Promise<unknown>): Promise<WebStatsConfig> {
  const lease = await store.getWriterLock().acquire(), path = join(store.rootDir, WEB_STATS_CONFIG_STATE)
  let attempted = false
  try {
    await fresh()
    const config = await readConfig(store)
    if (webStatsRevision(config) !== expected) return fail('CONFLICT', 'saved configuration changed; reload before saving', unchanged)
    const next = build(config)
    await lease.assertFencingToken(); attempted = true
    await atomicWriteJson(path, next, 0o640, async () => { await fresh(); await lease.assertFencingToken() })
    if (JSON.stringify(await readJsonIfExists<unknown>(path)) !== JSON.stringify(next)) throw new Error('readback_mismatch')
    return next
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the saved configuration could not be verified; review before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
}

/** Metrics Editor: the owner keeps or turns off engines per site; an engine the administrator controls cannot change. */
async function saveMetrics(req: Request, ports: WebStatsPorts): Promise<Response> {
  const first = await authorizeAccountOwner(ports, req, ['metrics-editor'], 'Metrics Editor')
  await qualified(ports, 'metrics-editor')
  const body = await jsonBody(req), revision = revisionOf(body.revision), requested = body.sites
  const engineList = (v: unknown): v is WebStatsGenerator[] => Array.isArray(v) && new Set(v).size === v.length && v.every(e => (WEB_STATS_GENERATORS as readonly unknown[]).includes(e))
  if (!requested || typeof requested !== 'object' || Array.isArray(requested) || !Object.values(requested).every(engineList)) return fail('VALIDATION', 'sites must map site names to engines', unchanged)
  const sites = requested as Record<string, WebStatsGenerator[]>, { account } = first
  let groups: ReturnType<typeof edge.groupSites>
  try { groups = edge.groupSites(account, await ports.store.listDomains({ accountId: account.id })) } catch { return fail('PRECONDITION_FAILED', 'the saved site configuration requires review', unchanged) }
  const owned = groups.map(group => group.main.name).filter(isStatsSiteName)
  if (Object.keys(sites).some(site => !owned.includes(site))) return fail('NOT_FOUND', 'site not found', unchanged)
  const fresh = async () => {
    const current = await authorizeAccountOwner(ports, req, ['metrics-editor'], 'Metrics Editor')
    if (current.caller.principal.id !== first.caller.principal.id || current.account.id !== account.id) fail('CONFLICT', 'the account binding changed before saving', unchanged)
  }
  const saved = await writeConfig(ports.store, revision, config => {
    const choosable = choosableEngines(config, account), mine = { ...config.choices[account.id] }
    for (const [site, engines] of Object.entries(sites)) {
      const current = selectedEngines(config, account, site)
      if (WEB_STATS_GENERATORS.some(engine => !choosable.includes(engine) && engines.includes(engine) !== current.includes(engine))) fail('FORBIDDEN', 'the server administrator controls this statistics engine', { ...unchanged, reason: 'web_stats_choice_locked' })
      mine[site] = engines.filter(engine => choosable.includes(engine))
    }
    return { ...config, choices: { ...config.choices, [account.id]: mine } }
  }, fresh)
  await ports.emitAudit({ actor: first.caller.principal.username, action: 'account.web_stats.metrics_saved', target: 'account:' + account.username, principalId: first.caller.principal.id, outcome: 'ok', detail: { sites: Object.keys(sites).length } }).catch(() => {})
  return workspaceJson({ revision: webStatsRevision(saved), sites: saved.choices[account.id] })
}

/** A reseller holds engines on or off for its own accounts; root's availability stays above every lock. */
async function handleWebStatsLocks(req: Request, url: URL, method: string, ports: WebStatsPorts): Promise<Response> {
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  if (url.search) return fail('VALIDATION', 'statistics routes accept no selectors', unchanged)
  const reseller = async (original?: AuthenticatedCaller): Promise<AuthenticatedCaller> => {
    const caller = await ports.requireCaller(req)
    if (caller.principal.kind !== 'reseller' || original && caller.principal.id !== original.principal.id) return fail('FORBIDDEN', 'a reseller locks statistics engines for its own accounts', unchanged)
    assertAcl(caller.principal, await ports.store.getReseller(caller.principal.id), 'edit-account')
    return caller
  }
  const caller = await reseller()
  if (method === 'GET') {
    const config = await readConfig(ports.store)
    return workspaceJson({ locks: config.resellerLocks[caller.principal.id] ?? {}, revision: webStatsRevision(config), available: WEB_STATS_GENERATORS.filter(engine => config.policy.engines[engine].available), actions: { save: await ports.toolQualified('metrics-editor') } })
  }
  await qualified(ports, 'metrics-editor')
  const body = await jsonBody(req), revision = revisionOf(body.revision), locks = validateWebStatsLocks(body.locks)
  const saved = await writeConfig(ports.store, revision, config => ({ ...config, resellerLocks: { ...config.resellerLocks, [caller.principal.id]: locks } }), () => reseller(caller))
  await ports.emitAudit({ actor: caller.principal.username, action: 'server.web_stats.reseller_locks_saved', target: 'reseller:' + caller.principal.username, principalId: caller.principal.id, outcome: 'ok', detail: { locks } }).catch(() => {})
  return workspaceJson({ locks, revision: webStatsRevision(saved) })
}

/** WHM Statistics Software Configuration: the saved policy, the host's run status and process-now for one account. */
export async function handleWebStatsServerRoute(req: Request, url: URL, method: string, ports: WebStatsPorts): Promise<Response | null> {
  if (url.pathname === WEB_STATS_LOCKS_ROUTE) return handleWebStatsLocks(req, url, method, ports)
  if (url.pathname !== WEB_STATS_SERVER_ROUTE && url.pathname !== WEB_STATS_PROCESS_ROUTE) return null
  const process = url.pathname === WEB_STATS_PROCESS_ROUTE, allow = process ? 'POST' : 'GET, PUT'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (url.search) return fail('VALIDATION', 'statistics routes accept no selectors', unchanged)
  const root = async (action: string, original?: AuthenticatedCaller): Promise<AuthenticatedCaller> => {
    const caller = await ports.requireCaller(req)
    if (caller.principal.kind !== 'root' || original && caller.principal.id !== original.principal.id) return fail('FORBIDDEN', 'the current root administrator is required', unchanged)
    await ports.assertRoot(caller, action)
    return caller
  }
  if (process) {
    const caller = await root('server.web_stats.process')
    await qualified(ports, 'web-stats-engines')
    const { username } = await jsonBody(req)
    if (typeof username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(username)) return fail('VALIDATION', 'an account username is required', unchanged)
    const reply = await ports.readAgent<Record<string, unknown>>(caller, '/host/web-stats/process', { username }, true)
    if (reply?.state !== 'started' || reply.username !== username) return fail('SERVICE_UNAVAILABLE', 'the statistics run could not be verified', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    await ports.emitAudit({ actor: caller.principal.username, action: 'server.web_stats.process_requested', target: 'account:' + username, principalId: caller.principal.id, outcome: 'ok', detail: {} }).catch(() => {})
    return workspaceJson({ username, state: 'started' }, 202)
  }
  if (method === 'GET') {
    const caller = await root('server.web_stats.read')
    const config = await readConfig(ports.store)
    const host = parseWebStatsHostStatus(await ports.readAgent<unknown>(caller, '/host/web-stats/status').catch(() => null))
    return workspaceJson({ policy: config.policy, revision: webStatsRevision(config), host, actions: { save: await ports.toolQualified('web-stats-engines') } })
  }
  const caller = await root('server.web_stats.update')
  await qualified(ports, 'web-stats-engines')
  const body = await jsonBody(req), revision = revisionOf(body.revision), policy = validateWebStatsPolicy(body.policy)
  const saved = await writeConfig(ports.store, revision, config => ({ ...config, policy }), () => root('server.web_stats.update', caller))
  await ports.emitAudit({ actor: caller.principal.username, action: 'server.web_stats.saved', target: 'server:web-stats', principalId: caller.principal.id, outcome: 'ok', detail: { intervalHours: policy.intervalHours } }).catch(() => {})
  return workspaceJson({ policy: saved.policy, revision: webStatsRevision(saved) })
}

/** The signed-in owner's statistics and Metrics Editor; the agent resolves sites from saved state and the reply is pinned to the account. */
export async function handleWebStatsWorkspaceRoute(req: Request, url: URL, method: string, ports: WebStatsPorts): Promise<Response | null> {
  const file = WEB_STATS_FILE_ROUTE.exec(url.pathname)
  if (url.pathname !== WEB_STATS_ROUTE && !file) return null
  if (method === 'PUT' && !file) return saveMetrics(req, ports)
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: file ? 'GET' : 'GET, PUT' } })
  if (file) {
    if (url.search) return fail('VALIDATION', 'report files accept no selectors', { stateChanged: false })
    const { caller, account } = await authorizeAccountOwner(ports, req, ['web-stats-webalizer'], 'Webalizer reports')
    const [, scheme, site, name] = file
    const raw = await ports.readAgent<Record<string, unknown>>(caller, `/accounts/${account.username}/web-stats/webalizer/${scheme}/${site}/${name}`)
    const context = raw && typeof raw === 'object' ? raw.context as Record<string, unknown> | undefined : undefined
    const type = name!.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8'
    if (!context || context.accountId !== account.id || context.site !== site || context.scheme !== scheme || context.file !== name || raw.contentType !== type || typeof raw.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.base64))
      return fail('SERVICE_UNAVAILABLE', 'the protected report read could not be verified', { stateChanged: false })
    return new Response(Buffer.from(raw.base64, 'base64'), { headers: { 'content-type': type, 'content-security-policy': WEBALIZER_PAGE_CSP, 'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' } })
  }
  for (const name of url.searchParams.keys()) if (!SELECTORS.has(name) || url.searchParams.getAll(name).length !== 1) return fail('VALIDATION', 'unknown or repeated selector', { stateChanged: false })
  const { caller, account } = await authorizeAccountOwner(ports, req, [], 'Web statistics')
  const raw = await ports.readAgent(caller, `/accounts/${account.username}/web-stats${url.search}`)
  const view = parseWebStatsView(raw, { accountId: account.id, username: account.username })
  if (!view) return fail('SERVICE_UNAVAILABLE', 'the protected statistics read could not be verified', { stateChanged: false })
  return workspaceJson(view)
}
