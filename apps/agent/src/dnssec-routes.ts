import { fail } from '@xpanel/core'
import type { Account, FeatureList, Plan } from '@xpanel/core'
import { isServiceDetailZone } from '@xpanel/os'
import { parseDnssecRequest, readDnssecView, runDnssecChange } from './dnssec.ts'
import type { DnssecRun } from './dnssec.ts'

export interface DnssecCaller { principalId: string; actor: string; role: string; accountId: string | null; resellerId: string | null }
export interface DnssecRouteDeps {
  caller: DnssecCaller
  store: {
    getDnsZone(name: string): Promise<{ name: string; accountId: string | null } | null>
    getAccount(id: string): Promise<Account | null>
    withAccountLifecycleLease<T>(accountId: string, operation: (account: Account) => Promise<T>): Promise<T>
    getPlan(id: string): Promise<Plan | null>
    getFeatureList(id: string): Promise<FeatureList | null>
  }
  /** Direct local principal read, repeated before every host change. */
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  /** Native Linux executor only; null keeps DNSSEC unavailable instead of simulating PowerDNS. */
  run: DnssecRun | null
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; principalId: string }): Promise<unknown>
}
const ROUTE = /^\/dns\/dnssec\/([a-z0-9.-]{1,253})$/
const FEATURES = ['dnssec']
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const readBody = async (req: Request): Promise<unknown> => {
  const text = await req.text()
  if (text.length > 4096) return fail('LIMIT_EXCEEDED', 'DNSSEC request is too large', { stateChanged: false })
  try { return JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
}
// Root-owned zones have no account lease; their changes still run one at a time in this process.
const rootQueue = new Map<string, Promise<unknown>>()
const serialized = <T>(zone: string, task: () => Promise<T>): Promise<T> => {
  const next = (rootQueue.get(zone) ?? Promise.resolve()).catch(() => undefined).then(task)
  rootQueue.set(zone, next)
  return next.finally(() => { if (rootQueue.get(zone) === next) rootQueue.delete(zone) })
}

/** One zone's DNSSEC keys: the zone's account owner, its reseller or root; the plan must allow DNSSEC. */
export async function handleDnssecRoute(req: Request, url: URL, method: string, deps: DnssecRouteDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'DNSSEC requests do not accept query selectors', { stateChanged: false })
  const zone = match[1]!
  if (!isServiceDetailZone(zone)) return fail('VALIDATION', 'a lowercase zone name is required', { stateChanged: false })
  const request = parseDnssecRequest(await readBody(req))
  const run = deps.run
  if (!run) return fail('PRECONDITION_FAILED', 'DNSSEC needs the native Linux host executor', { stateChanged: false, reason: 'host_executor_unavailable' })
  const caller = deps.caller
  const stored = await deps.store.getDnsZone(zone)
  if (!stored || stored.name !== zone) return fail('NOT_FOUND', 'zone not found', { stateChanged: false })
  const authorize = async (account: Account | null): Promise<void> => {
    const principal = await deps.currentPrincipal()
    if (!principal || principal.disabled || principal.id !== caller.principalId || principal.kind !== caller.role) return fail('FORBIDDEN', 'the current DNS caller is unavailable', { stateChanged: false })
    if (principal.kind === 'root') return
    const owned = !!account && account.status === 'active' && (principal.kind === 'user' ? principal.accountId === account.id : principal.kind === 'reseller' && account.ownerId === principal.id)
    if (!owned) return fail('FORBIDDEN', 'the zone is not managed by this caller', { stateChanged: false })
    const plan = await deps.store.getPlan(account!.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
    if (!plan || !features || FEATURES.some(key => features.disabled.includes(key))) return fail('FORBIDDEN', 'DNSSEC is disabled by the account plan', { stateChanged: false })
  }
  const handle = async (account: Account | null): Promise<Response> => {
    await authorize(account)
    if (request.op === 'read') return json({ view: await readDnssecView(run, zone), addedKeyIds: [] })
    const result = await runDnssecChange(run, zone, request)
    try {
      await deps.audit({ actor: caller.actor, action: 'dns.dnssec.' + (request.op === 'key' ? 'key_' + request.verb : request.op.replace('-', '_')), target: 'zone:' + zone, principalId: caller.principalId, outcome: 'ok',
        detail: { ...('keyId' in request ? { keyId: request.keyId } : {}), ...('verb' in request ? { verb: request.verb } : {}), addedKeyIds: result.addedKeyIds, signing: result.view.signing } })
    } catch { return fail('SERVICE_UNAVAILABLE', 'the DNSSEC change was applied but its audit requires review', { stateChanged: true, verificationRequired: true }) }
    return json(result)
  }
  if (stored.accountId === null) return caller.role === 'root' ? serialized(zone, () => handle(null)) : fail('NOT_FOUND', 'zone not found', { stateChanged: false })
  const account = await deps.store.getAccount(stored.accountId)
  if (!account) return fail('NOT_FOUND', 'zone not found', { stateChanged: false })
  return deps.store.withAccountLifecycleLease(account.id, async fresh => {
    const current = await deps.store.getDnsZone(zone)
    if (!current || current.accountId !== fresh.id) return fail('CONFLICT', 'the zone owner changed', { stateChanged: false })
    return handle(fresh)
  })
}
