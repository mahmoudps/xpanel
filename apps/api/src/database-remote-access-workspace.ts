import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { parseDatabaseRemoteAccessRequest, parseDatabaseRemoteEntries } from '../../../packages/core/src/database-remote-access.ts'
import type { DatabaseRemoteAccessRequest } from '../../../packages/core/src/database-remote-access.ts'
import type { DatabaseRemoteAccessView } from '../../agent/src/database-remote-access.ts'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'

export const ACCOUNT_DATABASE_REMOTE_ACCESS_PATH = '/api/account/database-remote-access'
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const exact = (raw: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key))
const count = (raw: unknown): boolean => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= 1000
const accountFence = (account: Account): string => JSON.stringify([account.id, account.username, account.createdAt, account.uid, account.gid, account.home, account.ownerId, account.planId, account.ipv4, account.ipv6, account.status])
/** The browser receives only policy metadata and explicit native proof; no user auth or neighboring data. */
export function validateDatabaseRemoteAccessView(raw: unknown, account: Account, request?: DatabaseRemoteAccessRequest): DatabaseRemoteAccessView {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'protected remote database reply is invalid')
  if (!object(raw) || !exact(raw, ['context', 'revision', 'entries', 'limit', 'users', 'databases', 'capability', 'application'])
    || !object(raw.context) || !exact(raw.context, ['accountId', 'username']) || raw.context.accountId !== account.id || raw.context.username !== account.username
    || typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision) || raw.limit !== 100 || !count(raw.users) || !count(raw.databases)
    || !Array.isArray(raw.entries) || raw.entries.length > 100 || !object(raw.capability) || !exact(raw.capability, ['canChange', 'reason']) || typeof raw.capability.canChange !== 'boolean' || !['qualified', 'native_provider_unavailable', 'native_drift'].includes(raw.capability.reason as string)
    || !object(raw.application) || !exact(raw.application, ['status', 'nativeQualified']) || !['read', 'applied'].includes(raw.application.status as string) || typeof raw.application.nativeQualified !== 'boolean') return bad()
  const entries = raw.entries.map(row => {
    if (!object(row) || !exact(row, ['host', 'comment', 'createdAt', 'firewall', 'grants']) || !['verified', 'unavailable'].includes(row.firewall as string) || !['verified', 'unavailable'].includes(row.grants as string)) return bad()
    return { host: row.host, comment: row.comment, createdAt: row.createdAt }
  })
  try { parseDatabaseRemoteEntries(entries) } catch { return bad() }
  const proven = raw.application.nativeQualified === true
  if (raw.capability.canChange !== proven || (raw.capability.reason === 'qualified') !== proven || raw.entries.some(row => !object(row) || (row.firewall === 'verified') !== proven || (row.grants === 'verified') !== proven)) return bad()
  if (request) {
    if (raw.application.status !== 'applied' || !proven || raw.revision === request.expectedRevision) return bad()
    const target = entries.find(row => row.host === (request.action === 'edit' ? request.replacement : request.host))
    if (request.action === 'remove' ? entries.some(row => row.host === request.host) : !target || target.comment !== request.comment) return bad()
    if (request.action === 'edit' && request.host !== request.replacement && entries.some(row => row.host === request.host)) return bad()
  } else if (raw.application.status !== 'read') return bad()
  return raw as unknown as DatabaseRemoteAccessView
}

export async function handleDatabaseRemoteAccessWorkspaceRoute(req: Request, url: URL, method: string, ports: AccountSshPorts): Promise<Response | null> {
  if (url.pathname !== ACCOUNT_DATABASE_REMOTE_ACCESS_PATH) return null
  if (!['GET', 'POST'].includes(method)) return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return fail('VALIDATION', 'remote database access does not accept selectors', { stateChanged: false })
  const first = await authorizeAccountOwner(ports, req, ['remote-database-access'], 'Remote database access')
  let request: DatabaseRemoteAccessRequest | undefined
  if (method === 'POST') {
    if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
    const text = await req.text()
    if (Buffer.byteLength(text) > 4096) return fail('VALIDATION', 'remote database request is too large', { stateChanged: false })
    let raw: unknown
    try { raw = JSON.parse(text) } catch { return fail('VALIDATION', 'a JSON object is required', { stateChanged: false }) }
    request = parseDatabaseRemoteAccessRequest(raw)
  }
  const fresh = await authorizeAccountOwner(ports, req, ['remote-database-access'], 'Remote database access')
  if (fresh.caller.principal.id !== first.caller.principal.id || accountFence(fresh.account) !== accountFence(first.account)) return fail('CONFLICT', 'the account binding changed; reload before retrying', { stateChanged: false })
  const raw = await ports.readAgent(fresh.caller, '/accounts/' + fresh.account.username + '/database-remote-access', request, method === 'POST', method)
  try {
    const after = await authorizeAccountOwner(ports, req, ['remote-database-access'], 'Remote database access')
    if (after.caller.principal.id !== fresh.caller.principal.id || accountFence(after.account) !== accountFence(fresh.account)) return fail('FORBIDDEN', 'the current account binding changed', { stateChanged: false })
  } catch (error) {
    if (method === 'POST') return fail('SERVICE_UNAVAILABLE', 'remote database change requires current-owner review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    throw error
  }
  let view: DatabaseRemoteAccessView
  try { view = validateDatabaseRemoteAccessView(raw, fresh.account, request) }
  catch { return fail('SERVICE_UNAVAILABLE', 'remote database state could not be verified', { stateChanged: method === 'POST', verificationRequired: true, ...(method === 'POST' ? { unknownOutcome: true } : {}) }) }
  return workspaceJson(view)
}
