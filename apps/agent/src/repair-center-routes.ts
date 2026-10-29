import { fail, isXpanelError } from '@xpanel/core'
import type { ConfigTest } from '@xpanel/core'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { buildRepairJobPlan, isRepairJobId, previewRepair, repairDiagnosticId, RHEL_REPAIR_JOB_IDS, runRepairDiagnostics } from './repair-center.ts'
import type { RepairDriftObservation, RepairJobId, RepairReport, RepairRun, RepairRunTest, RhelCacheRecovery } from './repair-center.ts'

export interface RepairCenterRouteContext {
  /** Re-authenticates this request's caller, requires root and returns the current actor. */
  assertRoot(action: string): Promise<{ actor: string }>
  /** Trusted startup profile family; only debian and rhel are supported. */
  family: string
  /** Native executor only. Null keeps every route unavailable instead of simulating a host. */
  run: RepairRun | null
  runTest?: RepairRunTest
  /** Reviewed server-level config tests (for example from the active generation manifest). */
  configTests?: () => Promise<readonly ConfigTest[]>
  /** The existing reviewed drift reader (HostReconciler.checkDrift). */
  readDrift?: () => Promise<RepairDriftObservation>
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView> | HostJobView) | null
  /** Explicitly qualified native cache recovery, absent by default. */
  cacheRecovery?: RhelCacheRecovery
  /** Explicitly qualified /var/lib/rpm snapshot recovery for the database rebuild, absent by default. */
  rpmRecovery?: RhelCacheRecovery
  readJob?: (id: string) => Promise<HostJobView | null>
  now?: () => Date
}

const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; action: string }>> = {
  '/host/repair/diagnostics': { method: 'GET', action: 'host.repair.read' },
  '/host/repair/preview': { method: 'POST', action: 'host.repair.preview' },
  '/host/repair/run': { method: 'POST', action: 'host.repair.run' },
}
const MAX_BODY_CHARS = 4096
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unchanged = { stateChanged: false }

interface RepairIntent { repairId: RepairJobId; expectedRevision: string; acceptRemovals?: boolean; expectedRemovals?: string }

async function readIntent(req: Request, run: boolean): Promise<RepairIntent> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const text = await req.text()
  if (text.length > MAX_BODY_CHARS) return fail('VALIDATION', 'repair request is too large', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'repair request is not valid JSON', unchanged) }
  const fields = run ? ['repairId', 'expectedRevision', 'acceptRemovals', 'expectedRemovals'] : ['repairId', 'expectedRevision']
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'repair request must be an object', unchanged)
  const value = body as Record<string, unknown>
  if (Object.keys(value).some(key => !fields.includes(key)) || !isRepairJobId(value.repairId) || !hash(value.expectedRevision)
    || value.acceptRemovals !== undefined && typeof value.acceptRemovals !== 'boolean' || value.expectedRemovals !== undefined && !hash(value.expectedRemovals)
    || (value.acceptRemovals === true) !== (value.expectedRemovals !== undefined)
    || value.repairId !== 'apt-fix-broken' && value.acceptRemovals !== undefined) return fail('VALIDATION', 'a reviewed repair, observed revision and exact removal acceptance are required', unchanged)
  return { repairId: value.repairId, expectedRevision: value.expectedRevision, ...(value.acceptRemovals === undefined ? {} : { acceptRemovals: value.acceptRemovals as boolean }), ...(hash(value.expectedRemovals) ? { expectedRemovals: value.expectedRemovals } : {}) }
}

/** GET diagnostics, POST preview and POST run (202 with a host job). Returns null for other paths. */
export async function handleRepairCenterRoute(req: Request, url: URL, method: string, ctx: RepairCenterRouteContext): Promise<Response | null> {
  const route = ROUTES[url.pathname]
  if (!route || !Object.hasOwn(ROUTES, url.pathname)) return null
  const first = await ctx.assertRoot(route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  if (url.search) return fail('VALIDATION', 'repair routes do not accept selectors', unchanged)
  const intent = route.method === 'POST' ? await readIntent(req, url.pathname === '/host/repair/run') : null
  const family = ctx.family
  if (family !== 'debian' && family !== 'rhel') return fail('PRECONDITION_FAILED', 'repair diagnostics require a supported host profile', unchanged)
  const run = ctx.run
  if (!run) return fail('PRECONDITION_FAILED', 'repair diagnostics require the native host executor', unchanged)
  const confirmRoot = async (): Promise<string> => {
    const fresh = await ctx.assertRoot(route.action)
    if (fresh.actor !== first.actor) return fail('FORBIDDEN', 'repair authority changed', unchanged)
    return fresh.actor
  }
  let configTests: readonly ConfigTest[] = []
  if (ctx.configTests) {
    try { configTests = await ctx.configTests() } catch { return fail('PRECONDITION_FAILED', 'service configuration tests could not be listed', unchanged) }
  }
  const cacheRecoveryAvailable = !!ctx.cacheRecovery && !!ctx.submitJob && !!ctx.readJob
  const rpmRecoveryAvailable = !!ctx.rpmRecovery && !!ctx.submitJob && !!ctx.readJob
  const observe = async (refresh = false): Promise<RepairReport> => runRepairDiagnostics({ family, run, configTests: refresh && ctx.configTests ? await ctx.configTests() : configTests, cacheRecoveryAvailable, rpmRecoveryAvailable, ...(ctx.runTest ? { runTest: ctx.runTest } : {}), ...(ctx.readDrift ? { drift: ctx.readDrift } : {}), ...(ctx.now ? { now: ctx.now } : {}) })
  const report: RepairReport = await observe()
  if (!intent) { await confirmRoot(); return json(report) }

  if (RHEL_REPAIR_JOB_IDS.includes(intent.repairId) !== (family === 'rhel')) return fail('PRECONDITION_FAILED', 'no reviewed repair exists for this host profile', { ...unchanged, reason: family === 'rhel' ? 'rhel_repair_not_reviewed' : 'repair_unavailable_for_family' })
  if (report.revision !== intent.expectedRevision) return fail('CONFLICT', 'host diagnostics changed; run diagnostics again before repairing', { ...unchanged, revision: report.revision })
  const diagnostic = report.diagnostics.find(item => item.id === repairDiagnosticId(intent.repairId))
  if (!diagnostic || diagnostic.state !== 'problem' || diagnostic.repair.id !== intent.repairId || !diagnostic.repair.available)
    return fail('PRECONDITION_FAILED', 'this repair is not available for the observed host state', { ...unchanged, reason: diagnostic?.repair.reason ?? 'diagnostic_unavailable' })
  const preview = await previewRepair({ repairId: intent.repairId, family, run, cacheRecoveryAvailable, rpmRecoveryAvailable })
  if (url.pathname === '/host/repair/preview') { await confirmRoot(); return json({ revision: report.revision, preview }) }

  if (preview.state !== 'ready') return fail('PRECONDITION_FAILED', 'the repair could not be previewed, so it was not started', { ...unchanged, reason: preview.reason ?? 'preview_unavailable' })
  let acceptedRemovals: { fingerprint: string; packages: readonly string[] } | undefined
  if (preview.remove.length) {
    if (intent.acceptRemovals !== true) return fail('PRECONDITION_FAILED', 'this repair removes packages; review and accept the exact removal list', { ...unchanged, reason: 'removals_require_acceptance', removals: preview.remove, removalFingerprint: preview.removalFingerprint })
    if (intent.expectedRemovals !== preview.removalFingerprint) return fail('CONFLICT', 'the package removal list changed; preview the repair again', { ...unchanged, removals: preview.remove, removalFingerprint: preview.removalFingerprint })
    acceptedRemovals = { fingerprint: preview.removalFingerprint, packages: preview.remove }
  } else if (intent.acceptRemovals === true && intent.expectedRemovals !== preview.removalFingerprint) {
    return fail('CONFLICT', 'the package removal list changed; preview the repair again', { ...unchanged, removals: [], removalFingerprint: preview.removalFingerprint })
  }
  const plan = buildRepairJobPlan({ repairId: intent.repairId, family, observedRevision: report.revision, ...(acceptedRemovals ? { acceptedRemovals } : {}), ...(RHEL_REPAIR_JOB_IDS.includes(intent.repairId) ? { cacheRecovery: ctx.cacheRecovery, rpmRecovery: ctx.rpmRecovery, currentRevision: async () => (await observe(true)).revision, authorize: async () => { await confirmRoot() } } : {}) })
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable, so no repair was started', unchanged)
  const actor = await confirmRoot()
  let job: HostJobView
  try { job = await ctx.submitJob(plan, actor) } catch (error) {
    if (isXpanelError(error)) throw error
    return fail('SERVICE_UNAVAILABLE', 'repair job submission outcome is unknown; review host jobs before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  if (RHEL_REPAIR_JOB_IDS.includes(intent.repairId)) {
    try {
      const readback = ctx.readJob ? await ctx.readJob(job.id) : null
      if (!readback || readback.id !== job.id || readback.kind !== plan.kind || readback.actor !== actor || readback.accountId !== null || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(readback.status)) throw new Error('invalid_repair_job_readback')
      await confirmRoot(); job = readback
    } catch { return fail('SERVICE_UNAVAILABLE', 'repair job submission requires fresh job readback before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  }
  return json({ revision: report.revision, job }, 202)
}
