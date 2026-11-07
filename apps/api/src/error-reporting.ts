import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import { latestActive } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { fail, isXpanelError } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertExpectedRevision, exactKeys, panelConfigRevision, panelJson, readPanelConfigBody, stateConfigFile } from './panel-config-file.ts'
import { isWebhookUrl } from '../../agent/src/ops-webhooks.ts'
import type { WebhookSender } from '../../agent/src/ops-webhooks.ts'

/**
 * Opt-in reporting of the panel's own unexpected errors to a Sentry-compatible DSN. Off until root saves a DSN. Every
 * report passes one scrubber first and leaves through the reviewed HTTPS egress; a failed report never touches the request.
 */
export interface ErrorReportingConfig { dsn: string | null; environment: string; sampleRate: number }
export type ErrorComponent = 'api' | 'agent' | 'web'
const ROUTE = '/api/server/error-reporting', TEST = ROUTE + '/test', NAMESPACE = 'error-reporting'
const unchanged = { stateChanged: false }
const DEFAULTS: ErrorReportingConfig = { dsn: null, environment: 'production', sampleRate: 1 }
const MAX_BODY_BYTES = 64 * 1024
const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function parseDsn(value: unknown): { key: string; envelope: string } | null {
  if (typeof value !== 'string' || value.length > 512) return null
  let url: URL
  try { url = new URL(value) } catch { return null }
  const project = /^\/([0-9]{1,20})$/.exec(url.pathname)?.[1]
  if (url.protocol !== 'https:' || !/^[0-9a-f]{16,64}$/i.test(url.username) || url.password || !project || url.search || url.hash) return null
  const envelope = `https://${url.host}/api/${project}/envelope/`
  return isWebhookUrl(envelope) ? { key: url.username, envelope } : null
}
export function parseErrorReportingConfig(raw: unknown): ErrorReportingConfig | null {
  if (!raw || typeof raw !== 'object' || !exactKeys(raw as Record<string, unknown>, ['dsn', 'environment', 'sampleRate'])) return null
  const { dsn, environment, sampleRate } = raw as Record<string, unknown>
  if (dsn !== null && !parseDsn(dsn) || typeof environment !== 'string' || !ENVIRONMENT.test(environment) || typeof sampleRate !== 'number' || !(sampleRate >= 0 && sampleRate <= 1)) return null
  return { dsn: dsn as string | null, environment, sampleRate }
}

const SECRET_KEY = /pass|pwd|secret|token|cookie|authorization|api[-_]?key|session|csrf|otp|totp|private/i
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const IPV4 = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi
const REDACTED = '[redacted]'
const scrubText = (text: string): string => text.replace(EMAIL, REDACTED).replace(IPV4, REDACTED).replace(IPV6, REDACTED)
/** Secret-named fields lose their value whatever it holds; every remaining string loses addresses. */
export function scrubReport(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) return depth > 8 ? REDACTED : value.slice(0, 100).map(item => scrubReport(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  if (depth > 8) return REDACTED
  return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [key, SECRET_KEY.test(key) ? REDACTED : scrubReport(item, depth + 1)]))
}

const stackFrames = (stack: string | undefined): { function: string; filename: string; lineno?: number; colno?: number }[] => (stack ?? '').split('\n').flatMap(line => {
  const match = /^\s*at (?:(.+?) \()?(.+?)(?::(\d+):(\d+))?\)?$/.exec(line)
  return match ? [{ function: match[1] ?? '<anonymous>', filename: match[2]!, ...(match[3] ? { lineno: Number(match[3]), colno: Number(match[4]) } : {}) }] : []
}).reverse().slice(-60)

export interface ErrorContext { component: ErrorComponent; method?: string; path?: string; body?: unknown }
/** A Sentry envelope: header line, item header line, event line. Sentry reads frames oldest first. */
export function errorEnvelope(error: unknown, context: ErrorContext, facts: { dsn: string; environment: string; release: string; generation: string; at: Date; eventId?: string }): string {
  const eventId = facts.eventId ?? randomUUID().replaceAll('-', ''), thrown = error instanceof Error ? error : new Error(String(error))
  const event = {
    event_id: eventId, timestamp: facts.at.toISOString(), platform: 'node', level: 'error', logger: 'xpanel', release: 'xpanel@' + facts.release, environment: facts.environment,
    tags: { component: context.component, generation: facts.generation },
    exception: { values: [{ type: thrown.name, value: scrubText(thrown.message), stacktrace: { frames: stackFrames(thrown.stack) } }] },
    ...(context.path ? { request: { method: context.method, url: context.path, ...(context.body === undefined ? {} : { data: scrubReport(context.body) }) } } : {}),
  }
  return [JSON.stringify({ event_id: eventId, sent_at: facts.at.toISOString(), dsn: facts.dsn }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n') + '\n'
}

const release = async (): Promise<string> => {
  if (process.env.XPANEL_VERSION) return process.env.XPANEL_VERSION
  const version = await realpath('/opt/xpanel/current').then(path => basename(path)).catch(() => null)
  if (version && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) return version
  return await readFile(new URL('../../../package.json', import.meta.url), 'utf8').then(text => String((JSON.parse(text) as { version?: unknown }).version ?? 'unknown')).catch(() => 'unknown')
}
const configFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>) => stateConfigFile(store, 'extended/integrations/error-reporting.json', NAMESPACE, parseErrorReportingConfig, () => DEFAULTS)

export interface ErrorReporterDeps { store: Pick<StateStore, 'rootDir' | 'getWriterLock'>; db: Db; send: () => Promise<WebhookSender>; random?: () => number; now?: () => Date }
export interface ErrorReporter {
  /** Whether a request body should be kept for a possible report; false when nothing is configured. */
  wanted(): Promise<boolean>
  capture(error: unknown, context: ErrorContext, force?: boolean): Promise<{ status: number } | null>
}
export function createErrorReporter(deps: ErrorReporterDeps): ErrorReporter {
  const file = configFile(deps.store)
  return {
    wanted: async () => (await file.current()).dsn !== null,
    capture: async (error, context, force = false) => {
      const config = await file.current(), dsn = parseDsn(config.dsn)
      if (!dsn || !force && (deps.random ?? Math.random)() >= config.sampleRate) return null
      const generation = await latestActive(deps.db).then(active => String(active?.id ?? 'none')).catch(() => 'unknown')
      const body = errorEnvelope(error, context, { dsn: config.dsn!, environment: config.environment, release: await release(), generation, at: (deps.now ?? (() => new Date()))() })
      return await (await deps.send())({ url: dsn.envelope, body, headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': 'Sentry sentry_version=7, sentry_client=xpanel/1, sentry_key=' + dsn.key } })
    },
  }
}
/** A small JSON body is copied before routing, only while a DSN is saved: the handler consumes the original. */
export async function keepErrorBody(request: Request, reporter: ErrorReporter): Promise<() => Promise<unknown>> {
  const size = Number(request.headers.get('content-length'))
  if (!['POST', 'PUT', 'PATCH'].includes(request.method) || !/json/i.test(request.headers.get('content-type') ?? '') || !(size > 0 && size <= MAX_BODY_BYTES) || !await reporter.wanted().catch(() => false)) return async () => undefined
  const copy = request.clone()
  return () => copy.json().catch(() => undefined)
}
/** The unexpected failures worth a report: a refused or validated request is the product working. */
export const isReportableError = (error: unknown): boolean => !isXpanelError(error) || ['INTERNAL_ERROR', 'SERVICE_UNAVAILABLE'].includes(error.code)

export interface ErrorReportingHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  reporter: ErrorReporter
}
export async function handleErrorReportingRoute(request: Request, url: URL, method: string, helpers: ErrorReportingHelpers): Promise<Response | null> {
  const test = url.pathname === TEST
  if (!test && url.pathname !== ROUTE) return null
  const write = test || method === 'PUT', action = test ? 'server.error_reporting.test' : write ? 'server.error_reporting.save' : 'server.error_reporting.read'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) return fail('VALIDATION', 'error reporting accepts no selectors', unchanged)
  const fresh = async (): Promise<AuthenticatedCaller> => { const current = await helpers.requireCaller(request); await helpers.assertRoot(current, action); return current }
  const file = configFile(helpers.store)
  if (test) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const config = await file.current()
    if (!config.dsn) return fail('PRECONDITION_FAILED', 'save a DSN first; nothing was sent', { ...unchanged, reason: 'dsn_not_configured' })
    let status: number | null = null
    try { status = (await helpers.reporter.capture(new Error('xPanel error reporting test event'), { component: 'api', method: 'POST', path: TEST, body: { password: 'test-value' } }, true))?.status ?? null }
    catch (error) { await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.error_reporting.tested', target: 'server:error-reporting', detail: { reason: (error as { reason?: string }).reason ?? 'unreachable' }, outcome: 'failed' }); return fail('PRECONDITION_FAILED', 'the DSN host did not accept the test event', { ...unchanged, reason: 'delivery_failed' }) }
    const delivered = status !== null && status >= 200 && status < 300
    await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.error_reporting.tested', target: 'server:error-reporting', detail: { status }, outcome: delivered ? 'ok' : 'failed' })
    return delivered ? panelJson({ delivered: true, status }) : fail('PRECONDITION_FAILED', 'the DSN host did not accept the test event', { ...unchanged, reason: 'delivery_failed', status })
  }
  const view = (raw: { raw: unknown; value: ErrorReportingConfig | null }) => ({ config: raw.value, invalid: raw.value === null, revision: panelConfigRevision(NAMESPACE, raw.raw) })
  if (method === 'GET') { const saved = await file.read(); await fresh(); return panelJson(view(saved)) }
  if (method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  const body = await readPanelConfigBody(request, 2048)
  if (!exactKeys(body, ['config', 'expectedRevision'])) return fail('VALIDATION', 'a config and the observed revision are required', unchanged)
  const expected = assertExpectedRevision(body.expectedRevision)
  const config = parseErrorReportingConfig(body.config)
  if (!config) return fail('VALIDATION', 'the DSN, environment or sample rate is invalid', { ...unchanged, reason: 'invalid_error_reporting' })
  const saved = await file.write(config, expected, async () => { await fresh() })
  await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.error_reporting.saved', target: 'server:error-reporting', detail: { enabled: config.dsn !== null, environment: config.environment, sampleRate: config.sampleRate }, outcome: 'ok' })
  return panelJson(view(saved))
}
