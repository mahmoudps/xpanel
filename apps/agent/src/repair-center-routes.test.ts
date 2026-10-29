import { describe, expect, it, vi } from 'vitest'
import { APT_CHECK_ARGV, APT_FIX_BROKEN_ARGV, APT_FIX_BROKEN_NO_REMOVE_ARGV, APT_FIX_PREVIEW_ARGV, DNF_CHECK_ARGV, DPKG_AUDIT_ARGV, RPMDB_VERIFY_ARGV, DNF_CACHE_CHECK_ARGV } from '../../../packages/os/src/repair-command.ts'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { handleRepairCenterRoute } from './repair-center-routes.ts'
import type { RepairCenterRouteContext } from './repair-center-routes.ts'
import { removalFingerprint } from './repair-center.ts'
import type { RepairCommandResult } from './repair-center.ts'

const out = (stdout: string, code = 0, stderr = ''): RepairCommandResult => ({ ok: code === 0, code, stdout, stderr })
const head = 'Reading package lists...\nBuilding dependency tree...\nReading state information...\n'
const aptBroken = out(head + 'The following packages have unmet dependencies:\n php8.3-fpm : Depends: php8.3-common (= 8.3.12-1) but 8.3.11-1 is installed\n', 100, 'E: Unmet dependencies. Try using -f.\n')
const simulateRemovals = out(head + '0 upgraded, 1 newly installed, 1 to remove and 0 not upgraded.\nRemv php8.3-fpm [8.3.11-1]\nInst php8.3-common (8.3.12-1 Debian:12.5/stable [amd64])\nConf php8.3-common (8.3.12-1 Debian:12.5/stable [amd64])\n')
const simulateClean = out(head + '1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\nInst php8.3-common [8.3.11-1] (8.3.12-1 Debian:12.5/stable [amd64])\nConf php8.3-common (8.3.12-1 Debian:12.5/stable [amd64])\n')
const key = (argv: readonly string[]): string => argv.join(' ')
const job = (plan: HostJobPlan, actor: string): HostJobView => ({ id: 'job-1', referenceCode: null, kind: plan.kind, status: 'queued', progress: 0, summary: plan.summary, accountId: null, actor, createdAt: '2026-10-27T10:00:00.000Z', startedAt: null, finishedAt: null, steps: [], error: null, failureClass: null, cancelRequested: false, verification: null, logBytes: 0 })

const context = (overrides: Partial<RepairCenterRouteContext> = {}, table: Record<string, RepairCommandResult> = {}) => {
  const commands: string[] = []
  const submitted: { plan: HostJobPlan; actor: string }[] = []
  const ctx: RepairCenterRouteContext = {
    assertRoot: vi.fn(async () => ({ actor: 'root' })),
    family: 'debian',
    run: async argv => { commands.push(key(argv)); const found = { [key(DPKG_AUDIT_ARGV)]: out(''), [key(APT_CHECK_ARGV)]: aptBroken, [key(APT_FIX_PREVIEW_ARGV)]: simulateRemovals, [key(DNF_CHECK_ARGV)]: out(''), [key(RPMDB_VERIFY_ARGV)]: out(''), [key(DNF_CACHE_CHECK_ARGV)]: out(''), ...table }[key(argv)]; if (!found) throw new Error('unexpected'); return found },
    submitJob: async (plan, actor) => { submitted.push({ plan, actor }); return job(plan, actor) },
    now: () => new Date('2026-10-27T10:00:00.000Z'),
    ...overrides,
  }
  return { ctx, commands, submitted }
}
const call = (ctx: RepairCenterRouteContext, path: string, method = 'GET', body?: unknown, contentType = 'application/json') => {
  const url = new URL('http://agent.local' + path)
  return handleRepairCenterRoute(new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': contentType } }) }), url, method, ctx)
}
const revisionOf = async (ctx: RepairCenterRouteContext): Promise<string> => ((await (await call(ctx, '/host/repair/diagnostics'))!.json()) as { revision: string }).revision

describe('repair center agent routes', () => {
  it('serves diagnostics only to a root caller, re-checking authority after the host reads', async () => {
    const { ctx, commands } = context()
    const response = await call(ctx, '/host/repair/diagnostics')
    expect(response!.status).toBe(200)
    expect(response!.headers.get('cache-control')).toBe('no-store')
    const body = await response!.json() as { diagnostics: { id: string; state: string }[] }
    expect(body.diagnostics.map(item => [item.id, item.state])).toEqual([['dpkg-interrupted', 'ok'], ['apt-broken-dependencies', 'problem'], ['configuration-drift', 'unavailable']])
    expect(ctx.assertRoot).toHaveBeenCalledTimes(2)
    expect(commands).toEqual([key(DPKG_AUDIT_ARGV), key(APT_CHECK_ARGV)])
    const denied = context({ assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' }) } })
    await expect(call(denied.ctx, '/host/repair/diagnostics')).rejects.toThrow('root role is required')
    expect(denied.commands).toEqual([])
  })

  it('refuses other methods, selectors, unsupported profiles and simulated executors', async () => {
    const { ctx, commands } = context()
    expect(await call(ctx, '/host/other')).toBeNull()
    const wrong = await call(ctx, '/host/repair/diagnostics', 'POST', {})
    expect(wrong!.status).toBe(405); expect(wrong!.headers.get('allow')).toBe('GET')
    expect((await call(ctx, '/host/repair/run'))!.status).toBe(405)
    await expect(call(ctx, '/host/repair/diagnostics?family=rhel')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(context({ family: 'arch' }).ctx, '/host/repair/diagnostics')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call(context({ run: null }).ctx, '/host/repair/diagnostics')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(commands).toEqual([])
  })

  it.each([
    ['extra field', { repairId: 'apt-fix-broken', expectedRevision: 'a'.repeat(64), argv: ['/bin/sh'] }],
    ['unknown repair', { repairId: 'dnf-repair', expectedRevision: 'a'.repeat(64) }],
    ['short revision', { repairId: 'apt-fix-broken', expectedRevision: 'abc' }],
    ['acceptance without list', { repairId: 'apt-fix-broken', expectedRevision: 'a'.repeat(64), acceptRemovals: true }],
    ['list without acceptance', { repairId: 'apt-fix-broken', expectedRevision: 'a'.repeat(64), expectedRemovals: 'b'.repeat(64) }],
    ['dpkg removals', { repairId: 'dpkg-configure', expectedRevision: 'a'.repeat(64), acceptRemovals: false }],
    ['metadata removals', { repairId: 'dnf-cache-refresh', expectedRevision: 'a'.repeat(64), acceptRemovals: false }],
    ['array body', ['apt-fix-broken']],
  ])('refuses run grammar: %s', async (_name, body) => {
    const { ctx, commands, submitted } = context()
    await expect(call(ctx, '/host/repair/run', 'POST', body)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(commands).toEqual([]); expect(submitted).toEqual([])
  })

  it('refuses non-JSON bodies and preview acceptance fields', async () => {
    const { ctx } = context()
    await expect(call(ctx, '/host/repair/preview', 'POST', 'repairId=apt-fix-broken', 'application/x-www-form-urlencoded')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(ctx, '/host/repair/preview', 'POST', '{bad', 'application/json')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(ctx, '/host/repair/preview', 'POST', { repairId: 'apt-fix-broken', expectedRevision: 'a'.repeat(64), acceptRemovals: true, expectedRemovals: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('returns 409 for a stale revision and 412 when the targeted diagnostic is not a repairable problem', async () => {
    const { ctx } = context()
    await expect(call(ctx, '/host/repair/preview', 'POST', { repairId: 'apt-fix-broken', expectedRevision: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT', status: 409 })
    const revision = await revisionOf(ctx)
    await expect(call(ctx, '/host/repair/preview', 'POST', { repairId: 'dpkg-configure', expectedRevision: revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', status: 412, detail: { reason: 'no_problem' } })
    const rhel = context({ family: 'rhel' })
    await expect(call(rhel.ctx, '/host/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: await revisionOf(rhel.ctx) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'rhel_repair_not_reviewed' } })
  })

  it('previews the simulation with removals flagged', async () => {
    const { ctx } = context()
    const response = await call(ctx, '/host/repair/preview', 'POST', { repairId: 'apt-fix-broken', expectedRevision: await revisionOf(ctx) })
    expect(response!.status).toBe(200)
    expect(await response!.json()).toMatchObject({ preview: { state: 'ready', remove: ['php8.3-fpm'], counts: { install: 1, remove: 1, configure: 1 }, removalFingerprint: removalFingerprint(['php8.3-fpm']) } })
  })

  it('starts a removal repair only with the exact accepted removal list', async () => {
    const { ctx, submitted } = context()
    const revision = await revisionOf(ctx)
    await expect(call(ctx, '/host/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'removals_require_acceptance', removals: ['php8.3-fpm'] } })
    await expect(call(ctx, '/host/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision, acceptRemovals: true, expectedRemovals: removalFingerprint(['other']) })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(submitted).toEqual([])
    const response = await call(ctx, '/host/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision, acceptRemovals: true, expectedRemovals: removalFingerprint(['php8.3-fpm']) })
    expect(response!.status).toBe(202)
    expect(await response!.json()).toMatchObject({ revision, job: { id: 'job-1', kind: 'system.repair.apt-fix-broken', status: 'queued' } })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]!.actor).toBe('root')
    expect(submitted[0]!.plan.steps[0]!.argv).toEqual([...APT_FIX_BROKEN_ARGV])
    expect(submitted[0]!.plan.fingerprint).toMatchObject({ observedRevision: revision, removalsAccepted: true })
  })

  it('keeps apt from removing anything when the preview has no removals', async () => {
    const { ctx, submitted } = context({}, { [key(APT_FIX_PREVIEW_ARGV)]: simulateClean })
    const response = await call(ctx, '/host/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: await revisionOf(ctx) })
    expect(response!.status).toBe(202)
    expect(submitted[0]!.plan.steps[0]!.argv).toEqual([...APT_FIX_BROKEN_NO_REMOVE_ARGV])
  })

  it('re-checks root immediately before submitting and never submits after authority changes', async () => {
    let calls = 0
    const { ctx, submitted } = context({ assertRoot: async () => ({ actor: ++calls > 3 ? 'other-root' : 'root' }) }, { [key(APT_FIX_PREVIEW_ARGV)]: simulateClean })
    const revision = await revisionOf(ctx)
    await expect(call(ctx, '/host/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: revision })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(submitted).toEqual([])
  })

  it('reports a missing runner and an unknown submission outcome truthfully', async () => {
    const missing = context({ submitJob: null }, { [key(APT_FIX_PREVIEW_ARGV)]: simulateClean })
    await expect(call(missing.ctx, '/host/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: await revisionOf(missing.ctx) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    const broken = context({ submitJob: async () => { throw new Error('socket closed') } }, { [key(APT_FIX_PREVIEW_ARGV)]: simulateClean })
    await expect(call(broken.ctx, '/host/repair/run', 'POST', { repairId: 'apt-fix-broken', expectedRevision: await revisionOf(broken.ctx) })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
  })

  it('surfaces an unreadable config-test list instead of silently omitting service checks', async () => {
    const { ctx } = context({ configTests: async () => { throw new Error('manifest unreadable') } })
    await expect(call(ctx, '/host/repair/diagnostics')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})

describe('RHEL metadata repair route', () => {
  const missingTable = { [key(DNF_CACHE_CHECK_ARGV)]: out('', 1, "Error: Cache-only enabled but no cache for 'baseos'\n") }
  const cacheRecovery = { begin: vi.fn(async (input: { expectedRevision: string; currentRevision(): Promise<string> }) => ({ observedRevision: await input.currentRevision(), snapshotRevision: 'b'.repeat(64), assertLeaseAndPackagesUnchanged: async () => {}, restoreAndVerify: async () => true, release: async () => {} })) }
  it('keeps metadata refresh disabled without qualified recovery and durable job readback', async () => {
    const t = context({ family: 'rhel' }, missingTable), revision = await revisionOf(t.ctx)
    await expect(call(t.ctx, '/host/repair/run', 'POST', { repairId: 'dnf-cache-refresh', expectedRevision: revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'cache_recovery_unavailable', stateChanged: false } })
    expect(t.submitted).toEqual([])
  })
  it('submits only the metadata plan and binds the acknowledgement to durable job readback', async () => {
    const t = context({ family: 'rhel', cacheRecovery, readJob: async id => t.submitted[0] ? { ...job(t.submitted[0].plan, 'root'), id } : null }, missingTable)
    const revision = await revisionOf(t.ctx)
    const preview = await call(t.ctx, '/host/repair/preview', 'POST', { repairId: 'dnf-cache-refresh', expectedRevision: revision })
    expect(await preview!.json()).toMatchObject({ preview: { state: 'ready', source: 'dnf-cache-only', install: [], remove: [], configure: [] } })
    const response = await call(t.ctx, '/host/repair/run', 'POST', { repairId: 'dnf-cache-refresh', expectedRevision: revision })
    expect(response?.status).toBe(202); expect(await response!.json()).toMatchObject({ job: { kind: 'system.repair.dnf-cache-refresh', actor: 'root' } })
    expect(t.submitted).toHaveLength(1)
    expect(t.submitted[0]!.plan.steps.every(step => !step.argv.includes('--rebuilddb') && !step.argv.includes('install'))).toBe(true)
    await t.submitted[0]!.plan.beforeStep!(t.submitted[0]!.plan.steps[0]!)
    expect(cacheRecovery.begin).toHaveBeenCalled()
  })
  it('refuses stale diagnostics, lost root authority and an invalid job readback without retry', async () => {
    let authorized = true
    const t = context({ family: 'rhel', cacheRecovery, readJob: async () => null, assertRoot: async () => { if (!authorized) throw new Error('root revoked'); return { actor: 'root' } } }, missingTable)
    await expect(call(t.ctx, '/host/repair/run', 'POST', { repairId: 'dnf-cache-refresh', expectedRevision: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    const revision = await revisionOf(t.ctx)
    await expect(call(t.ctx, '/host/repair/run', 'POST', { repairId: 'dnf-cache-refresh', expectedRevision: revision })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
    expect(t.submitted).toHaveLength(1); authorized = false
    await expect(t.submitted[0]!.plan.beforeStep!(t.submitted[0]!.plan.steps[0]!)).rejects.toThrow('root revoked')
  })
})

describe('RHEL RPM database rebuild route', () => {
  const identity = ['/usr/bin/rpm', '-qa', '--qf', '%{NEVRA}' + String.fromCharCode(92) + 'n'].join(' ')
  const corruptTable = { [key(RPMDB_VERIFY_ARGV)]: out('', 1, 'error: rpmdb: database disk image is malformed'), [identity]: out('bash-5.1.8-9.el9.x86_64\n') }
  const rpmRecovery = { begin: vi.fn(async (input: { expectedRevision: string; currentRevision(): Promise<string> }) => ({ observedRevision: await input.currentRevision(), snapshotRevision: 'b'.repeat(64), assertLeaseAndPackagesUnchanged: async () => {}, restoreAndVerify: async () => true, release: async () => {} })) }
  it('keeps the rebuild unavailable without a recovery provider and refuses it on Debian hosts', async () => {
    const t = context({ family: 'rhel' }, corruptTable), revision = await revisionOf(t.ctx)
    await expect(call(t.ctx, '/host/repair/run', 'POST', { repairId: 'rpmdb-rebuild', expectedRevision: revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'rpm_recovery_unavailable', stateChanged: false } })
    const debian = context({ rpmRecovery, readJob: async () => null })
    await expect(call(debian.ctx, '/host/repair/run', 'POST', { repairId: 'rpmdb-rebuild', expectedRevision: await revisionOf(debian.ctx) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'repair_unavailable_for_family' } })
    expect([...t.submitted, ...debian.submitted]).toEqual([])
  })
  it('submits the snapshot-bound rebuild with job readback when recovery is qualified', async () => {
    const t = context({ family: 'rhel', rpmRecovery, readJob: async id => t.submitted[0] ? { ...job(t.submitted[0].plan, 'root'), id } : null }, corruptTable)
    const revision = await revisionOf(t.ctx)
    expect(await (await call(t.ctx, '/host/repair/preview', 'POST', { repairId: 'rpmdb-rebuild', expectedRevision: revision }))!.json()).toMatchObject({ preview: { state: 'ready', source: 'rpm-database' } })
    const response = await call(t.ctx, '/host/repair/run', 'POST', { repairId: 'rpmdb-rebuild', expectedRevision: revision })
    expect(response?.status).toBe(202); expect(await response!.json()).toMatchObject({ job: { kind: 'system.repair.rpmdb-rebuild' } })
    await t.submitted[0]!.plan.beforeStep!(t.submitted[0]!.plan.steps[0]!)
    expect(rpmRecovery.begin).toHaveBeenCalledTimes(1)
  })
})
