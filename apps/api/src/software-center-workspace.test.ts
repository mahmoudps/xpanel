import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleSoftwareCenterWorkspaceRoute } from './software-center-workspace.ts'
import type { SoftwareCenterWorkspaceHelpers } from './software-center-workspace.ts'

const root = { principal: { kind: 'root', id: 'fixture-root', username: 'root' } } as AuthenticatedCaller
const reseller = { principal: { kind: 'reseller', id: 'fixture-reseller', username: 'reseller' } } as AuthenticatedCaller
const revision = 'a'.repeat(64)
const view = (page: string) => ({ state: 'read', page, revision, components: [], sources: [] })
function helpers(overrides: Partial<SoftwareCenterWorkspaceHelpers> = {}) {
  const events: string[] = []
  const value: SoftwareCenterWorkspaceHelpers = {
    requireCaller: vi.fn(async () => { events.push('auth'); return root }),
    assertRoot: vi.fn(async (caller: AuthenticatedCaller) => { events.push('root'); if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required for this operation') }),
    emitAudit: vi.fn(async (input: { action: string }) => { events.push('audit:' + input.action) }),
    callHost: vi.fn(async (_caller: AuthenticatedCaller, path: string, input?: unknown, mutation?: boolean) => {
      events.push('host:' + path + (mutation ? ':mutation' : ''))
      if (path.startsWith('/host/software-center?page=')) return view(path.split('=')[1]!)
      if (path.endsWith('/preview')) return { preview: { state: 'ready', revision: (input as { expectedRevision: string }).expectedRevision } }
      return { job: { id: 'job-1', kind: 'software.component.' + (input as { action: string }).action, status: 'queued' } }
    }),
    ...overrides,
  }
  return { value, events }
}
const call = (path: string, method = 'GET', body?: unknown, h = helpers().value, type = 'application/json') => {
  const url = new URL('http://localhost' + path)
  return handleSoftwareCenterWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': type } }) }), url, method, h)
}

describe('software center API workspace', () => {
  it('leaves unrelated routes untouched', async () => {
    const h = helpers()
    expect(await call('/api/server/software', 'GET', undefined, h.value)).toBeNull()
    expect(h.events).toEqual([])
  })
  it('authenticates and requires root before forwarding a page read, then re-checks', async () => {
    const h = helpers()
    const response = await call('/api/server/software-center?page=module', 'GET', undefined, h.value)
    expect(response!.status).toBe(200)
    expect(await response!.json()).toMatchObject({ page: 'module', revision })
    expect(h.events).toEqual(['auth', 'root', 'host:/host/software-center?page=module', 'auth', 'root'])
  })
  it('refuses non-root callers with 403 before any host call', async () => {
    const h = helpers({ requireCaller: vi.fn(async () => reseller) })
    await expect(call('/api/server/software-center?page=catalog', 'GET', undefined, h.value)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    await expect(call('/api/server/software-center/apply', 'POST', { action: 'install', componentIds: ['git'], expectedRevision: revision }, h.value)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.value.callHost).not.toHaveBeenCalled()
    expect(h.value.emitAudit).not.toHaveBeenCalled()
  })
  it.each(['', '?page=all', '?page=catalog&command=apt-get', '?page=catalog&page=module'])('refuses read selector %j', async query => {
    const h = helpers()
    await expect(call('/api/server/software-center' + query, 'GET', undefined, h.value)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(h.value.callHost).not.toHaveBeenCalled()
  })
  it.each([
    { action: 'purge', componentIds: ['git'], expectedRevision: revision },
    { action: 'install', componentIds: ['git'], expectedRevision: revision, packages: ['nginx'] },
    { action: 'install', componentIds: ['../etc'], expectedRevision: revision },
    { action: 'install', componentIds: Array.from({ length: 17 }, (_, index) => 'c' + index), expectedRevision: revision },
    { action: 'install', componentIds: ['git'], expectedRevision: 'nope' },
    { action: 'remove', componentIds: ['git'], expectedRevision: revision, acceptExtraRemovals: 'x' },
  ])('refuses invalid change grammar %j without forwarding', async body => {
    const h = helpers()
    await expect(call('/api/server/software-center/apply', 'POST', body, h.value)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(h.value.callHost).not.toHaveBeenCalled()
  })
  it('does not accept the extra-removal acknowledgement on a preview, selectors or non-JSON', async () => {
    await expect(call('/api/server/software-center/preview', 'POST', { action: 'remove', componentIds: ['git'], expectedRevision: revision, acceptExtraRemovals: revision })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/api/server/software-center/preview?x=1', 'POST', { action: 'remove', componentIds: ['git'], expectedRevision: revision })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/api/server/software-center/preview', 'POST', { action: 'remove', componentIds: ['git'], expectedRevision: revision }, helpers().value, 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call('/api/server/software-center/preview', 'GET'))!.status).toBe(405)
    expect((await call('/api/server/software-center?page=catalog', 'POST', {}))!.headers.get('allow')).toBe('GET')
  })
  it('forwards a preview bound to the reviewed revision', async () => {
    const h = helpers()
    const response = await call('/api/server/software-center/preview', 'POST', { action: 'install', componentIds: ['git'], expectedRevision: revision }, h.value)
    expect(await response!.json()).toEqual({ preview: { state: 'ready', revision } })
    expect(h.value.callHost).toHaveBeenCalledWith(root, '/host/software-center/preview', { action: 'install', componentIds: ['git'], expectedRevision: revision })
    await expect(call('/api/server/software-center/preview', 'POST', { action: 'install', componentIds: ['git'], expectedRevision: revision }, helpers({ callHost: vi.fn(async () => ({ preview: { state: 'ready', revision: 'b'.repeat(64) } })) }).value)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('audits, re-checks root around the mutation and returns the submitted job', async () => {
    const h = helpers()
    const body = { action: 'remove', componentIds: ['perl-dbi'], expectedRevision: revision, acceptExtraRemovals: 'c'.repeat(64) }
    const response = await call('/api/server/software-center/apply', 'POST', body, h.value)
    expect(response!.status).toBe(202)
    expect(await response!.json()).toEqual({ job: { id: 'job-1', kind: 'software.component.remove', status: 'queued' } })
    expect(h.events).toEqual(['auth', 'root', 'audit:software.component.change_requested', 'auth', 'root', 'host:/host/software-center/apply:mutation', 'auth', 'root', 'audit:software.component.job_submitted'])
  })
  it('propagates agent conflicts and treats an unverifiable acknowledgement as an unknown outcome', async () => {
    const body = { action: 'install', componentIds: ['git'], expectedRevision: revision }
    await expect(call('/api/server/software-center/apply', 'POST', body, helpers({ callHost: vi.fn(async () => fail('CONFLICT', 'the protected host request was refused', { stateChanged: false })) }).value)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 })
    await expect(call('/api/server/software-center/apply', 'POST', body, helpers({ callHost: vi.fn(async () => ({ job: { id: 'job-1', kind: 'system.packages.upgrade' } })) }).value)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    let calls = 0
    const changed = helpers({ requireCaller: vi.fn(async () => calls++ < 2 ? root : { principal: { kind: 'root', id: 'other-root', username: 'other' } } as AuthenticatedCaller) })
    await expect(call('/api/server/software-center/apply', 'POST', body, changed.value)).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: true } })
  })
})
