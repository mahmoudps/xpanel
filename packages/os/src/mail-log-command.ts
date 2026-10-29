/** Reviewed read-only journal grammar for Postfix delivery events. No caller-chosen flag, unit, path or field. */
export const JOURNALCTL = '/usr/bin/journalctl'
/** journalctl(1) -t matches SYSLOG_IDENTIFIER and may be repeated; Postfix daemons log as postfix/<service>. */
export const MAIL_LOG_IDENTIFIERS = ['postfix/smtp', 'postfix/lmtp', 'postfix/local', 'postfix/qmgr', 'postfix/smtpd', 'postfix/cleanup', 'postfix/bounce', 'postfix/error', 'postfix/virtual', 'postfix/pipe'] as const
// journalctl(1) --output-fields: json still prints __CURSOR, __REALTIME_TIMESTAMP, __MONOTONIC_TIMESTAMP and _BOOT_ID; this keeps 20000 records near 12 MiB.
// _EXE is a journald trusted field (systemd.journal-fields(7)); SYSLOG_IDENTIFIER is message text any local user can set with logger(1).
export const MAIL_LOG_OUTPUT_FIELDS = '--output-fields=MESSAGE,SYSLOG_IDENTIFIER,_EXE'
export const MAIL_LOG_MAX_LINES = 20000
export const MAIL_LOG_MAX_WINDOW_SECONDS = 7 * 24 * 60 * 60
export const MAIL_LOG_STATUSES = ['sent', 'deferred', 'bounced', 'expired', 'rejected', 'queued'] as const
export type MailLogStatus = typeof MAIL_LOG_STATUSES[number]
export interface MailLogFilters { sender?: string; recipient?: string; domain?: string; status?: MailLogStatus; dsn?: string }

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const JOURNAL_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/
const MAILBOX = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const FRAGMENT = /^[^\s\u0000-\u001f\u007f<>"]{1,254}$/

/** Whole-second UTC instant; the round trip rejects impossible calendar values. */
export const isMailLogInstant = (value: unknown): value is string =>
  typeof value === 'string' && INSTANT.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value.slice(0, 19) + '.000Z'
export const isMailLogMailbox = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && MAILBOX.test(value)
export const isMailLogWindow = (since: unknown, until: unknown): boolean => {
  if (!isMailLogInstant(since) || !isMailLogInstant(until)) return false
  const span = (Date.parse(until) - Date.parse(since)) / 1000
  return span > 0 && span <= MAIL_LOG_MAX_WINDOW_SECONDS
}
// systemd.time(7): "YYYY-MM-DD HH:MM:SS UTC" is an absolute timestamp in every supported systemd release.
const journalTime = (instant: string): string => instant.slice(0, 10) + ' ' + instant.slice(11, 19) + ' UTC'

export function mailLogArgv(since: string, until: string, limit: number): string[] {
  if (!isMailLogWindow(since, until) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAIL_LOG_MAX_LINES) throw new Error('unsupported_mail_log_query')
  return [JOURNALCTL, '--no-pager', '-o', 'json', MAIL_LOG_OUTPUT_FIELDS, '--since', journalTime(since), '--until', journalTime(until), '-n', String(limit), ...MAIL_LOG_IDENTIFIERS.flatMap(id => ['-t', id])]
}

export function isMailLogCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.length !== 11 + MAIL_LOG_IDENTIFIERS.length * 2 || argv.some(value => typeof value !== 'string')) return false
  const since = JOURNAL_TIME.exec(argv[6] as string), until = JOURNAL_TIME.exec(argv[8] as string)
  if (!since || !until || !/^[1-9][0-9]{0,4}$/.test(argv[10] as string)) return false
  try { return mailLogArgv(since[1] + 'T' + since[2] + 'Z', until[1] + 'T' + until[2] + 'Z', Number(argv[10])).every((value, index) => value === argv[index]) } catch { return false }
}

/** Search filters shared by the API boundary and the agent; values are compared, never interpolated into argv. */
export function parseMailLogFilters(get: (key: keyof MailLogFilters) => string | null): MailLogFilters {
  const filters: MailLogFilters = {}
  for (const key of ['sender', 'recipient'] as const) {
    const raw = get(key)
    if (raw === null) continue
    if (!FRAGMENT.test(raw)) throw new Error('invalid_mail_log_filter')
    filters[key] = raw.toLowerCase()
  }
  const domain = get('domain'), status = get('status'), dsn = get('dsn')
  if (domain !== null) { if (!DOMAIN.test(domain.toLowerCase())) throw new Error('invalid_mail_log_filter'); filters.domain = domain.toLowerCase() }
  if (status !== null) { if (!(MAIL_LOG_STATUSES as readonly string[]).includes(status)) throw new Error('invalid_mail_log_filter'); filters.status = status as MailLogStatus }
  if (dsn !== null) { if (!/^[245](?:\.[0-9]{1,3}){0,2}$/.test(dsn)) throw new Error('invalid_mail_log_filter'); filters.dsn = dsn }
  return filters
}
