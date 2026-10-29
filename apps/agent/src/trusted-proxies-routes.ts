import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { applyTrustedProxyPolicy, observeTrustedProxies, readTrustedProxyRecord, TRUSTED_PROXY_STATE_PATH, trustedProxyRevision } from './trusted-proxies.ts'
import type { TrustedProxyNativeProvider } from './trusted-proxies.ts'

export interface TrustedProxiesRouteContext {
  /** Re-authenticates the current caller and requires root each time. */
  assertRoot: (action: string) => Promise<{ actor: string }>
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  /** Absent until native dedicated ingress, recovery and management probes are qualified. */
  provider: TrustedProxyNativeProvider | null
}
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unchanged = { stateChanged: false }
export async function handleTrustedProxiesRoute(request: Request, url: URL, method: string, ctx: TrustedProxiesRouteContext): Promise<Response | null> {
  if (url.pathname !== '/host/trusted-proxies' && url.pathname !== '/host/trusted-proxies/apply') return null
  const action = url.pathname.endsWith('/apply') ? 'server.trusted_proxies.apply' : 'server.trusted_proxies.read'
  const actor = await ctx.assertRoot(action)
  if (url.search) return fail('VALIDATION', 'trusted proxy operations accept no query selectors', unchanged)
  if (url.pathname === '/host/trusted-proxies' && method === 'GET') {
    const view = await observeTrustedProxies(ctx.provider)
    if ((await ctx.assertRoot(action)).actor !== actor.actor) return fail('FORBIDDEN', 'root authority changed', unchanged)
    return json(view)
  }
  if (url.pathname !== '/host/trusted-proxies/apply' || method !== 'POST') return new Response(null, { status: 405, headers: { allow: url.pathname.endsWith('/apply') ? 'POST' : 'GET' } })
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const text = await request.text()
  if (Buffer.byteLength(text) > 1024) return fail('VALIDATION', 'trusted proxy request is too large', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'valid JSON is required', unchanged) }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== 'expectedActiveRevision,expectedRevision') return fail('VALIDATION', 'only expectedRevision and expectedActiveRevision are accepted', unchanged)
  const input = body as Record<string, unknown>
  if ([input.expectedRevision, input.expectedActiveRevision].some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) return fail('VALIDATION', 'exact observed revisions are required', unchanged)
  const lease = await ctx.store.getWriterLock().acquire()
  try {
    const authorize = async (): Promise<void> => { const fresh = await ctx.assertRoot(action); if (fresh.actor !== actor.actor) fail('FORBIDDEN', 'root authority changed', unchanged); await lease.assertFencingToken() }
    await authorize()
    const raw = await readJsonIfExists<unknown>(join(ctx.store.rootDir, TRUSTED_PROXY_STATE_PATH)), record = readTrustedProxyRecord(raw)
    if (!record) return fail('PRECONDITION_FAILED', 'a valid saved proxy policy is required', unchanged)
    if (trustedProxyRevision(raw) !== input.expectedRevision) return fail('CONFLICT', 'saved proxy policy changed; reload before applying', unchanged)
    const active = await applyTrustedProxyPolicy(record.policy, input.expectedActiveRevision as string, ctx.provider, authorize)
    return json({ active, savedRevision: input.expectedRevision, stateChanged: true, verificationRequired: false })
  } finally { await lease.release() }
}
