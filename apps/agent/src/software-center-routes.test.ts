import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { handleSoftwareCenterRoute } from './software-center-routes.ts'
import type { SoftwareCenterRouteContext } from './software-center-routes.ts'
import type { SoftwareCenterRun } from './software-center.ts'

const installed: Record<string, string> = { nginx: '1.24.0', 'php8.3-cli': '8.3.6', 'php8.3-fpm': '8.3.6', git: '1:2.43.0', 'libdbi-perl': '1.643', 'libclass-dbi-perl': '3.0.17' }
const simulations: Record<string, string> = {
  'install memcached': 'Inst memcached (1.6.24 Ubuntu:24.04/noble [amd64])\nConf memcached (1.6.24 Ubuntu:24.04/noble [amd64])\n',
  'remove libdbi-perl': 'Remv libclass-dbi-perl [3.0.17]\nRemv libdbi-perl [1.643]\n',
}
const run: SoftwareCenterRun = async argv => {
  const names = argv.slice(argv.indexOf('--') + 1)
  if (argv[0] === '/usr/bin/dpkg-query') return { ok: true, code: 0, stderr: '', stdout: Object.entries(installed).map(([name, version]) => `${name}\t${version}\tinstall ok installed`).join('\n') + '\n' }
  if (argv[0] === '/usr/bin/apt-cache') return { ok: true, code: 0, stderr: '', stdout: names.map(name => `${name}:\n  Installed: (none)\n  Candidate: 1.0\n`).join('') }
  const stdout = simulations[(argv.includes('install') ? 'install ' : 'remove ') + names.join(' ')]
  if (stdout === undefined) throw new Error('unexpected ' + argv.join(' '))
  return { ok: true, code: 0, stdout, stderr: '' }
}
const job = (plan: HostJobPlan, actor: string): HostJobView => ({ id: 'job-1', referenceCode: null, kind: plan.kind, status: 'queued', progress: 0, summary: plan.summary, accountId: null, actor, createdAt: '2026-10-27T10:00:00.000Z', startedAt: null, finishedAt: null, steps: plan.steps.map(step => ({ id: step.id, title: step.title, state: 'pending', exitCode: null })), error: null, failureClass: null, cancelRequested: false, verification: null, logBytes: 0 })
const context = (overrides: Partial<SoftwareCenterRouteContext> = {}): SoftwareCenterRouteContext & { roots: string[] } => {
  const roots: string[] = []
  return { roots, assertRoot: async action => { roots.push(action); return { actor: 'root' } }, family: 'debian', run, submitJob: vi.fn(async (plan: HostJobPlan, actor: string) => job(plan, actor)), now: () => new Date('2026-10-27T10:00:00.000Z'), ...overrides }
}
const call = (path: string, method = 'GET', body?: unknown, ctx = context(), type = 'application/json') => {
  const url = new URL('http://agent.local' + path)
  return handleSoftwareCenterRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': type } }) }), url, method, ctx)
}
const revisionOf = async (): Promise<string> => ((await (await call('/host/software-center?page=catalog'))!.json()) as { revision: string }).revision

describe('software center host routes', () => {
  it('ignores unrelated paths without authenticating', async () => {
    const ctx = context()
    expect(await call('/host/software-centers', 'GET', undefined, ctx)).toBeNull()
    expect(ctx.roots).toEqual([])
  })
  it('requires root before any host read and re-checks it afterwards', async () => {
    const reads = vi.fn(run)
    await expect(call('/host/software-center?page=catalog', 'GET', undefined, context({ run: reads, assertRoot: async () => fail('FORBIDDEN', 'root role is required') }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(reads).not.toHaveBeenCalled()
    const ctx = context()
    const response = await call('/host/software-center?page=runtime', 'GET', undefined, ctx)
    expect(response!.status).toBe(200)
    expect(ctx.roots).toEqual(['software.center.read', 'software.center.read'])
    const body = await response!.json() as Record<string, unknown> & { components: { page: string; id: string }[] }
    expect(body).toMatchObject({ state: 'read', page: 'runtime', family: 'debian', actions: { manage: true }, sources: [{ id: 'shipped', state: 'trusted' }, { id: 'external', state: 'unavailable' }] })
    expect(body.components.every(item => item.page === 'runtime')).toBe(true)
    expect(body).not.toHaveProperty('packages')
    expect(response!.headers.get('cache-control')).toBe('no-store')
  })
  it.each(['/host/software-center', '/host/software-center?page=all', '/host/software-center?page=catalog&page=module', '/host/software-center?page=catalog&path=/etc'])('refuses selector %s before reading', async path => {
    const reads = vi.fn(run)
    await expect(call(path, 'GET', undefined, context({ run: reads }))).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(reads).not.toHaveBeenCalled()
  })
  it('is truthfully unavailable off a native host and reports read-only mode without a runner', async () => {
    await expect(call('/host/software-center?page=catalog', 'GET', undefined, context({ family: null, run: null }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const body = await (await call('/host/software-center?page=module', 'GET', undefined, context({ submitJob: null })))!.json() as { actions: { manage: boolean }; components: { id: string }[] }
    expect(body.actions.manage).toBe(false)
    expect(body.components.map(item => item.id)).toContain('php83-redis')
    await expect(call('/host/software-center/apply', 'POST', { action: 'install', componentIds: ['memcached'], expectedRevision: 'a'.repeat(64) }, context({ submitJob: null }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('enforces methods and a strict JSON grammar', async () => {
    expect((await call('/host/software-center/preview', 'GET'))!.status).toBe(405)
    expect((await call('/host/software-center?page=catalog', 'POST', {}))!.headers.get('allow')).toBe('GET')
    const revision = 'a'.repeat(64)
    for (const body of [{ action: 'purge', componentIds: ['git'], expectedRevision: revision }, { action: 'install', componentIds: [], expectedRevision: revision }, { action: 'install', componentIds: ['Git'], expectedRevision: revision },
      { action: 'install', componentIds: ['git'], expectedRevision: 'x' }, { action: 'install', componentIds: ['git'], expectedRevision: revision, packages: ['nginx'] }, { action: 'install', componentIds: ['git'], expectedRevision: revision, acceptExtraRemovals: revision }])
      await expect(call('/host/software-center/preview', 'POST', body)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/host/software-center/preview', 'POST', { action: 'install', componentIds: ['git'], expectedRevision: revision }, context(), 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/host/software-center/preview?x=1', 'POST', { action: 'install', componentIds: ['git'], expectedRevision: revision })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('previews against the reviewed revision and returns 409 when packages changed', async () => {
    const revision = await revisionOf()
    const response = await call('/host/software-center/preview', 'POST', { action: 'install', componentIds: ['memcached'], expectedRevision: revision })
    expect(await response!.json()).toMatchObject({ preview: { state: 'ready', revision, requestedPackages: ['memcached'] } })
    await expect(call('/host/software-center/preview', 'POST', { action: 'install', componentIds: ['memcached'], expectedRevision: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT', detail: { currentRevision: revision, stateChanged: false } })
  })
  it('submits a reviewed job only after a fresh root check and answers 202', async () => {
    const revision = await revisionOf(), ctx = context()
    const response = await call('/host/software-center/apply', 'POST', { action: 'install', componentIds: ['memcached'], expectedRevision: revision }, ctx)
    expect(response!.status).toBe(202)
    expect(await response!.json()).toMatchObject({ job: { id: 'job-1', kind: 'software.component.install', status: 'queued' } })
    expect(ctx.roots).toEqual(['software.center.apply', 'software.center.apply'])
    const [plan, actor] = (ctx.submitJob as ReturnType<typeof vi.fn>).mock.calls[0]! as [HostJobPlan, string]
    expect(actor).toBe('root')
    expect(plan.steps[0]!.argv.at(-1)).toBe('memcached')
  })
  it('refuses unreviewed extra removals, refused previews and changed authority without submitting', async () => {
    const revision = await revisionOf()
    const extras = context()
    await expect(call('/host/software-center/apply', 'POST', { action: 'remove', componentIds: ['perl-dbi'], expectedRevision: revision }, extras)).rejects.toMatchObject({ code: 'CONFLICT', detail: { extraRemovals: ['libclass-dbi-perl'] } })
    const preview = await (await call('/host/software-center/preview', 'POST', { action: 'remove', componentIds: ['perl-dbi'], expectedRevision: revision }))!.json() as { preview: { extraRemovalsFingerprint: string } }
    const accepted = context()
    expect((await call('/host/software-center/apply', 'POST', { action: 'remove', componentIds: ['perl-dbi'], expectedRevision: revision, acceptExtraRemovals: preview.preview.extraRemovalsFingerprint }, accepted))!.status).toBe(202)
    const refused = context()
    await expect(call('/host/software-center/apply', 'POST', { action: 'install', componentIds: ['git'], expectedRevision: revision }, refused)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'nothing-to-do' } })
    let count = 0
    const changed = context({ assertRoot: async () => ({ actor: count++ ? 'other-root' : 'root' }) })
    await expect(call('/host/software-center/apply', 'POST', { action: 'install', componentIds: ['memcached'], expectedRevision: revision }, changed)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    for (const ctx of [extras, refused, changed]) expect(ctx.submitJob).not.toHaveBeenCalled()
  })
  it('reports an unknown outcome when submission fails ambiguously and propagates known refusals', async () => {
    const revision = await revisionOf(), body = { action: 'install', componentIds: ['memcached'], expectedRevision: revision }
    await expect(call('/host/software-center/apply', 'POST', body, context({ submitJob: async () => { throw new Error('socket closed') } }))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, stateChanged: true } })
    await expect(call('/host/software-center/apply', 'POST', body, context({ submitJob: async () => fail('CONFLICT', 'another package job is running', { stateChanged: false }) }))).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
  })
})
