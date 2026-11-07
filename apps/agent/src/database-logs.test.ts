import { describe, expect, it, vi } from 'vitest'
import { DATABASE_LOG_VARIABLES_SQL, databaseLogPath, handleDatabaseLogRoute, parseErrorLine, parseSlowLog, readDatabaseLog } from './database-logs.ts'

const SLOW = `/usr/sbin/mariadbd, Version: 10.6.18-MariaDB (log). started with:
# Time: 261107 10:00:00
# User@Host: alice_app[alice_app] @ localhost []
# Thread_id: 8  Schema: alice_db  QC_hit: No
# Query_time: 2.500123  Lock_time: 0.000100  Rows_sent: 1  Rows_examined: 500
# Rows_affected: 0  Bytes_sent: 63
use alice_db;
SET timestamp=1794045600;
select sleep(2);
# User@Host: root[root] @ localhost []
# Thread_id: 9  Schema:   QC_hit: No
# Query_time: 3.000000  Lock_time: 0.000000  Rows_sent: 0  Rows_examined: 0
SET timestamp=1794045660;
update t
set a = 1;
`
const variables = (over: Record<string, string> = {}): string => Object.entries({ slow_query_log: 'ON', long_query_time: '2.000000', slow_query_log_file: '/var/log/mysql/mariadb-slow.log', log_error: '', log_output: 'FILE', datadir: '/var/lib/mysql/', ...over }).map(([key, value]) => key + '\t' + value).join('\n') + '\n'
const now = () => new Date('2026-11-07T10:00:00Z')

describe('database logs', () => {
  it('parses slow log entries newest first with their real time and whole statement', () => {
    const entries = parseSlowLog(SLOW)
    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({ user: 'alice_app[alice_app] @ localhost []', schema: 'alice_db', queryTime: 2.500123, rowsExamined: 500, sql: 'select sleep(2);', at: new Date(1794045600 * 1000).toISOString() })
    expect(entries[0]).toMatchObject({ queryTime: 3, sql: 'update t\nset a = 1;' })
  })
  it('classifies error log lines and keeps a line it cannot read', () => {
    expect(parseErrorLine('2026-11-07 10:00:00 0 [ERROR] InnoDB: Cannot open file')).toEqual({ at: '2026-11-07 10:00:00', level: 'error', message: 'InnoDB: Cannot open file' })
    expect(parseErrorLine('free text')).toEqual({ at: null, level: null, message: 'free text' })
  })
  it('opens only paths under the package log directories or the data directory', () => {
    expect(databaseLogPath('host-slow.log', '/var/lib/mysql/')).toBe('/var/lib/mysql/host-slow.log')
    expect(databaseLogPath('/var/log/mariadb/mariadb.log', '/var/lib/mysql/')).toBe('/var/log/mariadb/mariadb.log')
    for (const bad of ['/etc/shadow', '../../etc/shadow', '/var/log/mysql/../../../etc/shadow']) expect(databaseLogPath(bad, '/var/lib/mysql/')).toBeNull()
  })
  it('reads the slow log from the path the server reports and states the recording settings', async () => {
    const query = vi.fn(async () => variables()), readTail = vi.fn(async () => ({ sizeBytes: 900, text: SLOW, truncated: false }))
    const view = await readDatabaseLog('slow', { mariadb: { query }, readTail, run: null, unit: 'mariadb.service', now })
    expect(query).toHaveBeenCalledWith([DATABASE_LOG_VARIABLES_SQL]); expect(readTail).toHaveBeenCalledWith('/var/log/mysql/mariadb-slow.log')
    expect(view).toMatchObject({ state: 'read', source: 'file', recording: { slowQueryLog: true, longQueryTime: 2 }, sizeBytes: 900 }); expect(view.entries).toHaveLength(2)
  })
  it('reads an empty error setting from the journal and a file setting from the file', async () => {
    const run = vi.fn(async () => ({ ok: true, code: 0, stdout: JSON.stringify({ __REALTIME_TIMESTAMP: '1794045600000000', PRIORITY: '3', MESSAGE: '2026-11-07 10:00:00 0 [Warning] Aborted connection', _SYSTEMD_UNIT: 'mariadb.service', _PID: '10' }) + '\n', stderr: '' }))
    const view = await readDatabaseLog('error', { mariadb: { query: async () => variables() }, readTail: vi.fn(), run: run as never, unit: 'mariadb.service', now })
    expect(view).toMatchObject({ state: 'read', source: 'journal' }); expect(view.entries[0]).toMatchObject({ level: 'warning', message: 'Aborted connection' })
    const file = await readDatabaseLog('error', { mariadb: { query: async () => variables({ log_error: '/var/log/mariadb/mariadb.log' }) }, readTail: async () => ({ sizeBytes: 10, text: '2026-11-07 10:00:00 0 [Note] ready\n', truncated: true }), run: null, unit: 'mariadb.service', now })
    expect(file).toMatchObject({ source: 'file', path: '/var/log/mariadb/mariadb.log', truncated: true })
  })
  it('stays truthful when nothing can be read', async () => {
    const base = { readTail: vi.fn(), run: null, unit: 'mariadb.service', now }
    expect(await readDatabaseLog('slow', { ...base, mariadb: null })).toMatchObject({ state: 'unavailable', reason: 'mariadb_unavailable' })
    expect(await readDatabaseLog('slow', { ...base, mariadb: { query: async () => { throw new Error('down') } } })).toMatchObject({ state: 'unavailable', reason: 'mariadb_unavailable' })
    expect(await readDatabaseLog('slow', { ...base, mariadb: { query: async () => variables({ log_output: 'TABLE' }) } })).toMatchObject({ state: 'unavailable', reason: 'slow_log_not_in_a_file' })
    expect(await readDatabaseLog('slow', { ...base, mariadb: { query: async () => variables({ slow_query_log_file: '/etc/shadow' }) } })).toMatchObject({ state: 'unavailable', reason: 'log_path_not_reviewed' })
    expect(base.readTail).not.toHaveBeenCalled()
    expect(await readDatabaseLog('slow', { ...base, readTail: async () => null, mariadb: { query: async () => variables({ slow_query_log: 'OFF' }) } })).toMatchObject({ state: 'read', sizeBytes: 0, entries: [], recording: { slowQueryLog: false } })
  })
  it('accepts one reviewed selector only', async () => {
    const ctx = { assertRoot: async () => undefined, mariadb: null, readTail: vi.fn(), run: null, unit: 'mariadb.service', now }
    const call = (query: string, method = 'GET') => { const url = new URL('http://agent/host/logs/database' + query); return handleDatabaseLogRoute(new Request(url, { method }), url, method, ctx) }
    await expect(call('?log=general')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('?log=slow&path=/etc/shadow')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call('?log=slow', 'POST'))!.status).toBe(405)
    expect(await (await call('?log=error'))!.json()).toMatchObject({ state: 'unavailable' })
  })
})
