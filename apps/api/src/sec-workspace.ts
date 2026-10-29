import { join } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { parseSecPolicy, readSecRecord, SEC_DEFAULTS, SEC_LISTENERS, SEC_STATE_PATHS, secPanelAccessAdmits, secRevision } from '../../agent/src/sec-policy.ts'
import type { SecKind, SecListener, SecPanelAccessPolicy } from '../../agent/src/sec-policy.ts'

export interface SecWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit' | 'triggerReconcile'> {
  store: StateStore
  /** Protected agent transport; a body sends a POST mutation. Absent when no host agent is connected. */
  callHost?: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
  /** Socket/trusted-ingress client address and the entry point of this request; never a header chosen by the browser. */
  readClient: (request: Request) => { listener: SecListener | null; address: string | null }
  /** True only when the API request pipeline enforces saved panel access (secPanelAccessGate). */
  panelAccessEnforced: boolean
  now?: () => Date
}
type ServerKind = Exclude<SecKind, 'waf-sites'>
const SERVER: Readonly<Record<string, { kind: ServerKind; host: string | null; reconcile: boolean }>> = {
  '/api/server/sec/waf': { kind: 'waf', host: '/host/sec/waf', reconcile: true },
  '/api/server/sec/flood': { kind: 'flood', host: '/host/sec/flood', reconcile: true },
  '/api/server/sec/panel-access': { kind: 'panel-access', host: null, reconcile: false },
  '/api/server/sec/dns-cluster': { kind: 'dns-cluster', host: '/host/sec/dns-cluster', reconcile: false },
}
const ACCOUNT_WAF = '/api/account/sec/waf'
const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const iso = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)
const boolOrNull = (value: unknown): value is boolean | null => value === null || typeof value === 'boolean'
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const path = (value: unknown): value is string | null => value === null || typeof value === 'string' && value.length <= 256 && /^\/[A-Za-z0-9._/-]+$/.test(value)
const unverified = (): never => fail('PRECONDITION_FAILED', 'the host observation could not be verified', { stateChanged: false, verificationRequired: true })

export function projectSecWafObservation(value: unknown): unknown {
  if (!object(value) || !iso(value.observedAt) || !(value.family === null || oneOf(value.family, ['debian', 'rhel'] as const)) || !object(value.connector) || !boolOrNull(value.connector.nginx) || !boolOrNull(value.connector.apache)
    || !object(value.engineConf) || !path(value.engineConf.path) || !(value.engineConf.ruleEngine === null || oneOf(value.engineConf.ruleEngine, ['On', 'Off', 'DetectionOnly'] as const))
    || !object(value.crs) || !path(value.crs.dir) || !(value.crs.version === null || typeof value.crs.version === 'string' && /^[0-9]{1,2}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(value.crs.version))
    || !object(value.active) || !boolOrNull(value.active.lists) || !boolOrNull(value.active.modsecurity)) return unverified()
  return { observedAt: value.observedAt, family: value.family, connector: { nginx: value.connector.nginx, apache: value.connector.apache }, engineConf: { path: value.engineConf.path, ruleEngine: value.engineConf.ruleEngine },
    crs: { dir: value.crs.dir, version: value.crs.version }, active: { lists: value.active.lists, modsecurity: value.active.modsecurity } }
}
export function projectSecFloodObservation(value: unknown): unknown {
  if (!object(value) || !iso(value.observedAt) || !oneOf(value.state, ['read', 'not_installed', 'not_applied', 'unavailable'] as const) || !(value.reason === null || oneOf(value.reason, ['command_failed', 'malformed_output'] as const))
    || !object(value.rules) || !['connections', 'rate', 'ping'].every(key => count((value.rules as Record<string, unknown>)[key])) || !Array.isArray(value.tracked) || value.tracked.length > 4) return unverified()
  const tracked = value.tracked.map(item => object(item) && oneOf(item.set, ['xpanel_flood_conn4', 'xpanel_flood_conn6', 'xpanel_flood_rate4', 'xpanel_flood_rate6'] as const) && count(item.elements) ? { set: item.set, elements: item.elements } : unverified())
  const rules = value.rules as Record<string, number>
  return { observedAt: value.observedAt, state: value.state, reason: value.reason, rules: { connections: rules.connections, rate: rules.rate, ping: rules.ping }, tracked }
}
const peerOf = (value: unknown): { name: string; address: string } => object(value) && text(value.name, 253) && /^[a-z0-9.-]+$/.test(value.name) && text(value.address, 45) && /^[0-9a-f:.]+$/.test(value.address) ? { name: value.name, address: value.address } : unverified()
const addresses = (value: unknown): string[] => Array.isArray(value) && value.length <= 64 && value.every(item => text(item, 64)) ? [...value as string[]] : unverified()
export function projectSecDnsClusterObservation(value: unknown): unknown {
  if (!object(value) || !iso(value.observedAt) || !oneOf(value.state, ['read', 'not_installed', 'unavailable'] as const) || !oneOf(value.application, ['single_node', 'applied', 'drift', 'unavailable'] as const) || !Array.isArray(value.peers) || value.peers.length > 16) return unverified()
  const s = value.settings
  if (value.state === 'read' ? !object(s) : s !== null) return unverified()
  const settings = object(s) ? (!(s.launch === null || text(s.launch, 256)) || !boolOrNull(s.primary) || typeof s.disableAxfr !== 'boolean' || !(s.includeDir === null || path(s.includeDir)) ? unverified()
    : { launch: s.launch, primary: s.primary, disableAxfr: s.disableAxfr, allowAxfrIps: addresses(s.allowAxfrIps), alsoNotify: addresses(s.alsoNotify), includeDir: s.includeDir }) : null
  const peers = value.peers.map(item => object(item) && boolOrNull(item.transferAllowed) && boolOrNull(item.notified) ? { ...peerOf(item), transferAllowed: item.transferAllowed, notified: item.notified } : unverified())
  return { observedAt: value.observedAt, state: value.state, settings, application: value.application, peers }
}
const ZONE_STATES = ['in_sync', 'behind', 'ahead', 'not_served', 'refused', 'unreachable', 'local_unavailable'] as const
export function projectSecPeerVerification(value: unknown, peer: string): unknown {
  if (!object(value) || !iso(value.observedAt) || !Array.isArray(value.zones) || value.zones.length > 200 || typeof value.truncated !== 'boolean' || !object(value.counts)) return unverified()
  const counted: Record<string, number> = Object.fromEntries(ZONE_STATES.map(state => [state, 0]))
  const serial = (item: unknown): item is number | null => item === null || count(item) && item <= 4294967295
  const zones = value.zones.map(row => {
    if (!object(row) || !text(row.zone, 253) || !/^[a-z0-9.-]+$/.test(row.zone) || !serial(row.localSerial) || !serial(row.peerSerial) || !oneOf(row.state, ZONE_STATES)) return unverified()
    counted[row.state]!++
    return { zone: row.zone, localSerial: row.localSerial, peerSerial: row.peerSerial, state: row.state }
  })
  const reported = value.counts as Record<string, unknown>, target = peerOf(value.peer)
  if (target.name !== peer || ZONE_STATES.some(state => reported[state] !== counted[state])) return unverified()
  return { observedAt: value.observedAt, peer: target, zones, counts: counted, truncated: value.truncated }
}

interface SecView { state: 'default' | 'saved' | 'invalid'; policy: unknown; updatedAt: string | null; revision: string }
const readRaw = async (store: Pick<StateStore, 'rootDir'>, kind: SecKind): Promise<unknown> => {
  try { return await readJsonIfExists<unknown>(join(store.rootDir, SEC_STATE_PATHS[kind])) } catch { return fail('PRECONDITION_FAILED', 'saved configuration is unreadable; review it before changing it', unchanged) }
}
const viewOf = (kind: SecKind, raw: unknown): SecView => {
  const record = raw === null ? null : readSecRecord(kind, raw)
  return { state: raw === null ? 'default' : record ? 'saved' : 'invalid', policy: raw === null ? structuredClone(SEC_DEFAULTS[kind]) : record?.policy ?? null, updatedAt: record?.updatedAt ?? null, revision: secRevision(kind, raw) }
}
const same = (left: AuthenticatedCaller, right: AuthenticatedCaller): boolean => left.principal.id === right.principal.id && left.sessionId === right.sessionId && left.apiTokenId === right.apiTokenId
const bodyOf = async (request: Request, max: number): Promise<Record<string, unknown>> => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const raw = await request.text()
  if (Buffer.byteLength(raw) > max) return invalid('the request is too large')
  let value: unknown
  try { value = JSON.parse(raw) } catch { return invalid('valid JSON is required') }
  return object(value) ? value : invalid('a JSON object is required')
}
const revisionOf = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : invalid('the exact observed revision is required')
const reconcileOutcome = async (helpers: SecWorkspaceHelpers, caller: AuthenticatedCaller): Promise<'requested' | 'failed' | 'not_connected' | 'unknown'> => {
  try { const result = await helpers.triggerReconcile(caller); return result === null ? 'not_connected' : result.ok ? 'requested' : 'failed' } catch { return 'unknown' }
}

/** Revision-bound write of one desired-state file; the saved effect is proven by a re-read before it is reported. */
async function writeRecord(helpers: SecWorkspaceHelpers, kind: SecKind, expectedRevision: string, build: (raw: unknown) => unknown, fresh: () => Promise<unknown>): Promise<unknown> {
  const lease = await helpers.store.getWriterLock().acquire()
  let attempted = false
  try {
    await fresh()
    const raw = await readRaw(helpers.store, kind)
    if (raw !== null && !readSecRecord(kind, raw)) return fail('PRECONDITION_FAILED', 'saved configuration requires review before changing it', unchanged)
    if (secRevision(kind, raw) !== expectedRevision) return fail('CONFLICT', 'saved configuration changed; reload before saving', unchanged)
    const record = { version: 1, policy: build(raw), updatedAt: (helpers.now ?? (() => new Date()))().toISOString() }
    await lease.assertFencingToken(); attempted = true
    await atomicWriteJson(join(helpers.store.rootDir, SEC_STATE_PATHS[kind]), record, 0o640, async () => { await fresh(); await lease.assertFencingToken() })
    const saved = await readRaw(helpers.store, kind)
    if (JSON.stringify(saved) !== JSON.stringify(record)) throw new Error('readback_mismatch')
    return saved
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the saved configuration could not be verified; review before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
}

const clientFacts = (policy: SecPanelAccessPolicy, client: { listener: SecListener | null; address: string | null }) => ({ listener: client.listener, address: client.address,
  admitted: Object.fromEntries(SEC_LISTENERS.map(name => [name, secPanelAccessAdmits(policy, name, client.address)])) as Record<SecListener, boolean> })

async function hostRead(helpers: SecWorkspaceHelpers, caller: AuthenticatedCaller, hostPath: string, project: (value: unknown) => unknown): Promise<{ observation: unknown; reason: string | null }> {
  if (!helpers.callHost) return { observation: null, reason: 'host_agent_unavailable' }
  try { return { observation: project(await helpers.callHost(caller, hostPath)), reason: null } }
  catch (error) { return { observation: null, reason: isXpanelError(error) && error.code === 'PRECONDITION_FAILED' && error.message.includes('verified') ? 'observation_unverified' : 'host_unavailable' } }
}
const PROJECT: Readonly<Record<string, (value: unknown) => unknown>> = { waf: projectSecWafObservation, flood: projectSecFloodObservation, 'dns-cluster': projectSecDnsClusterObservation }

/** Root WAF, flood, panel access and DNS cluster workspaces plus the account owner's per-domain ModSecurity switch. */
export async function handleSecWorkspaceRoute(request: Request, url: URL, method: string, helpers: SecWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname === ACCOUNT_WAF) return accountWaf(request, url, method, helpers)
  const verify = url.pathname === '/api/server/sec/dns-cluster/verify', apply = url.pathname === '/api/server/sec/dns-cluster/apply'
  const route = SERVER[url.pathname] ?? (verify || apply ? SERVER['/api/server/sec/dns-cluster']! : null)
  if (!route) return null
  const action = `server.sec.${route.kind}.${method === 'GET' ? 'read' : apply ? 'apply' : 'update'}`
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const fresh = async (): Promise<AuthenticatedCaller> => { const current = await helpers.requireCaller(request); await helpers.assertRoot(current, action); return same(caller, current) ? current : fail('FORBIDDEN', 'root authorization changed', unchanged) }
  const allowed = verify ? 'GET' : apply ? 'POST' : 'GET, PUT'
  if (!allowed.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow: allowed } })
  const query = [...url.searchParams]
  if (verify ? query.length !== 1 || query[0]![0] !== 'peer' || !/^[a-z0-9.-]{1,253}$/.test(query[0]![1]) : url.search) return invalid(verify ? 'exactly one peer name is required' : 'security workspaces accept no query selectors')
  const kind = route.kind

  if (verify) {
    if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'peer verification needs the host agent', unchanged)
    const peer = query[0]![1]
    const result = projectSecPeerVerification(await helpers.callHost(caller, '/host/sec/dns-cluster/verify?peer=' + encodeURIComponent(peer)), peer)
    await fresh()
    return workspaceJson(result)
  }
  if (apply) {
    const body = await bodyOf(request, 512)
    if (Object.keys(body).join() !== 'expectedRevision') return invalid('only expectedRevision is accepted')
    const expectedRevision = revisionOf(body.expectedRevision), raw = await readRaw(helpers.store, kind)
    if (!readSecRecord(kind, raw)) return fail('PRECONDITION_FAILED', 'save the cluster peers before applying them', unchanged)
    if (secRevision(kind, raw) !== expectedRevision) return fail('CONFLICT', 'saved cluster configuration changed; reload before applying', unchanged)
    if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'applying cluster settings needs the host agent', unchanged)
    const actor = await fresh()
    let ack: unknown
    try { ack = await helpers.callHost(actor, '/host/sec/dns-cluster/apply', { expectedRevision }) }
    catch (error) { if (isXpanelError(error) && error.detail.stateChanged === false) throw error; return fail('SERVICE_UNAVAILABLE', 'the PowerDNS apply outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
    if (!object(ack) || !oneOf(ack.outcome, ['applied', 'unchanged'] as const)) return fail('SERVICE_UNAVAILABLE', 'the PowerDNS apply outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    const observation = projectSecDnsClusterObservation(ack.observation) as { application: string }
    if (observation.application !== 'applied' && observation.application !== 'single_node') return fail('SERVICE_UNAVAILABLE', 'the PowerDNS apply outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    await helpers.emitAudit({ actor: actor.principal.username, action: 'server.sec.dns-cluster.applied', target: 'dns:cluster', principalId: actor.principal.id, outcome: 'ok', detail: { outcome: ack.outcome } }).catch(() => {})
    return workspaceJson({ outcome: ack.outcome, observation })
  }

  if (method === 'GET') {
    const view = viewOf(kind, await readRaw(helpers.store, kind))
    const host = route.host ? await hostRead(helpers, caller, route.host, PROJECT[kind]!) : null
    const extra = kind === 'panel-access' ? { client: clientFacts(view.policy as SecPanelAccessPolicy ?? SEC_DEFAULTS['panel-access'], helpers.readClient(request)), enforcement: helpers.panelAccessEnforced ? 'api_listener' : 'not_connected' } : {}
    await fresh()
    return workspaceJson({ ...view, ...(host ? host : {}), ...extra })
  }
  const body = await bodyOf(request, 96 * 1024)
  if (Object.keys(body).sort().join() !== 'expectedRevision,policy') return invalid('only policy and expectedRevision are accepted')
  const expectedRevision = revisionOf(body.expectedRevision), policy = parseSecPolicy(kind, body.policy)
  const saved = await writeRecord(helpers, kind, expectedRevision, () => {
    // Self-lockout guard: the list for the entry point in use (xWHM when it cannot be told) must still admit this request's address.
    const client = helpers.readClient(request), listener = client.listener ?? 'xwhm'
    if (kind === 'panel-access' && !secPanelAccessAdmits(policy as SecPanelAccessPolicy, listener, client.address)) return fail('CONFLICT', client.address ? 'the allowlist would lock out your current address on this entry point' : 'your current address could not be verified, so a restricting allowlist cannot be saved', { stateChanged: false, reason: 'self_lockout' })
    return policy
  }, fresh)
  const current = await fresh().catch(() => null)
  try { await helpers.emitAudit({ actor: caller.principal.username, action: `server.sec.${kind}.saved`, target: 'server:sec:' + kind, principalId: caller.principal.id, outcome: 'ok', detail: { revision: secRevision(kind, saved) } }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the configuration was saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
  const reconcile = route.reconcile && current ? await reconcileOutcome(helpers, current) : null
  return workspaceJson({ ...viewOf(kind, saved), reconcile })
}

/** The signed-in owner's domains with their ModSecurity switch, the server WAF limits that apply to them and live connector facts. */
async function accountWaf(request: Request, url: URL, method: string, helpers: SecWorkspaceHelpers): Promise<Response> {
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  if (url.search) return invalid('the account WAF accepts no selectors')
  const ports = { store: helpers.store, requireCaller: (req: Request) => helpers.requireCaller(req) }
  const first = await authorizeAccountOwner(ports, request, ['modsecurity'], 'Web application firewall')
  const server = viewOf('waf', await readRaw(helpers.store, 'waf')), sitesRaw = await readRaw(helpers.store, 'waf-sites'), sites = viewOf('waf-sites', sitesRaw)
  const view = async (account: typeof first.account, sitesView: SecView) => {
    const domains = (await helpers.store.listDomains({ accountId: account.id })).map(domain => domain.name).sort()
    const switches = (sitesView.policy as { sites: Record<string, { accountId: string; modsecurity: boolean }> } | null)?.sites ?? {}
    const policy = server.policy as typeof SEC_DEFAULTS.waf | null
    let live: unknown = null
    if (helpers.callHost) try { const raw = projectSecWafObservation(await helpers.callHost(first.caller, '/host/sec/waf/summary')) as { connector: { nginx: boolean | null }; crs: { version: string | null }; active: unknown }; live = { connector: raw.connector.nginx, crsVersion: raw.crs.version, active: raw.active } } catch { live = null }
    return { server: server.state === 'invalid' || !policy ? null : { requestsPerSecond: policy.requestsPerSecond, burst: policy.burst, maxBodyMb: policy.maxBodyMb, deniedResponse: policy.deniedResponse, modsecurity: policy.modsecurity, lists: { addresses: policy.denyIps.length, paths: policy.denyPaths.length, userAgents: policy.denyUserAgents.length } },
      live, revision: sitesView.revision, sitesState: sitesView.state,
      domains: domains.map(name => ({ domain: name, modsecurity: switches[name]?.accountId === account.id ? switches[name]!.modsecurity : true })) }
  }
  if (method === 'GET') return workspaceJson(await view(first.account, sites))
  const body = await bodyOf(request, 1024)
  if (Object.keys(body).sort().join() !== 'domain,expectedRevision,modsecurity' || typeof body.modsecurity !== 'boolean' || typeof body.domain !== 'string') return invalid('only domain, modsecurity and expectedRevision are accepted')
  const expectedRevision = revisionOf(body.expectedRevision), domain = body.domain, enabled = body.modsecurity
  const fresh = async () => {
    const again = await authorizeAccountOwner(ports, request, ['modsecurity'], 'Web application firewall')
    if (again.caller.principal.id !== first.caller.principal.id || again.account.id !== first.account.id) return fail('CONFLICT', 'the account binding changed before saving', unchanged)
    const owned = (await helpers.store.listDomains({ accountId: again.account.id })).some(item => item.name === domain)
    return owned ? again : fail('NOT_FOUND', 'domain not found', unchanged)
  }
  await fresh()
  const saved = await writeRecord(helpers, 'waf-sites', expectedRevision, raw => {
    const current = raw === null ? { sites: {} } : readSecRecord('waf-sites', raw)!.policy, next = { ...current.sites }
    // Only an "off" switch is stored; "on" is the default and removes the entry.
    if (enabled) delete next[domain]; else next[domain] = { accountId: first.account.id, modsecurity: false }
    return parseSecPolicy('waf-sites', { sites: Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))) })
  }, fresh)
  const current = await fresh().catch(() => null)
  try { await helpers.emitAudit({ actor: first.caller.principal.username, action: 'account.sec.waf.saved', target: 'domain:' + domain, principalId: first.caller.principal.id, outcome: 'ok', detail: { modsecurity: enabled } }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the switch was saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
  const reconcile = current ? await reconcileOutcome(helpers, current.caller) : null
  return workspaceJson({ ...await view(current?.account ?? first.account, viewOf('waf-sites', saved)), reconcile })
}
