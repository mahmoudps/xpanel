import { join } from 'node:path'
import { cidrContains, fail, isXpanelError, parseCidr, parseIp } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { parseTrustedProxyPolicy, readTrustedProxyActive, readTrustedProxyRecord, TRUSTED_PROXY_STATE_PATH, trustedProxyPolicyRevision, trustedProxyRevision } from '../../../packages/core/src/trusted-proxies.ts'
import type { TrustedProxyObservation, TrustedProxyPolicy, TrustedProxyRecord } from '../../../packages/core/src/trusted-proxies.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface TrustedProxiesWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  /** Trusted socket/session-derived context plus host interface inventory, never body/header selectors. */
  readSafety: (request: Request) => Promise<{ localAddresses: readonly string[]; managementClient: string | null }>
  /** Existing protected agent transport; absent until an agent is connected. The management client is this request's socket-derived address, carried to the protected ingress provider. */
  readHost?: (caller: AuthenticatedCaller, path: string, body?: unknown, managementClient?: string | null) => Promise<unknown>
  now?: () => Date
}
export interface TrustedProxiesView {
  state: 'default' | 'saved' | 'invalid'
  policy: TrustedProxyPolicy | null
  updatedAt: string | null
  revision: string
  observation: TrustedProxyObservation
  application: 'saved_only'
}
const ROUTE = '/api/server/trusted-proxies'
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const absent = (): TrustedProxyObservation => ({ state: 'unavailable', active: null, activation: 'unavailable', reason: 'protected_native_provider_unavailable' })
const same = (left: AuthenticatedCaller, right: AuthenticatedCaller): boolean => right.principal.kind === 'root' && left.principal.id === right.principal.id && left.sessionId === right.sessionId && left.apiTokenId === right.apiTokenId
const readRaw = async (store: TrustedProxiesWorkspaceHelpers['store']): Promise<unknown> => {
  try { return await readJsonIfExists<unknown>(join(store.rootDir, TRUSTED_PROXY_STATE_PATH)) } catch { return fail('PRECONDITION_FAILED', 'saved proxy configuration is unreadable; review it before changing it', unchanged) }
}
export function projectTrustedProxyObservation(raw: unknown): TrustedProxyObservation {
  if (!object(raw) || Object.keys(raw).sort().join() !== 'activation,active,reason,state') return absent()
  if (raw.state === 'unavailable' && raw.active === null && raw.activation === 'unavailable' && typeof raw.reason === 'string' && /^[a-z_]{1,80}$/.test(raw.reason)) return { state: 'unavailable', active: null, activation: 'unavailable', reason: raw.reason }
  if (raw.state !== 'read' || raw.activation !== 'available' || raw.reason !== null) return absent()
  try { return { state: 'read', active: readTrustedProxyActive(raw.active as Parameters<typeof readTrustedProxyActive>[0]), activation: 'available', reason: null } } catch { return absent() }
}
async function viewOf(raw: unknown, caller: AuthenticatedCaller, helpers: TrustedProxiesWorkspaceHelpers, managementClient: string | null): Promise<TrustedProxiesView> {
  const record = readTrustedProxyRecord(raw)
  let observation = absent()
  if (helpers.readHost) { try { observation = projectTrustedProxyObservation(await helpers.readHost(caller, '/host/trusted-proxies', undefined, managementClient)) } catch { observation = absent() } }
  return { state: raw === null ? 'default' : record ? 'saved' : 'invalid', policy: raw === null ? { cidrs: [], header: 'X-Forwarded-For' } : record?.policy ?? null, updatedAt: record?.updatedAt ?? null, revision: trustedProxyRevision(raw), observation, application: 'saved_only' }
}
const bodyOf = async (request: Request): Promise<Record<string, unknown>> => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await request.text()
  if (Buffer.byteLength(text) > 8192) return invalid('proxy configuration request is too large')
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return invalid('valid JSON is required') }
  return object(raw) ? raw : invalid('a JSON object is required')
}
const revisionOf = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : invalid('the exact observed revision is required')

/** Root metadata source. Saving never reconfigures either the API listener or native ingress. */
export async function handleTrustedProxiesWorkspaceRoute(request: Request, url: URL, method: string, helpers: TrustedProxiesWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== ROUTE && url.pathname !== ROUTE + '/apply') return null
  const caller = await helpers.requireCaller(request), action = url.pathname.endsWith('/apply') ? 'server.trusted_proxies.apply' : method === 'PUT' ? 'server.trusted_proxies.update' : 'server.trusted_proxies.read'
  await helpers.assertRoot(caller, action)
  const fresh = async (): Promise<AuthenticatedCaller> => { const current = await helpers.requireCaller(request); await helpers.assertRoot(current, action); if (!same(caller, current)) return fail('FORBIDDEN', 'root authorization changed', unchanged); return current }
  if (url.search) return invalid('proxy configuration accepts no query selectors')
  const client = async (): Promise<string | null> => { try { const value = (await helpers.readSafety(request))?.managementClient ?? null; return parseIp(value) ? value : null } catch { return null } }
  if (url.pathname === ROUTE && method === 'GET') { const view = await viewOf(await readRaw(helpers.store), caller, helpers, await client()); await fresh(); return json(view) }
  if (url.pathname === ROUTE + '/apply' && method === 'POST') {
    const body = await bodyOf(request)
    if (Object.keys(body).sort().join() !== 'expectedActiveRevision,expectedRevision') return invalid('only expectedRevision and expectedActiveRevision are accepted')
    const expectedRevision = revisionOf(body.expectedRevision), expectedActiveRevision = revisionOf(body.expectedActiveRevision)
    const raw = await readRaw(helpers.store), record = readTrustedProxyRecord(raw)
    if (!record) return fail('PRECONDITION_FAILED', 'a valid saved proxy policy is required', unchanged)
    if (trustedProxyRevision(raw) !== expectedRevision) return fail('CONFLICT', 'saved policy changed; reload before applying', unchanged)
    if (!helpers.readHost) return fail('PRECONDITION_FAILED', 'protected native ingress activation is unavailable', unchanged)
    // The current management client is re-read at apply time; the provider refuses it as a proxy again with its own evidence.
    const managementClient = await client(), current = managementClient ? parseIp(managementClient) : null
    if (!current) return fail('PRECONDITION_FAILED', 'the actual management client address could not be verified', unchanged)
    if (record.policy.cidrs.some(cidr => cidrContains(parseCidr(cidr)!, current))) return invalid('the actual management client cannot become a trusted proxy')
    const actor = await fresh()
    let ack: unknown
    try { ack = await helpers.readHost(actor, '/host/trusted-proxies/apply', { expectedRevision, expectedActiveRevision }, managementClient) }
    catch (error) {
      if (isXpanelError(error) && error.detail.stateChanged === false) throw error
      return fail('SERVICE_UNAVAILABLE', 'ingress activation transport outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    }
    let active: ReturnType<typeof readTrustedProxyActive>
    try {
      if (!object(ack) || ack.savedRevision !== expectedRevision || ack.stateChanged !== true || ack.verificationRequired !== false) throw new Error('invalid_activation_ack')
      active = readTrustedProxyActive(ack.active as Parameters<typeof readTrustedProxyActive>[0])
      if (active.revision !== trustedProxyPolicyRevision(record.policy)) throw new Error('activation_policy_mismatch')
      await fresh()
    } catch { return fail('SERVICE_UNAVAILABLE', 'ingress activation acknowledgement or authorization could not be verified', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
    try { await helpers.emitAudit({ actor: actor.principal.username, action: 'server.trusted_proxies.applied', target: 'server:trusted-proxies', principalId: actor.principal.id, outcome: 'ok', detail: { cidrs: record.policy.cidrs.length } }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'ingress activation requires audit review', { stateChanged: true, verificationRequired: true }) }
    return json({ active, savedRevision: expectedRevision, stateChanged: true, verificationRequired: false })
  }
  if (url.pathname !== ROUTE || method !== 'PUT') return new Response(null, { status: 405, headers: { allow: url.pathname.endsWith('/apply') ? 'POST' : 'GET, PUT' } })
  const body = await bodyOf(request)
  if (Object.keys(body).sort().join() !== 'expectedRevision,policy') return invalid('only policy and expectedRevision are accepted')
  const expectedRevision = revisionOf(body.expectedRevision)
  const lease = await helpers.store.getWriterLock().acquire()
  let attempted = false, next: TrustedProxyRecord
  try {
    await fresh()
    const raw = await readRaw(helpers.store)
    if (raw !== null && !readTrustedProxyRecord(raw)) return fail('PRECONDITION_FAILED', 'saved proxy policy requires review before changing it', unchanged)
    if (trustedProxyRevision(raw) !== expectedRevision) return fail('CONFLICT', 'saved proxy policy changed; reload before saving', unchanged)
    const safety = await helpers.readSafety(request)
    if (!safety || !Array.isArray(safety.localAddresses) || safety.localAddresses.length < 1 || safety.localAddresses.length > 256) return fail('PRECONDITION_FAILED', 'local interface safety inventory is unavailable', unchanged)
    const policy = parseTrustedProxyPolicy(body.policy, safety.localAddresses), client = parseIp(safety.managementClient)
    if (policy.cidrs.length && !client) return fail('PRECONDITION_FAILED', 'the actual management client address could not be verified', unchanged)
    if (client && policy.cidrs.some(cidr => cidrContains(parseCidr(cidr)!, client))) return invalid('the actual management client cannot become a trusted proxy')
    next = { version: 1, policy, updatedAt: (helpers.now ?? (() => new Date()))().toISOString() }
    await fresh(); await lease.assertFencingToken(); attempted = true
    await atomicWriteJson(join(helpers.store.rootDir, TRUSTED_PROXY_STATE_PATH), next, 0o640, async () => { await fresh(); await lease.assertFencingToken() })
    const saved = await readRaw(helpers.store)
    if (JSON.stringify(saved) !== JSON.stringify(next)) throw new Error('proxy_policy_readback_failed')
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'saved proxy policy could not be verified; review before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
  try { await helpers.emitAudit({ actor: caller.principal.username, action: 'server.trusted_proxies.saved', target: 'server:trusted-proxies', principalId: caller.principal.id, outcome: 'ok', detail: { cidrs: next!.policy.cidrs.length, application: 'saved_only' } }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'policy was saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
  try { const view = await viewOf(next!, caller, helpers, await client()); await fresh(); return json(view) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the policy was saved but post-save authorization requires review', { stateChanged: true, verificationRequired: true }) }
}
