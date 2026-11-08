import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { atomicWriteJson } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { uiPreferenceOwner } from './ui-preferences.ts'
import type { UiPreferenceAuthority, UiPreferenceOwner } from './ui-preferences.ts'

/** Saved per user on each surface: language, notice position, notification switches and the Getting Started dismissal. */
export const NOTICE_POSITIONS = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'center'] as const
export const NOTIFICATION_KEYS = ['disk', 'bandwidth', 'announcements'] as const
export type NoticePosition = typeof NOTICE_POSITIONS[number]
export type NotificationSwitches = Record<typeof NOTIFICATION_KEYS[number], boolean>
export interface PersonalPreferenceFields { locale: string | null; noticePosition: NoticePosition; notifications: NotificationSwitches; onboardingDismissed: boolean }
export interface PersonalPreferencesRecord extends PersonalPreferenceFields { schema: 1; surface: UiPreferenceAuthority['surface']; owner: UiPreferenceOwner; updatedAt: string }
export interface PersonalPreferencesView extends PersonalPreferenceFields {
  state: 'default' | 'saved' | 'invalid'
  /** the owner's language a team user sees until they choose one */
  inheritedLocale: string | null
  choices: { locales: readonly string[]; positions: readonly string[] }
  revision: string
  updatedAt: string | null
}
export interface PersonalPreferencesPorts extends Pick<ExtendedRouteHelpers, 'emitAudit'> {
  /** Revalidates session, listener and mailbox authority on every call. */
  open: (request: Request) => Promise<UiPreferenceAuthority>
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  locales: () => readonly string[]
  now?: () => Date
}

export const DEFAULT_PERSONAL_PREFERENCES: PersonalPreferenceFields = { locale: null, noticePosition: 'bottom-right', notifications: { disk: true, bandwidth: true, announcements: true }, onboardingDismissed: false }
const ROUTE = '/api/auth/personal-preferences'
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })
const recordPath = (rootDir: string, surface: string, owner: UiPreferenceOwner): string => join(rootDir, 'extended', 'personal-preferences', surface, owner.kind, hash(owner) + '.json')

function fields(raw: Record<string, unknown>): PersonalPreferenceFields | null {
  const n = raw.notifications
  if (!(raw.locale === null || typeof raw.locale === 'string') || !(NOTICE_POSITIONS as readonly unknown[]).includes(raw.noticePosition) || !object(n) || keys(n) !== [...NOTIFICATION_KEYS].sort().join()
    || !NOTIFICATION_KEYS.every(key => typeof n[key] === 'boolean') || typeof raw.onboardingDismissed !== 'boolean') return null
  return { locale: raw.locale, noticePosition: raw.noticePosition as NoticePosition, notifications: n as NotificationSwitches, onboardingDismissed: raw.onboardingDismissed }
}

async function readSaved(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return fail('PRECONDITION_FAILED', 'saved preferences cannot be read; review them before retrying', unchanged)
  }
}
const saved = (raw: unknown, surface: string, owner: UiPreferenceOwner): PersonalPreferencesRecord | null => {
  if (!object(raw) || raw.schema !== 1 || raw.surface !== surface || JSON.stringify(raw.owner) !== JSON.stringify(owner) || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) return null
  const values = fields(raw)
  return values ? { ...values, schema: 1, surface: surface as PersonalPreferencesRecord['surface'], owner, updatedAt: raw.updatedAt } : null
}
const inherited = async (rootDir: string, owner: UiPreferenceOwner): Promise<string | null> => {
  if (owner.kind !== 'team') return null
  const parent: UiPreferenceOwner = { kind: 'principal', principalKind: 'user', principalId: owner.ownerPrincipalId }
  return saved(await readSaved(recordPath(rootDir, 'xpanel', parent)).catch(() => undefined), 'xpanel', parent)?.locale ?? null
}

/** For document rendering: null when nothing usable is saved, so a broken record falls back to negotiation. */
export async function readPersonalPreferenceValues(rootDir: string, authority: UiPreferenceAuthority): Promise<PersonalPreferenceFields | null> {
  const owner = uiPreferenceOwner(authority)
  try {
    const record = saved(await readSaved(recordPath(rootDir, authority.surface, owner)), authority.surface, owner), fallback = await inherited(rootDir, owner)
    return record ? { ...record, locale: record.locale ?? fallback } : fallback ? { ...DEFAULT_PERSONAL_PREFERENCES, locale: fallback } : null
  } catch { return null }
}

export function parsePersonalPreferencesUpdate(value: unknown, locales: readonly string[]): PersonalPreferenceFields & { expectedRevision: string } {
  if (!object(value) || keys(value) !== 'expectedRevision,locale,noticePosition,notifications,onboardingDismissed') return fail('VALIDATION', 'locale, noticePosition, notifications, onboardingDismissed and expectedRevision are required', unchanged)
  const parsed = fields(value)
  if (!parsed) return fail('VALIDATION', 'a preference value is invalid', unchanged)
  if (parsed.locale !== null && !locales.includes(parsed.locale)) return fail('VALIDATION', 'the language is not offered on this server', { ...unchanged, reason: 'unknown_locale' })
  if (typeof value.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedRevision)) return fail('VALIDATION', 'the observed preferences revision is required', unchanged)
  return { ...parsed, expectedRevision: value.expectedRevision }
}

const viewOf = (raw: unknown, record: PersonalPreferencesRecord | null, locales: readonly string[], inheritedLocale: string | null): PersonalPreferencesView => {
  const { locale, noticePosition, notifications, onboardingDismissed } = record ?? DEFAULT_PERSONAL_PREFERENCES
  return { state: raw === undefined ? 'default' : record ? 'saved' : 'invalid', locale, noticePosition, notifications, onboardingDismissed, inheritedLocale,
    choices: { locales, positions: NOTICE_POSITIONS }, revision: hash({ exists: raw !== undefined, raw }), updatedAt: record?.updatedAt ?? null }
}

export async function handlePersonalPreferencesRoute(request: Request, url: URL, method: string, ports: PersonalPreferencesPorts): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT', 'cache-control': 'no-store' } })
  if (url.search) return fail('VALIDATION', 'preferences accept no query selectors', unchanged)
  const authority = await ports.open(request), owner = uiPreferenceOwner(authority), path = recordPath(ports.store.rootDir, authority.surface, owner), locales = ports.locales()
  if (method === 'GET') {
    const raw = await readSaved(path)
    return json(viewOf(raw, saved(raw, authority.surface, owner), locales, await inherited(ports.store.rootDir, owner)))
  }
  if (authority.caller.impersonator) return fail('FORBIDDEN', 'a handed-off session cannot change permanent personal preferences', unchanged)
  let body: unknown
  try { body = JSON.parse((await request.text()).slice(0, 4096)) } catch { return fail('VALIDATION', 'request body is not valid JSON', unchanged) }
  const { expectedRevision, ...values } = parsePersonalPreferencesUpdate(body, locales)
  const lease = await ports.store.getWriterLock().acquire()
  let next: PersonalPreferencesRecord
  try {
    const raw = await readSaved(path), current = viewOf(raw, saved(raw, authority.surface, owner), locales, null)
    if (current.state === 'invalid') return fail('PRECONDITION_FAILED', 'saved preferences require review before they can be changed', unchanged)
    if (current.revision !== expectedRevision) return fail('CONFLICT', 'preferences changed; reload before saving', unchanged)
    if (uiPreferenceOwner(await ports.open(request)).kind !== owner.kind) return fail('FORBIDDEN', 'personal preference authority changed; sign in again', unchanged)
    next = { schema: 1, surface: authority.surface, owner, ...values, onboardingDismissed: values.onboardingDismissed || current.onboardingDismissed, updatedAt: (ports.now ?? (() => new Date()))().toISOString() }
    await lease.assertFencingToken()
    await atomicWriteJson(path, next, 0o640, () => lease.assertFencingToken())
  } finally { await lease.release() }
  const stored = await readSaved(path)
  if (JSON.stringify(stored) !== JSON.stringify(next)) return fail('SERVICE_UNAVAILABLE', 'the preferences could not be verified; review them before retrying', { stateChanged: true, verificationRequired: true })
  await ports.emitAudit({ actor: authority.caller.team?.username ?? authority.caller.principal.username, action: 'auth.personal-preferences.updated', target: 'personal-preferences', principalId: authority.caller.principal.id, outcome: 'ok',
    detail: { surface: authority.surface, locale: values.locale, noticePosition: values.noticePosition, notifications: values.notifications, onboardingDismissed: next.onboardingDismissed } })
  return json(viewOf(stored, next, locales, await inherited(ports.store.rootDir, owner)))
}
