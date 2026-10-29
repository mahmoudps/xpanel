import { describe, expect, it, vi } from 'vitest'
import { handleSwContainersWorkspaceRoute } from './sw-containers-workspace.ts'
import type { SwContainersWorkspaceHelpers } from './sw-containers-workspace.ts'

const id = 'a'.repeat(64)
const list = { scope: 'host-engines', state: 'read', reason: null, observedAt: '2026-10-28T00:00:00.000Z', rootlessAccounts: 'not-read', actions: { lifecycle: true }, engines: [{ engine: 'podman', state: 'read', reason: null, version: '4.9.3', revision: 'b'.repeat(64), containers: [{ id, name: 'web', image: 'nginx:latest', state: 'running', status: 'Up 2 hours', ports: [] }] }] }
const helpers = (overrides: Partial<SwContainersWorkspaceHelpers> = {}) => {
  const principal = { id: 'p-root', username: 'root', kind: 'root' }
  const value: SwContainersWorkspaceHelpers = { requireCaller: vi.fn(async () => ({ principal }) as never), assertRoot: vi.fn(async () => {}), emitAudit: vi.fn(async () => {}) as never,
    callHost: vi.fn(async (_caller, path: string) => path.endsWith('/action') ? { job: { id: 'job-1', kind: 'software.container.stop' } } : list), ...overrides }
  return value
}
const call = (h: SwContainersWorkspaceHelpers, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
  const url = new URL('http://api.local' + path)
  return handleSwContainersWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), url, method, h)
}

describe('container workspace API', () => {
  it('is root-only and re-validates the host view', async () => {
    const denied = helpers({ assertRoot: vi.fn(async () => { throw new Error('forbidden') }) })
    await expect(call(denied, '/api/server/software/containers')).rejects.toThrow('forbidden'); expect(denied.callHost).not.toHaveBeenCalled()
    const h = helpers()
    expect((await (await call(h, '/api/server/software/containers'))!.json()).engines[0].containers[0].name).toBe('web')
    const forged = helpers({ callHost: vi.fn(async () => ({ ...list, actions: { lifecycle: true, exec: true } })) })
    await expect(call(forged, '/api/server/software/containers')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call(h, '/api/server/software/containers?engine=docker')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call(h, '/api/server/software/containers', undefined, 'DELETE'))!.status).toBe(405)
    expect(await call(h, '/api/server/software/other')).toBeNull()
  })
  it('audits intent and submission, and refuses unverifiable or extra-field mutations', async () => {
    const h = helpers(), body = { engine: 'podman', containerId: id, action: 'stop', expectedRevision: 'b'.repeat(64) }
    const response = await call(h, '/api/server/software/containers/action', body)
    expect(response!.status).toBe(202); expect(h.emitAudit).toHaveBeenCalledTimes(2)
    await expect(call(helpers(), '/api/server/software/containers/action', { ...body, image: 'alpine' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(helpers(), '/api/server/software/containers/action', { ...body, containerId: 'web' })).rejects.toMatchObject({ code: 'VALIDATION' })
    const wrong = helpers({ callHost: vi.fn(async () => ({ job: { id: 'job-1', kind: 'software.container.start' } })) })
    await expect(call(wrong, '/api/server/software/containers/action', body)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
  })
})
