import { assertUpstream, fail } from '@xpanel/core'
import type { Account, Domain, ServerSettings } from '@xpanel/core'
import { edge } from '@xpanel/render'
import type { DomainMutationOptions, StateStore } from '@xpanel/state'
import { isMailboxPrincipal } from './authorization.ts'
import type { AuthenticatedCaller } from './auth.ts'

export const REVERSE_PROXY_ROUTE = /^\/api\/domains\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/reverse-proxy$/
export type ReverseProxyUpstreamCode = 'invalid' | 'not_loopback' | 'reserved_port'
export interface ReverseProxyPorts {
  store: Pick<StateStore, 'getDomain' | 'getAccount' | 'getServerSettings' | 'listDomains' | 'updateDomain'>
  requireCaller(req: Request): Promise<AuthenticatedCaller>
  assertCanAccessAccount(caller: AuthenticatedCaller, account: Account, action: string): Promise<void>
  readJsonBody(req: Request): Promise<Record<string, unknown>>
  /** server.ts mutateDomainWorkspace: public revision, fresh authority under the writer lease, journaled projection, apply, audit and unknown outcome. */
  mutateDomainWorkspace(req: Request, caller: AuthenticatedCaller, account: Account, expected: unknown, action: string,
    mutate: (options: DomainMutationOptions) => Promise<Domain>): Promise<{ value: Domain; reconcile: unknown; view: object }>
}

const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const refuse = (code: Parameters<typeof fail>[0], message: string, detail: Record<string, unknown> = {}): never => fail(code, message, { ...detail, stateChanged: false })
const upstreamField = (code: ReverseProxyUpstreamCode, message: string): never => refuse('VALIDATION', message, { fields: [{ field: 'upstream', code }] })

/**
 * No plan feature admits remote targets, so owners proxy only to IP-literal loopback. The edge
 * renderer's own reserved-port rule runs here too: an upstream it refuses would fail the shared Nginx render.
 */
export function assertReverseProxyUpstream(value: unknown, domain: Domain, settings: ServerSettings): string {
  let host: string
  try { assertUpstream(value); host = edge.parseUpstream(value).host }
  catch { return upstreamField('invalid', 'upstream must be http(s)://127.0.0.1:PORT or http(s)://[::1]:PORT with an optional path') }
  if (host !== '127.0.0.1' && host !== '::1') return upstreamField('not_loopback', 'only 127.0.0.1 and [::1] upstreams are available')
  try { edge.siteUpstream({ ...domain, siteType: 'proxy', upstream: value as string }, settings) }
  catch { return upstreamField('reserved_port', 'the upstream port must be 1024 or higher and not used by a server service') }
  return value as string
}

/** PUT switches one owned non-alias domain between proxy and php/static through the domain workspace update path. */
export async function handleReverseProxyRoute(req: Request, url: URL, method: string, ports: ReverseProxyPorts): Promise<Response | null> {
  const match = REVERSE_PROXY_ROUTE.exec(url.pathname)
  if (!match) return null
  const caller = await ports.requireCaller(req)
  if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller)) return refuse('FORBIDDEN', 'hosting account owner access is required')
  if (url.search) return refuse('VALIDATION', 'reverse proxy does not accept query selectors')
  if (method !== 'PUT') return refuse('VALIDATION', 'unsupported reverse proxy method')
  const body = await ports.readJsonBody(req), siteType = body.siteType
  if (siteType !== 'proxy' && siteType !== 'php' && siteType !== 'static') return refuse('VALIDATION', 'siteType must be proxy, php or static')
  const allowed = ['expectedRevision', 'siteType', ...(siteType === 'proxy' ? ['upstream'] : [])]
  if (Object.keys(body).some(key => !allowed.includes(key)) || !Object.hasOwn(body, 'expectedRevision') || (siteType === 'proxy') !== Object.hasOwn(body, 'upstream')) {
    return refuse('VALIDATION', 'reverse proxy changes take expectedRevision, siteType and, for proxy, upstream')
  }
  const domain = await ports.store.getDomain(match[1]!)
  // A neighbour's domain answers exactly like a missing one.
  if (!domain || domain.accountId !== caller.principal.accountId) return refuse('NOT_FOUND', 'domain not found')
  const account = await ports.store.getAccount(domain.accountId)
  if (!account) return refuse('NOT_FOUND', 'domain not found')
  await ports.assertCanAccessAccount(caller, account, 'domain.modify')
  if (domain.kind === 'alias') return refuse('VALIDATION', 'an alias follows the site type of the domain it points at')
  if (!['php', 'static', 'proxy'].includes(domain.siteType)) return refuse('VALIDATION', 'application sites keep their own upstream')
  if (domain.redirect) return refuse('PRECONDITION_FAILED', 'this domain redirects; its redirect takes precedence over a proxy', { reason: 'domain_redirect' })
  // updateDomain carries only docRoot to aliases, so a parent switch would leave its aliases on the old runtime.
  if ((await ports.store.listDomains({ accountId: account.id })).some(entry => entry.kind === 'alias' && entry.parentId === domain.id)) {
    return refuse('PRECONDITION_FAILED', 'domains with aliases cannot change their site type here', { reason: 'has_aliases' })
  }
  const settings = await ports.store.getServerSettings()
  if (!settings) return refuse('PRECONDITION_FAILED', 'server settings are unavailable', { reason: 'server_settings_unavailable' })
  const upstream = siteType === 'proxy' ? assertReverseProxyUpstream(body.upstream, domain, settings) : null
  if (domain.siteType === siteType && domain.upstream === upstream) return refuse('VALIDATION', 'there is no change to save', { fields: [{ field: 'siteType', code: 'unchanged' }] })
  const result = await ports.mutateDomainWorkspace(req, caller, account, body.expectedRevision, 'domain.updated',
    options => ports.store.updateDomain(domain.id, { siteType, upstream }, options))
  return json({ domain: result.value, stateChanged: true, ...result.view, reconcile: result.reconcile })
}
