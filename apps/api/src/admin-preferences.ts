import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { LOCALES, fail, isLocale, isUuid } from '@xpanel/core'
import type { Locale, Principal } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface AdminPreferenceFields { language: Locale; theme: 'light' | 'dark'; density: 'comfortable' | 'compact' }
export interface AdminPreferencesRecord extends AdminPreferenceFields { version: 1; principalId: string; updatedAt: string }
export interface AdminPreferencesView {
  state: 'default' | 'saved' | 'invalid'
  preferences: AdminPreferenceFields | null
  updatedAt: string | null
  revision: string
  application: 'next_navigation'
}
export interface AdminPreferencesHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  now?: () => Date
}
export const DEFAULT_ADMIN_PREFERENCES: Readonly<AdminPreferenceFields> = Object.freeze({ language: 'en', theme: 'light', density: 'comfortable' })
const ROUTE = '/api/admin/preferences'
const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const identity = (principal: Principal): string => {
  if (!['root', 'reseller'].includes(principal.kind) || !isUuid(principal.id)) return fail('FORBIDDEN', 'administrator access is required', unchanged)
  return principal.id.toLowerCase()
}
const preferencePath = (rootDir: string, principal: Principal): string => join(rootDir, 'extended', 'preferences', identity(principal) + '.json')
const fields = (value: Record<string, unknown>): AdminPreferenceFields => {
  if (!isLocale(value.language)) return invalid(`language must be one of ${LOCALES.map(info => info.tag).join(', ')}`)
  if (value.theme !== 'light' && value.theme !== 'dark') return invalid('theme must be light or dark')
  if (value.density !== 'comfortable' && value.density !== 'compact') return invalid('density must be comfortable or compact')
  return { language: value.language, theme: value.theme, density: value.density }
}
export function readSavedAdminPreferences(raw: unknown, principal: Principal): AdminPreferencesRecord | null {
  try {
    if (!object(raw) || keys(raw) !== 'density,language,principalId,theme,updatedAt,version' || raw.version !== 1 || raw.principalId !== identity(principal)
      || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt)) || new Date(raw.updatedAt).toISOString() !== raw.updatedAt) return null
    return { version: 1, principalId: raw.principalId as string, ...fields(raw), updatedAt: raw.updatedAt }
  } catch { return null }
}
export const adminPreferencesRevision = (raw: unknown, principal: Principal): string => createHash('sha256')
  .update(JSON.stringify({ namespace: 'administrator-preferences:v1', principalId: identity(principal), value: raw })).digest('hex')
const viewOf = (raw: unknown, principal: Principal): AdminPreferencesView => {
  const saved = readSavedAdminPreferences(raw, principal)
  return { state: raw === null ? 'default' : saved ? 'saved' : 'invalid', preferences: raw === null ? { ...DEFAULT_ADMIN_PREFERENCES } : saved ? fields(saved as unknown as Record<string, unknown>) : null,
    updatedAt: saved?.updatedAt ?? null, revision: adminPreferencesRevision(raw, principal), application: 'next_navigation' }
}
/** Trusted document-rendering reader. Principal comes from the authenticated session, never a URL selector. */
export async function readAdminPreferenceValues(rootDir: string, principal: Principal): Promise<AdminPreferenceFields | null> {
  if (principal.kind !== 'root' && principal.kind !== 'reseller') return null
  try { const saved = readSavedAdminPreferences(await readJsonIfExists<unknown>(preferencePath(rootDir, principal)), principal); return saved ? fields(saved as unknown as Record<string, unknown>) : null }
  catch { return null }
}
export function parseAdminPreferencesUpdate(value: unknown): AdminPreferenceFields & { expectedRevision: string } {
  if (!object(value) || keys(value) !== 'density,expectedRevision,language,theme') return invalid('exactly language, theme, density and expectedRevision are required')
  if (typeof value.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedRevision)) return invalid('the observed preferences revision is required')
  return { ...fields(value), expectedRevision: value.expectedRevision }
}
const sameCaller = (left: AuthenticatedCaller, right: AuthenticatedCaller): boolean => left.principal.id === right.principal.id
  && left.principal.kind === right.principal.kind && left.principal.username === right.principal.username && left.sessionId === right.sessionId && left.apiTokenId === right.apiTokenId
const readSaved = async (path: string): Promise<unknown> => {
  try { return await readJsonIfExists<unknown>(path) }
  catch { return fail('PRECONDITION_FAILED', 'saved preferences cannot be read; review the saved file before retrying', unchanged) }
}
const readBody = async (request: Request): Promise<unknown> => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  if (!request.body) return invalid('a JSON body is required')
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
  for (;;) {
    const next = await reader.read(); if (next.done) break
    bytes += next.value.byteLength
    if (bytes > 4096) { await reader.cancel(); return invalid('the request body is too large') }
    chunks.push(next.value)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return invalid('request body is not valid JSON') }
}

/** Personal display preferences only: no server settings, account selector, authentication or MFA changes. */
export async function handleAdminPreferencesRoute(request: Request, url: URL, method: string, helpers: AdminPreferencesHelpers): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  const caller = await helpers.requireCaller(request), principalId = identity(caller.principal)
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  if (url.search) return invalid('preferences accept no query selectors')
  const path = preferencePath(helpers.store.rootDir, caller.principal)
  const fresh = async (): Promise<void> => {
    const current = await helpers.requireCaller(request)
    identity(current.principal)
    if (!sameCaller(caller, current)) fail('FORBIDDEN', 'administrator authority changed; sign in again', unchanged)
  }
  if (method === 'GET') { const raw = await readSaved(path); await fresh(); return json(viewOf(raw, caller.principal)) }
  const input = parseAdminPreferencesUpdate(await readBody(request))
  const lease = await helpers.store.getWriterLock().acquire()
  let attempted = false, result: AdminPreferencesView
  try {
    await fresh()
    const raw = await readSaved(path)
    if (raw !== null && !readSavedAdminPreferences(raw, caller.principal)) return fail('PRECONDITION_FAILED', 'saved preferences require review before they can be changed', unchanged)
    if (adminPreferencesRevision(raw, caller.principal) !== input.expectedRevision) return fail('CONFLICT', 'preferences changed; reload before saving', unchanged)
    const next: AdminPreferencesRecord = { version: 1, principalId, language: input.language, theme: input.theme, density: input.density, updatedAt: (helpers.now ?? (() => new Date()))().toISOString() }
    await fresh()
    await lease.assertFencingToken()
    attempted = true
    await atomicWriteJson(path, next, 0o640, async () => { await fresh(); await lease.assertFencingToken() })
    const saved = await readJsonIfExists<unknown>(path)
    if (JSON.stringify(saved) !== JSON.stringify(next) || !readSavedAdminPreferences(saved, caller.principal)) throw new Error('preferences_readback_failed')
    result = viewOf(saved, caller.principal)
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the preferences save could not be verified; reload before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
  try { await helpers.emitAudit({ actor: caller.principal.username, action: 'admin.preferences.updated', target: 'personal-preferences', detail: { language: input.language, theme: input.theme, density: input.density }, outcome: 'ok', principalId }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'preferences were saved but their audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true }) }
  return json(result!)
}
