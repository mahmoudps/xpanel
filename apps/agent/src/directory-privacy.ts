import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, Domain, ServerSettings } from '@xpanel/core'
import { extended } from '@xpanel/render'
import type { FileEntry, FileText, JailedFileManager } from './file-manager.ts'
import { parseManagedHtaccess, replaceManagedBlock } from './htaccess-managed.ts'
import { HTACCESS_MAX_BYTES } from './htaccess-policy.ts'

/**
 * Directory Privacy as cPanel lays it out: the folder's `.htaccess` carries the Basic auth block and
 * `~/.htpasswds/<folder>/passwd` the users. The account's own files are the desired state; every read
 * and write goes through the confined account file runner, never a root file operation.
 */
export type DirectoryPrivacyFiles = Pick<JailedFileManager, 'list' | 'readText' | 'writeTextChecked' | 'mkdir'>
export const DIRECTORY_PRIVACY_MAX_DIRECTORIES = 100
const MAX_WALK = 256
const REVISION = /^[0-9a-f]{64}$/
const unchanged = { stateChanged: false }

// SHA-512-crypt (Drepper, "Unix crypt using SHA-256 and SHA-512"); Apache verifies it through crypt(3).
const CRYPT64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const repeated = (digest: Buffer, length: number): Buffer => { const out = Buffer.alloc(length); for (let at = 0; at < length; at += 64) digest.copy(out, at, 0, Math.min(64, length - at)); return out }
export function sha512Crypt(password: string, salt: string = [...randomBytes(16)].map(byte => CRYPT64[byte & 63]).join(''), rounds = 5000): string {
  if (!/^[./0-9A-Za-z]{1,16}$/.test(salt) || !Number.isSafeInteger(rounds) || rounds < 1000 || rounds > 999_999_999) return fail('VALIDATION', 'invalid SHA-512-crypt parameters')
  const key = Buffer.from(password, 'utf8'), saltBytes = Buffer.from(salt, 'latin1')
  const alternate = createHash('sha512').update(key).update(saltBytes).update(key).digest()
  const first = createHash('sha512').update(key).update(saltBytes).update(repeated(alternate, key.length))
  for (let length = key.length; length > 0; length >>= 1) first.update(length & 1 ? alternate : key)
  const a = first.digest()
  const dp = createHash('sha512'); for (let index = 0; index < key.length; index++) dp.update(key)
  const p = repeated(dp.digest(), key.length)
  const ds = createHash('sha512'); for (let index = 0; index < 16 + a[0]!; index++) ds.update(saltBytes)
  const s = repeated(ds.digest(), saltBytes.length)
  let c = a
  for (let round = 0; round < rounds; round++) {
    const hash = createHash('sha512').update(round & 1 ? p : c)
    if (round % 3) hash.update(s)
    if (round % 7) hash.update(p)
    c = hash.update(round & 1 ? c : p).digest()
  }
  let encoded = ''
  const emit = (value: number, chars: number): void => { for (let n = 0; n < chars; n++) { encoded += CRYPT64[value & 63]; value >>= 6 } }
  for (let index = 0; index < 21; index++) {
    const [x, y, z] = [index, index + 21, index + 42], [b2, b1, b0] = index % 3 === 0 ? [x, y, z] : index % 3 === 1 ? [y, z, x] : [z, x, y]
    emit((c[b2]! << 16) | (c[b1]! << 8) | c[b0]!, 4)
  }
  emit(c[63]!, 2)
  return '$6$' + (rounds === 5000 ? '' : `rounds=${rounds}$`) + salt + '$' + encoded
}

export interface DirectoryPrivacyConflict { code: string; line?: number }
export interface DirectoryPrivacyDirectory {
  path: string; enabled: boolean; authName: string; users: string[]; revision: string
  conflict: DirectoryPrivacyConflict | null
  /** the managed `.htaccess` lines exactly as read back; empty when the folder is not protected */
  directives: string[]
  /** the site URL Apache serves this folder at; null outside every active document root */
  url: { domain: string; path: string } | null
}
export interface DirectoryPrivacyView {
  context: { accountId: string; username: string }
  roots: { domain: string; path: string }[]
  capabilities: { canSave: boolean; reason: 'engine' | 'inactive' | null }
  directories: DirectoryPrivacyDirectory[]
  application: { status: 'read' | 'saved'; httpStatus: number | null; protectionVerified: boolean | null; nativeQualified: false }
}
export type DirectoryPrivacyRequest =
  | { op: 'read'; path: string | null }
  | { op: 'save'; path: string; expectedRevision: string; enabled: boolean; authName: string; users: { username: string; passwordHash: string | null }[] }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const invalid = (message: string, field: string, code: string): never => fail('VALIDATION', message, { ...unchanged, fields: [{ field, code }] })
const pathOf = (value: unknown): string => { try { return extended.assertDirectoryPrivacyPath(value) } catch { return invalid('the folder must be a canonical path inside the account home', 'path', 'path') } }

/** The agent body; the API already hashed every new password, so plaintext never reaches the agent. */
export function parseDirectoryPrivacyRequest(value: unknown): DirectoryPrivacyRequest {
  if (!object(value)) return fail('VALIDATION', 'directory privacy request must be an object', unchanged)
  if (value.op === 'read' && exact(value, ['op', 'path'])) return { op: 'read', path: value.path === null ? null : pathOf(value.path) }
  if (value.op !== 'save' || !exact(value, ['op', 'path', 'expectedRevision', 'enabled', 'authName', 'users'])) return fail('VALIDATION', 'unsupported directory privacy request', unchanged)
  if (typeof value.expectedRevision !== 'string' || !REVISION.test(value.expectedRevision)) return invalid('a current folder revision is required', 'expectedRevision', 'revision')
  if (typeof value.enabled !== 'boolean') return invalid('enabled must be true or false', 'enabled', 'type')
  if (typeof value.authName !== 'string') return invalid('the protected area name must be text', 'authName', 'type')
  if (!Array.isArray(value.users) || value.users.length > extended.DIRECTORY_PRIVACY_MAX_USERS) return invalid(`a folder holds at most ${extended.DIRECTORY_PRIVACY_MAX_USERS} users`, 'users', 'too_many')
  const users = value.users.map((user, index) => {
    if (!object(user) || !exact(user, ['username', 'passwordHash']) || typeof user.username !== 'string' || !extended.HTPASSWD_USERNAME.test(user.username)) return invalid('each user needs a name of letters, digits, dot, dash or underscore', `users.${index}.username`, 'username')
    if (user.passwordHash !== null && !(typeof user.passwordHash === 'string' && /^\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/.test(user.passwordHash))) return invalid('new passwords arrive as SHA-512-crypt hashes', `users.${index}.passwordHash`, 'hash')
    return { username: user.username, passwordHash: user.passwordHash as string | null }
  })
  return { op: 'save', path: pathOf(value.path), expectedRevision: value.expectedRevision, enabled: value.enabled, authName: value.authName, users }
}

interface FolderState { htaccess: FileText | null; passwd: FileText | null }
const read = async (files: DirectoryPrivacyFiles, path: string): Promise<FileText | null> => {
  try { return await files.readText(path) } catch (error) { if (isXpanelError(error) && error.code === 'NOT_FOUND') return null; throw error }
}
const folderState = async (files: DirectoryPrivacyFiles, path: string): Promise<FolderState> =>
  ({ htaccess: await read(files, path + '/.htaccess'), passwd: await read(files, `${extended.HTPASSWDS_DIR}/${path}/passwd`) })
export const directoryPrivacyRevision = (accountId: string, path: string, state: FolderState): string =>
  createHash('sha256').update(JSON.stringify({ accountId, path, htaccess: state.htaccess, passwd: state.passwd })).digest('hex')

/** Account-relative document roots of the active file-backed sites; Apache serves only these trees. */
export function directoryPrivacyRoots(account: Pick<Account, 'id' | 'home'>, domains: readonly Domain[]): { domain: string; path: string }[] {
  return domains.filter(domain => domain.accountId === account.id && domain.kind !== 'alias' && !domain.suspended && (domain.siteType === 'php' || domain.siteType === 'static'))
    .flatMap(domain => { const rel = posix.relative(account.home, domain.docRoot); return rel && !rel.startsWith('..') && !posix.isAbsolute(rel) ? [{ domain: domain.name, path: rel }] : [] })
    .sort((left, right) => right.path.length - left.path.length || left.domain.localeCompare(right.domain))
}
const servedAt = (roots: readonly { domain: string; path: string }[], path: string): DirectoryPrivacyDirectory['url'] => {
  const root = roots.find(item => path === item.path || path.startsWith(item.path + '/'))
  return root ? { domain: root.domain, path: '/' + (path === root.path ? '' : path.slice(root.path.length + 1) + '/') } : null
}

function project(account: Pick<Account, 'id' | 'username' | 'home'>, roots: readonly { domain: string; path: string }[], path: string, state: FolderState): DirectoryPrivacyDirectory {
  const document = parseManagedHtaccess(state.htaccess?.content ?? ''), block = document.conflict ? undefined : document.blocks.get('directory-privacy')
  let conflict: DirectoryPrivacyConflict | null = document.conflict, enabled = false, authName = '', directives: string[] = []
  if (block) {
    const lines = document.records.slice(block.start + 1, block.end).map(record => record.text), name = /^AuthName "(.*)"$/.exec(lines[1] ?? '')?.[1]
    let expected: string[] = []
    try { expected = name ? extended.renderDirectoryPrivacy(account, path, { enabled: true, authName: name, users: [] }).htaccessBody : [] } catch { expected = [] }
    // A hand-edited block is reported, never reinterpreted.
    if (!expected.length || lines.join('\n') !== expected.join('\n')) conflict = { code: 'block_modified', line: block.start + 1 }
    else { enabled = true; authName = name!; directives = lines }
  }
  // Require lines at the same level combine as RequireAny, so other access rules could open the folder.
  const accessLine = document.accessRules || (document.blocks.get('ip-blocker')?.start ?? -1) + 1
  if (!conflict && accessLine) conflict = { code: 'access_rules_present', line: accessLine }
  const entries = state.passwd ? extended.parseHtpasswd(state.passwd.content) : []
  if (!conflict && entries === null) conflict = { code: 'passwd_unrecognized' }
  const url = servedAt(roots, path)
  if (!conflict && !url) conflict = { code: 'outside_document_root' }
  return { path, enabled, authName, users: (entries ?? []).map(entry => entry.username), revision: directoryPrivacyRevision(account.id, path, state), conflict, directives, url }
}

/** Folders that have a password file under ~/.htpasswds, found by a bounded walk of that tree only. */
async function protectedFolders(files: DirectoryPrivacyFiles): Promise<string[]> {
  const found: string[] = [], queue = [extended.HTPASSWDS_DIR]
  for (let visited = 0; queue.length; visited++) {
    if (visited >= MAX_WALK) return fail('LIMIT_EXCEEDED', `the ${extended.HTPASSWDS_DIR} tree has more than ${MAX_WALK} folders`, unchanged)
    const directory = queue.shift()!
    let entries: FileEntry[]
    try { entries = await files.list(directory, { showHidden: true }) }
    catch (error) { if (directory === extended.HTPASSWDS_DIR && isXpanelError(error) && error.code === 'NOT_FOUND') return []; throw error }
    for (const entry of entries) {
      if (entry.kind === 'directory') queue.push(entry.path)
      else if (entry.kind === 'file' && entry.name === 'passwd' && directory !== extended.HTPASSWDS_DIR) {
        const folder = directory.slice(extended.HTPASSWDS_DIR.length + 1)
        try { found.push(extended.assertDirectoryPrivacyPath(folder)) } catch { /* not a folder this tool can manage */ }
      }
    }
  }
  if (found.length > DIRECTORY_PRIVACY_MAX_DIRECTORIES) return fail('LIMIT_EXCEEDED', `more than ${DIRECTORY_PRIVACY_MAX_DIRECTORIES} protected folders`, unchanged)
  return found.sort()
}

export interface DirectoryPrivacyInput {
  account: Account
  domains: readonly Domain[]
  settings: ServerSettings | null
  files: DirectoryPrivacyFiles
  request: DirectoryPrivacyRequest
  /** fresh caller authority, called right before the first host change */
  authorize: () => Promise<void>
  /** loopback Apache request for a folder URL of one site; absent leaves the HTTP outcome unchecked */
  probe?: (domain: string, path: string) => Promise<number>
}

/** Read or save one folder. The caller holds the account lifecycle lease. */
export async function runDirectoryPrivacyRequest(input: DirectoryPrivacyInput): Promise<DirectoryPrivacyView> {
  const { account, files, request } = input
  const roots = directoryPrivacyRoots(account, input.domains)
  const reason = input.settings?.engine !== 'apache' ? 'engine' as const : account.status !== 'active' ? 'inactive' as const : null
  const view = (directories: DirectoryPrivacyDirectory[], application: DirectoryPrivacyView['application'] = { status: 'read', httpStatus: null, protectionVerified: null, nativeQualified: false }): DirectoryPrivacyView =>
    ({ context: { accountId: account.id, username: account.username }, roots, capabilities: { canSave: reason === null, reason }, directories, application })
  if (request.op === 'read') {
    const paths = request.path === null ? await protectedFolders(files) : [request.path]
    const directories: DirectoryPrivacyDirectory[] = []
    for (const path of paths) directories.push(project(account, roots, path, await folderState(files, path)))
    return view(directories)
  }
  const path = request.path, state = await folderState(files, path), current = project(account, roots, path, state)
  if (current.revision !== request.expectedRevision) return fail('CONFLICT', 'the folder changed; read it before saving', unchanged)
  if (reason) return fail('PRECONDITION_FAILED', 'directory privacy cannot be saved now', { ...unchanged, reason })
  if (current.conflict) return fail('PRECONDITION_FAILED', 'this folder needs review before its protection can change', { ...unchanged, conflict: current.conflict })
  try { await files.list(path, { showHidden: true }) }
  catch (error) { if (isXpanelError(error) && ['NOT_FOUND', 'FORBIDDEN', 'VALIDATION'].includes(error.code)) return fail('NOT_FOUND', 'the folder does not exist', unchanged); throw error }
  const existing = (state.passwd ? extended.parseHtpasswd(state.passwd.content) : []) ?? []
  const users = request.users.map((user, index) => {
    const passwordHash = user.passwordHash ?? existing.find(entry => entry.username === user.username)?.passwordHash
    return passwordHash ? { username: user.username, passwordHash } : invalid('a password is required for a new user', `users.${index}.password`, 'required')
  })
  let rendered: ReturnType<typeof extended.renderDirectoryPrivacy>
  try { rendered = extended.renderDirectoryPrivacy(account, path, { enabled: request.enabled, authName: request.authName, users }) }
  catch (error) { if (isXpanelError(error)) return fail('VALIDATION', 'the protected area name or users are invalid', { ...unchanged, fields: [{ field: 'authName', code: 'invalid' }] }); throw error }
  const htaccessPath = path + '/.htaccess', passwdPath = rendered.passwdPath
  const htaccessBefore = state.htaccess?.content ?? null
  const merged = replaceManagedBlock(htaccessBefore ?? '', parseManagedHtaccess(htaccessBefore ?? ''), 'directory-privacy', rendered.htaccessBody)
  const htaccessAfter = merged === '' ? null : merged
  // The password file stays while the folder is protected or still lists users (cPanel keeps users when protection is off).
  const passwdAfter = request.enabled || users.length ? rendered.passwd : null
  if (htaccessAfter !== null && Buffer.byteLength(htaccessAfter, 'utf8') > HTACCESS_MAX_BYTES) return fail('LIMIT_EXCEEDED', 'the .htaccess file would exceed 64 KiB', unchanged)
  await input.authorize()
  let wrote = false
  const writePasswd = async (): Promise<void> => {
    if (passwdAfter === (state.passwd?.content ?? null)) return
    if (passwdAfter !== null) {
      const segments = passwdPath.split('/').slice(0, -1)
      // mkdirat(2) EEXIST is CONFLICT: the folder is already there.
      for (let depth = 1; depth <= segments.length; depth++) try { await files.mkdir(segments.slice(0, depth).join('/'), 0o750); wrote = true } catch (error) { if (!(isXpanelError(error) && error.code === 'CONFLICT')) throw error }
    }
    await files.writeTextChecked(passwdPath, passwdAfter, state.passwd, 0o640); wrote = true
  }
  const writeHtaccess = async (): Promise<void> => {
    if (htaccessAfter === htaccessBefore) return
    await files.writeTextChecked(htaccessPath, htaccessAfter, state.htaccess); wrote = true
  }
  try {
    // Apache must never see a block whose password file is missing: the file goes first when protecting, last when not.
    if (rendered.htaccessBody.length) { await writePasswd(); await writeHtaccess() } else { await writeHtaccess(); await writePasswd() }
    const saved = await folderState(files, path)
    if ((saved.htaccess?.content ?? null) !== htaccessAfter || (saved.passwd?.content ?? null) !== passwdAfter) return fail('SERVICE_UNAVAILABLE', 'the protected folder write requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    const directory = project(account, roots, path, saved)
    let httpStatus: number | null = null
    if (request.enabled && directory.url && input.probe) try { httpStatus = await input.probe(directory.url.domain, directory.url.path) } catch { httpStatus = null }
    return view([directory], { status: 'saved', httpStatus, protectionVerified: request.enabled ? httpStatus === null ? null : httpStatus === 401 : null, nativeQualified: false })
  } catch (error) {
    const unchangedError = !wrote && isXpanelError(error) && error.detail?.stateChanged === false && !['unknownOutcome', 'verificationRequired'].some(key => error.detail?.[key] === true)
    if (unchangedError || isXpanelError(error) && error.code === 'SERVICE_UNAVAILABLE' && error.detail?.unknownOutcome === true) throw error
    return fail('SERVICE_UNAVAILABLE', 'the protected folder outcome requires inspection; no retry was sent', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
  }
}
