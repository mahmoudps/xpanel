import { gzipSync } from 'node:zlib'
import { fail } from '@xpanel/core'
import { isMailLogInstant, isMailLogWindow } from '../../../packages/os/src/mail-log-command.ts'
import { observeFtpLog } from './ftp-log.ts'
import type { FtpLogEvent, FtpLogRun, FtpLogState } from './ftp-log.ts'

/** WHM Raw FTP Log Download: pure-ftpd keeps no per-domain file, so the journal window is cut down to one domain's logins. */
export interface FtpRawLogState extends FtpLogState {
  domains: readonly { name: string; accountId: string; kind?: string }[]
  server: { settings: { ftp?: { enabled: boolean } } } | null
}
export interface FtpRawLogContext {
  assertRoot: (action: string) => Promise<unknown>
  readState: () => Promise<FtpRawLogState>
  /** Null without a native Linux executor; needs a >= 16 MiB output buffer. */
  run: FtpLogRun | null
  now?: () => Date
}
const DOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
const clean = (value: string): string => value.replace(/[\u0000- \u007f-\u009f]/g, '?')

/** A login is user@domain; an event with no login (a bare connection) belongs to no domain and is left out. */
export const ftpEventsForDomain = (events: readonly FtpLogEvent[], domain: string): FtpLogEvent[] => events.filter(event => event.user?.toLowerCase().endsWith('@' + domain))
export const ftpRawLogLine = (event: FtpLogEvent): string => [event.at, clean(event.client), clean(event.user ?? '-'), event.kind, event.bytes ?? '-', clean(event.path ?? '-')].join(' ')

/** GET /host/ftp/log/raw?domain=&since=&until=, root only, a gzip of plain text. */
export async function handleFtpRawLogRoute(req: Request, url: URL, method: string, ctx: FtpRawLogContext): Promise<Response | null> {
  if (url.pathname !== '/host/ftp/log/raw') return null
  await ctx.assertRoot('server.ftp-log.raw')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (req.body !== null || [...url.searchParams.keys()].sort().join() !== 'domain,since,until') return fail('VALIDATION', 'a raw FTP log takes one domain and a time window', { stateChanged: false })
  const domain = url.searchParams.get('domain')!, since = url.searchParams.get('since'), until = url.searchParams.get('until')
  if (!DOMAIN.test(domain) || !isMailLogInstant(since) || !isMailLogInstant(until) || !isMailLogWindow(since, until)) return fail('VALIDATION', 'a saved domain and a whole-second UTC window of at most 7 days are required', { stateChanged: false })
  const state = await ctx.readState()
  if (state.server?.settings.ftp?.enabled === false) return fail('SERVICE_DISABLED', 'the FTP service is disabled on this server', { stateChanged: false })
  if (!state.domains.some(item => item.name === domain)) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
  const observation = await observeFtpLog({ run: ctx.run, readState: async () => state, since, until, ...(ctx.now ? { now: ctx.now } : {}) })
  if (observation.state !== 'read') return fail('SERVICE_UNAVAILABLE', 'the FTP journal could not be read', { stateChanged: false, reason: observation.reason })
  const lines = ftpEventsForDomain(observation.events, domain).map(ftpRawLogLine)
  return new Response(gzipSync(lines.length ? lines.join('\n') + '\n' : ''), { headers: { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${domain}.ftp.log.gz"`, 'cache-control': 'no-store' } })
}
