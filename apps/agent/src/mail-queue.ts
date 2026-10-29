import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import { MAIL_QUEUE_LIST_ARGV, isMailQueueAction, isMailQueueActionQueue, isMailQueueId, mailQueueActionArgv } from '../../../packages/os/src/mail-queue-command.ts'
import type { MailQueueAction, MailQueueActionQueue } from '../../../packages/os/src/mail-queue-command.ts'
export type { MailQueueAction, MailQueueActionQueue } from '../../../packages/os/src/mail-queue-command.ts'

/** showq(8) also reports maildrop; it is read-only here because postsuper(1) does not name it. */
export type MailQueueName = MailQueueActionQueue | 'maildrop'
export const MAIL_QUEUE_NAMES: readonly MailQueueName[] = ['maildrop', 'incoming', 'active', 'deferred', 'hold']
export interface MailQueueCommandResult { ok: boolean; code: number; stdout: string; stderr: string }
export type MailQueueRun = (argv: string[]) => Promise<MailQueueCommandResult>
export interface MailQueueRecipient { address: string; delayReason: string | null }
export interface MailQueueMessage {
  queueId: string
  queue: MailQueueName
  arrivalTime: string
  sizeBytes: number
  sender: string
  recipients: MailQueueRecipient[]
  recipientCount: number
  forcedExpire: boolean
}
export interface MailQueueRead {
  state: 'read' | 'unavailable'
  observedAt: string
  revision: string | null
  truncated: boolean
  counts: Record<MailQueueName, number>
  messages: MailQueueMessage[]
  reason?: 'command_failed' | 'output_limit' | 'malformed_output'
}
export type MailQueueOutcome = 'confirmed' | 'attempted' | 'unknown'
export interface MailQueueActionResult {
  action: MailQueueAction
  queueId: string
  queue: MailQueueActionQueue
  outcome: MailQueueOutcome
  verificationRequired: boolean
  after: { present: boolean | null; queue: MailQueueName | null }
  observedRevision: string
  revision: string | null
  observedAt: string
}

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
export const MAIL_QUEUE_SCAN_LIMIT = 50000
const MAX_RECIPIENTS = 100
const MAX_TEXT = 512
const REVISION = /^[0-9a-f]{64}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
// Envelope addresses are remote-controlled: neutralize controls/bidi overrides and bound length instead of failing the whole read.
const text = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ').slice(0, MAX_TEXT).toWellFormed()
const emptyCounts = (): Record<MailQueueName, number> => ({ maildrop: 0, incoming: 0, active: 0, deferred: 0, hold: 0 })
class MalformedQueue extends Error {}
const malformed = (): never => { throw new MalformedQueue() }

/** postqueue(1) -j: one JSON object per queue file, each followed by a newline (Postfix >= 3.1). */
function parseLine(line: string): MailQueueMessage {
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return malformed() }
  if (!object(raw) || typeof raw.queue_name !== 'string' || !(MAIL_QUEUE_NAMES as readonly string[]).includes(raw.queue_name) || !isMailQueueId(raw.queue_id)
    || !integer(raw.arrival_time, 253402300799) || !integer(raw.message_size, Number.MAX_SAFE_INTEGER) || typeof raw.sender !== 'string'
    || raw.forced_expire !== undefined && typeof raw.forced_expire !== 'boolean' || !Array.isArray(raw.recipients)) return malformed()
  // postqueue(1) -j: delay_reason is optional; delayed recipients may have none while delivery is in progress.
  const recipients = raw.recipients.slice(0, MAX_RECIPIENTS).map(item => {
    if (!object(item) || typeof item.address !== 'string' || item.delay_reason !== undefined && typeof item.delay_reason !== 'string') return malformed()
    return { address: text(item.address), delayReason: typeof item.delay_reason === 'string' ? text(item.delay_reason) : null }
  })
  return { queueId: raw.queue_id, queue: raw.queue_name as MailQueueName, arrivalTime: new Date(raw.arrival_time * 1000).toISOString(), sizeBytes: raw.message_size,
    sender: text(raw.sender), recipients, recipientCount: raw.recipients.length, forcedExpire: raw.forced_expire === true }
}

// shortcut: the API's protected host reader caps a response at 1 MiB; raise both together if larger listings are needed.
const DEFAULT_MAX_BYTES = 960 * 1024

export async function readMailQueue(input: { run: MailQueueRun; now?: () => Date; maxMessages?: number; maxBytes?: number }): Promise<MailQueueRead> {
  const maxMessages = input.maxMessages ?? 5000, maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > MAIL_QUEUE_SCAN_LIMIT || !(maxBytes > 0)) throw new Error('invalid_mail_queue_bound')
  const observedAt = (input.now?.() ?? new Date()).toISOString()
  const unavailable = (reason: NonNullable<MailQueueRead['reason']>): MailQueueRead => ({ state: 'unavailable', observedAt, revision: null, truncated: false, counts: emptyCounts(), messages: [], reason })
  let result: MailQueueCommandResult
  try { result = await input.run([...MAIL_QUEUE_LIST_ARGV]) } catch { return unavailable('command_failed') }
  if (!result || !result.ok || result.code !== 0 || typeof result.stdout !== 'string') return unavailable('command_failed')
  if (Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) return unavailable('output_limit')
  const lines = result.stdout.split('\n').filter(line => line.trim() !== '')
  const messages: MailQueueMessage[] = [], seen = new Set<string>(), counts = emptyCounts()
  let bytes = 0, truncated = lines.length > maxMessages
  try {
    for (const line of lines.slice(0, maxMessages)) {
      const message = parseLine(line)
      // postqueue(1): the queue may change while listed, so a message can appear more than once; keep the first sighting.
      if (seen.has(message.queueId)) continue
      bytes += Buffer.byteLength(JSON.stringify(message)) + 1
      if (bytes > maxBytes) { truncated = true; break }
      seen.add(message.queueId); counts[message.queue] += 1; messages.push(message)
    }
  } catch (error) { if (error instanceof MalformedQueue) return unavailable('malformed_output'); throw error }
  const identity = messages.map(item => [item.queue, item.queueId, item.arrivalTime, item.sizeBytes].join(' ')).sort().join('\n')
  return { state: 'read', observedAt, revision: createHash('sha256').update(identity).digest('hex'), truncated, counts, messages }
}

const eligible = (action: MailQueueAction, queue: MailQueueActionQueue): boolean =>
  action === 'deliver' ? queue === 'deferred' : action === 'release' ? queue === 'hold' : action === 'hold' ? queue !== 'hold' : true

/** Effects are proven only by a fresh postqueue -j re-read; command exit status alone never proves success. */
export async function applyMailQueueAction(input: {
  run: MailQueueRun; action: MailQueueAction; queueId: string; expectedQueue: MailQueueActionQueue; observedRevision: string
  now?: () => Date; authorize?: () => Promise<void>
}): Promise<MailQueueActionResult> {
  const { run, action, queueId, expectedQueue, observedRevision } = input
  if (!isMailQueueAction(action) || !isMailQueueId(queueId) || !isMailQueueActionQueue(expectedQueue) || typeof observedRevision !== 'string' || !REVISION.test(observedRevision)) return fail('VALIDATION', 'a supported action, queue id, queue and observed revision are required', { stateChanged: false })
  if (!eligible(action, expectedQueue)) return fail('VALIDATION', 'this action does not apply to messages in the selected queue', { stateChanged: false })
  const read = (): Promise<MailQueueRead> => readMailQueue({ run, ...(input.now ? { now: input.now } : {}), maxMessages: MAIL_QUEUE_SCAN_LIMIT, maxBytes: Number.POSITIVE_INFINITY })
    .catch(() => ({ state: 'unavailable' }) as MailQueueRead)
  const locate = (view: MailQueueRead): MailQueueName | null | undefined => view.state !== 'read' ? undefined
    : view.messages.find(item => item.queueId === queueId)?.queue ?? (view.truncated ? undefined : null)
  const before = locate(await read())
  if (before === undefined) return fail('PRECONDITION_FAILED', 'the mail queue could not be read before the action', { stateChanged: false })
  // The whole-queue revision churns on a live MTA; the precondition is this id in the queue the operator saw.
  if (before !== expectedQueue) return fail('CONFLICT', 'the message is no longer in the expected queue; reload before retrying', { stateChanged: false, current: { present: before !== null, queue: before } })
  await input.authorize?.()
  let accepted = false
  try { const result = await run(mailQueueActionArgv(action, queueId, expectedQueue)); accepted = !!result && result.ok && result.code === 0 } catch { accepted = false }
  const view = await read(), after = locate(view)
  if (!accepted && after === expectedQueue) return fail('PRECONDITION_FAILED', 'Postfix did not accept the queue action; the message is unchanged', { stateChanged: false })
  const proven = after === undefined ? false : action === 'delete' ? after === null : action === 'hold' ? after === 'hold' : action === 'release' ? after !== 'hold' : after !== expectedQueue
  // postqueue(1) -i only schedules delivery; a message may legitimately stay deferred, so it is never "delivered".
  const outcome: MailQueueOutcome = !accepted || after === undefined ? 'unknown' : action === 'deliver' ? 'attempted' : proven ? 'confirmed' : 'unknown'
  return { action, queueId, queue: expectedQueue, outcome, verificationRequired: outcome === 'unknown',
    after: { present: after === undefined ? null : after !== null, queue: after ?? null }, observedRevision, revision: view.state === 'read' ? view.revision : null,
    observedAt: view.observedAt ?? (input.now?.() ?? new Date()).toISOString() }
}
