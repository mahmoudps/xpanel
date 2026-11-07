import { join } from 'node:path'
import { listAudit } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { deliverWebhook, MAX_WEBHOOK_ATTEMPTS, parseWebhookConfig, randomDeliveryId, WEBHOOK_BACKOFF_SEC } from '../../agent/src/ops-webhooks.ts'
import type { WebhookAttempt, WebhookDeliveryRecord, WebhookEvent, WebhookSender } from '../../agent/src/ops-webhooks.ts'

/**
 * Turns audited host events into signed webhook deliveries. The audit log is the one place both the API and the agent
 * record what happened, so a cursor over it misses nothing across restarts; the pending file keeps the retry schedule.
 * No timer of its own: it runs on the alert scheduler's cycle and does nothing while no endpoint is active.
 */
export const WEBHOOK_AUDIT_EVENTS: Readonly<Record<string, WebhookEvent>> = {
  'account.provisioned': 'account.created', 'account.suspended': 'account.suspended', 'account.terminated': 'account.deleted',
  'backup.account.completed': 'backup.completed', 'certificate.renewed': 'ssl.renewed', 'reconcile.failed': 'job.failed',
}
export const WEBHOOK_FILES = { saved: 'integrations/webhooks.json', secrets: 'integrations/secrets.json', log: 'integrations/deliveries.json', pending: 'integrations/pending.json', cursor: 'integrations/cursor.json' } as const
const MAX_LOG = 100, MAX_PENDING = 500, BATCH = 200

interface Pending { id: string; endpointId: string; event: WebhookEvent; payload: string; createdAt: string; attempts: WebhookAttempt[]; nextAt: string }
export interface WebhookDispatchInput { db: Db; store: Pick<StateStore, 'rootDir'>; send: WebhookSender; now?: () => Date }

const logged = (log: WebhookDeliveryRecord[], record: WebhookDeliveryRecord): WebhookDeliveryRecord[] => [...log.filter(item => item.id !== record.id), record].slice(-MAX_LOG)

/** One pass: collect new audited events for the active endpoints, then attempt every delivery that is due. */
export async function dispatchWebhooks(input: WebhookDispatchInput): Promise<{ queued: number; attempted: number }> {
  const file = (name: keyof typeof WEBHOOK_FILES): string => join(input.store.rootDir, 'extended', WEBHOOK_FILES[name])
  const now = input.now ?? (() => new Date())
  const raw = await readJsonIfExists<unknown>(file('saved'))
  let active: ReturnType<typeof parseWebhookConfig>['endpoints'] = []
  try { active = raw ? parseWebhookConfig(raw).endpoints.filter(endpoint => endpoint.active) : [] } catch { return { queued: 0, attempted: 0 } }
  const cursor = await readJsonIfExists<{ id: string } | null>(file('cursor'))
  let pending = await readJsonIfExists<Pending[]>(file('pending')) ?? []
  if (!active.length) {
    // An endpoint added later must not receive what happened before it existed.
    if (cursor) await atomicWriteJson(file('cursor'), null, 0o600)
    if (!pending.length) return { queued: 0, attempted: 0 }
  }
  let queued = 0
  if (active.length) {
    const latest = await listAudit(input.db, { limit: BATCH })
    if (!cursor) await atomicWriteJson(file('cursor'), { id: String(latest[0]?.id ?? 0) }, 0o600)
    else {
      const fresh = latest.filter(entry => Number(entry.id) > Number(cursor.id)).reverse()
      for (const entry of fresh) {
        const event = entry.outcome === 'ok' ? WEBHOOK_AUDIT_EVENTS[entry.action] : undefined
        if (event) for (const endpoint of active) if (endpoint.events.includes(event) && pending.length < MAX_PENDING) {
          // The audit target and time only: audit detail can hold account data the receiver never asked for.
          pending.push({ id: randomDeliveryId(), endpointId: endpoint.id, event, payload: JSON.stringify({ event, at: entry.at, target: entry.target }), createdAt: now().toISOString(), attempts: [], nextAt: now().toISOString() })
          queued++
        }
      }
      if (fresh.length) await atomicWriteJson(file('cursor'), { id: String(fresh.at(-1)!.id) }, 0o600)
      if (queued) await atomicWriteJson(file('pending'), pending, 0o600)
    }
  }
  const secrets = await readJsonIfExists<Record<string, string>>(file('secrets')) ?? {}
  let log = await readJsonIfExists<WebhookDeliveryRecord[]>(file('log')) ?? [], attempted = 0
  const due = pending.filter(item => Date.parse(item.nextAt) <= now().getTime())
  for (const item of due) {
    const endpoint = active.find(candidate => candidate.id === item.endpointId), secret = secrets[item.endpointId]
    // A removed or paused endpoint drops its deliveries; the secret is gone with it.
    if (!endpoint || typeof secret !== 'string') { pending = pending.filter(other => other.id !== item.id); continue }
    const record = await deliverWebhook({ endpoint, secret, delivery: { id: item.id, event: item.event, payload: item.payload, timestamp: Math.floor(now().getTime() / 1000) }, send: input.send, now, maxAttempts: 1 })
    attempted++
    const done = item.attempts.length + 1, last = done >= MAX_WEBHOOK_ATTEMPTS, delivered = record.state === 'delivered'
    const attempts: WebhookAttempt[] = [...item.attempts, { ...record.attempts[0]!, attempt: done, nextAttemptAt: delivered || last ? null : new Date(now().getTime() + WEBHOOK_BACKOFF_SEC[done]! * 1000).toISOString() }]
    log = logged(log, { id: item.id, endpointId: item.endpointId, event: item.event, createdAt: item.createdAt, state: delivered ? 'delivered' : last ? 'exhausted' : 'failed', attempts })
    pending = delivered || last ? pending.filter(other => other.id !== item.id) : pending.map(other => other.id === item.id ? { ...item, attempts, nextAt: attempts.at(-1)!.nextAttemptAt! } : other)
  }
  if (due.length) { await atomicWriteJson(file('log'), log, 0o600); await atomicWriteJson(file('pending'), pending, 0o600) }
  return { queued, attempted }
}
