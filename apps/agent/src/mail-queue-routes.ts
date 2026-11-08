import { fail } from '@xpanel/core'
import { applyMailQueueAction, drainMailQueue, MAIL_QUEUE_SCAN_LIMIT, readMailQueue } from './mail-queue.ts'
import type { MailQueueActionResult, MailQueueRun } from './mail-queue.ts'
import { isMailQueueAction, isMailQueueActionQueue, isMailQueueId, mailQueueActionArgv } from '../../../packages/os/src/mail-queue-command.ts'

export interface MailQueueAuditEntry { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }
export interface MailQueueRouteContext {
  /** Re-authenticates the current caller and requires root on every call. */
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Null when this agent is not running with the native Linux host executor. */
  run: MailQueueRun | null
  audit?: (entry: MailQueueAuditEntry) => Promise<unknown>
  now?: () => Date
}

const FIELDS = ['action', 'queueId', 'queue', 'expectedRevision']
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unavailable = (): never => fail('PRECONDITION_FAILED', 'the mail queue requires the native Linux host executor', { stateChanged: false })
async function readBody(req: Request, max = 4096): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', { stateChanged: false })
  const chunks: Uint8Array[] = [], reader = req.body?.getReader()
  let length = 0
  if (reader) try {
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      length += part.value.byteLength
      if (length > max) { await reader.cancel().catch(() => {}); return fail('VALIDATION', 'mail queue request exceeds the bounded body size', { stateChanged: false }) }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  let body: unknown
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { return fail('VALIDATION', 'request body must be valid UTF-8 JSON', { stateChanged: false }) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'request body must be an object', { stateChanged: false })
  return body as Record<string, unknown>
}

const HELD_SENDER = /^(?:[a-z0-9._+-]{1,64}@)?[a-z0-9.-]{1,253}$/
/** Releases or deletes the hold-queue messages of named senders (an address, or a domain for all its addresses), one queue id at a time, and reports what a fresh read still finds. */
async function heldMessages(req: Request, method: string, ctx: MailQueueRouteContext): Promise<Response> {
  const { actor } = await ctx.assertRoot('mail.queue.manage')
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const run = ctx.run ?? unavailable(), body = await readBody(req, 128 * 1024)
  if (Object.keys(body).sort().join() !== 'action,senders' || (body.action !== 'release' && body.action !== 'delete') || !Array.isArray(body.senders) || !body.senders.length || body.senders.length > 2000 || body.senders.some(item => typeof item !== 'string' || !HELD_SENDER.test(item))) return fail('VALIDATION', 'named senders and release or delete are required', { stateChanged: false })
  const senders = new Set(body.senders as string[]), action = body.action
  const scan = async () => { const view = await readMailQueue({ run, maxMessages: MAIL_QUEUE_SCAN_LIMIT, maxBytes: Number.POSITIVE_INFINITY }); return view.state === 'read' ? view.messages.filter(item => { const sender = item.sender.toLowerCase(); return item.queue === 'hold' && (senders.has(sender) || senders.has(sender.slice(sender.lastIndexOf('@') + 1))) }) : null }
  const matched = await scan()
  if (!matched) return fail('PRECONDITION_FAILED', 'the mail queue could not be read before the action', { stateChanged: false })
  for (const message of matched) await run(mailQueueActionArgv(action, message.queueId, 'hold')).catch(() => undefined)
  const left = await scan()
  await ctx.audit?.({ actor, action: 'mail.queue.held_' + action, target: 'mail-queue:hold', outcome: left?.length === 0 ? 'ok' : 'failed', detail: { matched: matched.length, remaining: left?.length ?? null } }).catch(() => {})
  return json({ action, matched: matched.length, remaining: left?.length ?? null })
}

async function drainRoute(req: Request, method: string, ctx: MailQueueRouteContext): Promise<Response> {
  await ctx.assertRoot('mail.queue.manage')
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const run = ctx.run ?? unavailable(), body = await readBody(req, 128 * 1024), domains = body.domains
  if (Object.keys(body).join() !== 'domains' || !Array.isArray(domains) || domains.length > 2000 || domains.some(item => typeof item !== 'string' || !HELD_SENDER.test(item) || item.includes('@'))) return fail('VALIDATION', 'domains are required', { stateChanged: false })
  return json(await drainMailQueue({ run, domains: domains as string[] }))
}

/** Root-only Postfix queue host routes. No message content, headers or bulk selector reaches Postfix. */
export async function handleMailQueueRoute(req: Request, url: URL, method: string, ctx: MailQueueRouteContext): Promise<Response | null> {
  const listing = url.pathname === '/host/mail/queue', held = url.pathname === '/host/mail/queue/held'
  if (url.pathname === '/host/mail/queue/drain') return drainRoute(req, method, ctx)
  if (!listing && !held && url.pathname !== '/host/mail/queue/action') return null
  if (held) return heldMessages(req, method, ctx)
  const { actor } = await ctx.assertRoot(listing ? 'mail.queue.read' : 'mail.queue.manage')
  const allowed = listing ? 'GET' : 'POST'
  if (method !== allowed) return new Response(null, { status: 405, headers: { allow: allowed } })
  if (url.search) return fail('VALIDATION', 'mail queue routes do not accept selectors', { stateChanged: false })
  const now = ctx.now ?? (() => new Date())
  if (listing) {
    if (!ctx.run) return unavailable()
    return json(await readMailQueue({ run: ctx.run, now }))
  }
  const body = await readBody(req)
  if (Object.keys(body).length !== FIELDS.length || Object.keys(body).some(key => !FIELDS.includes(key)) || !isMailQueueAction(body.action) || !isMailQueueId(body.queueId)
    || !isMailQueueActionQueue(body.queue) || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return fail('VALIDATION', 'action, queueId, queue and expectedRevision are required', { stateChanged: false })
  if (!ctx.run) return unavailable()
  const run = ctx.run, action = body.action, queueId = body.queueId, queue = body.queue, target = 'mail-queue:' + queueId
  if (ctx.audit) try { await ctx.audit({ actor, action: 'mail.queue.change_requested', target, outcome: 'ok', detail: { operation: action, queue } }) }
  catch { return fail('PRECONDITION_FAILED', 'the mail queue action could not be audited before dispatch', { stateChanged: false }) }
  let result: MailQueueActionResult, dispatched = false
  try {
    result = await applyMailQueueAction({ run, action, queueId, expectedQueue: queue, observedRevision: body.expectedRevision, now,
      authorize: async () => { await ctx.assertRoot('mail.queue.manage'); dispatched = true } })
  } catch (error) {
    const detail = (error as { detail?: Record<string, unknown> })?.detail
    await ctx.audit?.({ actor, action: 'mail.queue.' + action, target, outcome: 'failed', detail: { queue, outcome: !dispatched || detail?.stateChanged === false ? 'refused' : 'unknown' } }).catch(() => {})
    throw error
  }
  if (ctx.audit) try { await ctx.audit({ actor, action: 'mail.queue.' + action, target, outcome: result.outcome === 'unknown' ? 'failed' : 'ok', detail: { queue, outcome: result.outcome, afterQueue: result.after.queue } }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the mail queue outcome and audit require review', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
  return json(result)
}
