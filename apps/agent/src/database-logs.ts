import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { posix } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import { parseMariadbBatch } from './mariadb-admin.ts'
import type { MariadbAdminClient } from './mariadb-admin.ts'
import { readLogs } from './host-monitoring.ts'
import type { MonitoringRun } from './host-monitoring.ts'

/** Service Logs: the MariaDB slow query log and error log, read-only, at the paths the running server reports. */
export const DATABASE_LOG_VARIABLES = ['slow_query_log', 'long_query_time', 'slow_query_log_file', 'log_error', 'log_output', 'datadir'] as const
export const DATABASE_LOG_VARIABLES_SQL = `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${DATABASE_LOG_VARIABLES.map(name => `'${name}'`).join(', ')})`
export const DATABASE_LOG_MAX_BYTES = 1024 * 1024
const MAX_ENTRIES = 200, SQL_MAX = 2000, MESSAGE_MAX = 2000, JOURNAL_LINES = 500
// A path MariaDB reports stays inside the package log directories or its data directory; anything else is never opened as root.
const LOG_ROOTS = ['/var/log/mysql/', '/var/log/mariadb/', '/var/lib/mysql/']
export type DatabaseLogKind = 'slow' | 'error'
export interface SlowQueryEntry { at: string | null; user: string; schema: string | null; queryTime: number; lockTime: number; rowsSent: number; rowsExamined: number; sql: string }
export interface DatabaseErrorEntry { at: string | null; level: 'error' | 'warning' | 'note' | null; message: string }
export interface DatabaseLogView {
  log: DatabaseLogKind; state: 'read' | 'unavailable'; reason: string | null; observedAt: string; source: 'file' | 'journal' | null; path: string | null
  sizeBytes: number | null; truncated: boolean; recording: { slowQueryLog: boolean; longQueryTime: number } | null; entries: (SlowQueryEntry | DatabaseErrorEntry)[]
}

const clip = (text: string, max: number): string => { const value = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '?'); return value.length > max ? value.slice(0, max - 3) + '...' : value }
const number = (line: string, name: string): number => { const match = new RegExp('(?:^|\\s)' + name + ': ([0-9.]+)').exec(line); return match ? Number(match[1]) : 0 }

/** MariaDB slow log entries, newest first. The header comments open an entry and SET timestamp carries its real time. */
export function parseSlowLog(text: string, max = MAX_ENTRIES): SlowQueryEntry[] {
  const entries: SlowQueryEntry[] = []
  let current: (SlowQueryEntry & { body: string[] }) | null = null
  const close = (): void => { if (current?.body.length) { const { body, ...entry } = current; entries.push({ ...entry, sql: clip(body.join('\n'), SQL_MAX) }) } current = null }
  for (const line of text.split('\n')) {
    if (line.startsWith('# Time:')) continue
    const user = /^# User@Host: (.{0,200})$/.exec(line)
    if (user) { close(); current = { at: null, user: clip(user[1]!, 200), schema: null, queryTime: 0, lockTime: 0, rowsSent: 0, rowsExamined: 0, sql: '', body: [] }; continue }
    if (!current) continue
    const open: SlowQueryEntry & { body: string[] } = current
    if (line.startsWith('#')) {
      const schema = /\bSchema: ([^\s]{1,64})/.exec(line)
      if (schema) open.schema = clip(schema[1]!, 64)
      if (line.includes('Query_time:')) { open.queryTime = number(line, 'Query_time'); open.lockTime = number(line, 'Lock_time'); open.rowsSent = number(line, 'Rows_sent'); open.rowsExamined = number(line, 'Rows_examined') }
      continue
    }
    const stamp = /^SET timestamp=([0-9]{1,12});$/.exec(line)
    if (stamp) { open.at = new Date(Number(stamp[1]) * 1000).toISOString(); continue }
    if (/^use [^\s;]{1,64};$/.test(line)) continue
    if (line) open.body.push(line)
  }
  close()
  return entries.reverse().slice(0, max)
}

const ERROR_LINE = /^(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}:\d{2}|\d{6}\s+\d{1,2}:\d{2}:\d{2})\s+(?:\d+\s+)?\[(Note|Warning|ERROR)\]\s+(.*)$/
export function parseErrorLine(line: string): DatabaseErrorEntry {
  const match = ERROR_LINE.exec(line)
  return match ? { at: match[1]!.replace(/\s+/, ' '), level: match[2]!.toLowerCase() as 'error' | 'warning' | 'note', message: clip(match[3]!, MESSAGE_MAX) } : { at: null, level: null, message: clip(line, MESSAGE_MAX) }
}

export function parseDatabaseLogVariables(stdout: string): Record<typeof DATABASE_LOG_VARIABLES[number], string> {
  const rows = new Map(parseMariadbBatch(stdout, 2).map(([name, value]) => [name!, value!]))
  if (DATABASE_LOG_VARIABLES.some(name => !rows.has(name))) throw new Error('invalid_database_log_variables')
  return Object.fromEntries(rows) as Record<typeof DATABASE_LOG_VARIABLES[number], string>
}

/** A relative name is under datadir (mariadbd(8)); the result must stay under a reviewed root. */
export function databaseLogPath(value: string, datadir: string): string | null {
  const path = posix.normalize(posix.isAbsolute(value) ? value : posix.join(datadir, value))
  return LOG_ROOTS.some(root => path.startsWith(root)) && path.length <= 512 ? path : null
}

export interface DatabaseLogFile { sizeBytes: number; text: string; truncated: boolean }
/** Last bytes of a regular file, opened without following a link; a cut first line is dropped. */
export async function readDatabaseLogTail(path: string): Promise<DatabaseLogFile | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (!handle) return null
  try {
    const [file, named] = await Promise.all([handle.stat(), lstat(path)])
    if (!file.isFile() || named.ino !== file.ino || named.dev !== file.dev) throw new Error('database_log_not_regular')
    const start = Math.max(0, file.size - DATABASE_LOG_MAX_BYTES), buffer = Buffer.alloc(file.size - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start), text = buffer.subarray(0, bytesRead).toString('utf8')
    return { sizeBytes: file.size, text: start > 0 ? text.slice(text.indexOf('\n') + 1) : text, truncated: start > 0 }
  } finally { await handle.close() }
}

export interface DatabaseLogPorts { mariadb: Pick<MariadbAdminClient, 'query'> | null; readTail: (path: string) => Promise<DatabaseLogFile | null>; run: MonitoringRun | null; unit: string; now?: () => Date }

export async function readDatabaseLog(log: DatabaseLogKind, ports: DatabaseLogPorts): Promise<DatabaseLogView> {
  const observedAt = (ports.now ?? (() => new Date()))().toISOString(), base = { log, observedAt, source: null, path: null, sizeBytes: null, truncated: false, recording: null, entries: [] }
  if (!ports.mariadb) return { ...base, state: 'unavailable', reason: 'mariadb_unavailable' }
  let variables: ReturnType<typeof parseDatabaseLogVariables>
  try { variables = parseDatabaseLogVariables(await ports.mariadb.query([DATABASE_LOG_VARIABLES_SQL])) }
  catch { return { ...base, state: 'unavailable', reason: 'mariadb_unavailable' } }
  const recording = { slowQueryLog: variables.slow_query_log === 'ON', longQueryTime: Number(variables.long_query_time) }, shared = { ...base, recording }
  if (log === 'slow' && !variables.log_output.split(',').includes('FILE')) return { ...shared, state: 'unavailable', reason: 'slow_log_not_in_a_file' }
  const reported = log === 'slow' ? variables.slow_query_log_file : variables.log_error
  // An empty log_error sends errors to stderr, which systemd keeps in the journal on Debian and Ubuntu.
  if (log === 'error' && reported === '') {
    if (!ports.run) return { ...shared, state: 'unavailable', reason: 'journal_unavailable' }
    const journal = await readLogs(ports.run, { unit: ports.unit, lines: JOURNAL_LINES, since: null, priority: null }, () => new Date(observedAt))
    if (journal.state !== 'read') return { ...shared, state: 'unavailable', reason: 'journal_unavailable' }
    return { ...shared, state: 'read', reason: null, source: 'journal', truncated: journal.truncated, entries: journal.items.flatMap(item => item.message === null ? [] : [{ ...parseErrorLine(item.message), at: item.at }]).slice(0, MAX_ENTRIES) }
  }
  const path = databaseLogPath(reported, variables.datadir)
  if (!path) return { ...shared, state: 'unavailable', reason: 'log_path_not_reviewed' }
  let file: DatabaseLogFile | null
  try { file = await ports.readTail(path) } catch { return { ...shared, state: 'unavailable', reason: 'log_unreadable', path } }
  if (!file) return { ...shared, state: 'read', reason: null, source: 'file', path, sizeBytes: 0 }
  const entries = log === 'slow' ? parseSlowLog(file.text) : file.text.split('\n').filter(Boolean).map(parseErrorLine).reverse().slice(0, MAX_ENTRIES)
  return { ...shared, state: 'read', reason: null, source: 'file', path, sizeBytes: file.sizeBytes, truncated: file.truncated, entries }
}

/** GET /host/logs/database?log=slow|error, root only; the path comes from the server, never the caller. */
export async function handleDatabaseLogRoute(req: Request, url: URL, method: string, ctx: DatabaseLogPorts & { assertRoot: (action: string) => Promise<unknown> }): Promise<Response | null> {
  if (url.pathname !== '/host/logs/database') return null
  await ctx.assertRoot('server.logs.database')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const log = url.searchParams.get('log')
  if (req.body !== null || [...url.searchParams.keys()].join() !== 'log' || log !== 'slow' && log !== 'error') return fail('VALIDATION', 'choose the slow or the error log', { stateChanged: false })
  try { return new Response(JSON.stringify(await readDatabaseLog(log, ctx)), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }) }
  catch (error) { if (isXpanelError(error)) throw error; return fail('SERVICE_UNAVAILABLE', 'the database log could not be read', { stateChanged: false }) }
}
