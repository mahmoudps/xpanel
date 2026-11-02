import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, isUuid, parseMailboxMetadataAuthority } from '@xpanel/core'
import type { MailboxMetadataAuthority, Principal } from '@xpanel/core'
import { atomicWriteJson } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { isMailboxPrincipalUsername } from './entry-points.ts'
import { mailboxPrincipalUsername } from './mail/inbox.ts'

export type UiPreferenceSurface = 'xpanel' | 'xwhm' | 'xmail'
export type UiPreferenceOwner =
  | Readonly<{ kind: 'principal'; principalKind: Principal['kind']; principalId: string }>
  | Readonly<{ kind: 'team'; ownerPrincipalId: string; accountId: string; memberId: string }>
  | Readonly<{ kind: 'mailbox'; accountId: string; serviceUserId: string; mailbox: string }>

/** Created only after ordinary request authentication and current sealed-mailbox binding. */
export interface UiPreferenceAuthority {
  readonly caller: AuthenticatedCaller
  readonly surface: UiPreferenceSurface
  readonly mailbox?: MailboxMetadataAuthority & Readonly<{ sessionId: string }>
}

export interface UiPreferenceConfiguration {
  readonly choices: readonly string[]
  readonly defaultUiTheme: string
}
export interface UiPreferencesPorts extends UiPreferenceConfiguration, Pick<ExtendedRouteHelpers, 'emitAudit'> {
  /** Revalidate HTTPS, CSRF, Origin, account/session authority and optional MFA on every invocation. */
  readonly open: (request: Request) => Promise<UiPreferenceAuthority>
  readonly store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  readonly now?: () => Date
}
export interface UiPreferencesRecord {
  readonly schema: 1
  readonly surface: UiPreferenceSurface
  readonly owner: UiPreferenceOwner
  readonly uiTheme: string
  readonly updatedAt: string
}
export interface UiPreferencesView {
  readonly state: 'default' | 'saved' | 'invalid'
  readonly uiTheme: string | null
  readonly choices: readonly string[]
  readonly revision: string
  readonly updatedAt: string | null
  readonly application: 'next_navigation'
}

const ROUTE = '/api/auth/ui-preferences'
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const denied = (message: string): never => fail('FORBIDDEN', message, unchanged)
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const json = (body: unknown): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
})
const identifier = (value: unknown): string => isUuid(value) ? value.toLowerCase() : denied('personal preferences require a current authenticated identity')
const configuration = (value: UiPreferenceConfiguration): UiPreferenceConfiguration => {
  const choices = [...value.choices]
  if (!choices.length || choices.length > 32 || choices.some(choice => typeof choice !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(choice))
    || new Set(choices).size !== choices.length || !choices.includes(value.defaultUiTheme)) {
    return fail('SERVICE_UNAVAILABLE', 'registered UI themes are unavailable', unchanged)
  }
  return { choices, defaultUiTheme: value.defaultUiTheme }
}

/** Derives storage authority from authenticated facts, never from a request selector. */
export function uiPreferenceOwner(authority: UiPreferenceAuthority): UiPreferenceOwner {
  const { caller, surface } = authority
  if (!caller || caller.apiTokenId !== null || typeof caller.sessionId !== 'string' || !caller.sessionId) return denied('personal preferences require an interactive session')
  const principal = caller.principal
  const principalId = identifier(principal.id)
  if (surface === 'xmail') {
    const mailbox = parseMailboxMetadataAuthority(authority.mailbox && {
      accountId: authority.mailbox.accountId, serviceUserId: authority.mailbox.serviceUserId, mailbox: authority.mailbox.mailbox,
    })
    if (principal.kind !== 'user' || caller.team || !mailbox || authority.mailbox?.sessionId !== caller.sessionId
      || identifier(principal.accountId) !== mailbox.accountId
      || ![mailboxPrincipalUsername(mailbox.mailbox), mailbox.mailbox].includes(principal.username.toLowerCase())) {
      return denied('personal mailbox preferences require the current sealed mailbox session')
    }
    return { kind: 'mailbox', ...mailbox }
  }
  if (authority.mailbox || !['xpanel', 'xwhm'].includes(surface)
    || surface === 'xwhm' && !['root', 'reseller'].includes(principal.kind)
    || surface === 'xpanel' && principal.kind !== 'user' || isMailboxPrincipalUsername(principal.username)) return denied('personal preference audience is unavailable')
  if (caller.team) {
    if (surface !== 'xpanel' || principal.kind !== 'user' || caller.team.kind !== 'team'
      || identifier(principal.accountId) !== identifier(caller.team.accountId)) return denied('team preference authority is unavailable')
    return { kind: 'team', ownerPrincipalId: principalId, accountId: identifier(caller.team.accountId), memberId: identifier(caller.team.id) }
  }
  return { kind: 'principal', principalKind: principal.kind, principalId }
}

function binding(authority: UiPreferenceAuthority, write: boolean) {
  const owner = uiPreferenceOwner(authority)
  if (write && authority.caller.impersonator) return denied('a handed-off session cannot change permanent personal preferences')
  const caller = authority.caller
  return { owner, surface: authority.surface, session: {
    sessionId: caller.sessionId,
    principal: { kind: caller.principal.kind, id: caller.principal.id, username: caller.principal.username,
      accountId: caller.principal.kind === 'user' ? caller.principal.accountId : null },
    team: caller.team ? { id: caller.team.id, accountId: caller.team.accountId, username: caller.team.username,
      login: caller.team.login, roles: [...caller.team.roles].sort() } : null,
    impersonator: caller.impersonator ? { principalId: caller.impersonator.principalId, login: caller.impersonator.login } : null,
  } }
}

const sameOwner = (left: UiPreferenceOwner, right: unknown): boolean => object(right)
  && keys(right) === Object.keys(left).sort().join() && Object.entries(left).every(([name, value]) => right[name] === value)
const preferencePath = (rootDir: string, surface: UiPreferenceSurface, owner: UiPreferenceOwner): string =>
  join(rootDir, 'extended', 'ui-preferences', surface, owner.kind, hash(owner) + '.json')

export function readSavedUiPreferences(raw: unknown, authority: UiPreferenceAuthority, config: UiPreferenceConfiguration): UiPreferencesRecord | null {
  const owner = uiPreferenceOwner(authority)
  if (!object(raw) || keys(raw) !== 'owner,schema,surface,uiTheme,updatedAt' || raw.schema !== 1 || raw.surface !== authority.surface
    || !sameOwner(owner, raw.owner) || typeof raw.uiTheme !== 'string' || !config.choices.includes(raw.uiTheme)
    || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt)) || new Date(raw.updatedAt).toISOString() !== raw.updatedAt) return null
  return { schema: 1, surface: authority.surface, owner, uiTheme: raw.uiTheme, updatedAt: raw.updatedAt }
}

export const uiPreferencesRevision = (raw: unknown, authority: UiPreferenceAuthority): string =>
  hash({ namespace: 'personal-ui-preferences:v1', surface: authority.surface, owner: uiPreferenceOwner(authority),
    value: raw === undefined ? { exists: false } : { exists: true, record: raw } })

function viewOf(raw: unknown, authority: UiPreferenceAuthority, config: UiPreferenceConfiguration): UiPreferencesView {
  const saved = readSavedUiPreferences(raw, authority, config)
  return { state: raw === undefined ? 'default' : saved ? 'saved' : 'invalid',
    uiTheme: raw === undefined ? config.defaultUiTheme : saved?.uiTheme ?? null, choices: [...config.choices],
    revision: uiPreferencesRevision(raw, authority), updatedAt: saved?.updatedAt ?? null, application: 'next_navigation' }
}

/** Called after trusted session/listener validation; malformed records never become a saved choice. */
export async function readUiPreferenceValue(rootDir: string, authority: UiPreferenceAuthority, options: UiPreferenceConfiguration): Promise<string | null> {
  const config = configuration(options), owner = uiPreferenceOwner(authority)
  try { return readSavedUiPreferences(await readSaved(preferencePath(rootDir, authority.surface, owner)), authority, config)?.uiTheme ?? null }
  catch { return null }
}

export function parseUiPreferencesUpdate(value: unknown, choices: readonly string[]): { uiTheme: string; expectedRevision: string } {
  if (!object(value) || keys(value) !== 'expectedRevision,uiTheme') return invalid('exactly uiTheme and expectedRevision are required')
  if (typeof value.uiTheme !== 'string' || !choices.includes(value.uiTheme)) return invalid('uiTheme must be a registered UI theme')
  if (typeof value.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedRevision)) return invalid('the observed UI preferences revision is required')
  return { uiTheme: value.uiTheme, expectedRevision: value.expectedRevision }
}

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !request.body) return invalid('a JSON body is required')
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    bytes += next.value.byteLength
    if (bytes > 4096) { await reader.cancel(); return invalid('the request body is too large') }
    chunks.push(next.value)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return invalid('request body is not valid JSON') }
}

async function readSaved(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return fail('PRECONDITION_FAILED', 'saved UI preferences cannot be read; review them before retrying', unchanged)
  }
}

/** Self-only appearance metadata. Authentication policy and mailbox credentials remain in their existing authorities. */
export async function handleUiPreferencesRoute(request: Request, url: URL, method: string, ports: UiPreferencesPorts): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT', 'cache-control': 'no-store' } })
  if (url.search) return invalid('UI preferences accept no query selectors')
  const config = configuration(ports), authority = await ports.open(request)
  const currentBinding = binding(authority, method === 'PUT'), identity = hash(currentBinding)
  const path = preferencePath(ports.store.rootDir, authority.surface, currentBinding.owner)
  const fresh = async (): Promise<void> => {
    if (hash(binding(await ports.open(request), method === 'PUT')) !== identity) return denied('personal preference authority changed; sign in again')
  }
  if (method === 'GET') {
    const raw = await readSaved(path)
    await fresh()
    return json(viewOf(raw, authority, config))
  }
  const input = parseUiPreferencesUpdate(await readBody(request), config.choices)
  const lease = await ports.store.getWriterLock().acquire()
  let attempted = false, result: UiPreferencesView
  try {
    await fresh()
    const raw = await readSaved(path)
    if (raw !== undefined && !readSavedUiPreferences(raw, authority, config)) return fail('PRECONDITION_FAILED', 'saved UI preferences require review before they can be changed', unchanged)
    if (uiPreferencesRevision(raw, authority) !== input.expectedRevision) return fail('CONFLICT', 'UI preferences changed; reload before saving', unchanged)
    const next: UiPreferencesRecord = { schema: 1, surface: authority.surface, owner: currentBinding.owner,
      uiTheme: input.uiTheme, updatedAt: (ports.now ?? (() => new Date()))().toISOString() }
    await fresh()
    await lease.assertFencingToken()
    attempted = true
    await atomicWriteJson(path, next, 0o640, async () => { await fresh(); await lease.assertFencingToken() })
    const saved = await readSaved(path)
    if (JSON.stringify(saved) !== JSON.stringify(next) || !readSavedUiPreferences(saved, authority, config)) throw new Error('ui_preferences_readback_failed')
    await fresh()
    result = viewOf(saved, authority, config)
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the UI preference save could not be verified; review it before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally {
    try { await lease.release() }
    catch {
      return fail('SERVICE_UNAVAILABLE', 'the UI preference writer lease requires review before retrying', attempted
        ? { stateChanged: true, verificationRequired: true, unknownOutcome: true } : unchanged)
    }
  }
  try {
    await ports.emitAudit({ actor: authority.caller.team?.username ?? authority.caller.principal.username, action: 'auth.ui-preferences.updated', target: 'personal-ui-preferences',
      principalId: authority.caller.principal.id, outcome: 'ok', detail: { uiTheme: input.uiTheme, surface: authority.surface, ownerKind: currentBinding.owner.kind } })
    await fresh()
  } catch { return fail('SERVICE_UNAVAILABLE', 'UI preferences were saved but their authority or audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
  return json(result!)
}
