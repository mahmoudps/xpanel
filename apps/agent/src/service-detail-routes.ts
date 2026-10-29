import { fail } from '@xpanel/core'
import { checkDnsZone, readCertificatesServiceDetail, readDnsServiceDetail, readFtpServiceDetail } from './service-detail.ts'
import type { ServiceDetailHost, ServiceDetailState } from './service-detail.ts'
import { isServiceDetailZone } from '../../../packages/os/src/service-detail-command.ts'

export interface ServiceDetailRouteContext {
  /** Re-authenticates the current caller and requires root on every call. */
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Null when this agent is not running with the native Linux host executor. */
  host: ServiceDetailHost | null
  readState: () => Promise<ServiceDetailState>
  now?: () => Date
}

const ROUTE = /^\/host\/services\/detail\/(dns|ftp|certificates|dns\/zone-check)$/
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Root-only, read-only service detail observations. Restarts stay on the existing /host/services/<id>/restart route. */
export async function handleServiceDetailRoute(_req: Request, url: URL, method: string, ctx: ServiceDetailRouteContext): Promise<Response | null> {
  const kind = ROUTE.exec(url.pathname)?.[1]
  if (!kind) return null
  await ctx.assertRoot(kind === 'dns/zone-check' ? 'host.services.dns.check' : 'host.services.detail')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const keys = [...url.searchParams.keys()], zone = url.searchParams.get('zone')
  if (kind === 'dns/zone-check' ? keys.length !== 1 || keys[0] !== 'zone' || !isServiceDetailZone(zone) : url.search) return fail('VALIDATION', kind === 'dns/zone-check' ? 'exactly one canonical zone is required' : 'service detail routes do not accept selectors', { stateChanged: false })
  if (!ctx.host) return fail('PRECONDITION_FAILED', 'service detail requires the native Linux host executor', { stateChanged: false })
  const input = { host: ctx.host, readState: ctx.readState, ...(ctx.now ? { now: ctx.now } : {}) }
  if (kind === 'dns') return json(await readDnsServiceDetail(input))
  if (kind === 'ftp') return json(await readFtpServiceDetail(input))
  if (kind === 'certificates') return json(await readCertificatesServiceDetail(input))
  let state: ServiceDetailState
  try { state = await ctx.readState() } catch { return fail('PRECONDITION_FAILED', 'saved DNS state could not be read', { stateChanged: false }) }
  if (!state.zones.some(item => item.name === zone)) return fail('NOT_FOUND', 'the zone is not rendered by xPanel', { stateChanged: false })
  return json(await checkDnsZone({ run: ctx.host.run, zone: zone!, ...(ctx.now ? { now: ctx.now } : {}) }))
}
