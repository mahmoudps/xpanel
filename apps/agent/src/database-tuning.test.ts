import { describe, expect, it, vi } from 'vitest'
import { MARIADB_ADMIN_VERSION_SQL } from '../../../packages/os/src/mariadb-admin-command.ts'
import { DATABASE_TUNING_STATUS, DATABASE_TUNING_STATUS_SQL, DATABASE_TUNING_VARIABLES, DATABASE_TUNING_VARIABLES_SQL, admitDatabaseTuning, buildDatabaseTuningView, handleDatabaseTuningRoute, isDatabaseTuningStatement, parseDatabaseTuningStatus, parseDatabaseTuningVariables, projectDatabaseTuningView, readDatabaseTuning } from './database-tuning.ts'
import type { DatabaseTuningRouteContext } from './database-tuning.ts'

const vars = { innodb_buffer_pool_size: 134217728, max_connections: 151, tmp_table_size: 16777216, max_heap_table_size: 16777216, table_open_cache: 2000, thread_cache_size: 151, slow_query_log: 'OFF', long_query_time: 10.25 }
const stats = Object.fromEntries(DATABASE_TUNING_STATUS.map(key => [key, key === 'Uptime' ? 500 : key === 'Uptime_since_flush_status' ? 400 : 1]))
const rows = (values: Record<string, unknown>): string => Object.entries(values).map(([name, value]) => name + '\t' + String(value) + '\n').join('')
const answer = (sql: string): string => sql === MARIADB_ADMIN_VERSION_SQL ? '10.11.9-MariaDB\n' : sql === DATABASE_TUNING_VARIABLES_SQL ? rows(vars) : rows(stats)
const clock = () => new Date('2026-10-27T12:00:00.000Z')

describe('database tuning fixed observations', () => {
  it('admits only the exact fixed read statements and passes SQL through the protected provider', async () => {
    for (const sql of [MARIADB_ADMIN_VERSION_SQL, DATABASE_TUNING_VARIABLES_SQL, DATABASE_TUNING_STATUS_SQL]) expect(isDatabaseTuningStatement(sql)).toBe(true)
    for (const sql of [DATABASE_TUNING_STATUS_SQL + ';', 'SET GLOBAL max_connections=1000', 'SHOW GLOBAL VARIABLES', '', null]) expect(isDatabaseTuningStatement(sql)).toBe(false)
    const query = vi.fn(async () => '')
    await admitDatabaseTuning({ query, socketPath: null })(DATABASE_TUNING_STATUS_SQL)
    expect(query).toHaveBeenCalledWith([DATABASE_TUNING_STATUS_SQL])
    await expect(admitDatabaseTuning({ query, socketPath: null })('DROP DATABASE production')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(query).toHaveBeenCalledTimes(1)
  })
  it('accepts complete named variables and status without order dependence', () => {
    expect(parseDatabaseTuningVariables(rows(vars))).toEqual(vars)
    expect(parseDatabaseTuningStatus(rows(stats))).toEqual(stats)
    expect(parseDatabaseTuningVariables(rows(Object.fromEntries(Object.entries(vars).reverse())))).toEqual(vars)
  })
  it('refuses partial, duplicate, unknown and malformed variables', () => {
    const missing = { ...vars } as Record<string, unknown>; delete missing.max_connections
    for (const value of [rows(missing), rows(vars) + 'max_connections\t20\n', rows({ ...vars, secret: 'value' }), rows({ ...vars, max_connections: 0 }), rows({ ...vars, long_query_time: -1 }), rows({ ...vars, slow_query_log: 'yes' }), rows(vars).replace('134217728', '9007199254740992'), rows(vars).trimEnd()]) expect(() => parseDatabaseTuningVariables(value)).toThrow()
  })
  it('refuses missing counters, negative counters, overflow and escaped control text', () => {
    const missing = { ...stats }; delete missing.Uptime
    for (const value of [rows(missing), rows({ ...stats, Connections: -1 }), rows({ ...stats, Questions: '1e9' }), rows({ ...stats, Questions: '9007199254740992' }), rows(stats).replace('Uptime\t500', 'Uptime\t5\\n0')]) expect(() => parseDatabaseTuningStatus(value)).toThrow()
  })
  it('reads sequentially, rechecks authority after every read and generates a nonmutating plan', async () => {
    const queries: string[] = [], authorize = vi.fn(async () => undefined)
    const result = await readDatabaseTuning(async sql => { queries.push(sql); return answer(sql) }, authorize, clock)
    expect(queries).toEqual([MARIADB_ADMIN_VERSION_SQL, DATABASE_TUNING_VARIABLES_SQL, DATABASE_TUNING_STATUS_SQL])
    expect(authorize).toHaveBeenCalledTimes(4)
    expect(result).toMatchObject({ state: 'read', observedAt: clock().toISOString(), capabilities: { apply: false }, plan: { kind: 'advisory', state: 'ready' } })
    expect(result.plan.checks.map(check => check.id)).toEqual(['connections', 'buffer-pool', 'temporary-tables', 'slow-log', 'table-cache', 'thread-cache'])
    expect(result.plan.checks[0]?.state).toBe('review')
    expect(result.plan.checks[1]?.state).toBe('observe')
    expect(result.plan.checks[3]?.evidence).toEqual([{ name: 'slow_query_log', value: 'OFF' }, { name: 'long_query_time', value: 10.25 }, { name: 'Slow_queries', value: 1 }])
    expect(projectDatabaseTuningView(result)).toEqual(result)
  })
  it('reports failed and partial reads without leaking provider messages', async () => {
    const result = await readDatabaseTuning(async sql => { if (sql === DATABASE_TUNING_VARIABLES_SQL) throw new Error('password-private'); return answer(sql) }, undefined, clock)
    expect(result.state).toBe('partial'); expect(result.variables).toBeNull()
    expect(result.plan.checks.every(check => check.state === 'unavailable' && check.evidence.length === 0)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('password-private')
    const offline = await readDatabaseTuning(null, undefined, clock)
    expect(offline).toMatchObject({ state: 'unavailable', status: null, variables: null, version: null, plan: { state: 'unavailable' } })
  })
  it('never catches a revocation as an unavailable observation or proceeds to the next query', async () => {
    const run = vi.fn(async (sql: string) => answer(sql))
    await expect(readDatabaseTuning(run, async () => { throw new Error('revoked') }, clock)).rejects.toThrow('revoked')
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('refuses invented plans, mutation capabilities and contradictory response states', async () => {
    const valid = await readDatabaseTuning(async sql => answer(sql), undefined, clock)
    for (const raw of [{ ...valid, capabilities: { apply: true } }, { ...valid, state: 'unavailable' }, { ...valid, extra: true }, { ...valid, plan: { ...valid.plan, checks: [] } }, { ...valid, status: { ...valid.status, Questions: -1 } }]) expect(() => projectDatabaseTuningView(raw)).toThrow()
    expect(buildDatabaseTuningView({ engine: 'mariadb', state: 'unavailable', observedAt: null, version: null, variables: null, status: null }).plan.state).toBe('unavailable')
  })
})

describe('database tuning root route', () => {
  const caller = { principalId: 'root-principal', actor: 'root', role: 'root' as const, accountId: null, resellerId: null }
  const setup = () => {
    const query = vi.fn(async (sql: readonly string[]) => answer(sql[0]!))
    const ctx: DatabaseTuningRouteContext = { caller, reauthenticate: vi.fn(async () => caller), assertRoot: vi.fn(async who => { if (who.role !== 'root') throw new Error('forbidden') }), mariadb: { query, socketPath: null }, now: clock }
    const call = (path = '/host/databases/tuning', method = 'GET') => { const url = new URL('http://agent.local' + path); return handleDatabaseTuningRoute(new Request(url, { method }), url, method, ctx) }
    return { ctx, query, call }
  }
  it('serves only the exact GET route and refuses selectors before provider work', async () => {
    const t = setup()
    expect(await t.call('/host/databases/other')).toBeNull()
    expect((await t.call('/host/databases/tuning', 'POST'))?.status).toBe(405)
    await expect(t.call('/host/databases/tuning?sql=SELECT%201')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(t.query).not.toHaveBeenCalled()
    const response = await t.call(); expect(response?.headers.get('cache-control')).toBe('no-store')
    if (!response) throw new Error('missing_tuning_response')
    const body = projectDatabaseTuningView(await response.json())
    expect(body.state).toBe('read')
  })
  it('blocks changed or non-root authority before reading and after an in-flight query', async () => {
    const changed = setup(); changed.ctx.reauthenticate = async () => ({ ...caller, principalId: 'different' })
    await expect(changed.call()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(changed.query).not.toHaveBeenCalled()
    const revoked = setup(); let calls = 0
    revoked.ctx.reauthenticate = async () => ++calls > 1 ? { ...caller, role: 'user' } : caller
    await expect(revoked.call()).rejects.toThrow('forbidden'); expect(revoked.query).toHaveBeenCalledTimes(1)
  })
})
