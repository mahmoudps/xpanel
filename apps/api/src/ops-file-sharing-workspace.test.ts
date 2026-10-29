import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { policyForRequest } from './authorization.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'
import { handleFileSharingWorkspaceRoute, projectShareObservation } from './ops-file-sharing-workspace.ts'
import type { FileSharingWorkspaceHelpers } from './ops-file-sharing-workspace.ts'
import { renderManagedExports, savedShareConfigRevision, shareConfigRevision } from '../../agent/src/ops-file-sharing.ts'
import type { ShareConfig } from '../../agent/src/ops-file-sharing.ts'

const root = { principal: { kind: 'root', id: 'fixture-root', username: 'root' }, sessionId: 'sess', apiTokenId: null } as AuthenticatedCaller
const config: ShareConfig = { shares: [{ id: 'shr_' + 'a'.repeat(16), path: '/srv/shares/team', clients: [{ host: '10.0.0.0/24', permission: 'rw', squashRoot: true, subtreeCheck: true }] }] }
const observed = (overrides: Record<string, unknown> = {}) => ({ state: 'read', managedPresent: true, shares: config.shares.map(share => ({ ...share, exportState: 'exported' })), foreignExports: ['/data'], reason: null, ...overrides })
const savedOf = (value: unknown) => ({ saved: { config: value === null ? { shares: [] } : value, savedRevision: savedShareConfigRevision(value), revision: shareConfigRevision(value === null ? { shares: [] } : value as ShareConfig), invalid: false }, observed: observed() })

const helpers = (overrides: Partial<FileSharingWorkspaceHelpers> = {}) => {
  let stored: unknown = null
  const events: string[] = []
  const value: FileSharingWorkspaceHelpers = {
    requireCaller: async () => { events.push('auth'); return root },
    assertRoot: async (_caller, action) => { events.push('root:' + action) },
    emitAudit: async entry => { events.push('audit:' + entry.action) },
    readSaved: async () => stored,
    writeSaved: async value => { stored = value; return value },
    callHost: async (_caller, path, body) => { events.push('host:' + path); return path.endsWith('/apply') ? { active: observed(), appliedRevision: shareConfigRevision(config) } : savedOf(stored) },
    ...overrides,
  }
  return { value, events, setStored: (next: unknown) => { void next } }
}
const call = (h: FileSharingWorkspaceHelpers, path: string, method = 'GET', body?: unknown) => {
  const url = new URL('http://localhost' + path)
  return handleFileSharingWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, h)
}

describe('file sharing API workspace', () => {
  it('is root-only server policy on the xWHM listener', () => {
    for (const path of ['/api/server/file-sharing', '/api/server/file-sharing/apply']) {
      expect(policyForRequest(path, 'POST')).toMatchObject({ resource: 'server', rootOnly: true })
      expect(entryPointAllowsApiRoute('xwhm', path, 'POST')).toBe(true)
      expect(entryPointAllowsApiRoute('xpanel', path, 'POST')).toBe(false)
    }
  })
  it('projects the host observation and rejects anything outside the reviewed shape', () => {
    expect(projectShareObservation(observed()).foreignExports).toEqual(['/data'])
    for (const bad of [observed({ shares: [{ id: 'bad', path: '/srv/shares/x', clients: [], exportState: 'exported' }] }), observed({ foreignExports: ['relative'] }), observed({ reason: 'Bad Reason' }), observed({ shares: [{ ...config.shares[0], path: '/etc/x', exportState: 'exported' }] })])
      expect(() => projectShareObservation(bad)).toThrow()
  })
  it('reads saved shares with their revisions and host observation', async () => {
    const h = helpers()
    const body = await (await call(h.value, '/api/server/file-sharing'))!.json() as Record<string, any>
    expect(body).toMatchObject({ config: { shares: [] }, invalid: false, observed: { state: 'read' } })
    expect(body.savedRevision).toMatch(/^[0-9a-f]{64}$/)
  })
  it('saves a validated config with optimistic concurrency and verifies the write', async () => {
    const h = helpers()
    const first = await (await call(h.value, '/api/server/file-sharing'))!.json() as Record<string, any>
    const saved = await call(h.value, '/api/server/file-sharing', 'PUT', { config, expectedSavedRevision: first.savedRevision })
    expect(await saved!.json()).toMatchObject({ config: { shares: [{ path: '/srv/shares/team' }] }, activeRevision: shareConfigRevision(config) })
    expect(h.events).toContain('audit:server.file-sharing.saved')
    await expect(call(h.value, '/api/server/file-sharing', 'PUT', { config, expectedSavedRevision: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call(h.value, '/api/server/file-sharing', 'PUT', { config: { shares: [{ id: 'bad', path: '/etc', clients: [] }] }, expectedSavedRevision: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('forwards an apply with exact revisions and projects the active state', async () => {
    const h = helpers()
    const response = await call(h.value, '/api/server/file-sharing/apply', 'POST', { expectedRevision: 'a'.repeat(64), expectedActiveRevision: 'b'.repeat(64) })
    expect(await response!.json()).toMatchObject({ appliedRevision: shareConfigRevision(config), active: { state: 'read' } })
    expect(h.events).toContain('audit:server.file-sharing.apply_requested')
    expect(h.events).toContain('host:/host/file-sharing/apply')
    await expect(call(h.value, '/api/server/file-sharing/apply', 'POST', { expectedRevision: 'x', expectedActiveRevision: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('reports an unknown outcome when the apply transport fails after the request', async () => {
    const h = helpers({ callHost: async () => { throw Object.assign(new Error('transport'), { code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true } }) } })
    await expect(call(h.value, '/api/server/file-sharing/apply', 'POST', { expectedRevision: 'a'.repeat(64), expectedActiveRevision: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
  })
})

void renderManagedExports
