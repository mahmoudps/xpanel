import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { handleConfigurationHealthRoute, parseConfigurationHealthIntent, readConfigurationHealth } from './configuration-health.ts'
import type { ConfigurationHealthContext, ConfigurationHealthGeneration, ConfigurationHealthRepairProvider } from './configuration-health.ts'
import type { DriftReport, GenerationManifest } from './reconciler-journal.ts'

const checksum = 'a'.repeat(64), state = 'b'.repeat(64), expected = 'c'.repeat(64), observed = 'd'.repeat(64)
const path = '/etc/nginx/nginx.conf', test = { name: 'nginx', argv: ['/usr/sbin/nginx', '-t', '-q', '-c', path] }
const item = () => ({ path, reason: 'content_mismatch' as const, expectedSha256: expected, observedSha256: observed, expectedMeta: { mode: 420, owner: 'root', group: 'root' } })
const manifest = (): GenerationManifest => ({ schemaVersion: 1, generationId: 7, filesChecksum: checksum, stateChecksum: state, createdAt: '2026-10-27T00:00:00.000Z', actor: 'root', files: [{ path, sha256: expected, mode: 420, owner: 'root', group: 'root', sizeBytes: 12, logicalOwner: 'server', service: 'nginx', dependentUnits: ['nginx.service'] }], managedUnits: ['nginx.service'], testResults: [{ ...test, ok: true, code: 0, testedConfigChecksum: checksum, at: '2026-10-27T00:00:00.000Z' }] })
const generation = (): ConfigurationHealthGeneration => ({ id: 7, checksum, manifest: manifest() })
const report = (): DriftReport => ({ hasDrift: true, manifestMissing: false, generationId: 7, items: [item()] })
const context = (overrides: Partial<ConfigurationHealthContext> = {}): ConfigurationHealthContext => ({ assertRoot: vi.fn(async () => ({ actor: 'root' })), readGeneration: async () => generation(), readDesired: async () => ({ revision: 2, checksum: state }), readDrift: async () => report(), reviewedTests: [test], runTest: vi.fn(async () => ({ ok: true, code: 0, stdout: 'secret configuration output', stderr: '' })), repair: null, audit: vi.fn(async () => {}), now: () => new Date('2026-10-27T01:00:00.000Z'), ...overrides })
const call = (ctx: ConfigurationHealthContext, body?: unknown, pathname = body === undefined ? '/host/configuration-health' : '/host/configuration-health/repair', method = body === undefined ? 'GET' : 'POST') => { const request = new Request('http://local' + pathname, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); return handleConfigurationHealthRoute(request, new URL(request.url), method, ctx) }
const repairContext = () => {
  let repaired = false
  const events: string[] = []
  const provider: ConfigurationHealthRepairProvider = { withLease: async work => { events.push('lease'); return work(async () => { events.push('held') }) }, repairTarget: vi.fn(async input => { await input.assertHeld(); await input.authorize(); events.push('repair'); repaired = true; return { recoveryVerified: true } }) }
  const ctx = context({ repair: provider, readDrift: async () => repaired ? { ...report(), hasDrift: false, items: [] } : report(), assertRoot: async () => { events.push('auth'); return { actor: 'root' } }, audit: async entry => { events.push(entry.action) } })
  return { ctx, provider, events }
}
const intent = async (ctx: ConfigurationHealthContext) => { const view = await readConfigurationHealth(ctx); return { target: view.targets[0]!.token, expectedRevision: view.revision, expectedGenerationId: 7, expectedGenerationChecksum: checksum, confirmation: 'REPAIR CONFIGURATION' } }

describe('configuration health canonical observations', () => {
  it('uses the existing drift reader and current reviewed tests without projecting commands or secret output', async () => {
    const ctx = context(), view = await readConfigurationHealth(ctx)
    expect(view).toMatchObject({ state: 'read', drift: 'drift', manifest: 'linked', managedFiles: 1, canRepair: false, repairReason: 'provider_unavailable', tests: [{ name: 'nginx', state: 'passed', exitCode: 0 }] })
    expect(view.targets[0]).toMatchObject({ path, expectedChecksum: expected, observedChecksum: observed }); expect(view.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(ctx.runTest).toHaveBeenCalledWith(test); expect(JSON.stringify(view)).not.toMatch(/secret configuration output|argv|actor/)
  })
  it('does not interpret missing host observation or generation as healthy', async () => {
    for (const overrides of [{ readDrift: null }, { readGeneration: async () => null }, { readDesired: null }, { readGeneration: async () => ({ ...generation(), manifest: null }) }]) expect(await readConfigurationHealth(context(overrides))).toMatchObject({ state: 'unavailable', canRepair: false, revision: null })
  })
  it.each([
    { ...report(), generationId: 9 }, { ...report(), hasDrift: false }, { ...report(), items: [item(), item()] },
    { ...report(), items: [{ ...item(), path: '/etc/unmanaged.conf' }] }, { ...report(), items: [{ ...item(), expectedSha256: observed }] },
    { ...report(), items: [{ ...item(), reason: 'missing', observedSha256: observed }] },
  ])('refuses contradictory or foreign drift %j', async value => expect(await readConfigurationHealth(context({ readDrift: async () => value as DriftReport }))).toMatchObject({ state: 'unavailable', canRepair: false }))
  it('refuses a generation change while current tests await', async () => {
    let reads = 0
    const ctx = context({ readGeneration: async () => ({ ...generation(), id: ++reads === 1 ? 7 : 8 }) })
    expect(await readConfigurationHealth(ctx)).toMatchObject({ state: 'unavailable', revision: null })
  })
  it('blocks repair of unrelated pending saved changes', async () => {
    const { ctx, provider } = repairContext(); ctx.readDesired = async () => ({ revision: 3, checksum: observed })
    expect(await readConfigurationHealth(ctx)).toMatchObject({ state: 'read', pending: true, canRepair: false, repairReason: 'pending_changes' }); expect(provider.repairTarget).not.toHaveBeenCalled()
  })
  it('does not execute historical or unreviewed manifest argv', async () => {
    const ctx = context({ reviewedTests: [{ name: 'nginx', argv: ['malicious', '-t'] }] })
    expect((await readConfigurationHealth(ctx)).tests).toEqual([{ name: 'nginx', state: 'unavailable', exitCode: null }]); expect(ctx.runTest).not.toHaveBeenCalled()
  })
  it('keeps failed and unavailable configuration tests distinct', async () => {
    const failed = context({ runTest: async () => ({ ok: false, code: 1, stdout: '', stderr: 'configuration error' }) })
    expect((await readConfigurationHealth(failed)).tests[0]).toEqual({ name: 'nginx', state: 'failed', exitCode: 1 })
    const { ctx } = repairContext(); ctx.runTest = async () => ({ ok: false, code: null, stdout: '', stderr: 'spawn missing' })
    expect(await readConfigurationHealth(ctx)).toMatchObject({ canRepair: false, repairReason: 'observation_unavailable', tests: [{ state: 'unavailable', exitCode: null }] })
  })
  it('binds metadata drift observations into exact target revisions', async () => {
    const ctx = context({ readDrift: async () => ({ ...report(), items: [{ ...item(), reason: 'metadata_mismatch', observedSha256: expected, observedMeta: { mode: 384, owner: 'root', group: 'root' } }] }) }), before = await readConfigurationHealth(ctx)
    ctx.readDrift = async () => ({ ...report(), items: [{ ...item(), reason: 'metadata_mismatch', observedSha256: expected, observedMeta: { mode: 511, owner: 'root', group: 'root' } }] })
    expect((await readConfigurationHealth(ctx)).revision).not.toBe(before.revision)
  })
})

describe('configuration health guarded target repair', () => {
  it('rejects unknown body fields, caller-selected paths, query and wrong methods', async () => {
    const { ctx } = repairContext(), body = await intent(ctx)
    expect(() => parseConfigurationHealthIntent({ ...body, path })).toThrow(); expect(() => parseConfigurationHealthIntent({ ...body, target: path })).toThrow()
    await expect(call(ctx, undefined, '/host/configuration-health?path=x')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call(ctx, undefined, '/host/configuration-health', 'DELETE'))!.status).toBe(405); expect(await call(ctx, undefined, '/other')).toBeNull()
  })
  it('requires the qualified targeted repair provider', async () => {
    const ctx = context(); await expect(call(ctx, await intent(ctx))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('reauthorizes after observations and rejects revoked reads', async () => {
    let reads = 0
    await expect(call(context({ assertRoot: async () => ({ actor: reads++ ? 'other' : 'root' }) }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('repairs only the exact reviewed target under lease and verifies recovery, remaining drift and tests', async () => {
    const { ctx, provider, events } = repairContext(), body = await intent(ctx), response = await call(ctx, body)
    expect(await response!.json()).toMatchObject({ outcome: 'verified', target: body.target, recoveryVerified: true, verificationRequired: false, view: { drift: 'clean' } })
    expect(provider.repairTarget).toHaveBeenCalledWith(expect.objectContaining({ generation: { id: 7, checksum }, desired: { revision: 2, checksum: state }, target: expect.objectContaining({ path }) }))
    expect(events.indexOf('lease')).toBeLessThan(events.indexOf('repair')); expect(events.indexOf('configuration.health.repair.requested')).toBeLessThan(events.indexOf('repair')); expect(events.at(-1)).toBe('configuration.health.repair.verified')
  })
  it('refuses stale generation/checksum/revision before effects', async () => {
    for (const change of [{ expectedGenerationId: 8 }, { expectedGenerationChecksum: observed }, { expectedRevision: observed }]) { const { ctx, provider } = repairContext(); await expect(call(ctx, { ...await intent(ctx), ...change })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } }); expect(provider.repairTarget).not.toHaveBeenCalled() }
  })
  it('stops a revoked authority after awaited audit before the effect', async () => {
    const { ctx, provider } = repairContext(); let revoked = false
    ctx.assertRoot = async () => { if (revoked) return fail('FORBIDDEN', 'revoked', { stateChanged: false }); return { actor: 'root' } }; ctx.audit = async () => { revoked = true }
    await expect(call(ctx, await intent(ctx))).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(provider.repairTarget).not.toHaveBeenCalled()
  })
  it('preserves known provider refusals and locks unknown effects or unverified recovery', async () => {
    const refused = repairContext(); refused.provider.repairTarget = async () => fail('CONFLICT', 'stale', { stateChanged: false })
    await expect(call(refused.ctx, await intent(refused.ctx))).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    for (const repairTarget of [async () => { throw new Error('lost') }, async () => ({ recoveryVerified: false })]) { const { ctx, provider } = repairContext(); provider.repairTarget = repairTarget; await expect(call(ctx, await intent(ctx))).rejects.toMatchObject({ detail: { unknownOutcome: true, verificationRequired: true } }) }
  })
  it('never claims success if the target still drifts after the provider returns', async () => {
    const { ctx, provider } = repairContext(); provider.repairTarget = async () => ({ recoveryVerified: true })
    await expect(call(ctx, await intent(ctx))).rejects.toMatchObject({ detail: { unknownOutcome: true, verificationRequired: true } })
  })
})
