import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import { composerTargetFingerprint, handleComposerJobRoute, isComposerJobProviderQualified } from './composer-job.ts'
import type { ComposerJobServices } from './composer-job.ts'
import type { ComposerJobObservation, ComposerJobProvider, ComposerJobTarget } from './composer-job-provider.ts'
import type { ComposerWorkspaceContext } from './composer-workspace.ts'
import type { HostJobCommandResult, HostJobPlan, HostJobRun, HostJobStepRun, HostJobView } from './host-job-contract.ts'
import { validateHostJobPlan } from './host-jobs.ts'

const H = (value: string): string => createHash('sha256').update(value).digest('hex')
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', domainId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const account = { id: accountId, username: 'alpha', uid: 20001, gid: 20001, home: '/home/alpha', status: 'active', planId: 'plan' } as Account
const domain = { id: domainId, accountId, name: 'example.test', siteType: 'php', docRoot: '/home/alpha/public_html', suspended: false, php: { version: '8.3' } } as Domain
const plan = { id: 'plan', resources: { memoryMb: 128, cpuPercent: 25, maxProcesses: 12, diskMb: 100 } } as Plan
const manifest = JSON.stringify({ require: { 'vendor/package': '^1.0' }, scripts: { 'post-install-cmd': 'private-script-not-executed' } })
const lock = JSON.stringify({ packages: [{ name: 'vendor/package', version: '1.0.0' }], 'packages-dev': [] })
const success: HostJobCommandResult = { ok: true, code: 0, stdout: '', stderr: '', timedOut: false }
const normalRun: HostJobRun = async () => success
const finalRun: HostJobStepRun = async () => success
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function fixture() {
  let currentAccount = account, currentDomain = domain, currentPlan = plan, currentManifest: string | null = manifest, postimage = false, held = false, actor = 'root', recoveryConflict = false
  let submitted: HostJobPlan | null = null, lastTarget: Readonly<ComposerJobTarget> | null = null
  const observation = (target: Readonly<ComposerJobTarget>): ComposerJobObservation => ({ targetFingerprint: composerTargetFingerprint(target), treeDigest: H(postimage ? 'complete-postimage-tree' : 'complete-preimage-tree'), manifest: currentManifest, lock, installed: postimage ? JSON.stringify({ packages: [{ name: 'vendor/package', version: '1.0.0' }] }) : null, uid: target.uid, gid: target.gid, ownershipVerified: true, verifiedGraphDigest: postimage ? H('approved-artifact-graph') : null })
  const provider: ComposerJobProvider = {
    qualification: { protocol: 1, native: true, helperSha256: H('qualified-helper'), sourcePolicyRevision: H('approved-source-policy'), descriptorConfined: true, numericAccountIdentity: true, lifecycleFencing: true, isolatedStaging: true, offlineExecution: true, approvedArtifactDigests: true, resourceLimits: true, durableSnapshotRecovery: true, completeOwnershipReadback: true, sanitizedOutput: true },
    observe: vi.fn(async target => { lastTarget = target; return observation(target) }),
    resolve: vi.fn(async (_target, _action, beforeRevision) => ({ beforeRevision, graphDigest: H('approved-artifact-graph'), lockDigest: H(lock), sourcePolicyRevision: H('approved-source-policy'), packages: [{ name: 'vendor/package', version: '1.0.0', development: false }] })),
    prepare: vi.fn<ComposerJobProvider['prepare']>(async input => { expect(held).toBe(true); expect(input.target.uid).toBe(20001); expect(input.target.limits).toEqual({ memoryMb: 128, cpuPercent: 25, maxProcesses: 12, maxBytes: 100 * 1024 * 1024, maxFiles: 20000 }); expect(input.argv).toContain('--no-scripts'); expect(input.argv).toContain('--no-plugins'); return { transactionId: input.transactionId, targetFingerprint: composerTargetFingerprint(input.target), beforeRevision: input.beforeRevision, snapshotDigest: H('durable-complete-snapshot'), complete: true, durable: true, uid: input.target.uid, gid: input.target.gid } }),
    recover: vi.fn<ComposerJobProvider['recover']>(async (_id, target) => { expect(held).toBe(true); if (recoveryConflict) return { state: 'conflict', observation: null }; postimage = false; return { state: 'restored', observation: observation(target) } }),
    close: vi.fn(async () => { expect(held).toBe(true); return { released: true, snapshotRetained: true } }),
  }
  const ctx: Pick<ComposerWorkspaceContext, 'store' | 'assertRoot'> = {
    assertRoot: vi.fn(async () => ({ actor })),
    store: { listAccounts: vi.fn(async () => [currentAccount]), listDomains: vi.fn(async () => [currentDomain]), getPlan: vi.fn(async () => currentPlan), withAccountLifecycleLease: vi.fn(async (_id, operation) => { expect(held).toBe(false); held = true; try { return await operation(currentAccount) } finally { held = false } }) },
  }
  const services: ComposerJobServices = { provider, family: 'debian', audit: vi.fn(async () => {}), submitJob: vi.fn(async value => { validateHostJobPlan(value); submitted = value; return { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', accountId, kind: value.kind, referenceCode: 'JOB-2026-000001' } as HostJobView }) }
  return { ctx, provider, services, get held() { return held }, get submitted() { return submitted }, get target() { return lastTarget }, execute: () => { expect(held).toBe(true); postimage = true }, changeAccount: (value: Account) => { currentAccount = value }, changeDomain: (value: Domain) => { currentDomain = value }, changePlan: (value: Plan) => { currentPlan = value }, changeManifest: (value: string | null) => { currentManifest = value }, changeActor: () => { actor = 'another-root' }, conflictRecovery: () => { recoveryConflict = true } }
}
async function request(f: ReturnType<typeof fixture>, operation: 'preview' | 'apply', body: unknown, method = 'POST') {
  const url = new URL('http://local/host/composer/jobs/' + operation)
  return handleComposerJobRoute(new Request(url, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }), url, method, f.ctx, f.services)
}
async function preview(f: ReturnType<typeof fixture>, action = 'install') {
  const response = await request(f, 'preview', { action, domainId }); assert.ok(response)
  const value: unknown = await response.json(); assert.ok(object(value) && object(value.review)); assert.equal(value.review.state, 'ready')
  assert.ok(typeof value.review.expectedRevision === 'string' && /^[0-9a-f]{64}$/.test(value.review.expectedRevision)); assert.ok(typeof value.review.reviewFingerprint === 'string' && /^[0-9a-f]{64}$/.test(value.review.reviewFingerprint))
  expect(JSON.stringify(value)).not.toContain('private-script')
  return { action, domainId, expectedRevision: value.review.expectedRevision, reviewFingerprint: value.review.reviewFingerprint }
}
async function queued(f: ReturnType<typeof fixture>, action = 'install'): Promise<HostJobPlan> {
  const response = await request(f, 'apply', await preview(f, action)); expect(response!.status).toBe(202); assert.ok(f.submitted); return f.submitted
}
describe('consumed account Composer transaction plan', () => {
  it('keeps the default provider unavailable and never qualifies partial safety evidence', async () => {
    const f = fixture(); f.services.provider = null
    await expect(request(f, 'preview', { action: 'install', domainId })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(f.services.submitJob).not.toHaveBeenCalled(); expect(f.provider.observe).not.toHaveBeenCalled()
    const g = fixture(); Object.assign(g.provider.qualification, { durableSnapshotRecovery: false })
    expect(isComposerJobProviderQualified(g.provider)).toBe(false); await expect(preview(g)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it.each(['path', 'url', 'env', 'phpBinary', 'scripts', 'mirror'])('refuses caller-selected %s before provider access', async key => {
    const f = fixture(); await expect(request(f, 'preview', { action: 'install', domainId, [key]: '/root/private' })).rejects.toMatchObject({ code: 'VALIDATION' }); expect(f.provider.observe).not.toHaveBeenCalled()
  })
  it('bounds request bodies before protected provider observations and only serves POST', async () => {
    const f = fixture(); await expect(request(f, 'preview', { action: 'install', domainId, padding: 'x'.repeat(3000) })).rejects.toMatchObject({ code: 'VALIDATION' }); expect(f.provider.observe).not.toHaveBeenCalled()
    expect((await request(f, 'preview', {}, 'GET'))!.status).toBe(405)
  })
  it('previews without snapshot writes and binds the saved target, version and plan limits', async () => {
    const f = fixture(); const review = await preview(f)
    expect(review.action).toBe('install'); expect(f.target).toMatchObject({ accountId, domainId, username: 'alpha', uid: 20001, gid: 20001, directory: '/home/alpha/public_html', phpVersion: '8.3' }); expect(f.provider.prepare).not.toHaveBeenCalled(); expect(f.held).toBe(false)
  })
  it('pins the account lease from complete snapshot through verified readback and retained recovery copy', async () => {
    const f = fixture(), job = await queued(f), step = job.steps[0]!
    expect(job.accountId).toBe(accountId); expect(job.policy(step.argv)).toBe(true); expect(job.policy([...step.argv, '--root'])).toBe(false)
    await job.beforeStep!(step); expect(f.held).toBe(true); expect(f.provider.prepare).toHaveBeenCalledOnce()
    f.execute(); expect((await job.verify!(normalRun)).ok).toBe(true)
    const final = await job.finalize!(finalRun, [{ id: step.id, result: success }]); expect(final).toMatchObject({ ok: true, detail: { installedFilesVerified: true, snapshotRetained: true } }); expect(f.held).toBe(false); expect(f.provider.recover).not.toHaveBeenCalled()
  })
  it('implements the same pinned plan for update without free package names or flags', async () => {
    const f = fixture(), job = await queued(f, 'update'); expect(job.kind).toBe('composer.dependencies.update')
    await job.beforeStep!(job.steps[0]!); const prepare = vi.mocked(f.provider.prepare).mock.calls[0]![0]; expect(prepare.action).toBe('update'); expect(prepare.argv[3]).toBe('update')
    await job.finalize!(finalRun, []); expect(f.held).toBe(false)
  })
  it('returns COMPOSER_JSON_MISSING and refuses unsafe project configuration', async () => {
    const f = fixture(); f.changeManifest(null); await expect(preview(f)).rejects.toMatchObject({ code: 'VALIDATION', message: 'COMPOSER_JSON_MISSING' }); expect(f.provider.resolve).not.toHaveBeenCalled()
    const g = fixture(); g.changeManifest(JSON.stringify({ require: {}, repositories: [{ url: 'http://127.0.0.1/private' }] })); await expect(preview(g)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' }); expect(g.provider.resolve).not.toHaveBeenCalled()
    const h = fixture(); h.changeManifest(JSON.stringify({ config: { 'vendor-dir': '/root/private' } })); await expect(preview(h)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('refuses a stale review before submission and a changed target before preparing the queued job', async () => {
    const f = fixture(), review = await preview(f); f.changePlan({ ...plan, resources: { ...plan.resources, memoryMb: 64 } }); await expect(request(f, 'apply', review)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(f.services.submitJob).not.toHaveBeenCalled()
    const g = fixture(), job = await queued(g); g.changeDomain({ ...domain, docRoot: '/home/alpha/other' }); await expect(job.beforeStep!(job.steps[0]!)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(g.provider.prepare).not.toHaveBeenCalled(); await job.finalize!(finalRun, []); expect(g.held).toBe(false)
  })
  it('refuses root/account identity changes and cannot wait forever if acquiring the lifecycle lease fails', async () => {
    const f = fixture(), job = await queued(f); f.changeActor(); await expect(job.beforeStep!(job.steps[0]!)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(f.provider.prepare).not.toHaveBeenCalled(); await job.finalize!(finalRun, [])
    const g = fixture(), other = await queued(g); g.ctx.store.withAccountLifecycleLease = async () => { throw new Error('lease-unavailable') }; await expect(other.beforeStep!(other.steps[0]!)).rejects.toThrow('lease-unavailable'); expect((await other.finalize!(finalRun, [])).ok).toBe(true)
  })
  it('restores and re-reads the complete preimage after an unsuccessful execution', async () => {
    const f = fixture(), job = await queued(f), step = job.steps[0]!; await job.beforeStep!(step); f.execute()
    const result = await job.finalize!(finalRun, [{ id: step.id, result: { ...success, ok: false, code: 2 } }]); expect(result).toMatchObject({ ok: true, detail: { restored: true, snapshotRetained: true } }); expect(f.provider.recover).toHaveBeenCalledOnce(); expect(f.held).toBe(false)
  })
  it('never treats package metadata alone as verified installed files, and preserves unknown recovery outcomes', async () => {
    const f = fixture(), job = await queued(f), step = job.steps[0]!; await job.beforeStep!(step); f.execute()
    const original = f.provider.observe; f.provider.observe = async target => ({ ...await original(target), verifiedGraphDigest: null })
    expect((await job.verify!(normalRun)).ok).toBe(false); f.conflictRecovery(); expect(await job.finalize!(finalRun, [{ id: step.id, result: success }])).toMatchObject({ ok: false, detail: { unknownOutcome: true, verificationRequired: true } }); expect(f.provider.close).not.toHaveBeenCalled(); expect(f.held).toBe(false)
  })
  it('recovers safely after malformed snapshot evidence and before-step cancellation', async () => {
    const f = fixture(), job = await queued(f); const original = f.provider.prepare; f.provider.prepare = async input => ({ ...await original(input), complete: false } as never)
    await expect(job.beforeStep!(job.steps[0]!)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' }); expect(f.held).toBe(true); expect((await job.finalize!(finalRun, [])).ok).toBe(true); expect(f.held).toBe(false)
  })
  it('does not downgrade a lost submission acknowledgement to an unchanged failure', async () => {
    const f = fixture(), review = await preview(f); f.services.submitJob = async () => { throw new Error('private-provider-error') }
    await expect(request(f, 'apply', review)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
  })
  it('invalidates the review and queued execution when the qualified helper digest changes', async () => {
    const f = fixture(), review = await preview(f); f.provider.qualification.helperSha256 = H('replacement-helper')
    await expect(request(f, 'apply', review)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(f.services.submitJob).not.toHaveBeenCalled()
    const g = fixture(), job = await queued(g); g.provider.qualification.helperSha256 = H('replacement-helper')
    await expect(job.beforeStep!(job.steps[0]!)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' }); expect(g.provider.prepare).not.toHaveBeenCalled(); expect((await job.finalize!(finalRun, [])).ok).toBe(true); expect(g.held).toBe(false)
  })
})
