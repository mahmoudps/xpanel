import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import { atomicRemove, atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { MAILX_DEFAULTS, MAILX_SECTIONS, mailxCompositeRevision, mailxStatePath, readMailxStored, renderMailxDovecot, renderMailxPostfix } from '../../agent/src/mailx-policy.ts'
import type { MailxSaved, MailxSection, MailxStored } from '../../agent/src/mailx-policy.ts'
import { MAILX_MAPS } from '../../../packages/os/src/mailx-command.ts'
import { readMailxSaved } from '../../agent/src/mailx-routes.ts'

/** Exim Configuration Manager, for Postfix: backups of the saved mail policy, restore and reset, each applied by the agent. */
export interface MailxConfigHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: StateStore
  callHost?: (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>
  now?: () => Date
}
type Sections = MailxSaved['sections']
export interface MailxBackup { id: string; createdAt: string; createdBy: string; reason: 'manual' | 'before-restore' | 'before-reset'; fingerprint: string; sections: Sections }
export type MailxResetType = 'advanced' | 'full'

export const MAILX_BACKUPS_MAX = 20
const BASE = '/api/server/mailx-config', MAX_BODY = 1024 * 1024
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const unchanged = { stateChanged: false }
const review = { stateChanged: true, unknownOutcome: true, verificationRequired: true }
const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const emptySections = (): Sections => Object.fromEntries(MAILX_SECTIONS.map(section => [section, null])) as unknown as Sections

/** What the mail policy generates for Postfix and Dovecot; a relay password counts by its version, so the hash reveals nothing about it. */
export function mailxGeneratedFingerprint(sections: Sections): string {
  const saved: MailxSaved = { sections, archives: [] }, plan = renderMailxPostfix(saved)
  return createHash('sha256').update(JSON.stringify({ settings: plan.settings, master: plan.master ?? null, dovecot: renderMailxDovecot(saved)?.content ?? null, relay: sections.relay?.secret?.version ?? null,
    files: plan.files.filter(file => file.path !== MAILX_MAPS.relaySasl).map(file => [file.path, file.content]) })).digest('hex')
}
const managedKeys = (sections: Sections): string[] => Object.keys(renderMailxPostfix({ sections, archives: [] }).settings)
/** Keys the previous configuration set and the next one does not; the agent removes them, so Postfix falls back to its default. */
export const mailxReleasedKeys = (before: Sections, after: Sections): string[] => { const kept = new Set(managedKeys(after)); return managedKeys(before).filter(key => !kept.has(key)) }

const parseSections = (value: unknown): Sections => {
  if (!object(value) || Object.keys(value).some(key => !(MAILX_SECTIONS as readonly string[]).includes(key))) throw new Error('invalid_mailx_backup')
  const sections = emptySections()
  for (const section of MAILX_SECTIONS) if (value[section] !== null && value[section] !== undefined) (sections as Record<string, unknown>)[section] = readMailxStored(section, value[section])
  return sections
}
const parseBackup = (raw: unknown): MailxBackup => {
  if (!object(raw) || typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.createdAt !== 'string' || typeof raw.createdBy !== 'string' || !['manual', 'before-restore', 'before-reset'].includes(String(raw.reason)) || typeof raw.fingerprint !== 'string') throw new Error('invalid_mailx_backup')
  return { id: raw.id, createdAt: raw.createdAt, createdBy: raw.createdBy, reason: raw.reason as MailxBackup['reason'], fingerprint: raw.fingerprint, sections: parseSections(raw.sections) }
}
/** A download never carries the relay password; only the root-only copy on the server does. */
const publicBackup = (backup: MailxBackup): unknown => ({ ...backup, sections: { ...backup.sections, ...(backup.sections.relay ? { relay: { ...backup.sections.relay, secret: null } } : {}) } })

export function createMailxConfigRoutes(helpers: MailxConfigHelpers) {
  const now = () => (helpers.now ?? (() => new Date()))()
  const dir = (): string => join(helpers.store.rootDir, ...mailxStatePath('backups'))
  const sectionPath = (section: MailxSection): string => join(helpers.store.rootDir, ...mailxStatePath(section + '.json'))
  const list = async (): Promise<MailxBackup[]> => {
    const names = await readdir(dir()).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
    const backups: MailxBackup[] = []
    for (const name of names.filter(item => item.endsWith('.json')).sort().reverse().slice(0, MAILX_BACKUPS_MAX + 4)) try { backups.push(parseBackup(await readJsonIfExists<unknown>(join(dir(), name)))) } catch { /* a damaged copy cannot be restored and stays for inspection */ }
    return backups
  }
  const write = async (sections: Sections, reason: MailxBackup['reason'], caller: AuthenticatedCaller, guard: () => Promise<unknown>): Promise<MailxBackup> => {
    const at = now(), backup: MailxBackup = { id: randomUUID(), createdAt: at.toISOString(), createdBy: caller.principal.username, reason, fingerprint: mailxGeneratedFingerprint(sections), sections }
    await atomicWriteJson(join(dir(), `${at.toISOString().replace(/[:.]/g, '-')}-${backup.id}.json`), backup, 0o600, guard)
    const names = (await readdir(dir())).filter(item => item.endsWith('.json')).sort()
    for (const name of names.slice(0, Math.max(0, names.length - MAILX_BACKUPS_MAX))) await atomicRemove(join(dir(), name), guard)
    return backup
  }
  const authorize = async (req: Request, initial?: AuthenticatedCaller): Promise<AuthenticatedCaller> => {
    const caller = await helpers.requireCaller(req)
    await helpers.assertRoot(caller, 'server.mail-policy.config')
    if (initial && (initial.principal.id !== caller.principal.id || initial.sessionId !== caller.sessionId)) return fail('FORBIDDEN', 'mail policy authority changed', unchanged)
    return caller
  }
  const body = async (req: Request, keys: readonly string[]): Promise<Record<string, unknown>> => {
    if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
    const text = await req.text()
    if (text.length > MAX_BODY) return fail('VALIDATION', 'mail configuration request exceeds its bound', unchanged)
    let raw: unknown
    try { raw = JSON.parse(text) } catch { return fail('VALIDATION', 'valid JSON is required', unchanged) }
    if (!object(raw) || Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw as object, key))) return fail('VALIDATION', 'mail configuration request requires only supported fields', unchanged)
    return raw
  }
  /** Saves `next` under the writer lock after a backup of the current policy, then asks the agent to apply it. */
  const replace = async (req: Request, initial: AuthenticatedCaller, expectedRevision: unknown, reason: 'before-restore' | 'before-reset', next: (current: Sections) => Sections, action: string, detail: Record<string, unknown>): Promise<Response> => {
    if (typeof expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(expectedRevision)) return fail('VALIDATION', 'expectedRevision must be the captured revision', unchanged)
    const lease = await helpers.store.getWriterLock().acquire()
    let wrote = false, before: Sections, after: Sections, safety: MailxBackup
    try {
      const saved = await readMailxSaved(helpers.store.rootDir)
      if (mailxCompositeRevision(saved) !== expectedRevision) return fail('CONFLICT', 'saved mail policy changed; reload before continuing', unchanged)
      before = saved.sections; after = next(before)
      const guard = () => lease.assertFencingToken()
      await authorize(req, initial); await guard()
      safety = await write(before, reason, initial, guard)
      wrote = true
      for (const section of MAILX_SECTIONS) {
        if (after[section]) await atomicWriteJson(sectionPath(section), after[section], section === 'relay' ? 0o600 : 0o640, guard)
        else if (before[section]) await atomicRemove(sectionPath(section), guard)
      }
    } catch (error) {
      if (wrote) return fail('SERVICE_UNAVAILABLE', 'mail policy save outcome requires inspection', review)
      if (isXpanelError(error)) throw error
      return fail('PRECONDITION_FAILED', 'saved mail policy requires review', { ...unchanged, reason: 'saved_policy_review' })
    } finally { await lease.release() }
    const caller = await authorize(req, initial)
    let application: Record<string, unknown> = { outcome: 'not-connected', verificationRequired: false }
    if (helpers.callHost) {
      const released = mailxReleasedKeys(before, after), revision = mailxCompositeRevision(await readMailxSaved(helpers.store.rootDir))
      try { application = await helpers.callHost(caller, '/host/mailx/apply', { revision, ...(released.length ? { unset: released } : {}) }) as Record<string, unknown> }
      catch (error) { application = isXpanelError(error) && error.detail?.stateChanged === false ? { outcome: 'refused', verificationRequired: false, reason: error.detail.reason } : { outcome: 'unknown', verificationRequired: true } }
    }
    const outcome = String(application.outcome)
    try { await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action, target: 'server:mail-policy', outcome: outcome === 'unknown' ? 'failed' : 'ok', detail: { ...detail, safetyBackup: safety.id, outcome } }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'saved mail policy requires audit review', review) }
    return json({ application: { outcome, verificationRequired: application.verificationRequired === true, ...(typeof application.reason === 'string' ? { reason: application.reason } : {}) }, safetyBackup: safety.id, compositeRevision: mailxCompositeRevision(await readMailxSaved(helpers.store.rootDir)), fingerprint: mailxGeneratedFingerprint(after) })
  }
  const defaults = (current: Sections, type: MailxResetType): Sections => {
    if (type === 'advanced') return { ...current, advanced: null }
    const reset = emptySections(), stamp = now().toISOString()
    // A saved section is rewritten with defaults rather than removed, because a removed section is no longer managed and its files and certificate would stay.
    for (const section of MAILX_SECTIONS) if (current[section]) (reset as Record<string, unknown>)[section] = { section, policy: MAILX_DEFAULTS[section], ...(section === 'relay' ? { secret: null } : {}), updatedAt: stamp, updatedBy: 'reset' } satisfies Partial<MailxStored>
    return reset
  }

  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    const path = url.pathname
    if (path !== BASE + '/backups' && path !== BASE + '/restore' && path !== BASE + '/reset' && !path.startsWith(BASE + '/backups/')) return null
    const caller = await authorize(req)
    if (url.search) return fail('VALIDATION', 'mail configuration routes accept no selectors', unchanged)
    if (path === BASE + '/backups') {
      if (method === 'GET') {
        const items = await list()
        await authorize(req, caller)
        return json({ backups: items.map(({ sections: _sections, ...item }) => item), compositeRevision: mailxCompositeRevision(await readMailxSaved(helpers.store.rootDir)), fingerprint: mailxGeneratedFingerprint((await readMailxSaved(helpers.store.rootDir)).sections), limit: MAILX_BACKUPS_MAX })
      }
      if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
      const lease = await helpers.store.getWriterLock().acquire()
      try {
        await authorize(req, caller)
        const backup = await write((await readMailxSaved(helpers.store.rootDir)).sections, 'manual', caller, () => lease.assertFencingToken())
        await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.mail_policy.backup_created', target: 'server:mail-policy', outcome: 'ok', detail: { backup: backup.id } })
        const { sections: _sections, ...item } = backup
        return json({ backup: item }, 201)
      } finally { await lease.release() }
    }
    if (path.startsWith(BASE + '/backups/')) {
      if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
      const backup = (await list()).find(item => item.id === path.slice(BASE.length + '/backups/'.length))
      await authorize(req, caller)
      return backup ? json(publicBackup(backup)) : fail('NOT_FOUND', 'backup not found', unchanged)
    }
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    if (path === BASE + '/reset') {
      const input = await body(req, ['type', 'expectedRevision'])
      if (input.type !== 'advanced' && input.type !== 'full') return fail('VALIDATION', 'reset type must be advanced or full', unchanged)
      const type = input.type
      return replace(req, caller, input.expectedRevision, 'before-reset', current => defaults(current, type), 'server.mail_policy.reset', { type })
    }
    const input = await body(req, ['backup', 'expectedRevision'])
    let sections: Sections
    if (typeof input.backup === 'string') {
      const stored = (await list()).find(item => item.id === input.backup)
      if (!stored) return fail('NOT_FOUND', 'backup not found', unchanged)
      sections = stored.sections
    } else {
      // An uploaded copy has no relay password: it can only keep the saved one for the same username.
      if (!object(input.backup)) return fail('VALIDATION', 'a stored backup id or an uploaded backup is required', unchanged)
      const uploaded = input.backup.sections, relay = object(uploaded) && object(uploaded.relay) ? uploaded.relay : null, current = (await readMailxSaved(helpers.store.rootDir)).sections.relay
      const username = object(relay?.policy) ? relay!.policy.username : null
      if (relay && username !== null) {
        const secret = current && current.policy.username === username ? current.secret : null
        if (!secret) return fail('PRECONDITION_FAILED', 'the uploaded backup names a relay user whose password is not saved here, so nothing was changed', { ...unchanged, reason: 'relay_password_required' })
        relay.secret = secret
      }
      try { sections = parseSections(uploaded) } catch { return fail('VALIDATION', 'the uploaded file is not a valid mail configuration backup', unchanged) }
    }
    return replace(req, caller, input.expectedRevision, 'before-restore', () => sections, 'server.mail_policy.restored', { source: typeof input.backup === 'string' ? 'stored' : 'upload' })
  }
}
