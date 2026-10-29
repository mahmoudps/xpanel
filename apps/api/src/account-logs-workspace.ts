import { fail, isXpanelError } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { ACCOUNT_LOG_FEATURES, LOG_LINE_MAX_CHARS, LOG_TAIL_MAX_BYTES, LOG_TAIL_MAX_LINES, parseAccessLogLine, parseErrorLogLine } from '../../agent/src/account-logs.ts'
import type { AccessLogEntry, AccountLogKind, AccountLogView, ErrorLogEntry } from '../../agent/src/account-logs.ts'

export const ACCOUNT_LOGS_ROUTE = /^\/api\/account\/logs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(access|error)$/
export type AccountLogsPorts = AccountSshPorts
export interface AccountLogsProjection {
  context: AccountLogView['context']; file: AccountLogView['file']; limits: AccountLogView['limits']; observedAt: string
  entries: AccessLogEntry[] | ErrorLogEntry[]; unparsedLines: number
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const int = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min

/** Pins the agent tail to the owned domain and its bounds, then parses each line for the browser. */
export function projectAccountLogs(raw: unknown, account: Account, domain: Domain, kind: AccountLogKind): AccountLogsProjection {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'protected log reply is invalid')
  if (!object(raw) || !object(raw.context) || !object(raw.file) || !object(raw.limits) || !Array.isArray(raw.lines)) return bad()
  const { context, file, limits } = raw
  if (context.accountId !== account.id || context.domainId !== domain.id || context.domainName !== domain.name || context.kind !== kind || typeof context.site !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(context.site)
    || typeof file.exists !== 'boolean' || !int(file.sizeBytes) || typeof file.truncated !== 'boolean' || !(file.mtime === null || typeof file.mtime === 'string' && Number.isFinite(Date.parse(file.mtime))) || !file.exists && (file.sizeBytes !== 0 || raw.lines.length !== 0)
    || limits.maxBytes !== LOG_TAIL_MAX_BYTES || limits.maxLines !== LOG_TAIL_MAX_LINES || !int(limits.linesDropped) || raw.lines.length > LOG_TAIL_MAX_LINES || raw.lines.some(line => typeof line !== 'string' || line.length > LOG_LINE_MAX_CHARS + 1 || /[\r\n]/.test(line))
    || typeof raw.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.observedAt))) return bad()
  const lines = raw.lines as string[]
  const entries = kind === 'access' ? lines.map(parseAccessLogLine).filter((entry): entry is AccessLogEntry => entry !== null) : lines.map(parseErrorLogLine)
  return { context: { accountId: account.id, domainId: domain.id, domainName: domain.name, site: context.site, kind },
    file: { exists: file.exists, sizeBytes: file.sizeBytes, mtime: file.mtime as string | null, truncated: file.truncated }, limits: { maxBytes: LOG_TAIL_MAX_BYTES, maxLines: LOG_TAIL_MAX_LINES, linesDropped: limits.linesDropped },
    observedAt: raw.observedAt, entries, unparsedLines: kind === 'access' ? lines.length - entries.length : entries.filter(entry => (entry as ErrorLogEntry).time === null).length }
}

/** GET only. The domain must belong to the signed-in owner; its log path is resolved by the agent. */
export async function handleAccountLogsRoute(req: Request, url: URL, method: string, ports: AccountLogsPorts): Promise<Response | null> {
  const match = ACCOUNT_LOGS_ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'log reads do not accept selectors; filter in the page', { stateChanged: false })
  const domainId = match[1]!, kind = match[2] as AccountLogKind
  const { caller, account } = await authorizeAccountOwner(ports, req, [ACCOUNT_LOG_FEATURES[kind][0]], 'Site logs')
  const domain = await ports.store.getDomain(domainId)
  if (!domain || domain.accountId !== account.id) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
  const raw = await ports.readAgent(caller, '/accounts/' + account.username + '/logs/' + domain.id + '/' + kind)
  try { return workspaceJson(projectAccountLogs(raw, account, domain, kind)) }
  catch (error) { if (isXpanelError(error) && error.code !== 'CONFIG_TEST_FAILED') throw error; return fail('SERVICE_UNAVAILABLE', 'the protected log read could not be verified', { stateChanged: false }) }
}
