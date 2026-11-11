import { createHash, randomBytes } from 'node:crypto'
import { assertEmail, fail } from '@xpanel/core'
import { isWebhookUrl } from '../../agent/src/ops-webhooks.ts'
import { sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { ALERT_NOTIFICATION_EVENT, configuredChannels, EMPTY_DELIVERY_STATE, readSavedDeliveryState, sendTestNotice, serialDelivery } from './alert-delivery.ts'
import type { DeliveryChannels, DeliveryTransports, EmailMinimumSeverity } from './alert-delivery.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface PanelNotificationsHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** ext.readOrDefault('panel/notifications.json', null) */
  readSaved: () => Promise<unknown>
  /** ext.write('panel/notifications.json', value) */
  writeSaved: (value: unknown) => Promise<unknown>
  /** extended/panel/notification-signing-key.json, written 0600 and never returned after creation. */
  readSigningKey: () => Promise<unknown>
  writeSigningKey: (value: unknown) => Promise<unknown>
  /** The alert delivery record (monitoring/alerts-delivery.json); a test message is logged there. */
  readDelivery: () => Promise<unknown>
  writeDelivery: (value: unknown) => Promise<unknown>
  transports: DeliveryTransports
  now?: () => Date
}

/**
 * monitoring.alert is delivered by the alert evaluation (alert-delivery.ts). The others are audit actions the API and agent
 * really write (server.ts, reconciler.ts, upgrade-routes.ts, agent server.ts); no event source sends them yet.
 */
export const NOTIFICATION_EVENTS = [
  ALERT_NOTIFICATION_EVENT, 'auth.lockout', 'auth.login_failed', 'auth.2fa_disabled', 'reconcile.failed', 'reconcile.rolled_back', 'upgrade.handoff_failed', 'agent.internal_error', 'api.internal_error',
] as const
export const DELIVERED_NOTIFICATION_EVENTS: readonly string[] = [ALERT_NOTIFICATION_EVENT]
export const NOTIFICATION_MAX_RECIPIENTS = 10
export const EMAIL_MINIMUM_SEVERITIES: readonly EmailMinimumSeverity[] = ['all', 'warning', 'critical', 'high']
export interface NotificationWebhook { url: string; enabled: boolean }
export interface SavedTelegramChannel { botToken: string | null; chatId: string; enabled: boolean }
export interface ProjectedTelegramChannel { chatId: string; enabled: boolean; tokenSet: boolean }
export interface NotificationSettings {
  recipients: string[]
  events: string[]
  webhook: NotificationWebhook | null
  emailMinimumSeverity?: EmailMinimumSeverity
  telegram?: SavedTelegramChannel | null
  updatedAt: string
  updatedBy: string
}
interface SigningKeyRecord { key: string; createdAt: string; createdBy: string }

const ROUTE = '/api/server/panel/notifications', KEY_ROUTE = ROUTE + '/webhook-key', TEST_ROUTE = ROUTE + '/test', RESET_ROUTE = ROUTE + '/reset'
const MAX_BODY_BYTES = 16 * 1024
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, ACTOR = /^[A-Za-z0-9_.@-]{1,64}$/
// 'whsec_' + base64url(32 random bytes); verifiers recompute HMAC-SHA256 over `${t}.${body}` (ops-webhooks.ts).
const SIGNING_KEY = /^whsec_[A-Za-z0-9_-]{43}$/
const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const revisionOf = (raw: unknown): string => sha256Hex(JSON.stringify(raw ?? null))
/** Only the alert event sends messages: email through the local MTA, and a signed HTTPS webhook. */
const DELIVERY = { events: DELIVERED_NOTIFICATION_EVENTS, email: 'local_mta', webhook: 'https_signed', test: 'available' } as const

const recipientsOf = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > NOTIFICATION_MAX_RECIPIENTS) return invalid(`recipients must list at most ${NOTIFICATION_MAX_RECIPIENTS} email addresses`)
  const recipients = value.map(item => { try { return assertEmail(item, 'recipient').toLowerCase() } catch { return invalid('each recipient must be an email address') } })
  if (new Set(recipients).size !== recipients.length) return invalid('recipients must not repeat')
  return recipients
}
const eventsOf = (value: unknown): string[] => {
  if (!Array.isArray(value) || new Set(value).size !== value.length || !value.every(item => (NOTIFICATION_EVENTS as readonly unknown[]).includes(item))) return invalid('events must be a set of known notification events')
  return value as string[]
}
const webhookOf = (value: unknown): NotificationWebhook | null => {
  if (value === null) return null
  if (!object(value) || Object.keys(value).sort().join() !== 'enabled,url' || typeof value.enabled !== 'boolean' || !isWebhookUrl(value.url)) return invalid('the webhook needs an https URL on a public host and an enabled flag, or null')
  return { url: value.url, enabled: value.enabled }
}
const severityOf = (value: unknown): EmailMinimumSeverity => {
  if (typeof value !== 'string' || !(EMAIL_MINIMUM_SEVERITIES as readonly string[]).includes(value)) return invalid('emailMinimumSeverity must be all, warning, critical or high')
  return value as EmailMinimumSeverity
}
const telegramInputOf = (value: unknown): { botToken?: string | null; chatId: string; enabled: boolean } | null => {
  if (value === null) return null
  if (!object(value)) return invalid('telegram must be an object or null')
  const allowed = new Set(['botToken', 'chatId', 'enabled'])
  if (!Object.keys(value).every(k => allowed.has(k))) return invalid('telegram accepts only botToken, chatId and enabled')
  if (typeof value.chatId !== 'string' || value.chatId.trim().length === 0 || value.chatId.length > 128) return invalid('telegram.chatId is required')
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return invalid('telegram.enabled must be a boolean')
  if (value.botToken !== undefined && value.botToken !== null && (typeof value.botToken !== 'string' || value.botToken.trim().length === 0 || value.botToken.length > 256)) {
    return invalid('telegram.botToken must be a non-empty string or null')
  }
  return {
    chatId: value.chatId.trim(),
    enabled: value.enabled ?? true,
    ...(value.botToken !== undefined ? { botToken: value.botToken === null ? null : value.botToken.trim() } : {}),
  }
}
const savedTelegramOf = (value: unknown): SavedTelegramChannel | null => {
  if (value === null) return null
  if (!object(value) || Object.keys(value).sort().join() !== 'botToken,chatId,enabled' || typeof value.chatId !== 'string' || value.chatId.length === 0 || value.chatId.length > 128 || typeof value.enabled !== 'boolean') return invalid('invalid saved telegram')
  if (value.botToken !== null && (typeof value.botToken !== 'string' || value.botToken.length === 0 || value.botToken.length > 256)) return invalid('invalid saved telegram token')
  return { botToken: value.botToken, chatId: value.chatId, enabled: value.enabled }
}

/** Strict saved-file reader: anything else is reported as invalid, never as saved settings. */
export function readSavedNotificationSettings(raw: unknown): NotificationSettings | null {
  try {
    if (!object(raw)) return null
    const required = ['events', 'recipients', 'updatedAt', 'updatedBy', 'webhook']
    const optional = new Set(['emailMinimumSeverity', 'telegram'])
    const keys = Object.keys(raw)
    if (!required.every(k => k in raw) || !keys.every(k => required.includes(k) || optional.has(k))) return null
    if (typeof raw.updatedAt !== 'string' || !STAMP.test(raw.updatedAt) || typeof raw.updatedBy !== 'string' || !ACTOR.test(raw.updatedBy)) return null
    return {
      recipients: recipientsOf(raw.recipients),
      events: eventsOf(raw.events),
      webhook: webhookOf(raw.webhook),
      ...(raw.emailMinimumSeverity !== undefined ? { emailMinimumSeverity: severityOf(raw.emailMinimumSeverity) } : {}),
      ...(raw.telegram !== undefined ? { telegram: savedTelegramOf(raw.telegram) } : {}),
      updatedAt: raw.updatedAt,
      updatedBy: raw.updatedBy,
    }
  } catch { return null }
}
const readSigningKeyRecord = (raw: unknown): SigningKeyRecord | null => object(raw) && Object.keys(raw).sort().join() === 'createdAt,createdBy,key' && typeof raw.key === 'string' && SIGNING_KEY.test(raw.key)
  && typeof raw.createdAt === 'string' && STAMP.test(raw.createdAt) && typeof raw.createdBy === 'string' && ACTOR.test(raw.createdBy) ? raw as unknown as SigningKeyRecord : null
/** A short, non-reversible identifier so a receiver's configured key can be matched without showing it again. */
export const signingKeyFingerprint = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 16)

/** Where alerts go, from the saved settings and signing key; null when no verified settings are saved. */
export function deliveryChannelsOf(rawSettings: unknown, rawKey: unknown): DeliveryChannels | null {
  const settings = readSavedNotificationSettings(rawSettings)
  if (!settings) return null
  return {
    alerts: settings.events.includes(ALERT_NOTIFICATION_EVENT),
    recipients: settings.recipients,
    webhook: settings.webhook?.enabled ? { url: settings.webhook.url, key: readSigningKeyRecord(rawKey)?.key ?? null } : null,
    ...(settings.emailMinimumSeverity !== undefined ? { emailMinimumSeverity: settings.emailMinimumSeverity } : {}),
    ...(settings.telegram?.enabled ? { telegram: { botToken: settings.telegram.botToken, chatId: settings.telegram.chatId } } : {}),
  }
}

export function parseNotificationUpdate(body: unknown): {
  recipients: string[]
  events: string[]
  webhook: NotificationWebhook | null
  emailMinimumSeverity?: EmailMinimumSeverity
  telegram?: { botToken?: string | null; chatId: string; enabled: boolean } | null
  expectedRevision: string
} {
  if (!object(body)) return invalid('recipients, events, webhook and expectedRevision are required and nothing else is accepted')
  const required = ['events', 'expectedRevision', 'recipients', 'webhook']
  const optional = new Set(['emailMinimumSeverity', 'telegram'])
  const keys = Object.keys(body)
  if (!required.every(k => k in body) || !keys.every(k => required.includes(k) || optional.has(k))) {
    return invalid('recipients, events, webhook and expectedRevision are required and nothing else is accepted')
  }
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return invalid('the observed settings revision is required')
  const recipients = recipientsOf(body.recipients), events = eventsOf(body.events), webhook = webhookOf(body.webhook)
  const emailMinimumSeverity = body.emailMinimumSeverity !== undefined ? severityOf(body.emailMinimumSeverity) : undefined
  const telegram = body.telegram !== undefined ? telegramInputOf(body.telegram) : undefined
  if (events.length > 0 && recipients.length === 0 && !webhook?.enabled && !telegram?.enabled) return invalid('choose at least one recipient or an enabled webhook for the selected events')
  return {
    recipients,
    events,
    webhook,
    ...(emailMinimumSeverity !== undefined ? { emailMinimumSeverity } : {}),
    ...(telegram !== undefined ? { telegram } : {}),
    expectedRevision: body.expectedRevision,
  }
}

const projectSettings = (settings: NotificationSettings | null) => {
  if (!settings) return null
  const { telegram, ...rest } = settings
  if (telegram === undefined) return rest
  const projected: ProjectedTelegramChannel | null = telegram
    ? { chatId: telegram.chatId, enabled: telegram.enabled, tokenSet: Boolean(telegram.botToken) }
    : null
  return { ...rest, telegram: projected }
}

const viewOf = (raw: unknown, rawKey: unknown) => {
  const settings = raw === null ? null : readSavedNotificationSettings(raw), key = readSigningKeyRecord(rawKey)
  return { state: raw === null ? 'default' : settings ? 'saved' : 'invalid', settings: projectSettings(settings), revision: revisionOf(raw), events: NOTIFICATION_EVENTS, delivery: DELIVERY,
    signingKey: key ? { fingerprint: signingKeyFingerprint(key.key), createdAt: key.createdAt, createdBy: key.createdBy } : null }
}

// shortcut: in-process serialization only; one API process owns this extended state file.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task, task); queue = run.catch(() => undefined); return run }
async function freshRoot(request: Request, caller: AuthenticatedCaller, action: string, helpers: PanelNotificationsHelpers): Promise<AuthenticatedCaller> {
  const actor = await helpers.requireCaller(request)
  await helpers.assertRoot(actor, action)
  if (actor.principal.id !== caller.principal.id || actor.sessionId !== caller.sessionId || actor.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'notification settings authority changed', unchanged)
  return actor
}
const auditOrReview = async (helpers: PanelNotificationsHelpers, entry: Parameters<PanelNotificationsHelpers['emitAudit']>[0], message: string): Promise<void> => {
  try { await helpers.emitAudit(entry) } catch { return fail('SERVICE_UNAVAILABLE', message, { stateChanged: true, verificationRequired: true }) }
}

/**
 * Root notification channels and event selection under extended state: GET/PUT the settings, POST /webhook-key creates or
 * replaces the webhook signing key (returned once), POST /test sends one test message on every saved channel, POST /reset clears saved settings.
 */
export async function handlePanelNotificationsRoute(request: Request, url: URL, method: string, helpers: PanelNotificationsHelpers): Promise<Response | null> {
  if (url.pathname !== ROUTE && url.pathname !== KEY_ROUTE && url.pathname !== TEST_ROUTE && url.pathname !== RESET_ROUTE) return null
  const writing = method === 'PUT', posting = url.pathname !== ROUTE
  const action = url.pathname === KEY_ROUTE ? 'panel.notifications.webhook_key' : url.pathname === TEST_ROUTE ? 'panel.notifications.test' : url.pathname === RESET_ROUTE ? 'panel.notifications.reset' : writing ? 'panel.notifications.update' : 'panel.notifications.read'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (posting ? method !== 'POST' : method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: posting ? 'POST' : 'GET, PUT' } })
  if (url.search) return invalid('notification settings do not accept selectors')
  const now = helpers.now ?? (() => new Date())
  if (method === 'GET') return json(200, viewOf(await helpers.readSaved(), await helpers.readSigningKey()))

  if (url.pathname === RESET_ROUTE) {
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
    let body: unknown
    try { body = JSON.parse(await request.text()) } catch { return invalid('request body is not valid JSON') }
    if (!object(body) || Object.keys(body).join() !== 'expectedRevision' || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) {
      return invalid('the observed settings revision is required')
    }
    const expectedRevision = body.expectedRevision
    return serial(async () => {
      if (revisionOf(await helpers.readSaved()) !== expectedRevision) return fail('CONFLICT', 'notification settings changed since they were read; reload before resetting', unchanged)
      const actor = await freshRoot(request, caller, action, helpers)
      await helpers.writeSaved(null)
      if (await helpers.readSaved() !== null) return fail('SERVICE_UNAVAILABLE', 'the reset notification settings could not be verified', { stateChanged: true, verificationRequired: true })
      const rawKey = await helpers.readSigningKey()
      await auditOrReview(helpers, { actor: actor.principal.username, action: 'server.notifications.updated', target: 'panel:notifications', detail: { recipients: 0, events: [], webhook: null, reset: true }, outcome: 'ok', principalId: actor.principal.id },
        'the settings were reset but their audit record requires review')
      return json(200, viewOf(null, rawKey))
    })
  }

  if (posting) {
    if ((await request.text()).length) return invalid('this action does not accept a body')
    if (url.pathname === KEY_ROUTE) return serial(async () => {
      const actor = await freshRoot(request, caller, action, helpers)
      const record: SigningKeyRecord = { key: 'whsec_' + randomBytes(32).toString('base64url'), createdAt: now().toISOString(), createdBy: actor.principal.username }
      await helpers.writeSigningKey(record)
      if (readSigningKeyRecord(await helpers.readSigningKey())?.key !== record.key) return fail('SERVICE_UNAVAILABLE', 'the new signing key could not be verified', { stateChanged: true, verificationRequired: true })
      await auditOrReview(helpers, { actor: actor.principal.username, action: 'server.notifications.webhook_key_created', target: 'panel:notifications', detail: { fingerprint: signingKeyFingerprint(record.key) }, outcome: 'ok', principalId: actor.principal.id },
        'the signing key is saved but its audit record requires review')
      return json(200, { ...viewOf(await helpers.readSaved(), record), createdSigningKey: record.key })
    })
    return serial(async () => {
      const actor = await freshRoot(request, caller, action, helpers)
      const raw = await helpers.readSaved(), rawKey = await helpers.readSigningKey(), channels = deliveryChannelsOf(raw, rawKey)
      if (!channels || !configuredChannels(channels, true).length) return fail('PRECONDITION_FAILED', 'save at least one recipient or an enabled webhook before sending a test', unchanged)
      const at = now()
      const results = await serialDelivery(async () => {
        const sent = await sendTestNotice(readSavedDeliveryState(await helpers.readDelivery()) ?? EMPTY_DELIVERY_STATE, channels, helpers.transports, at)
        await helpers.writeDelivery(sent.state)
        return sent.results
      })
      await auditOrReview(helpers, { actor: actor.principal.username, action: 'server.notifications.tested', target: 'panel:notifications', detail: { results: results.map(item => ({ channel: item.channel, error: item.error, status: item.status })) },
        outcome: results.every(item => !item.error) ? 'ok' : 'failed', principalId: actor.principal.id }, 'the test was attempted but its audit record requires review')
      return json(200, { ...viewOf(raw, rawKey), test: { at: at.toISOString(), results } })
    })
  }

  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return invalid('the request body is too large')
  let body: unknown
  try { body = JSON.parse(text) } catch { return invalid('request body is not valid JSON') }
  const input = parseNotificationUpdate(body)
  return serial(async () => {
    const existingRaw = await helpers.readSaved()
    if (revisionOf(existingRaw) !== input.expectedRevision) return fail('CONFLICT', 'notification settings changed since they were read; reload before saving', unchanged)
    const actor = await freshRoot(request, caller, action, helpers)
    const rawKey = await helpers.readSigningKey()
    if (input.webhook?.enabled && !readSigningKeyRecord(rawKey)) return invalid('create a signing key before enabling the webhook')
    const existingSettings = existingRaw === null ? null : readSavedNotificationSettings(existingRaw)
    const savedTelegram: SavedTelegramChannel | null | undefined = input.telegram === undefined
      ? existingSettings?.telegram
      : input.telegram === null
        ? null
        : {
            chatId: input.telegram.chatId,
            enabled: input.telegram.enabled,
            botToken: input.telegram.botToken !== undefined ? input.telegram.botToken : (existingSettings?.telegram?.botToken ?? null),
          }
    const savedSeverity = input.emailMinimumSeverity !== undefined ? input.emailMinimumSeverity : existingSettings?.emailMinimumSeverity
    const next: NotificationSettings = {
      recipients: input.recipients,
      events: input.events,
      webhook: input.webhook,
      ...(savedSeverity !== undefined ? { emailMinimumSeverity: savedSeverity } : {}),
      ...(savedTelegram !== undefined ? { telegram: savedTelegram } : {}),
      updatedAt: now().toISOString(),
      updatedBy: actor.principal.username,
    }
    await helpers.writeSaved(next)
    const saved = await helpers.readSaved()
    if (revisionOf(saved) !== revisionOf(next) || !readSavedNotificationSettings(saved)) return fail('SERVICE_UNAVAILABLE', 'the saved notification settings could not be verified', { stateChanged: true, verificationRequired: true })
    await auditOrReview(helpers, { actor: actor.principal.username, action: 'server.notifications.updated', target: 'panel:notifications',
      detail: {
        recipients: next.recipients.length,
        events: next.events,
        webhook: next.webhook ? { host: new URL(next.webhook.url).host, enabled: next.webhook.enabled } : null,
        ...(next.emailMinimumSeverity !== undefined ? { emailMinimumSeverity: next.emailMinimumSeverity } : {}),
        ...(next.telegram !== undefined ? { telegram: next.telegram ? { enabled: next.telegram.enabled, tokenSet: Boolean(next.telegram.botToken) } : null } : {}),
      }, outcome: 'ok', principalId: actor.principal.id },
      'the settings are saved but their audit record requires review')
    return json(200, viewOf(saved, rawKey))
  })
}
