import { fail } from '@xpanel/core'
import { SUPPORT_BUNDLE_MANIFEST, SUPPORT_BUNDLE_SECTIONS, SUPPORT_JOURNAL_UNITS, SUPPORT_LIMITS } from '../../agent/src/support-bundle.ts'
import type { SupportBundle, SupportJournalUnit, SupportResources, SupportSummary } from '../../agent/src/support-bundle.ts'
import { isSupportRedacted } from '../../agent/src/support-bundle-redaction.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface SupportWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** Absent when no protected host agent is connected. */
  readHost?: (caller: AuthenticatedCaller, path: string) => Promise<unknown>
  /** The saved branding document, or null when the owner never saved one. Built-in defaults are never passed. */
  readBranding: () => Promise<unknown>
}
export type SupportContact = { state: 'configured'; url: string | null; email: string | null } | { state: 'not-configured' } | { state: 'unavailable' }

const ACTION = 'server.support.read'
const BUNDLE_ACTION = 'server.support.bundle'
const unchanged = { stateChanged: false }
const invalid = (): never => fail('PRECONDITION_FAILED', 'the support observation could not be verified', unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
const CONTROLS = new RegExp(CONTROL.source, 'g')
const text = (value: unknown, max: number, pattern?: RegExp): string => typeof value === 'string' && value.length <= max && value.isWellFormed() && !CONTROL.test(value) && (!pattern || pattern.test(value)) ? value : invalid()
const nullable = <T>(value: unknown, read: (raw: unknown) => T): T | null => value === null ? null : read(value)
const time = (value: unknown): string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) && !CONTROL.test(value) ? value : invalid()
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max ? value as number : invalid()
const flag = (value: unknown): boolean => typeof value === 'boolean' ? value : invalid()
const oneOf = <T extends string | null>(value: unknown, allowed: readonly T[]): T => allowed.includes(value as T) ? value as T : invalid()
const list = <T>(value: unknown, max: number, read: (raw: unknown) => T): T[] => Array.isArray(value) && value.length <= max ? value.map(read) : invalid()
const keys = (value: Record<string, unknown>, expected: readonly string[]): void => { if (Object.keys(value).join('\u0000') !== expected.join('\u0000')) invalid() }
const READ = ['read', 'unavailable'] as const
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/
const reference = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(value) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && value !== 'XP-JOB-000000'
// read <=> value present, so a missing value can never render as observed.
const paired = <T extends { state: string }>(entry: T, present: boolean, readState = 'read'): T => (entry.state === readState) === present ? entry : invalid()

/** Whitelists the agent summary: exact grammars, bounded lists, and read states that match their values. */
export function projectSupportSummary(value: unknown): SupportSummary {
  if (!object(value) || !object(value.versions) || !object(value.versions.panel) || !object(value.os) || !object(value.os.profile) || !object(value.os.release) || !object(value.uptime)
    || !object(value.services) || !object(value.generation) || !object(value.drift) || !object(value.drift.byReason) || !object(value.failedJobs)) return invalid()
  const { panel } = value.versions, { profile, release } = value.os, g = value.generation, d = value.drift
  const version = nullable(panel.version, raw => text(raw, 32, VERSION))
  const seconds = nullable(value.uptime.seconds, raw => count(raw))
  const reasons = Object.entries(d.byReason as Record<string, unknown>)
  if (reasons.length > 8) invalid()
  return {
    observedAt: time(value.observedAt), host: oneOf(value.host, READ),
    versions: { panel: paired({ state: oneOf(panel.state, READ), version, releasePath: nullable(panel.releasePath, raw => text(raw, 256, /^\/[A-Za-z0-9/._-]*$/)) }, version !== null), node: text(value.versions.node, 32, /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/) },
    os: { profile: { id: text(profile.id, 64), versionId: text(profile.versionId, 64), family: text(profile.family, 32) },
      release: paired({ state: oneOf(release.state, READ), id: nullable(release.id, raw => text(raw, 64)), versionId: nullable(release.versionId, raw => text(raw, 64)), prettyName: nullable(release.prettyName, raw => text(raw, 160)) }, release.prettyName !== null || release.id !== null) },
    uptime: paired({ state: oneOf(value.uptime.state, READ), seconds }, seconds !== null),
    services: { state: oneOf(value.services.state, READ), items: list(value.services.items, 32, raw => object(raw) ? { id: text(raw.id, 32, /^[a-z0-9-]{1,32}$/), label: text(raw.label, 64), unit: nullable(raw.unit, item => text(item, 128, /^[A-Za-z0-9@._-]{1,128}$/)), state: oneOf(raw.state, ['active', 'inactive', 'failed', 'not-installed', 'unchecked'] as const) } : invalid()) },
    generation: paired({ state: oneOf(g.state, ['read', 'none', 'unavailable'] as const), id: nullable(g.id, raw => count(raw)), status: nullable(g.status, raw => text(raw, 32, /^[a-z_]{1,32}$/)), createdAt: nullable(g.createdAt, time), testedAt: nullable(g.testedAt, time), activatedAt: nullable(g.activatedAt, time), checksum: nullable(g.checksum, raw => text(raw, 64, /^[0-9a-f]{64}$/)) }, g.id !== null),
    drift: paired({ state: oneOf(d.state, ['read', 'none', 'unavailable'] as const), generationId: nullable(d.generationId, raw => count(raw)), manifestMissing: nullable(d.manifestMissing, flag), count: nullable(d.count, raw => count(raw, 1_000_000)),
      byReason: Object.fromEntries(reasons.map(([reason, total]) => [text(reason, 32, /^[a-z_]{1,32}$/), count(total, 1_000_000)])) }, d.count === null, 'unavailable'),
    failedJobs: { state: oneOf(value.failedJobs.state, READ), items: list(value.failedJobs.items, SUPPORT_LIMITS.failedJobs, raw => object(raw) ? {
      id: text(raw.id, 128, ID), referenceCode: nullable(raw.referenceCode, raw => reference(raw) ? raw : invalid()), kind: text(raw.kind, 128, ID), failureClass: oneOf(raw.failureClass, [null, 'retryable', 'permanent', 'unknown_outcome'] as const),
      createdAt: time(raw.createdAt), startedAt: nullable(raw.startedAt, time), finishedAt: nullable(raw.finishedAt, time),
      error: nullable(raw.error, item => typeof item === 'string' && item.length <= SUPPORT_LIMITS.jobErrorChars && item.isWellFormed() ? item.replace(CONTROLS, ' ') : invalid()),
      steps: list(raw.steps, SUPPORT_LIMITS.jobSteps, step => object(step) ? { id: text(step.id, 128, ID), state: oneOf(step.state, ['pending', 'running', 'succeeded', 'failed', 'skipped', 'unknown'] as const), exitCode: nullable(step.exitCode, code => Number.isSafeInteger(code) ? code as number : invalid()) } : invalid()),
    } : invalid()) },
  }
}

const bytesOrNull = (value: unknown): number | null => nullable(value, raw => count(raw))
function projectResources(value: unknown): SupportResources {
  if (!object(value) || !object(value.memory) || !object(value.filesystems)) return invalid()
  const m = value.memory, f = value.filesystems
  return {
    memory: { state: oneOf(m.state, READ), totalBytes: bytesOrNull(m.totalBytes), availableBytes: bytesOrNull(m.availableBytes), swapTotalBytes: bytesOrNull(m.swapTotalBytes), swapFreeBytes: bytesOrNull(m.swapFreeBytes) },
    filesystems: { state: oneOf(f.state, READ), truncated: flag(f.truncated), items: list(f.items, SUPPORT_LIMITS.filesystems, raw => object(raw) ? {
      filesystem: text(raw.filesystem, 1024), type: text(raw.type, 64), mount: text(raw.mount, 4096), totalBytes: count(raw.totalBytes), usedBytes: count(raw.usedBytes), availableBytes: count(raw.availableBytes),
      inodes: nullable(raw.inodes, item => object(item) ? { total: count(item.total), used: count(item.used), free: count(item.free) } : invalid()),
    } : invalid()) },
  }
}
const message = (value: unknown): string => typeof value === 'string' && value.length <= 64 * 1024 && value.isWellFormed() ? value : invalid()
const journalUnit = (value: unknown): SupportJournalUnit => object(value) ? {
  state: oneOf(value.state, READ), reason: nullable(value.reason, raw => text(raw, 32, /^[a-z-]{1,32}$/)), truncated: flag(value.truncated),
  items: list(value.items, SUPPORT_LIMITS.journalLines, raw => object(raw) ? { at: time(raw.at), priority: nullable(raw.priority, item => count(item, 7)), pid: nullable(raw.pid, item => count(item)), message: nullable(raw.message, message), messageTruncated: flag(raw.messageTruncated) } : invalid()),
} : invalid()

/** Rebuilds the bundle from whitelisted fields only, then proves it is the reviewed manifest and that redaction left nothing to redact. */
export function projectSupportBundle(value: unknown): SupportBundle {
  if (!object(value) || !object(value.journal)) return invalid()
  keys(value, ['manifest', 'generatedAt', ...SUPPORT_BUNDLE_SECTIONS.map(section => section.id)])
  keys(value.journal, SUPPORT_JOURNAL_UNITS)
  if (JSON.stringify(value.manifest) !== JSON.stringify(SUPPORT_BUNDLE_MANIFEST)) return invalid()
  const { observedAt: generatedAt, host: _host, ...summary } = projectSupportSummary({ ...value, observedAt: value.generatedAt, host: 'read' })
  const content = { versions: summary.versions, os: summary.os, uptime: summary.uptime, services: summary.services, resources: projectResources(value.resources), generation: summary.generation, drift: summary.drift, failedJobs: summary.failedJobs,
    journal: { [SUPPORT_JOURNAL_UNITS[0]]: journalUnit(value.journal[SUPPORT_JOURNAL_UNITS[0]]), [SUPPORT_JOURNAL_UNITS[1]]: journalUnit(value.journal[SUPPORT_JOURNAL_UNITS[1]]) } as SupportBundle['journal'] }
  if (!isSupportRedacted(content)) return fail('PRECONDITION_FAILED', 'the support bundle redaction could not be verified', unchanged)
  return { manifest: SUPPORT_BUNDLE_MANIFEST, generatedAt, ...content }
}

// /api/branding PUT merges its built-in placeholder contacts into the saved file; they are not owner configuration.
const PLACEHOLDER_CONTACTS: ReadonlySet<string> = new Set(['https://support.xpanel.internal', 'support@xpanel.internal', 'https://support.example.com'])
/** Only owner-saved support fields are shown; anything absent, malformed or placeholder is not configured. */
export function projectSupportContact(value: unknown): SupportContact {
  const pick = (raw: unknown, pattern: RegExp): string | null => typeof raw === 'string' && raw.length <= 512 && pattern.test(raw) && !CONTROL.test(raw) && !PLACEHOLDER_CONTACTS.has(raw.toLowerCase()) ? raw : null
  const url = object(value) ? pick(value.supportUrl, /^https?:\/\/[^\s<>"'`]{1,500}$/i) : null
  const email = object(value) ? pick(value.supportEmail, /^[^\s@<>"'`]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/) : null
  return url || email ? { state: 'configured', url, email } : { state: 'not-configured' }
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/**
 * Root-only GET /api/server/support (summary, manifest, contact) and GET /api/server/support/bundle?manifest=<id>
 * (the redacted diagnostics as a JSON attachment, bound to the manifest the administrator reviewed).
 */
export async function handleSupportWorkspaceRoute(request: Request, url: URL, method: string, helpers: SupportWorkspaceHelpers): Promise<Response | null> {
  const bundle = url.pathname === '/api/server/support/bundle'
  if (url.pathname !== '/api/server/support' && !bundle) return null
  const action = bundle ? BUNDLE_ACTION : ACTION
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (request.body !== null) return fail('VALIDATION', 'support reads do not accept a body', unchanged)
  if (!bundle && url.search) return fail('VALIDATION', 'the support summary does not accept selectors', unchanged)
  if (bundle) {
    const params = [...url.searchParams.keys()], manifest = url.searchParams.get('manifest')
    if (url.search.length > 64 || params.length !== 1 || params[0] !== 'manifest' || !manifest || !/^[0-9a-f]{16}$/.test(manifest)) return fail('VALIDATION', 'the reviewed manifest id is required', unchanged)
    if (manifest !== SUPPORT_BUNDLE_MANIFEST.id) return fail('CONFLICT', 'the bundle manifest changed; review it again before downloading', unchanged)
  }
  if (bundle && !helpers.readHost) return fail('PRECONDITION_FAILED', 'privileged host agent is not connected', unchanged)
  const raw = helpers.readHost ? await helpers.readHost(caller, bundle ? '/host/support/bundle' : '/host/support') : null
  const fresh = await helpers.requireCaller(request)
  await helpers.assertRoot(fresh, action)
  if (fresh.principal.id !== caller.principal.id || fresh.sessionId !== caller.sessionId || fresh.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'support authority changed', unchanged)
  if (!bundle) {
    let contact: SupportContact
    try { contact = projectSupportContact(await helpers.readBranding()) } catch { contact = { state: 'unavailable' } }
    return json({ summary: raw === null ? null : projectSupportSummary(raw), manifest: SUPPORT_BUNDLE_MANIFEST, contact })
  }
  const projected = projectSupportBundle(raw), body = JSON.stringify(projected)
  try { await helpers.emitAudit({ actor: fresh.principal.username, action: 'server.support.bundle_downloaded', target: 'server:support', detail: { manifest: SUPPORT_BUNDLE_MANIFEST.id, bytes: Buffer.byteLength(body) }, outcome: 'ok', principalId: fresh.principal.id }) }
  catch { return fail('PRECONDITION_FAILED', 'the support bundle download could not be audited', unchanged) }
  const stamp = projected.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return new Response(body, { headers: {
    'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="xpanel-support-${/^\d{8}T\d{6}Z$/.test(stamp) ? stamp : 'bundle'}.json"`,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  } })
}
