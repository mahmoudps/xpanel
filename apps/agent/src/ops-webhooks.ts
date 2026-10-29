import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { fail } from '@xpanel/core'

/** Signed outbound webhooks: HMAC-SHA256 over a timestamped payload, bounded retries and a durable delivery log.
 * No network call lives here; a delivery transport is injected so tests never reach a real endpoint. */
export type WebhookEvent = 'account.created' | 'account.suspended' | 'account.deleted' | 'backup.completed' | 'ssl.renewed' | 'job.failed'
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = ['account.created', 'account.suspended', 'account.deleted', 'backup.completed', 'ssl.renewed', 'job.failed']
export interface WebhookEndpoint { id: string; url: string; events: WebhookEvent[]; active: boolean }
export interface WebhookConfig { endpoints: WebhookEndpoint[] }

export const MAX_ENDPOINTS = 50
const ENDPOINT_ID = /^whk_[0-9a-f]{16}$/
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Only https to a public host; loopback, link-local and the reserved management ports are refused. */
export function isWebhookUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || /^(?:127\.|10\.|192\.168\.|169\.254\.|::1$|fe80:|fc|fd)/i.test(host) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return false
  if (['2083', '2087', '2096', '12083', '12087', '12096'].includes(url.port)) return false
  return true
}

export function parseWebhookConfig(value: unknown): WebhookConfig {
  if (!object(value) || Object.keys(value).join() !== 'endpoints' || !Array.isArray(value.endpoints) || value.endpoints.length > MAX_ENDPOINTS) return fail('VALIDATION', 'a bounded list of webhook endpoints is required', unchanged)
  const ids = new Set<string>()
  const endpoints = value.endpoints.map(raw => {
    if (!object(raw) || Object.keys(raw).sort().join() !== 'active,events,id,url' || typeof raw.id !== 'string' || !ENDPOINT_ID.test(raw.id) || ids.has(raw.id) || !isWebhookUrl(raw.url) || typeof raw.active !== 'boolean'
      || !Array.isArray(raw.events) || raw.events.length < 1 || raw.events.length > WEBHOOK_EVENTS.length || new Set(raw.events).size !== raw.events.length || !raw.events.every(event => WEBHOOK_EVENTS.includes(event as WebhookEvent))) return fail('VALIDATION', 'each endpoint needs an https URL and at least one known event', unchanged)
    ids.add(raw.id)
    return { id: raw.id, url: raw.url, events: raw.events as WebhookEvent[], active: raw.active }
  })
  return { endpoints }
}
export const webhookConfigRevision = (config: WebhookConfig): string =>
  createHash('sha256').update(JSON.stringify([...config.endpoints].map(endpoint => [endpoint.url, [...endpoint.events].sort(), endpoint.active]).sort((a, b) => (a[0] as string) < (b[0] as string) ? -1 : 1))).digest('hex')

export interface WebhookDelivery { id: string; event: WebhookEvent; payload: string; timestamp: number }
/** GitHub/Stripe-style scheme: sign `${t}.${body}` and send `t=<unix>,v1=<hex>`; the receiver recomputes and compares. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-xpanel-signature'
export function webhookSignature(secret: string, timestamp: number, body: string): string {
  if (typeof secret !== 'string' || secret.length < 32) return fail('PRECONDITION_FAILED', 'a webhook signing secret of at least 32 characters is required', unchanged)
  return 't=' + timestamp + ',v1=' + createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex')
}
/** Constant-time verification within a freshness window; used by tests and any local self-check, never trusting the header blindly. */
export function verifyWebhookSignature(secret: string, header: string, body: string, now: number, toleranceSec = 300): boolean {
  const match = /^t=([0-9]{1,15}),v1=([0-9a-f]{64})$/.exec(header)
  if (!match) return false
  const timestamp = Number(match[1])
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > toleranceSec) return false
  const expected = createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex')
  const got = Buffer.from(match[2]!, 'hex'), want = Buffer.from(expected, 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

/** Fixed backoff schedule (seconds): 6 attempts over ~1 hour. A non-2xx response or a transport error schedules the next attempt. */
export const WEBHOOK_BACKOFF_SEC: readonly number[] = [0, 30, 120, 300, 900, 1800]
export const MAX_WEBHOOK_ATTEMPTS = WEBHOOK_BACKOFF_SEC.length
export type WebhookSender = (input: { url: string; body: string; headers: Record<string, string> }) => Promise<{ status: number }>
export interface WebhookAttempt { attempt: number; at: string; outcome: 'delivered' | 'failed'; status: number | null; nextAttemptAt: string | null }
export interface WebhookDeliveryRecord { id: string; endpointId: string; event: WebhookEvent; createdAt: string; state: 'delivered' | 'failed' | 'exhausted'; attempts: WebhookAttempt[] }

/** One delivery run: attempts up to MAX_WEBHOOK_ATTEMPTS with the backoff schedule, signing every request. Returns the log record. */
export async function deliverWebhook(input: { endpoint: WebhookEndpoint; secret: string; delivery: WebhookDelivery; send: WebhookSender; now?: () => Date; sleep?: (ms: number) => Promise<void> }): Promise<WebhookDeliveryRecord> {
  const now = input.now ?? (() => new Date())
  const record: WebhookDeliveryRecord = { id: input.delivery.id, endpointId: input.endpoint.id, event: input.delivery.event, createdAt: now().toISOString(), state: 'exhausted', attempts: [] }
  for (let attempt = 0; attempt < MAX_WEBHOOK_ATTEMPTS; attempt++) {
    if (attempt > 0 && input.sleep) await input.sleep(WEBHOOK_BACKOFF_SEC[attempt]! * 1000)
    const timestamp = Math.floor(now().getTime() / 1000)
    const headers = { 'content-type': 'application/json', [WEBHOOK_SIGNATURE_HEADER]: webhookSignature(input.secret, timestamp, input.delivery.payload), 'x-xpanel-event': input.delivery.event, 'x-xpanel-delivery': input.delivery.id }
    let status: number | null = null
    try { const response = await input.send({ url: input.endpoint.url, body: input.delivery.payload, headers }); status = Number.isInteger(response?.status) ? response.status : null } catch { status = null }
    const delivered = status !== null && status >= 200 && status < 300
    const last = attempt === MAX_WEBHOOK_ATTEMPTS - 1
    const nextAttemptAt = delivered || last ? null : new Date(now().getTime() + WEBHOOK_BACKOFF_SEC[attempt + 1]! * 1000).toISOString()
    record.attempts.push({ attempt: attempt + 1, at: now().toISOString(), outcome: delivered ? 'delivered' : 'failed', status, nextAttemptAt })
    if (delivered) { record.state = 'delivered'; return record }
  }
  record.state = 'exhausted'
  return record
}

export const randomDeliveryId = (): string => 'whd_' + randomUUID().replace(/-/g, '').slice(0, 24)
export const randomEndpointId = (): string => 'whk_' + createHash('sha256').update(randomUUID()).digest('hex').slice(0, 16)
