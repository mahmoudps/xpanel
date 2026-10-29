import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleServiceManagerWorkspaceRoute, projectServiceManagerView } from './service-manager-workspace.ts'
import type { ServiceManagerWorkspaceHelpers } from './service-manager-workspace.ts'
const root = { principal: { kind: 'root', id: 'root-1', username: 'root' } } as AuthenticatedCaller
const view = () => ({ state: 'read', observedAt: '2026-10-27T00:00:00.000Z', revision: 'a'.repeat(64), bootTime: 1793000000, manage: true, units: [{ unit: 'ssh.service', load: 'loaded', active: 'active', sub: 'running', boot: 'enabled', restart: true, bootEditable: false }] })
const helpers = (overrides: Partial<ServiceManagerWorkspaceHelpers> = {}): ServiceManagerWorkspaceHelpers => ({ requireCaller: vi.fn(async () => root), assertRoot: vi.fn(async () => {}), emitAudit: vi.fn(async () => {}), callHost: vi.fn(async (_caller, _path, body) => body ? { action: (body as any).action, unit: (body as any).unit ?? null, outcome: (body as any).action === 'reboot' ? 'attempted' : 'submitted', verificationRequired: true, job: { id: 'job-1', kind: 'services.manager.' + (body as any).action, status: 'queued' } } : view()), ...overrides })
const call = (h: ServiceManagerWorkspaceHelpers, body?: unknown, path = '/api/server/service-manager' + (body ? '/action' : '')) => { const req = new Request('http://local' + path, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }); return handleServiceManagerWorkspaceRoute(req, new URL(req.url), req.method, h) }
const body = { action: 'restart', unit: 'ssh.service', expectedRevision: 'a'.repeat(64) }

describe('service manager API projection', () => {
  it('projects known facts and strips unknown properties', () => expect(JSON.stringify(projectServiceManagerView({ ...view(), secret: 'private', units: view().units.map(row => ({ ...row, command: 'private' })) }))).not.toContain('private'))
  it.each([() => ({ ...view(), state: 'unavailable' }), () => ({ ...view(), units: [...view().units, ...view().units] }), () => ({ ...view(), units: [{ ...view().units[0], unit: 'nginx.service', restart: true }] }), () => ({ ...view(), units: [{ ...view().units[0], bootEditable: true }] }), () => ({ ...view(), bootTime: -1 }), () => ({ ...view(), revision: null })])('refuses contradictory or malformed facts', value => expect(() => projectServiceManagerView(value())).toThrow())
  it('allows a truthful unavailable response', () => expect(projectServiceManagerView({ state: 'unavailable', observedAt: view().observedAt, revision: null, bootTime: null, manage: false, units: [] }).state).toBe('unavailable'))
})
describe('service manager API routes', () => {
  it('reads through protected host transport then rechecks caller', async () => {
    const h = helpers(); expect((await call(h))!.status).toBe(200); expect(h.callHost).toHaveBeenCalledWith(root, '/host/service-manager'); expect(h.requireCaller).toHaveBeenCalledTimes(2)
    expect(await call(h, undefined, '/other')).toBeNull()
  })
  it('audits and reauthorizes immediately before forwarding the mutation', async () => {
    const h = helpers(); const response = await call(h, body)
    expect(response!.status).toBe(202); expect(h.callHost).toHaveBeenCalledWith(root, '/host/service-manager/action', body, true); expect(h.emitAudit).toHaveBeenCalledOnce(); expect(h.requireCaller).toHaveBeenCalledTimes(3)
  })
  it('refuses unknown fields and selectors without forwarding', async () => {
    const h = helpers(); await expect(call(h, { ...body, command: 'reboot' })).rejects.toMatchObject({ code: 'VALIDATION' }); await expect(call(h, undefined, '/api/server/service-manager?unit=x')).rejects.toMatchObject({ code: 'VALIDATION' }); expect(h.callHost).not.toHaveBeenCalled()
  })
  it('stops on changed identity before mutation', async () => {
    let checks = 0; const h = helpers({ requireCaller: async () => checks++ ? { principal: { ...root.principal, id: 'other' } } as AuthenticatedCaller : root })
    await expect(call(h, body)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(h.callHost).not.toHaveBeenCalled()
  })
  it('rejects wrong action/target acknowledgement as an unknown outcome', async () => {
    const h = helpers({ callHost: async () => ({ action: 'restart', unit: 'nginx.service', outcome: 'submitted', verificationRequired: true, job: { id: 'job-1', kind: 'services.manager.restart', status: 'queued' } }) })
    await expect(call(h, body)).rejects.toMatchObject({ detail: { unknownOutcome: true, verificationRequired: true } })
  })
})
