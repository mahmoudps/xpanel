import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleRepairWorkspaceRoute } from './repair-workspace.ts'
import type { RepairWorkspaceHelpers } from './repair-workspace.ts'

const root = (id = 'fixture-root', sessionId = 'session-1') => ({ principal: { kind: 'root', id, username: 'root' }, sessionId, apiTokenId: null }) as unknown as AuthenticatedCaller
const revision = 'a'.repeat(64)
const helpers = (overrides: Partial<RepairWorkspaceHelpers> = {}, agent: () => Response = () => Response.json({ revision, diagnostics: [] })) => {
  const forwarded: { path: string; body: unknown }[] = []
  const audits: string[] = []
  const value: RepairWorkspaceHelpers = {
    requireCaller: vi.fn(async () => root()),
    assertRoot: vi.fn(async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') throw Object.assign(new Error('root required'), { code: 'FORBIDDEN' }) }),
    emitAudit: vi.fn(async (input: { action: string }) => { audits.push(input.action) }),
    forward: vi.fn(async (_caller, path, body) => { forwarded.push({ path, body }); return agent() }),
    ...overrides,
  }
  return { value, forwarded, audits }
}
const call = (h: RepairWorkspaceHelpers, path: string, method = 'GET', body?: unknown, contentType = 'application/json') => {
  const url = new URL('http://localhost' + path)
  return handleRepairWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': contentType } }) }), url, method, h)
}

describe('repair workspace API', () => {
  it('forwards the finite RHEL metadata intent without a package, repository or recovery selector', async () => {
    const { value, forwarded } = helpers({}, () => Response.json({ revision, job: { id: 'job-1', referenceCode: null, kind: 'system.repair.dnf-cache-refresh', status: 'queued' } }, { status: 202 }))
    expect((await call(value, '/api/server/repair/run', 'POST', { repairId: 'dnf-cache-refresh', expectedRevision: revision }))!.status).toBe(202)
    expect(forwarded).toEqual([{ path: '/host/repair/run', body: { repairId: 'dnf-cache-refresh', expectedRevision: revision } }])
    for (const extra of [{ repository: 'https://example.test' }, { recovery: true }, { argv: ['/usr/bin/rpmdb', '--rebuilddb'] }]) await expect(call(value, '/api/server/repair/run', 'POST', { repairId: 'dnf-cache-refresh', expectedRevision: revision, ...extra })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(forwarded).toHaveLength(1)
  })
  it.each(['XP-JOB-2026-000123', 'LEGACY/77-A', null])('preserves the repair job reference: %s', async referenceCode => {
    const { value } = helpers({}, () => Response.json({ revision, job: { id: 'job-1', referenceCode, status: 'queued' } }, { status: 202 }))
    const response = (await call(value, '/api/server/repair/run', 'POST', { repairId: 'dpkg-configure', expectedRevision: revision }))!
    expect(await response.json()).toMatchObject({ job: { referenceCode } })
  })

  it('treats an unverifiable reference after submission as an uncertain outcome', async () => {
    const { value } = helpers({}, () => Response.json({ revision, job: { id: 'job-1' } }, { status: 202 }))
    await expect(call(value, '/api/server/repair/run', 'POST', { repairId: 'dpkg-configure', expectedRevision: revision })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
  })
  it('authorizes root and forwards diagnostics without selectors', async () => {
    const { value, forwarded } = helpers()
    const response = await call(value, '/api/server/repair/diagnostics')
    expect(response!.status).toBe(200)
    expect(response!.headers.get('cache-control')).toBe('no-store')
    expect(await response!.json()).toEqual({ revision, diagnostics: [] })
    expect(forwarded).toEqual([{ path: '/host/repair/diagnostics', body: undefined }])
    expect(await call(value, '/api/server/other')).toBeNull()
  })

  it('refuses a non-root caller before any host call (403)', async () => {
    const { value, forwarded } = helpers({ requireCaller: async () => ({ principal: { kind: 'reseller', id: 'r', username: 'reseller' } }) as unknown as AuthenticatedCaller })
    await expect(call(value, '/api/server/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(forwarded).toEqual([])
  })

  it.each([
    ['selector', '/api/server/repair/diagnostics?family=rhel', 'GET', undefined],
    ['extra field', '/api/server/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision, argv: ['/bin/sh'] }],
    ['unknown repair', '/api/server/repair/preview', 'POST', { repairId: 'dnf-repair', expectedRevision: revision }],
    ['bad revision', '/api/server/repair/preview', 'POST', { repairId: 'apt-fix-broken', expectedRevision: 'nope' }],
    ['acceptance without list', '/api/server/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision, acceptRemovals: true }],
    ['preview acceptance', '/api/server/repair/preview', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision, acceptRemovals: true, expectedRemovals: revision }],
    ['dpkg removals', '/api/server/repair/run', 'POST', { repairId: 'dpkg-configure', expectedRevision: revision, acceptRemovals: false }],
    ['metadata removals', '/api/server/repair/run', 'POST', { repairId: 'dnf-cache-refresh', expectedRevision: revision, acceptRemovals: false }],
  ])('refuses grammar (422 VALIDATION): %s', async (_name, path, method, body) => {
    const { value, forwarded } = helpers()
    await expect(call(value, path, method, body)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(forwarded).toEqual([])
  })

  it('refuses non-JSON bodies and wrong methods', async () => {
    const { value, forwarded } = helpers()
    await expect(call(value, '/api/server/repair/run', 'POST', 'repairId=apt-fix-broken', 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
    const wrong = await call(value, '/api/server/repair/diagnostics', 'POST', {})
    expect(wrong!.status).toBe(405); expect(wrong!.headers.get('allow')).toBe('GET')
    expect(forwarded).toEqual([])
  })

  it('forwards only the normalized run intent, audits it and re-checks root after the host call', async () => {
    const { value, forwarded, audits } = helpers({}, () => Response.json({ revision, job: { id: 'job-1', referenceCode: 'XP-JOB-2026-000123', status: 'queued' } }, { status: 202 }))
    const response = await call(value, '/api/server/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision, acceptRemovals: true, expectedRemovals: 'b'.repeat(64) })
    expect(response!.status).toBe(202)
    expect(forwarded).toEqual([{ path: '/host/repair/run', body: { repairId: 'apt-fix-broken', expectedRevision: revision, acceptRemovals: true, expectedRemovals: 'b'.repeat(64) } }])
    expect(value.requireCaller).toHaveBeenCalledTimes(3)
    expect(audits).toEqual(['server.repair.run_requested', 'server.repair.job_submitted'])
  })

  it('reports a submitted job as changed state when authority is lost after the host call', async () => {
    let calls = 0
    const { value } = helpers({ requireCaller: async () => root(++calls > 2 ? 'other-root' : 'fixture-root') }, () => Response.json({ revision, job: { id: 'job-1', referenceCode: null } }, { status: 202 }))
    await expect(call(value, '/api/server/repair/run', 'POST', { repairId: 'dpkg-configure', expectedRevision: revision })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: true, unknownOutcome: true } })
    calls = 0
    const preview = helpers({ requireCaller: async () => root(++calls > 2 ? 'other-root' : 'fixture-root') }, () => Response.json({ revision, preview: {} }))
    await expect(call(preview.value, '/api/server/repair/preview', 'POST', { repairId: 'dpkg-configure', expectedRevision: revision })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
  })

  it('maps agent refusals to API problems with only reviewed details', async () => {
    const problem = (status: number, details: Record<string, unknown>) => () => new Response(JSON.stringify({ status, detail: 'host diagnostics changed; run diagnostics again before repairing', details }), { status, headers: { 'content-type': 'application/problem+json' } })
    const stale = helpers({}, problem(409, { stateChanged: false, revision: 'c'.repeat(64), secret: '/etc/shadow' }))
    const error = await call(stale.value, '/api/server/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision }).catch(caught => caught)
    expect(error).toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false, revision: 'c'.repeat(64) } })
    expect(JSON.stringify(error.detail)).not.toContain('shadow')
    const removals = helpers({}, problem(412, { stateChanged: false, reason: 'removals_require_acceptance', removals: ['php8.3-fpm'], removalFingerprint: 'd'.repeat(64) }))
    await expect(call(removals.value, '/api/server/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'removals_require_acceptance', removals: ['php8.3-fpm'], removalFingerprint: 'd'.repeat(64) } })
    const unknown = helpers({}, problem(503, {}))
    await expect(call(unknown.value, '/api/server/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
  })

  it('does not send a run that cannot be audited, and reports transport loss as unknown', async () => {
    const unaudited = helpers({ emitAudit: async () => { throw new Error('audit down') } })
    await expect(call(unaudited.value, '/api/server/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(unaudited.forwarded).toEqual([])
    const lost = helpers({ forward: async () => { throw new Error('socket') } })
    await expect(call(lost.value, '/api/server/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
    const disconnected = helpers({ forward: async () => fail('PRECONDITION_FAILED', 'privileged host agent is not connected', { stateChanged: false }) })
    await expect(call(disconnected.value, '/api/server/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    const readLost = helpers({ forward: async () => { throw new Error('socket') } })
    await expect(call(readLost.value, '/api/server/repair/diagnostics')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
  })
})
