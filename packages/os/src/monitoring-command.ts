import { fail } from '@xpanel/core'
import { SUPPORTED_PHP_VERSIONS } from './php.ts'

/** Reviewed read-only monitoring observers plus one bounded signal grammar. No caller-selected binary, path or filter. */
// procps ps(1): a trailing `=` suppresses each header. No args/cmd column: arguments can carry secrets.
// `uid` is numeric because `user` falls back to a decimal id when the name exceeds the column width.
export const MONITORING_PS_ARGV = ['/usr/bin/ps', '-eo', 'pid=,ppid=,uid=,user=,pcpu=,pmem=,rss=,etimes=,stat=,comm='] as const
export const MONITORING_DF_SPACE_ARGV = ['/usr/bin/df', '-B1', '-P', '-T'] as const
export const MONITORING_DF_INODE_ARGV = ['/usr/bin/df', '-i', '-P'] as const
export const MONITORING_LOG_MAX_LINES = 500
export const MONITORING_LOG_DEFAULT_LINES = 100
/** Linux PID_MAX_LIMIT on 64-bit hosts. */
export const MONITORING_PID_MAX = 4_194_304
export const MONITORING_SIGNALS = ['TERM', 'KILL'] as const
export type MonitoringSignal = typeof MONITORING_SIGNALS[number]
export const MONITORING_LOG_UNITS: readonly string[] = Object.freeze([
  'nginx.service', 'apache2.service', 'httpd.service',
  ...SUPPORTED_PHP_VERSIONS.flatMap(version => [`php${version}-fpm.service`, `php${version.replace('.', '')}-php-fpm.service`]), 'php-fpm.service',
  'mariadb.service', 'postfix.service', 'postfix@-.service', 'dovecot.service', 'pdns.service',
  'xpanel-agent.service', 'xpanel-api.service', 'ssh.service', 'sshd.service', 'nftables.service',
])

export interface MonitoringLogQuery { unit: string; lines: number; since: string | null; priority: number | null }
export interface MonitoringSignalRequest { pid: number; uid: number; comm: string; startedAt: string; signal: MonitoringSignal }

const refuse = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const same = (left: readonly string[], right: readonly unknown[]): boolean => left.length === right.length && left.every((value, index) => value === right[index])
const ISO_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/

/** Exactly unit, optional lines (1..500), optional UTC ISO since and optional journal priority 0..7, each at most once. */
export function parseMonitoringLogQuery(params: URLSearchParams): MonitoringLogQuery {
  const keys = [...params.keys()]
  if (keys.some(key => !['unit', 'lines', 'since', 'priority'].includes(key)) || new Set(keys).size !== keys.length) return refuse('unsupported log selector')
  const unit = params.get('unit'), lines = params.get('lines'), since = params.get('since'), priority = params.get('priority')
  if (unit === null || !MONITORING_LOG_UNITS.includes(unit)) return refuse('the log unit is not in the reviewed list')
  if (lines !== null && (!/^[1-9][0-9]{0,2}$/.test(lines) || Number(lines) > MONITORING_LOG_MAX_LINES)) return refuse('log lines must be 1 to 500')
  if (priority !== null && !/^[0-7]$/.test(priority)) return refuse('log priority must be 0 to 7')
  let sinceIso: string | null = null
  if (since !== null) {
    const ms = ISO_MINUTE.test(since) ? Date.parse(since) : Number.NaN
    // Round-trip rejects calendar overflow such as February 30.
    if (!Number.isFinite(ms) || ms < 0 || ms >= Date.UTC(2200, 0, 1) || new Date(ms).toISOString().slice(0, 16) !== since.slice(0, 16)) return refuse('since must be a UTC ISO 8601 timestamp')
    sinceIso = new Date(Math.floor(ms / 1000) * 1000).toISOString()
  }
  return { unit, lines: lines === null ? MONITORING_LOG_DEFAULT_LINES : Number(lines), since: sinceIso, priority: priority === null ? null : Number(priority) }
}

/** Canonical selector forwarded from the API to the agent. */
export const monitoringLogSearch = (query: MonitoringLogQuery): string => {
  const params = new URLSearchParams({ unit: query.unit, lines: String(query.lines) })
  if (query.since !== null) params.set('since', query.since)
  if (query.priority !== null) params.set('priority', String(query.priority))
  return params.toString()
}

// journalctl(1): -o json prints one object per line; --output-fields keeps only the shown fields (never _CMDLINE);
// -p N keeps N and more severe; systemd.time(7) accepts @<epoch seconds>.
const JOURNAL_PREFIX = ['/usr/bin/journalctl', '--no-pager', '-o', 'json', '--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,_PID', '-n'] as const
export const monitoringJournalArgv = (query: MonitoringLogQuery): string[] => [
  ...JOURNAL_PREFIX, String(query.lines), '-u', query.unit,
  ...(query.since === null ? [] : ['--since', '@' + String(Date.parse(query.since) / 1000)]),
  ...(query.priority === null ? [] : ['-p', String(query.priority)]),
]

export function monitoringKillArgv(pid: number, signal: MonitoringSignal): string[] {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid > MONITORING_PID_MAX || !MONITORING_SIGNALS.includes(signal)) return refuse('unsupported process signal target')
  return ['/usr/bin/kill', '-s', signal, String(pid)]
}

/** TERM needs the reviewed row identity; KILL additionally needs its own explicit confirmation flag. */
export function parseMonitoringSignalRequest(value: unknown): MonitoringSignalRequest {
  if (!object(value)) return refuse('a process signal request object is required')
  const fields = value.signal === 'KILL' ? ['pid', 'uid', 'comm', 'startedAt', 'signal', 'killConfirmed'] : ['pid', 'uid', 'comm', 'startedAt', 'signal']
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) return refuse('unsupported process signal field')
  if (!MONITORING_SIGNALS.includes(value.signal as MonitoringSignal) || value.signal === 'KILL' && value.killConfirmed !== true) return refuse('TERM, or KILL with its separate confirmation, is required')
  if (!Number.isSafeInteger(value.pid) || Number(value.pid) < 2 || Number(value.pid) > MONITORING_PID_MAX || !Number.isSafeInteger(value.uid) || Number(value.uid) < 0 || Number(value.uid) > 4_294_967_295) return refuse('a bounded process and user id are required')
  if (typeof value.comm !== 'string' || value.comm.length < 1 || value.comm.length > 64 || /[\u0000-\u001f\u007f]/.test(value.comm)) return refuse('the reviewed command name is required')
  if (typeof value.startedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value.startedAt) || !Number.isFinite(Date.parse(value.startedAt)) || new Date(value.startedAt).toISOString() !== value.startedAt) return refuse('the reviewed process start time is required')
  return { pid: Number(value.pid), uid: Number(value.uid), comm: value.comm, startedAt: value.startedAt, signal: value.signal as MonitoringSignal }
}

const isJournalArgv = (argv: readonly string[]): boolean => {
  if (argv.length < 9 || !same(JOURNAL_PREFIX, argv.slice(0, 6)) || argv[7] !== '-u') return false
  const params = new URLSearchParams({ unit: argv[8]!, lines: argv[6]! })
  let index = 9
  if (argv[index] === '--since') {
    const value = argv[index + 1]
    if (value === undefined || !/^@[0-9]{1,12}$/.test(value)) return false
    params.set('since', new Date(Number(value.slice(1)) * 1000).toISOString()); index += 2
  }
  if (argv[index] === '-p') { if (argv[index + 1] === undefined) return false; params.set('priority', argv[index + 1]!); index += 2 }
  if (index !== argv.length) return false
  try { return same(monitoringJournalArgv(parseMonitoringLogQuery(params)), argv) } catch { return false }
}

/** Executor admission: exact observer argv, the bounded journal grammar, or one TERM/KILL to one pid. */
export function isMonitoringCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  const values = argv as readonly string[]
  if ([MONITORING_PS_ARGV, MONITORING_DF_SPACE_ARGV, MONITORING_DF_INODE_ARGV].some(expected => same(expected, values))) return true
  if (values.length === 4 && values[0] === '/usr/bin/kill' && values[1] === '-s' && /^[1-9][0-9]{0,6}$/.test(values[3]!)) {
    try { return same(monitoringKillArgv(Number(values[3]), values[2] as MonitoringSignal), values) } catch { return false }
  }
  return isJournalArgv(values)
}
