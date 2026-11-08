import { join } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { DnssecKeyView, DnssecRequest, DnssecView } from '../../agent/src/dnssec.ts'

export const DNSSEC_ROUTE = /^\/api\/dns\/zones\/([a-z0-9.-]{1,253})\/dnssec$/
export interface DnssecRollover { keyId: number; newKeyId: number; type: DnssecKeyView['type']; startedAt: string; notBefore: string }
export interface DnssecWorkspaceView { view: DnssecView; rollovers: (DnssecRollover & { ready: boolean })[] }
export interface DnssecPorts {
  store: StateStore
  requireCaller: (req: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  assertCanAccessAccount: (caller: AuthenticatedCaller, account: Account, action: string) => Promise<void>
  /** Protected agent transport; null without a connected host agent. */
  callAgent: ((path: string, options: { caller: AuthenticatedCaller; method: string; body: unknown }) => Promise<Response>) | null
  now?: () => Date
}
const unchanged = { stateChanged: false }
const uncertain = { stateChanged: true, unknownOutcome: true, verificationRequired: true }
// Agent refusals the page explains; any other refusal stays generic.
const REASONS = new Set(['dnssec_key_store_unavailable', 'zone_not_published', 'dnssec_already_enabled', 'dnssec_not_enabled', 'last_active_key', 'active_key_unpublished', 'key_unpublished',
  'key_inactive', 'dnssec_key_limit', 'rollover_mismatch', 'rollover_unpublished', 'algorithm_unsupported', 'dnssec_change_refused', 'dnssec_change_partial', 'dnssec_change_unverified',
  'dns_service_unavailable', 'dnssec_key_store_unreadable', 'dnssec_observation_unrecognized', 'host_executor_unavailable'])
// Resolver caches hold the old DNSKEY set for its TTL; the server's own key cache adds up to 60 s.
const CACHE_MARGIN_MS = 90_000
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Pins the agent reply; anything unexpected is an unverified host answer, never shown as state. */
export function validateDnssecReply(raw: unknown, zone: string): { view: DnssecView; addedKeyIds: number[] } {
  const bad = (): never => fail('SERVICE_UNAVAILABLE', 'the DNSSEC host reply could not be verified')
  if (!object(raw) || !object(raw.view) || !Array.isArray(raw.addedKeyIds) || raw.addedKeyIds.some(id => !Number.isSafeInteger(id) || (id as number) < 1)) return bad()
  const v = raw.view
  if (v.zone !== zone || !['ready', 'unconfigured'].includes(v.store as string) || typeof v.served !== 'boolean' || !['unsigned', 'signed', 'pending'].includes(v.signing as string)
    || !['none', 'current', 'pending'].includes(v.publication as string) || !(v.dnskeyTtl === null || Number.isSafeInteger(v.dnskeyTtl)) || typeof v.observedAt !== 'string' || !Number.isFinite(Date.parse(v.observedAt))
    || !(v.nsec === null || object(v.nsec) && ['nsec', 'nsec3'].includes(v.nsec.mode as string) && typeof v.nsec.optOut === 'boolean' && typeof v.nsec.narrow === 'boolean')
    || !Array.isArray(v.keys) || v.keys.length > 16) return bad()
  for (const key of v.keys) {
    if (!object(key) || !Number.isSafeInteger(key.id) || !['KSK', 'ZSK', 'CSK'].includes(key.type as string) || typeof key.active !== 'boolean' || typeof key.published !== 'boolean'
      || !Number.isSafeInteger(key.bits) || typeof key.algorithm !== 'string' || !/^[A-Z0-9-]{2,32}$/.test(key.algorithm) || !Number.isSafeInteger(key.tag)
      || !(key.dnskey === null || typeof key.dnskey === 'string' && /^(256|257) 3 [0-9]{1,3} [A-Za-z0-9+/]+={0,2}$/.test(key.dnskey)) || !Array.isArray(key.ds) || key.ds.length > 2
      || key.ds.some(ds => !object(ds) || ds.keyTag !== key.tag || ![2, 4].includes(ds.digestType as number) || typeof ds.digest !== 'string' || !/^[0-9A-F]{64}(?:[0-9A-F]{32})?$/.test(ds.digest))) return bad()
  }
  return raw as unknown as { view: DnssecView; addedKeyIds: number[] }
}

/** Browser body to agent request; disabling needs the zone typed back and a KSK swap needs the registrar confirmed. */
export function parseDnssecBody(raw: unknown, zone: string): { request: Exclude<DnssecRequest, { op: 'read' }>; dsUpdated: boolean } {
  const bad = (message = 'unsupported DNSSEC change'): never => fail('VALIDATION', message, unchanged)
  if (!object(raw)) return bad()
  const { confirm, dsUpdated, ...rest } = raw
  if (rest.op === 'disable' && confirm !== zone) return bad('type the zone name to turn DNSSEC off')
  if (rest.op !== 'disable' && confirm !== undefined) return bad()
  if (dsUpdated !== undefined && (rest.op !== 'rollover-finish' || typeof dsUpdated !== 'boolean')) return bad()
  if (rest.op === 'read') return bad()
  const KEYS: Record<string, string> = { enable: 'algorithm,layout,op', disable: 'op', 'add-key': 'active,algorithm,op,type', key: 'keyId,op,verb', nsec: 'mode,op,optOut', 'rollover-start': 'keyId,op', 'rollover-finish': 'keyId,newKeyId,op' }
  if (typeof rest.op !== 'string' || KEYS[rest.op] !== Object.keys(rest).sort().join()) return bad()
  return { request: rest as Exclude<DnssecRequest, { op: 'read' }>, dsUpdated: dsUpdated === true }
}

export async function handleDnssecRoute(req: Request, url: URL, method: string, ports: DnssecPorts): Promise<Response | null> {
  const match = DNSSEC_ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return fail('VALIDATION', 'DNSSEC requests do not accept query selectors', unchanged)
  const zone = match[1]!, now = ports.now ?? (() => new Date())
  const authorize = async (): Promise<AuthenticatedCaller> => {
    const caller = await ports.requireCaller(req)
    const stored = await ports.store.getDnsZone(zone)
    if (!stored || stored.name !== zone) return fail('NOT_FOUND', 'zone not found', unchanged)
    if (stored.accountId === null) { await ports.assertRoot(caller, 'dns.dnssec'); return caller }
    const account = await ports.store.getAccount(stored.accountId)
    if (!account) return fail('NOT_FOUND', 'zone not found', unchanged)
    await ports.assertCanAccessAccount(caller, account, 'dns.dnssec')
    return caller
  }
  const first = await authorize()
  if (!ports.callAgent) return fail('PRECONDITION_FAILED', 'DNSSEC needs the protected host agent', { ...unchanged, reason: 'host_agent_unavailable' })
  const callAgent = ports.callAgent
  const path = join(ports.store.rootDir, 'extended', 'dns', 'dnssec', zone + '.json')
  const readRollovers = async (): Promise<DnssecRollover[]> => {
    const raw = await readJsonIfExists<unknown>(path)
    if (raw === null) return []
    if (!object(raw) || raw.zone !== zone || !Array.isArray(raw.rollovers) || raw.rollovers.length > 6 || raw.rollovers.some(item => !object(item) || !Number.isSafeInteger(item.keyId) || !Number.isSafeInteger(item.newKeyId)
      || !['KSK', 'ZSK', 'CSK'].includes(item.type as string) || typeof item.startedAt !== 'string' || typeof item.notBefore !== 'string' || !Number.isFinite(Date.parse(item.notBefore)))) return fail('PRECONDITION_FAILED', 'saved DNSSEC rollovers require review', { ...unchanged, reason: 'dnssec_rollover_review' })
    return raw.rollovers as DnssecRollover[]
  }
  const agent = async (caller: AuthenticatedCaller, body: unknown, mutation: boolean) => {
    let response: Response
    try { response = await callAgent('/dns/dnssec/' + zone, { caller, method: 'POST', body }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the protected host transport could not be verified', mutation ? uncertain : unchanged) }
    const text = await response.text()
    if (text.length > 256 * 1024) return fail('SERVICE_UNAVAILABLE', 'the DNSSEC host reply is too large', mutation ? uncertain : unchanged)
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return fail('SERVICE_UNAVAILABLE', 'the DNSSEC host reply could not be verified', mutation ? uncertain : unchanged) }
    if (!response.ok) {
      const detail = object(parsed) && object(parsed.details) ? parsed.details : {}
      const reason = typeof detail.reason === 'string' && REASONS.has(detail.reason) ? detail.reason : null
      const known = detail.stateChanged === false && detail.verificationRequired !== true
      const code = response.status === 403 ? 'FORBIDDEN' : response.status === 404 ? 'NOT_FOUND' : response.status === 422 ? 'VALIDATION' : response.status === 412 ? 'PRECONDITION_FAILED' : 'SERVICE_UNAVAILABLE'
      return fail(code, reason ? 'the DNS server refused the DNSSEC change' : 'the protected host request was refused', { ...(known || !mutation ? unchanged : uncertain), ...(reason ? { reason } : {}) })
    }
    try { return validateDnssecReply(parsed, zone) } catch { return fail('SERVICE_UNAVAILABLE', 'the DNSSEC host reply could not be verified', mutation ? uncertain : unchanged) }
  }
  const respond = (view: DnssecView, rollovers: DnssecRollover[]): Response => {
    const at = now().getTime()
    return json({ view, rollovers: rollovers.map(item => ({ ...item, ready: at >= Date.parse(item.notBefore) })) } satisfies DnssecWorkspaceView)
  }
  if (method === 'GET') {
    const { view } = await agent(first, { op: 'read' }, false)
    return respond(view, await readRollovers())
  }
  const text = await req.text()
  if (text.length > 4096) return fail('LIMIT_EXCEEDED', 'DNSSEC request is too large', unchanged)
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  const { request, dsUpdated } = parseDnssecBody(raw, zone)
  const lease = await ports.store.getWriterLock().acquire()
  let applied = false
  try {
    const before = await readRollovers()
    if (request.op === 'rollover-start' && before.some(item => item.keyId === request.keyId)) return fail('CONFLICT', 'this key is already being rolled over', { ...unchanged, reason: 'rollover_started' })
    if (request.op === 'rollover-finish') {
      const started = before.find(item => item.keyId === request.keyId && item.newKeyId === request.newKeyId)
      if (!started) return fail('PRECONDITION_FAILED', 'no rollover was started for these keys', { ...unchanged, reason: 'rollover_not_started' })
      if (now().getTime() < Date.parse(started.notBefore)) return fail('PRECONDITION_FAILED', 'resolver caches may still hold the old keys', { ...unchanged, reason: 'rollover_wait', notBefore: started.notBefore })
      if (started.type !== 'ZSK' && !dsUpdated) return fail('PRECONDITION_FAILED', 'confirm that the registrar publishes the new DS record first', { ...unchanged, reason: 'rollover_ds_unconfirmed' })
    }
    const fresh = await authorize()
    if (fresh.principal.id !== first.principal.id) return fail('CONFLICT', 'the signed-in caller changed', unchanged)
    await lease.assertFencingToken()
    applied = true
    const { view, addedKeyIds } = await agent(fresh, request, true)
    const present = new Set(view.keys.map(key => key.id))
    let rollovers = before.filter(item => present.has(item.keyId) && present.has(item.newKeyId))
    if (request.op === 'rollover-finish') rollovers = rollovers.filter(item => item.keyId !== request.keyId)
    if (request.op === 'rollover-start' && addedKeyIds.length === 1) {
      const old = view.keys.find(key => key.id === request.keyId)!, started = now()
      rollovers.push({ keyId: request.keyId, newKeyId: addedKeyIds[0]!, type: old.type, startedAt: started.toISOString(), notBefore: new Date(started.getTime() + (view.dnskeyTtl ?? 86_400) * 1000 + CACHE_MARGIN_MS).toISOString() })
    }
    if (JSON.stringify(rollovers) !== JSON.stringify(before)) {
      try { await atomicWriteJson(path, { zone, rollovers }, 0o640, () => lease.assertFencingToken()) }
      catch { return fail('SERVICE_UNAVAILABLE', 'the DNSSEC change was applied but the rollover record could not be saved', uncertain) }
    }
    return respond(view, rollovers)
  } catch (error) {
    if (applied && !isXpanelError(error)) return fail('SERVICE_UNAVAILABLE', 'the DNSSEC change outcome requires inspection', uncertain)
    throw error
  } finally { await lease.release() }
}
