import { createHash, createPublicKey } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, FeatureList, Plan, ServerSettings } from '@xpanel/core'
import { system } from '@xpanel/render'
import { MAX_EDIT_BYTES } from './file-manager.ts'
import type { FileText, JailedFileManager } from './file-manager.ts'
import type { AgentCallerIdentity } from './server.ts'

export const AUTHORIZED_KEYS_PATH = '.ssh/authorized_keys'
export const SSH_DIRECTORY = '.ssh'
/** sshd(8) AUTHORIZED_KEYS FILE FORMAT: a line may be up to 8 kilobytes. */
export const SSH_KEY_LINE_MAX_BYTES = 8192
export const SSH_MAX_KEYS = 100
export const SSH_COMMENT_MAX = 255
export const SSH_MIN_RSA_BITS = 3072
const FILE_MODE = 0o600, DIRECTORY_MODE = 0o700
/** sshd(8) key types. Only the first group may be added; the rest are listed so they can be removed. */
const ADDABLE = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'] as const
const KNOWN = new Set<string>([...ADDABLE, 'ssh-dss', 'sk-ecdsa-sha2-nistp256@openssh.com', 'sk-ssh-ed25519@openssh.com'])
const CURVES: Readonly<Record<string, { crv: string; bytes: number; bits: number }>> = {
  'ecdsa-sha2-nistp256': { crv: 'P-256', bytes: 32, bits: 256 }, 'ecdsa-sha2-nistp384': { crv: 'P-384', bytes: 48, bits: 384 }, 'ecdsa-sha2-nistp521': { crv: 'P-521', bytes: 66, bits: 521 },
}
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u, UNSAFE_ALL = new RegExp(UNSAFE_TEXT.source, 'gu')
export const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/
const REVISION = /^[0-9a-f]{64}$/

export interface AuthorizedKey { line: number; type: string; fingerprint: string; comment: string; bits: number | null; hasOptions: boolean; allowed: boolean }
export interface AuthorizedKeysDocument { keys: AuthorizedKey[]; unrecognizedLines: number[] }
export interface NewAuthorizedKey { type: string; fingerprint: string; comment: string; bits: number; line: string }
interface KeyBlob { fingerprint: string; bits: number | null; valid: boolean }

const b64url = (bytes: Buffer): string => bytes.toString('base64url')
/** RFC 4251 section 5: string = uint32 length + bytes. */
const wireStrings = (blob: Buffer): Buffer[] | null => {
  const out: Buffer[] = []
  for (let offset = 0; offset < blob.length;) {
    if (offset + 4 > blob.length) return null
    const length = blob.readUInt32BE(offset)
    if (offset + 4 + length > blob.length) return null
    out.push(blob.subarray(offset + 4, offset + 4 + length)); offset += 4 + length
  }
  return out
}
/** RFC 4251 mpint: two's complement; a positive value with its high bit set carries one leading zero byte. */
const positiveMpint = (value: Buffer): Buffer | null => {
  if (value.length === 0 || (value[0]! & 0x80) !== 0) return null
  if (value[0] === 0 && (value.length === 1 || (value[1]! & 0x80) === 0)) return null
  return value[0] === 0 ? value.subarray(1) : value
}
const inspectBlob = (type: string, encoded: string): KeyBlob | null => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null
  const blob = Buffer.from(encoded, 'base64')
  if (blob.toString('base64') !== encoded) return null
  const fields = wireStrings(blob)
  if (!fields || fields[0]?.toString('latin1') !== type) return null
  // ssh-keygen -l prints SHA256 of the key blob as unpadded base64.
  const fingerprint = 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  let bits: number | null = null, valid = true
  try {
    if (type === 'ssh-ed25519') {
      if (fields.length !== 2 || fields[1]!.length !== 32) return null
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(fields[1]!) }, format: 'jwk' }); bits = 256
    } else if (CURVES[type]) {
      const curve = CURVES[type]!, point = fields[2]
      if (fields.length !== 3 || fields[1]!.toString('latin1') !== type.slice('ecdsa-sha2-'.length) || !point || point.length !== 1 + 2 * curve.bytes || point[0] !== 4) return null
      createPublicKey({ key: { kty: 'EC', crv: curve.crv, x: b64url(point.subarray(1, 1 + curve.bytes)), y: b64url(point.subarray(1 + curve.bytes)) }, format: 'jwk' }); bits = curve.bits
    } else if (type === 'ssh-rsa') {
      const e = fields.length === 3 ? positiveMpint(fields[1]!) : null, n = fields.length === 3 ? positiveMpint(fields[2]!) : null
      if (!e || !n) return null
      bits = createPublicKey({ key: { kty: 'RSA', n: b64url(n), e: b64url(e) }, format: 'jwk' }).asymmetricKeyDetails?.modulusLength ?? null
      if (bits === null) return null
    } else valid = false
  } catch { return null }
  return { fingerprint, bits, valid }
}
const addable = (type: string, blob: KeyBlob): boolean => blob.valid && (ADDABLE as readonly string[]).includes(type) && (type !== 'ssh-rsa' || (blob.bits ?? 0) >= SSH_MIN_RSA_BITS)

/** sshd(8): options are comma-separated without spaces except inside double quotes. */
const splitOptions = (line: string): { options: string | null; rest: string } | null => {
  const first = /^\S+/.exec(line)?.[0] ?? ''
  if (KNOWN.has(first)) return { options: null, rest: line }
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (char === '\\' && quoted) { index++; continue }
    if (char === '"') quoted = !quoted
    else if (!quoted && (char === ' ' || char === '\t')) return { options: line.slice(0, index), rest: line.slice(index).replace(/^[ \t]+/, '') }
  }
  return null
}

/** Parses an OpenSSH authorized_keys file per sshd(8) AUTHORIZED_KEYS FILE FORMAT. */
export function parseAuthorizedKeys(content: string): AuthorizedKeysDocument {
  const keys: AuthorizedKey[] = [], unrecognizedLines: number[] = []
  content.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '').replace(/^[ \t]+/, '')
    if (!line || line.startsWith('#')) return
    const split = splitOptions(line), fields = split ? /^(\S+)[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(split.rest) : null
    const type = fields?.[1] ?? '', blob = fields && KNOWN.has(type) ? inspectBlob(type, fields[2]!) : null
    if (!split || !fields || !blob) { unrecognizedLines.push(index + 1); return }
    keys.push({ line: index + 1, type, fingerprint: blob.fingerprint, comment: (fields[3] ?? '').trim().replace(UNSAFE_ALL, '\ufffd').slice(0, 1024),
      bits: blob.bits, hasOptions: split.options !== null, allowed: addable(type, blob) })
  })
  return { keys, unrecognizedLines }
}

const keyError = (code: string, message: string): never => fail('VALIDATION', message, { stateChanged: false, fields: [{ field: 'key', code }] })
/** One public key line `type base64 [comment]`; option prefixes are refused in this version. */
export function parseNewAuthorizedKey(input: unknown): NewAuthorizedKey {
  if (typeof input !== 'string' || !input.isWellFormed()) return keyError('invalid', 'the public key must be text')
  const text = input.trim()
  if (!text) return keyError('required', 'a public key is required')
  if (Buffer.byteLength(text, 'utf8') > SSH_KEY_LINE_MAX_BYTES) return keyError('too_long', 'the public key line exceeds 8 KiB')
  if (/[\r\n]/.test(text)) return keyError('multiple_lines', 'add one key at a time')
  if (UNSAFE_TEXT.test(text.replace(/\t/g, ' '))) return keyError('invalid_characters', 'the public key contains control characters')
  const spaced = text.replace(/\t/g, ' '), fields = /^(\S+) +(\S+)(?: +(.*))?$/.exec(spaced)
  const type = fields?.[1] ?? ''
  if (!fields || !(ADDABLE as readonly string[]).includes(type)) return keyError(!KNOWN.has(type) && spaced.split(/ +/).slice(1).some(token => KNOWN.has(token)) ? 'options_refused' : 'unsupported_type', 'only ssh-ed25519, ecdsa-sha2-nistp256/384/521 and ssh-rsa keys without options can be added')
  const comment = (fields[3] ?? '').trim()
  if (comment.length > SSH_COMMENT_MAX) return keyError('comment_too_long', 'the key comment exceeds 255 characters')
  const blob = inspectBlob(type, fields[2]!)
  if (!blob || !blob.valid || blob.bits === null) return keyError('invalid_key', 'the public key data is not a valid key of the stated type')
  // OpenSSH signs with rsa-sha2-256/512 for ssh-rsa keys; only the modulus size is the key's own property.
  if (type === 'ssh-rsa' && blob.bits < SSH_MIN_RSA_BITS) return keyError('rsa_too_short', 'RSA keys must be at least 3072 bits')
  return { type, fingerprint: blob.fingerprint, comment, bits: blob.bits, line: type + ' ' + fields[2]! + (comment ? ' ' + comment : '') }
}

export type AccountSshFiles = Pick<JailedFileManager, 'list' | 'readText' | 'writeTextChecked' | 'mkdir' | 'chmod'>
export interface AccountSshView {
  context: { accountId: string; username: string }
  file: { path: typeof AUTHORIZED_KEYS_PATH; exists: boolean; sizeBytes: number; mtime: string | null; revision: string; directory: { exists: boolean; kind: 'directory' | 'file' | 'symlink' | null; mode: number | null } }
  keys: AuthorizedKey[]; unrecognizedLines: number[]
  capacity: { maxKeys: number; used: number }
  login: { enabled: boolean; accountShell: Account['shell']; planShell: Plan['shell']; port: number | null; source: 'saved-configuration' }
  capabilities: { canAdd: boolean; canRemove: boolean; reason: 'directory_unmanageable' | 'capacity' | null }
  application: { status: 'read' | 'added' | 'removed'; nativeQualified: false; removedLines?: number }
}
export const sshKeysRevision = (accountId: string, file: FileText | null): string => createHash('sha256').update(JSON.stringify({ accountId, path: AUTHORIZED_KEYS_PATH, file })).digest('hex')

interface SshState { directory: AccountSshView['file']['directory']; file: FileText | null }
const readState = async (files: AccountSshFiles): Promise<SshState> => {
  const entry = (await files.list('', { showHidden: true })).find(item => item.path === SSH_DIRECTORY)
  const directory = { exists: !!entry, kind: entry?.kind ?? null, mode: entry ? entry.mode & 0o7777 : null }
  if (entry?.kind !== 'directory') return { directory, file: null }
  try { return { directory, file: await files.readText(AUTHORIZED_KEYS_PATH) } }
  catch (error) { if (isXpanelError(error) && error.code === 'NOT_FOUND') return { directory, file: null }; throw error }
}
const project = (account: Account, plan: Plan, settings: ServerSettings | null, state: SshState, status: AccountSshView['application']['status'], removedLines?: number): AccountSshView => {
  const parsed = parseAuthorizedKeys(state.file?.content ?? ''), usable = state.directory.kind === null || state.directory.kind === 'directory'
  return { context: { accountId: account.id, username: account.username },
    file: { path: AUTHORIZED_KEYS_PATH, exists: state.file !== null, sizeBytes: state.file?.sizeBytes ?? 0, mtime: state.file?.mtime ?? null, revision: sshKeysRevision(account.id, state.file), directory: state.directory },
    keys: parsed.keys, unrecognizedLines: parsed.unrecognizedLines, capacity: { maxKeys: SSH_MAX_KEYS, used: parsed.keys.length },
    login: { enabled: system.effectiveShell(account, plan) !== system.NOLOGIN_SHELL, accountShell: account.shell, planShell: plan.shell, port: settings?.sshPort ?? null, source: 'saved-configuration' },
    capabilities: { canAdd: usable && parsed.keys.length < SSH_MAX_KEYS, canRemove: usable && parsed.keys.length > 0, reason: !usable ? 'directory_unmanageable' : parsed.keys.length >= SSH_MAX_KEYS ? 'capacity' : null },
    application: { status, nativeQualified: false, ...(removedLines === undefined ? {} : { removedLines }) } }
}

export type AccountSshRequest = { op: 'read' } | { op: 'add'; expectedRevision: string; key: NewAuthorizedKey } | { op: 'remove'; expectedRevision: string; fingerprint: string }
export function parseAccountSshRequest(method: string, body: unknown): AccountSshRequest {
  if (method === 'GET') return { op: 'read' }
  const fields = method === 'POST' ? ['expectedRevision', 'key'] : method === 'DELETE' ? ['expectedRevision', 'fingerprint'] : null
  if (!fields) return fail('VALIDATION', 'unsupported SSH key method', { stateChanged: false })
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'SSH key request must be an object', { stateChanged: false })
  const value = body as Record<string, unknown>
  if (Object.keys(value).length !== 2 || fields.some(key => !Object.hasOwn(value, key))) return fail('VALIDATION', 'SSH key requests take only ' + fields.join(' and '), { stateChanged: false })
  if (typeof value.expectedRevision !== 'string' || !REVISION.test(value.expectedRevision)) return fail('VALIDATION', 'a current key file revision is required', { stateChanged: false })
  if (method === 'POST') return { op: 'add', expectedRevision: value.expectedRevision, key: parseNewAuthorizedKey(value.key) }
  if (typeof value.fingerprint !== 'string' || !SSH_FINGERPRINT.test(value.fingerprint)) return fail('VALIDATION', 'a SHA256 key fingerprint is required', { stateChanged: false, fields: [{ field: 'fingerprint', code: 'invalid' }] })
  return { op: 'remove', expectedRevision: value.expectedRevision, fingerprint: value.fingerprint }
}

/** Removes every line carrying the fingerprint, keeping all other bytes and line endings. */
const withoutKey = (content: string, fingerprint: string): { content: string; removed: number } => {
  const lines = content.split('\n'), drop = new Set(parseAuthorizedKeys(content).keys.filter(key => key.fingerprint === fingerprint).map(key => key.line - 1))
  return { content: lines.filter((_, index) => !drop.has(index)).join('\n'), removed: drop.size }
}

/** Mutations run through the confined runner only; the caller holds the account lifecycle lease. */
export async function runAccountSshRequest(input: { account: Account; plan: Plan; settings: ServerSettings | null; files: AccountSshFiles; request: AccountSshRequest; authorize: () => Promise<void> }): Promise<AccountSshView> {
  const { account, plan, settings, files, request } = input
  const state = await readState(files)
  if (request.op === 'read') return project(account, plan, settings, state, 'read')
  if (sshKeysRevision(account.id, state.file) !== request.expectedRevision) return fail('CONFLICT', 'the key file changed; read it before retrying', { stateChanged: false })
  const view = project(account, plan, settings, state, 'read'), current = state.file?.content ?? ''
  let next: string, removed: number | undefined
  if (request.op === 'add') {
    if (!view.capabilities.canAdd) return fail('PRECONDITION_FAILED', 'keys cannot be added to this account now', { stateChanged: false, reason: view.capabilities.reason })
    if (view.keys.some(key => key.fingerprint === request.key.fingerprint)) return fail('CONFLICT', 'this key is already authorized', { stateChanged: false, fields: [{ field: 'key', code: 'duplicate' }] })
    next = current + (current && !current.endsWith('\n') ? '\n' : '') + request.key.line + '\n'
  } else {
    if (state.directory.kind !== 'directory' || !state.file) return fail('NOT_FOUND', 'key not found', { stateChanged: false })
    const result = withoutKey(current, request.fingerprint)
    if (result.removed === 0) return fail('NOT_FOUND', 'key not found', { stateChanged: false })
    next = result.content; removed = result.removed
  }
  if (Buffer.byteLength(next, 'utf8') > MAX_EDIT_BYTES) return fail('LIMIT_EXCEEDED', 'the key file would exceed 1 MiB', { stateChanged: false })
  // Fresh owner authority immediately before the first host change.
  await input.authorize()
  let prepared = false
  try {
    if (state.directory.kind === null) {
      // mkdirat(2) EEXIST means another writer created it first; nothing of ours changed.
      try { await files.mkdir(SSH_DIRECTORY, DIRECTORY_MODE) } catch (error) { if (isXpanelError(error) && error.code === 'CONFLICT') return fail('CONFLICT', 'the key directory changed; read it before retrying', { stateChanged: false }); throw error }
      prepared = true
    }
    else if (state.directory.mode !== DIRECTORY_MODE) { await files.chmod(SSH_DIRECTORY, DIRECTORY_MODE); prepared = true }
    const acknowledgement = await files.writeTextChecked(AUTHORIZED_KEYS_PATH, next, state.file, FILE_MODE)
    const saved = await files.readText(AUTHORIZED_KEYS_PATH)
    if (saved.content !== next || !acknowledgement || acknowledgement.mtime !== saved.mtime || acknowledgement.sizeBytes !== saved.sizeBytes || acknowledgement.mode !== FILE_MODE) return fail('SERVICE_UNAVAILABLE', 'the key file write requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    return project(account, plan, settings, { directory: { exists: true, kind: 'directory', mode: DIRECTORY_MODE }, file: saved }, request.op === 'add' ? 'added' : 'removed', removed)
  } catch (error) {
    const unchanged = isXpanelError(error) && error.detail?.stateChanged === false && !['unknownOutcome', 'verificationRequired'].some(key => error.detail?.[key] === true)
    if (unchanged && !prepared) throw error
    if (isXpanelError(error) && error.code === 'SERVICE_UNAVAILABLE' && error.detail?.unknownOutcome === true) throw error
    return fail('SERVICE_UNAVAILABLE', 'the key file outcome requires inspection; no retry was sent', { stateChanged: true, verificationRequired: true, unknownOutcome: !unchanged, directoryPrepared: prepared })
  }
}

export interface AccountSshRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; withAccountLifecycleLease<T>(accountId: string, operation: (account: Account) => Promise<T>): Promise<T>
    getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; getServerSettings(): Promise<ServerSettings | null> }
  /** Direct local principal read; no API self-RPC inside the lease. */
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  files(account: Account, plan: Plan): AccountSshFiles
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; principalId: string }): Promise<unknown>
}
const SSH_ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/ssh\/keys$/
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const readBody = async (req: Request): Promise<unknown> => {
  const text = await req.text()
  if (text.length > 16 * 1024) return fail('LIMIT_EXCEEDED', 'SSH key request is too large', { stateChanged: false })
  try { return JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
}

/** Account owner only: reseller and root callers manage keys through their own tools. */
export async function handleAccountSshRoute(req: Request, url: URL, method: string, deps: AccountSshRouteDeps): Promise<Response | null> {
  const match = SSH_ROUTE.exec(url.pathname)
  if (!match) return null
  if (!['GET', 'POST', 'DELETE'].includes(method)) return new Response(null, { status: 405, headers: { allow: 'GET, POST, DELETE' } })
  if (url.search) return fail('VALIDATION', 'SSH key requests do not accept query selectors', { stateChanged: false })
  const username = match[1]!, caller = deps.caller
  if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'SSH keys are managed by the signed-in account owner', { stateChanged: false })
  const request = parseAccountSshRequest(method, method === 'GET' ? undefined : await readBody(req))
  const account = await deps.store.getAccountByUsername(username)
  if (!account || account.id !== caller.accountId) return fail('FORBIDDEN', 'the SSH key account does not match the signed-in owner', { stateChanged: false })
  return deps.store.withAccountLifecycleLease(account.id, async fresh => {
    const authorize = async (): Promise<Plan> => {
      const principal = await deps.currentPrincipal()
      if (!principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== fresh.id || principal.username !== fresh.username || fresh.username !== username || fresh.status !== 'active') return fail('FORBIDDEN', 'the current account owner is no longer authorized', { stateChanged: false })
      const plan = await deps.store.getPlan(fresh.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
      if (!plan || !features || features.disabled.includes('ssh-access') || features.disabled.includes('SSH Access & Terminal')) return fail('FORBIDDEN', 'SSH access is disabled by the current account plan', { stateChanged: false })
      return plan
    }
    const plan = await authorize()
    const result = await runAccountSshRequest({ account: fresh, plan, settings: await deps.store.getServerSettings(), files: deps.files(fresh, plan), request, authorize: async () => { await authorize() } })
    if (request.op !== 'read') {
      const fingerprint = request.op === 'add' ? request.key.fingerprint : request.fingerprint
      try { await deps.audit({ actor: caller.actor, action: request.op === 'add' ? 'account.ssh_key.added' : 'account.ssh_key.removed', target: 'account:' + fresh.username, detail: { fingerprint, ...(request.op === 'add' ? { type: request.key.type } : { removedLines: result.application.removedLines }) }, outcome: 'ok', principalId: caller.principalId }) }
      catch { return fail('SERVICE_UNAVAILABLE', 'the key change and its audit require inspection', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
    }
    return json(result)
  })
}
