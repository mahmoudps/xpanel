import { fail, isXpanelError } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import { assertAccountFeatures, isMailboxPrincipal } from './authorization.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { AUTHORIZED_KEYS_PATH, SSH_FINGERPRINT, parseAccountSshRequest } from '../../agent/src/account-ssh.ts'
import type { AccountSshView } from '../../agent/src/account-ssh.ts'

export const ACCOUNT_SSH_PATH = '/api/account/ssh/keys'
/** server.ts readNativeWorkspace: bounded agent JSON with mutation-aware uncertainty mapping. */
export type ReadAgent = <T>(caller: AuthenticatedCaller, path: string, input?: unknown, mutation?: boolean, method?: string) => Promise<T>
export interface AccountOwnerPorts { store: StateStore; requireCaller(req: Request): Promise<AuthenticatedCaller> }
export interface AccountSshPorts extends AccountOwnerPorts { readAgent: ReadAgent }

/** Signed-in account owner only; the account comes from the session, never from the request. */
export async function authorizeAccountOwner(ports: AccountOwnerPorts, req: Request, toolIds: readonly string[], label: string): Promise<{ caller: AuthenticatedCaller; account: Account }> {
  const caller = await ports.requireCaller(req)
  if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller)) return fail('FORBIDDEN', label + ' requires the signed-in account owner', { stateChanged: false })
  const account = await ports.store.getAccount(caller.principal.accountId)
  if (!account || account.id !== caller.principal.accountId || account.username !== caller.principal.username) return fail('NOT_FOUND', 'account not found', { stateChanged: false })
  if (account.status !== 'active') return fail('FORBIDDEN', label + ' requires an active account', { stateChanged: false })
  await assertAccountFeatures(ports.store, caller, account, toolIds)
  return { caller, account }
}
export const workspaceJson = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const int = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const KEY_TYPES = new Set(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa', 'ssh-dss', 'sk-ecdsa-sha2-nistp256@openssh.com', 'sk-ssh-ed25519@openssh.com'])

/** Agent reply pinning, independent of the browser's own checks. */
export function validateAccountSshView(raw: unknown, account: Account, status: AccountSshView['application']['status']): AccountSshView {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'protected SSH key reply is invalid')
  if (!object(raw) || !object(raw.context) || raw.context.accountId !== account.id || raw.context.username !== account.username || !object(raw.file) || !object(raw.login) || !object(raw.capacity) || !object(raw.capabilities) || !object(raw.application)) return bad()
  const file = raw.file, directory = file.directory, login = raw.login, capabilities = raw.capabilities, application = raw.application
  if (file.path !== AUTHORIZED_KEYS_PATH || typeof file.exists !== 'boolean' || !int(file.sizeBytes, 0, 1024 * 1024) || typeof file.revision !== 'string' || !/^[0-9a-f]{64}$/.test(file.revision) || !(file.mtime === null || typeof file.mtime === 'string' && Number.isFinite(Date.parse(file.mtime))) || !file.exists && (file.sizeBytes !== 0 || file.mtime !== null)
    || !object(directory) || typeof directory.exists !== 'boolean' || ![null, 'directory', 'file', 'symlink'].includes(directory.kind as string | null) || !(directory.mode === null || int(directory.mode, 0, 0o7777)) || directory.exists !== (directory.kind !== null)) return bad()
  if (!Array.isArray(raw.keys) || raw.keys.length > 10_000 || !Array.isArray(raw.unrecognizedLines) || raw.unrecognizedLines.length > 100_000 || raw.unrecognizedLines.some(line => !int(line, 1))) return bad()
  for (const key of raw.keys) if (!object(key) || !int(key.line, 1) || !KEY_TYPES.has(key.type as string) || typeof key.fingerprint !== 'string' || !SSH_FINGERPRINT.test(key.fingerprint) || typeof key.comment !== 'string' || key.comment.length > 1025 || !(key.bits === null || int(key.bits, 1, 65536)) || typeof key.hasOptions !== 'boolean' || typeof key.allowed !== 'boolean') return bad()
  if (!int(raw.capacity.maxKeys, 1) || raw.capacity.used !== raw.keys.length || typeof login.enabled !== 'boolean' || !['none', 'jailed'].includes(login.accountShell as string) || !['none', 'jailed'].includes(login.planShell as string) || !(login.port === null || int(login.port, 1, 65535)) || login.source !== 'saved-configuration'
    || typeof capabilities.canAdd !== 'boolean' || typeof capabilities.canRemove !== 'boolean' || ![null, 'directory_unmanageable', 'capacity'].includes(capabilities.reason as string | null)
    || application.status !== status || application.nativeQualified !== false) return bad()
  return raw as unknown as AccountSshView
}

/** GET lists, POST adds one key, DELETE removes one fingerprint; every write carries the captured revision. */
export async function handleAccountSshRoute(req: Request, url: URL, method: string, ports: AccountSshPorts): Promise<Response | null> {
  if (url.pathname !== ACCOUNT_SSH_PATH) return null
  if (!['GET', 'POST', 'DELETE'].includes(method)) return new Response(null, { status: 405, headers: { allow: 'GET, POST, DELETE' } })
  if (url.search) return fail('VALIDATION', 'SSH keys do not accept account selectors', { stateChanged: false })
  const first = await authorizeAccountOwner(ports, req, ['ssh-access'], 'SSH key management')
  const agentPath = '/accounts/' + first.account.username + '/ssh/keys'
  if (method === 'GET') {
    try { return workspaceJson(validateAccountSshView(await ports.readAgent(first.caller, agentPath), first.account, 'read')) }
    catch (error) { if (isXpanelError(error) && error.code !== 'CONFIG_TEST_FAILED') throw error; return fail('SERVICE_UNAVAILABLE', 'the protected SSH key read could not be verified', { stateChanged: false }) }
  }
  let raw: unknown
  try { raw = await req.json() } catch { return fail('VALIDATION', 'SSH key request must be valid JSON', { stateChanged: false }) }
  const request = parseAccountSshRequest(method, raw)
  if (request.op === 'read') return fail('VALIDATION', 'unsupported SSH key method', { stateChanged: false })
  // Fresh authority immediately before the mutation; the agent re-checks again inside the account lease.
  const fresh = await authorizeAccountOwner(ports, req, ['ssh-access'], 'SSH key management')
  if (fresh.caller.principal.id !== first.caller.principal.id || fresh.account.id !== first.account.id || fresh.account.username !== first.account.username) return fail('CONFLICT', 'the account binding changed before saving', { stateChanged: false })
  const body = request.op === 'add' ? { expectedRevision: request.expectedRevision, key: request.key.line } : { expectedRevision: request.expectedRevision, fingerprint: request.fingerprint }
  const reply = await ports.readAgent(fresh.caller, agentPath, body, true, method)
  let view: AccountSshView
  try { view = validateAccountSshView(reply, fresh.account, request.op === 'add' ? 'added' : 'removed') }
  catch { return fail('SERVICE_UNAVAILABLE', 'SSH key outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  const present = view.keys.some(key => key.fingerprint === (request.op === 'add' ? request.key.fingerprint : request.fingerprint))
  if (present !== (request.op === 'add') || view.file.revision === request.expectedRevision) return fail('SERVICE_UNAVAILABLE', 'SSH key outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return workspaceJson(view)
}
