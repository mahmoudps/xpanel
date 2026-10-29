import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { AgentExecutor } from './executor.ts'
import { applySecDnsCluster, observeSecDnsCluster, secQuerySoa, verifySecDnsPeer } from './sec-dns-cluster.ts'
import type { SecListDir, SecQuerySoa } from './sec-dns-cluster.ts'
import { observeSecFlood } from './sec-flood.ts'
import { effectiveSecPolicy, SEC_DNS_CLUSTER_STATE, secRevision } from './sec-policy.ts'
import { observeSecWaf, secPresent, secReadText } from './sec-waf.ts'
import type { SecPresent, SecReadText } from './sec-waf.ts'

export interface SecAuditEntry { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }
export interface SecRouteContext {
  /** Re-authenticates the caller and requires root on every call. */
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Any authenticated, active principal: admits only the read-only WAF summary an account owner sees. */
  assertCaller?: () => Promise<void>
  /** Native Linux host executor only; null keeps every host read unavailable instead of simulating one. */
  executor: AgentExecutor | null
  os: { family: string; nginxConf: string; powerdnsUnit: string }
  rootDir: string
  zones: () => Promise<readonly string[]>
  audit?: (entry: SecAuditEntry) => Promise<unknown>
  present?: SecPresent
  readText?: SecReadText
  listDir?: SecListDir
  query?: SecQuerySoa
  now?: () => Date
}
const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; action: string }>> = {
  '/host/sec/waf': { method: 'GET', action: 'security.waf.read' },
  '/host/sec/flood': { method: 'GET', action: 'security.flood.read' },
  '/host/sec/dns-cluster': { method: 'GET', action: 'dns.cluster.read' },
  '/host/sec/dns-cluster/verify': { method: 'GET', action: 'dns.cluster.verify' },
  '/host/sec/dns-cluster/apply': { method: 'POST', action: 'dns.cluster.apply' },
}
const unchanged = { stateChanged: false }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const readSaved = async (root: string): Promise<unknown> => {
  let text: string
  try { text = await readFile(join(root, SEC_DNS_CLUSTER_STATE), 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return fail('PRECONDITION_FAILED', 'saved DNS cluster configuration is unreadable', unchanged) }
  try { return JSON.parse(text) } catch { return fail('PRECONDITION_FAILED', 'saved DNS cluster configuration is invalid', unchanged) }
}

/** Root-only WAF, flood and DNS cluster host routes. Peers and zones come from saved state, never from the request. */
export async function handleSecRoute(req: Request, url: URL, method: string, ctx: SecRouteContext): Promise<Response | null> {
  if (url.pathname === '/host/sec/waf/summary') {
    await (ctx.assertCaller ?? (() => ctx.assertRoot('security.waf.read')))()
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    if (url.search) return fail('VALIDATION', 'security routes accept no query selectors', unchanged)
    const executor = ctx.executor
    if (!executor) return fail('PRECONDITION_FAILED', 'security observations require the native Linux host executor', unchanged)
    return json(await observeSecWaf({ family: ctx.os.family, readNginxMain: () => executor.readFile(ctx.os.nginxConf), ...(ctx.present ? { present: ctx.present } : {}), ...(ctx.readText ? { readText: ctx.readText } : {}), ...(ctx.now ? { now: ctx.now } : {}) }))
  }
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname]! : null
  if (!route) return null
  const { actor } = await ctx.assertRoot(route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  const verify = url.pathname === '/host/sec/dns-cluster/verify', query = [...url.searchParams]
  if (verify ? query.length !== 1 || query[0]![0] !== 'peer' : url.search) return fail('VALIDATION', verify ? 'exactly one saved peer name is required' : 'security routes accept no query selectors', unchanged)
  const executor = ctx.executor
  if (!executor) return fail('PRECONDITION_FAILED', 'security observations require the native Linux host executor', unchanged)
  const now = ctx.now ?? (() => new Date()), present = ctx.present ?? secPresent, readText = ctx.readText ?? secReadText
  const confirm = async (): Promise<void> => { if ((await ctx.assertRoot(route.action)).actor !== actor) fail('FORBIDDEN', 'security authority changed', unchanged) }

  if (url.pathname === '/host/sec/waf') return json(await observeSecWaf({ family: ctx.os.family, readNginxMain: () => executor.readFile(ctx.os.nginxConf), present, readText, now }))
  if (url.pathname === '/host/sec/flood') return json(await observeSecFlood({ run: argv => executor.runCommand(argv), present, now }))
  const raw = await readSaved(ctx.rootDir), peers = effectiveSecPolicy('dns-cluster', raw).peers
  const dir = ctx.listDir ? { listDir: ctx.listDir } : {}
  if (url.pathname === '/host/sec/dns-cluster') return json(await observeSecDnsCluster({ family: ctx.os.family, peers, readText, ...dir, now }))
  if (verify) {
    const peer = peers.find(item => item.name === query[0]![1])
    if (!peer) return fail('NOT_FOUND', 'the peer is not in the saved cluster configuration', unchanged)
    return json(await verifySecDnsPeer({ peer, zones: await ctx.zones(), ...(ctx.query ? { query: ctx.query } : {}), now }))
  }
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', unchanged)
  const text = await req.text()
  let body: unknown
  try { body = text.length <= 256 ? JSON.parse(text) : null } catch { body = null }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'expectedRevision' || typeof (body as { expectedRevision?: unknown }).expectedRevision !== 'string') return fail('VALIDATION', 'only the expected saved revision is accepted', unchanged)
  if ((body as { expectedRevision: string }).expectedRevision !== secRevision('dns-cluster', raw)) return fail('CONFLICT', 'the saved cluster configuration changed; reload before applying', unchanged)
  const zones = await ctx.zones(), soa = ctx.query ?? secQuerySoa
  const target = 'dns:cluster'
  await ctx.audit?.({ actor, action: 'dns.cluster.apply_requested', target, outcome: 'ok', detail: { peers: peers.length } })
  try {
    const result = await applySecDnsCluster(peers, { family: ctx.os.family, powerdnsUnit: ctx.os.powerdnsUnit, readText, ...dir,
      writeFile: file => executor.writeFile(file), removePath: path => executor.removePath(path), runAction: action => executor.runAction(action),
      probe: async () => zones.length ? 'serial' in await soa('127.0.0.1', zones[0]!) : null, authorize: confirm })
    await ctx.audit?.({ actor, action: 'dns.cluster.applied', target, outcome: 'ok', detail: { outcome: result.outcome, peers: peers.length } }).catch(() => {})
    return json(result)
  } catch (error) {
    await ctx.audit?.({ actor, action: 'dns.cluster.applied', target, outcome: 'failed', detail: { peers: peers.length } }).catch(() => {})
    throw error
  }
}
