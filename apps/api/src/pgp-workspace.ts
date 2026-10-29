import { fail, isXpanelError } from '@xpanel/core'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { parsePgpRequest, pgpRevision } from '../../agent/src/account-pgp.ts'
import type { PgpView } from '../../agent/src/account-pgp.ts'
import { GPG_FINGERPRINT, GPG_MAX_ARMOR_BYTES, GPG_MAX_KEYS, GPG_REVISION, validateGpgArmor } from '../../../packages/os/src/gpg-command.ts'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value) && Number.isFinite(Date.parse(value))
export function validatePgpView(raw: unknown, accountId: string, username: string, status: PgpView['application']['status']): PgpView {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'protected OpenPGP reply is invalid')
  if (!object(raw) || !exact(raw, ['context', 'revision', 'keys', 'mailboxes', 'application', 'capabilities', 'scope', 'messageEncryption']) || !object(raw.context) || !exact(raw.context, ['accountId', 'username']) || raw.context.accountId !== accountId || raw.context.username !== username || typeof raw.revision !== 'string' || !GPG_REVISION.test(raw.revision) || raw.scope !== 'account-keyring' || raw.messageEncryption !== false || !object(raw.application) || !exact(raw.application, ['status', 'fingerprint']) || raw.application.status !== status || !(raw.application.fingerprint === null ? status === 'read' : typeof raw.application.fingerprint === 'string' && GPG_FINGERPRINT.test(raw.application.fingerprint)) || !object(raw.capabilities) || !exact(raw.capabilities, ['generate', 'import', 'export', 'delete']) || Object.values(raw.capabilities).some(value => typeof value !== 'boolean')) return bad()
  if (!Array.isArray(raw.mailboxes) || raw.mailboxes.length > 10000 || raw.mailboxes.some(address => typeof address !== 'string' || address.length > 320 || !/^[^\s<>@]+@[^\s<>@]+$/.test(address)) || new Set(raw.mailboxes).size !== raw.mailboxes.length || !Array.isArray(raw.keys) || raw.keys.length > GPG_MAX_KEYS) return bad()
  for (const key of raw.keys) if (!object(key) || !exact(key, ['fingerprint', 'uids', 'algorithm', 'bits', 'created', 'expires', 'hasSecret', 'encryption']) || typeof key.fingerprint !== 'string' || !GPG_FINGERPRINT.test(key.fingerprint) || !Array.isArray(key.uids) || !key.uids.length || key.uids.length > 32 || key.uids.some(uid => typeof uid !== 'string' || uid.length > 512 || /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(uid)) || !['RSA', 'DSA', 'ElGamal', 'ECDH', 'ECDSA', 'Ed25519', 'X25519'].includes(key.algorithm as string) || !Number.isInteger(key.bits) || Number(key.bits) < 1 || Number(key.bits) > 65536 || !date(key.created) || !(key.expires === null || date(key.expires)) || typeof key.hasSecret !== 'boolean' || typeof key.encryption !== 'boolean') return bad()
  if (new Set(raw.keys.map(key => (key as Record<string, unknown>).fingerprint)).size !== raw.keys.length) return bad()
  const view = raw as unknown as PgpView, fingerprint = view.application.fingerprint
  if (status === 'read' && fingerprint !== null || view.revision !== pgpRevision(accountId, view.keys) || Object.entries(view.capabilities).some(([kind, allowed]) => allowed !== (kind === 'generate' || kind === 'import' ? view.keys.length < GPG_MAX_KEYS && view.mailboxes.length > 0 : view.keys.length > 0))) return bad()
  if (status !== 'read' && (view.keys.some(key => key.fingerprint === fingerprint) !== (status !== 'deleted'))) return bad()
  return view
}
/** No account selector: the sealed owner session fixes the agent path and every reply is pinned to it. */
export async function handlePgpWorkspace(req: Request, url: URL, method: string, ports: AccountSshPorts): Promise<Response | null> {
  const match = /^\/api\/account\/pgp(?:\/([A-F0-9]{40}|[A-F0-9]{64})\/public)?$/.exec(url.pathname)
  if (!match) return null
  if (!['GET', 'POST', 'DELETE'].includes(method) || match[1] && method !== 'GET') return new Response(null, { status: 405, headers: { allow: match[1] ? 'GET' : 'GET, POST, DELETE' } })
  if (url.search) return fail('VALIDATION', 'OpenPGP requests do not accept selectors', { stateChanged: false })
  const first = await authorizeAccountOwner(ports, req, ['email-encryption'], 'OpenPGP key management')
  const path = '/accounts/' + first.account.username + '/pgp' + (match[1] ? '/' + match[1] + '/public' : '')
  let raw: unknown
  if (method !== 'GET') { const text = await req.text(); if (Buffer.byteLength(text) > GPG_MAX_ARMOR_BYTES + 8192) return fail('LIMIT_EXCEEDED', 'OpenPGP request exceeds the size limit', { stateChanged: false }); try { raw = JSON.parse(text) } catch { return fail('VALIDATION', 'OpenPGP request must be valid JSON', { stateChanged: false }) } }
  const request = parsePgpRequest(method, raw, match[1]), mutation = request.op !== 'read' && request.op !== 'export'
  const fresh = await authorizeAccountOwner(ports, req, ['email-encryption'], 'OpenPGP key management')
  if (fresh.account.id !== first.account.id || fresh.account.username !== first.account.username || fresh.caller.principal.id !== first.caller.principal.id) return fail('CONFLICT', 'the account binding changed', { stateChanged: false })
  const reply = await ports.readAgent(fresh.caller, path, method === 'GET' ? undefined : request, mutation, method)
  try {
    const after = await authorizeAccountOwner(ports, req, ['email-encryption'], 'OpenPGP key management')
    if (after.account.id !== fresh.account.id || after.account.username !== fresh.account.username || after.caller.principal.id !== fresh.caller.principal.id) throw new Error('changed_account_binding')
    if (request.op === 'export') {
      if (!object(reply) || !exact(reply, ['fingerprint', 'armor', 'kind']) || reply.fingerprint !== request.fingerprint || reply.kind !== 'public') throw new Error('invalid_public_export')
      const armor = validateGpgArmor(reply.armor, true).armor
      return new Response(armor, { headers: { 'content-type': 'application/pgp-keys', 'content-disposition': 'attachment; filename="openpgp-' + request.fingerprint + '.asc"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    }
    const status = request.op === 'read' ? 'read' : request.op === 'generate' ? 'generated' : request.op === 'import' ? 'imported' : 'deleted'
    const view = validatePgpView(reply, fresh.account.id, fresh.account.username, status)
    if (request.op !== 'read' && view.revision === request.expectedRevision) throw new Error('unchanged_acknowledgement')
    if (request.op === 'delete' && view.application.fingerprint !== request.fingerprint || request.op === 'generate' && !view.keys.some(key => key.fingerprint === view.application.fingerprint && key.hasSecret && key.encryption && key.uids.includes(request.name + ' <' + request.address + '>'))) throw new Error('invalid_acknowledgement')
    return workspaceJson(view)
  } catch (error) { if (!mutation && isXpanelError(error) && error.code !== 'CONFIG_TEST_FAILED' && error.code !== 'VALIDATION') throw error; return fail('SERVICE_UNAVAILABLE', 'the OpenPGP result could not be verified', mutation ? { stateChanged: true, unknownOutcome: true, verificationRequired: true } : { stateChanged: false }) }
}
