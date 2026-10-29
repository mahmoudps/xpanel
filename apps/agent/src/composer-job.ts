import { createHash, randomUUID } from 'node:crypto'
import { fail, msgid } from '@xpanel/core'
import type { Account, Domain, Plan } from '@xpanel/core'
import { composerAccountCommand, composerJobCommand, COMPOSER_JOB_TIMEOUT_MS, isComposerJobCommand } from '../../../packages/os/src/composer-job-command.ts'
import type { ComposerJobAction } from '../../../packages/os/src/composer-job-command.ts'
import { parseComposerDocuments } from './composer-workspace.ts'
import type { ComposerWorkspaceContext } from './composer-workspace.ts'
import type { HostJobPlan, HostJobVerification, HostJobView } from './host-job-contract.ts'
import type { ComposerJobGraphPackage, ComposerJobObservation, ComposerJobProvider, ComposerJobResolution, ComposerJobSnapshot, ComposerJobTarget } from './composer-job-provider.ts'

const HASH = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const unchanged = { stateChanged: false }
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const unavailable = (): never => fail('PRECONDITION_FAILED', 'the qualified descriptor-confined Composer transaction provider is unavailable; no job was submitted', unchanged)
const invalidObservation = (): never => fail('PRECONDITION_FAILED', 'Composer native transaction evidence could not be verified', unchanged)
const json = (status: number, body: unknown): Response => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export interface ComposerJobServices {
  provider: ComposerJobProvider | null
  family: 'debian' | 'rhel' | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  audit(entry: { actor: string; action: string; target: string; outcome: 'ok'; detail: Record<string, unknown> }): Promise<void>
}
type Context = Pick<ComposerWorkspaceContext, 'assertRoot' | 'store'>
export interface ComposerJobReview {
  state: 'ready'; action: ComposerJobAction; domainId: string; domain: string; account: string; phpVersion: string
  expectedRevision: string; reviewFingerprint: string; graphDigest: string; lockDigest: string; packages: ComposerJobGraphPackage[]
}
interface Reviewed { view: ComposerJobReview; target: Readonly<ComposerJobTarget>; resolution: ComposerJobResolution; before: ComposerJobObservation }
const qualifiedKeys = ['native', 'descriptorConfined', 'numericAccountIdentity', 'lifecycleFencing', 'isolatedStaging', 'offlineExecution', 'approvedArtifactDigests', 'resourceLimits', 'durableSnapshotRecovery', 'completeOwnershipReadback', 'sanitizedOutput'] as const
export function isComposerJobProviderQualified(provider: ComposerJobProvider | null | undefined): provider is ComposerJobProvider {
  const evidence = provider?.qualification
  return !!evidence && evidence.protocol === 1 && HASH.test(evidence.helperSha256) && HASH.test(evidence.sourcePolicyRevision) && qualifiedKeys.every(key => evidence[key] === true) && ['observe', 'resolve', 'prepare', 'recover', 'close'].every(key => typeof (provider as unknown as Record<string, unknown>)[key] === 'function')
}
export const composerTargetFingerprint = (target: Readonly<ComposerJobTarget>): string => sha(JSON.stringify(target))

function targetFrom(account: Account, domain: Domain, plan: Plan, family: 'debian' | 'rhel'): Readonly<ComposerJobTarget> {
  if (!UUID.test(account.id) || !UUID.test(domain.id) || account.id !== domain.accountId || account.status !== 'active' || domain.suspended || domain.siteType !== 'php' || !/^[a-z][a-z0-9]{0,15}$/.test(account.username) || account.home !== '/home/' + account.username || !Number.isSafeInteger(account.uid) || !Number.isSafeInteger(account.gid) || account.uid < 1000 || account.gid < 1000 || account.uid > 65533 || account.gid > 65533 || domain.docRoot.length > 1024 || !domain.docRoot.startsWith(account.home + '/') || !/^\/home\/[a-z][a-z0-9]{0,15}\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(domain.docRoot) || domain.docRoot.split('/').some(part => part === '.' || part === '..')) return fail('PRECONDITION_FAILED', 'the selected active PHP account target is unsupported', unchanged)
  composerAccountCommand('install', domain.php.version, family)
  const bounded = (limit: unknown, ceiling: number): number => {
    if (limit === 'unlimited') return ceiling
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) return fail('PRECONDITION_FAILED', 'the account plan resource limits are unavailable', unchanged)
    return Math.min(limit, ceiling)
  }
  const limits = Object.freeze({ memoryMb: bounded(plan.resources.memoryMb, 512), cpuPercent: bounded(plan.resources.cpuPercent, 100), maxProcesses: bounded(plan.resources.maxProcesses, 32), maxBytes: bounded(plan.resources.diskMb, 256) * 1024 * 1024, maxFiles: 20000 })
  return Object.freeze({ accountId: account.id, domainId: domain.id, username: account.username, uid: account.uid, gid: account.gid, home: account.home, directory: domain.docRoot, phpVersion: domain.php.version, family, planDigest: sha(JSON.stringify({ id: plan.id, resources: plan.resources })), limits })
}

/** A complete-tree provider digest is required; metadata alone can never verify vendor contents or ownership. */
export function composerObservationRevision(target: Readonly<ComposerJobTarget>, value: ComposerJobObservation): string {
  if (!object(value) || value.targetFingerprint !== composerTargetFingerprint(target) || !HASH.test(value.treeDigest) || value.uid !== target.uid || value.gid !== target.gid || value.ownershipVerified !== true || value.verifiedGraphDigest !== null && !HASH.test(value.verifiedGraphDigest)) return invalidObservation()
  for (const text of [value.manifest, value.lock, value.installed]) if (text !== null && (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024)) return invalidObservation()
  if (value.manifest === null) return fail('VALIDATION', 'COMPOSER_JSON_MISSING', { ...unchanged, reason: 'COMPOSER_JSON_MISSING' })
  try { parseComposerDocuments(value.manifest, value.lock, value.installed) } catch { return invalidObservation() }
  return sha(JSON.stringify([composerTargetFingerprint(target), value.treeDigest, value.manifest, value.lock, value.installed]))
}
function assertManifestPolicy(text: string): void {
  const manifest: unknown = JSON.parse(text)
  if (!object(manifest) || ['repositories', 'include-path', 'target-dir', 'bin'].some(key => Object.hasOwn(manifest, key))) return fail('PRECONDITION_FAILED', 'custom repositories and executable or alternate project paths are unsupported by the confined Composer job', unchanged)
  if (manifest.config !== undefined) {
    const config = manifest.config
    if (!object(config)) return invalidObservation()
    for (const [key, value] of Object.entries(config)) {
      const safe = ['sort-packages', 'optimize-autoloader'].includes(key) && typeof value === 'boolean' || key === 'allow-plugins' && (value === false || object(value) && Object.values(value).every(item => item === false)) || key === 'vendor-dir' && value === 'vendor' || key === 'bin-dir' && value === 'vendor/bin' || key === 'preferred-install' && value === 'dist'
      if (!safe) return fail('PRECONDITION_FAILED', 'project Composer configuration exceeds the reviewed isolated job profile', unchanged)
    }
  }
}
function resolutionView(value: ComposerJobResolution, beforeRevision: string, provider: ComposerJobProvider): ComposerJobResolution {
  if (!object(value) || value.beforeRevision !== beforeRevision || !HASH.test(value.graphDigest) || !HASH.test(value.lockDigest) || value.sourcePolicyRevision !== provider.qualification.sourcePolicyRevision || !Array.isArray(value.packages) || value.packages.length > 1000) return invalidObservation()
  const seen = new Set<string>()
  const packages = value.packages.map(item => {
    if (!object(item) || typeof item.name !== 'string' || item.name.length > 200 || !/^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/.test(item.name) || seen.has(item.name) || typeof item.version !== 'string' || !/^(?:v?[0-9][A-Za-z0-9.+_-]{0,127}|dev-[A-Za-z0-9._-]{1,120})$/.test(item.version) || typeof item.development !== 'boolean') return invalidObservation()
    seen.add(item.name); return { name: item.name, version: item.version, development: item.development }
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  return { beforeRevision, graphDigest: value.graphDigest, lockDigest: value.lockDigest, sourcePolicyRevision: value.sourcePolicyRevision, packages }
}
async function freshTarget(ctx: Context, account: Account, domainId: string, family: 'debian' | 'rhel'): Promise<{ target: Readonly<ComposerJobTarget>; domain: Domain }> {
  const domains = await ctx.store.listDomains()
  if (domains.length > 1000) return fail('PRECONDITION_FAILED', 'the Composer target inventory exceeds its bound', unchanged)
  const domain = domains.find(item => item.id === domainId), plan = await ctx.store.getPlan(account.planId)
  if (!domain || !plan) return fail('NOT_FOUND', 'the saved Composer site or plan is unavailable', unchanged)
  return { target: targetFrom(account, domain, plan, family), domain }
}
async function reviewUnderLease(ctx: Context, provider: ComposerJobProvider, account: Account, domainId: string, action: ComposerJobAction, family: 'debian' | 'rhel'): Promise<Reviewed> {
  const { target, domain } = await freshTarget(ctx, account, domainId, family)
  const observed = await provider.observe(target), expectedRevision = composerObservationRevision(target, observed)
  const before = Object.freeze({ ...observed })
  assertManifestPolicy(before.manifest!)
  const resolution = resolutionView(await provider.resolve(target, action, expectedRevision), expectedRevision, provider)
  if (action === 'install' && before.lock !== null && resolution.lockDigest !== sha(before.lock)) return fail('CONFLICT', 'install must preserve the existing Composer lock file', unchanged)
  const view: ComposerJobReview = { state: 'ready', action, domainId, domain: domain.name, account: account.username, phpVersion: domain.php.version, expectedRevision, reviewFingerprint: sha(JSON.stringify([composerTargetFingerprint(target), action, provider.qualification.helperSha256, resolution])), graphDigest: resolution.graphDigest, lockDigest: resolution.lockDigest, packages: resolution.packages }
  return { view, target, resolution, before }
}

export function buildComposerJobPlan(input: { ctx: Context; provider: ComposerJobProvider; reviewed: Reviewed; actor: string; assertActor(): Promise<void>; transactionId?: string }): HostJobPlan {
  if (!isComposerJobProviderQualified(input.provider)) return unavailable()
  const { ctx, provider, reviewed } = input, transactionId = input.transactionId ?? randomUUID(), argv = composerJobCommand(transactionId)
  const sourcePolicy = provider.qualification.sourcePolicyRevision, helperSha256 = provider.qualification.helperSha256
  let release: (() => void) | null = null, leaseTask: Promise<void> | null = null, snapshot: ComposerJobSnapshot | null = null
  let prepareAttempted = false, verified = false, began = false
  const expected = reviewed.view.expectedRevision, target = reviewed.target
  const observePostimage = async (): Promise<boolean> => {
    const current = await provider.observe(target)
    composerObservationRevision(target, current)
    if (current.manifest !== reviewed.before.manifest || current.lock === null || current.installed === null || sha(current.lock) !== reviewed.resolution.lockDigest || current.verifiedGraphDigest !== reviewed.resolution.graphDigest) return false
    const actual = parseComposerDocuments(current.manifest!, current.lock, current.installed).filter(item => item.locked !== null || item.installed !== null)
    return actual.length === reviewed.resolution.packages.length && reviewed.resolution.packages.every(item => actual.some(row => row.name === item.name && row.locked === item.version && row.installed === item.version && row.development === item.development))
  }
  return {
    kind: 'composer.dependencies.' + reviewed.view.action, summary: 'Composer ' + reviewed.view.action + ': ' + reviewed.view.domain, accountId: target.accountId,
    fingerprint: { domainId: target.domainId, action: reviewed.view.action, expectedRevision: expected, reviewFingerprint: reviewed.view.reviewFingerprint },
    detail: { domain: reviewed.view.domain, account: target.username, action: reviewed.view.action, packageCount: reviewed.resolution.packages.length, scripts: false, plugins: false, network: false, recoverySnapshotRetained: true },
    steps: [{ id: 'composer-transaction', title: msgid('Run isolated Composer transaction'), argv, timeoutMs: COMPOSER_JOB_TIMEOUT_MS, mutates: true }],
    policy: candidate => isComposerJobCommand(candidate) && JSON.stringify(candidate) === JSON.stringify(argv),
    beforeStep: async () => {
      if (began) return fail('CONFLICT', 'the Composer transaction cannot be replayed', unchanged)
      began = true
      await input.assertActor()
      if (!isComposerJobProviderQualified(provider) || provider.qualification.sourcePolicyRevision !== sourcePolicy || provider.qualification.helperSha256 !== helperSha256) return unavailable()
      const ready = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
      release = () => gate.resolve()
      leaseTask = ctx.store.withAccountLifecycleLease(target.accountId, async account => {
        try {
          await input.assertActor()
          const fresh = await reviewUnderLease(ctx, provider, account, target.domainId, reviewed.view.action, target.family)
          if (fresh.view.reviewFingerprint !== reviewed.view.reviewFingerprint) return fail('CONFLICT', 'Composer project, plan or approved dependency graph changed after review', unchanged)
          await input.assertActor()
          prepareAttempted = true
          snapshot = await provider.prepare({ transactionId, target, action: reviewed.view.action, review: reviewed.resolution, beforeRevision: expected, argv: composerAccountCommand(reviewed.view.action, target.phpVersion, target.family) })
          if (!snapshot || snapshot.transactionId !== transactionId || snapshot.targetFingerprint !== composerTargetFingerprint(target) || snapshot.beforeRevision !== expected || !HASH.test(snapshot.snapshotDigest) || snapshot.complete !== true || snapshot.durable !== true || snapshot.uid !== target.uid || snapshot.gid !== target.gid) return invalidObservation()
          await input.assertActor()
          ready.resolve(); await gate.promise
        } catch (error) {
          ready.reject(error)
          if (prepareAttempted) await gate.promise
        }
      })
      void leaseTask.catch(error => ready.reject(error))
      await ready.promise
    },
    verify: async () => {
      await input.assertActor()
      verified = snapshot !== null && await observePostimage()
      return { ok: verified, detail: { observedInstalledFiles: verified, ownershipVerified: verified, scripts: false, plugins: false, verificationRequired: !verified } }
    },
    finalize: async (_run, results): Promise<HostJobVerification> => {
      let result: HostJobVerification = { ok: false, detail: { verificationRequired: true, unknownOutcome: true } }
      try {
        if (!prepareAttempted) result = { ok: true, detail: { stateChanged: false, snapshotCreated: false } }
        else {
          const normal = results.length === 1 && results[0]?.id === 'composer-transaction' && results[0]?.result?.ok === true && results[0]?.result?.code === 0 && results[0]?.result?.timedOut === false
          if (verified && normal && snapshot && await observePostimage()) {
            const closed = await provider.close(transactionId, target, 'committed')
            result = { ok: closed.released === true && closed.snapshotRetained === true, detail: { installedFilesVerified: true, snapshotRetained: closed.snapshotRetained === true, verificationRequired: closed.released !== true || closed.snapshotRetained !== true } }
          } else {
            const recovered = await provider.recover(transactionId, target)
            const restored = ['restored', 'unchanged'].includes(recovered.state) && recovered.observation !== null && composerObservationRevision(target, recovered.observation) === expected
            if (restored) {
              const closed = await provider.close(transactionId, target, 'recovered')
              result = { ok: closed.released === true && closed.snapshotRetained === true, detail: { restored: true, snapshotRetained: closed.snapshotRetained === true, verificationRequired: closed.released !== true || closed.snapshotRetained !== true } }
            }
          }
        }
      } catch { result = { ok: false, detail: { verificationRequired: true, unknownOutcome: true, recoveryRequired: true } } }
      finally {
        release?.()
        try { await leaseTask } catch { if (prepareAttempted) result = { ok: false, detail: { verificationRequired: true, unknownOutcome: true, recoveryRequired: true } } }
      }
      return result
    },
  }
}

async function body(request: Request, apply: boolean): Promise<{ action: ComposerJobAction; domainId: string; expectedRevision?: string; reviewFingerprint?: string }> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'Composer jobs require JSON', unchanged)
  const reader = request.body?.getReader()
  if (!reader) return fail('VALIDATION', 'Composer job request body is required', unchanged)
  const chunks: Uint8Array[] = []; let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 2048) { await reader.cancel(); return fail('VALIDATION', 'Composer job request is too large', unchanged) }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch { return fail('VALIDATION', 'Composer job request must be UTF-8 JSON', unchanged) }
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail('VALIDATION', 'Composer job request must be valid JSON', unchanged) }
  const keys = apply ? ['action', 'domainId', 'expectedRevision', 'reviewFingerprint'] : ['action', 'domainId']
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || !['install', 'update'].includes(String(value.action)) || typeof value.domainId !== 'string' || !UUID.test(value.domainId) || apply && (typeof value.expectedRevision !== 'string' || !HASH.test(value.expectedRevision) || typeof value.reviewFingerprint !== 'string' || !HASH.test(value.reviewFingerprint))) return fail('VALIDATION', 'choose install or update and a saved site with the exact current review; paths, URLs, environments and extra fields are refused', unchanged)
  return { action: value.action as ComposerJobAction, domainId: value.domainId, ...(apply ? { expectedRevision: value.expectedRevision as string, reviewFingerprint: value.reviewFingerprint as string } : {}) }
}

export async function handleComposerJobRoute(request: Request, url: URL, method: string, ctx: Context, services?: ComposerJobServices | null): Promise<Response | null> {
  const apply = url.pathname === '/host/composer/jobs/apply'
  if (!apply && url.pathname !== '/host/composer/jobs/preview') return null
  const first = await ctx.assertRoot('software.composer.' + (apply ? 'apply' : 'preview'))
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'Composer jobs do not accept query selectors', unchanged)
  const input = await body(request, apply)
  if (!services || !services.family || !isComposerJobProviderQualified(services.provider) || !services.submitJob) return unavailable()
  const provider = services.provider, family = services.family
  const assertActor = async (): Promise<void> => { if ((await ctx.assertRoot('software.composer.' + (apply ? 'apply' : 'preview'))).actor !== first.actor) return fail('FORBIDDEN', 'Composer authority changed', unchanged) }
  const [accounts, domains] = await Promise.all([ctx.store.listAccounts(), ctx.store.listDomains()])
  if (accounts.length > 10000 || domains.length > 1000) return fail('PRECONDITION_FAILED', 'the Composer inventory exceeds its bound', unchanged)
  const domain = domains.find(item => item.id === input.domainId), account = domain ? accounts.find(item => item.id === domain.accountId) : null
  if (!domain || !account) return fail('NOT_FOUND', 'the selected Composer site is unavailable', unchanged)
  const reviewed = await ctx.store.withAccountLifecycleLease(account.id, async fresh => { await assertActor(); return reviewUnderLease(ctx, provider, fresh, input.domainId, input.action, family) })
  await assertActor()
  if (!apply) return json(200, { review: reviewed.view })
  if (input.expectedRevision !== reviewed.view.expectedRevision || input.reviewFingerprint !== reviewed.view.reviewFingerprint) return fail('CONFLICT', 'the Composer project or dependency graph changed; preview again', unchanged)
  const plan = buildComposerJobPlan({ ctx, provider, reviewed, actor: first.actor, assertActor })
  await services.audit({ actor: first.actor, action: 'composer.dependencies.requested', target: domain.name, outcome: 'ok', detail: { action: input.action, packageCount: reviewed.view.packages.length, reviewFingerprint: reviewed.view.reviewFingerprint } })
  await assertActor()
  let job: HostJobView
  try { job = await services.submitJob!(plan, first.actor) }
  catch { return fail('SERVICE_UNAVAILABLE', 'Composer job submission requires review before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  if (!UUID.test(job.id) || job.kind !== plan.kind || job.accountId !== account.id) return fail('SERVICE_UNAVAILABLE', 'the submitted Composer job acknowledgement could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  try { await assertActor() } catch { return fail('SERVICE_UNAVAILABLE', 'Composer authority changed after job submission; review the job before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  return json(202, { job })
}
