import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'

export interface WhmLogToolsHelpers {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  /** Protected agent GET with an already validated query. */
  readHost: (caller: AuthenticatedCaller, path: string) => Promise<unknown>
  /** Raw agent response for the gzip download. */
  callAgent: (caller: AuthenticatedCaller, path: string) => Promise<Response>
  emitAudit: (entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok'; principalId: string }, scope: { accountId: string | null; resellerId: string | null }) => Promise<unknown>
  now?: () => Date
}

const ROUTES: Readonly<Record<string, string>> = {
  '/api/server/logs/security-analysis': 'server.logs.security-analysis', '/api/server/logs/database': 'server.logs.database', '/api/server/ftp-log/raw': 'server.ftp-log.raw',
}
const DOMAIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HOURS = new Set(['1', '6', '24', '72', '168'])
const only = (url: URL, ...keys: string[]): boolean => { const seen = [...url.searchParams.keys()].sort(); return seen.join() === [...keys].sort().join() && new Set(seen).size === seen.length }
const unchanged = { stateChanged: false }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' } })

/** Root reads on the WHM Logs page: access log security analysis, MariaDB logs and the raw FTP log of one domain. */
export async function handleWhmLogToolsRoute(request: Request, url: URL, method: string, helpers: WhmLogToolsHelpers): Promise<Response | null> {
  const action = ROUTES[url.pathname]
  if (!action) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.pathname === '/api/server/logs/security-analysis') {
    const domainId = url.searchParams.get('domainId')
    if (!only(url, 'domainId') || !domainId || !DOMAIN_ID.test(domainId)) return fail('VALIDATION', 'choose one site', unchanged)
    return json(await helpers.readHost(caller, '/host/logs/security-analysis?domainId=' + domainId))
  }
  if (url.pathname === '/api/server/logs/database') {
    const log = url.searchParams.get('log')
    if (!only(url, 'log') || log !== 'slow' && log !== 'error') return fail('VALIDATION', 'choose the slow or the error log', unchanged)
    return json(await helpers.readHost(caller, '/host/logs/database?log=' + log))
  }
  const domain = url.searchParams.get('domain'), hours = url.searchParams.get('hours')
  if (!only(url, 'domain', 'hours') || !domain || !/^[a-z0-9.-]{1,253}$/.test(domain) || !hours || !HOURS.has(hours)) return fail('VALIDATION', 'choose a domain and a time range', unchanged)
  const end = Math.floor((helpers.now ?? (() => new Date()))().getTime() / 1000) * 1000, iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + 'Z'
  const response = await helpers.callAgent(caller, '/host/ftp/log/raw?' + new URLSearchParams({ domain, since: iso(end - Number(hours) * 3_600_000), until: iso(end) }).toString())
  if (!response.ok || !response.body) {
    const problem = await response.json().catch(() => null) as { code?: unknown } | null
    return fail(response.status === 404 ? 'NOT_FOUND' : problem?.code === 'SERVICE_DISABLED' ? 'SERVICE_DISABLED' : response.status === 400 ? 'VALIDATION' : 'SERVICE_UNAVAILABLE', 'the raw FTP log could not be read', unchanged)
  }
  await helpers.emitAudit({ actor: caller.principal.username, action: 'server.ftp-log.raw_downloaded', target: 'domain:' + domain, detail: { hours: Number(hours) }, outcome: 'ok', principalId: caller.principal.id }, { accountId: null, resellerId: null })
  return new Response(response.body, { headers: { 'content-type': 'application/gzip', 'content-disposition': response.headers.get('content-disposition') ?? 'attachment', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })
}
