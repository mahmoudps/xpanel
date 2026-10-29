import { isIP } from 'node:net'
import { assertProxyOptions, assertUpstream, fail, isXpanelError } from '@xpanel/core'
import type { Account, Domain, ProxyOptions, ServerSettings } from '@xpanel/core'
import { edge } from '@xpanel/render'
import type { DomainMutationOptions, StateStore } from '@xpanel/state'
import { isMailboxPrincipal } from './authorization.ts'
import type { AuthenticatedCaller } from './auth.ts'

export const REVERSE_PROXY_ROUTE = /^\/api\/domains\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/reverse-proxy$/
export type ReverseProxyUpstreamCode = 'invalid' | 'not_loopback' | 'reserved_port' | 'port_taken' | 'host_not_allowed' | 'resolver_unavailable'
export interface ReverseProxyPorts {
  store: Pick<StateStore, 'getDomain' | 'getAccount' | 'getServerSettings' | 'listDomains' | 'updateDomain'>
  requireCaller(req: Request): Promise<AuthenticatedCaller>
  assertCanAccessAccount(caller: AuthenticatedCaller, account: Account, action: string): Promise<void>
  readJsonBody(req: Request): Promise<Record<string, unknown>>
  /** Remote upstream hosts root allows on the Panel settings page; none means loopback only. */
  readAllowedRemoteHosts?(): Promise<readonly string[]>
  /** server.ts mutateDomainWorkspace: public revision, fresh authority under the writer lease, journaled projection, apply, audit and unknown outcome. */
  mutateDomainWorkspace(req: Request, caller: AuthenticatedCaller, account: Account, expected: unknown, action: string,
    mutate: (options: DomainMutationOptions) => Promise<Domain>): Promise<{ value: Domain; reconcile: unknown; view: object }>
}

const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const refuse = (code: Parameters<typeof fail>[0], message: string, detail: Record<string, unknown> = {}): never => fail(code, message, { ...detail, stateChanged: false })
const upstreamField = (code: ReverseProxyUpstreamCode, message: string): never => refuse('VALIDATION', message, { fields: [{ field: 'upstream', code }] })
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const loopbackPort = (upstream: string | null): number | null => {
  try { const u = upstream ? edge.parseUpstream(upstream) : null; return u && LOOPBACK.has(u.host) ? u.port : null } catch { return null }
}

/**
 * Owners proxy to IP-literal loopback, or to a remote host root allowed. Loopback ports are one namespace
 * for every tenant, so a port another account already proxies to is refused. The edge renderer's own
 * reserved-port and address-class rules run here too: an upstream it refuses would fail the shared Nginx render.
 */
export function assertReverseProxyUpstream(value: unknown, domain: Domain, settings: ServerSettings,
  context: { domains?: readonly Domain[]; allowedHosts?: readonly string[] } = {}): string {
  let host: string, port: number
  try { assertUpstream(value); ({ host, port } = edge.parseUpstream(value)) }
  catch { return upstreamField('invalid', 'upstream must be http(s)://HOST[:PORT] with an optional path, without credentials, query or spaces') }
  const local = host === '127.0.0.1' || host === '::1'
  if (host === 'localhost') return upstreamField('not_loopback', 'use 127.0.0.1 or [::1] for an application on this server')
  if (!local) {
    if (!(context.allowedHosts ?? []).some(allowed => allowed.toLowerCase() === host)) {
      return upstreamField('host_not_allowed', 'only 127.0.0.1, [::1] and the remote hosts the server administrator allowed are available')
    }
    if (isIP(host) === 0 && !(settings as ServerSettings & { edge?: { resolvers?: unknown[] } }).edge?.resolvers?.length) {
      return upstreamField('resolver_unavailable', 'this server has no DNS resolver for named upstream hosts; use the host IP address')
    }
  }
  try { edge.siteUpstream({ ...domain, siteType: 'proxy', upstream: value as string }, settings) }
  catch {
    return local ? upstreamField('reserved_port', 'the upstream port must be 1024 or higher and not used by a server service')
      : upstreamField('host_not_allowed', 'private, link-local and reserved addresses are not available')
  }
  if (local && (context.domains ?? []).some(other => other.accountId !== domain.accountId && loopbackPort(other.upstream) === port)) {
    return upstreamField('port_taken', 'another account already uses this local port')
  }
  return value as string
}

const DEFAULT_PROXY_OPTIONS: ProxyOptions = { websocket: true, hostHeader: 'client', headers: [] }
const sameOptions = (left: ProxyOptions | undefined, right: ProxyOptions | undefined): boolean =>
  JSON.stringify(left ?? DEFAULT_PROXY_OPTIONS) === JSON.stringify(right ?? DEFAULT_PROXY_OPTIONS)
const proxyOptions = (value: unknown): ProxyOptions => {
  try { return assertProxyOptions(value) }
  catch (error) {
    const what = isXpanelError(error) && typeof error.detail.what === 'string' ? error.detail.what : 'proxy'
    const field = what.startsWith('proxy.headers') ? 'headers' : what === 'proxy.websocket' ? 'websocket' : what === 'proxy.hostHeader' ? 'hostHeader' : 'proxy'
    return refuse('VALIDATION', isXpanelError(error) ? error.message : 'invalid proxy options', { fields: [{ field, code: 'invalid' }] })
  }
}

/** PUT switches one owned non-alias domain between proxy and php/static, with proxy options, through the domain workspace update path. */
export async function handleReverseProxyRoute(req: Request, url: URL, method: string, ports: ReverseProxyPorts): Promise<Response | null> {
  const match = REVERSE_PROXY_ROUTE.exec(url.pathname)
  if (!match) return null
  const caller = await ports.requireCaller(req)
  if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller)) return refuse('FORBIDDEN', 'hosting account owner access is required')
  if (url.search) return refuse('VALIDATION', 'reverse proxy does not accept query selectors')
  if (method !== 'PUT') return refuse('VALIDATION', 'unsupported reverse proxy method')
  const body = await ports.readJsonBody(req), siteType = body.siteType
  if (siteType !== 'proxy' && siteType !== 'php' && siteType !== 'static') return refuse('VALIDATION', 'siteType must be proxy, php or static')
  const allowed = ['expectedRevision', 'siteType', ...(siteType === 'proxy' ? ['upstream', 'proxy'] : [])]
  if (Object.keys(body).some(key => !allowed.includes(key)) || !Object.hasOwn(body, 'expectedRevision') || (siteType === 'proxy') !== Object.hasOwn(body, 'upstream')) {
    return refuse('VALIDATION', 'reverse proxy changes take expectedRevision, siteType and, for proxy, upstream and optional proxy options')
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
  const domains = await ports.store.listDomains()
  if (domains.some(entry => entry.accountId === account.id && entry.kind === 'alias' && entry.parentId === domain.id)) {
    return refuse('PRECONDITION_FAILED', 'domains with aliases cannot change their site type here', { reason: 'has_aliases' })
  }
  const settings = await ports.store.getServerSettings()
  if (!settings) return refuse('PRECONDITION_FAILED', 'server settings are unavailable', { reason: 'server_settings_unavailable' })
  const options = siteType !== 'proxy' ? undefined : body.proxy !== undefined ? proxyOptions(body.proxy) : domain.proxy
  const upstream = siteType === 'proxy'
    ? assertReverseProxyUpstream(body.upstream, domain, settings, { domains, allowedHosts: await ports.readAllowedRemoteHosts?.() ?? [] }) : null
  if (domain.siteType === siteType && domain.upstream === upstream && sameOptions(domain.proxy, options)) {
    return refuse('VALIDATION', 'there is no change to save', { fields: [{ field: 'siteType', code: 'unchanged' }] })
  }
  // Default options are stored as absence, so a plain proxy renders exactly as before options existed.
  const proxy = options && !sameOptions(options, undefined) ? options : undefined
  const result = await ports.mutateDomainWorkspace(req, caller, account, body.expectedRevision, 'domain.updated',
    mutation => ports.store.updateDomain(domain.id, { siteType, upstream, proxy }, mutation))
  return json({ domain: result.value, stateChanged: true, ...result.view, reconcile: result.reconcile })
}
