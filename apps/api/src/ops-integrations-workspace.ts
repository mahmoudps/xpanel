import { createHash, randomBytes } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { deliverWebhook, parseWebhookConfig, randomEndpointId, webhookConfigRevision, WEBHOOK_EVENTS } from '../../agent/src/ops-webhooks.ts'
import type { WebhookConfig, WebhookDeliveryRecord, WebhookSender } from '../../agent/src/ops-webhooks.ts'

/** External integrations: signed webhook endpoints held as configuration, with per-endpoint secrets kept out of every
 * response, a bounded delivery log and a test delivery. Outbound egress is injected; tests never reach the network. */
export interface IntegrationsWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** ext.readOrDefault('integrations/webhooks.json', null) */
  readSaved: () => Promise<unknown>
  writeSaved: (value: unknown) => Promise<unknown>
  /** ext.readOrDefault('integrations/secrets.json', {}) — a map of endpoint id to signing secret; never returned to a client. */
  readSecrets: () => Promise<Record<string, string>>
  writeSecrets: (value: Record<string, string>) => Promise<unknown>
  /** ext.readOrDefault('integrations/deliveries.json', []) — a bounded delivery log. */
  readLog: () => Promise<WebhookDeliveryRecord[]>
  writeLog: (value: WebhookDeliveryRecord[]) => Promise<unknown>
  /** Qualified outbound HTTPS transport with egress controls. Null on a host with no reviewed webhook egress. */
  sender?: WebhookSender | null
  now?: () => Date
}

const ROUTE = '/api/server/integrations', TEST = '/api/server/integrations/test'
const MAX_LOG = 100
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
export const savedWebhookRevision = (raw: unknown): string => createHash('sha256').update(JSON.stringify(raw ?? null)).digest('hex')
const newSecret = (): string => 'whsec_' + randomBytes(24).toString('hex')

/** Public projection: endpoints, whether each has a stored secret, the signing scheme and egress capability. Never a secret. */
function viewOf(config: WebhookConfig, secrets: Record<string, string>, log: WebhookDeliveryRecord[], raw: unknown, capability: boolean, invalid: boolean) {
  return {
    endpoints: config.endpoints.map(endpoint => ({ id: endpoint.id, url: endpoint.url, events: endpoint.events, active: endpoint.active, secretPresent: typeof secrets[endpoint.id] === 'string' && secrets[endpoint.id]!.length >= 32 })),
    events: WEBHOOK_EVENTS, signatureScheme: 'hmac-sha256-t-v1', secretsLocation: 'extended/integrations/secrets.json',
    savedRevision: savedWebhookRevision(raw), activeRevision: webhookConfigRevision(config), invalid,
    egress: { state: capability ? 'available' : 'unavailable', reason: capability ? null : 'no_reviewed_webhook_egress' },
    deliveries: log.slice(-MAX_LOG).map(record => ({ id: record.id, endpointId: record.endpointId, event: record.event, createdAt: record.createdAt, state: record.state, attempts: record.attempts.length, lastStatus: record.attempts.at(-1)?.status ?? null })),
  }
}

export async function handleIntegrationsWorkspaceRoute(request: Request, url: URL, method: string, helpers: IntegrationsWorkspaceHelpers): Promise<Response | null> {
  const test = url.pathname === TEST
  if (!test && url.pathname !== ROUTE) return null
  const action = test ? 'server.integrations.test' : method === 'PUT' ? 'server.integrations.save' : 'server.integrations.read'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) return fail('VALIDATION', 'integration routes accept no selectors', unchanged)
  const fresh = async (): Promise<AuthenticatedCaller> => { const current = await helpers.requireCaller(request); await helpers.assertRoot(current, action); if (current.principal.id !== caller.principal.id || current.sessionId !== caller.sessionId || current.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'integration authority changed', unchanged); return current }
  const capability = typeof helpers.sender === 'function'

  if (test) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const body = await readJson(request, 1024)
    if (!object(body) || Object.keys(body).join() !== 'id' || typeof body.id !== 'string' || !/^whk_[0-9a-f]{16}$/.test(body.id)) return fail('VALIDATION', 'a webhook endpoint id is required', unchanged)
    const raw = await helpers.readSaved(), config = parseWebhookConfig(raw ?? { endpoints: [] }), endpoint = config.endpoints.find(item => item.id === body.id)
    if (!endpoint) return fail('NOT_FOUND', 'the webhook endpoint is not registered', unchanged)
    const secrets = await helpers.readSecrets(), secret = secrets[endpoint.id]
    if (typeof secret !== 'string' || secret.length < 32) return fail('PRECONDITION_FAILED', 'the endpoint has no signing secret; save it again to generate one', unchanged)
    const actor = await fresh()
    if (!capability || !helpers.sender) {
      await helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: 'server.integrations.test_attempted', target: 'webhook:' + endpoint.id, detail: { result: 'egress_unavailable' }, outcome: 'ok' })
      return fail('PRECONDITION_FAILED', 'outbound webhook delivery is unavailable on this server; nothing was sent', { ...unchanged, reason: 'no_reviewed_webhook_egress' })
    }
    const now = helpers.now ?? (() => new Date())
    const payload = JSON.stringify({ event: 'account.created', test: true, at: now().toISOString() })
    const record = await deliverWebhook({ endpoint, secret, delivery: { id: 'whd_test_' + now().getTime().toString(16), event: 'account.created', payload, timestamp: Math.floor(now().getTime() / 1000) }, send: helpers.sender, now })
    const log = [...await helpers.readLog(), record].slice(-MAX_LOG)
    await helpers.writeLog(log)
    await fresh()
    await helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: 'server.integrations.tested', target: 'webhook:' + endpoint.id, detail: { state: record.state, attempts: record.attempts.length }, outcome: record.state === 'delivered' ? 'ok' : 'failed' })
    return json(200, { delivery: { id: record.id, endpointId: record.endpointId, event: record.event, state: record.state, attempts: record.attempts.length, lastStatus: record.attempts.at(-1)?.status ?? null } })
  }

  if (method === 'GET') {
    const raw = await helpers.readSaved()
    let invalid = false
    if (raw !== null && raw !== undefined) try { parseWebhookConfig(raw) } catch { invalid = true }
    const config = invalid ? { endpoints: [] } : parseWebhookConfig(raw ?? { endpoints: [] })
    const [secrets, log] = [await helpers.readSecrets(), await helpers.readLog()]
    await fresh()
    return json(200, viewOf(config, secrets, log, raw, capability, invalid))
  }
  if (method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })

  const body = await readJson(request, 64 * 1024)
  if (!object(body) || Object.keys(body).sort().join() !== 'config,expectedSavedRevision' || typeof body.expectedSavedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedSavedRevision)) return fail('VALIDATION', 'a config and the observed saved revision are required', unchanged)
  const config = parseWebhookConfig(body.config)
  const actor = await fresh()
  if (savedWebhookRevision(await helpers.readSaved()) !== body.expectedSavedRevision) return fail('CONFLICT', 'the webhook registry changed since it was read; reload before saving', unchanged)
  // Generate a secret for every endpoint that lacks one; drop secrets for removed endpoints.
  const previous = await helpers.readSecrets(), secrets: Record<string, string> = {}
  for (const endpoint of config.endpoints) secrets[endpoint.id] = typeof previous[endpoint.id] === 'string' && previous[endpoint.id]!.length >= 32 ? previous[endpoint.id]! : newSecret()
  await helpers.writeSecrets(secrets)
  await helpers.writeSaved(config)
  const after = await helpers.readSaved()
  let verified: WebhookConfig
  try { verified = parseWebhookConfig(after) } catch { return fail('SERVICE_UNAVAILABLE', 'the saved webhook registry could not be verified', { stateChanged: true, verificationRequired: true }) }
  if (webhookConfigRevision(verified) !== webhookConfigRevision(config)) return fail('SERVICE_UNAVAILABLE', 'the saved webhook registry could not be verified', { stateChanged: true, verificationRequired: true })
  await helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: 'server.integrations.saved', target: 'server:integrations', detail: { endpoints: config.endpoints.length }, outcome: 'ok' })
  return json(200, viewOf(verified, secrets, await helpers.readLog(), after, capability, false))
}

async function readJson(request: Request, max: number): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > max) return fail('VALIDATION', 'the request body is too large', unchanged)
  try { return JSON.parse(text) } catch { return fail('VALIDATION', 'request body is not valid JSON', unchanged) }
}

void randomEndpointId
