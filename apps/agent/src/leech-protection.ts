import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { effectivePlan, fail, isXpanelError } from '@xpanel/core'
import type { Account, Domain, FeatureList, Plan, ServerSettings } from '@xpanel/core'
import { edge, extended } from '@xpanel/render'
import { directoryPrivacyRoots, type DirectoryPrivacyFiles } from './directory-privacy.ts'
import { JailedFileManager, type AccountFileRunner } from './file-manager.ts'
import { absoluteUrl, parseManagedHtaccess, replaceManagedBlock } from './htaccess-managed.ts'
import { HTACCESS_MAX_BYTES } from './htaccess-policy.ts'

/**
 * cPanel Leech Protection for Directory Privacy folders. A user who signs in to a protected folder from more
 * addresses than allowed within two hours is redirected (and optionally disabled, with an optional alert email).
 * Apache logs every authenticated request to a dedicated log; the agent reads it on its minute tick, so the
 * redirect starts with the next tick after the limit is passed rather than on the offending request itself.
 * Settings are desired state (extended/edge/leech/<accountId>.json); while a user is over the limit the folder
 * .htaccess carries a redirect block, written only as the account, through the confined account file runner.
 */
export const LEECH_STATE_DIR = 'extended/edge/leech'
export const LEECH_WINDOW_MS = 2 * 60 * 60 * 1000
export const LEECH_MAX_FOLDERS = 100
const MAX_READ = 4 * 1024 * 1024, ROTATE_AT = 16 * 1024 * 1024
const unchanged = { stateChanged: false }

export interface LeechFolder { path: string; maxLogins: number; redirectUrl: string; alertEmail: string | null; disableUsers: boolean }
export interface LeechRecord { version: 1; folders: LeechFolder[]; updatedAt: string }
export const leechStatePath = (accountId: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(accountId)) return fail('VALIDATION', 'account id is invalid')
  return LEECH_STATE_DIR + '/' + accountId + '.json'
}
export const leechRevision = (raw: unknown): string => createHash('sha256').update(JSON.stringify(raw ?? null)).digest('hex')

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
// RFC 5321 mailbox, kept to a header-safe subset: no spaces, quotes, angle brackets or line breaks.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

/** One folder's settings; field issues name the request position for the form. */
export function parseLeechFolder(raw: unknown): LeechFolder {
  const fields: { field: string; code: string }[] = []
  if (!object(raw) || !exact(raw, ['path', 'maxLogins', 'redirectUrl', 'alertEmail', 'disableUsers'])) return fail('VALIDATION', 'leech protection takes path, maxLogins, redirectUrl, alertEmail and disableUsers', unchanged)
  let path = ''
  try { path = extended.assertDirectoryPrivacyPath(raw.path) } catch { fields.push({ field: 'path', code: 'path' }) }
  if (!Number.isSafeInteger(raw.maxLogins) || (raw.maxLogins as number) < 1 || (raw.maxLogins as number) > 1000) fields.push({ field: 'maxLogins', code: 'range' })
  const redirectUrl = absoluteUrl(raw.redirectUrl, true)
  if (!redirectUrl) fields.push({ field: 'redirectUrl', code: 'url' })
  if (!(raw.alertEmail === null || typeof raw.alertEmail === 'string' && raw.alertEmail.length <= 254 && EMAIL.test(raw.alertEmail))) fields.push({ field: 'alertEmail', code: 'email' })
  if (typeof raw.disableUsers !== 'boolean') fields.push({ field: 'disableUsers', code: 'type' })
  if (fields.length) return fail('VALIDATION', 'leech protection fields are invalid', { ...unchanged, fields })
  return { path, maxLogins: raw.maxLogins as number, redirectUrl: redirectUrl!, alertEmail: raw.alertEmail as string | null, disableUsers: raw.disableUsers as boolean }
}
export function readLeechRecord(raw: unknown): LeechRecord | null {
  if (!object(raw) || !exact(raw, ['version', 'folders', 'updatedAt']) || raw.version !== 1 || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))
    || !Array.isArray(raw.folders) || raw.folders.length > LEECH_MAX_FOLDERS) return null
  try {
    const folders = raw.folders.map(parseLeechFolder)
    if (new Set(folders.map(folder => folder.path)).size !== folders.length || JSON.stringify(folders) !== JSON.stringify(raw.folders)) return null
    return { version: 1, folders, updatedAt: raw.updatedAt }
  } catch { return null }
}

/** The folder's managed block: every request of a flagged user is redirected; no offender, no block. */
export function renderLeechBlock(folder: Pick<LeechFolder, 'redirectUrl'>, flagged: readonly string[]): string[] {
  const users = [...flagged].sort()
  if (users.some(user => !extended.HTPASSWD_USERNAME.test(user))) return fail('VALIDATION', 'flagged user names are invalid')
  if (!users.length) return []
  // Per-directory rewriting runs after authentication, so REMOTE_USER is the signed-in user.
  return ['RewriteEngine On', `RewriteCond %{REMOTE_USER} ^(?:${users.map(user => user.replace(/\./g, '\\.')).join('|')})$`, `RewriteRule ^ ${folder.redirectUrl} [R=302,L]`]
}

/** Apache writes this line for every request that carries a signed-in user (rendered by renderApacheAuthLog). */
export interface AuthLogLine { at: number; vhost: string; ip: string; status: number; user: string; path: string }
export function parseAuthLogLine(line: string): AuthLogLine | null {
  const parts = line.split('\t')
  if (parts.length !== 6) return null
  const [at, vhost, ip, status, user, path] = parts as [string, string, string, string, string, string]
  if (!/^[0-9]{9,11}$/.test(at) || !/^[a-z0-9.-]{1,253}$/.test(vhost) || !/^[0-9a-f.:]{2,45}$/.test(ip) || !/^[1-5][0-9]{2}$/.test(status) || !extended.HTPASSWD_USERNAME.test(user) || !path.startsWith('/') || path.length > 4096) return null
  return { at: Number(at) * 1000, vhost, ip, status: Number(status), user, path }
}

export interface LeechFolderStatus extends LeechFolder {
  state: 'applied' | 'not_protected' | 'conflict' | 'outside_document_root' | 'pending'
  flagged: string[]
  disabled: string[]
}
export interface LeechAuditEntry { actor: 'system'; action: 'account.leech_protection.triggered'; target: string; detail: { path: string; users: string[]; disabled: boolean; alert: 'sent' | 'failed' | 'none' }; outcome: 'ok' }
export interface LeechMonitorDeps {
  root: string
  store: { getAccount(id: string): Promise<Account | null>; listDomains(filter?: { accountId?: string }): Promise<Domain[]>; withAccountLifecycleLease<T>(id: string, operation: (account: Account) => Promise<T>): Promise<T> }
  files: (account: Account) => DirectoryPrivacyFiles | Promise<DirectoryPrivacyFiles>
  /** Bounded read of the auth log from an offset; null while the log does not exist. */
  readLog?: (offset: number, max: number) => Promise<{ ino: number; size: number; text: string } | null>
  /** Empties the auth log once it is read to its end and large; absent never truncates. */
  truncateLog?: () => Promise<void>
  sendAlert?: (to: string, subject: string, text: string) => Promise<void>
  /** A background redirect, disable or alert leaves its own record; absent records nothing. */
  audit?: (entry: LeechAuditEntry) => Promise<unknown>
  now?: () => Date
}

const readJson = async (path: string): Promise<unknown> => {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  try { return JSON.parse(text) } catch { return undefined }
}
const readOptional = async (files: DirectoryPrivacyFiles, path: string) => {
  try { return await files.readText(path) } catch (error) { if (isXpanelError(error) && error.code === 'NOT_FOUND') return null; throw error }
}

interface Watched { account: Account; folders: LeechFolder[]; roots: { domain: string; path: string }[] }

/** Sliding two-hour windows per folder and user, fed from the auth log, applied to the folder files. */
export class LeechMonitor {
  private offset = -1
  private ino = -1
  private readonly seen = new Map<string, Map<string, Map<string, number>>>()
  private readonly applied = new Map<string, string>()
  private readonly state = new Map<string, LeechFolderStatus>()
  private busy = false
  private readonly deps: LeechMonitorDeps
  constructor(deps: LeechMonitorDeps) { this.deps = deps }

  private now(): number { return (this.deps.now?.() ?? new Date()).getTime() }
  private key(accountId: string, path: string): string { return accountId + '\u0000' + path }

  async record(accountId: string): Promise<LeechRecord | null> {
    const raw = await readJson(join(this.deps.root, leechStatePath(accountId)))
    if (raw === null) return null
    return readLeechRecord(raw) ?? fail('PRECONDITION_FAILED', 'saved leech protection settings require review', unchanged)
  }

  /** Users over the limit now: more distinct addresses inside the window than the folder allows. */
  private flagged(accountId: string, folder: LeechFolder): string[] {
    const users = this.seen.get(this.key(accountId, folder.path)), cutoff = this.now() - LEECH_WINDOW_MS, out: string[] = []
    for (const [user, addresses] of users ?? []) {
      for (const [ip, at] of addresses) if (at < cutoff) addresses.delete(ip)
      if (!addresses.size) users!.delete(user)
      else if (addresses.size > folder.maxLogins) out.push(user)
    }
    return out.sort()
  }

  /** Writes one folder's block and disables newly flagged users; called inside the account lease. */
  private async applyFolder(account: Account, folder: LeechFolder | null, path: string, files: DirectoryPrivacyFiles): Promise<LeechFolderStatus | null> {
    const key = this.key(account.id, path), htaccessPath = path + '/.htaccess', passwdPath = `${extended.HTPASSWDS_DIR}/${path}/passwd`
    const htaccess = await readOptional(files, htaccessPath), document = parseManagedHtaccess(htaccess?.content ?? '')
    const passwd = await readOptional(files, passwdPath), entries = passwd ? extended.parseHtpasswd(passwd.content) : null
    const report = (state: LeechFolderStatus['state'], flagged: string[] = []): LeechFolderStatus | null => {
      if (!folder) { this.state.delete(key); this.seen.delete(key); return null }
      const status = { ...folder, state, flagged, disabled: (entries ?? []).filter(entry => entry.passwordHash.startsWith('!')).map(entry => entry.username) }
      this.state.set(key, status); return status
    }
    // RewriteEngine off in the folder would silently void the redirect.
    if (document.conflict || folder && document.rewriteDisabled) return report('conflict')
    const protectedFolder = document.blocks.has('directory-privacy') && entries !== null
    if (folder && !protectedFolder) return report('not_protected')
    const roots = directoryPrivacyRoots(account, await this.deps.store.listDomains({ accountId: account.id }))
    if (folder && !roots.some(root => path === root.path || path.startsWith(root.path + '/'))) return report('outside_document_root')
    const flagged = folder ? this.flagged(account.id, folder) : []
    const body = folder ? renderLeechBlock(folder, flagged) : []
    const content = replaceManagedBlock(htaccess?.content ?? '', document, 'leech-protection', body)
    if (content !== (htaccess?.content ?? '')) {
      if (Buffer.byteLength(content, 'utf8') > HTACCESS_MAX_BYTES) return report('conflict', flagged)
      await files.writeTextChecked(htaccessPath, content === '' ? null : content, htaccess)
    }
    this.applied.set(key, body.join('\n'))
    if (folder && flagged.length && entries) {
      const previous = this.state.get(key)?.flagged ?? []
      const fresh = flagged.filter(user => !previous.includes(user))
      if (folder.disableUsers && fresh.some(user => entries.some(entry => entry.username === user && !entry.passwordHash.startsWith('!')))) {
        const next = entries.map(entry => fresh.includes(entry.username) && !entry.passwordHash.startsWith('!') ? { ...entry, passwordHash: '!' + entry.passwordHash } : entry)
        await files.writeTextChecked(passwdPath, next.map(entry => entry.username + ':' + entry.passwordHash).join('\n') + '\n', passwd, 0o640)
        entries.splice(0, entries.length, ...next)
      }
      let alert: LeechAuditEntry['detail']['alert'] = 'none'
      if (folder.alertEmail && this.deps.sendAlert) for (const user of fresh) {
        const count = this.seen.get(key)?.get(user)?.size ?? 0
        try { await this.deps.sendAlert(folder.alertEmail, `Leech protection: ${user} on ${account.username}`, `The user ${user} of the protected folder ${path} signed in from ${count} addresses within two hours; the limit is ${folder.maxLogins}.\nRequests of this user are redirected to ${folder.redirectUrl}.${folder.disableUsers ? '\nThe user is disabled until a new password is set in Directory Privacy.' : ''}\n`); if (alert === 'none') alert = 'sent' }
        catch { alert = 'failed' }
      }
      if (fresh.length) await this.deps.audit?.({ actor: 'system', action: 'account.leech_protection.triggered', target: 'account:' + account.username, detail: { path, users: fresh, disabled: folder.disableUsers, alert }, outcome: 'ok' })
    }
    return report('applied', flagged)
  }

  /** Re-renders the folders of one account; `path` alone also clears a folder that was just turned off. */
  async applyAccount(accountId: string, path?: string): Promise<LeechFolderStatus[]> {
    return this.deps.store.withAccountLifecycleLease(accountId, async account => {
      const record = await this.record(account.id), files = await this.deps.files(account), out: LeechFolderStatus[] = []
      if (account.status !== 'active') return out
      const folders = record?.folders ?? []
      if (path !== undefined && !folders.some(folder => folder.path === path)) await this.applyFolder(account, null, path, files)
      for (const folder of folders) {
        const status = await this.applyFolder(account, folder, folder.path, files)
        if (status) out.push(status)
      }
      return out
    })
  }

  /** Live status without writing: what the last tick or apply observed. */
  async status(accountId: string): Promise<LeechFolderStatus[]> {
    const record = await this.record(accountId)
    return (record?.folders ?? []).map(folder => this.state.get(this.key(accountId, folder.path)) ?? { ...folder, state: 'pending' as const, flagged: this.flagged(accountId, folder), disabled: [] })
  }

  /** The minute tick: read new auth log lines, update windows, apply folders whose flagged users changed. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    // A failed tick repeats a minute later; the offset only moves past lines that were consumed.
    try { await this.step() } catch { /* retried on the next tick */ } finally { this.busy = false }
  }

  private async step(): Promise<void> {
    if (!this.deps.readLog) return
    const watched: Watched[] = []
    for (const accountId of await this.savedAccounts()) {
      const account = await this.deps.store.getAccount(accountId)
      if (!account || account.status !== 'active') continue
      let record: LeechRecord | null = null
      try { record = await this.record(account.id) } catch { continue }
      if (record?.folders.length) watched.push({ account, folders: record.folders, roots: directoryPrivacyRoots(account, await this.deps.store.listDomains({ accountId: account.id })) })
    }
    const chunk = await this.deps.readLog(Math.max(0, this.offset), MAX_READ)
    if (!chunk) return
    if (!watched.length) {
      // Nothing reads the log now; it still stays bounded, and the next watcher starts from the recent end.
      this.offset = -1
      if (chunk.size >= ROTATE_AT) await this.deps.truncateLog?.()
      return
    }
    // First read after start or a rotated log: begin at most one read size before the end.
    if (this.offset < 0 || chunk.ino !== this.ino || chunk.size < this.offset) {
      this.ino = chunk.ino
      const start = Math.max(0, chunk.size - MAX_READ)
      const again = start === Math.max(0, this.offset) ? chunk : await this.deps.readLog(start, MAX_READ)
      if (!again) return
      this.offset = start
      this.consume(again.text, watched, start > 0)
    } else this.consume(chunk.text, watched, false)
    for (const { account, folders } of watched) {
      const changed = folders.some(folder => renderLeechBlock(folder, this.flagged(account.id, folder)).join('\n') !== this.applied.get(this.key(account.id, folder.path)))
      if (changed) try { await this.applyAccount(account.id) } catch { /* retried on the next tick */ }
    }
    if (this.deps.truncateLog && this.offset >= ROTATE_AT) {
      const latest = await this.deps.readLog(this.offset, 1)
      if (latest && latest.size === this.offset) { await this.deps.truncateLog(); this.offset = 0 }
    }
  }

  private async savedAccounts(): Promise<string[]> {
    try { return (await readdir(join(this.deps.root, LEECH_STATE_DIR))).flatMap(name => /^[0-9a-f-]{36}\.json$/.test(name) ? [name.slice(0, 36)] : []) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }

  private consume(text: string, watched: readonly Watched[], skipFirst: boolean): void {
    const end = text.lastIndexOf('\n')
    if (end < 0) return
    const lines = text.slice(0, end).split('\n')
    this.offset += Buffer.byteLength(text.slice(0, end + 1), 'utf8')
    const cutoff = this.now() - LEECH_WINDOW_MS
    for (const raw of skipFirst ? lines.slice(1) : lines) {
      const line = parseAuthLogLine(raw)
      // 401 is a refused sign-in; 3xx/4xx after a valid sign-in still counts as a login from that address.
      if (!line || line.status === 401 || line.at < cutoff) continue
      for (const { account, folders, roots } of watched) {
        const root = roots.find(item => item.domain === line.vhost)
        if (!root) continue
        for (const folder of folders) {
          if (folder.path !== root.path && !folder.path.startsWith(root.path + '/')) continue
          const url = '/' + (folder.path === root.path ? '' : folder.path.slice(root.path.length + 1) + '/')
          if (!(line.path + '/').startsWith(url)) continue
          const key = this.key(account.id, folder.path), users = this.seen.get(key) ?? new Map<string, Map<string, number>>()
          this.seen.set(key, users)
          if (!users.has(line.user) && users.size >= extended.DIRECTORY_PRIVACY_MAX_USERS) continue
          const addresses = users.get(line.user) ?? new Map<string, number>()
          users.set(line.user, addresses)
          // Bounded per user: once over the limit the exact count above it does not matter.
          if (addresses.has(line.ip) || addresses.size <= folder.maxLogins + 16) addresses.set(line.ip, Math.max(addresses.get(line.ip) ?? 0, line.at))
        }
      }
    }
  }
}

/** Fixed-path access to the root-owned auth log: no symlink, and only the single-link regular file Apache created. */
const openAuthLog = async (flags: number) => {
  const handle = await open(edge.APACHE_AUTH_LOG, flags | constants.O_NOFOLLOW)
  const facts = await handle.stat()
  if (facts.isFile() && facts.uid === 0 && facts.nlink === 1) return { handle, facts }
  await handle.close()
  return fail('PRECONDITION_FAILED', 'the Apache auth log is not a protected file', unchanged)
}
export const nativeAuthLog = {
  async read(offset: number, max: number): Promise<{ ino: number; size: number; text: string } | null> {
    let log
    try { log = await openAuthLog(constants.O_RDONLY) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try {
      const length = Math.max(0, Math.min(max, log.facts.size - offset)), buffer = Buffer.alloc(length)
      if (length) await log.handle.read(buffer, 0, length, offset)
      return { ino: log.facts.ino, size: log.facts.size, text: buffer.toString('utf8') }
    } finally { await log.handle.close() }
  },
  async truncate(): Promise<void> {
    const log = await openAuthLog(constants.O_WRONLY)
    try { await log.handle.truncate(0) } finally { await log.handle.close() }
  },
}

/** Alert through the local MTA's sendmail interface; argv only, a fixed sender and a header-safe recipient. */
export const sendmailAlert = (sender: string, to: string, subject: string, text: string): Promise<void> => new Promise((resolve, reject) => {
  if (!EMAIL.test(to) || !EMAIL.test(sender) || /[\r\n]/.test(subject)) { reject(new Error('invalid_alert')); return }
  const child = spawn('/usr/sbin/sendmail', ['-i', '-f', sender, '--', to], { shell: false, stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } })
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  child.once('error', error => { clearTimeout(timer); reject(error) })
  child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('sendmail_failed')) })
  child.stdin.on('error', () => undefined)
  child.stdin.end(`From: xPanel <${sender}>\nTo: <${to}>\nSubject: ${subject}\nAuto-Submitted: auto-generated\nContent-Type: text/plain; charset=utf-8\n\n${text}`)
})

/** The daemon's monitor: confined account files, the fixed auth log and alerts from the server host name. */
export const createNativeLeechMonitor = (deps: Pick<LeechMonitorDeps, 'audit'> & { store: LeechMonitorDeps['store'] & Pick<LeechRouteDeps['store'], 'getPlan' | 'getServerSettings'> & { rootDir: string }; runner: AccountFileRunner }): LeechMonitor => new LeechMonitor({
  root: deps.store.rootDir, store: deps.store, readLog: nativeAuthLog.read, truncateLog: nativeAuthLog.truncate, ...(deps.audit ? { audit: deps.audit } : {}),
  files: async account => {
    const plan = await deps.store.getPlan(account.planId)
    return plan ? new JailedFileManager(account.home, effectivePlan(plan, account).resources.diskMb, { account, runner: deps.runner }) : fail('PRECONDITION_FAILED', 'the account plan is unavailable', unchanged)
  },
  sendAlert: async (to, subject, text) => { await sendmailAlert('xpanel@' + (await deps.store.getServerSettings())!.hostname, to, subject, text) },
})

export type LeechAgentRequest = { op: 'status' } | { op: 'apply'; path: string }
export function parseLeechAgentRequest(raw: unknown): LeechAgentRequest {
  if (object(raw) && raw.op === 'status' && exact(raw, ['op'])) return { op: 'status' }
  if (!object(raw) || raw.op !== 'apply' || !exact(raw, ['op', 'path'])) return fail('VALIDATION', 'unsupported leech protection request', unchanged)
  try { return { op: 'apply', path: extended.assertDirectoryPrivacyPath(raw.path) } } catch { return fail('VALIDATION', 'the folder must be a canonical path inside the account home', { ...unchanged, fields: [{ field: 'path', code: 'path' }] }) }
}

export interface LeechAgentView {
  context: { accountId: string; username: string }
  capabilities: { canSave: boolean; reason: 'engine' | 'monitor' | null }
  folders: LeechFolderStatus[]
}
export interface LeechRouteDeps {
  caller: { role: string; principalId: string; accountId: string | null }
  store: { getAccountByUsername(username: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; getServerSettings(): Promise<ServerSettings | null> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  /** Absent off a native Linux host: nothing observes sign-ins there, so nothing can be saved. */
  monitor: LeechMonitor | null
  readBody(req: Request): Promise<Record<string, unknown>>
}
const LEECH_ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/leech-protection$/

/** Account owner status and apply; the settings themselves are written by the API under the state writer lock. */
export async function handleLeechRoute(req: Request, url: URL, method: string, deps: LeechRouteDeps): Promise<Response | null> {
  const match = LEECH_ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (deps.caller.role !== 'user' || !deps.caller.accountId) return fail('FORBIDDEN', 'leech protection is managed by the signed-in account owner', unchanged)
  const body = parseLeechAgentRequest(await deps.readBody(req))
  const account = await deps.store.getAccountByUsername(match[1]!), principal = await deps.currentPrincipal()
  if (!account || account.id !== deps.caller.accountId || account.status !== 'active' || !principal || principal.disabled || principal.kind !== 'user' || principal.id !== deps.caller.principalId || principal.accountId !== account.id || principal.username !== account.username) return fail('FORBIDDEN', 'the current account caller is unavailable', unchanged)
  const plan = await deps.store.getPlan(account.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
  if (!features || features.disabled.some(key => key === 'directory-privacy' || key === 'leech-protection')) return fail('FORBIDDEN', 'Leech Protection is unavailable in the current plan', unchanged)
  const settings = await deps.store.getServerSettings(), reason = !deps.monitor ? 'monitor' as const : settings?.engine !== 'apache' ? 'engine' as const : null
  if (body.op === 'apply' && reason) return fail('PRECONDITION_FAILED', 'leech protection cannot be applied on this host', { ...unchanged, reason })
  const folders = !deps.monitor ? [] : body.op === 'apply' ? await deps.monitor.applyAccount(account.id, body.path) : await deps.monitor.status(account.id)
  const view: LeechAgentView = { context: { accountId: account.id, username: account.username }, capabilities: { canSave: reason === null, reason }, folders }
  return new Response(JSON.stringify(view), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
