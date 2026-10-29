import { fail, isXpanelError } from '@xpanel/core'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { buildPhpJobPlan, previewPhpOperation, readPhpManagement, readPhpOperation } from './php-manager.ts'
import type { PhpManagerHost } from './php-manager.ts'

export interface PhpManagerRouteContext {
  /** Re-authenticates the current caller and requires root; returns the fresh actor. */
  assertRoot(action: string): Promise<{ actor: string }>
  /** null when this agent does not run on a qualified native Linux host. */
  host: PhpManagerHost | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

async function body(req: Request): Promise<{ expectedRevision: string; rest: Record<string, unknown> }> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  let value: unknown
  try { value = JSON.parse(await req.text()) } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VALIDATION', 'request body must be a JSON object', { stateChanged: false })
  const { expectedRevision, ...rest } = value as Record<string, unknown>
  if (typeof expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(expectedRevision)) return fail('VALIDATION', 'the observed PHP revision is required', { stateChanged: false })
  return { expectedRevision, rest }
}

export async function handlePhpManagerRoute(req: Request, url: URL, method: string, ctx: PhpManagerRouteContext): Promise<Response | null> {
  const operation = url.pathname === '/host/php/manage' ? 'read' : url.pathname === '/host/php/manage/preview' ? 'preview' : url.pathname === '/host/php/manage/apply' ? 'apply' : null
  if (!operation) return null
  const action = 'host.php.manage.' + operation
  const first = await ctx.assertRoot(action)
  const expected = operation === 'read' ? 'GET' : 'POST'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return fail('VALIDATION', 'PHP management does not accept selectors', { stateChanged: false })
  const fresh = async (): Promise<string> => {
    const current = await ctx.assertRoot(action)
    if (current.actor !== first.actor) return fail('FORBIDDEN', 'PHP management authority changed', { stateChanged: false })
    return current.actor
  }
  if (!ctx.host) return fail('PRECONDITION_FAILED', 'PHP management requires a supported native Linux host', { stateChanged: false })
  if (operation === 'read') {
    const observed = await readPhpManagement(ctx.host)
    await fresh()
    return json(200, { ...observed, actions: { manage: ctx.submitJob !== null && observed.state === 'read' } })
  }
  const input = await body(req)
  const op = readPhpOperation(input.rest)
  if (operation === 'apply' && !ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable; no PHP change was submitted', { stateChanged: false })
  const observed = await readPhpManagement(ctx.host)
  if (observed.state !== 'read') return fail('PRECONDITION_FAILED', 'the PHP packages could not be observed', { stateChanged: false, reason: observed.reason })
  if (observed.revision !== input.expectedRevision) return fail('CONFLICT', 'PHP on this host changed since it was reviewed', { stateChanged: false, currentRevision: observed.revision })
  const preview = await previewPhpOperation(ctx.host, op, observed)
  const { built: _built, ...view } = preview
  if (operation === 'preview') { await fresh(); return json(200, { preview: view }) }
  if (preview.state !== 'ready') return fail('PRECONDITION_FAILED', 'the reviewed PHP change can no longer be applied', { stateChanged: false, reason: preview.reason })
  const actor = await fresh()
  const plan = await buildPhpJobPlan(ctx.host, preview, observed)
  let job: HostJobView
  try { job = await ctx.submitJob!(plan, actor) }
  catch (error) {
    if (isXpanelError(error) && error.detail.stateChanged === false) throw error
    return fail('SERVICE_UNAVAILABLE', 'PHP job submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  if (!job || typeof job.id !== 'string' || job.kind !== plan.kind) return fail('SERVICE_UNAVAILABLE', 'PHP job submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return json(202, { job, preview: view })
}
