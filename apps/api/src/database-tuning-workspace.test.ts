import { describe, expect, it, vi } from 'vitest'
import { buildDatabaseTuningView, DATABASE_TUNING_STATUS } from '../../agent/src/database-tuning.ts'
import { handleDatabaseTuningWorkspaceRoute } from './database-tuning-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { DatabaseTuningWorkspaceHelpers } from './database-tuning-workspace.ts'

const caller = { principal: { id: 'root-principal', username: 'root', kind: 'root' }, sessionId: 'session', apiTokenId: null } as AuthenticatedCaller
const view = buildDatabaseTuningView({ engine: 'mariadb', state: 'read', observedAt: '2026-10-27T12:00:00.000Z', version: '10.11.9-MariaDB', variables: { innodb_buffer_pool_size: 134217728, max_connections: 151, tmp_table_size: 16777216, max_heap_table_size: 16777216, table_open_cache: 2000, thread_cache_size: 151, slow_query_log: 'OFF', long_query_time: 10 }, status: Object.fromEntries(DATABASE_TUNING_STATUS.map(key => [key, 1])) as any })
const setup = () => {
  const audit = vi.fn(async () => undefined)
  const callHost = vi.fn(async (_c: AuthenticatedCaller, path: string, body: unknown) => ({ ok: true, path, body }))
  const helpers: DatabaseTuningWorkspaceHelpers = {
    requireCaller: vi.fn(async () => caller),
    assertRoot: vi.fn(async who => { if (who.principal.kind !== 'root') throw new Error('forbidden') }),
    readHost: vi.fn(async () => view),
    callHost,
    emitAudit: audit as never,
  }
  const call = (path = '/api/server/databases/tuning', method = 'GET', body?: unknown) => {
    const url = new URL('http://api.local' + path)
    return handleDatabaseTuningWorkspaceRoute(new Request(url, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, method, helpers)
  }
  return { helpers, audit, callHost, call }
}

describe('database tuning API', () => {
  it('projects the exact protected observation and sends no SQL or client selectors', async () => {
    const t = setup(), response = await t.call()
    expect(await response!.json()).toEqual(view)
    expect(t.helpers.readHost).toHaveBeenCalledWith(caller, '/host/databases/tuning')
    expect(t.helpers.requireCaller).toHaveBeenCalledTimes(2)
    expect(response?.headers.get('cache-control')).toBe('no-store')
  })
  it('rejects methods and query selectors without calling the host', async () => {
    const t = setup()
    expect(await t.call('/api/server/databases/other')).toBeNull()
    expect((await t.call(undefined, 'POST'))?.status).toBe(405)
    expect((await t.call('/api/server/databases/tuning/apply', 'GET'))?.status).toBe(405)
    await expect(t.call('/api/server/databases/tuning?profile=large')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(t.call('/api/server/databases/tuning/apply?x=1', 'POST', { settings: { max_connections: 200 }, expectedRevision: 'rev' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(t.helpers.readHost).not.toHaveBeenCalled()
    expect(t.callHost).not.toHaveBeenCalled()
  })
  it('returns truthful unavailable data for malformed, injected and failed host observations', async () => {
    for (const input of [{ ...view, capabilities: { apply: false } }, { ...view, plan: { kind: 'advisory', state: 'ready', checks: [] } }, { ...view, variables: { ...view.variables, max_connections: -1 } }, { state: 'read', password: 'private' }]) {
      const t = setup(); t.helpers.readHost = async () => input
      const body = await (await t.call())!.json()
      expect(body).toMatchObject({ state: 'unavailable', observedAt: null, capabilities: { apply: false }, plan: { state: 'unavailable' } })
      expect(JSON.stringify(body)).not.toContain('private')
    }
    const t = setup(); t.helpers.readHost = async () => { throw new Error('secret provider error') }
    expect((await (await t.call())!.json()).state).toBe('unavailable')
  })
  it('rejects non-root callers and revocation while the host read was in flight', async () => {
    const t = setup(); t.helpers.requireCaller = async () => ({ ...caller, principal: { ...caller.principal, kind: 'user' } }) as AuthenticatedCaller
    await expect(t.call()).rejects.toThrow('forbidden'); expect(t.helpers.readHost).not.toHaveBeenCalled()
    const changed = setup(); let count = 0
    changed.helpers.requireCaller = async () => ++count === 1 ? caller : { ...caller, sessionId: 'other-session' }
    await expect(changed.call()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('routes root-only tuning preview, apply and rollback with validation, conflict forwarding and audit logs', async () => {
    const t = setup()
    const preview = await t.call('/api/server/databases/tuning/preview', 'POST', { settings: { max_connections: 200 } })
    expect(preview?.status).toBe(200)
    expect(t.callHost).toHaveBeenCalledWith(caller, '/host/databases/tuning/preview', { settings: { max_connections: 200 } })
    expect(t.audit).not.toHaveBeenCalled()

    await expect(t.call('/api/server/databases/tuning/apply', 'POST', { settings: { max_connections: 5 }, expectedRevision: 'rev1' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(t.call('/api/server/databases/tuning/apply', 'POST', { settings: { max_connections: 200 }, expectedRevision: '' })).rejects.toMatchObject({ code: 'VALIDATION' })

    const applied = await t.call('/api/server/databases/tuning/apply', 'POST', { settings: { max_connections: 200 }, expectedRevision: view.dropIn.revision })
    expect(applied?.status).toBe(200)
    expect(t.callHost).toHaveBeenLastCalledWith(caller, '/host/databases/tuning/apply', { settings: { max_connections: 200 }, expectedRevision: view.dropIn.revision })
    expect(t.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.databases.tuning_applied', outcome: 'ok' }))

    const rolled = await t.call('/api/server/databases/tuning/rollback', 'POST', { expectedRevision: 'rev2' })
    expect(rolled?.status).toBe(200)
    expect(t.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'server.databases.tuning_rolled_back', outcome: 'ok' }))

    t.callHost.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'CONFLICT' }))
    await expect(t.call('/api/server/databases/tuning/apply', 'POST', { settings: { max_connections: 200 }, expectedRevision: 'stale' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(t.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'server.databases.tuning_applied', outcome: 'failed' }))
  })
})
