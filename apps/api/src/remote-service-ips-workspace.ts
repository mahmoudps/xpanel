import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, validateRemoteServiceIps } from '@xpanel/core'
import { atomicWriteJson } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { REMOTE_SERVICE_IPS_STATE, readRemoteServiceIps } from '../../agent/src/remote-service-ips.ts'
import { SEC_DNS_CLUSTER_STATE, secRevision } from '../../agent/src/sec-policy.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

/** Remote Service IPs: GET/PUT the saved lists; a save reconciles mail and re-applies the PowerDNS drop-in. */
export interface RemoteServiceIpsHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir'>
  reconcile: (caller: AuthenticatedCaller) => Promise<{ body: Record<string, unknown> } | null>
  /** The agent's DNS cluster apply, which renders allow-axfr-ips from the cluster peers and these nameservers; absent without a host agent. */
  applyDns?: (caller: AuthenticatedCaller, expectedRevision: string) => Promise<unknown>
}

const ROUTE = '/api/server/remote-service-ips'
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export async function handleRemoteServiceIpsRoute(request: Request, url: URL, method: string, helpers: RemoteServiceIpsHelpers): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, method === 'GET' ? 'server.remote_service_ips.read' : 'server.remote_service_ips.save')
  if (method === 'GET') return json({ lists: await readRemoteServiceIps(helpers.store.rootDir) ?? { smtp: [], nameservers: [] } })
  if (method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  let body: unknown
  try { body = await request.json() } catch { return fail('VALIDATION', 'a JSON object body is required', { stateChanged: false }) }
  const lists = validateRemoteServiceIps(body)
  await atomicWriteJson(join(helpers.store.rootDir, REMOTE_SERVICE_IPS_STATE), lists)
  await helpers.emitAudit({ actor: caller.principal.username, action: 'server.remote_service_ips.saved', target: 'server:remote-service-ips', detail: { smtp: lists.smtp.length, nameservers: lists.nameservers.length }, outcome: 'ok', principalId: caller.principal.id })
  const mail = (await helpers.reconcile(caller))?.body ?? null
  let dns: unknown = null
  if (helpers.applyDns) {
    let raw: unknown = null
    try { raw = JSON.parse(await readFile(join(helpers.store.rootDir, SEC_DNS_CLUSTER_STATE), 'utf8')) } catch { raw = null }
    try { dns = await helpers.applyDns(caller, secRevision('dns-cluster', raw)) } catch (error) { dns = { refused: (error as { details?: { reason?: unknown } }).details?.reason ?? 'dns_apply_failed' } }
  }
  return json({ lists, reconcile: mail, dns })
}
