import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { isMailQueueAction, isMailQueueActionQueue, isMailQueueId } from '../../../packages/os/src/mail-queue-command.ts'
import type { MailQueueAction, MailQueueActionQueue } from '../../../packages/os/src/mail-queue-command.ts'
import type { MailQueueActionResult, MailQueueMessage, MailQueueName, MailQueueRead } from '../../agent/src/mail-queue.ts'

export interface MailQueueActionInput { action: MailQueueAction; queueId: string; queue: MailQueueActionQueue; expectedRevision: string }
export interface MailQueueWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** The authenticated agent owns Postfix access; absent when no protected host agent is connected. */
  readQueue?: (caller: AuthenticatedCaller) => Promise<unknown>
  applyAction?: (caller: AuthenticatedCaller, input: MailQueueActionInput) => Promise<unknown>
}

const QUEUES: readonly MailQueueName[] = ['maildrop', 'incoming', 'active', 'deferred', 'hold']
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
const bounded = (value: unknown): value is string => typeof value === 'string' && value.length <= 512
const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const badRead = (): never => fail('PRECONDITION_FAILED', 'the mail queue observation could not be verified', { stateChanged: false, verificationRequired: true })
const reviewAction = (): never => fail('PRECONDITION_FAILED', 'the mail queue action outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Whitelist the host boundary: envelope metadata only, never message bodies or headers. */
export function projectMailQueueRead(value: unknown): MailQueueRead {
  if (!object(value) || !['read', 'unavailable'].includes(String(value.state)) || !iso(value.observedAt) || typeof value.truncated !== 'boolean' || !object(value.counts) || !Array.isArray(value.messages) || value.messages.length > 5000) return badRead()
  if (value.state === 'read' ? !revision(value.revision) || value.reason !== undefined : value.revision !== null || value.messages.length !== 0 || !['command_failed', 'output_limit', 'malformed_output'].includes(String(value.reason))) return badRead()
  const counts = Object.fromEntries(QUEUES.map(name => [name, 0])) as Record<MailQueueName, number>, seen = new Set<string>()
  const messages: MailQueueMessage[] = value.messages.map(raw => {
    if (!object(raw) || !isMailQueueId(raw.queueId) || seen.has(raw.queueId) || !QUEUES.includes(raw.queue as MailQueueName) || !iso(raw.arrivalTime) || !count(raw.sizeBytes) || !bounded(raw.sender)
      || !Array.isArray(raw.recipients) || raw.recipients.length > 100 || !count(raw.recipientCount) || raw.recipientCount < raw.recipients.length || typeof raw.forcedExpire !== 'boolean') return badRead()
    seen.add(raw.queueId); counts[raw.queue as MailQueueName] += 1
    const recipients = raw.recipients.map(item => object(item) && bounded(item.address) && (item.delayReason === null || bounded(item.delayReason)) ? { address: item.address, delayReason: item.delayReason as string | null } : badRead())
    return { queueId: raw.queueId, queue: raw.queue as MailQueueName, arrivalTime: raw.arrivalTime, sizeBytes: raw.sizeBytes, sender: raw.sender, recipients, recipientCount: raw.recipientCount, forcedExpire: raw.forcedExpire }
  })
  const reported = value.counts
  if (QUEUES.some(name => reported[name] !== counts[name]) || Object.keys(reported).length !== QUEUES.length) return badRead()
  return { state: value.state as MailQueueRead['state'], observedAt: value.observedAt, revision: value.revision as string | null, truncated: value.truncated, counts, messages,
    ...(value.state === 'unavailable' ? { reason: value.reason as NonNullable<MailQueueRead['reason']> } : {}) }
}

/** A result is accepted only when its outcome is consistent with the re-read it claims. */
export function projectMailQueueAction(value: unknown, input: MailQueueActionInput): MailQueueActionResult {
  if (!object(value) || value.action !== input.action || value.queueId !== input.queueId || value.queue !== input.queue || value.observedRevision !== input.expectedRevision
    || !['confirmed', 'attempted', 'unknown'].includes(String(value.outcome)) || value.verificationRequired !== (value.outcome === 'unknown') || !iso(value.observedAt)
    || !object(value.after) || ![true, false, null].includes(value.after.present as boolean | null) || value.after.queue !== null && !QUEUES.includes(value.after.queue as MailQueueName)
    || (value.after.present === true) !== (value.after.queue !== null) || value.revision !== null && !revision(value.revision)) return reviewAction()
  const after = { present: value.after.present as boolean | null, queue: value.after.queue as MailQueueName | null }
  const proven = input.action === 'delete' ? after.present === false : input.action === 'hold' ? after.queue === 'hold' : input.action === 'release' ? after.present !== null && after.queue !== 'hold' : after.present !== null && after.queue !== input.queue
  if (value.outcome === 'attempted' ? input.action !== 'deliver' || after.present === null : value.outcome === 'confirmed' && (input.action === 'deliver' || !proven)) return reviewAction()
  return { action: input.action, queueId: input.queueId, queue: input.queue, outcome: value.outcome as MailQueueActionResult['outcome'], verificationRequired: value.outcome === 'unknown', after,
    observedRevision: input.expectedRevision, revision: value.revision as string | null, observedAt: value.observedAt }
}

async function readAction(request: Request): Promise<MailQueueActionInput> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', { stateChanged: false })
  const text = await request.text()
  if (text.length > 4096) return fail('VALIDATION', 'mail queue request exceeds the bounded body size', { stateChanged: false })
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
  const fields = ['action', 'queueId', 'queue', 'expectedRevision']
  if (!object(body) || Object.keys(body).length !== fields.length || Object.keys(body).some(key => !fields.includes(key)) || !isMailQueueAction(body.action) || !isMailQueueId(body.queueId)
    || !isMailQueueActionQueue(body.queue) || !revision(body.expectedRevision)) return fail('VALIDATION', 'action, queueId, queue and expectedRevision are required', { stateChanged: false })
  return { action: body.action, queueId: body.queueId, queue: body.queue, expectedRevision: body.expectedRevision }
}

export async function handleMailQueueWorkspaceRoute(request: Request, url: URL, method: string, helpers: MailQueueWorkspaceHelpers): Promise<Response | null> {
  const listing = url.pathname === '/api/server/mail-queue'
  if (!listing && url.pathname !== '/api/server/mail-queue/action') return null
  const action = listing ? 'server.mail-queue.read' : 'server.mail-queue.manage'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const allowed = listing ? 'GET' : 'POST'
  if (method !== allowed) return new Response(null, { status: 405, headers: { allow: allowed } })
  if (url.search) return fail('VALIDATION', 'mail queue routes do not accept selectors', { stateChanged: false })
  if (listing) {
    if (!helpers.readQueue) return fail('PRECONDITION_FAILED', 'the mail queue requires a connected host agent', { stateChanged: false })
    return json(projectMailQueueRead(await helpers.readQueue(caller)))
  }
  const input = await readAction(request)
  if (!helpers.applyAction) return fail('PRECONDITION_FAILED', 'the mail queue requires a connected host agent', { stateChanged: false })
  const fresh = async (): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, action)
    return current.principal.id === caller.principal.id ? current : fail('FORBIDDEN', 'mail queue authority changed', { stateChanged: false })
  }
  const actor = await fresh()
  const audit = (outcome: string, extra: Record<string, unknown> = {}) => helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: 'server.mail_queue.' + input.action,
    target: 'mail-queue:' + input.queueId, outcome: ['confirmed', 'attempted'].includes(outcome) ? 'ok' : 'failed', detail: { queue: input.queue, outcome, ...extra } })
  let result: MailQueueActionResult
  try { result = projectMailQueueAction(await helpers.applyAction(actor, input), input) }
  catch (error) {
    const raw = (error as { detail?: unknown })?.detail, detail = object(raw) ? raw : {}
    await audit(detail.stateChanged === false && detail.unknownOutcome !== true ? 'refused' : 'unknown').catch(() => {})
    throw error
  }
  try { await fresh() } catch {
    await audit(result.outcome, { authorityChanged: true }).catch(() => {})
    return fail('FORBIDDEN', 'root authority changed; the mail queue action outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
  }
  try { await audit(result.outcome, { afterQueue: result.after.queue }) } catch { return reviewAction() }
  return json(result)
}
