import { describe, expect, it, vi } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import { evaluateServerHealth } from '../../agent/src/server-health.ts'
import { readServerLimits } from '../../agent/src/server-health-limits.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { handleServerHealthWorkspaceRoute, projectServerHealth, projectServerLimits } from './server-health-workspace.ts'
import type { ServerHealthWorkspaceHelpers } from './server-health-workspace.ts'

const root = { principal: { kind: 'root', id: 'root-1', username: 'root' }, sessionId: 's1', apiTokenId: null } as unknown as AuthenticatedCaller
const now = () => new Date('2026-10-27T10:00:00.000Z')
const plan = defaultPlan({ id: 'plan', name: 'Standard', featureListId: 'features' })
const account = (username: string) => ({ id: 'id-' + username, username, uid: 20001, home: '/home/' + username, planId: 'plan', status: 'active' }) as Account
const health = () => evaluateServerHealth({ executor: null, family: null, readDrift: null, saved: { certificates: [{ names: ['soon.example.test'], notAfter: '2026-10-30T00:00:00.000Z', autoRenew: false, source: 'upload' }], accounts: [], plans: [] }, now })
const limits = (names: readonly string[]) => readServerLimits({ accounts: names.map(account), plans: [plan], executor: null, readResources: null, now })
const get = (path: string, init?: RequestInit) => new Request('http://localhost' + path, init)
const call = (req: Request, helpers: ServerHealthWorkspaceHelpers) => handleServerHealthWorkspaceRoute(req, new URL(req.url), req.method, helpers)
const helpers = (overrides: Partial<ServerHealthWorkspaceHelpers> = {}, names = ['bob', 'alice']) => {
  const events: string[] = []
  const value: ServerHealthWorkspaceHelpers = {
    requireCaller: vi.fn(async () => { events.push('auth'); return root }),
    assertRoot: vi.fn(async (_caller, action: string) => { events.push('root:' + action) }),
    listAccounts: vi.fn(async () => names.map(username => ({ username }))),
    readHost: vi.fn(async (_caller, path: string) => {
      events.push('agent:' + path)
      return path === '/host/server-health' ? health() : limits(new URL('http://agent' + path).searchParams.getAll('username'))
    }),
    ...overrides,
  }
  return { value, events }
}

describe('API server health workspace', () => {
  it('leaves unrelated routes untouched', async () => {
    const { value } = helpers()
    expect(await call(get('/api/server/monitoring/disk'), value)).toBeNull()
    expect(value.requireCaller).not.toHaveBeenCalled()
  })

  it('authorizes root before and after the agent read and returns the projected report', async () => {
    const { value, events } = helpers()
    const response = (await call(get('/api/server/server-health'), value))!
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as { host: string; counts: Record<string, number>; checks: { id: string; state: string }[] }
    expect(body).toMatchObject({ host: 'unavailable', counts: { warning: 1, unavailable: 8 } })
    expect(body.checks.find(entry => entry.id === 'certificates')).toMatchObject({ state: 'warning' })
    expect(events).toEqual(['auth', 'root:server.server-health.read', 'agent:/host/server-health', 'auth', 'root:server.server-health.read'])
  })

  it('refuses non-root callers with 403 before any host read', async () => {
    const denied = Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' })
    const { value } = helpers({ assertRoot: vi.fn(async () => { throw denied }) })
    for (const path of ['/api/server/server-health', '/api/server/server-limits']) await expect(call(get(path), value)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(value.readHost).not.toHaveBeenCalled()
    expect(value.listAccounts).not.toHaveBeenCalled()
  })

  it('rejects selectors, malformed usernames and oversized batches before the host read', async () => {
    const { value } = helpers()
    expect((await call(get('/api/server/server-health', { method: 'POST', body: '{}' }), value))!.status).toBe(405)
    const many = Array.from({ length: 51 }, (_, index) => 'username=u' + index).join('&')
    for (const path of ['/api/server/server-health?refresh=1', '/api/server/server-limits?user=alice', '/api/server/server-limits?username=Alice', '/api/server/server-limits?username=bob&username=bob', '/api/server/server-limits?' + many])
      await expect(call(get(path), value)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(get('/api/server/server-limits?username=carol'), value)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(value.readHost).not.toHaveBeenCalled()
  })

  it('reads the first 50 accounts and lists the rest as pending, or exactly the selected accounts', async () => {
    const names = Array.from({ length: 53 }, (_, index) => 'u' + String(index).padStart(2, '0'))
    const { value, events } = helpers({}, names)
    const first = await (await call(get('/api/server/server-limits'), value))!.json() as { accounts: { username: string }[]; pending: string[]; truncated: boolean }
    expect(first.accounts).toHaveLength(50)
    expect(first.accounts[0]!.username).toBe('u00')
    expect(first.pending).toEqual(['u50', 'u51', 'u52'])
    expect(first.truncated).toBe(false)
    const picked = await (await call(get('/api/server/server-limits?username=u52&username=u01'), value))!.json() as { accounts: { username: string }[]; pending: string[] }
    expect(picked.accounts.map(entry => entry.username)).toEqual(['u52', 'u01'])
    expect(picked.pending).toEqual([])
    expect(events).toContain('agent:/host/server-limits?username=u52&username=u01')
    const none = await (await call(get('/api/server/server-limits'), helpers({}, []).value))!.json() as { accounts: unknown[] }
    expect(none.accounts).toEqual([])
  })

  it('refuses unverifiable agent reports, changed authority and a missing agent', async () => {
    const report = await health()
    for (const bad of [{ ...report, counts: { ...report.counts, ok: 9 } }, { ...report, checks: [...report.checks].reverse() }, { ...report, checks: report.checks.map(entry => ({ ...entry, state: 'fine' })) },
      { ...report, checks: report.checks.map(entry => ({ ...entry, evidence: 'x\u0007' })) }, { ...report, observedAt: 'now' }]) expect(() => projectServerHealth(bad)).toThrow()
    const rows = await limits(['alice'])
    for (const bad of [{ ...rows, accounts: [{ ...rows.accounts[0], username: 'bob' }] }, { ...rows, accounts: [{ ...rows.accounts[0], high: 3 }] }, { ...rows, accounts: [{ ...rows.accounts[0], rows: rows.accounts[0]!.rows.slice(1) }] },
      { ...rows, accounts: [{ ...rows.accounts[0], rows: rows.accounts[0]!.rows.map(row => ({ ...row, usage: -1 })) }] }]) expect(() => projectServerLimits(bad, ['alice'])).toThrow()
    expect(projectServerLimits(rows, ['alice']).accounts[0]!.rows).toHaveLength(8)
    let calls = 0
    const switched = helpers({ requireCaller: vi.fn(async () => (calls++ ? { ...root, sessionId: 's2' } : root) as AuthenticatedCaller) })
    await expect(call(get('/api/server/server-health'), switched.value)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const { readHost: _readHost, ...offline } = helpers().value
    await expect(call(get('/api/server/server-health'), offline)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
