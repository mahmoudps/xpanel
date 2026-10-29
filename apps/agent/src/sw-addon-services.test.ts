import { describe, expect, it, vi } from 'vitest'
import { isSwAddonServiceCommand, readSwAddonServicesView, SW_ADDON_SERVICES, swAddonActionArgv } from '../../../packages/os/src/sw-addon-command.ts'
import { isServiceManagerCommand } from '../../../packages/os/src/service-manager-command.ts'
import { buildSwAddonJobPlan, handleSwAddonServicesRoute, parseSwAddonUnit } from './sw-addon-services.ts'
import type { SwAddonRouteContext } from './sw-addon-services.ts'
import type { HostJobPlan } from './host-job-contract.ts'

const show = (unit: string, load = 'loaded', active = 'active', sub = 'running', boot = 'enabled') => `Id=${unit}\nNames=${unit}\nLoadState=${load}\nActiveState=${active}\nSubState=${sub}\nUnitFileState=${boot}\n`
const context = (overrides: Partial<SwAddonRouteContext> = {}, units: Record<string, string> = {}) => {
  const submitted: HostJobPlan[] = []
  const run = vi.fn(async (argv: readonly string[]) => { const unit = argv.at(-1)!; return { ok: true, code: 0, stdout: units[unit] ?? show(unit, 'not-found', 'inactive', 'dead', ''), stderr: '' } })
  const ctx: SwAddonRouteContext = { assertRoot: async () => ({ actor: 'root' }), run, submitJob: async plan => { submitted.push(plan); return { id: 'job-1', kind: plan.kind } as never }, audit: vi.fn(async () => {}), now: () => new Date('2026-10-28T00:00:00.000Z'), ...overrides }
  return { ctx, run, submitted }
}
const call = (ctx: SwAddonRouteContext, path: string, body?: unknown) => {
  const url = new URL('http://agent.local' + path)
  return handleSwAddonServicesRoute(new Request(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, body === undefined ? 'GET' : 'POST', ctx)
}

describe('add-on service grammar and observation', () => {
  it('admits only fixed units for start/stop/restart and reuses the reviewed show command', () => {
    for (const service of SW_ADDON_SERVICES) for (const action of ['start', 'stop', 'restart'] as const) expect(isSwAddonServiceCommand(swAddonActionArgv(action, service))).toBe(true)
    for (const argv of [['/usr/bin/systemctl', 'start', '--', 'nginx.service'], ['/usr/bin/systemctl', 'enable', '--', 'memcached.service'], ['/usr/bin/systemctl', 'start', 'memcached.service'], ['/bin/systemctl', 'start', '--', 'memcached.service']]) expect(isSwAddonServiceCommand(argv)).toBe(false)
    expect(isServiceManagerCommand(['/usr/bin/systemctl', 'show', '--no-pager', '--property=Id,Names,LoadState,ActiveState,SubState,UnitFileState', '--', 'rabbitmq-server.service'])).toBe(true)
  })
  it('parses loaded and not-found units and refuses ambiguous properties', () => {
    expect(parseSwAddonUnit(show('memcached.service'), 'memcached.service')).toEqual({ load: 'loaded', active: 'active', sub: 'running', boot: 'enabled' })
    expect(parseSwAddonUnit(show('opensearch.service', 'not-found', 'inactive', 'dead', ''), 'opensearch.service').boot).toBeNull()
    for (const bad of [show('memcached.service') + 'LoadState=loaded\n', show('other.service'), show('memcached.service', 'loaded', 'active', 'running', ''), show('memcached.service').replace('running', 'Running!')]) expect(() => parseSwAddonUnit(bad, 'memcached.service')).toThrow()
  })
  it('reads all four services with truthful states and per-unit revisions', async () => {
    const { ctx } = context({}, { 'memcached.service': show('memcached.service') })
    const view = readSwAddonServicesView(await (await call(ctx, '/host/software/addon-services'))!.json())
    expect(view.services.map(item => [item.id, item.load, item.active])).toEqual([['memcached', 'loaded', 'active'], ['rabbitmq', 'not-found', 'inactive'], ['elasticsearch', 'not-found', 'inactive'], ['opensearch', 'not-found', 'inactive']])
    expect(view.actions.control).toBe(true)
    const host = context({ run: null })
    expect(((await (await call(host.ctx, '/host/software/addon-services'))!.json()) as { reason: unknown }).reason).toBe('unsupported-host')
    const broken = context({ run: async () => ({ ok: true, stdout: 'garbage', stderr: '' }) })
    expect(readSwAddonServicesView(await (await call(broken.ctx, '/host/software/addon-services'))!.json()).services.every(item => item.state === 'unavailable')).toBe(true)
  })
})

describe('add-on service changes', () => {
  it('requires the observed revision, an installed unit and a real state transition', async () => {
    const { ctx, submitted } = context({}, { 'memcached.service': show('memcached.service') })
    const revision = readSwAddonServicesView(await (await call(ctx, '/host/software/addon-services'))!.json()).services[0]!.revision!
    await expect(call(ctx, '/host/software/addon-services/action', { serviceId: 'nginx', action: 'stop', expectedRevision: revision })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(ctx, '/host/software/addon-services/action', { serviceId: 'memcached', action: 'stop', expectedRevision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call(ctx, '/host/software/addon-services/action', { serviceId: 'memcached', action: 'start', expectedRevision: revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const rabbit = readSwAddonServicesView(await (await call(ctx, '/host/software/addon-services'))!.json()).services[1]!.revision!
    await expect(call(ctx, '/host/software/addon-services/action', { serviceId: 'rabbitmq', action: 'start', expectedRevision: rabbit })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await call(ctx, '/host/software/addon-services/action', { serviceId: 'memcached', action: 'restart', expectedRevision: revision }))!.status).toBe(202)
    expect(submitted[0]!.kind).toBe('software.addon.restart')
    const noRunner = context({ submitJob: null }, { 'memcached.service': show('memcached.service') })
    await expect(call(noRunner.ctx, '/host/software/addon-services/action', { serviceId: 'memcached', action: 'stop', expectedRevision: revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('verifies the effect from systemd and refuses a changed unit before the step', async () => {
    let text = show('memcached.service')
    const run = async () => ({ ok: true, code: 0, stdout: text, stderr: '', timedOut: false })
    const service = SW_ADDON_SERVICES[0]!
    const revision = readSwAddonServicesView(await (await call(context({}, { 'memcached.service': text }).ctx, '/host/software/addon-services'))!.json()).services[0]!.revision!
    const plan = buildSwAddonJobPlan({ service, action: 'stop', expectedRevision: revision, revalidate: { run, assertActor: async () => {} } })
    expect(plan.policy(plan.steps[0]!.argv)).toBe(true); expect(plan.policy(['/usr/bin/systemctl', 'mask', '--', 'memcached.service'])).toBe(false)
    await plan.beforeStep!(plan.steps[0]!)
    expect((await plan.verify!(run)).ok).toBe(false)
    text = show('memcached.service', 'loaded', 'inactive', 'dead'); expect((await plan.verify!(run)).ok).toBe(true)
    await expect(plan.beforeStep!(plan.steps[0]!)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
