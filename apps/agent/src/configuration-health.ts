import { createHash } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { ConfigTest } from '@xpanel/core'
import type { DriftReport, GenerationManifest } from './reconciler-journal.ts'

export interface ConfigurationHealthGeneration { id: number; checksum: string; manifest: GenerationManifest | null }
export interface ConfigurationHealthAuthority { revision: number; checksum: string }
export interface ConfigurationHealthTarget { token: string; path: string; reason: 'missing' | 'content_mismatch' | 'metadata_mismatch'; expectedChecksum: string; observedChecksum: string | null }
export interface ConfigurationHealthTest { name: string; state: 'passed' | 'failed' | 'unavailable'; exitCode: number | null }
export interface ConfigurationHealthView {
  state: 'read' | 'unavailable'; observedAt: string; revision: string | null
  generation: { id: number; checksum: string } | null; desired: ConfigurationHealthAuthority | null
  drift: 'clean' | 'drift' | 'unavailable'; manifest: 'linked' | 'missing' | 'unavailable'; pending: boolean | null
  managedFiles: number | null; targets: ConfigurationHealthTarget[]; tests: ConfigurationHealthTest[]
  canRepair: boolean; repairReason: 'ready' | 'provider_unavailable' | 'no_drift' | 'observation_unavailable' | 'pending_changes'
}
/** A trusted adapter must use the reconciler's existing generation/lifecycle exclusion and durable journal.
 * It repairs only the supplied owned target, preserves a recoverable preimage before any effect,
 * rechecks authorize/assertHeld immediately before every effect, and returns only after journal recovery/readback.
 * A bare reconcile(force) is deliberately not this adapter: it can apply unrelated pending changes.
 */
export interface ConfigurationHealthRepairProvider {
  withLease: <T>(work: (assertHeld: () => Promise<void>) => Promise<T>) => Promise<T>
  repairTarget: (input: { generation: { id: number; checksum: string }; desired: ConfigurationHealthAuthority; target: ConfigurationHealthTarget; authorize: () => Promise<void>; assertHeld: () => Promise<void> }) => Promise<{ recoveryVerified: boolean }>
}
export interface ConfigurationHealthContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  readGeneration: (() => Promise<ConfigurationHealthGeneration | null>) | null
  readDesired: (() => Promise<ConfigurationHealthAuthority>) | null
  readDrift: (() => Promise<DriftReport>) | null
  /** Renderer-produced server-wide configuration tests from the trusted OS profile, never HTTP or manifest argv. */
  reviewedTests: readonly ConfigTest[]
  runTest: ((test: ConfigTest) => Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string; timedOut?: boolean }>) | null
  repair: ConfigurationHealthRepairProvider | null
  audit: (entry: { actor: string; action: string; target: string; outcome: 'ok' | 'error'; detail: Record<string, unknown> }) => Promise<unknown>
  now?: () => Date
}
export const configurationHealthHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const safePath = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024 && value.startsWith('/') && !value.includes('//') && !value.split('/').some(part => part === '.' || part === '..') && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const unavailable = (observedAt: string): ConfigurationHealthView => ({ state: 'unavailable', observedAt, revision: null, generation: null, desired: null, drift: 'unavailable', manifest: 'unavailable', pending: null, managedFiles: null, targets: [], tests: [], canRepair: false, repairReason: 'observation_unavailable' })

/** Reads only the reconciler's current owned manifest/drift reader; no parallel file scan or service inventory. */
export async function readConfigurationHealth(ctx: ConfigurationHealthContext): Promise<ConfigurationHealthView> {
  const observedAt = (ctx.now?.() ?? new Date()).toISOString()
  if (!ctx.readGeneration || !ctx.readDesired || !ctx.readDrift) return unavailable(observedAt)
  try {
    const before = await ctx.readGeneration(), desired = await ctx.readDesired(), drift = await ctx.readDrift()
    if (!before || !integer(before.id, 1) || !configurationHealthHash(before.checksum) || !integer(desired.revision) || !configurationHealthHash(desired.checksum)) return unavailable(observedAt)
    const manifest = before.manifest
    if (!manifest || drift.manifestMissing) return { ...unavailable(observedAt), generation: { id: before.id, checksum: before.checksum }, desired, manifest: 'missing' }
    if (manifest.generationId !== before.id || manifest.filesChecksum !== before.checksum || !configurationHealthHash(manifest.stateChecksum) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10000 || !Array.isArray(manifest.testResults) || manifest.testResults.length > 256
      || drift.generationId !== before.id || typeof drift.hasDrift !== 'boolean' || drift.manifestMissing !== false || !Array.isArray(drift.items) || drift.items.length > 10000 || drift.hasDrift !== (drift.items.length > 0)) return unavailable(observedAt)
    const files = new Map<string, string>()
    for (const file of manifest.files) {
      if (!safePath(file.path) || !configurationHealthHash(file.sha256) || files.has(file.path)) return unavailable(observedAt)
      files.set(file.path, file.sha256)
    }
    const seen = new Set<string>(), targets: ConfigurationHealthTarget[] = drift.items.map(item => {
      if (!safePath(item.path) || seen.has(item.path) || files.get(item.path) !== item.expectedSha256 || !['missing', 'content_mismatch', 'metadata_mismatch'].includes(item.reason) || item.observedSha256 !== null && !configurationHealthHash(item.observedSha256)
        || item.reason === 'missing' && item.observedSha256 !== null || item.reason !== 'missing' && item.observedSha256 === null || item.reason === 'content_mismatch' && item.observedSha256 === item.expectedSha256 || item.reason === 'metadata_mismatch' && item.observedSha256 !== item.expectedSha256) throw new Error('invalid_drift')
      seen.add(item.path)
      const target = { path: item.path, reason: item.reason, expectedChecksum: item.expectedSha256, observedChecksum: item.observedSha256 }
      return { token: digest({ ...target, expectedMeta: item.expectedMeta, observedMeta: item.observedMeta ?? null }), ...target }
    }).sort((a, b) => a.path.localeCompare(b.path, 'en'))
    const tests: ConfigurationHealthTest[] = [], testNames = new Set<string>()
    for (const recorded of manifest.testResults) {
      if (typeof recorded.name !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(recorded.name)) continue
      if (testNames.has(recorded.name)) return unavailable(observedAt)
      testNames.add(recorded.name)
      const reviewed = ctx.reviewedTests.find(test => test.name === recorded.name && same(test.argv, recorded.argv))
      let row: ConfigurationHealthTest = { name: recorded.name, state: 'unavailable', exitCode: null }
      if (reviewed && ctx.runTest) try {
        const result = await ctx.runTest({ name: reviewed.name, argv: [...reviewed.argv] })
        if (typeof result.ok === 'boolean' && integer(result.code) && result.code <= 255 && typeof result.stdout === 'string' && typeof result.stderr === 'string' && Buffer.byteLength(result.stdout) <= 1024 * 1024 && Buffer.byteLength(result.stderr) <= 1024 * 1024 && !result.timedOut && result.ok === (result.code === 0)) row = { name: recorded.name, state: result.ok ? 'passed' : 'failed', exitCode: result.code }
      } catch { /* The test stays explicitly unverified; command output may contain secrets and is never projected. */ }
      tests.push(row)
    }
    const after = await ctx.readGeneration(), desiredAfter = await ctx.readDesired()
    if (!after || after.id !== before.id || after.checksum !== before.checksum || !same(after.manifest, manifest) || !same(desiredAfter, desired)) return unavailable(observedAt)
    const pending = manifest.stateChecksum !== desired.checksum
    const repairReason = pending ? 'pending_changes' : !targets.length ? 'no_drift' : !ctx.repair ? 'provider_unavailable' : tests.length === 0 || tests.some(test => test.state === 'unavailable') ? 'observation_unavailable' : 'ready'
    const view: ConfigurationHealthView = { state: 'read', observedAt, revision: null, generation: { id: before.id, checksum: before.checksum }, desired, drift: targets.length ? 'drift' : 'clean', manifest: 'linked', pending, managedFiles: files.size, targets, tests, canRepair: repairReason === 'ready', repairReason }
    view.revision = digest({ generation: view.generation, desired, targets, tests, manifest: view.manifest, pending, managedFiles: view.managedFiles })
    return view
  } catch { return unavailable(observedAt) }
}

export interface ConfigurationHealthIntent { target: string; expectedRevision: string; expectedGenerationId: number; expectedGenerationChecksum: string; confirmation: 'REPAIR CONFIGURATION' }
export function parseConfigurationHealthIntent(value: unknown): ConfigurationHealthIntent {
  const keys = ['target', 'expectedRevision', 'expectedGenerationId', 'expectedGenerationChecksum', 'confirmation']
  if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) || !configurationHealthHash(value.target) || !configurationHealthHash(value.expectedRevision) || !integer(value.expectedGenerationId, 1) || !configurationHealthHash(value.expectedGenerationChecksum) || value.confirmation !== 'REPAIR CONFIGURATION') return fail('VALIDATION', 'an exact observed configuration target and confirmation are required', { stateChanged: false })
  return { target: value.target, expectedRevision: value.expectedRevision, expectedGenerationId: value.expectedGenerationId, expectedGenerationChecksum: value.expectedGenerationChecksum, confirmation: 'REPAIR CONFIGURATION' }
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
export async function handleConfigurationHealthRoute(req: Request, url: URL, method: string, ctx: ConfigurationHealthContext): Promise<Response | null> {
  const mutation = url.pathname === '/host/configuration-health/repair'
  if (!mutation && url.pathname !== '/host/configuration-health') return null
  const action = 'host.configuration-health.' + (mutation ? 'repair' : 'read'), initial = await ctx.assertRoot(action)
  const fresh = async () => { const current = await ctx.assertRoot(action); if (current.actor !== initial.actor) return fail('FORBIDDEN', 'configuration authority changed', { stateChanged: false }) }
  if (method !== (mutation ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: mutation ? 'POST' : 'GET' } })
  if (url.search) return fail('VALIDATION', 'configuration health does not accept selectors', { stateChanged: false })
  if (!mutation) { const view = await readConfigurationHealth(ctx); await fresh(); return json(view) }
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await req.text()
  if (text.length > 2048) return fail('VALIDATION', 'configuration repair request is too large', { stateChanged: false })
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'valid JSON is required', { stateChanged: false }) }
  const intent = parseConfigurationHealthIntent(body), provider = ctx.repair
  if (!provider) return fail('PRECONDITION_FAILED', 'targeted recoverable configuration repair is unavailable', { stateChanged: false })
  return provider.withLease(async assertHeld => {
    await fresh(); await assertHeld()
    const before = await readConfigurationHealth(ctx)
    if (before.state !== 'read' || !before.canRepair || !before.generation || !before.desired) return fail('PRECONDITION_FAILED', 'configuration repair requires a coherent current observation without pending changes', { stateChanged: false })
    if (before.revision !== intent.expectedRevision || before.generation.id !== intent.expectedGenerationId || before.generation.checksum !== intent.expectedGenerationChecksum) return fail('CONFLICT', 'configuration generation or observed files changed; read them again', { stateChanged: false })
    const target = before.targets.find(item => item.token === intent.target)
    if (!target) return fail('CONFLICT', 'the selected configuration drift is no longer current', { stateChanged: false })
    await fresh(); await ctx.audit({ actor: initial.actor, action: 'configuration.health.repair.requested', target: target.path, outcome: 'ok', detail: { generationId: before.generation.id, expectedChecksum: target.expectedChecksum } }); await assertHeld(); await fresh()
    let providerCompleted = false
    try {
      const result = await provider.repairTarget({ generation: before.generation, desired: before.desired, target, authorize: fresh, assertHeld })
      providerCompleted = true
      await assertHeld()
      const after = await readConfigurationHealth(ctx)
      if (result.recoveryVerified !== true || after.state !== 'read' || !after.generation || after.generation.id !== before.generation.id || after.generation.checksum !== before.generation.checksum || !same(after.desired, before.desired) || after.targets.some(item => item.path === target.path)
        || !same(after.targets, before.targets.filter(item => item.path !== target.path)) || after.tests.some(test => test.state !== 'passed') || after.tests.length === 0) throw new Error('unverified_configuration_repair')
      await fresh()
      await ctx.audit({ actor: initial.actor, action: 'configuration.health.repair.verified', target: target.path, outcome: 'ok', detail: { generationId: after.generation.id, expectedChecksum: target.expectedChecksum, recoveryVerified: true } })
      return json({ outcome: 'verified', target: target.token, generation: after.generation, recoveryVerified: true, verificationRequired: false, view: after })
    } catch (error) {
      if (!providerCompleted && isXpanelError(error) && error.detail.stateChanged === false) throw error
      return fail('SERVICE_UNAVAILABLE', 'configuration repair needs readback and recovery review before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    }
  })
}
