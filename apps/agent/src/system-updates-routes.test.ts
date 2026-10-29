import { describe, expect, it, vi } from 'vitest'
import { APT_SHOW_HOLDS_ARGV, APT_UPGRADE_PREFIX } from '../../../packages/os/src/package-manager-command.ts'
import type { HostJobPlan } from './host-job-contract.ts'
import { readSystemUpdatePlan } from './package-manager.ts'
import { handleSystemUpdatesRoute } from './system-updates-routes.ts'
import type { SystemUpdatesRouteContext } from './system-updates-routes.ts'
import type { PackageSafety } from './ops-package-writers.ts'

const SIMULATION = 'Inst openssl [3.0.13-0ubuntu3.4] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-security [amd64])\nInst tzdata [2024a-3ubuntu1.1] (2024b-0ubuntu0.24.04 Ubuntu:24.04/noble-updates [all])\n'
const run = vi.fn(async (argv: string[]) => ({ ok: true, code: 0, stdout: argv.join(' ') === APT_SHOW_HOLDS_ARGV.join(' ') ? '' : SIMULATION, stderr: '' }))
const CLEAN: PackageSafety = { state: 'read', writers: [], database: 'clean' }
const revision = async () => (await readSystemUpdatePlan({ run, family: 'debian' })).revision!
const context = (overrides: Partial<SystemUpdatesRouteContext> = {}) => {
  const events: string[] = []
  const submitted: HostJobPlan[] = []
  const ctx: SystemUpdatesRouteContext = {
    assertRoot: async action => { events.push('root:' + action); return { actor: 'root' } },
    family: 'debian', run, readFile: async () => null,
    submitJob: async (plan, actor) => { events.push('submit:' + actor); submitted.push(plan); return { id: '0f9c3c1e-2b9a-4f43-9d55-8f1b7d0b3a11', status: 'queued' } },
    safety: async () => CLEAN,
    ...overrides,
  }
  return { ctx, events, submitted }
}
const call = (ctx: SystemUpdatesRouteContext, path: string, method = 'GET', body?: unknown, contentType = 'application/json') => {
  const url = new URL('http://agent.local' + path)
  return handleSystemUpdatesRoute(new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': contentType } }) }), url, method, ctx)
}

describe('agent system update routes', () => {
  it('ignores unrelated paths without authorization side effects', async () => {
    const { ctx, events } = context()
    expect(await call(ctx, '/host/php/inventory')).toBeNull()
    expect(events).toEqual([])
  })
  it('asserts root before reading and reports job availability truthfully', async () => {
    const { ctx, events } = context()
    const response = await call(ctx, '/host/system-updates/plan')
    expect(response!.status).toBe(200)
    expect(response!.headers.get('cache-control')).toBe('no-store')
    const body = await response!.json() as Record<string, unknown>
    expect(body.plan).toMatchObject({ state: 'read', source: 'apt', counts: { total: 2, security: 1 } })
    expect(body.actions).toEqual({ refresh: true, apply: true })
    expect(events).toEqual(['root:host.system-updates.read', 'root:host.system-updates.read'])
    const offline = await (await call(context({ submitJob: null }).ctx, '/host/system-updates/plan'))!.json() as Record<string, unknown>
    expect(offline.actions).toEqual({ refresh: false, apply: false })
  })
  it('returns an unavailable plan for unsupported hosts without running commands', async () => {
    const local = vi.fn()
    const body = await (await call(context({ family: null, run: local }).ctx, '/host/system-updates/plan'))!.json()
    expect(body).toMatchObject({ plan: { state: 'unavailable', reason: 'unsupported-host' }, actions: { refresh: false, apply: false } })
    expect(local).not.toHaveBeenCalled()
  })
  it('refuses denied callers, wrong methods and selectors before reading', async () => {
    run.mockClear()
    await expect(call(context({ assertRoot: async () => { throw new Error('denied') } }).ctx, '/host/system-updates/plan')).rejects.toThrow('denied')
    expect((await call(context().ctx, '/host/system-updates/apply'))!.status).toBe(405)
    expect((await call(context().ctx, '/host/system-updates/plan', 'POST', {}))!.headers.get('allow')).toBe('GET')
    await expect(call(context().ctx, '/host/system-updates/plan?family=rhel')).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(run).not.toHaveBeenCalled()
  })
  it.each([
    [{ expectedRevision: 'a'.repeat(64), mode: 'all', extra: true }],
    [{ expectedRevision: 'A'.repeat(64), mode: 'all' }],
    [{ expectedRevision: 'a'.repeat(64), mode: 'everything' }],
    [{ expectedRevision: 'a'.repeat(64), mode: 'all', packages: ['openssl'] }],
    [{ expectedRevision: 'a'.repeat(64), mode: 'selected' }],
    [{ expectedRevision: 'a'.repeat(64), mode: 'selected', packages: ['--allow-downgrades'] }],
    [{ expectedRevision: 'a'.repeat(64), mode: 'selected', packages: Array.from({ length: 501 }, (_, index) => 'p' + index) }],
    ['not json'],
    [[]],
  ])('rejects apply body %# without submitting', async body => {
    const { ctx, submitted } = context()
    await expect(call(ctx, '/host/system-updates/apply', 'POST', body)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(submitted).toEqual([])
  })
  it('requires JSON content', async () => {
    await expect(call(context().ctx, '/host/system-updates/refresh', 'POST', '{}', 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('returns 409 without submitting when the plan revision changed', async () => {
    const { ctx, submitted } = context()
    await expect(call(ctx, '/host/system-updates/apply', 'POST', { expectedRevision: '0'.repeat(64), mode: 'security' })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(submitted).toEqual([])
  })
  it('re-reads, re-asserts root right before submission and returns 202 with the job', async () => {
    const { ctx, events, submitted } = context()
    const response = await call(ctx, '/host/system-updates/apply', 'POST', { expectedRevision: await revision(), mode: 'selected', packages: ['tzdata'] })
    expect(response!.status).toBe(202)
    expect(await response!.json()).toEqual({ job: { id: '0f9c3c1e-2b9a-4f43-9d55-8f1b7d0b3a11', status: 'queued' } })
    expect(events).toEqual(['root:host.system-updates.apply', 'root:host.system-updates.apply', 'submit:root'])
    expect(submitted[0]!.kind).toBe('system.packages.upgrade')
    expect(submitted[0]!.steps[0]!.argv).toEqual([...APT_UPGRADE_PREFIX, 'tzdata'])
  })
  it('does not submit when root is lost after the plan re-read', async () => {
    let calls = 0
    const { ctx, submitted } = context({ assertRoot: async () => { if (++calls > 1) throw new Error('root revoked'); return { actor: 'root' } } })
    await expect(call(ctx, '/host/system-updates/apply', 'POST', { expectedRevision: await revision(), mode: 'all' })).rejects.toThrow('root revoked')
    expect(submitted).toEqual([])
  })
  it('returns truthful 412 when jobs or a supported host are unavailable', async () => {
    for (const overrides of [{ submitJob: null }, { family: null }] as const) {
      await expect(call(context(overrides).ctx, '/host/system-updates/refresh', 'POST', {})).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    }
  })
  it('submits a refresh job only for an exact empty body', async () => {
    const { ctx, submitted } = context()
    await expect(call(ctx, '/host/system-updates/refresh', 'POST', { force: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    const response = await call(ctx, '/host/system-updates/refresh', 'POST', {})
    expect(response!.status).toBe(202)
    expect(submitted.map(plan => plan.kind)).toEqual(['system.packages.refresh'])
  })
  it('reports competing writers and refuses jobs until the package manager is idle and the database is clean', async () => {
    const busy: PackageSafety = { state: 'read', writers: [{ pid: 4242, command: 'unattended-upgr' }], database: 'clean' }
    const read = await (await call(context({ safety: async () => busy }).ctx, '/host/system-updates/plan'))!.json() as Record<string, unknown>
    expect(read).toMatchObject({ safety: busy, actions: { refresh: false, apply: false } })
    for (const [safety, reason] of [[async () => busy, 'competing-package-writer'], [async (): Promise<PackageSafety> => ({ state: 'read', writers: [], database: 'interrupted' }), 'package-database-not-clean'], [null, 'package-safety-unverified'], [async () => { throw new Error('proc') }, 'package-safety-unverified']] as const) {
      const { ctx, submitted } = context({ safety })
      await expect(call(ctx, '/host/system-updates/apply', 'POST', { expectedRevision: await revision(), mode: 'all' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, reason } })
      await expect(call(ctx, '/host/system-updates/refresh', 'POST', {})).rejects.toMatchObject({ detail: { reason } })
      expect(submitted).toEqual([])
    }
  })
  it('fences every submitted step against a new writer and checks the database when the job settles', async () => {
    let current: PackageSafety = CLEAN
    const { ctx, submitted } = context({ safety: async () => current })
    expect((await call(ctx, '/host/system-updates/apply', 'POST', { expectedRevision: await revision(), mode: 'all' }))!.status).toBe(202)
    const plan = submitted[0]!
    expect(plan.detail).toMatchObject({ competingWritersChecked: true, recoveryRoute: '/whm/monitoring/repair' })
    await expect(plan.beforeStep!(plan.steps[0]!)).resolves.toBeUndefined()
    current = { state: 'read', writers: [{ pid: 7, command: 'dpkg' }], database: 'clean' }
    await expect(plan.beforeStep!(plan.steps[0]!)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'competing-package-writer' } })
    expect(plan.policy(['/usr/bin/dpkg', '--audit'])).toBe(true)
    expect(plan.policy(['/usr/bin/dpkg', '--configure', '-a'])).toBe(false)
    const audit = (stdout: string) => async () => ({ ok: true, code: 0, stdout, stderr: '', timedOut: false })
    await expect(plan.finalize!(audit(''), [])).resolves.toEqual({ ok: true, detail: { packageDatabase: 'clean' } })
    const interrupted = 'The following packages are only half configured, probably due to problems\nconfiguring them the first time.  The configuration should be retried using\ndpkg --configure <package> or the configure menu option in dselect:\n openssl  Secure Sockets Layer toolkit\n'
    await expect(plan.finalize!(audit(interrupted), [])).resolves.toEqual({ ok: false, detail: { packageDatabase: 'interrupted', recoveryRequired: true, recoveryRoute: '/whm/monitoring/repair' } })
    await expect(plan.finalize!(async () => { throw new Error('lost') }, [])).resolves.toMatchObject({ ok: false, detail: { packageDatabase: 'not-read' } })
  })
  it('marks an unverifiable submission receipt as an unknown outcome', async () => {
    const { ctx } = context({ submitJob: async () => ({ id: '<script>', status: 'queued' }) })
    await expect(call(ctx, '/host/system-updates/refresh', 'POST', {})).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: true, unknownOutcome: true } })
  })
})

describe('kernel-excluded agent route contract', () => {
  const kernels = SIMULATION + 'Inst linux-image-generic [6.8.0-50.51] (6.8.0-51.52 Ubuntu:24.04/noble-security [amd64])\n'
  const provider = (unsafe = false) => vi.fn(async (argv: string[]) => ({ ok: true, code: 0, stdout: argv[0] === '/usr/bin/apt-mark' ? '' : argv.includes('dist-upgrade') || unsafe ? kernels : SIMULATION, stderr: '' }))
  it('reads an exclusion-bound preview without hiding pending kernels and submits only protected nonkernel targets', async () => {
    const run = provider(), { ctx, submitted } = context({ run })
    const preview = await (await call(ctx, '/host/system-updates/plan?excludeKernel=true'))!.json() as any
    expect(preview.plan).toMatchObject({ excludeKernel: true, counts: { kernel: 1, total: 3 } })
    expect(preview.plan.packages.some((item: any) => item.name === 'linux-image-generic')).toBe(true)
    expect((await call(ctx, '/host/system-updates/apply', 'POST', { expectedRevision: preview.plan.revision, mode: 'all', excludeKernel: true }))!.status).toBe(202)
    expect(submitted[0]!.detail).toMatchObject({ excludeKernel: true, counts: { kernel: 0 } })
    expect(submitted[0]!.steps[0]!.argv).toEqual([...APT_UPGRADE_PREFIX, 'openssl', 'tzdata', 'linux-image-generic=6.8.0-50.51'])
    expect(submitted[0]!.beforeStep).toBeTypeOf('function')
  })
  it('refuses an option/revision mismatch or dependency kernel change before submission', async () => {
    const run = provider(), { ctx, submitted } = context({ run })
    const preview = await readSystemUpdatePlan({ run, family: 'debian', excludeKernel: true })
    await expect(call(ctx, '/host/system-updates/apply', 'POST', { expectedRevision: preview.revision, mode: 'all' })).rejects.toMatchObject({ code: 'CONFLICT' })
    const unsafe = context({ run: provider(true) })
    await expect(call(unsafe.ctx, '/host/system-updates/apply', 'POST', { expectedRevision: preview.revision, mode: 'all', excludeKernel: true })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(submitted).toEqual([]); expect(unsafe.submitted).toEqual([])
  })
  it('rejects caller exclusion lists, duplicate selectors and nonboolean options', async () => {
    for (const path of ['/host/system-updates/plan?excludeKernel=*', '/host/system-updates/plan?excludeKernel=true&excludeKernel=true']) await expect(call(context().ctx, path)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(context().ctx, '/host/system-updates/apply', 'POST', { expectedRevision: await revision(), mode: 'all', excludeKernel: 'true' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('rechecks root after the plan observation await', async () => {
    let checks = 0
    await expect(call(context({ assertRoot: async () => { if (++checks > 1) throw new Error('revoked'); return { actor: 'root' } } }).ctx, '/host/system-updates/plan?excludeKernel=true')).rejects.toThrow('revoked')
  })
})

