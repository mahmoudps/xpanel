import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { atomicWriteJson, isStateDirectoryDurabilityError, readJsonIfExists } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

type Helpers = Pick<ExtendedRouteHelpers, 'store' | 'requireCaller' | 'assertRoot' | 'emitAudit'>
/** Source API tokens are written once and only ever leave this module as an outbound Authorization header. */
interface StoredCredential { id: string; label: string; kind: 'api-token'; token: string; createdAt: string; createdBy: string }
interface CredentialDocument { version: 1; credentials: StoredCredential[] }
export interface TransferCredentialView { id: string; label: string; kind: 'api-token'; fingerprint: string; createdAt: string; createdBy: string }

export const TRANSFER_CREDENTIAL_LIMIT = 50
const MAX_BODY_BYTES = 4096
const ROUTE = /^\/api\/transfers\/credentials(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/
// apps/api/src/panel-tokens-workspace.ts issues 'xp_' + base64url(32 random bytes).
const TOKEN = /^xp_[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ACTOR = /^[A-Za-z0-9_.@-]{1,64}$/
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069<>]/u
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const path = (store: { readonly rootDir: string }): string => join(store.rootDir, 'extended', 'transfers', 'credentials.json')

export const parseCredentialLabel = (value: unknown): string => {
  if (typeof value !== 'string') return invalid('a credential label is required')
  const label = value.trim()
  if (!label || [...label].length > 80 || FORBIDDEN.test(label) || !label.isWellFormed()) return invalid('the credential label must be 1 to 80 characters of plain text')
  return label
}
export const parseSourceApiToken = (value: unknown): string => typeof value === 'string' && TOKEN.test(value) ? value : invalid('paste the complete xPanel API token issued on the source server')
/** A short, non-reversible identifier so an operator can match the source token without seeing it again. */
export const credentialFingerprint = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 16)

const readDocument = async (store: { readonly rootDir: string }): Promise<CredentialDocument> => {
  const raw = await readJsonIfExists<unknown>(path(store))
  if (raw === null) return { version: 1, credentials: [] }
  const ok = object(raw) && keys(raw) === 'credentials,version' && raw.version === 1 && Array.isArray(raw.credentials) && raw.credentials.length <= TRANSFER_CREDENTIAL_LIMIT
    && raw.credentials.every(item => object(item) && keys(item) === 'createdAt,createdBy,id,kind,label,token' && typeof item.id === 'string' && UUID.test(item.id) && item.kind === 'api-token'
      && typeof item.token === 'string' && TOKEN.test(item.token) && typeof item.createdAt === 'string' && STAMP.test(item.createdAt) && typeof item.createdBy === 'string' && ACTOR.test(item.createdBy)
      && (() => { try { return parseCredentialLabel(item.label) === item.label } catch { return false } })())
    && new Set(raw.credentials.map(item => (item as StoredCredential).id)).size === raw.credentials.length
  return ok ? raw as unknown as CredentialDocument : fail('PRECONDITION_FAILED', 'stored transfer credentials require inspection', { stateChanged: false })
}
const view = (document: CredentialDocument) => {
  const credentials: TransferCredentialView[] = document.credentials.map(({ token, ...rest }) => ({ ...rest, fingerprint: credentialFingerprint(token) }))
  return { revision: digest(credentials), credentials, limit: TRANSFER_CREDENTIAL_LIMIT }
}

/** Trusted-reference lookup for the discovery adapter; null when the reference no longer exists. */
export const readTransferCredentialToken = async (store: { readonly rootDir: string }, id: string): Promise<string | null> =>
  (await readDocument(store)).credentials.find(item => item.id === id)?.token ?? null

const readBody = async (req: Request): Promise<Record<string, unknown>> => {
  if (req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await req.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return invalid('the request body is too large')
  let body: unknown
  try { body = JSON.parse(text) } catch { return invalid('request body is not valid JSON') }
  return object(body) ? body : invalid('request body must be an object')
}
const expected = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : invalid('the observed credentials revision is required')
const same = (a: AuthenticatedCaller, b: AuthenticatedCaller): boolean => a.principal.id === b.principal.id && a.sessionId === b.sessionId && a.apiTokenId === b.apiTokenId

/** Root-only write-once store of source API tokens: GET lists metadata, POST saves one, DELETE removes one. */
export async function handleTransferCredentialsRoute(req: Request, url: URL, method: string, helpers: Helpers): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const id = match[1]
  const caller = await helpers.requireCaller(req)
  await helpers.assertRoot(caller, 'transfers.credentials')
  const allow = id ? 'DELETE' : 'GET, POST'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (url.search) return invalid('transfer credentials accept no selectors')
  if (method === 'GET') return json(view(await readDocument(helpers.store)))
  const body = await readBody(req)
  if (keys(body) !== (id ? 'expectedRevision' : 'expectedRevision,label,token')) return invalid(id ? 'only expectedRevision is accepted' : 'exactly label, token and expectedRevision are required')
  const revision = expected(body.expectedRevision)
  const input = id ? null : { label: parseCredentialLabel(body.label), token: parseSourceApiToken(body.token) }
  const lease = await helpers.store.getWriterLock().acquire()
  let written = false, changed: TransferCredentialView | undefined, result: ReturnType<typeof view>
  try {
    const fresh = await helpers.requireCaller(req)
    await helpers.assertRoot(fresh, 'transfers.credentials')
    if (!same(fresh, caller)) return fail('FORBIDDEN', 'transfer credential authority changed', { stateChanged: false })
    const document = await readDocument(helpers.store)
    if (view(document).revision !== revision) return fail('CONFLICT', 'transfer credentials changed; read them again', { stateChanged: false })
    let next: StoredCredential[]
    if (input) {
      if (document.credentials.length >= TRANSFER_CREDENTIAL_LIMIT) return fail('LIMIT_EXCEEDED', `at most ${TRANSFER_CREDENTIAL_LIMIT} source credentials can be stored`, { stateChanged: false })
      if (document.credentials.some(item => item.label.toLowerCase() === input.label.toLowerCase())) return fail('CONFLICT', 'a credential with this label exists', { stateChanged: false })
      if (document.credentials.some(item => item.token === input.token)) return fail('CONFLICT', 'this token is already stored', { stateChanged: false })
      const record: StoredCredential = { id: randomUUID(), label: input.label, kind: 'api-token', token: input.token, createdAt: new Date().toISOString(), createdBy: fresh.principal.username }
      next = [...document.credentials, record]
    } else {
      if (!document.credentials.some(item => item.id === id)) return fail('NOT_FOUND', 'transfer credential not found', { stateChanged: false })
      next = document.credentials.filter(item => item.id !== id)
    }
    await lease.assertFencingToken()
    written = true
    await atomicWriteJson(path(helpers.store), { version: 1, credentials: next } satisfies CredentialDocument, 0o600, () => lease.assertFencingToken())
    await lease.commitAuthority()
    result = view(await readDocument(helpers.store))
    if (result.revision !== view({ version: 1, credentials: next }).revision) return fail('SERVICE_UNAVAILABLE', 'the saved credentials could not be verified', { stateChanged: true, verificationRequired: true })
    changed = input ? result.credentials.at(-1) : document.credentials.map(({ token, ...rest }) => ({ ...rest, fingerprint: credentialFingerprint(token) })).find(item => item.id === id)
  } catch (error) {
    if (written || isStateDirectoryDurabilityError(error)) return fail('SERVICE_UNAVAILABLE', 'the credential write outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    throw error
  } finally { await lease.release() }
  try { await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: input ? 'transfer.credential.created' : 'transfer.credential.deleted', target: 'transfer-credential:' + changed!.id, detail: { label: changed!.label, fingerprint: changed!.fingerprint }, outcome: 'ok' }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the credential change is saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
  return json({ ...result, changed: changed!.id }, input ? 201 : 200)
}
