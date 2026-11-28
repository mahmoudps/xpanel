import { describe, expect, it, vi } from 'vitest'
import { MARIADB_ADMIN_VERSION_SQL } from '../../../packages/os/src/mariadb-admin-command.ts'
import {
  DATABASE_TUNING_BOUNDS, DATABASE_TUNING_STATUS, DATABASE_TUNING_STATUS_SQL, DATABASE_TUNING_VARIABLES,
  DATABASE_TUNING_VARIABLES_SQL, MARIADB_TUNING_DROPIN_DEBIAN, admitDatabaseTuning, applyDatabaseTuning,
  buildDatabaseTuningView, dropInRevisionOf, handleDatabaseTuningMutationRoute, handleDatabaseTuningRoute,
  isDatabaseTuningStatement, parseDatabaseTuningStatus, parseDatabaseTuningVariables, previewDatabaseTuning,
  projectDatabaseTuningView, readDatabaseTuning, renderDatabaseTuningDropIn, rollbackDatabaseTuning,
  validateDatabaseTuningSettings,
} from './database-tuning.ts'
import type { DatabaseTuningRollbackRecord, DatabaseTuningRollbackStore, DatabaseTuningRouteContext } from './database-tuning.ts'
import type { DbServiceHost } from './db-service-files.ts'

const vars = { innodb_buffer_pool_size: 134217728, max_connections: 151, tmp_table_size: 16777216, max_heap_table_size: 16777216, table_open_cache: 2000, thread_cache_size: 151, slow_query_log: 'OFF', long_query_time: 10.25 }
const stats = Object.fromEntries(DATABASE_TUNING_STATUS.map(key => [key, key === 'Uptime' ? 500 : key === 'Uptime_since_flush_status' ? 400 : 1]))
const rows = (values: Record<string, unknown>): string => Object.entries(values).map(([name, value]) => name + '\t' + String(value) + '\n').join('')
const answer = (sql: string): string => sql === MARIADB_ADMIN_VERSION_SQL ? '10.11.9-MariaDB\n' : sql === DATABASE_TUNING_VARIABLES_SQL ? rows(vars) : sql === 'SELECT 1' ? '1\n' : rows(stats)
const clock = () => new Date('2026-10-27T12:00:00.000Z')

describe('database tuning fixed observations', () => {
  it('admits only the exact fixed read statements and passes SQL through the protected provider', async () => {
    for (const sql of [MARIADB_ADMIN_VERSION_SQL, DATABASE_TUNING_VARIABLES_SQL, DATABASE_TUNING_STATUS_SQL, 'SELECT 1']) expect(isDatabaseTuningStatement(sql)).toBe(true)
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
  it('reads sequentially, rechecks authority after every read and builds an apply-capable view', async () => {
    const queries: string[] = [], authorize = vi.fn(async () => undefined)
    const result = await readDatabaseTuning(async sql => { queries.push(sql); return answer(sql) }, authorize, clock)
    expect(queries).toEqual([MARIADB_ADMIN_VERSION_SQL, DATABASE_TUNING_VARIABLES_SQL, DATABASE_TUNING_STATUS_SQL])
    expect(authorize).toHaveBeenCalledTimes(4)
    expect(result).toMatchObject({ state: 'read', observedAt: clock().toISOString(), capabilities: { apply: true }, plan: { kind: 'advisory', state: 'ready' } })
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
  it('refuses invented plans, forged revisions and contradictory response states', async () => {
    const valid = await readDatabaseTuning(async sql => answer(sql), undefined, clock)
    for (const raw of [
      { ...valid, capabilities: { apply: false } },
      { ...valid, state: 'unavailable' },
      { ...valid, extra: true },
      { ...valid, plan: { ...valid.plan, checks: [] } },
      { ...valid, status: { ...valid.status, Questions: -1 } },
      { ...valid, dropIn: { ...valid.dropIn, revision: '0'.repeat(64) } },
    ]) expect(() => projectDatabaseTuningView(raw)).toThrow()
    expect(buildDatabaseTuningView({ engine: 'mariadb', state: 'unavailable', observedAt: null, version: null, variables: null, status: null }).plan.state).toBe('unavailable')
  })
})

describe('database tuning bounds, preview, apply and rollback', () => {
  const caller = { principalId: 'root-principal', actor: 'root', role: 'root' as const, accountId: null, resellerId: null }
  const makeFixture = (initialDropIn: string | null = null) => {
    const files = new Map<string, string>()
    if (initialDropIn !== null) files.set(MARIADB_TUNING_DROPIN_DEBIAN, initialDropIn)
    let backup: DatabaseTuningRollbackRecord | null = null
    const rollbackStore: DatabaseTuningRollbackStore = {
      async read() { return backup },
      async write(record) { backup = record },
      async clear() { backup = null },
    }
    const host: DbServiceHost = {
      async readFile(path) { return files.get(path) ?? null },
      async writeFile(file) { files.set(file.path, file.content) },
    }
    const removeFile = vi.fn(async (path: string) => { files.delete(path) })
    const commands: string[][] = []
    let configOk = true, restartOk = true, pingOk = true
    const run = vi.fn(async (argv: readonly string[]) => {
      commands.push([...argv])
      if (argv[0] === '/usr/sbin/mariadbd') return { ok: configOk, code: configOk ? 0 : 1, stdout: '', stderr: configOk ? '' : 'unknown variable' }
      if (argv[0] === '/usr/bin/systemctl') return { ok: restartOk, code: restartOk ? 0 : 1, stdout: '', stderr: restartOk ? '' : 'failed' }
      return { ok: false, code: 1, stdout: '', stderr: 'unexpected' }
    })
    const query = vi.fn(async (sql: readonly string[]) => {
      if (sql[0] === 'SELECT 1') {
        if (!pingOk) throw new Error('mariadb down')
        return '1\n'
      }
      return answer(sql[0]!)
    })
    const ctx: DatabaseTuningRouteContext = {
      caller,
      reauthenticate: vi.fn(async () => caller),
      assertRoot: vi.fn(async who => { if (who.role !== 'root') throw new Error('forbidden') }),
      mariadb: { query, socketPath: null },
      now: clock,
      family: 'debian',
      host,
      run,
      removeFile,
      rollbackStore,
      sleep: async () => undefined,
    }
    return {
      files,
      commands,
      ctx,
      setOutcome(opts: { configOk?: boolean; restartOk?: boolean; pingOk?: boolean }) {
        if (opts.configOk !== undefined) configOk = opts.configOk
        if (opts.restartOk !== undefined) restartOk = opts.restartOk
        if (opts.pingOk !== undefined) pingOk = opts.pingOk
      },
      getBackup: () => backup,
      removeFile,
    }
  }

  it('enforces safe numeric bounds on all tuning parameters', () => {
    const valid = validateDatabaseTuningSettings({
      innodb_buffer_pool_size: 268_435_456,
      max_connections: 250,
      tmp_table_size: 33_554_432,
      max_heap_table_size: 33_554_432,
      table_open_cache: 4000,
      thread_cache_size: 64,
      innodb_log_file_size: 134_217_728,
      query_cache_type: 0,
      slow_query_log: 1,
      long_query_time: 1.5,
    })
    expect(valid.max_connections).toBe(250)
    expect(renderDatabaseTuningDropIn(valid)).toContain('innodb_log_file_size = 134217728')
    expect(() => validateDatabaseTuningSettings({})).toThrow()
    expect(() => validateDatabaseTuningSettings({ unknown_var: 1 })).toThrow()
    expect(() => validateDatabaseTuningSettings({ max_connections: DATABASE_TUNING_BOUNDS.max_connections.min - 1 })).toThrow()
    expect(() => validateDatabaseTuningSettings({ max_connections: DATABASE_TUNING_BOUNDS.max_connections.max + 1 })).toThrow()
    expect(() => validateDatabaseTuningSettings({ innodb_buffer_pool_size: 1024 })).toThrow()
    expect(() => validateDatabaseTuningSettings({ query_cache_type: 3 })).toThrow()
    expect(() => validateDatabaseTuningSettings({ max_connections: 100.5 })).toThrow()
    expect(() => validateDatabaseTuningSettings({ long_query_time: 0 })).toThrow()
  })

  it('previews validated drop-in diff, applies atomically with health check and supports explicit rollback', async () => {
    const f = makeFixture()
    const settings = { innodb_buffer_pool_size: 268_435_456, max_connections: 200 }
    const preview = await previewDatabaseTuning({ settings }, f.ctx)
    expect(preview.path).toBe(MARIADB_TUNING_DROPIN_DEBIAN)
    expect(preview.changed).toBe(true)
    expect(preview.diff).toContain('+ innodb_buffer_pool_size = 268435456')
    expect(f.files.has(MARIADB_TUNING_DROPIN_DEBIAN)).toBe(false)

    await expect(applyDatabaseTuning({ settings, expectedRevision: 'bad-revision' }, f.ctx)).rejects.toMatchObject({ code: 'CONFLICT' })
    const applied = await applyDatabaseTuning({ settings, expectedRevision: preview.currentRevision }, f.ctx)
    expect(applied.applied).toBe(true)
    expect(applied.rollbackAvailable).toBe(true)
    expect(f.files.get(MARIADB_TUNING_DROPIN_DEBIAN)).toBe(applied.content)
    expect(f.commands).toEqual([['/usr/sbin/mariadbd', '--verbose', '--help'], ['/usr/bin/systemctl', 'restart', '--', 'mariadb.service']])

    const rolled = await rollbackDatabaseTuning({ expectedRevision: applied.revision }, f.ctx)
    expect(rolled.rolledBack).toBe(true)
    expect(rolled.restoredExisted).toBe(false)
    expect(f.removeFile).toHaveBeenCalledWith(MARIADB_TUNING_DROPIN_DEBIAN)
    expect(f.files.has(MARIADB_TUNING_DROPIN_DEBIAN)).toBe(false)
    expect(f.getBackup()).toBeNull()
  })

  it('automatically rolls back if MariaDB fails config check or fails to answer ping', async () => {
    const previous = '# previous\n[mysqld]\nmax_connections = 120\n'
    const f = makeFixture(previous)
    let failedOnce = false
    const run = f.ctx.run!
    f.ctx.run = vi.fn(async argv => {
      if (argv[0] === '/usr/bin/systemctl' && !failedOnce) {
        failedOnce = true
        return { ok: false, code: 1, stdout: '', stderr: 'restart failed' }
      }
      return run(argv)
    })
    await expect(applyDatabaseTuning({ settings: { max_connections: 300 }, expectedRevision: dropInRevisionOf(previous) }, f.ctx))
      .rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', detail: { stateChanged: false, restored: true, reason: 'tuning_apply_rejected' } })
    expect(f.files.get(MARIADB_TUNING_DROPIN_DEBIAN)).toBe(previous)

    const f2 = makeFixture()
    let queries = 0
    f2.ctx.mariadb = {
      socketPath: null,
      query: vi.fn(async sql => {
        if (sql[0] === 'SELECT 1') {
          queries++
          if (queries <= 20) throw new Error('still down')
          return '1\n'
        }
        return answer(sql[0]!)
      }),
    }
    await expect(applyDatabaseTuning({ settings: { max_connections: 300 }, expectedRevision: dropInRevisionOf(null) }, f2.ctx))
      .rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', detail: { stateChanged: false, restored: true } })
    expect(f2.files.has(MARIADB_TUNING_DROPIN_DEBIAN)).toBe(false)
  })
})

describe('database tuning root route', () => {
  const caller = { principalId: 'root-principal', actor: 'root', role: 'root' as const, accountId: null, resellerId: null }
  const setup = () => {
    const files = new Map<string, string>()
    const query = vi.fn(async (sql: readonly string[]) => answer(sql[0]!))
    const run = vi.fn(async () => ({ ok: true, code: 0, stdout: '', stderr: '' }))
    const ctx: DatabaseTuningRouteContext = {
      caller,
      reauthenticate: vi.fn(async () => caller),
      assertRoot: vi.fn(async who => { if (who.role !== 'root') throw new Error('forbidden') }),
      mariadb: { query, socketPath: null },
      now: clock,
      host: { async readFile(p) { return files.get(p) ?? null }, async writeFile(f) { files.set(f.path, f.content) } },
      run,
      removeFile: async p => { files.delete(p) },
      sleep: async () => undefined,
    }
    const call = (path = '/host/databases/tuning', method = 'GET', body?: unknown) => {
      const url = new URL('http://agent.local' + path)
      return handleDatabaseTuningRoute(new Request(url, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, method, ctx)
    }
    return { ctx, query, call }
  }
  it('serves GET and POST preview/apply/rollback routes and refuses selectors before provider work', async () => {
    const t = setup()
    expect(await t.call('/host/databases/other')).toBeNull()
    expect(await handleDatabaseTuningMutationRoute(new Request('http://agent.local/host/databases/tuning'), new URL('http://agent.local/host/databases/tuning'), 'GET', t.ctx)).toBeNull()
    expect((await t.call('/host/databases/tuning', 'POST'))?.status).toBe(405)
    expect((await t.call('/host/databases/tuning/apply', 'GET'))?.status).toBe(405)
    await expect(t.call('/host/databases/tuning?sql=SELECT%201')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(t.query).not.toHaveBeenCalled()

    const response = await t.call(); expect(response?.headers.get('cache-control')).toBe('no-store')
    const body = projectDatabaseTuningView(await response!.json())
    expect(body.state).toBe('read')
    expect(body.capabilities.apply).toBe(true)

    const previewRes = await t.call('/host/databases/tuning/preview', 'POST', { settings: { max_connections: 250 } })
    const preview = await previewRes!.json() as { currentRevision: string; diff: string }
    expect(preview.diff).toContain('+ max_connections = 250')

    const applyRes = await t.call('/host/databases/tuning/apply', 'POST', { settings: { max_connections: 250 }, expectedRevision: preview.currentRevision })
    const applied = await applyRes!.json() as { applied: boolean; revision: string }
    expect(applied.applied).toBe(true)

    const rollRes = await t.call('/host/databases/tuning/rollback', 'POST', { expectedRevision: applied.revision })
    expect(await rollRes!.json()).toMatchObject({ rolledBack: true })
  })
  it('blocks changed or non-root authority before reading and after an in-flight query', async () => {
    const changed = setup(); changed.ctx.reauthenticate = async () => ({ ...caller, principalId: 'different' })
    await expect(changed.call()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(changed.query).not.toHaveBeenCalled()
    const revoked = setup(); let calls = 0
    revoked.ctx.reauthenticate = async () => ++calls > 1 ? { ...caller, role: 'user' } : caller
    await expect(revoked.call()).rejects.toThrow('forbidden'); expect(revoked.query).toHaveBeenCalledTimes(1)
  })
})
