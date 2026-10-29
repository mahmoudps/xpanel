import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { parseFtpLogFilters } from '../../../packages/os/src/ftp-log-command.ts'
import { isMailLogWindow } from '../../../packages/os/src/mail-log-command.ts'

export interface FtpLogWorkspaceHelpers {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  /** Protected agent GET /host/ftp/log with this already validated query; no command, unit or path is selectable. */
  readActivity: (caller: AuthenticatedCaller, query: string) => Promise<unknown>
  now?: () => Date
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Root FTP activity: whole-window summary, filtered events and the drill-down summary from one parsed pure-ftpd journal window. */
export async function handleFtpLogWorkspaceRoute(request: Request, url: URL, method: string, helpers: FtpLogWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== '/api/server/ftp-log/activity') return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.ftp-log.read')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  for (const key of new Set(url.searchParams.keys())) if (!['since', 'until', 'user', 'client', 'kind', 'text'].includes(key) || url.searchParams.getAll(key).length !== 1) fail('VALIDATION', 'unsupported or repeated FTP log selector', { stateChanged: false })
  let since = url.searchParams.get('since'), until = url.searchParams.get('until')
  // Both bounds, or neither for the latest 24 hours; at most 7 days, whole UTC seconds.
  if (since === null && until === null) {
    const end = Math.floor((helpers.now ?? (() => new Date()))().getTime() / 1000) * 1000, iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + 'Z'
    since = iso(end - DEFAULT_WINDOW_MS); until = iso(end)
  } else if (!isMailLogWindow(since, until)) return fail('VALIDATION', 'since and until must be whole-second UTC instants at most 7 days apart', { stateChanged: false })
  let filters: Record<string, string>
  try { filters = { ...parseFtpLogFilters(key => url.searchParams.get(key)) } } catch { return fail('VALIDATION', 'unsupported FTP log filter', { stateChanged: false }) }
  const body = await helpers.readActivity(caller, new URLSearchParams({ since: since!, until: until!, ...filters }).toString())
  if (!object(body) || body.scope !== 'server' || (body.state !== 'read' && body.state !== 'unavailable') || !Array.isArray(body.events) || !object(body.summary)) return fail('SERVICE_UNAVAILABLE', 'the FTP log observation could not be verified', { stateChanged: false })
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' } })
}
