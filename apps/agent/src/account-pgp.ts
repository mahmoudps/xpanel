import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, FeatureList, Plan, ServiceUser } from '@xpanel/core'
import { GPG_FINGERPRINT, GPG_MAX_ARMOR_BYTES, GPG_MAX_KEYS, GPG_MAX_OUTPUT_BYTES, GPG_REVISION, gpgAccountArgv, gpgIdentity, isGpgUid, validateGpgArmor } from '../../../packages/os/src/gpg-command.ts'
import type { GpgAlgorithm, GpgCommand, GpgIdentity } from '../../../packages/os/src/gpg-command.ts'
import type { JailedFileManager } from './file-manager.ts'
import type { AgentCallerIdentity } from './server.ts'

export interface PgpKey { fingerprint: string; uids: string[]; algorithm: string; bits: number; created: string; expires: string | null; hasSecret: boolean; encryption: boolean }
export interface PgpView { context: { accountId: string; username: string }; revision: string; keys: PgpKey[]; mailboxes: string[]; application: { status: 'read' | 'generated' | 'imported' | 'deleted'; fingerprint: string | null }; capabilities: { generate: boolean; import: boolean; export: boolean; delete: boolean }; scope: 'account-keyring'; messageEncryption: false }
export type PgpRequest = { op: 'read' } | { op: 'export'; fingerprint: string }
  | { op: 'generate'; expectedRevision: string; name: string; address: string; algorithm: GpgAlgorithm; days: number; passphrase: string }
  | { op: 'import'; expectedRevision: string; armor: string }
  | { op: 'delete'; expectedRevision: string; fingerprint: string; confirmation: string }
export interface PgpResult { ok: boolean; stdout: string; status: string }
export interface PgpRunner { run(identity: GpgIdentity, command: GpgCommand, stdin?: string): Promise<PgpResult> }
type PgpFiles = Pick<JailedFileManager, 'list' | 'mkdir' | 'chmod'>
const invalid = (): never => fail('VALIDATION', 'invalid OpenPGP request', { stateChanged: false })
const unavailable = (): never => fail('PRECONDITION_FAILED', 'OpenPGP observation is unavailable or incomplete', { stateChanged: false })
const uncertain = (): never => fail('SERVICE_UNAVAILABLE', 'the OpenPGP operation requires a fresh keyring read before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (raw: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(raw).length === fields.length && fields.every(field => Object.hasOwn(raw, field))
export function parsePgpRequest(method: string, raw?: unknown, exportFingerprint?: string): PgpRequest {
  if (method === 'GET') return exportFingerprint ? GPG_FINGERPRINT.test(exportFingerprint) ? { op: 'export', fingerprint: exportFingerprint } : invalid() : { op: 'read' }
  if (!object(raw)) return invalid()
  if (raw.op === 'generate' && method === 'POST' && exact(raw, ['op', 'expectedRevision', 'name', 'address', 'algorithm', 'days', 'passphrase']) && typeof raw.name === 'string' && raw.name === raw.name.trim() && typeof raw.address === 'string' && raw.address === raw.address.toLowerCase() && isGpgUid(raw.name + ' <' + raw.address + '>') && ['ed25519', 'rsa3072'].includes(raw.algorithm as string) && Number.isInteger(raw.days) && Number(raw.days) >= 1 && Number(raw.days) <= 3650 && typeof raw.passphrase === 'string' && raw.passphrase.length >= 12 && raw.passphrase.length <= 1024 && !/[\r\n\x00]/.test(raw.passphrase) && typeof raw.expectedRevision === 'string' && GPG_REVISION.test(raw.expectedRevision)) return raw as unknown as PgpRequest
  if (raw.op === 'import' && method === 'POST' && exact(raw, ['op', 'expectedRevision', 'armor']) && typeof raw.expectedRevision === 'string' && GPG_REVISION.test(raw.expectedRevision)) return { op: 'import', expectedRevision: raw.expectedRevision, armor: validateGpgArmor(raw.armor).armor }
  if (raw.op === 'delete' && method === 'DELETE' && exact(raw, ['op', 'expectedRevision', 'fingerprint', 'confirmation']) && typeof raw.expectedRevision === 'string' && GPG_REVISION.test(raw.expectedRevision) && typeof raw.fingerprint === 'string' && GPG_FINGERPRINT.test(raw.fingerprint) && raw.confirmation === raw.fingerprint) return raw as unknown as PgpRequest
  return invalid()
}
const timestamp = (raw: string, optional = false): string | null => {
  if (optional && (raw === '' || raw === '0')) return null
  if (!/^[1-9][0-9]{0,10}$/.test(raw) || Number(raw) > 253402300799) return unavailable()
  return new Date(Number(raw) * 1000).toISOString()
}
const uidText = (raw: string): string => {
  // GnuPG doc/DETAILS: colon-format UID bytes use \xHH quoting; decode UTF-8 only after unescaping.
  const bytes: number[] = []
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === '\\') { if (!/^\\x[0-9a-fA-F]{2}/.test(raw.slice(index, index + 4))) return unavailable(); bytes.push(parseInt(raw.slice(index + 2, index + 4), 16)); index += 3 }
    else { const point = raw.codePointAt(index)!; bytes.push(...Buffer.from(String.fromCodePoint(point), 'utf8')); if (point > 0xffff) index++ }
  }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)) } catch { return unavailable() }
  if (!text || text.length > 512 || /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(text)) return unavailable()
  return text
}
/** GnuPG doc/DETAILS colon fields: type, validity, bits, algorithm, keyid, creation, expiry; fingerprint and UID are field 10. */
export function parseGpgKeys(stdout: string): PgpKey[] {
  if (Buffer.byteLength(stdout) > GPG_MAX_OUTPUT_BYTES || stdout && !stdout.endsWith('\n')) return unavailable()
  const keys: PgpKey[] = [], fingerprints = new Set<string>(); let key: PgpKey | undefined, pending: 'primary' | 'subkey' | null = null, pendingId = ''
  for (const line of stdout.split('\n').filter(Boolean)) {
    if (line.length > 8192 || /[\x00-\x08\x0b-\x1f\x7f]/.test(line)) return unavailable()
    const fields = line.split(':'), type = fields[0]
    // GnuPG DETAILS: trust records have 8 fields, not the 10-field key-record layout.
    if (type === 'tru') { if (!/^tru:[ot]*:[0-9]+:[0-9]+:[0-9]+:[0-9]+:[0-9]+:[0-9]+:?$/.test(line)) return unavailable(); continue }
    if (fields.length < 10 || !type) return unavailable()
    if (type === 'pub' || type === 'sec') {
      if (pending || key && (!key.fingerprint || !key.uids.length) || keys.length >= GPG_MAX_KEYS || !/^[1-9][0-9]{0,4}$/.test(fields[2]!) || Number(fields[2]) > 65536 || !/^[0-9]{1,3}$/.test(fields[3]!) || !/^[A-F0-9]{16}$/.test(fields[4]!)) return unavailable()
      const algorithms: Record<string, string> = { '1': 'RSA', '2': 'RSA', '3': 'RSA', '16': 'ElGamal', '17': 'DSA', '18': 'ECDH', '19': 'ECDSA', '22': 'Ed25519', '25': 'X25519', '27': 'Ed25519' }
      if (!algorithms[fields[3]!]) return unavailable()
      key = { fingerprint: '', uids: [], algorithm: algorithms[fields[3]!]!, bits: Number(fields[2]), created: timestamp(fields[5]!)!, expires: timestamp(fields[6]!, true), hasSecret: type === 'sec' && (!fields[14] || fields[14] === '+'), encryption: (fields[11] ?? '').toLowerCase().includes('e') }; keys.push(key); pending = 'primary'; pendingId = fields[4]!
    } else if (type === 'fpr') {
      if (!key || !pending || !GPG_FINGERPRINT.test(fields[9]!) || !fields[9]!.endsWith(pendingId) || fingerprints.has(fields[9]!)) return unavailable()
      if (pending === 'primary') key.fingerprint = fields[9]!
      fingerprints.add(fields[9]!); pending = null
    } else if (type === 'uid') {
      if (!key || pending || key.uids.length >= 32) return unavailable()
      const uid = uidText(fields[9]!); if (key.uids.includes(uid)) return unavailable(); key.uids.push(uid)
    } else if (type === 'sub' || type === 'ssb') {
      if (key && type === 'ssb' && (!fields[14] || fields[14] === '+')) key.hasSecret = true
      if (!key || pending || !/^[A-F0-9]{16}$/.test(fields[4]!) || !/^[1-9][0-9]{0,4}$/.test(fields[2]!) || !/^[0-9]{1,3}$/.test(fields[3]!)) return unavailable(); timestamp(fields[5]!); timestamp(fields[6]!, true); pending = 'subkey'; pendingId = fields[4]!; if ((fields[11] ?? '').toLowerCase().includes('e')) key.encryption = true
    } else if (!['grp', 'rvk'].includes(type)) return unavailable()
  }
  if (pending || keys.some(item => !item.fingerprint || !item.uids.length) || new Set(keys.map(item => item.fingerprint)).size !== keys.length) return unavailable()
  return keys
}
/** Defense in depth for an explicitly admitted Linux runner. Qualification still needs native confinement/race probes. */
export async function assertPgpHome(identity: GpgIdentity, missingAllowed = false): Promise<void> {
  gpgIdentity(identity)
  const parent = await lstat('/home'), home = await lstat(identity.home)
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o022) || await realpath('/home') !== '/home' || !home.isDirectory() || home.isSymbolicLink() || home.uid !== identity.uid || home.gid !== identity.gid || (home.mode & 0o022) || await realpath(identity.home) !== identity.home) return unavailable()
  const directory = identity.home + '/.gnupg'
  try { await lstat(directory) } catch (error) { if (missingAllowed && object(error) && error.code === 'ENOENT') return; throw error }
  const pending = [directory]; let count = 0
  while (pending.length) {
    const path = pending.pop()!, entry = await lstat(path)
    if (++count > 4096 || entry.isSymbolicLink() || entry.uid !== identity.uid || entry.gid !== identity.gid || await realpath(path) !== path || entry.isFile() && (entry.nlink !== 1 || (entry.mode & 0o077)) || entry.isDirectory() && (entry.mode & 0o7777) !== 0o700 || !entry.isDirectory() && !entry.isFile() && !entry.isSocket()) return unavailable()
    if (entry.isDirectory()) { const names = await readdir(path); if (names.length + count + pending.length > 4096) return unavailable(); for (const name of names) pending.push(path + '/' + name) }
  }
}
export function createSystemPgpRunner(): PgpRunner {
  return { run: async (identity, command, stdin = '') => {
    if (process.platform !== 'linux') return unavailable()
    const argv = gpgAccountArgv(identity, command)
    if (Buffer.byteLength(stdin) > GPG_MAX_ARMOR_BYTES + 1024) return invalid()
    if (command.op === 'generate' || command.op === 'subkey') { if (!/^[^\r\n\x00]{12,1024}\n$/.test(stdin)) return invalid() }
    else if (command.op === 'inspect' || command.op === 'import') validateGpgArmor(stdin)
    else if (stdin) return invalid()
    await assertPgpHome(identity, command.op === 'version')
    return new Promise<PgpResult>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: identity.home, env: { HOME: identity.home, GNUPGHOME: identity.home + '/.gnupg', PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
      const output: Buffer[] = [], diagnostic: Buffer[] = []; let bytes = 0, failed = false
      const stop = () => { failed = true; try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* Already exited. */ } }
      const timer = setTimeout(stop, command.op === 'generate' || command.op === 'subkey' ? 120_000 : 20_000)
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > GPG_MAX_OUTPUT_BYTES) stop(); else output.push(chunk) })
      child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > GPG_MAX_OUTPUT_BYTES) stop(); else diagnostic.push(chunk) })
      child.stdin.on('error', () => { /* Exit result is authoritative; never expose stdin or system errors. */ })
      child.once('error', () => { clearTimeout(timer); reject(new Error('pgp_execution_unavailable')) })
      child.once('close', code => { clearTimeout(timer); if (failed) { reject(new Error('pgp_execution_unavailable')); return }
        // Only machine-status records are retained. Never return diagnostic text, key material, or passphrases from stderr.
        const status = Buffer.concat(diagnostic).toString('utf8').split('\n').filter(line => /^\[GNUPG:\] (?:KEY_CREATED [BPS] [A-F0-9]{40,64}|IMPORT_OK [0-9]+ [A-F0-9]{40,64}|IMPORT_RES [0-9 ]+)$/.test(line)).join('\n')
        resolve({ ok: code === 0, stdout: Buffer.concat(output).toString('utf8'), status }) })
      child.stdin.end(stdin)
    })
  } }
}
export const pgpRevision = (accountId: string, keys: readonly PgpKey[]): string => createHash('sha256').update(JSON.stringify({ accountId, keys })).digest('hex')
export const pgpMailboxes = (account: Account, users: readonly ServiceUser[]): string[] => [...new Set(users.filter(user => user.accountId === account.id && user.services.email).map(user => user.login.toLowerCase()).filter(address => isGpgUid('Account <' + address + '>')))].sort()
async function readKeys(runner: PgpRunner, identity: GpgIdentity): Promise<PgpKey[]> {
  const pub = await runner.run(identity, { op: 'public' }), secret = await runner.run(identity, { op: 'secret' })
  if (!pub.ok || !secret.ok) return unavailable()
  const keys = parseGpgKeys(pub.stdout), secretKeys = parseGpgKeys(secret.stdout)
  if (secretKeys.some(item => !keys.some(key => key.fingerprint === item.fingerprint))) return unavailable()
  return keys.map(key => ({ ...key, hasSecret: secretKeys.some(item => item.fingerprint === key.fingerprint && item.hasSecret) }))
}
export async function runPgpRequest(input: { account: Account; files: PgpFiles; runner: PgpRunner; request: PgpRequest; mailboxes: string[]; authorize(mailboxes?: readonly string[]): Promise<void> }): Promise<PgpView | { fingerprint: string; armor: string; kind: 'public' }> {
  const { account, files, runner, request } = input, identity = gpgIdentity(account)
  await input.authorize()
  const entry = (await files.list('', { showHidden: true })).find(item => item.path === '.gnupg')
  if (entry && (entry.kind !== 'directory' || (entry.mode & 0o7777) !== 0o700)) return fail('PRECONDITION_FAILED', 'the OpenPGP directory must be a private 0700 directory', { stateChanged: false })
  const present = !!entry, keys = present ? await readKeys(runner, identity) : []
  const view = (current: PgpKey[], status: PgpView['application']['status'] = 'read', fingerprint: string | null = null): PgpView => ({ context: { accountId: account.id, username: account.username }, revision: pgpRevision(account.id, current), keys: current, mailboxes: input.mailboxes, application: { status, fingerprint }, capabilities: { generate: current.length < GPG_MAX_KEYS && input.mailboxes.length > 0, import: current.length < GPG_MAX_KEYS && input.mailboxes.length > 0, export: current.length > 0, delete: current.length > 0 }, scope: 'account-keyring', messageEncryption: false })
  if (request.op === 'read') { await input.authorize(); return view(keys) }
  if (request.op === 'export') {
    if (!keys.some(key => key.fingerprint === request.fingerprint)) return fail('NOT_FOUND', 'OpenPGP key not found', { stateChanged: false })
    await input.authorize(); const result = await runner.run(identity, { op: 'export', fingerprint: request.fingerprint })
    if (!result.ok) return unavailable()
    const armor = validateGpgArmor(result.stdout, true).armor, inspected = await runner.run(identity, { op: 'inspect' }, armor)
    if (!inspected.ok) return unavailable()
    const exported = parseGpgKeys(inspected.stdout)
    if (exported.length !== 1 || exported[0]!.fingerprint !== request.fingerprint || exported[0]!.hasSecret) return unavailable()
    await input.authorize()
    return { fingerprint: request.fingerprint, armor, kind: 'public' }
  }
  if (request.expectedRevision !== pgpRevision(account.id, keys)) return fail('CONFLICT', 'the OpenPGP keyring changed; read it before retrying', { stateChanged: false })
  if (request.op !== 'delete' && (keys.length >= GPG_MAX_KEYS || !input.mailboxes.length)) return fail('LIMIT_EXCEEDED', 'OpenPGP key capacity or mailbox precondition is not satisfied', { stateChanged: false })
  if (request.op === 'generate' && !input.mailboxes.includes(request.address)) return fail('FORBIDDEN', 'the address must be a current mailbox of this account', { stateChanged: false })
  if (request.op === 'delete' && !keys.some(key => key.fingerprint === request.fingerprint)) return fail('NOT_FOUND', 'OpenPGP key not found', { stateChanged: false })
  await input.authorize()
  let changed = false
  try {
    if (!present) { await files.mkdir('.gnupg', 0o700); changed = true }
    const probe = await runner.run(identity, { op: 'version' })
    if (!probe.ok || !/^gpg \(GnuPG\) 2\.(?:[2-9]|[1-9][0-9])\.[0-9]+(?:[ -]|$)/m.test(probe.stdout)) return changed ? uncertain() : unavailable()
    let fingerprint: string
    if (request.op === 'import') {
      const inspected = await runner.run(identity, { op: 'inspect' }, request.armor)
      if (!inspected.ok) return fail('VALIDATION', 'the OpenPGP key could not be inspected', { stateChanged: changed })
      const imported = parseGpgKeys(inspected.stdout)
      if (imported.length !== 1 || imported[0]!.uids.some(uid => { const address = /<([^<>]+)>$/.exec(uid)?.[1] ?? uid; return !input.mailboxes.includes(address.toLowerCase()) })) return fail('FORBIDDEN', 'import one key whose identities all belong to current account mailboxes', { stateChanged: changed })
      fingerprint = imported[0]!.fingerprint
      if (keys.some(key => key.fingerprint === fingerprint)) return fail('CONFLICT', 'the OpenPGP key is already present', { stateChanged: changed })
      await input.authorize(imported[0]!.uids.map(uid => (/<([^<>]+)>$/.exec(uid)?.[1] ?? uid).toLowerCase())); changed = true
      const result = await runner.run(identity, { op: 'import' }, request.armor)
      if (!result.ok || !result.status.split('\n').some(line => new RegExp('^\\[GNUPG:\\] IMPORT_OK [0-9]+ ' + fingerprint + '$').test(line))) return uncertain()
    } else if (request.op === 'generate') {
      await input.authorize(); changed = true
      const result = await runner.run(identity, { op: 'generate', uid: request.name + ' <' + request.address + '>', algorithm: request.algorithm, days: request.days }, request.passphrase + '\n')
      const created = /^\[GNUPG:\] KEY_CREATED [BP] ([A-F0-9]{40,64})$/m.exec(result.status)
      if (!result.ok || !created || !GPG_FINGERPRINT.test(created[1]!)) return uncertain()
      fingerprint = created[1]!; if (keys.some(key => key.fingerprint === fingerprint)) return uncertain(); await input.authorize()
      if (!(await runner.run(identity, { op: 'subkey', fingerprint, algorithm: request.algorithm, days: request.days }, request.passphrase + '\n')).ok) return uncertain()
    } else { fingerprint = request.fingerprint; await input.authorize(); changed = true; if (!(await runner.run(identity, { op: 'delete', fingerprint })).ok) return uncertain() }
    const after = await readKeys(runner, identity), found = after.find(key => key.fingerprint === fingerprint)
    if (request.op === 'delete' ? !!found : !found || request.op === 'generate' && (!found.hasSecret || !found.encryption || !found.uids.includes(request.name + ' <' + request.address + '>')) || request.op === 'import' && validateGpgArmor(request.armor).secret && !found.hasSecret) return uncertain()
    if (keys.some(key => key.fingerprint !== fingerprint && !after.some(item => JSON.stringify(item) === JSON.stringify(key))) || after.some(key => key.fingerprint !== fingerprint && !keys.some(item => item.fingerprint === key.fingerprint))) return uncertain()
    await input.authorize()
    return view(after, request.op === 'generate' ? 'generated' : request.op === 'import' ? 'imported' : 'deleted', fingerprint)
  } catch (error) { if (changed) return uncertain(); if (isXpanelError(error)) throw error; return unavailable() }
}
export interface PgpRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(name: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; listServiceUsers(id: string): Promise<ServiceUser[]>; withAccountLifecycleLease<T>(id: string, operation: (account: Account) => Promise<T>): Promise<T> }
  currentPrincipal(): Promise<{ id: string; kind: string; disabled: boolean; username: string; accountId?: string | null } | null>
  files(account: Account, plan: Plan): PgpFiles
  runner: PgpRunner | null
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok'; principalId: string }): Promise<unknown>
}
export async function handleAccountPgpRoute(req: Request, url: URL, method: string, deps: PgpRouteDeps): Promise<Response | null> {
  const match = /^\/accounts\/([a-z][a-z0-9]{1,15})\/pgp(?:\/([A-F0-9]{40}|[A-F0-9]{64})\/public)?$/.exec(url.pathname)
  if (!match) return null
  if (!['GET', 'POST', 'DELETE'].includes(method) || match[2] && method !== 'GET') return new Response(null, { status: 405, headers: { allow: match[2] ? 'GET' : 'GET, POST, DELETE' } })
  if (url.search) return invalid()
  const caller = deps.caller
  if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'OpenPGP requires the signed-in account owner', { stateChanged: false })
  const account = await deps.store.getAccountByUsername(match[1]!)
  if (!account || account.id !== caller.accountId) return fail('FORBIDDEN', 'OpenPGP account does not match the signed-in owner', { stateChanged: false })
  let raw: unknown
  if (method !== 'GET') { const text = await req.text(); if (Buffer.byteLength(text) > GPG_MAX_ARMOR_BYTES + 8192) return invalid(); try { raw = JSON.parse(text) } catch { return invalid() } }
  const request = parsePgpRequest(method, raw, match[2])
  return deps.store.withAccountLifecycleLease(account.id, async fresh => {
    const authorize = async (mailboxes: readonly string[] = []): Promise<Plan> => {
      const principal = await deps.currentPrincipal()
      if (!principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== fresh.id || principal.username !== fresh.username || fresh.status !== 'active' || fresh.username !== match[1]) return fail('FORBIDDEN', 'the current owner is not authorized for OpenPGP', { stateChanged: false })
      const plan = await deps.store.getPlan(fresh.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
      if (!plan || !features || features.disabled.includes('email-encryption') || features.disabled.includes('Encryption (GnuPG Keys)')) return fail('FORBIDDEN', 'OpenPGP is disabled by the current account plan', { stateChanged: false })
      const currentMailboxes = pgpMailboxes(fresh, await deps.store.listServiceUsers(fresh.id))
      if (request.op === 'generate' && !currentMailboxes.includes(request.address) || mailboxes.some(address => !currentMailboxes.includes(address))) return fail('FORBIDDEN', 'the current mailbox is no longer available', { stateChanged: false })
      return plan
    }
    const plan = await authorize()
    if (!deps.runner) return unavailable()
    const result = await runPgpRequest({ account: fresh, files: deps.files(fresh, plan), runner: deps.runner, request, mailboxes: pgpMailboxes(fresh, await deps.store.listServiceUsers(fresh.id)), authorize: async mailboxes => { await authorize(mailboxes) } })
    if (request.op !== 'read' && request.op !== 'export') {
      try { await deps.audit({ actor: caller.actor, action: 'account.pgp.' + request.op, target: 'account:' + fresh.username, detail: { fingerprint: (result as PgpView).application.fingerprint }, outcome: 'ok', principalId: caller.principalId }) } catch { return uncertain() }
    }
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
  })
}
