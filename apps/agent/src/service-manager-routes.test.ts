import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { handleServiceManagerRoute, parseServiceManagerInput } from './service-manager-routes.ts'
import type { ServiceManagerRouteContext } from './service-manager-routes.ts'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { readServiceManager } from './service-manager.ts'
const at = new Date('2026-10-27T00:00:00.000Z')
const good = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' })
const run = async (argv: readonly string[]) => good(argv.includes('list-units') ? 'memcached.service loaded active running Cache\nssh.service loaded active running SSH\n' : argv.includes('list-unit-files') ? 'memcached.service disabled enabled\nssh.service enabled enabled\n' : argv.includes('cat') ? '[Install]\nWantedBy=multi-user.target\n' : `Id=${argv.at(-1)}\nNames=${argv.at(-1)}\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=disabled\n`)
const context = (overrides: Partial<ServiceManagerRouteContext> = {}): ServiceManagerRouteContext => ({ assertRoot: vi.fn(async () => ({ actor: 'root' })), run, readFile: async () => 'btime 1793000000\n', now: () => at, audit: vi.fn(async () => {}), submitJob: vi.fn(async (plan: HostJobPlan) => ({ id: 'job-1', kind: plan.kind, status: 'queued' } as HostJobView)), ...overrides })
const call = (ctx: ServiceManagerRouteContext, body?: unknown, path = '/host/service-manager' + (body === undefined ? '' : '/action'), method = body === undefined ? 'GET' : 'POST') => { const req = new Request('http://local' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); return handleServiceManagerRoute(req, new URL(req.url), method, ctx) }
const revision = async () => (await readServiceManager({ run, readFile: async () => 'btime 1793000000\n', now: () => at })).revision!
const readState = (value: unknown): 'read' | 'unavailable' => {
  if (!value || typeof value !== 'object' || !('state' in value) || value.state !== 'read' && value.state !== 'unavailable') throw new Error('invalid_service_view_fixture')
  return value.state
}

describe('service manager host routes', () => {
  it('returns only its route and guards query/method/native availability', async () => {
    expect(await call(context(), undefined, '/other')).toBeNull()
    expect((await call(context(), undefined, '/host/service-manager', 'DELETE'))!.status).toBe(405)
    await expect(call(context(), undefined, '/host/service-manager?unit=ssh')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(context({ run: null }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call(context({ assertRoot: async () => fail('FORBIDDEN', 'root only') }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('rechecks root after observations', async () => {
    const ctx = context(); const response = await call(ctx)
    expect(readState(await response!.json())).toBe('read'); expect(ctx.assertRoot).toHaveBeenCalledTimes(2)
    let checks = 0
    await expect(call(context({ assertRoot: async () => ({ actor: checks++ ? 'another-root' : 'root' }) }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it.each([{}, { action: 'restart', unit: 'ssh.service', expectedRevision: 'a'.repeat(64), injected: true }, { action: 'reboot', expectedRevision: 'a'.repeat(64), confirmation: 'yes' }, { action: 'disable', unit: '../x.service', expectedRevision: 'a'.repeat(64) }, { action: 'start', unit: 'ssh.service', expectedRevision: 'a'.repeat(64) }])('rejects malformed action %j', value => expect(() => parseServiceManagerInput(value)).toThrow())
  it('submits isolated boot and restart jobs only after audit and fresh auth', async () => {
    const events: string[] = [], ctx = context({ assertRoot: async () => { events.push('auth'); return { actor: 'root' } }, audit: async () => { events.push('audit') }, submitJob: async plan => { events.push('submit'); return { id: 'job-1', kind: plan.kind, status: 'queued' } as HostJobView } })
    const response = await call(ctx, { action: 'enable', unit: 'memcached.service', expectedRevision: await revision() })
    expect(response!.status).toBe(202); expect(await response!.json()).toMatchObject({ outcome: 'submitted', verificationRequired: true })
    expect(events.slice(-3)).toEqual(['audit', 'auth', 'submit'])
    expect((await call(context(), { action: 'restart', unit: 'ssh.service', expectedRevision: await revision() }))!.status).toBe(202)
  })
  it('refuses stale revisions, protected units and audit failure without submission', async () => {
    for (const body of [{ action: 'enable', unit: 'memcached.service', expectedRevision: 'a'.repeat(64) }, { action: 'disable', unit: 'ssh.service', expectedRevision: await revision() }]) {
      const ctx = context(); await expect(call(ctx, body)).rejects.toBeTruthy(); expect(ctx.submitJob).not.toHaveBeenCalled()
    }
    const ctx = context({ audit: async () => { throw new Error('audit offline') } }); await expect(call(ctx, { action: 'enable', unit: 'memcached.service', expectedRevision: await revision() })).rejects.toThrow('audit offline'); expect(ctx.submitJob).not.toHaveBeenCalled()
  })
  it('requires exact reboot phrase and observable boot time, then returns attempted', async () => {
    const response = await call(context(), { action: 'reboot', confirmation: 'REBOOT SERVER', expectedRevision: await revision() })
    expect(await response!.json()).toMatchObject({ outcome: 'attempted', verificationRequired: true, unit: null })
    const ctx = context({ readFile: async () => null }), missingRevision = (await readServiceManager({ run, readFile: async () => null })).revision
    await expect(call(ctx, { action: 'reboot', confirmation: 'REBOOT SERVER', expectedRevision: missingRevision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' }); expect(ctx.submitJob).not.toHaveBeenCalled()
  })
  it('keeps ambiguous submissions uncertain and preserves known refusal', async () => {
    const body = { action: 'enable', unit: 'memcached.service', expectedRevision: await revision() }
    await expect(call(context({ submitJob: async () => { throw new Error('lost') } }), body)).rejects.toMatchObject({ detail: { unknownOutcome: true, verificationRequired: true } })
    await expect(call(context({ submitJob: async () => fail('CONFLICT', 'busy', { stateChanged: false }) }), body)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
  })
})
