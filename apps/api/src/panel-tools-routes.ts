import { fail } from '@xpanel/core'
import type { Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { handleApiShellRoute } from './api-shell.ts'
import { handleConfigAsCodeRoute } from './config-as-code.ts'
import type { DeveloperWorkspaceHelpers } from './developer-workspace.ts'
import { handleErrorReportingRoute } from './error-reporting.ts'
import type { ErrorReporter } from './error-reporting.ts'
import { handleMetricsExportRoute } from './metrics-export.ts'
import { panelJson } from './panel-config-file.ts'

/** Root panel data and developer routes, mounted by one line in the API server. */
export const PANEL_TOOL_ROUTE = /^\/api\/(?:metrics|server\/(?:metrics-export|error-reporting(?:\/test)?|config-as-code\/(?:export|preview|apply)|panel-backups(?:\/[^/]+)?|application-projects(?:\/log)?|panel\/developer\/(?:functions|call|openapi))|account\/developer\/(?:functions|call|openapi))$/
export interface PanelToolsHelpers extends DeveloperWorkspaceHelpers {
  store: StateStore
  db: Db
  clientIp: (request: Request) => string | null
  reporter: ErrorReporter
  reconcile: (caller: AuthenticatedCaller) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> } | null>
  /** Protected agent read; a body makes it a POST. */
  callHost: (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>
  /** The agent's raw reply, for a streamed snapshot download. */
  streamHost: (caller: AuthenticatedCaller, path: string) => Promise<Response>
}

const unchanged = { stateChanged: false }
// A scrape every few seconds must not run systemctl each time.
let services: { at: number; rows: { name: string; up: boolean }[] } | null = null
const SERVICES_TTL_MS = 60_000
const readServices = async (helpers: PanelToolsHelpers, caller: AuthenticatedCaller): Promise<{ name: string; up: boolean }[]> => {
  if (services && Date.now() - services.at < SERVICES_TTL_MS) return services.rows
  const reply = await helpers.callHost(caller, '/host/services') as { services?: { id?: unknown; state?: unknown }[] }
  const rows = (reply.services ?? []).flatMap(row => typeof row.id === 'string' && row.state !== 'not-installed' && row.state !== 'unchecked' ? [{ name: row.id, up: row.state === 'active' }] : [])
  services = { at: Date.now(), rows }
  return rows
}

async function handlePanelBackups(request: Request, url: URL, method: string, helpers: PanelToolsHelpers): Promise<Response | null> {
  const file = /^\/api\/server\/panel-backups\/([^/]+)$/.exec(url.pathname)?.[1]
  if (url.pathname !== '/api/server/panel-backups' && !file) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, method === 'GET' ? 'server.panel_backups.read' : 'server.panel_backups.change')
  if (url.search) return fail('VALIDATION', 'panel backups accept no selectors', unchanged)
  if (file) {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const reply = await helpers.streamHost(caller, '/host/panel-backups/' + file)
    if (!reply.ok || !reply.body) return fail('NOT_FOUND', 'the snapshot could not be read', unchanged)
    return new Response(reply.body, { headers: { 'content-type': reply.headers.get('content-type') ?? 'application/octet-stream', ...(reply.headers.get('content-length') ? { 'content-length': reply.headers.get('content-length')! } : {}), 'content-disposition': reply.headers.get('content-disposition') ?? 'attachment', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  }
  if (method === 'GET') return panelJson(await helpers.callHost(caller, '/host/panel-backups'))
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const text = await request.text()
  if (text.length > 4 * 1024 * 1024) return fail('VALIDATION', 'the request is too large', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'the request must be valid JSON', unchanged) }
  return panelJson(await helpers.callHost(caller, '/host/panel-backups', body))
}

async function handleApplicationProjects(request: Request, url: URL, method: string, helpers: PanelToolsHelpers): Promise<Response | null> {
  const log = url.pathname === '/api/server/application-projects/log'
  if (!log && url.pathname !== '/api/server/application-projects') return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, method === 'GET' ? 'server.application_projects.read' : 'server.application_projects.change')
  if (log) {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const account = url.searchParams.get('account') ?? '', target = url.searchParams.get('target') ?? ''
    if ([...url.searchParams.keys()].sort().join() !== 'account,target' || !/^[a-z][a-z0-9]{0,15}$/.test(account) || !/^[a-z]{1,8}:[a-z0-9-]{1,32}$/.test(target)) return fail('VALIDATION', 'choose one project log', unchanged)
    return panelJson(await helpers.callHost(caller, '/host/application-projects/log?account=' + encodeURIComponent(account) + '&target=' + encodeURIComponent(target)))
  }
  if (url.search) return fail('VALIDATION', 'application projects accept no selectors', unchanged)
  if (method === 'GET') return panelJson(await helpers.callHost(caller, '/host/application-projects'))
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  const text = await request.text()
  let body: unknown
  try { body = text.length <= 65536 ? JSON.parse(text) : null } catch { body = null }
  if (!body || typeof body !== 'object') return fail('VALIDATION', 'choose one account and one operation', unchanged)
  return panelJson(await helpers.callHost(caller, '/host/application-projects', body))
}

export async function handlePanelToolsRoute(request: Request, url: URL, method: string, helpers: PanelToolsHelpers): Promise<Response | null> {
  return await handleMetricsExportRoute(request, url, method, { ...helpers, readServices: caller => readServices(helpers, caller) })
    ?? await handleErrorReportingRoute(request, url, method, helpers)
    ?? await handleConfigAsCodeRoute(request, url, method, helpers)
    ?? await handleApiShellRoute(request, url, method, helpers)
    ?? await handlePanelBackups(request, url, method, helpers)
    ?? await handleApplicationProjects(request, url, method, helpers)
}
