import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { policyForRequest } from './authorization.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'
import { handleSystemUpdatesWorkspaceRoute, projectSystemUpdatesPlan } from './system-updates-workspace.ts'
import type { SystemUpdatesWorkspaceHelpers } from './system-updates-workspace.ts'

const root = { principal: { kind: 'root', id: 'fixture-root', username: 'root' } } as AuthenticatedCaller
const revision = 'b'.repeat(64)
const hostPlan = () => ({
  plan: {
    state: 'read', source: 'apt', observedAt: '2026-10-27T10:00:00.000Z', revision,
    packages: [
      { name: 'openssl', current: '3.0.13-0ubuntu3.4', candidate: '3.0.13-0ubuntu3.5', origin: 'Ubuntu:24.04/noble-security', security: true, kernel: false, held: false, newInstall: false },
      { name: 'linux-image-6.8.0-51-generic', current: null, candidate: '6.8.0-51.52', origin: 'Ubuntu:24.04/noble-security', security: true, kernel: true, held: false, newInstall: true },
    ],
    holds: ['nginx'], rebootRequired: false, counts: { total: 2, security: 2, kernel: 1, held: 1 },
  },
  safety: { state: 'read', writers: [], database: 'clean' },
  actions: { refresh: true, apply: true },
})
const helpers = (overrides: Partial<SystemUpdatesWorkspaceHelpers> = {}) => {
  const events: string[] = []
  const value: SystemUpdatesWorkspaceHelpers = {
    requireCaller: async () => { events.push('auth'); return root },
    assertRoot: async (_caller, action) => { events.push('root:' + action) },
    callHost: async (_caller, path, body) => { events.push('host:' + path + (body ? ':' + JSON.stringify(body) : '')); return path.endsWith('/plan') ? hostPlan() : { job: { id: 'job-1', status: 'queued' } } },
    ...overrides,
  }
  return { value, events }
}
const call = (h: SystemUpdatesWorkspaceHelpers, path: string, method = 'GET', body?: unknown, contentType = 'application/json') => {
  const url = new URL('http://localhost' + path)
  return handleSystemUpdatesWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': contentType } }) }), url, method, h)
}

describe('system updates API workspace', () => {
  it('is covered by the existing root-only server policy and the xWHM listener only', () => {
    for (const path of ['/api/server/updates/plan', '/api/server/updates/apply', '/api/server/updates/refresh']) {
      expect(policyForRequest(path, path.endsWith('/plan') ? 'GET' : 'POST')).toMatchObject({ resource: 'server', rootOnly: true })
      expect(entryPointAllowsApiRoute('xwhm', path, 'POST')).toBe(true)
      expect(entryPointAllowsApiRoute('xpanel', path, 'GET')).toBe(false)
      expect(entryPointAllowsApiRoute('xmail', path, 'GET')).toBe(false)
    }
  })
  it('ignores unrelated routes', async () => {
    const h = helpers()
    expect(await call(h.value, '/api/server/php/inventory')).toBeNull()
    expect(h.events).toEqual([])
  })
  it('authenticates and asserts root before the protected read and returns a projected plan', async () => {
    const h = helpers()
    const response = await call(h.value, '/api/server/updates/plan')
    expect(response!.status).toBe(200)
    expect(response!.headers.get('cache-control')).toBe('no-store')
    expect(await response!.json()).toEqual(hostPlan())
    expect(h.events).toEqual(['auth', 'root:server.updates.read', 'host:/host/system-updates/plan', 'auth', 'root:server.updates.read'])
  })
  it('does not reach the host when root is refused', async () => {
    const callHost = vi.fn()
    await expect(call(helpers({ assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' }) }, callHost }).value, '/api/server/updates/apply', 'POST', { expectedRevision: revision, mode: 'all' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(callHost).not.toHaveBeenCalled()
  })
  it.each([
    ['/api/server/updates/plan?source=dnf', 'GET', undefined],
    ['/api/server/updates/apply', 'POST', { expectedRevision: revision, mode: 'all', command: 'apt-get' }],
    ['/api/server/updates/apply', 'POST', { expectedRevision: 'short', mode: 'all' }],
    ['/api/server/updates/apply', 'POST', { expectedRevision: revision, mode: 'selected', packages: ['-o', 'x'] }],
    ['/api/server/updates/apply', 'POST', { expectedRevision: revision, mode: 'selected', packages: [] }],
    ['/api/server/updates/apply', 'POST', { expectedRevision: revision, mode: 'security', packages: ['openssl'] }],
    ['/api/server/updates/apply', 'POST', 'nope'],
    ['/api/server/updates/refresh', 'POST', { force: true }],
  ])('rejects %s %s with a strict grammar before the host call', async (path, method, body) => {
    const callHost = vi.fn()
    await expect(call(helpers({ callHost }).value, path, method, body)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(callHost).not.toHaveBeenCalled()
  })
  it('requires JSON and the declared method', async () => {
    await expect(call(helpers().value, '/api/server/updates/refresh', 'POST', '{}', 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call(helpers().value, '/api/server/updates/apply', 'GET'))!.status).toBe(405)
  })
  it('re-checks root after the body read and after the host call, forwarding only the reviewed body', async () => {
    const h = helpers()
    const response = await call(h.value, '/api/server/updates/apply', 'POST', { expectedRevision: revision, mode: 'selected', packages: ['openssl'] })
    expect(response!.status).toBe(202)
    expect(await response!.json()).toEqual({ job: { id: 'job-1', status: 'queued' } })
    expect(h.events).toEqual(['auth', 'root:server.updates.apply', 'auth', 'root:server.updates.apply', 'host:/host/system-updates/apply:{"expectedRevision":"' + revision + '","mode":"selected","packages":["openssl"]}', 'auth', 'root:server.updates.apply'])
    const refresh = helpers()
    expect((await call(refresh.value, '/api/server/updates/refresh', 'POST', {}))!.status).toBe(202)
    expect(refresh.events).toContain('host:/host/system-updates/refresh:{}')
  })
  it('refuses a mutation when the principal changes before the host call', async () => {
    let calls = 0
    const callHost = vi.fn()
    const other = { principal: { kind: 'root', id: 'other-root', username: 'root2' } } as AuthenticatedCaller
    await expect(call(helpers({ requireCaller: async () => ++calls === 1 ? root : other, callHost }).value, '/api/server/updates/apply', 'POST', { expectedRevision: revision, mode: 'all' })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(callHost).not.toHaveBeenCalled()
  })
  it('reports changed state truthfully when root is lost after submission or the receipt is malformed', async () => {
    let roots = 0
    await expect(call(helpers({ assertRoot: async () => { if (++roots > 2) throw new Error('denied') } }).value, '/api/server/updates/refresh', 'POST', {})).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: true } })
    await expect(call(helpers({ callHost: async () => ({ job: { id: 'x y', status: 'queued' } }) }).value, '/api/server/updates/refresh', 'POST', {})).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: true, unknownOutcome: true } })
  })
  it('refuses host plans that do not match the contract', () => {
    const mutate = (change: (value: ReturnType<typeof hostPlan>) => void) => { const value = hostPlan(); change(value); return () => projectSystemUpdatesPlan(value) }
    expect(mutate(value => { value.plan.counts.security = 1 })).toThrow()
    expect(mutate(value => { value.plan.packages[0]!.name = '<img src=x>' })).toThrow()
    expect(mutate(value => { value.plan.packages[0]!.origin = 'a\u202eb' })).toThrow()
    expect(mutate(value => { (value.plan as Record<string, unknown>).state = 'unavailable' })).toThrow()
    expect(mutate(value => { value.plan.packages[1]!.current = '1.0' })).toThrow()
    expect(mutate(value => { value.plan.holds = ['--x'] })).toThrow()
    const unavailable = { plan: { state: 'unavailable', source: 'apt', observedAt: '2026-10-27T10:00:00.000Z', revision: null, packages: [], holds: null, rebootRequired: 'not-read', counts: { total: 0, security: 0, kernel: 0, held: null }, reason: 'package-manager-busy' }, safety: { state: 'read', writers: [], database: 'clean' }, actions: { refresh: true, apply: false } }
    expect(projectSystemUpdatesPlan(unavailable).plan.reason).toBe('package-manager-busy')
    expect(() => projectSystemUpdatesPlan({ ...unavailable, actions: { refresh: true, apply: true } })).toThrow()
  })
})

describe('package safety projection', () => {
  it('passes competing writers and database state through and never offers jobs over them', () => {
    const busy = { state: 'read', writers: [{ pid: 4242, command: 'unattended-upgr' }], database: 'clean' }
    expect(projectSystemUpdatesPlan({ ...hostPlan(), safety: busy, actions: { refresh: false, apply: false } }).safety).toEqual(busy)
    expect(() => projectSystemUpdatesPlan({ ...hostPlan(), safety: busy })).toThrow()
    expect(() => projectSystemUpdatesPlan({ ...hostPlan(), safety: { state: 'read', writers: [], database: 'interrupted' } })).toThrow()
    expect(() => projectSystemUpdatesPlan({ ...hostPlan(), safety: undefined })).toThrow()
    for (const safety of [{ state: 'read', writers: [{ pid: 1, command: '<b>' }], database: 'clean' }, { state: 'read', writers: [], database: 'clean', extra: 1 }, { state: 'unavailable', writers: [], database: 'clean' }, { state: 'read', writers: [{ pid: 0, command: 'apt' }], database: 'clean' }])
      expect(() => projectSystemUpdatesPlan({ ...hostPlan(), safety, actions: { refresh: false, apply: false } })).toThrow()
  })
})

describe('kernel exclusion API contract', () => {
  it('forwards only the fixed preview option and bound apply intent', async () => {
    const callHost = vi.fn(async (_caller: AuthenticatedCaller, path: string) => path.includes('/plan') ? { ...hostPlan(), plan: { ...hostPlan().plan, excludeKernel: true } } : { job: { id: 'job-1', status: 'queued' } })
    const h = helpers({ callHost })
    const preview = await (await call(h.value, '/api/server/updates/plan?excludeKernel=true'))!.json()
    expect(preview).toMatchObject({ plan: { excludeKernel: true } })
    expect(callHost).toHaveBeenCalledWith(root, '/host/system-updates/plan?excludeKernel=true')
    await call(h.value, '/api/server/updates/apply', 'POST', { expectedRevision: revision, mode: 'security', excludeKernel: true })
    expect(callHost).toHaveBeenLastCalledWith(root, '/host/system-updates/apply', { expectedRevision: revision, mode: 'security', excludeKernel: true })
  })
  it('refuses mismatched host option, caller patterns and a revoked read principal', async () => {
    await expect(call(helpers({ callHost: async () => hostPlan() }).value, '/api/server/updates/plan?excludeKernel=true')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call(helpers().value, '/api/server/updates/apply', 'POST', { expectedRevision: revision, mode: 'all', excludeKernel: 'linux-*' })).rejects.toMatchObject({ code: 'VALIDATION' })
    let auth = 0
    const h = helpers({ requireCaller: async () => { if (++auth > 1) throw new Error('revoked'); return root } })
    await expect(call(h.value, '/api/server/updates/plan')).rejects.toThrow('revoked')
  })
})

