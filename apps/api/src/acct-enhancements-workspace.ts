import { fail } from '@xpanel/core'
import { sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export const ENHANCEMENT_LIMITS = { definitions: 50, label: 80, value: 1_000_000_000, targets: 5000 } as const
export interface EnhancementDefinition { id: string; label: string; kind: 'flag' | 'limit'; min: number | null; max: number | null }
export type EnhancementValues = Record<string, true | number>
/** Saved document. Plan values apply to every account on the plan; account values override them. Reseller limits cap direct account assignments; null is unlimited and a missing entry is unlimited. */
export interface EnhancementsDocument {
  definitions: EnhancementDefinition[]
  planAssignments: Record<string, EnhancementValues>
  accountAssignments: Record<string, EnhancementValues>
  resellerLimits: Record<string, Record<string, number | null>>
}
export interface EnhancementsDirectory { plans: { id: string; name: string }[]; accounts: { id: string; username: string; planId: string; ownerId: string | null }[]; resellers: { id: string; username: string }[] }
export interface EnhancementsHelpers extends Pick<ExtendedRouteHelpers, 'store' | 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** ext.readOrDefault('plans/enhancements.json', null) */
  readSaved: () => Promise<unknown>
  /** ext.write('plans/enhancements.json', value) */
  writeSaved: (value: unknown) => Promise<unknown>
}

const ROUTE = '/api/server/account-enhancements'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ID = /^[a-z][a-z0-9-]{0,47}$/
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u
const DOCUMENT_KEYS = 'accountAssignments,definitions,planAssignments,resellerLimits'
const MAX_BODY_BYTES = 512 * 1024
const invalid = (message: string, detail: Record<string, unknown> = {}): never => fail('VALIDATION', message, { stateChanged: false, ...detail })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const revisionOf = (raw: unknown): string => sha256Hex(JSON.stringify(raw ?? null))
const count = (value: unknown, what: string, min = 0): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= ENHANCEMENT_LIMITS.value ? value : invalid(`${what} must be a whole number from ${min} to ${ENHANCEMENT_LIMITS.value}`)
export const EMPTY_ENHANCEMENTS: EnhancementsDocument = { definitions: [], planAssignments: {}, accountAssignments: {}, resellerLimits: {} }

const definitionOf = (raw: unknown): EnhancementDefinition => {
  if (!object(raw) || keys(raw) !== 'id,kind,label,max,min') return invalid('each enhancement needs exactly id, label, kind, min and max')
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) return invalid('an enhancement id is 1 to 48 lowercase letters, digits or hyphens and starts with a letter')
  if (typeof raw.label !== 'string' || !raw.label.isWellFormed() || raw.label !== raw.label.trim() || !raw.label || [...raw.label].length > ENHANCEMENT_LIMITS.label || FORBIDDEN.test(raw.label)) return invalid(`an enhancement label is 1 to ${ENHANCEMENT_LIMITS.label} characters of plain text`)
  if (raw.kind === 'flag') return raw.min === null && raw.max === null ? { id: raw.id, label: raw.label, kind: 'flag', min: null, max: null } : invalid('a flag enhancement has no minimum or maximum')
  if (raw.kind !== 'limit') return invalid('an enhancement kind is flag or limit')
  const min = count(raw.min, 'the minimum'), max = count(raw.max, 'the maximum')
  return min <= max ? { id: raw.id, label: raw.label, kind: 'limit', min, max } : invalid('the minimum must not exceed the maximum')
}
const valuesOf = (raw: unknown, definitions: ReadonlyMap<string, EnhancementDefinition>, where: string): EnhancementValues => {
  if (!object(raw) || !Object.keys(raw).length) return invalid(`${where} must list at least one enhancement value`)
  const out: EnhancementValues = {}
  for (const id of Object.keys(raw).sort()) {
    const definition = definitions.get(id), value = raw[id]
    if (!definition) return invalid(`${where} uses an undefined enhancement`, { enhancement: id.slice(0, 48) })
    if (definition.kind === 'flag') { if (value !== true) return invalid(`${where}: a flag is assigned as true`); out[id] = true; continue }
    const amount = count(value, `${where} ${id}`)
    if (amount < definition.min! || amount > definition.max!) return invalid(`${where}: ${id} must be between ${definition.min} and ${definition.max}`)
    out[id] = amount
  }
  return out
}
const targetsOf = <T>(raw: unknown, what: string, read: (value: unknown, target: string) => T): Record<string, T> => {
  if (!object(raw) || Object.keys(raw).length > ENHANCEMENT_LIMITS.targets) return invalid(`${what} must be a bounded object keyed by identity`)
  const out: Record<string, T> = {}
  for (const target of Object.keys(raw).sort()) out[UUID.test(target) ? target : invalid(`${what} must be keyed by identity`)] = read(raw[target], target)
  return out
}
/** Strict document grammar (shape, bounds, references to defined enhancements). Directory references are checked separately. */
export function parseEnhancementsDocument(raw: unknown): EnhancementsDocument {
  if (!object(raw) || keys(raw) !== DOCUMENT_KEYS) return invalid('exactly definitions, planAssignments, accountAssignments and resellerLimits are required')
  if (!Array.isArray(raw.definitions) || raw.definitions.length > ENHANCEMENT_LIMITS.definitions) return invalid(`at most ${ENHANCEMENT_LIMITS.definitions} enhancements can be defined`)
  const definitions = raw.definitions.map(definitionOf), byId = new Map(definitions.map(definition => [definition.id, definition]))
  if (byId.size !== definitions.length) return invalid('enhancement ids must be unique')
  return {
    definitions, planAssignments: targetsOf(raw.planAssignments, 'plan assignments', value => valuesOf(value, byId, 'a plan assignment')),
    accountAssignments: targetsOf(raw.accountAssignments, 'account assignments', value => valuesOf(value, byId, 'an account assignment')),
    resellerLimits: targetsOf(raw.resellerLimits, 'reseller limits', value => {
      if (!object(value) || !Object.keys(value).length) return invalid('a reseller limit lists at least one enhancement')
      const out: Record<string, number | null> = {}
      for (const id of Object.keys(value).sort()) out[byId.has(id) ? id : invalid('a reseller limit uses an undefined enhancement')] = value[id] === null ? null : count(value[id], 'a reseller limit')
      return out
    }),
  }
}

/** Effective values for one account: its plan's assignments overlaid by the account's own. */
export function effectiveEnhancements(document: EnhancementsDocument, plan: { id: string }, account: { id: string; planId: string }): EnhancementValues {
  if (account.planId !== plan.id) return fail('VALIDATION', 'the plan does not belong to the account', { stateChanged: false })
  const defined = new Set(document.definitions.map(definition => definition.id))
  return Object.fromEntries(Object.entries({ ...document.planAssignments[plan.id], ...document.accountAssignments[account.id] }).filter(([id]) => defined.has(id)))
}
/** Direct assignments a reseller's accounts hold per enhancement. */
export const resellerUsage = (document: EnhancementsDocument, accounts: EnhancementsDirectory['accounts'], resellerId: string): Record<string, number> => {
  const usage: Record<string, number> = {}
  for (const account of accounts) if (account.ownerId === resellerId) for (const id of Object.keys(document.accountAssignments[account.id] ?? {})) usage[id] = (usage[id] ?? 0) + 1
  return usage
}
/** Directory references and reseller caps; 0 means the reseller's accounts may not hold the enhancement. */
export function assertEnhancementsAgainstDirectory(document: EnhancementsDocument, directory: EnhancementsDirectory): void {
  const plans = new Set(directory.plans.map(plan => plan.id)), accounts = new Set(directory.accounts.map(account => account.id)), resellers = new Set(directory.resellers.map(reseller => reseller.id))
  const missing = [...Object.keys(document.planAssignments).filter(id => !plans.has(id)), ...Object.keys(document.accountAssignments).filter(id => !accounts.has(id)), ...Object.keys(document.resellerLimits).filter(id => !resellers.has(id))]
  if (missing.length) invalid('assignments name plans, accounts or resellers that no longer exist', { missing: missing.slice(0, 10) })
  for (const [resellerId, limits] of Object.entries(document.resellerLimits)) {
    const usage = resellerUsage(document, directory.accounts, resellerId)
    for (const [id, limit] of Object.entries(limits)) if (limit !== null && (usage[id] ?? 0) > limit) fail('LIMIT_EXCEEDED', `the reseller's accounts hold ${id} ${usage[id]} times; its limit is ${limit}`, { stateChanged: false, enhancement: id, limit })
  }
}
/** Strict saved-file reader: null is "nothing saved"; anything else unreadable returns null. */
export function readSavedEnhancements(raw: unknown): EnhancementsDocument | null {
  if (raw === null) return EMPTY_ENHANCEMENTS
  try { const document = parseEnhancementsDocument(raw); return JSON.stringify(document) === JSON.stringify(raw) ? document : null } catch { return null }
}

const directoryOf = async (helpers: EnhancementsHelpers): Promise<EnhancementsDirectory> => {
  const snapshot = await helpers.store.readSnapshot()
  return { plans: snapshot.plans.map(plan => ({ id: plan.id, name: plan.name })), accounts: snapshot.accounts.map(account => ({ id: account.id, username: account.username, planId: account.planId, ownerId: account.ownerId })), resellers: snapshot.resellers.map(reseller => ({ id: reseller.id, username: reseller.username })) }
}
const view = (raw: unknown, directory: EnhancementsDirectory) => {
  const document = readSavedEnhancements(raw)
  return {
    state: raw === null ? 'default' : document ? 'saved' : 'invalid', revision: revisionOf(raw), document: document ?? EMPTY_ENHANCEMENTS, directory,
    // Saved entitlements; no xPanel feature reads them yet and resellers cannot assign them from their own screens.
    application: { enforced: false, resellerAssignment: false },
  }
}
const readJson = async (request: Request): Promise<unknown> => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return invalid('the request body is too large')
  try { return JSON.parse(text) } catch { return invalid('request body is not valid JSON') }
}
const sameAuthority = (a: AuthenticatedCaller, b: AuthenticatedCaller): boolean => a.principal.id === b.principal.id && a.sessionId === b.sessionId && a.apiTokenId === b.apiTokenId

// shortcut: in-process serialization only; one API process owns these extended state files.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task, task); queue = run.catch(() => undefined); return run }

/** Root account enhancements: GET reads, PUT replaces the whole document under the observed revision. */
export async function handleAccountEnhancementsRoute(request: Request, url: URL, method: string, helpers: EnhancementsHelpers): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, method === 'GET' ? 'account-enhancements.read' : 'account-enhancements.update')
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  if (url.search) return invalid('account enhancements do not accept selectors')
  if (method === 'GET') return json(200, view(await helpers.readSaved(), await directoryOf(helpers)))
  const body = await readJson(request)
  if (!object(body) || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return invalid('the observed enhancements revision is required')
  const { expectedRevision, ...rest } = body
  const document = parseEnhancementsDocument(rest)
  return serial(async () => {
    const raw = await helpers.readSaved()
    if (revisionOf(raw) !== expectedRevision) return fail('CONFLICT', 'enhancements changed since they were read; reload before saving', { stateChanged: false })
    if (raw !== null && !readSavedEnhancements(raw)) return fail('PRECONDITION_FAILED', 'the saved enhancements file requires review before it can be changed', { stateChanged: false })
    const directory = await directoryOf(helpers)
    assertEnhancementsAgainstDirectory(document, directory)
    const actor = await helpers.requireCaller(request)
    await helpers.assertRoot(actor, 'account-enhancements.update')
    if (!sameAuthority(actor, caller)) return fail('FORBIDDEN', 'enhancement authority changed', { stateChanged: false })
    try { await helpers.writeSaved(document) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the enhancements write requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
    const saved = await helpers.readSaved()
    if (revisionOf(saved) !== revisionOf(document) || !readSavedEnhancements(saved)) return fail('SERVICE_UNAVAILABLE', 'the saved enhancements could not be verified', { stateChanged: true, verificationRequired: true })
    try { await helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: 'server.account-enhancements.updated', target: 'account-enhancements', detail: { definitions: document.definitions.length, plans: Object.keys(document.planAssignments).length, accounts: Object.keys(document.accountAssignments).length, resellers: Object.keys(document.resellerLimits).length }, outcome: 'ok' }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the enhancements are saved but their audit record requires review', { stateChanged: true, verificationRequired: true }) }
    return json(200, view(saved, directory))
  })
}
