import { fail } from '@xpanel/core'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import type { AgentCallerIdentity } from './server.ts'

/**
 * Account view of the edge response policy that actually serves its sites: compression and the proxy
 * response cache, read from the managed Nginx main configuration. Per-site toggles and cache purge have
 * no reviewed renderer or confined purge provider, so they are reported unavailable rather than simulated.
 */
export const OPTIMIZE_FEATURE = 'optimize-website'
export interface SwEdgePolicy { compression: 'on' | 'off'; types: string[]; minLength: number | null; proxied: string[]; cache: { configured: boolean; maxSize: string | null } }
export interface SwOptimizeView {
  context: { accountId: string; username: string }
  state: 'read' | 'unavailable'; reason: null | 'edge-config-unavailable' | 'unmanaged-edge-config' | 'invalid-edge-config'
  policy: SwEdgePolicy | null
  domains: { name: string; redirect: boolean; suspended: boolean }[]
  actions: { siteCompression: false; siteCache: false; purge: false }
}
export interface SwOptimizeContext {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; listDomains(): Promise<Domain[]>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; withAccountLifecycleLease<T>(id: string, operation: (account: Account) => Promise<T>): Promise<T> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  /** Reads `<nginx root>/nginx.conf`; null off a qualified native Linux host. */
  readEdgeMain: (() => Promise<string | null>) | null
}
const unchanged = { stateChanged: false }
const invalid = (): never => { throw new Error('invalid_edge_config') }

/** ngx_http_gzip_module and ngx_http_proxy_module directive syntax, one directive per line as the panel renders it. */
export function parseEdgePolicy(text: string): SwEdgePolicy | 'unmanaged' {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024 || /\u0000/.test(text)) return invalid()
  if (!text.startsWith('# Managed by xPanel.')) return 'unmanaged'
  const found = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim(), match = /^(gzip|gzip_types|gzip_min_length|gzip_proxied|proxy_cache_path)\s+([^;]{1,2048});$/.exec(line)
    if (!match) continue
    if (found.has(match[1]!)) return invalid()
    found.set(match[1]!, match[2]!)
  }
  const gzip = found.get('gzip') ?? 'off'
  if (!['on', 'off'].includes(gzip)) return invalid()
  // gzip_module: text/html is always compressed in addition to gzip_types.
  const types = ['text/html', ...(found.get('gzip_types') ?? '').split(/\s+/).filter(Boolean)]
  if (types.length > 64 || types.some(type => !/^[a-z]+\/[a-z0-9.+-]{1,100}$/.test(type) && type !== '*')) return invalid()
  const min = found.get('gzip_min_length'), proxied = (found.get('gzip_proxied') ?? 'off').split(/\s+/)
  if (min !== undefined && !/^[0-9]{1,9}$/.test(min) || proxied.length > 10 || proxied.some(item => !['off', 'expired', 'no-cache', 'no-store', 'private', 'no_last_modified', 'no_etag', 'auth', 'any'].includes(item))) return invalid()
  const cache = found.get('proxy_cache_path'), size = cache ? /(?:^|\s)max_size=([0-9]{1,9}[kmgKMG]?)(?:\s|$)/.exec(cache)?.[1] ?? null : null
  return { compression: gzip as 'on' | 'off', types: [...new Set(types)], minLength: min === undefined ? null : Number(min), proxied, cache: { configured: cache !== undefined, maxSize: size } }
}

export async function handleSwOptimizeRoute(_req: Request, url: URL, method: string, ctx: SwOptimizeContext): Promise<Response | null> {
  const match = /^\/accounts\/([a-z][a-z0-9]{0,15})\/optimize$/.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'optimization reads do not accept selectors', unchanged)
  const caller = ctx.caller
  if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'website optimization requires the signed-in account owner', unchanged)
  const target = await ctx.store.getAccountByUsername(match[1]!)
  if (!target || target.id !== caller.accountId) return fail('FORBIDDEN', 'the account does not match the current owner', unchanged)
  return ctx.store.withAccountLifecycleLease(target.id, async account => {
    const authorize = async (): Promise<void> => {
      const principal = await ctx.currentPrincipal(), plan = await ctx.store.getPlan(account.planId), features = plan ? await ctx.store.getFeatureList(plan.featureListId) : null
      if (!principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== account.id || account.id !== caller.accountId || account.username !== match[1] || account.status !== 'active' || !features || features.disabled.includes(OPTIMIZE_FEATURE)) return fail('FORBIDDEN', 'current account owner is not authorized for website optimization', unchanged)
    }
    await authorize()
    const domains = (await ctx.store.listDomains()).filter(domain => domain.accountId === account.id)
    if (domains.length > 1000) return fail('PRECONDITION_FAILED', 'the domain inventory exceeds its bound', unchanged)
    let state: SwOptimizeView['state'] = 'unavailable', reason: SwOptimizeView['reason'] = 'edge-config-unavailable', policy: SwEdgePolicy | null = null
    if (ctx.readEdgeMain) {
      try {
        const text = await ctx.readEdgeMain()
        if (text !== null) { const parsed = parseEdgePolicy(text); if (parsed === 'unmanaged') reason = 'unmanaged-edge-config'; else { policy = parsed; state = 'read'; reason = null } }
      } catch { reason = 'invalid-edge-config' }
    }
    await authorize()
    const view: SwOptimizeView = { context: { accountId: account.id, username: account.username }, state, reason, policy,
      domains: domains.map(domain => ({ name: domain.name, redirect: !!domain.redirect, suspended: !!domain.suspended })).sort((a, b) => a.name.localeCompare(b.name, 'en')),
      actions: { siteCompression: false, siteCache: false, purge: false } }
    return new Response(JSON.stringify(view), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
  })
}
