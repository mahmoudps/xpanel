import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleReleasePackagesWorkspaceRoute } from './release-packages-workspace.ts'
import type { ReleasePackagesWorkspaceHelpers } from './release-packages-workspace.ts'

const root = { principal: { kind: 'root', id: 'fixture-root', username: 'root' } } as AuthenticatedCaller
const revision = 'a'.repeat(64)
const helpers = (overrides: Partial<ReleasePackagesWorkspaceHelpers> = {}): ReleasePackagesWorkspaceHelpers => ({
  requireCaller: vi.fn(async () => root),
  assertRoot: vi.fn(async () => undefined),
  readHost: vi.fn(async (_caller: AuthenticatedCaller, path: string) => path.endsWith('/retry') ? { job: { id: 'job-1', status: 'queued' } } : { state: 'read', features: [] }),
  ...overrides,
})
const call = (path: string, method = 'GET', body?: unknown, h = helpers(), type = 'application/json') => {
  const url = new URL('http://panel.test' + path)
  return handleReleasePackagesWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': type } }) }), url, method, h)
}

describe('release packages workspace', { tags: ['unit'] }, () => {
  it('leaves other upgrade routes to their own handler', async () => {
    expect(await call('/api/server/upgrade')).toBeNull()
    expect(await call('/api/server/upgrade/status')).toBeNull()
  })
  it('reads through the root-only host route and passes no selector', async () => {
    const h = helpers()
    expect(await (await call('/api/server/upgrade/packages', 'GET', undefined, h))!.json()).toEqual({ state: 'read', features: [] })
    expect(h.assertRoot).toHaveBeenCalledWith(root, 'server.upgrade.read')
    expect(h.readHost).toHaveBeenCalledExactlyOnceWith(root, '/host/upgrade/packages')
    await expect(call('/api/server/upgrade/packages?feature=mail')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call('/api/server/upgrade/packages', 'POST'))!.status).toBe(405)
    expect((await call('/api/server/upgrade/packages/retry'))!.status).toBe(405)
  })
  it('refuses a non-root caller before any host call', async () => {
    const h = helpers({ assertRoot: vi.fn(async () => fail('FORBIDDEN', 'root role is required for this operation')) })
    await expect(call('/api/server/upgrade/packages/retry', 'POST', { expectedRevision: revision }, h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.readHost).not.toHaveBeenCalled()
  })
  it('passes only the observed revision and re-checks the principal before the host call', async () => {
    const h = helpers()
    const response = (await call('/api/server/upgrade/packages/retry', 'POST', { expectedRevision: revision }, h))!
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ job: { id: 'job-1', status: 'queued' } })
    expect(h.requireCaller).toHaveBeenCalledTimes(2)
    expect(h.assertRoot).toHaveBeenCalledWith(root, 'server.upgrade.packages')
    expect(h.readHost).toHaveBeenCalledExactlyOnceWith(root, '/host/upgrade/packages/retry', { expectedRevision: revision })
    const changed = helpers({ requireCaller: vi.fn().mockResolvedValueOnce(root).mockResolvedValueOnce({ principal: { kind: 'root', id: 'other', username: 'other' } }) })
    await expect(call('/api/server/upgrade/packages/retry', 'POST', { expectedRevision: revision }, changed)).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(changed.readHost).not.toHaveBeenCalled()
  })
  it.each([[{}], ['nope'], [{ expectedRevision: 'short' }], [{ expectedRevision: revision, features: ['mail'] }]])('refuses the body %j', async body => {
    const h = helpers()
    await expect(call('/api/server/upgrade/packages/retry', 'POST', body, h)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(h.readHost).not.toHaveBeenCalled()
  })
  it('requires JSON', async () => {
    await expect(call('/api/server/upgrade/packages/retry', 'POST', { expectedRevision: revision }, helpers(), 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
