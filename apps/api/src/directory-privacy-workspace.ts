import { fail, isXpanelError } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import { assertAccountFeatures } from './authorization.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { workspaceJson, type ReadAgent } from './account-ssh-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { sha512Crypt } from '../../agent/src/directory-privacy.ts'
import type { DirectoryPrivacyView } from '../../agent/src/directory-privacy.ts'

export const DIRECTORY_PRIVACY_ROUTE = /^\/api\/web-features\/([^/]+)\/directory-privacy$/
export interface DirectoryPrivacyPorts extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertCanAccessAccount' | 'resolveAccountParam' | 'emitAudit'> {
  store: StateStore
  /** Protected agent transport; null without a connected host agent. */
  readAgent: ReadAgent | null
}
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const REVISION = /^[0-9a-f]{64}$/, USERNAME = /^[A-Za-z0-9._-]{1,64}$/, FOLDER = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const CONFLICTS = new Set(['marker_malformed', 'marker_nested', 'marker_duplicate', 'marker_scope', 'marker_unbalanced', 'block_modified', 'access_rules_present', 'passwd_unrecognized', 'outside_document_root'])
const folder = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && FOLDER.test(value) && !value.split('/').some(part => part === '.' || part === '..')

/** Agent reply pinning; anything unexpected is an unverified host answer, never shown as state. */
export function validateDirectoryPrivacyView(raw: unknown, account: Pick<Account, 'id' | 'username'>, status: 'read' | 'saved'): DirectoryPrivacyView {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'protected directory privacy reply is invalid')
  if (!object(raw) || !object(raw.context) || raw.context.accountId !== account.id || raw.context.username !== account.username || !Array.isArray(raw.roots) || raw.roots.length > 1000
    || !object(raw.capabilities) || typeof raw.capabilities.canSave !== 'boolean' || ![null, 'engine', 'inactive'].includes(raw.capabilities.reason as string | null)
    || !Array.isArray(raw.directories) || raw.directories.length > 100 || !object(raw.application) || raw.application.status !== status || raw.application.nativeQualified !== false
    || !(raw.application.httpStatus === null || Number.isSafeInteger(raw.application.httpStatus) && (raw.application.httpStatus as number) >= 100 && (raw.application.httpStatus as number) <= 599)
    || ![null, true, false].includes(raw.application.protectionVerified as boolean | null)) return bad()
  const site = (value: unknown): boolean => object(value) && typeof value.domain === 'string' && /^[a-z0-9.-]{1,253}$/.test(value.domain) && typeof value.path === 'string' && value.path.length <= 1024
  if (raw.roots.some(root => !site(root) || !folder((root as Record<string, unknown>).path))) return bad()
  for (const item of raw.directories) {
    if (!object(item) || !folder(item.path) || typeof item.enabled !== 'boolean' || typeof item.authName !== 'string' || item.authName.length > 128 || UNSAFE.test(item.authName) || typeof item.revision !== 'string' || !REVISION.test(item.revision)
      || !Array.isArray(item.users) || item.users.length > 100 || item.users.some(user => typeof user !== 'string' || !USERNAME.test(user))
      || !(item.conflict === null || object(item.conflict) && CONFLICTS.has(item.conflict.code as string)) || !(item.url === null || site(item.url))
      || !Array.isArray(item.directives) || item.directives.length > 8 || item.directives.some(line => typeof line !== 'string' || line.length > 1024 || UNSAFE.test(line))) return bad()
  }
  return raw as unknown as DirectoryPrivacyView
}

const readBody = async (req: Request): Promise<Record<string, unknown>> => {
  const text = await req.text()
  if (Buffer.byteLength(text) > 256 * 1024) return fail('LIMIT_EXCEEDED', 'directory privacy request is too large', unchanged)
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  return object(value) ? value : fail('VALIDATION', 'request body must be a JSON object', unchanged)
}
const field = (message: string, name: string, code: string): never => fail('VALIDATION', message, { ...unchanged, fields: [{ field: name, code }] })

/** GET lists the protected folders (or one folder with `?path=`); PUT sets one folder's protection and users. */
export async function handleDirectoryPrivacyRoute(req: Request, url: URL, method: string, ports: DirectoryPrivacyPorts): Promise<Response | null> {
  const match = DIRECTORY_PRIVACY_ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  const authorize = async (): Promise<{ caller: AuthenticatedCaller; account: Account }> => {
    const caller = await ports.requireCaller(req)
    const account = await ports.resolveAccountParam(decodeURIComponent(match[1]!))
    await ports.assertCanAccessAccount(caller, account, 'web_features.directory-privacy')
    await assertAccountFeatures(ports.store, caller, account, ['directory-privacy'])
    return { caller, account }
  }
  const first = await authorize()
  const agentPath = '/accounts/' + first.account.username + '/directory-privacy'
  if (!ports.readAgent) return fail('PRECONDITION_FAILED', 'directory privacy needs the protected host agent', { ...unchanged, reason: 'host_agent_unavailable' })
  if (method === 'GET') {
    const query = [...url.searchParams]
    if (query.length > 1 || query.length === 1 && (query[0]![0] !== 'path' || !folder(query[0]![1]))) return fail('VALIDATION', 'directory privacy reads accept only one canonical folder path', unchanged)
    try { return workspaceJson(validateDirectoryPrivacyView(await ports.readAgent(first.caller, agentPath, { op: 'read', path: query[0]?.[1] ?? null }), first.account, 'read')) }
    catch (error) { if (isXpanelError(error) && error.code !== 'CONFIG_TEST_FAILED') throw error; return fail('SERVICE_UNAVAILABLE', 'the protected folder read could not be verified', unchanged) }
  }
  if (url.search) return fail('VALIDATION', 'directory privacy saves accept no query selectors', unchanged)
  const body = await readBody(req)
  if (Object.keys(body).sort().join() !== 'authName,enabled,expectedRevision,path,users') return fail('VALIDATION', 'a save takes exactly path, expectedRevision, enabled, authName and users', unchanged)
  if (!folder(body.path)) return field('the folder must be a canonical path inside the account home', 'path', 'path')
  if (typeof body.expectedRevision !== 'string' || !REVISION.test(body.expectedRevision)) return field('a current folder revision is required', 'expectedRevision', 'revision')
  if (typeof body.enabled !== 'boolean') return field('enabled must be true or false', 'enabled', 'type')
  if (typeof body.authName !== 'string' || body.authName.length > 128 || UNSAFE.test(body.authName) || /["\\]/.test(body.authName) || body.authName.trim() !== body.authName || body.enabled && !body.authName) return field('the protected area name is 1 to 128 characters without quotes or backslashes', 'authName', 'invalid')
  if (!Array.isArray(body.users) || body.users.length > 100) return field('a folder holds at most 100 users', 'users', 'too_many')
  const seen = new Set<string>()
  const users = body.users.map((user, index) => {
    if (!object(user) || Object.keys(user).some(key => key !== 'username' && key !== 'password') || typeof user.username !== 'string' || !USERNAME.test(user.username)) return field('each user needs a name of letters, digits, dot, dash or underscore', `users.${index}.username`, 'username')
    if (seen.has(user.username)) return field('each user is listed once', `users.${index}.username`, 'duplicate')
    seen.add(user.username)
    if (user.password === undefined) return { username: user.username, passwordHash: null }
    if (typeof user.password !== 'string' || !user.password.isWellFormed() || UNSAFE.test(user.password) || user.password.length < 8 || Buffer.byteLength(user.password, 'utf8') > 1024) return field('passwords are 8 to 1024 bytes on one line', `users.${index}.password`, 'password')
    return { username: user.username, passwordHash: sha512Crypt(user.password) }
  })
  // Fresh authority immediately before the mutation; the agent re-checks again inside the account lease.
  const fresh = await authorize()
  if (fresh.caller.principal.id !== first.caller.principal.id || fresh.account.id !== first.account.id || fresh.account.username !== first.account.username) return fail('CONFLICT', 'the account binding changed before saving', unchanged)
  const reply = await ports.readAgent(fresh.caller, agentPath, { op: 'save', path: body.path, expectedRevision: body.expectedRevision, enabled: body.enabled, authName: body.authName, users }, true)
  let view: DirectoryPrivacyView
  try { view = validateDirectoryPrivacyView(reply, fresh.account, 'saved') } catch { return fail('SERVICE_UNAVAILABLE', 'the protected folder outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  const saved = view.directories[0]
  if (view.directories.length !== 1 || saved!.path !== body.path || saved!.enabled !== body.enabled || saved!.users.join() !== users.map(user => user.username).join()) return fail('SERVICE_UNAVAILABLE', 'the protected folder outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  try { await ports.emitAudit({ actor: fresh.caller.principal.username, action: 'web_features.directory_privacy.updated', target: 'account:' + fresh.account.username, principalId: fresh.caller.principal.id, outcome: 'ok', detail: { path: body.path, enabled: body.enabled, users: users.length, httpStatus: view.application.httpStatus } }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the folder was saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
  return workspaceJson(view)
}
