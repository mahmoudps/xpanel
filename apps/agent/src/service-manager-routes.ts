import { fail, isXpanelError } from '@xpanel/core'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { assertServiceManagerTarget, buildServiceManagerPlan, readServiceManager } from './service-manager.ts'
import type { ServiceManagerAction, ServiceManagerRun } from './service-manager.ts'
import { isServiceManagerUnit } from '../../../packages/os/src/service-manager-command.ts'

export interface ServiceManagerRouteContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  run: ServiceManagerRun | null
  readFile: (path: string) => Promise<string | null>
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  audit: (entry: { actor: string; action: string; target: string; outcome: 'ok'; detail: Record<string, unknown> }) => Promise<unknown>
  now?: () => Date
}
export interface ServiceManagerInput { action: ServiceManagerAction; unit?: string; confirmation?: string; expectedRevision: string }
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function parseServiceManagerInput(value: unknown): ServiceManagerInput {
  const bad = (): never => fail('VALIDATION', 'an exact service action and observed revision are required', { stateChanged: false })
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad()
  const input = value as Record<string, unknown>, reboot = input.action === 'reboot'
  const keys = reboot ? ['action', 'confirmation', 'expectedRevision'] : ['action', 'unit', 'expectedRevision']
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key)) || !hash(input.expectedRevision)) return bad()
  if (reboot) { if (input.confirmation !== 'REBOOT SERVER') return bad(); return { action: 'reboot', confirmation: 'REBOOT SERVER', expectedRevision: input.expectedRevision } }
  if (!['enable', 'disable', 'restart'].includes(String(input.action)) || !isServiceManagerUnit(input.unit)) return bad()
  return { action: input.action as ServiceManagerAction, unit: input.unit, expectedRevision: input.expectedRevision }
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
export async function handleServiceManagerRoute(req: Request, url: URL, method: string, ctx: ServiceManagerRouteContext): Promise<Response | null> {
  const operation = url.pathname === '/host/service-manager' ? 'read' : url.pathname === '/host/service-manager/action' ? 'action' : null
  if (!operation) return null
  const action = 'host.services.manager.' + operation, first = await ctx.assertRoot(action)
  const fresh = async () => { const current = await ctx.assertRoot(action); if (current.actor !== first.actor) return fail('FORBIDDEN', 'service manager authority changed', { stateChanged: false }) }
  const expected = operation === 'read' ? 'GET' : 'POST'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return fail('VALIDATION', 'service manager does not accept query fields', { stateChanged: false })
  if (!ctx.run) return fail('PRECONDITION_FAILED', 'service manager requires the native Linux host executor', { stateChanged: false })
  if (operation === 'read') {
    const view = await readServiceManager({ run: ctx.run, readFile: ctx.readFile, manage: ctx.submitJob !== null, ...(ctx.now ? { now: ctx.now } : {}) })
    await fresh(); return json(view)
  }
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await req.text()
  if (text.length > 1024) return fail('VALIDATION', 'service action request exceeds the size limit', { stateChanged: false })
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'valid JSON is required', { stateChanged: false }) }
  const input = parseServiceManagerInput(body)
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable', { stateChanged: false })
  const observed = await readServiceManager({ run: ctx.run, readFile: ctx.readFile, ...(ctx.now ? { now: ctx.now } : {}) })
  if (observed.state !== 'read') return fail('PRECONDITION_FAILED', 'service inventory could not be verified', { stateChanged: false })
  if (observed.revision !== input.expectedRevision) return fail('CONFLICT', 'service state changed; refresh before trying again', { stateChanged: false })
  if (input.action !== 'reboot') {
    const target = await assertServiceManagerTarget(ctx.run, input.action, input.unit!)
    if (input.action === 'enable' && target.boot === 'enabled' || input.action === 'disable' && target.boot === 'disabled') return fail('CONFLICT', 'service already has the requested boot state', { stateChanged: false })
  } else if (observed.bootTime === null) return fail('PRECONDITION_FAILED', 'boot time must be observable before reboot', { stateChanged: false })
  const plan = buildServiceManagerPlan({ ...input, run: ctx.run, bootTime: observed.bootTime, assertFresh: fresh })
  await fresh()
  await ctx.audit({ actor: first.actor, action: 'services.manager.requested', target: input.unit ?? 'server', outcome: 'ok', detail: { action: input.action, verificationRequired: true } })
  await fresh()
  let job: HostJobView
  try { job = await ctx.submitJob(plan, first.actor) } catch (error) {
    if (isXpanelError(error) && error.detail.stateChanged === false) throw error
    return fail('SERVICE_UNAVAILABLE', 'service job submission requires review before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  if (!job || typeof job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(job.id) || job.kind !== plan.kind || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status)) return fail('SERVICE_UNAVAILABLE', 'service job acknowledgement could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return json({ action: input.action, unit: input.unit ?? null, outcome: input.action === 'reboot' ? 'attempted' : 'submitted', verificationRequired: true, job: { id: job.id, kind: job.kind, status: job.status } }, 202)
}
