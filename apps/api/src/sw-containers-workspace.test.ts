import { describe, expect, it, vi } from 'vitest'
import { handleSwContainersWorkspaceRoute } from './sw-containers-workspace.ts'
import type { SwContainersWorkspaceHelpers } from './sw-containers-workspace.ts'

const id = 'a'.repeat(64)
const list = { scope: 'host-engines', state: 'read', reason: null, observedAt: '2026-10-28T00:00:00.000Z', rootlessAccounts: 'not-read', actions: { lifecycle: true }, engines: [{ engine: 'podman', state: 'read', reason: null, version: '4.9.3', revision: 'b'.repeat(64), containers: [{ id, name: 'web', image: 'nginx:latest', state: 'running', status: 'Up 2 hours', ports: [] }] }] }
const helpers = (overrides: Partial<SwContainersWorkspaceHelpers> = {}) => {
  const principal = { id: 'p-root', username: 'root', kind: 'root' }
  const value: SwContainersWorkspaceHelpers = { requireCaller: vi.fn(async () => ({ principal }) as never), assertRoot: vi.fn(async () => {}), emitAudit: vi.fn(async () => {}) as never,
    callHost: vi.fn(async (_caller, path: string) => path.endsWith('/action') ? { job: { id: 'job-1', kind: 'software.container.stop' } } : list),
    streamHost: vi.fn(async () => new Response('{"line":"x"}\n', { headers: { 'content-type': 'application/x-ndjson' } })), ...overrides }
  return value
}
const call = (h: SwContainersWorkspaceHelpers, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
  const url = new URL('http://api.local' + path)
  return handleSwContainersWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), url, method, h)
}

describe('container workspace API', () => {
  const scope = { scope: 'account', account: 'alice', state: 'read', reason: null, observedAt: '2026-11-07T00:00:00.000Z', revision: 'b'.repeat(64), version: '4.9.3', stats: [], images: [], networks: [], volumes: [], stacks: [], logins: [], actions: { write: true, jobs: true } }
  it('passes reads to the matching host route and re-validates each view', async () => {
    const h = helpers({ callHost: vi.fn(async () => scope) })
    expect((await (await call(h, '/api/server/software/containers/scope?account=alice'))!.json()).account).toBe('alice')
    expect(h.callHost).toHaveBeenCalledWith(expect.anything(), '/host/software/containers/scope?account=alice')
    await expect(call(h, '/api/server/software/containers/scope?other=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(helpers({ callHost: vi.fn(async () => ({ ...scope, env: 'x' })) }), '/api/server/software/containers/scope')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await call(h, '/api/server/software/containers/op', undefined, 'GET'))!.status).toBe(405)
    const denied = helpers({ assertRoot: vi.fn(async () => { throw new Error('forbidden') }) })
    await expect(call(denied, '/api/server/software/containers/accounts')).rejects.toThrow('forbidden'); expect(denied.callHost).not.toHaveBeenCalled()
  })
  it('passes a live log through only as an agent stream', async () => {
    const h = helpers()
    const response = (await call(h, '/api/server/software/containers/log-stream?account=alice&stack=shop'))!
    expect(response.headers.get('x-accel-buffering')).toBe('no'); expect(await response.text()).toContain('"line"')
    expect(h.streamHost).toHaveBeenCalledWith(expect.anything(), '/host/software/containers/log-stream?account=alice&stack=shop')
    await expect(call(h, '/api/server/software/containers/log-stream?other=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(helpers({ streamHost: vi.fn(async () => new Response('{}', { status: 412 })) }), '/api/server/software/containers/log-stream?account=alice&stack=shop')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('audits a catalog update and takes one envelope or one URL', async () => {
    const view = { revision: 'b'.repeat(64), registries: [], templates: [], apps: [], catalog: { source: 'signed', sequence: 2, expiresAt: '2026-12-01T00:00:00.000Z', reason: null }, feedUrl: null, configPath: '/x', stackPath: '~/y' }
    const h = helpers({ callHost: vi.fn(async () => view) })
    expect((await call(h, '/api/server/software/containers/catalog', { envelope: '{}', url: null }))!.status).toBe(200)
    expect(h.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.container.catalog_imported' }))
    await expect(call(h, '/api/server/software/containers/catalog', { envelope: '{}' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('audits each operation by name, never its password, and refuses a forged job', async () => {
    const body = { account: 'alice', expectedRevision: 'b'.repeat(64), action: { op: 'registry.login', host: 'ghcr.io', username: 'bob', password: 'hunter2' } }
    const h = helpers({ callHost: vi.fn(async () => ({ op: 'registry.login', changed: true })) })
    expect((await call(h, '/api/server/software/containers/op', body))!.status).toBe(200)
    expect(h.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.container.registry.login', target: 'account:alice' }))
    expect(JSON.stringify((h.emitAudit as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('hunter2')
    await expect(call(h, '/api/server/software/containers/op', { ...body, action: { op: 'shell', command: 'id' } })).rejects.toMatchObject({ code: 'VALIDATION' })
    const forged = helpers({ callHost: vi.fn(async () => ({ job: { id: 'job-1', kind: 'system.packages.upgrade' } })) })
    await expect(call(forged, '/api/server/software/containers/op', { ...body, action: { op: 'image.prune' } })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    const policy = helpers({ callHost: vi.fn(async () => ({ revision: 'b'.repeat(64), registries: [], templates: [], apps: [], catalog: { source: 'bundled', sequence: null, expiresAt: null, reason: null }, feedUrl: null, configPath: '/x', stackPath: '~/y' })) })
    expect((await call(policy, '/api/server/software/containers/policy', { expectedRevision: 'b'.repeat(64), policy: { registries: [], templates: [], feedUrl: null } }))!.status).toBe(200)
    expect(policy.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.container.policy_saved' }))
    await expect(call(policy, '/api/server/software/containers/policy', { policy: {} })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
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
