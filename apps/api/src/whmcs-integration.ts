import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cidrContains, fail, isUuid, isXpanelError, parseCidr, parseIp, validateDomainName, validateUsername } from '@xpanel/core'
import type { ErrorCode } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { renderWhmcsModule, WHMCS_MODULE_FILENAME, WHMCS_PROVISION_PATH } from './whmcs-module.ts'

export const WHMCS_ACTIONS = ['test', 'create', 'suspend', 'unsuspend', 'terminate', 'change_package'] as const
export type WhmcsAction = typeof WHMCS_ACTIONS[number]
export type WhmcsSsoTarget = 'xpanel' | 'xwhm' | 'xmail'
export interface WhmcsPlanMapping { package: string; planId: string }
export interface WhmcsSettings {
  enabled: boolean; whmcsUrl: string; allowedAddresses: string[]; ssoTarget: WhmcsSsoTarget; autoCreate: boolean; planMap: WhmcsPlanMapping[]
}
/** Only the token hash is kept; `issuedBy` is the root principal every WHMCS call then acts as. */
export interface WhmcsTokenRecord { sha256: string; hint: string; createdAt: string; issuedBy: string }
export interface WhmcsRecord extends WhmcsSettings { version: 1; apiIdentifier: string; token: WhmcsTokenRecord | null; updatedAt: string }
export interface WhmcsView {
  state: 'default' | 'saved' | 'invalid'
  settings: WhmcsSettings | null
  apiIdentifier: string | null
  token: { hint: string; createdAt: string } | null
  updatedAt: string | null
  revision: string
  plans: { id: string; name: string; accounts: number }[]
}
export interface WhmcsActivityEntry {
  at: string; action: WhmcsAction | null; username: string | null; result: 'ok' | 'refused' | 'failed'; reason: string; ip: string | null
}
/** Each port runs the same validation, audit and reconcile as the matching HTTP account route, as root principal `actor`. */
export interface WhmcsProvisionPorts {
  createAccount(input: { actor: string; username: string; primaryDomain: string; planId: string; password: string; contactEmail: string | null }): Promise<void>
  suspendAccount(input: { actor: string; username: string; reason: string }): Promise<void>
  unsuspendAccount(input: { actor: string; username: string }): Promise<void>
  terminateAccount(input: { actor: string; username: string }): Promise<void>
  changePlan(input: { actor: string; username: string; planId: string }): Promise<void>
}
export interface WhmcsRouteHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock' | 'listPlans' | 'listAccounts' | 'getAccountByUsername'>
  /** Socket or trusted-ingress client address, resolved the same way as for sign-in. */
  clientIp: (request: Request) => string | null
  ports: WhmcsProvisionPorts
  now?: () => Date
}

const ROUTE = '/api/server/panel/whmcs'
export const DEFAULT_WHMCS_SETTINGS: Readonly<WhmcsSettings> = Object.freeze({ enabled: false, whmcsUrl: '', allowedAddresses: [], ssoTarget: 'xpanel', autoCreate: false, planMap: [] })
export const WHMCS_ACTIVITY_KEEP = 500
const ACTIVITY_ROTATE_BYTES = 256 * 1024
const ACTIVITY_READ = 100
const RECORD_KEYS = 'allowedAddresses,apiIdentifier,autoCreate,enabled,planMap,ssoTarget,token,updatedAt,version,whmcsUrl'
const UPDATE_KEYS = 'allowedAddresses,autoCreate,enabled,expectedRevision,planMap,ssoTarget,whmcsUrl'
const TOKEN_RE = /^xpw_[A-Za-z0-9_-]{43}$/
const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const configPath = (rootDir: string): string => join(rootDir, 'extended', 'integrations', 'whmcs.json')
const activityPath = (rootDir: string): string => join(rootDir, 'extended', 'integrations', 'whmcs-activity.jsonl')
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const printable = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value)

const packageName = (value: unknown): string => {
  if (!printable(value, 64) || !value.trim() || value !== value.trim()) return invalid('each WHMCS package name must be 1 to 64 printable characters without surrounding spaces')
  return value
}
const whmcsUrl = (value: unknown): string => {
  if (value === '') return ''
  if (!printable(value, 512) || /\s/.test(value)) return invalid('the WHMCS URL must be an https:// address')
  let parsed: URL
  try { parsed = new URL(value) } catch { return invalid('the WHMCS URL must be an https:// address') }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return invalid('the WHMCS URL must be an https:// address without credentials')
  return value
}
const addresses = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 32) return invalid('allowed addresses must be a list of up to 32 entries')
  const seen = new Set<string>()
  return value.map(entry => {
    if (typeof entry !== 'string' || !parseCidr(entry)) return invalid('each allowed address must be an IPv4 or IPv6 address or a CIDR range with zero host bits')
    if (seen.has(entry.toLowerCase())) return invalid('allowed addresses must not repeat')
    seen.add(entry.toLowerCase())
    return entry
  })
}
const planMap = (value: unknown): WhmcsPlanMapping[] => {
  if (!Array.isArray(value) || value.length > 64) return invalid('the plan mapping must be a list of up to 64 rows')
  const seen = new Set<string>()
  return value.map(row => {
    if (!object(row) || keys(row) !== 'package,planId') return invalid('each plan mapping row needs exactly package and planId')
    const name = packageName(row.package)
    if (!printable(row.planId, 128) || !row.planId) return invalid('each plan mapping row needs an xPanel plan')
    if (seen.has(name.toLowerCase())) return invalid('each WHMCS package can be mapped once')
    seen.add(name.toLowerCase())
    return { package: name, planId: row.planId }
  })
}
const settingsOf = (value: Record<string, unknown>): WhmcsSettings => {
  if (typeof value.enabled !== 'boolean' || typeof value.autoCreate !== 'boolean') return invalid('enabled and autoCreate must be true or false')
  if (value.ssoTarget !== 'xpanel' && value.ssoTarget !== 'xwhm' && value.ssoTarget !== 'xmail') return invalid('ssoTarget must be xpanel, xwhm or xmail')
  const settings: WhmcsSettings = { enabled: value.enabled, whmcsUrl: whmcsUrl(value.whmcsUrl), allowedAddresses: addresses(value.allowedAddresses), ssoTarget: value.ssoTarget, autoCreate: value.autoCreate, planMap: planMap(value.planMap) }
  if (settings.enabled && (!settings.whmcsUrl || !settings.allowedAddresses.length)) return invalid('an enabled integration needs the WHMCS URL and at least one allowed address')
  return settings
}

export function readSavedWhmcs(raw: unknown): WhmcsRecord | null {
  try {
    if (!object(raw) || keys(raw) !== RECORD_KEYS || raw.version !== 1 || typeof raw.apiIdentifier !== 'string' || !/^whmcs_[0-9a-f]{12}$/.test(raw.apiIdentifier) || !isTime(raw.updatedAt)) return null
    const token = raw.token
    if (token !== null && (!object(token) || keys(token) !== 'createdAt,hint,issuedBy,sha256' || typeof token.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(token.sha256)
      || typeof token.hint !== 'string' || !/^[A-Za-z0-9_-]{4}$/.test(token.hint) || !isTime(token.createdAt) || !isUuid(token.issuedBy))) return null
    return { version: 1, apiIdentifier: raw.apiIdentifier, ...settingsOf(raw), token: token as WhmcsTokenRecord | null, updatedAt: raw.updatedAt }
  } catch { return null }
}
export const whmcsRevision = (raw: unknown): string => createHash('sha256').update(JSON.stringify({ namespace: 'whmcs-integration:v1', value: raw })).digest('hex')

export function parseWhmcsUpdate(value: unknown): WhmcsSettings & { expectedRevision: string } {
  if (!object(value) || keys(value) !== UPDATE_KEYS) return invalid('exactly enabled, whmcsUrl, allowedAddresses, ssoTarget, autoCreate, planMap and expectedRevision are required')
  return { ...settingsOf(value), expectedRevision: revisionOf(value) }
}
const revisionOf = (value: Record<string, unknown>): string => {
  if (typeof value.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedRevision)) return invalid('the observed integration revision is required')
  return value.expectedRevision
}

export interface WhmcsProvisionInput { action: WhmcsAction; username: string | null; domain: string | null; package: string | null; password: string | null; contactEmail: string | null; reason: string | null }
const SHAPES: Record<WhmcsAction, { required: string[]; optional: string[] }> = {
  test: { required: [], optional: [] },
  create: { required: ['username', 'domain', 'package', 'password'], optional: ['contactEmail'] },
  suspend: { required: ['username'], optional: ['reason'] },
  unsuspend: { required: ['username'], optional: [] },
  terminate: { required: ['username'], optional: [] },
  change_package: { required: ['username', 'package'], optional: [] },
}
export function parseWhmcsProvision(value: unknown): WhmcsProvisionInput {
  if (!object(value) || !(WHMCS_ACTIONS as readonly unknown[]).includes(value.action)) return invalid('action must be one of ' + WHMCS_ACTIONS.join(', '))
  const action = value.action as WhmcsAction, shape = SHAPES[action]
  const present = Object.keys(value).filter(key => key !== 'action')
  if (shape.required.some(key => !present.includes(key)) || present.some(key => !shape.required.includes(key) && !shape.optional.includes(key))) {
    return invalid(`${action} needs exactly ${shape.required.join(', ') || 'no other fields'}${shape.optional.length ? ' and optionally ' + shape.optional.join(', ') : ''}`)
  }
  const optionalText = (key: string, max: number, test: (text: string) => boolean, message: string): string | null => {
    const text = value[key]
    if (text === undefined || text === '') return null
    return printable(text, max) && test(text) ? text : invalid(message)
  }
  return {
    action,
    username: present.includes('username') ? validateUsername(value.username) : null,
    domain: present.includes('domain') ? validateDomainName(value.domain) : null,
    package: present.includes('package') ? packageName(value.package) : null,
    password: present.includes('password') ? (printable(value.password, 128) && value.password.length > 0 ? value.password : invalid('password must be 1 to 128 printable characters')) : null,
    contactEmail: optionalText('contactEmail', 254, text => /^[^\s@]{1,64}@[^\s@]{1,253}$/.test(text), 'contactEmail must be an email address'),
    reason: optionalText('reason', 256, () => true, 'reason must be up to 256 printable characters'),
  }
}

const readBody = async (request: Request, limit: number): Promise<unknown> => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  if (!request.body) return invalid('a JSON body is required')
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
  for (;;) {
    const next = await reader.read(); if (next.done) break
    bytes += next.value.byteLength
    if (bytes > limit) { await reader.cancel(); return invalid('the request body is too large') }
    chunks.push(next.value)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return invalid('request body is not valid JSON') }
}
const readConfig = async (rootDir: string): Promise<unknown> => {
  try { return await readJsonIfExists<unknown>(configPath(rootDir)) }
  catch { return fail('PRECONDITION_FAILED', 'the saved WHMCS integration cannot be read; review the saved file before retrying', unchanged) }
}

// ---- Activity log: bounded JSONL, one writer chain per process --------------------------------
let activityChain: Promise<void> = Promise.resolve()
const appendActivity = (rootDir: string, entry: WhmcsActivityEntry): Promise<void> => {
  const path = activityPath(rootDir)
  const run = activityChain.then(async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o750 })
    await appendFile(path, JSON.stringify(entry) + '\n', { mode: 0o640 })
    if ((await stat(path)).size <= ACTIVITY_ROTATE_BYTES) return
    const kept = (await readFile(path, 'utf8')).split('\n').filter(Boolean).slice(-WHMCS_ACTIVITY_KEEP)
    const temp = path + '.' + process.pid + '.tmp'
    try { await writeFile(temp, kept.join('\n') + '\n', { mode: 0o640 }); await rename(temp, path) }
    finally { await rm(temp, { force: true }) }
  })
  activityChain = run.catch(() => undefined)
  return run
}
const readActivityEntry = (line: string): WhmcsActivityEntry | null => {
  try {
    const value: unknown = JSON.parse(line)
    if (!object(value) || keys(value) !== 'action,at,ip,reason,result,username' || !isTime(value.at) || (value.action !== null && !(WHMCS_ACTIONS as readonly unknown[]).includes(value.action))
      || (value.username !== null && typeof value.username !== 'string') || !['ok', 'refused', 'failed'].includes(value.result as string)
      || typeof value.reason !== 'string' || !/^[a-z0-9_]{1,48}$/.test(value.reason) || (value.ip !== null && !parseIp(value.ip))) return null
    return value as unknown as WhmcsActivityEntry
  } catch { return null }
}
export async function readWhmcsActivity(rootDir: string): Promise<WhmcsActivityEntry[]> {
  let text: string
  try { text = await readFile(activityPath(rootDir), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; return fail('SERVICE_UNAVAILABLE', 'the WHMCS activity log cannot be read', unchanged) }
  return text.split('\n').filter(Boolean).slice(-ACTIVITY_READ).map(readActivityEntry).filter((entry): entry is WhmcsActivityEntry => entry !== null).reverse()
}

// Unauthenticated refusals are recorded at most once a minute per address and reason, so a scanner cannot grow the log or the audit trail.
const refusalSeen = new Map<string, number>()
const recordRefusal = (key: string, nowMs: number): boolean => {
  if (refusalSeen.size > 1024) refusalSeen.clear()
  const last = refusalSeen.get(key)
  if (last !== undefined && nowMs - last < 60_000) return false
  refusalSeen.set(key, nowMs)
  return true
}
const tokenMatches = (header: string | null, storedHash: string): boolean => {
  const match = /^Bearer (\S+)$/.exec(header ?? '')
  if (!match || !TOKEN_RE.test(match[1]!)) return false
  return timingSafeEqual(Buffer.from(sha256(match[1]!), 'hex'), Buffer.from(storedHash, 'hex'))
}
const reasonOf = (error: unknown): string => {
  if (!isXpanelError(error)) return 'internal_error'
  const reason = error.detail.reason
  return typeof reason === 'string' && /^[a-z0-9_]{1,48}$/.test(reason) ? reason : error.code.toLowerCase()
}

async function provision(request: Request, method: string, helpers: WhmcsRouteHelpers): Promise<Response> {
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const now = (helpers.now ?? (() => new Date()))()
  const rawIp = helpers.clientIp(request), ip = rawIp && parseIp(rawIp) ? rawIp : null
  const log = (entry: Omit<WhmcsActivityEntry, 'at' | 'ip'>): Promise<void> => appendActivity(helpers.store.rootDir, { at: now.toISOString(), ip, ...entry }).catch(() => undefined)
  const refuse = async (reason: string, code: ErrorCode, message: string): Promise<never> => {
    if (recordRefusal((ip ?? 'unknown') + ' ' + reason, now.getTime())) {
      await log({ action: null, username: null, result: 'refused', reason })
      await helpers.emitAudit({ actor: 'whmcs', action: 'whmcs.provision.refused', target: 'integration:whmcs', detail: { reason }, outcome: 'denied', ip }).catch(() => undefined)
    }
    return fail(code, message, unchanged)
  }
  let raw: unknown = null
  try { raw = await readJsonIfExists<unknown>(configPath(helpers.store.rootDir)) } catch { raw = null }
  const record = readSavedWhmcs(raw)
  if (!record?.enabled || !record.token) return refuse('integration_disabled', 'NOT_FOUND', 'the WHMCS integration is not enabled')
  const peer = parseIp(ip)
  if (!peer || !record.allowedAddresses.some(entry => { const range = parseCidr(entry); return !!range && cidrContains(range, peer) })) {
    return refuse('address_not_allowed', 'FORBIDDEN', 'this address is not allowed to call the WHMCS integration')
  }
  if (request.headers.get('x-xpanel-whmcs-id') !== record.apiIdentifier || !tokenMatches(request.headers.get('authorization'), record.token.sha256)) {
    return refuse('token_invalid', 'UNAUTHENTICATED', 'the WHMCS API identifier or token is not valid')
  }
  const actor = record.token.issuedBy
  const audit = (action: WhmcsAction, username: string | null, outcome: 'ok' | 'denied' | 'failed', detail: Record<string, unknown>) => helpers.emitAudit({
    actor: 'whmcs:' + record.apiIdentifier, action: 'whmcs.provision.' + action, target: username ? 'account:' + username : 'integration:whmcs', detail, outcome, principalId: actor, ip })
  let input: WhmcsProvisionInput
  try { input = parseWhmcsProvision(await readBody(request, 8192)) }
  catch (error) { await log({ action: null, username: null, result: 'refused', reason: 'invalid_request' }); throw error }
  const { action, username } = input
  const refused = async (reason: string, code: ErrorCode, message: string): Promise<never> => {
    await log({ action, username, result: 'refused', reason })
    await audit(action, username, 'denied', { result: 'refused', reason }).catch(() => undefined)
    return fail(code, message, { ...unchanged, reason })
  }
  if (action === 'create' && !record.autoCreate) return refused('create_disabled', 'PRECONDITION_FAILED', 'account creation from WHMCS is turned off in xWHM')
  const mapped = input.package === null ? null : record.planMap.find(row => row.package === input.package)
  if (input.package !== null && !mapped) return refused('package_not_mapped', 'PRECONDITION_FAILED', `the WHMCS package "${input.package}" is not mapped to an xPanel plan`)
  if (username && action !== 'create' && !await helpers.store.getAccountByUsername(username)) return refused('account_not_found', 'NOT_FOUND', `account "${username}" was not found`)
  try {
    if (action === 'create') await helpers.ports.createAccount({ actor, username: username!, primaryDomain: input.domain!, planId: mapped!.planId, password: input.password!, contactEmail: input.contactEmail })
    else if (action === 'suspend') await helpers.ports.suspendAccount({ actor, username: username!, reason: input.reason ?? 'Suspended by WHMCS' })
    else if (action === 'unsuspend') await helpers.ports.unsuspendAccount({ actor, username: username! })
    else if (action === 'terminate') await helpers.ports.terminateAccount({ actor, username: username! })
    else if (action === 'change_package') await helpers.ports.changePlan({ actor, username: username!, planId: mapped!.planId })
  } catch (error) {
    const reason = reasonOf(error)
    await log({ action, username, result: 'failed', reason })
    await audit(action, username, 'failed', { result: 'failed', reason }).catch(() => undefined)
    throw error
  }
  await log({ action, username, result: 'ok', reason: 'completed' })
  try { await audit(action, username, 'ok', { result: 'ok', ...(mapped ? { package: mapped.package, planId: mapped.planId } : {}) }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the WHMCS call completed but its audit record requires review', { stateChanged: action !== 'test', verificationRequired: true }) }
  return json({ ok: true, action, username })
}

// ---- Root configuration routes --------------------------------------------------------------
const sameCaller = (left: AuthenticatedCaller, right: AuthenticatedCaller): boolean => left.principal.id === right.principal.id
  && left.principal.kind === right.principal.kind && left.sessionId === right.sessionId && left.apiTokenId === right.apiTokenId

async function viewOf(raw: unknown, helpers: WhmcsRouteHelpers): Promise<WhmcsView> {
  const saved = readSavedWhmcs(raw)
  const [plans, accounts] = await Promise.all([helpers.store.listPlans(), helpers.store.listAccounts()])
  const counts = new Map<string, number>()
  for (const account of accounts) counts.set(account.planId, (counts.get(account.planId) ?? 0) + 1)
  const settings = raw === null ? { ...DEFAULT_WHMCS_SETTINGS, allowedAddresses: [], planMap: [] } : saved
    ? { enabled: saved.enabled, whmcsUrl: saved.whmcsUrl, allowedAddresses: saved.allowedAddresses, ssoTarget: saved.ssoTarget, autoCreate: saved.autoCreate, planMap: saved.planMap } : null
  return {
    state: raw === null ? 'default' : saved ? 'saved' : 'invalid', settings, apiIdentifier: saved?.apiIdentifier ?? null,
    token: saved?.token ? { hint: saved.token.hint, createdAt: saved.token.createdAt } : null, updatedAt: saved?.updatedAt ?? null, revision: whmcsRevision(raw),
    plans: plans.map(plan => ({ id: plan.id, name: plan.name, accounts: counts.get(plan.id) ?? 0 })),
  }
}

/** Serves the root WHMCS pages and the token-authenticated provisioning endpoint; returns null for any other path. */
export async function handleWhmcsRoute(request: Request, url: URL, method: string, helpers: WhmcsRouteHelpers): Promise<Response | null> {
  if (url.pathname === WHMCS_PROVISION_PATH) {
    if (url.search) return invalid('the provisioning endpoint accepts no query')
    return provision(request, method, helpers)
  }
  const sub = url.pathname === ROUTE ? '' : url.pathname.startsWith(ROUTE + '/') ? url.pathname.slice(ROUTE.length + 1) : null
  if (sub === null || !['', 'token', 'module', 'activity'].includes(sub)) return null
  const caller = await helpers.requireCaller(request)
  const allowed = sub === '' ? ['GET', 'PUT'] : sub === 'token' ? ['POST'] : ['GET']
  if (!allowed.includes(method)) return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
  await helpers.assertRoot(caller, 'whmcs.' + (sub || 'settings'))
  if (url.search) return invalid('the WHMCS integration accepts no query selectors')
  const rootDir = helpers.store.rootDir
  if (sub === 'module') {
    return new Response(renderWhmcsModule(), { headers: { 'content-type': 'text/x-php; charset=utf-8', 'content-disposition': `attachment; filename="${WHMCS_MODULE_FILENAME}"`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  }
  if (sub === 'activity') return json({ entries: await readWhmcsActivity(rootDir) })
  if (method === 'GET') return json(await viewOf(await readConfig(rootDir), helpers))

  const body = await readBody(request, 16384)
  const update = sub === '' ? parseWhmcsUpdate(body) : null
  const expectedRevision = update ? update.expectedRevision : object(body) && keys(body) === 'expectedRevision' ? revisionOf(body) : invalid('exactly expectedRevision is required')
  const fresh = async (): Promise<void> => {
    const current = await helpers.requireCaller(request)
    if (!sameCaller(caller, current) || current.principal.kind !== 'root') fail('FORBIDDEN', 'root authority changed; sign in again', unchanged)
  }
  const nowIso = (helpers.now ?? (() => new Date()))().toISOString()
  const path = configPath(rootDir)
  let secret: string | null = null, attempted = false, next: WhmcsRecord
  const lease = await helpers.store.getWriterLock().acquire()
  try {
    await fresh()
    const raw = await readConfig(rootDir)
    const saved = readSavedWhmcs(raw)
    if (raw !== null && !saved) return fail('PRECONDITION_FAILED', 'the saved WHMCS integration requires review before it can be changed', unchanged)
    if (whmcsRevision(raw) !== expectedRevision) return fail('CONFLICT', 'the WHMCS integration changed; reload before saving', unchanged)
    const base: WhmcsRecord = saved ?? { version: 1, apiIdentifier: 'whmcs_' + randomBytes(6).toString('hex'), ...DEFAULT_WHMCS_SETTINGS, allowedAddresses: [], planMap: [], token: null, updatedAt: nowIso }
    if (update) {
      const known = new Set((await helpers.store.listPlans()).map(plan => plan.id))
      const missing = update.planMap.find(row => !known.has(row.planId))
      if (missing) return fail('VALIDATION', `the plan mapped to "${missing.package}" does not exist`, unchanged)
      if (update.enabled && !base.token) return fail('PRECONDITION_FAILED', 'create an API token before enabling the integration', unchanged)
      const { expectedRevision: _revision, ...settings } = update
      next = { ...base, ...settings, updatedAt: nowIso }
    } else {
      secret = 'xpw_' + randomBytes(32).toString('base64url')
      next = { ...base, token: { sha256: sha256(secret), hint: secret.slice(-4), createdAt: nowIso, issuedBy: caller.principal.id }, updatedAt: nowIso }
    }
    await fresh()
    await lease.assertFencingToken()
    attempted = true
    await atomicWriteJson(path, next, 0o640, async () => { await fresh(); await lease.assertFencingToken() })
    const readback = await readJsonIfExists<unknown>(path)
    if (JSON.stringify(readback) !== JSON.stringify(next) || !readSavedWhmcs(readback)) throw new Error('whmcs_readback_failed')
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the WHMCS integration save could not be verified; reload before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
  const view = await viewOf(next, helpers)
  try {
    await helpers.emitAudit(secret
      ? { actor: caller.principal.username, action: 'whmcs.token.rotated', target: 'integration:whmcs', detail: { apiIdentifier: next.apiIdentifier, createdAt: next.token!.createdAt }, outcome: 'ok', principalId: caller.principal.id }
      : { actor: caller.principal.username, action: 'whmcs.settings.updated', target: 'integration:whmcs', outcome: 'ok', principalId: caller.principal.id,
          detail: { enabled: next.enabled, whmcsUrl: next.whmcsUrl, allowedAddresses: next.allowedAddresses.length, ssoTarget: next.ssoTarget, autoCreate: next.autoCreate, planMap: next.planMap.length } })
  } catch {
    // The secret is never returned without its audit row: a rotated token whose audit failed must be rotated again.
    return fail('SERVICE_UNAVAILABLE', 'the WHMCS integration was saved but its audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true })
  }
  return json(secret ? { ...view, secret } : view)
}
