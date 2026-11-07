import { randomUUID } from 'node:crypto'
import { chmod, chown, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { assertEmail, effectivePlan, fail } from '@xpanel/core'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { DEFAULT_BACKUP_DIR } from './account-backup.ts'
import { runBackupCommand } from './backup-low-priority.ts'
import type { BackupCommandRunner } from './backup-low-priority.ts'
import { authorizeOwnerTool } from './owner-tools.ts'
import { deriveSitePublisherTarget } from './site-publisher.ts'
import type { AgentCallerIdentity } from './server.ts'

/**
 * Website Backups: one site's document root plus chosen databases, kept in the root-only backup store. Files are
 * read and written by tar as the account, so a planted symlink reaches only what the account can reach. One
 * backup or restore runs per account at a time, and a backup is listed only once its manifest exists.
 */
export const WEBSITE_BACKUPS_FEATURE = 'website-backups'
export const MAX_SITE_BACKUPS = 10
export const WEBSITE_JOB_TIMEOUT_MS = 30 * 60_000
const STAMP = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/
const ARCHIVE = 'files.tar.gz', MANIFEST = 'manifest.json'
const unchanged = { stateChanged: false }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export interface WebsiteManifest { id: string; createdAt: string; path: string; bytes: number; databases: { name: string; sha256: string }[] }
export interface WebsiteDatabases {
  list(account: Account): Promise<string[]>
  dump(account: Account, database: string, outputPath: string): Promise<{ bytes: number; sha256: string }>
  restore(account: Account, database: string, inputPath: string, sha256: string): Promise<void>
}
export interface WebsiteBackupsContext {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; listDomains(): Promise<Domain[]> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  /** null off a Linux host: reads are empty and every write refuses */
  databases: WebsiteDatabases | null
  linuxHost: boolean
  run?: BackupCommandRunner
  root?: string
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; principalId: string }): Promise<unknown>
  /** through the local MTA; a failure is recorded in the audit entry and changes nothing else */
  sendEmail(to: string, subject: string, text: string): Promise<void>
}

/** Process-wide: at most one website job per account; a restart ends it with the process. */
const running = new Map<string, { id: string; kind: string; domainId: string }>()
export const websiteJob = (username: string): { id: string; kind: string; domainId: string } | null => running.get(username) ?? null

const siteDir = (root: string, username: string, domainId: string): string => posix.join(root, username, 'website', domainId)
const stampOf = (now: Date): string => now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + randomUUID().slice(0, 8)

const noticeAddress = (value: unknown): string => { try { return assertEmail(value, 'notify') } catch { return fail('VALIDATION', 'enter a valid email address', { ...unchanged, reason: 'invalid_email' }) } }
/** Fixed text with the site name only, so this route cannot carry a caller's message to the address it is given. */
export const websiteBackupNotice = (site: string, finished: boolean, at: Date): { subject: string; text: string } => {
  const when = at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  return finished ? { subject: 'Website backup finished: ' + site, text: `The backup of ${site} finished at ${when}.\nIt is listed under Website backups in your control panel.\n` }
    : { subject: 'Website backup failed: ' + site, text: `The backup of ${site} failed at ${when}. Nothing was kept.\nOpen Website backups in your control panel to run it again.\n` }
}

export async function listWebsiteBackups(root: string, username: string, domainId: string): Promise<WebsiteManifest[]> {
  const dir = siteDir(root, username, domainId), names = await readdir(dir).catch(() => [] as string[]), out: WebsiteManifest[] = []
  for (const id of names.filter(name => STAMP.test(name))) {
    try { out.push(JSON.parse(await readFile(posix.join(dir, id, MANIFEST), 'utf8')) as WebsiteManifest) } catch { /* no manifest: unfinished, never listed */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function ensureStoreDir(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); await chown(path, 0, 0) }

/** du as the account, so an unreadable or planted path can never make root walk elsewhere. */
async function bytesOf(run: BackupCommandRunner, account: Account, path: string): Promise<number | null> {
  const result = await run({ argv: ['/usr/bin/du', '-sb', '--', path], runAsUser: account.username, maxStdoutBytes: 4096, timeoutMs: 20_000 }).catch(() => null)
  const bytes = Number(result?.stdout.split(/\s/)[0])
  return result?.ok && Number.isSafeInteger(bytes) ? bytes : null
}

export interface WebsiteJobDeps { run: BackupCommandRunner; root: string; databases: WebsiteDatabases | null; now?: () => Date }

export async function createWebsiteBackup(deps: WebsiteJobDeps, account: Account, site: { domainId: string; path: string }, databases: readonly string[]): Promise<WebsiteManifest> {
  const dir = siteDir(deps.root, account.username, site.domainId), id = stampOf((deps.now ?? (() => new Date()))()), target = posix.join(dir, id)
  await ensureStoreDir(posix.join(deps.root, account.username, 'website')); await ensureStoreDir(dir); await ensureStoreDir(target)
  try {
    const files = await deps.run({ argv: ['/usr/bin/tar', '--create', '--gzip', '--file=-', '--directory=' + account.home, '--', site.path], runAsUser: account.username, stdoutPath: posix.join(target, ARCHIVE), maxStdoutBytes: 4 * 1024 ** 3, timeoutMs: WEBSITE_JOB_TIMEOUT_MS })
    // GNU tar exit 1 on create means a file changed while it was read; the member is still a complete copy.
    if (files.killed || files.code > 1) fail('PRECONDITION_FAILED', 'the site files could not be archived', { reason: 'archive_failed' })
    const dumped: WebsiteManifest['databases'] = []
    for (const name of databases) {
      if (!deps.databases) fail('PRECONDITION_FAILED', 'database dumps are unavailable on this host', { reason: 'database_unavailable' })
      dumped.push({ name, sha256: (await deps.databases!.dump(account, name, posix.join(target, name + '.sql'))).sha256 })
    }
    const manifest: WebsiteManifest = { id, createdAt: (deps.now ?? (() => new Date()))().toISOString(), path: site.path, bytes: files.stdoutBytes, databases: dumped }
    await writeFile(posix.join(target, MANIFEST), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' })
    for (const old of (await listWebsiteBackups(deps.root, account.username, site.domainId)).slice(MAX_SITE_BACKUPS)) await rm(posix.join(dir, old.id), { recursive: true, force: true })
    return manifest
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error }
}

const extractArgv = (home: string, keepNewer: boolean, directory = home): string[] => ['/usr/bin/tar', '--extract', '--gzip', '--file=-', '--directory=' + directory, '--no-same-owner', ...(keepNewer ? ['--keep-newer-files'] : [])]
const emptyArgv = (home: string, path: string): string[] => ['/usr/bin/find', posix.join(home, path), '-mindepth', '1', '-delete']

/** Merge overwrites and adds but keeps newer files; clean first empties the site, with a rollback archive of what was there. */
export async function restoreWebsiteBackup(deps: WebsiteJobDeps, account: Account, domainId: string, manifest: WebsiteManifest, mode: 'merge' | 'clean', restoreDatabases: boolean): Promise<{ restored: string[]; failed: string[] }> {
  const target = posix.join(siteDir(deps.root, account.username, domainId), manifest.id), archive = posix.join(target, ARCHIVE), asUser = { runAsUser: account.username, maxStdoutBytes: 65536, timeoutMs: WEBSITE_JOB_TIMEOUT_MS }
  const rollback = posix.join(target, `.rollback-${randomUUID()}.tar.gz`)
  try {
    if (mode === 'clean') {
      const saved = await deps.run({ argv: ['/usr/bin/tar', '--create', '--gzip', '--file=-', '--directory=' + account.home, '--', manifest.path], runAsUser: account.username, stdoutPath: rollback, maxStdoutBytes: 4 * 1024 ** 3, timeoutMs: WEBSITE_JOB_TIMEOUT_MS })
      if (saved.killed || saved.code > 1) fail('PRECONDITION_FAILED', 'the rollback archive could not be made; nothing was changed', { stateChanged: false, reason: 'rollback_failed' })
      await deps.run({ argv: emptyArgv(account.home, manifest.path), ...asUser })
    }
    const files = await deps.run({ argv: extractArgv(account.home, mode === 'merge'), stdinPath: archive, ...asUser })
    if (!files.ok) {
      if (mode === 'clean') await deps.run({ argv: extractArgv(account.home, false), stdinPath: rollback, ...asUser })
      fail('PRECONDITION_FAILED', 'the site files could not be restored', { stateChanged: mode === 'merge', verificationRequired: mode === 'merge', reason: 'restore_failed' })
    }
    const restored: string[] = [], failed: string[] = []
    if (restoreDatabases) for (const database of manifest.databases) {
      if (!deps.databases) { failed.push(database.name); continue }
      const snapshot = posix.join(target, `.rollback-${database.name}.sql`)
      try {
        const before = await deps.databases.dump(account, database.name, snapshot)
        try { await deps.databases.restore(account, database.name, posix.join(target, database.name + '.sql'), database.sha256); restored.push(database.name) }
        catch { await deps.databases.restore(account, database.name, snapshot, before.sha256).catch(() => undefined); failed.push(database.name) }
      } catch { failed.push(database.name) } finally { await rm(snapshot, { force: true }) }
    }
    return { restored, failed }
  } finally { await rm(rollback, { force: true }) }
}

/** Into a new folder of the home; the live site is not touched. */
export async function extractWebsiteBackup(deps: WebsiteJobDeps, account: Account, domainId: string, manifest: WebsiteManifest): Promise<string> {
  const folder = 'website-restore-' + manifest.id
  const made = await deps.run({ argv: ['/usr/bin/mkdir', posix.join(account.home, folder)], runAsUser: account.username, maxStdoutBytes: 4096 })
  if (!made.ok) fail('CONFLICT', 'the restore folder already exists', { ...unchanged, reason: 'folder_exists' })
  const files = await deps.run({ argv: extractArgv(account.home, false, posix.join(account.home, folder)), stdinPath: posix.join(siteDir(deps.root, account.username, domainId), manifest.id, ARCHIVE), runAsUser: account.username, maxStdoutBytes: 65536, timeoutMs: WEBSITE_JOB_TIMEOUT_MS })
  if (!files.ok) fail('PRECONDITION_FAILED', 'the backup could not be extracted', { stateChanged: true, reason: 'extract_failed' })
  return folder
}

const rootBackupTarget = async (store: WebsiteBackupsContext['store'], username: string): Promise<{ account: Account; plan: Plan }> => {
  const account = await store.getAccountByUsername(username), plan = account ? await store.getPlan(account.planId) : null
  return account && plan ? { account, plan } : fail('NOT_FOUND', 'account not found', unchanged)
}

export async function handleWebsiteBackupsRoute(req: Request, url: URL, method: string, ctx: WebsiteBackupsContext): Promise<Response | null> {
  const match = /^\/accounts\/([a-z][a-z0-9]{0,15})\/website-backups$/.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  // Root's bulk site backup comes through the API, which admitted root; it only creates.
  const { account, plan } = ctx.caller.role === 'root' && method === 'POST' ? await rootBackupTarget(ctx.store, match[1]!) : await authorizeOwnerTool(ctx, match[1]!, WEBSITE_BACKUPS_FEATURE)
  const root = ctx.root ?? DEFAULT_BACKUP_DIR, run = ctx.run ?? runBackupCommand, deps: WebsiteJobDeps = { run, root, databases: ctx.databases }
  const domains = (await ctx.store.listDomains()).filter(domain => domain.accountId === account.id && domain.kind !== 'alias' && !domain.suspended)
  const site = (id: unknown): { domainId: string; path: string } => {
    const domain = domains.find(item => item.id === id)
    return domain ? { domainId: domain.id, path: deriveSitePublisherTarget(account, domain).path } : fail('NOT_FOUND', 'the domain is not an active site of this account', unchanged)
  }
  if (method === 'GET') {
    const domainId = url.searchParams.get('domainId'), selected = domainId === null ? null : site(domainId)
    const manifests = selected ? await listWebsiteBackups(root, account.username, selected.domainId) : []
    const disk = effectivePlan(plan, account).resources.diskMb
    const estimate = selected && ctx.linuxHost ? await bytesOf(run, account, posix.join(account.home, selected.path)) : null, used = selected && ctx.linuxHost ? await bytesOf(run, account, account.home) : null
    const remaining = disk === 'unlimited' || used === null ? null : disk * 1024 * 1024 - used
    return json(200, { context: { accountId: account.id }, domains: domains.map(domain => ({ id: domain.id, name: domain.name })), databases: ctx.databases ? await ctx.databases.list(account).catch(() => []) : [], contactEmail: account.contactEmail, job: websiteJob(account.username),
      selected: selected ? { domainId: selected.domainId, estimateBytes: estimate, remainingBytes: remaining, fits: estimate === null || remaining === null ? null : estimate <= remaining, backups: manifests.map(({ id, createdAt, bytes, databases }) => ({ id, createdAt, bytes, databases: databases.map(item => item.name) })) } : null })
  }
  if (!ctx.linuxHost) return fail('PRECONDITION_FAILED', 'website backups need a Linux host', unchanged)
  let body: Record<string, unknown>
  try { body = JSON.parse(await req.text()) as Record<string, unknown> } catch { return fail('VALIDATION', 'request body must be JSON', unchanged) }
  const chosen = site(body?.domainId), op = body?.op
  const manifest = async (): Promise<WebsiteManifest> => (await listWebsiteBackups(root, account.username, chosen.domainId)).find(item => item.id === body.id) ?? fail('NOT_FOUND', 'backup not found', unchanged)
  if (op === 'delete') {
    const ids = body.ids
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_SITE_BACKUPS || !ids.every(id => typeof id === 'string' && STAMP.test(id))) return fail('VALIDATION', 'choose the backups to delete', unchanged)
    for (const id of ids as string[]) await rm(posix.join(siteDir(root, account.username, chosen.domainId), id), { recursive: true, force: true })
    return json(200, { deleted: ids.length })
  }
  if (!['create', 'restore', 'extract'].includes(op as string) || ctx.caller.role === 'root' && op !== 'create') return fail('VALIDATION', 'unknown website backup operation', unchanged)
  if (running.has(account.username)) return fail('CONFLICT', 'a website backup or restore is already running for this account', { ...unchanged, reason: 'OPERATION_IN_PROGRESS' })
  const known = op === 'create' ? null : await manifest()
  if (op === 'restore' && !['merge', 'clean'].includes(body.mode as string)) return fail('VALIDATION', 'mode must be merge or clean', unchanged)
  const wanted = op === 'create' ? body.databases : []
  if (!Array.isArray(wanted) || !wanted.every(name => typeof name === 'string') || wanted.length && !ctx.databases) return fail('VALIDATION', 'choose databases of this account', unchanged)
  const own = ctx.databases && wanted.length ? await ctx.databases.list(account) : []
  if ((wanted as string[]).some(name => !own.includes(name))) return fail('VALIDATION', 'choose databases of this account', { ...unchanged, reason: 'foreign_database' })
  const notify = op === 'create' && body.notify !== null && body.notify !== undefined ? noticeAddress(body.notify) : null
  const id = randomUUID()
  running.set(account.username, { id, kind: op as string, domainId: chosen.domainId })
  const audit = (outcome: 'ok' | 'failed', detail: Record<string, unknown>) => ctx.audit({ actor: ctx.caller.actor, principalId: ctx.caller.principalId, action: 'account.website-backup.' + op, target: 'account:' + account.username, outcome, detail: { domainId: chosen.domainId, ...detail } }).catch(() => {})
  const report = async (finished: boolean): Promise<Record<string, boolean>> => {
    if (!notify) return {}
    const notice = websiteBackupNotice(domains.find(domain => domain.id === chosen.domainId)!.name, finished, new Date())
    return ctx.sendEmail(notify, notice.subject, notice.text).then(() => ({ emailed: true }), () => ({ emailed: false }))
  }
  void (async () => {
    try {
      const result = op === 'create' ? { id: (await createWebsiteBackup(deps, account, chosen, wanted as string[])).id }
        : op === 'restore' ? await restoreWebsiteBackup(deps, account, chosen.domainId, known!, body.mode as 'merge' | 'clean', body.databases !== false)
          : { folder: await extractWebsiteBackup(deps, account, chosen.domainId, known!) }
      await audit('ok', { result, ...await report(true) })
    } catch (error) { await audit('failed', { code: (error as { code?: string }).code ?? 'failed', ...await report(false) }) } finally { running.delete(account.username) }
  })()
  return json(202, { operationId: id, kind: op })
}
