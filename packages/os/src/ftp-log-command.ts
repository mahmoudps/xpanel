import { JOURNALCTL, isMailLogWindow } from './mail-log-command.ts'

/** Reviewed read-only journal grammar for pure-ftpd activity. No caller-chosen flag, unit, path or field. */
// pure-ftpd(8) logs through syslog(3) with the ident "pure-ftpd"; journalctl(1) -t matches SYSLOG_IDENTIFIER.
export const FTP_LOG_IDENTIFIER = 'pure-ftpd'
// _EXE and _SYSTEMD_UNIT are journald trusted fields (systemd.journal-fields(7)); SYSLOG_IDENTIFIER is text any local user can set with logger(1).
export const FTP_LOG_OUTPUT_FIELDS = '--output-fields=MESSAGE,SYSLOG_IDENTIFIER,_EXE,_SYSTEMD_UNIT'
export const FTP_LOG_MAX_LINES = 20000
export const FTP_LOG_KINDS = ['connect', 'login', 'login-failed', 'upload', 'download', 'delete', 'logout', 'timeout'] as const
export type FtpLogKind = typeof FTP_LOG_KINDS[number]
/** user and client are exact matches; text is a case-insensitive fragment of user, account, client or path. */
export interface FtpLogFilters { user?: string; client?: string; kind?: FtpLogKind; text?: string }

const JOURNAL_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/
const VALUE = /^[^\u0000-\u001f\u007f]{1,254}$/
const CLIENT = /^[0-9A-Za-z.:%_-]{1,253}$/
// systemd.time(7): "YYYY-MM-DD HH:MM:SS UTC" is an absolute timestamp in every supported systemd release.
const journalTime = (instant: string): string => instant.slice(0, 10) + ' ' + instant.slice(11, 19) + ' UTC'

/** Same whole-second UTC window grammar as the mail log (at most 7 days). */
export function ftpLogArgv(since: string, until: string, limit: number): string[] {
  if (!isMailLogWindow(since, until) || !Number.isSafeInteger(limit) || limit < 1 || limit > FTP_LOG_MAX_LINES) throw new Error('unsupported_ftp_log_query')
  return [JOURNALCTL, '--no-pager', '-o', 'json', FTP_LOG_OUTPUT_FIELDS, '--since', journalTime(since), '--until', journalTime(until), '-n', String(limit), '-t', FTP_LOG_IDENTIFIER]
}

export function isFtpLogCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.length !== 13 || argv.some(value => typeof value !== 'string')) return false
  const since = JOURNAL_TIME.exec(argv[6] as string), until = JOURNAL_TIME.exec(argv[8] as string)
  if (!since || !until || !/^[1-9][0-9]{0,4}$/.test(argv[10] as string)) return false
  try { return ftpLogArgv(since[1] + 'T' + since[2] + 'Z', until[1] + 'T' + until[2] + 'Z', Number(argv[10])).every((value, index) => value === argv[index]) } catch { return false }
}

/** Search filters shared by the API boundary and the agent; values are compared, never interpolated into argv. */
export function parseFtpLogFilters(get: (key: keyof FtpLogFilters) => string | null): FtpLogFilters {
  const filters: FtpLogFilters = {}
  const user = get('user'), client = get('client'), kind = get('kind'), text = get('text')
  if (user !== null) { if (!VALUE.test(user)) throw new Error('invalid_ftp_log_filter'); filters.user = user }
  if (client !== null) { if (!CLIENT.test(client)) throw new Error('invalid_ftp_log_filter'); filters.client = client.toLowerCase() }
  if (kind !== null) { if (!(FTP_LOG_KINDS as readonly string[]).includes(kind)) throw new Error('invalid_ftp_log_filter'); filters.kind = kind as FtpLogKind }
  if (text !== null) { if (!VALUE.test(text) || !text.trim()) throw new Error('invalid_ftp_log_filter'); filters.text = text.trim().toLowerCase() }
  return filters
}
