import { fail, isXpanelError } from '@xpanel/core'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { buildComponentJobPlan, isComponentSelection, previewComponentChange, readSoftwareCenter } from './software-center.ts'
import type { SoftwareCenterAction, SoftwareCenterFamily, SoftwareCenterObservation, SoftwareCenterRun } from './software-center.ts'

export interface SoftwareCenterRouteContext {
  /** Re-authenticates the current caller and requires root; returns the fresh actor. */
  assertRoot(action: string): Promise<{ actor: string }>
  /** null when this agent does not run on a qualified native Linux host. */
  family: SoftwareCenterFamily | null
  run: SoftwareCenterRun | null
  /** Host job runner submission; null while the runner is unavailable. */
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  now?: () => Date
}

const PAGES = ['catalog', 'module', 'runtime'] as const
const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Public projection: the internal package database observation never leaves the agent. */
export const softwareCenterView = (observed: SoftwareCenterObservation, page: typeof PAGES[number], manage: boolean) => ({
  state: observed.state, reason: observed.reason, family: observed.family, observedAt: observed.observedAt, revision: observed.revision, page,
  phpVersions: observed.phpVersions, candidates: observed.candidates, components: observed.components.filter(item => item.page === page),
  sources: [
    { id: 'shipped', state: 'trusted', trust: 'release-code' },
    { id: 'external', state: 'unavailable', reason: 'signed-external-catalogs-not-supported' },
  ],
  actions: { manage: manage && observed.state === 'read' },
})

async function body(req: Request, apply: boolean): Promise<{ action: SoftwareCenterAction; componentIds: string[]; expectedRevision: string; acceptExtraRemovals?: string }> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  let value: unknown
  try { value = JSON.parse(await req.text()) } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
  const fields = apply ? ['action', 'componentIds', 'expectedRevision', 'acceptExtraRemovals'] : ['action', 'componentIds', 'expectedRevision']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) return fail('VALIDATION', 'unsupported software center field', { stateChanged: false })
  const input = value as Record<string, unknown>
  if (input.action !== 'install' && input.action !== 'remove' || !isComponentSelection(input.componentIds) || !revision(input.expectedRevision) || input.acceptExtraRemovals !== undefined && !revision(input.acceptExtraRemovals)) return fail('VALIDATION', 'an action, 1 to 16 catalog component ids and the observed revision are required', { stateChanged: false })
  return { action: input.action, componentIds: input.componentIds, expectedRevision: input.expectedRevision, ...(input.acceptExtraRemovals === undefined ? {} : { acceptExtraRemovals: input.acceptExtraRemovals as string }) }
}

export async function handleSoftwareCenterRoute(req: Request, url: URL, method: string, ctx: SoftwareCenterRouteContext): Promise<Response | null> {
  const operation = url.pathname === '/host/software-center' ? 'read' : url.pathname === '/host/software-center/preview' ? 'preview' : url.pathname === '/host/software-center/apply' ? 'apply' : null
  if (!operation) return null
  const action = 'software.center.' + operation
  const first = await ctx.assertRoot(action)
  const expected = operation === 'read' ? 'GET' : 'POST'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  const unsupported = (): never => fail('PRECONDITION_FAILED', 'software changes require a supported native Linux host package manager', { stateChanged: false })
  const fresh = async (): Promise<string> => {
    const current = await ctx.assertRoot(action)
    if (current.actor !== first.actor) return fail('FORBIDDEN', 'software center authority changed', { stateChanged: false })
    return current.actor
  }
  if (operation === 'read') {
    const keys = [...url.searchParams.keys()], page = url.searchParams.get('page')
    if (keys.length !== 1 || keys[0] !== 'page' || !PAGES.includes(page as typeof PAGES[number])) return fail('VALIDATION', 'page must be catalog, module or runtime', { stateChanged: false })
    if (!ctx.family || !ctx.run) return unsupported()
    const observed = await readSoftwareCenter({ family: ctx.family, run: ctx.run, ...(ctx.now ? { now: ctx.now } : {}) })
    await fresh()
    return json(200, softwareCenterView(observed, page as typeof PAGES[number], ctx.submitJob !== null))
  }
  if (url.search) return fail('VALIDATION', 'software center changes do not accept selectors', { stateChanged: false })
  const input = await body(req, operation === 'apply')
  if (!ctx.family || !ctx.run) return unsupported()
  if (operation === 'apply' && !ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable; no package change was submitted', { stateChanged: false })
  const observed = await readSoftwareCenter({ family: ctx.family, run: ctx.run, ...(ctx.now ? { now: ctx.now } : {}) })
  if (observed.state !== 'read') return fail('PRECONDITION_FAILED', 'the package database could not be observed', { stateChanged: false, reason: observed.reason })
  if (observed.revision !== input.expectedRevision) return fail('CONFLICT', 'installed packages changed since they were reviewed', { stateChanged: false, currentRevision: observed.revision })
  const preview = await previewComponentChange({ action: input.action, componentIds: input.componentIds, family: ctx.family, run: ctx.run, observed })
  if (operation === 'preview') { await fresh(); return json(200, { preview }) }
  if (preview.state !== 'ready') return fail('PRECONDITION_FAILED', 'the reviewed change can no longer be applied', { stateChanged: false, reason: preview.reason, blockers: preview.blockers })
  const plan = buildComponentJobPlan({ action: input.action, componentIds: input.componentIds, family: ctx.family, observedRevision: input.expectedRevision, preview, observed, acceptExtraRemovals: input.acceptExtraRemovals })
  const actor = await fresh()
  let job: HostJobView
  try { job = await ctx.submitJob!(plan, actor) }
  catch (error) {
    if (isXpanelError(error) && error.detail.stateChanged === false) throw error
    return fail('SERVICE_UNAVAILABLE', 'package job submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  if (!job || typeof job.id !== 'string' || job.kind !== plan.kind) return fail('SERVICE_UNAVAILABLE', 'package job submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return json(202, { job })
}
