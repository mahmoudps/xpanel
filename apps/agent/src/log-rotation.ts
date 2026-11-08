import { constants } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { fail, logTweakValues, parseTweakValues, TWEAK_SETTINGS_STATE } from '@xpanel/core'
import type { Account, AccountLogSettings, LogTweakValues } from '@xpanel/core'
import { edge, system } from '@xpanel/render'
import { readJsonIfExists } from '@xpanel/state'
import type { ConfigTestResult } from './executor.ts'
import { rotatedLogPath, type BandwidthCollection } from './metering.ts'

export const LOG_ROTATION_STATE_PATH = '/var/lib/xpanel/log-rotation.json'
/** Root-owned staging the account reads through its group: <dir>/<username>/<archive>. */
export const LOG_ARCHIVE_STAGING_DIR = '/var/lib/xpanel-log-archive'
/** Root-only holding area beside the rotated site logs: <dir>/<username>/<archive>, kept until the copy into ~/logs succeeds. */
export const LOG_HELD_DIR = edge.XP_PATHS.nginxLogDir + '/held'
/** The account's archive directory below its home (cPanel ~/logs). */
export const ACCOUNT_LOG_ARCHIVE_DIR = 'logs'
export const LOG_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024
const LOG_ARCHIVE_LIST_MAX = 2000
const HELD_LIST_MAX = 10_000
const FAILURES_KEPT = 50
/** Reopens every nginx log file; the master signals its workers. */
export const NGINX_REOPEN_COMMAND = ['/usr/bin/systemctl', 'kill', '--kill-whom=main', '--signal=USR1', 'nginx.service'] as const
const ARCHIVE_NAME = /^([a-z0-9][a-z0-9.-]{0,252})-(\d{4}-\d{2}-\d{2})(?:-([2-9]))?\.gz$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const DEFAULTS: LogTweakValues = logTweakValues({})

export interface LogArchive { name: string; site: string; day: string; sizeBytes: number; mtime: string }
export interface LogRotationFailure { username: string; site: string; reason: string; at: string }
/** held: archives still waiting for their copy into ~/logs after the run; lost: held archives removed undelivered (expired or evicted). */
export interface LogRotationRun { at: string; rotated: number; archived: number; deleted: number; removedArchives: number; failures: number; held: number; lost: number }
/** A rotated, counted site log compressed into the holding area because its copy into ~/logs has not succeeded yet. */
export interface HeldLog { username: string; name: string; sizeBytes: number; heldAt: string }
/** Undelivered archives of one account: always reported with the stable code archive_pending and the last copy failure. */
export interface LogRotationPending { username: string; code: 'archive_pending'; count: number; bytes: number; oldest: string; reason: string }
export interface LogRotationState {
  /** Per site log path: its account and the UTC day its current file started. */
  sites: Record<string, { accountId: string; day: string; archiveDay?: string }>
  /** Per account id: the UTC day its held archives were last retried and its archives purged. */
  purged: Record<string, string>
  /** Per held archive (username/name): the last copy failure and how often the copy was tried. */
  held: Record<string, { reason: string; attempts: number }>
  lastRun: LogRotationRun | null
  failures: LogRotationFailure[]
}
export const emptyLogRotationState = (): LogRotationState => ({ sites: {}, purged: {}, held: {}, lastRun: null, failures: [] })
const RUN_COUNTS = ['rotated', 'archived', 'deleted', 'removedArchives', 'failures', 'held', 'lost'] as const

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
/** A malformed state file is not trusted: sites start their day again and nothing is purged twice on the same day. */
export function parseLogRotationState(raw: unknown): LogRotationState {
  if (!record(raw) || !record(raw.sites) || !record(raw.purged) || !Array.isArray(raw.failures)) return emptyLogRotationState()
  const sites: LogRotationState['sites'] = {}
  for (const [path, v] of Object.entries(raw.sites)) if (record(v) && typeof v.accountId === 'string' && typeof v.day === 'string' && DAY.test(v.day) && (v.archiveDay === undefined || typeof v.archiveDay === 'string' && DAY.test(v.archiveDay))) sites[path] = { accountId: v.accountId, day: v.day, ...(v.archiveDay ? { archiveDay: v.archiveDay as string } : {}) }
  const purged = Object.fromEntries(Object.entries(raw.purged).filter(([, day]) => typeof day === 'string' && DAY.test(day))) as Record<string, string>
  const held = Object.fromEntries(Object.entries(record(raw.held) ? raw.held : {}).filter(([, v]) => record(v) && typeof v.reason === 'string' && count(v.attempts))) as LogRotationState['held']
  const run = raw.lastRun
  const lastRun = record(run) && typeof run.at === 'string' && RUN_COUNTS.every(key => count(run[key])) ? run as unknown as LogRotationRun : null
  const failures = raw.failures.filter((v): v is LogRotationFailure => record(v) && typeof v.username === 'string' && typeof v.site === 'string' && typeof v.reason === 'string' && typeof v.at === 'string').slice(-FAILURES_KEPT)
  return { sites, purged, held, lastRun, failures }
}

export const archiveName = (site: string, day: string, n = 1): string => `${edge.assertDomainName(site)}-${day}${n > 1 ? '-' + n : ''}.gz`
export const parseArchiveName = (name: string): { site: string; day: string } | null => {
  const match = ARCHIVE_NAME.exec(name)
  return match ? { site: match[1]!, day: match[2]! } : null
}

/** The Logs section of the saved Tweak Settings; an unreadable file gives the defaults, which never delete an archive. */
export async function readLogTweaks(stateRoot: string): Promise<LogTweakValues> {
  try { return logTweakValues(parseTweakValues(await readJsonIfExists<unknown>(join(stateRoot, TWEAK_SETTINGS_STATE)))) }
  catch { return DEFAULTS }
}
export const effectiveLogSettings = (account: Pick<Account, 'logs'>, defaults: AccountLogSettings): AccountLogSettings => account.logs ?? defaults

const dayBefore = (day: string): string => new Date(Date.parse(day + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10)
const daysBefore = (day: string, days: number): string => new Date(Date.parse(day + 'T00:00:00Z') - days * 86_400_000).toISOString().slice(0, 10)

/** Archives the settings remove on `today`: those older than the retention, and with removePreviousMonthArchive those of earlier months. */
export function archivesToRemove(archives: readonly Pick<LogArchive, 'name' | 'day'>[], settings: AccountLogSettings, today: string): string[] {
  const oldest = settings.retentionDays === null ? null : daysBefore(today, settings.retentionDays)
  return archives.filter(archive => (oldest !== null && archive.day < oldest) || (settings.removePreviousMonthArchive && archive.day.slice(0, 7) < today.slice(0, 7))).map(archive => archive.name)
}

export interface HeldPlan { retry: HeldLog[]; expire: HeldLog[]; evict: HeldLog[] }
/**
 * What happens to the holding area: archives older than the server's hold days expire, then the oldest go first until the
 * rest fits the byte bound; of what is left, the archives of the accounts in `retry` are copied again. Expired and evicted
 * archives are losses the caller reports.
 */
export function planHeldLogs(held: readonly HeldLog[], opts: { now: Date; holdDays: number; maxBytes: number; retry: ReadonlySet<string> }): HeldPlan {
  const oldest = opts.now.getTime() - opts.holdDays * 86_400_000
  const ordered = [...held].sort((a, b) => a.heldAt.localeCompare(b.heldAt) || a.name.localeCompare(b.name))
  const expire = ordered.filter(item => Date.parse(item.heldAt) < oldest), kept = ordered.filter(item => Date.parse(item.heldAt) >= oldest)
  let bytes = kept.reduce((sum, item) => sum + item.sizeBytes, 0)
  const evict: HeldLog[] = []
  while (bytes > opts.maxBytes && kept.length) { const item = kept.shift()!; evict.push(item); bytes -= item.sizeBytes }
  return { retry: kept.filter(item => opts.retry.has(item.username)), expire, evict }
}

/** The pending archives per account, with the last copy failure recorded for them. */
export function pendingOf(held: readonly HeldLog[], reasons: LogRotationState['held']): LogRotationPending[] {
  const out = new Map<string, LogRotationPending>()
  for (const item of [...held].sort((a, b) => a.heldAt.localeCompare(b.heldAt))) {
    const entry = out.get(item.username) ?? { username: item.username, code: 'archive_pending' as const, count: 0, bytes: 0, oldest: item.heldAt, reason: 'archive_failed' }
    entry.count++; entry.bytes += item.sizeBytes
    entry.reason = reasons[item.username + '/' + item.name]?.reason ?? entry.reason
    out.set(item.username, entry)
  }
  return [...out.values()].sort((a, b) => a.username.localeCompare(b.username))
}

/** Why one copy into ~/logs failed, from the jailed install's exit and message. */
export const copyFailure = (result: ConfigTestResult | null): string =>
  !result ? 'archive_failed' : /quota/i.test(result.stderr) ? 'archive_quota_exceeded'
    : /No such file|Not a directory|Permission denied|Read-only file system/i.test(result.stderr) ? 'archive_home_unavailable' : result.ok ? 'archive_unverified' : 'archive_failed'

type JailAccount = Pick<Account, 'username' | 'uid' | 'gid' | 'home'>
const archiveDir = (account: Pick<Account, 'home'>): string => posix.join(account.home, ACCOUNT_LOG_ARCHIVE_DIR)
export const stagingDir = (account: Pick<Account, 'username'>): string => posix.join(LOG_ARCHIVE_STAGING_DIR, account.username)
export type LogArchiveOperation = { kind: 'install'; name: string } | { kind: 'remove'; names: readonly string[] }

/** As the account, in its slice and home namespace: copy a staged archive into ~/logs, or remove archives there. */
export function buildLogArchiveCommand(account: JailAccount, op: LogArchiveOperation): string[] {
  const skeleton = system.buildJailedFileOpArgv(account, ['/usr/bin/id'])
  const prefix = skeleton.slice(0, skeleton.lastIndexOf('--') + 1), dir = archiveDir(account)
  const names = op.kind === 'install' ? [op.name] : [...op.names]
  if (names.length < 1 || names.length > 64 || names.some(name => !parseArchiveName(name))) return fail('VALIDATION', 'invalid log archive name', { stateChanged: false })
  return op.kind === 'install'
    ? [...prefix, '/usr/bin/install', '-D', '-m', '0640', '-T', '--', posix.join(stagingDir(account), op.name), posix.join(dir, op.name)]
    : [...prefix, '/usr/bin/rm', '-f', '--', ...names.map(name => posix.join(dir, name))]
}

/** Exact outer admission of buildLogArchiveCommand and the nginx reopen; it approves no other systemd-run, user, path or binary. */
export function isLogRotationCommand(argv: readonly string[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  if (argv.length === NGINX_REOPEN_COMMAND.length && argv.every((value, index) => value === NGINX_REOPEN_COMMAND[index])) return true
  const delimiter = argv.indexOf('--'), command = argv.slice(delimiter + 1)
  const bound = argv.find(value => value.startsWith('BindPaths='))?.slice(10), user = bound?.match(/^\/home[1-9]?[0-9]?\/([a-z][a-z0-9]{0,15})$/)?.[1]
  const uid = Number(argv.find(value => /^Slice=xpanel-[0-9]+\.slice$/.test(value))?.slice(13, -6))
  if (delimiter < 1 || !user || !Number.isSafeInteger(uid)) return false
  const account = { username: user, uid, gid: uid, home: bound! }
  try {
    const op: LogArchiveOperation = command[0] === '/usr/bin/install' ? { kind: 'install', name: posix.basename(command.at(-1) ?? '') }
      : { kind: 'remove', names: command.slice(3).map(path => posix.basename(path)) }
    const expected = buildLogArchiveCommand(account, op)
    return expected.length === argv.length && expected.every((value, index) => value === argv[index])
  } catch { return false }
}

export interface LogFileFacts { identity: string; sizeBytes: number }
export interface LogRotationDeps {
  readState: () => Promise<{ accounts: readonly Account[] }>
  readTweaks: () => Promise<LogTweakValues>
  readRotation: () => Promise<unknown>
  writeRotation: (state: LogRotationState) => Promise<void>
  /** The protected edge log at path, or null when it is absent. */
  stat: (path: string) => Promise<LogFileFacts | null>
  rename: (from: string, to: string) => Promise<void>
  unlink: (path: string) => Promise<void>
  /** Signals nginx to reopen its logs. */
  reopen: () => Promise<ConfigTestResult>
  /** Compresses a counted rotated log into the root-only holding area as `name`; returns its size. */
  hold: (account: Account, source: string, name: string) => Promise<number>
  /** Every archive in the holding area, bounded. */
  listHeld: () => Promise<HeldLog[]>
  unhold: (username: string, name: string) => Promise<void>
  /** Copies a held archive into the account's staging directory, readable by the account group only; returns its size. */
  stage: (account: Account, name: string) => Promise<number>
  unstage: (account: Account, name: string) => Promise<void>
  /** Runs an admitted buildLogArchiveCommand argv. */
  run: (argv: string[]) => Promise<ConfigTestResult>
  /** The archives in ~/logs, or null when it is not a directory the account owns. */
  listArchives: (account: Account) => Promise<LogArchive[] | null>
  /** Polls until nginx has created a reopened log, bounded. */
  waitForReopen?: (paths: readonly string[]) => Promise<void>
}

/**
 * Daily raw access log rotation after metering (cPanel Raw Access archiving). A site log is renamed only while the meter
 * follows that file; nginx then reopens a new one and the meter counts the renamed copy's last lines on its next
 * collection (metering.ts). Only a copy the meter no longer follows is archived, or deleted when the account does not
 * archive, so no counted line is lost and none is counted twice. An archive is compressed into the root-only holding area
 * first and leaves it only once its copy into ~/logs as the account is verified; a failed copy (quota, unavailable home)
 * is retried on the account's next daily run. The holding area is bounded by the server's hold days and bytes; an archive
 * removed undelivered is reported as lost. Archives in ~/logs are then purged by the account's retention settings.
 */
export function createLogRotation(deps: LogRotationDeps) {
  let active: Promise<LogRotationRun> | undefined
  const runOnce = async (collected: BandwidthCollection): Promise<LogRotationRun> => {
    const at = collected.at.toISOString(), today = at.slice(0, 10)
    const [state, saved, tweaks] = [parseLogRotationState(await deps.readRotation()), await deps.readState(), await deps.readTweaks()]
    const accounts = new Map(saved.accounts.filter(account => account.status !== 'terminating').map(account => [account.id, account]))
    const run: LogRotationRun = { at, rotated: 0, archived: 0, deleted: 0, removedArchives: 0, failures: 0, held: 0, lost: 0 }
    const failed = (account: Account, site: string, reason: string): void => { run.failures++; state.failures = [...state.failures, { username: account.username, site, reason, at }].slice(-FAILURES_KEPT) }
    const reason = (username: string, name: string): string => username + '/' + name
    // Archives held by this run had their first copy already; their retry waits for the account's next daily run.
    const fresh = new Set<string>()
    // One verified copy of a held archive into ~/logs; a failure keeps it held with its reason for the next daily retry.
    const deliver = async (account: Account, name: string): Promise<boolean> => {
      let result: ConfigTestResult | null = null, delivered = false
      try {
        const size = await deps.stage(account, name)
        result = await deps.run(buildLogArchiveCommand(account, { kind: 'install', name }))
        delivered = result.ok && (await deps.listArchives(account))?.some(entry => entry.name === name && entry.sizeBytes === size) === true
      } catch { delivered = false }
      await deps.unstage(account, name).catch(() => undefined)
      const key = reason(account.username, name)
      if (delivered) { await deps.unhold(account.username, name); delete state.held[key]; run.archived++; return true }
      const why = copyFailure(result)
      state.held[key] = { reason: why, attempts: (state.held[key]?.attempts ?? 0) + 1 }
      failed(account, parseArchiveName(name)?.site ?? '', why)
      return false
    }
    const archive = async (account: Account, site: string, rotated: string, day: string): Promise<void> => {
      if (!effectiveLogSettings(account, tweaks.defaults).archive) { await deps.unlink(rotated); run.deleted++; return }
      const taken = new Set([...(await deps.listArchives(account).catch(() => null) ?? []).map(entry => entry.name),
        ...(await deps.listHeld()).filter(entry => entry.username === account.username).map(entry => entry.name)])
      const name = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => archiveName(site, day, n)).find(candidate => !taken.has(candidate))
      // The copy is counted already; with every name of the day taken it cannot be kept apart, which is reported.
      if (!name) { await deps.unlink(rotated); failed(account, site, 'archive_name_taken'); return }
      // Without a protected holding area the rotated copy stays where it is: nothing counted is deleted.
      try { await deps.hold(account, rotated, name) } catch { failed(account, site, 'hold_unavailable'); return }
      await deps.unlink(rotated)
      fresh.add(reason(account.username, name))
      await deliver(account, name)
    }
    const renamed: { path: string; account: Account; site: string }[] = []
    for (const { path, accountId, site } of collected.sites) {
      const account = accounts.get(accountId)
      if (!account) continue
      const rotated = rotatedLogPath(path), [copy, current] = [await deps.stat(rotated), await deps.stat(path)]
      if (copy) {
        // nginx never reopened: put the copy back where it still writes, before anything treats it as finished.
        if (!current) { await deps.rename(rotated, path); failed(account, site, 'reopen_unverified'); continue }
        if (collected.cursors[path]?.identity === copy.identity) continue
        const entry = state.sites[path]
        await archive(account, site, rotated, entry?.archiveDay ?? dayBefore(today))
        if (entry) state.sites[path] = { accountId: entry.accountId, day: entry.day }
        continue
      }
      const entry = state.sites[path]
      if (!current || current.sizeBytes === 0 || !entry || entry.accountId !== accountId) { if (!entry || entry.accountId !== accountId) state.sites[path] = { accountId, day: today }; continue }
      // Due once per UTC day, and only while the meter follows this very file.
      if (entry.day >= today || collected.cursors[path]?.identity !== current.identity) continue
      await deps.rename(path, rotated)
      state.sites[path] = { accountId, day: today, archiveDay: entry.day }
      renamed.push({ path, account, site })
    }
    if (renamed.length) {
      const reopened = await deps.reopen().catch(() => null)
      if (reopened?.ok) await deps.waitForReopen?.(renamed.map(entry => entry.path)).catch(() => undefined)
      for (const entry of renamed) {
        if (reopened?.ok && await deps.stat(entry.path)) { run.rotated++; continue }
        if (!await deps.stat(entry.path)) await deps.rename(rotatedLogPath(entry.path), entry.path)
        failed(entry.account, entry.site, 'reopen_failed')
      }
    }
    const due = new Set<string>()
    for (const account of accounts.values()) {
      if (state.purged[account.id] === today) continue
      state.purged[account.id] = today
      due.add(account.username)
    }
    const byName = new Map([...accounts.values()].map(account => [account.username, account]))
    const losses = async (removed: readonly HeldLog[], why: 'held_expired' | 'held_evicted'): Promise<void> => {
      for (const item of removed) {
        await deps.unhold(item.username, item.name)
        delete state.held[reason(item.username, item.name)]
        run.lost++; run.failures++
        state.failures = [...state.failures, { username: item.username, site: parseArchiveName(item.name)?.site ?? '', reason: why, at }].slice(-FAILURES_KEPT)
      }
    }
    const bound = { now: collected.at, holdDays: tweaks.hold.days, maxBytes: tweaks.hold.maxBytes }
    const plan = planHeldLogs(await deps.listHeld(), { ...bound, retry: due })
    await losses(plan.expire, 'held_expired'); await losses(plan.evict, 'held_evicted')
    for (const item of plan.retry) {
      const account = byName.get(item.username)
      if (!account || fresh.has(reason(item.username, item.name))) continue
      if (effectiveLogSettings(account, tweaks.defaults).archive) await deliver(account, item.name)
      else { await deps.unhold(item.username, item.name); delete state.held[reason(item.username, item.name)]; run.deleted++ }
    }
    for (const account of accounts.values()) {
      if (!due.has(account.username)) continue
      const archives = await deps.listArchives(account).catch(() => null)
      if (!archives) continue
      const remove = archivesToRemove(archives, effectiveLogSettings(account, tweaks.defaults), today)
      for (let index = 0; index < remove.length; index += 64) {
        const names = remove.slice(index, index + 64), result = await deps.run(buildLogArchiveCommand(account, { kind: 'remove', names })).catch(() => null)
        if (result?.ok) run.removedArchives += names.length
        else failed(account, '', 'purge_failed')
      }
    }
    // Archives held by this run count against the same bound at once, so the area never stays above it.
    const after = planHeldLogs(await deps.listHeld(), { ...bound, retry: new Set() })
    await losses(after.expire, 'held_expired'); await losses(after.evict, 'held_evicted')
    const held = await deps.listHeld(), keys = new Set(held.map(item => reason(item.username, item.name)))
    for (const key of Object.keys(state.held)) if (!keys.has(key)) delete state.held[key]
    run.held = held.length
    for (const path of Object.keys(state.sites)) if (!collected.sites.some(site => site.path === path)) delete state.sites[path]
    for (const id of Object.keys(state.purged)) if (!accounts.has(id)) delete state.purged[id]
    state.lastRun = run
    await deps.writeRotation(state)
    return run
  }
  return {
    /** One run at a time; the meter calls it after each recorded collection. */
    run(collected: BandwidthCollection): Promise<LogRotationRun> {
      active ??= runOnce(collected).finally(() => { active = undefined })
      return active
    },
    async status(): Promise<Pick<LogRotationState, 'lastRun' | 'failures'> & { pending: LogRotationPending[]; hold: LogTweakValues['hold'] }> {
      const [{ lastRun, failures, held }, items, tweaks] = [parseLogRotationState(await deps.readRotation()), await deps.listHeld(), await deps.readTweaks()]
      return { lastRun, failures, pending: pendingOf(items, held), hold: tweaks.hold }
    },
  }
}
export type LogRotation = ReturnType<typeof createLogRotation>

/** Root read of ~/logs: the directory and each archive must be the account's own, never a link or a hard link. */
export async function listAccountLogArchives(account: Pick<Account, 'home' | 'uid'>): Promise<LogArchive[] | null> {
  const dir = archiveDir(account)
  const info = await lstat(dir).catch(() => null)
  if (!info || !info.isDirectory() || info.isSymbolicLink() || info.uid !== account.uid) return null
  const out: LogArchive[] = []
  for (const name of (await readdir(dir)).slice(0, LOG_ARCHIVE_LIST_MAX * 4)) {
    const parsed = parseArchiveName(name)
    if (!parsed) continue
    const file = await lstat(posix.join(dir, name)).catch(() => null)
    if (file?.isFile() && file.uid === account.uid && file.nlink === 1) out.push({ name, ...parsed, sizeBytes: file.size, mtime: file.mtime.toISOString() })
    if (out.length >= LOG_ARCHIVE_LIST_MAX) break
  }
  return out.sort((a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name))
}

/** Opens one archive for download as root: owner, link count and the directory identity are checked on the open file. */
export async function openAccountLogArchive(account: Pick<Account, 'home' | 'uid'>, name: string) {
  if (!parseArchiveName(name)) return fail('NOT_FOUND', 'log archive not found', { stateChanged: false })
  const dir = archiveDir(account), before = await lstat(dir).catch(() => null)
  if (!before?.isDirectory() || before.isSymbolicLink() || before.uid !== account.uid) return fail('NOT_FOUND', 'log archive not found', { stateChanged: false })
  const handle = await open(posix.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null)
  if (!handle) return fail('NOT_FOUND', 'log archive not found', { stateChanged: false })
  const [file, after] = await Promise.all([handle.stat(), lstat(dir).catch(() => null)])
  if (!file.isFile() || file.uid !== account.uid || file.nlink !== 1 || file.size > LOG_ARCHIVE_MAX_BYTES || !after || after.ino !== before.ino || after.dev !== before.dev) {
    await handle.close(); return fail('NOT_FOUND', 'log archive not found', { stateChanged: false })
  }
  return { handle, sizeBytes: file.size }
}

const identityOf = async (path: string): Promise<LogFileFacts | null> => {
  const info = await lstat(path).catch(() => null)
  return info?.isFile() ? { identity: info.dev + ':' + info.ino, sizeBytes: info.size } : null
}
const inEdgeLogDir = (path: string): string => {
  if (posix.dirname(path) !== edge.XP_PATHS.nginxLogDir || !/^[a-z0-9.-]+\.access\.log(?:\.1)?$/.test(posix.basename(path))) return fail('PRECONDITION_FAILED', 'the log path is not an xPanel site access log', { stateChanged: false })
  return path
}

const assertHeldUser = (username: string): string => /^[a-z][a-z0-9]{0,15}$/.test(username) ? username : fail('VALIDATION', 'invalid account username', { stateChanged: false })
const heldName = (name: string): string => parseArchiveName(name) ? name : fail('VALIDATION', 'invalid log archive name', { stateChanged: false })
const isProtected = (info: Awaited<ReturnType<typeof lstat>> | null): boolean => !!info && info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && (Number(info.mode) & 0o022) === 0

/** Every ancestor is a root-owned real directory, and none below /var/log/xpanel is writable by another user (as account-logs.ts reads the edge logs). */
async function rootAncestors(path: string): Promise<boolean> {
  for (let current = posix.dirname(path); current !== '/'; current = posix.dirname(current)) {
    const info = await lstat(current).catch(() => null)
    if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || current.startsWith('/var/log/xpanel') && (Number(info.mode) & 0o022) !== 0) return false
  }
  return true
}

/** Creates or checks a root-owned directory no other user can change, then sets its group and mode. */
async function protectedDir(path: string, mode: number, gid: number): Promise<string> {
  if (!await rootAncestors(path)) return fail('PRECONDITION_FAILED', 'the log holding directory is not protected', { stateChanged: false, reason: 'hold_unavailable' })
  await mkdir(path, { mode }).catch(error => { if (error?.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0) return fail('PRECONDITION_FAILED', 'the log holding directory is not protected', { stateChanged: false })
  await chown(path, 0, gid); await chmod(path, mode)
  return path
}

/** Root copy between protected directories through a .part file, compressed or as is; returns the published size. */
async function writeFrom(source: string, target: string, mode: number, gid: number, gzip: boolean): Promise<number> {
  const part = target + '.part'
  const from = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  const to = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode)
  try {
    await to.chown(0, gid)
    const read = from.createReadStream({ autoClose: false }), write = to.createWriteStream({ autoClose: false })
    await (gzip ? pipeline(read, createGzip({ level: 6 }), write) : pipeline(read, write))
    await to.sync()
  } finally { await Promise.all([from.close(), to.close()]) }
  await rename(part, target)
  return (await lstat(target)).size
}

/** Every held archive, oldest first, from the root-only holding area; anything else in it is ignored. */
export async function listHeldLogs(root = LOG_HELD_DIR): Promise<HeldLog[]> {
  if (!isProtected(await lstat(root).catch(() => null)) || !await rootAncestors(root)) return []
  const out: HeldLog[] = []
  for (const username of (await readdir(root)).filter(name => /^[a-z][a-z0-9]{0,15}$/.test(name)).sort()) {
    const dir = posix.join(root, username)
    if (!isProtected(await lstat(dir).catch(() => null))) continue
    for (const name of (await readdir(dir)).filter(name => parseArchiveName(name)).sort()) {
      const file = await lstat(posix.join(dir, name)).catch(() => null)
      if (file?.isFile() && file.uid === 0 && file.nlink === 1) out.push({ username, name, sizeBytes: file.size, heldAt: file.mtime.toISOString() })
      if (out.length >= HELD_LIST_MAX) return out
    }
  }
  return out
}

/** The held archives of one account for its Raw Access page; null when none wait. */
export async function readHeldPending(username: string): Promise<LogRotationPending | null> {
  const [held, state] = await Promise.all([listHeldLogs(), readJsonIfExists<unknown>(LOG_ROTATION_STATE_PATH).catch(() => null)])
  return pendingOf(held.filter(item => item.username === username), parseLogRotationState(state).held)[0] ?? null
}

/** The native host side of createLogRotation. */
export function nativeLogRotationDeps(input: Pick<LogRotationDeps, 'readState' | 'readTweaks' | 'readRotation' | 'writeRotation'> & { runCommand: (argv: string[]) => Promise<ConfigTestResult> }): LogRotationDeps {
  return {
    ...input,
    stat: path => identityOf(inEdgeLogDir(path)),
    rename: (from, to) => rename(inEdgeLogDir(from), inEdgeLogDir(to)),
    unlink: path => unlink(inEdgeLogDir(path)),
    reopen: () => input.runCommand([...NGINX_REOPEN_COMMAND]),
    waitForReopen: async paths => { for (let tries = 0; tries < 20; tries++) { if ((await Promise.all(paths.map(identityOf))).every(Boolean)) return; await new Promise(resolve => setTimeout(resolve, 100)) } },
    hold: async (account, source, name) => {
      await protectedDir(LOG_HELD_DIR, 0o700, 0)
      const dir = await protectedDir(posix.join(LOG_HELD_DIR, assertHeldUser(account.username)), 0o700, 0)
      return writeFrom(inEdgeLogDir(source), posix.join(dir, heldName(name)), 0o600, 0, true)
    },
    listHeld: () => listHeldLogs(),
    unhold: (username, name) => unlink(posix.join(LOG_HELD_DIR, assertHeldUser(username), heldName(name))),
    stage: async (account, name) => {
      await protectedDir(LOG_ARCHIVE_STAGING_DIR, 0o711, 0)
      const dir = await protectedDir(stagingDir(account), 0o750, account.gid)
      return writeFrom(posix.join(LOG_HELD_DIR, assertHeldUser(account.username), heldName(name)), posix.join(dir, name), 0o640, account.gid, false)
    },
    unstage: (account, name) => unlink(posix.join(stagingDir(account), name)),
    run: argv => isLogRotationCommand(argv) ? input.runCommand(argv) : fail('PRECONDITION_FAILED', 'the log archive command was not admitted', { stateChanged: false }),
    listArchives: account => listAccountLogArchives(account),
  }
}
