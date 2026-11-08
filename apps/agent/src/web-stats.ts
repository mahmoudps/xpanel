import { randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { createInterface } from 'node:readline'
import type { Account, Domain, FeatureList, Id, Plan, WebsiteAnalyticsSnapshot } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { readJsonIfExists } from '@xpanel/state'
import type { SiteLogChunk, WebsiteAnalyticsFeed } from './analytics.ts'
import type { BackupCommandRunner } from './backup-low-priority.ts'
import type { GeoipSource } from './geoip.ts'
import { selectedEngines, statsRunDue } from './web-stats-config.ts'
import type { WebStatsConfig } from './web-stats-config.ts'
import { awstatsDataFile, isStatsSiteName, parseAwstatsData, renderAwstatsConfig, toCombinedLog, WEB_STATS_ENGINES, WEB_STATS_GENERATORS, WEB_STATS_SCHEMES } from './web-stats-format.ts'
import type { AwstatsMonth, WebStatsEngine, WebStatsGenerator, WebStatsScheme } from './web-stats-format.ts'

/** Root-owned and traversable, so account runs reach their configuration and the GeoIP database and nothing else. */
export const WEB_STATS_ROOT = '/var/lib/xpanel-stats'
const TICK_MS = 15 * 60_000
/** Per site and scheme; lines past it are counted as dropped until the next run empties the spool. */
export const WEB_STATS_SPOOL_MAX_BYTES = 64 * 1024 * 1024
export const WEB_STATS_MONTHS_KEPT = 12
const RUN_TIMEOUT_MS = 30 * 60_000
const DATA_FILE_MAX_BYTES = 64 * 1024 * 1024
/** Encoded, a file stays inside the panel's 1 MiB bound on host replies. */
export const WEBALIZER_FILE_MAX_BYTES = 512 * 1024
/** The files Webalizer writes into a report directory and the report pages link to. */
export const WEBALIZER_FILE = /^(?:index\.html|usage\.png|usage_\d{6}\.html|(?:daily_usage|hourly_usage|ctry_usage)_\d{6}\.png)$/
/** Plan feature per engine: catalog tool id and featureKey. */
export const WEB_STATS_FEATURES: Readonly<Record<WebStatsGenerator, readonly [string, string]>> = { analog: ['web-stats-analog', 'Analog Stats'], awstats: ['web-stats-awstats', 'Awstats'], webalizer: ['web-stats-webalizer', 'Webalizer'] }
/** GeoIP2::Database::Reader, which the AWStats geoip2_country plugin loads: Ubuntu, then EPEL. */
export const GEOIP2_PERL_MODULES = ['/usr/share/perl5/GeoIP2/Database/Reader.pm', '/usr/share/perl5/vendor_perl/GeoIP2/Database/Reader.pm'] as const

export type EngineRunState = 'updated' | 'failed' | 'unavailable' | 'not-entitled' | 'not-selected'
export interface EngineRun { state: EngineRunState; at: string; reason?: string }
/** droppedLines passed the spool limit; lostBytes of the site log were never spooled (a lost save before a restart), shared by both schemes. */
export interface SchemeReport { awstats: EngineRun | null; webalizer: EngineRun | null; droppedLines: number; lostBytes: number; months: Record<string, AwstatsMonth> }
export interface AccountReports { accountId: string; updatedAt: string; sites: Record<string, Partial<Record<WebStatsScheme, SchemeReport>>> }
interface SpoolState { bytes: number; dropped: number; lostBytes: number; months: string[] }
interface StatsState {
  /** Per edge log path: the identity and end offset already spooled, so a meter re-read after a lost ledger write is not spooled twice. */
  marks: Record<string, { identity: string; end: number }>
  spools: Record<string, SpoolState>
  /** A spool taken by a run; engines that finished it are listed, so a retry never feeds them the same lines again. */
  batches: Record<string, SpoolState & { done: WebStatsEngine[] }>
  lastRunAt: string | null
  /** Account id to the end of its last run, full or single. */
  accounts: Record<string, string>
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const months = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 24 && v.every(m => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m))
const spool = (v: unknown): v is SpoolState => object(v) && count(v.bytes) && count(v.dropped) && count(v.lostBytes) && months(v.months)
const KEY = /^[0-9a-f-]{36}\/[a-z0-9.-]{1,253}\/https?$/
export function parseStatsState(raw: unknown): StatsState | null {
  const instant = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v))
  if (!object(raw) || !object(raw.marks) || !object(raw.spools) || !object(raw.batches) || !object(raw.accounts) || !Object.values(raw.accounts).every(instant) || !(raw.lastRunAt === null || instant(raw.lastRunAt))) return null
  for (const mark of Object.values(raw.marks)) if (!object(mark) || typeof mark.identity !== 'string' || !count(mark.end)) return null
  for (const [key, value] of Object.entries(raw.spools)) if (!KEY.test(key) || !spool(value)) return null
  for (const [key, value] of Object.entries(raw.batches)) {
    const done = object(value) ? value.done : undefined
    if (!KEY.test(key) || !spool(value) || !Array.isArray(done) || !done.every((e: unknown) => (WEB_STATS_ENGINES as readonly unknown[]).includes(e))) return null
  }
  return raw as unknown as StatsState
}
const emptyState = (): StatsState => ({ marks: {}, spools: {}, batches: {}, lastRunAt: null, accounts: {} })
const spoolKey = (accountId: string, site: string, scheme: WebStatsScheme): string => `${accountId}/${site}/${scheme}`
const siteOfLog = (path: string): string | null => { const m = /^([a-z0-9.-]+)\.access\.log$/.exec(posix.basename(path)); return m && posix.dirname(path) === edge.XP_PATHS.nginxLogDir && isStatsSiteName(m[1]!) ? m[1]! : null }

export interface WebStatsOptions {
  root?: string
  readState: () => Promise<{ accounts: readonly Account[]; domains: readonly Domain[]; plans: readonly Plan[]; featureLists: readonly FeatureList[] }>
  /** Saved policy and choices; null when the file needs review, which stops runs and keeps every spool. */
  readConfig: () => Promise<WebStatsConfig | null>
  /** True while a backup or restore holds the host; absent where none can run. */
  backupBusy?: () => boolean
  run: BackupCommandRunner
  /** Installed engine programs; null when the engine is not installed on this host. */
  engines: () => Record<WebStatsEngine, string | null>
  /** The GeoIP database path when it and the AWStats plugin's Perl module are installed. */
  geoip: GeoipSource | null
  geoipReady: () => boolean
  admit?: <T>(work: () => Promise<T>) => Promise<T>
  /** Owner every statistics directory must have: root on a host, the test user in tests. */
  owner?: { uid: number; gid: number }
  spoolMaxBytes?: number
  now?: () => Date
  onError?: (error: unknown) => void
}

/** Root-only JSON, replaced atomically; the state store's writer would hand these files to the panel user. */
const writePrivateJson = async (path: string, data: unknown): Promise<void> => {
  const temporary = `${path}.${process.pid}.tmp`
  await rm(temporary, { force: true })
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
}

/** Plan entitlement per engine: neither the tool id nor its featureKey disabled. */
export const entitledEngines = (list: FeatureList | null | undefined): Record<WebStatsGenerator, boolean> =>
  Object.fromEntries(WEB_STATS_GENERATORS.map(engine => [engine, !!list && !WEB_STATS_FEATURES[engine].some(k => list.disabled.includes(k))])) as Record<WebStatsGenerator, boolean>

/** Analog off: totals and bandwidth stay, the report lists are withheld and marked, so nobody reads them as an empty report. */
export const withoutAnalogReport = (snapshot: WebsiteAnalyticsSnapshot): WebsiteAnalyticsSnapshot => ({ ...snapshot, topPaths: [], topReferrers: [], topClientIps: [], analog: 'off' })

/** The account's own report directories, as cPanel lays them out under ~/tmp. */
export const statsDirectories = (account: Account, site: string, scheme: WebStatsScheme): Record<WebStatsEngine, string> => {
  const home = posix.normalize(account.home)
  if (!home.startsWith('/') || home !== account.home || home === '/') throw new Error('invalid account home')
  return { awstats: posix.join(home, 'tmp', 'awstats', ...(scheme === 'https' ? ['ssl'] : [])), webalizer: posix.join(home, 'tmp', scheme === 'https' ? 'webalizerssl' : 'webalizer', site) }
}

/**
 * Web statistics from the lines the bandwidth meter reads: every newly consumed site log line is appended to a root-only spool per site
 * and scheme, and once a day each engine processes the spool as the account at low priority. Rotation, retention and the read cursor
 * stay with the meter, so the engines see each line exactly once.
 */
export function createWebStats(options: WebStatsOptions) {
  const root = options.root ?? WEB_STATS_ROOT, spoolDir = posix.join(root, 'spool'), confDir = posix.join(root, 'conf'), reportDir = posix.join(root, 'reports'), statePath = posix.join(root, 'state.json')
  const owner = options.owner ?? { uid: 0, gid: 0 }, now = options.now ?? (() => new Date()), admit = options.admit ?? (<T>(work: () => Promise<T>) => work())
  let state: StatsState | null = null, marksLoaded = false, queue: Promise<unknown> = Promise.resolve(), running: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined, stopped = false
  const staged: StatsState['marks'] = {}
  const pending = new Map<string, { lines: string[]; bytes: number; dropped: number; lostBytes: number; months: Set<string> }>()
  const pendingFor = (key: string) => { let p = pending.get(key); if (!p) pending.set(key, p = { lines: [], bytes: 0, dropped: 0, lostBytes: 0, months: new Set() }); return p }
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => undefined); return next }
  const loaded = async (): Promise<StatsState> => state ??= parseStatsState(await readJsonIfExists(statePath).catch(() => null)) ?? emptyState()
  const spoolFile = (key: string, batch = false): string => posix.join(spoolDir, key.replaceAll('/', '_') + (batch ? '.batch' : '.log'))
  const ensureDir = async (path: string, mode: number, gid = owner.gid): Promise<void> => {
    await mkdir(path, { recursive: true, mode })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner.uid) throw new Error('web statistics directory is not root-owned')
    // Only root can hand a directory to the account group; a test owner keeps its own group.
    if (info.gid !== gid && owner.uid === 0) await chown(path, 0, gid)
  }
  const saveState = (): Promise<void> => admit(async () => { await ensureDir(root, 0o711); await writePrivateJson(statePath, state) })

  const feed: WebsiteAnalyticsFeed = {
    // Only the first load seeds the marks: later ones must not roll back marks of lines still pending after a failed save.
    async load() { await loaded(); if (!marksLoaded) { Object.assign(staged, state!.marks); marksLoaded = true } },
    ingestSiteLog(chunk: SiteLogChunk): number {
      const site = siteOfLog(chunk.path)
      if (!site || !Object.values(options.engines()).some(Boolean)) return 0
      const mark = staged[chunk.path], sameFile = mark !== undefined && mark.identity === chunk.identity && chunk.sizeBytes >= mark.end
      const skip = sameFile ? Math.min(chunk.bytes.length, Math.max(0, mark.end - chunk.start)) : 0
      const lost = sameFile && chunk.start > mark.end ? chunk.start - mark.end : 0
      staged[chunk.path] = { identity: chunk.identity, end: sameFile ? Math.max(mark.end, chunk.start + chunk.bytes.length) : chunk.start + chunk.bytes.length }
      let added = 0
      if (lost) for (const scheme of WEB_STATS_SCHEMES) pendingFor(spoolKey(chunk.accountId, site, scheme)).lostBytes += lost
      for (const line of chunk.bytes.subarray(skip).toString('utf8').split('\n')) {
        const entry = line ? toCombinedLog(line) : null
        if (!entry) continue
        const key = spoolKey(chunk.accountId, site, entry.scheme), p = pendingFor(key)
        const committed = state?.spools[key]?.bytes ?? 0
        if (committed + p.bytes + entry.text.length > (options.spoolMaxBytes ?? WEB_STATS_SPOOL_MAX_BYTES)) { p.dropped++; continue }
        p.lines.push(entry.text); p.bytes += Buffer.byteLength(entry.text); p.months.add(entry.month); added++
      }
      return added
    },
    async save(): Promise<void> {
      if (!pending.size && JSON.stringify(staged) === JSON.stringify(state?.marks ?? {})) return
      await exclusive(async () => {
        const current = await loaded()
        await admit(async () => {
          await ensureDir(root, 0o711); await ensureDir(spoolDir, 0o700)
          for (const [key, p] of pending) {
            const s = current.spools[key] ??= { bytes: 0, dropped: 0, lostBytes: 0, months: [] }
            if (p.lines.length) {
              const handle = await open(spoolFile(key), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
              try {
                const size = (await handle.stat()).size
                // Bytes past the committed size were appended by a save whose state write never landed; they are written again below.
                if (size > s.bytes) await handle.truncate(s.bytes)
                if (size < s.bytes) { s.lostBytes += s.bytes - size; s.bytes = size }
                const data = Buffer.from(p.lines.join(''))
                await handle.write(data, 0, data.length, s.bytes); await handle.sync()
                s.bytes += data.length
              } finally { await handle.close() }
            }
            s.dropped += p.dropped; s.lostBytes += p.lostBytes; s.months = [...new Set([...s.months, ...p.months])].sort().slice(-24)
          }
          current.marks = { ...staged }
          await writePrivateJson(statePath, current)
        })
        pending.clear()
      })
    },
  }

  const readReports = async (accountId: string): Promise<AccountReports | null> => {
    const raw = await readJsonIfExists<AccountReports>(posix.join(reportDir, accountId + '.json')).catch(() => null)
    return object(raw) && raw.accountId === accountId && object(raw.sites) ? raw : null
  }
  const writeReports = (reports: AccountReports): Promise<void> => admit(async () => { await ensureDir(reportDir, 0o700); await writePrivateJson(posix.join(reportDir, reports.accountId + '.json'), reports) })

  /** One engine over one batch, as the account; the AWStats data files it touched are read back the same way. */
  const runEngine = async (engine: WebStatsEngine, program: string, account: Account, site: string, names: readonly string[], scheme: WebStatsScheme, batch: string, monthsTouched: readonly string[], report: SchemeReport, config: WebStatsConfig): Promise<boolean> => {
    const dirs = statsDirectories(account, site, scheme), at = now().toISOString()
    const prepared = await options.run({ argv: ['/usr/bin/mkdir', '-p', '--', dirs[engine]], runAsUser: account.username, maxStdoutBytes: 4096, timeoutMs: 60_000 })
    if (!prepared.ok) { report[engine] = { state: 'failed', at, reason: 'report directory could not be created' }; return false }
    let argv: string[]
    if (engine === 'awstats') {
      const include = config.policy.allowInclude ? posix.join(account.home, 'tmp', 'awstats', 'awstats.conf.include') : null
      // AWStats stops on a missing include, and an owner who never wrote one must still get reports.
      if (include && !(await options.run({ argv: ['/usr/bin/touch', '--', include], runAsUser: account.username, maxStdoutBytes: 4096, timeoutMs: 60_000 })).ok) { report[engine] = { state: 'failed', at, reason: 'include file could not be prepared' }; return false }
      const conf = posix.join(confDir, account.username, scheme)
      await admit(async () => {
        await ensureDir(confDir, 0o711); await ensureDir(posix.join(confDir, account.username), 0o750, account.gid); await ensureDir(conf, 0o750, account.gid)
        const file = posix.join(conf, `awstats.${site}.conf`)
        await writeFile(file, renderAwstatsConfig({ site, names, dataDir: dirs.awstats, geoipDatabase: options.geoip && options.geoipReady() ? options.geoip.path : null, reverseDns: config.policy.reverseDns, include }), { mode: 0o640, flag: 'w' })
        // The mode argument is masked by the process umask, and AWStats reads this file as the account.
        await chmod(file, 0o640)
        if (owner.uid === 0) await chown(file, 0, account.gid)
      })
      argv = [program, `-config=${site}`, `-configdir=${conf}`, '-update']
    } else argv = [program, '-c', '/dev/null', '-p', '-Q', '-F', 'clf', '-n', site, '-t', site, '-o', dirs.webalizer, '-']
    const result = await options.run({ argv, runAsUser: account.username, stdinPath: batch, maxStdoutBytes: 1024 * 1024, timeoutMs: RUN_TIMEOUT_MS })
    if (!result.ok) { report[engine] = { state: 'failed', at, reason: result.killed ?? `exit ${result.code}` }; return false }
    report[engine] = { state: 'updated', at }
    if (engine === 'awstats') for (const month of monthsTouched) {
      const copy = posix.join(reportDir, `.${account.id}.${scheme}.read`)
      await rm(copy, { force: true })
      const read = await options.run({ argv: ['/usr/bin/cat', '--', posix.join(dirs.awstats, awstatsDataFile(month, site))], runAsUser: account.username, stdoutPath: copy, maxStdoutBytes: DATA_FILE_MAX_BYTES, timeoutMs: 120_000 })
      try {
        if (read.ok) report.months[month] = await parseAwstatsData(createInterface({ input: createReadStream(copy), crlfDelay: Infinity }), month)
      } finally { await rm(copy, { force: true }) }
    }
    for (const month of Object.keys(report.months).sort().slice(0, -WEB_STATS_MONTHS_KEPT)) delete report.months[month]
    return true
  }

  /** Every account, or one account for WHM process-now; a single run leaves the schedule and the cleanup of removed sites alone. */
  const runOnce = async (only?: string): Promise<void> => {
    const config = await options.readConfig()
    if (!config) throw new Error('saved statistics configuration requires review')
    const current = await loaded(), started = now()
    if (options.geoip && !only) await options.geoip.refresh(started).catch(error => options.onError?.(error))
    const saved = await options.readState(), engines = options.engines(), live = new Set<string>()
    await admit(async () => { await ensureDir(root, 0o711); await ensureDir(reportDir, 0o700) })
    for (const account of saved.accounts) {
      if (stopped) return
      if (only && account.id !== only) continue
      let groups: ReturnType<typeof edge.groupSites>
      try { groups = edge.groupSites(account, saved.domains.filter(domain => domain.accountId === account.id)) } catch (error) {
        // A site configuration that needs review keeps the account's spools for a later run.
        for (const key of [...Object.keys(current.spools), ...Object.keys(current.batches)]) if (key.startsWith(account.id + '/')) live.add(key)
        options.onError?.(error); continue
      }
      const plan = saved.plans.find(row => row.id === account.planId)
      const entitled = entitledEngines(plan ? saved.featureLists.find(row => row.id === plan.featureListId) : undefined)
      const reports = await readReports(account.id) ?? { accountId: account.id, updatedAt: started.toISOString(), sites: {} }
      for (const group of groups) for (const scheme of WEB_STATS_SCHEMES) {
        const site = group.main.name, key = spoolKey(account.id, site, scheme)
        live.add(key)
        if (!isStatsSiteName(site) || account.status !== 'active') continue
        const batch = await exclusive(async () => {
          if (!current.batches[key] && current.spools[key]) {
            await admit(async () => { await rename(spoolFile(key), spoolFile(key, true)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) })
            current.batches[key] = { ...current.spools[key]!, done: [] }
            delete current.spools[key]
            await saveState()
          }
          return current.batches[key]
        })
        if (!batch) continue
        const chosen = selectedEngines(config, account, site)
        const report = ((reports.sites[site] ??= {})[scheme] ??= { awstats: null, webalizer: null, droppedLines: 0, lostBytes: 0, months: {} })
        report.droppedLines += batch.dropped; report.lostBytes += batch.lostBytes
        batch.dropped = 0; batch.lostBytes = 0
        for (const engine of WEB_STATS_ENGINES) {
          if (batch.done.includes(engine)) continue
          const at = now().toISOString(), program = engines[engine]
          // An engine the plan does not include or the host does not have never sees these lines; its report says why.
          if (!entitled[engine]) { report[engine] = { state: 'not-entitled', at }; batch.done.push(engine); continue }
          if (!chosen.includes(engine)) { report[engine] = { state: 'not-selected', at }; batch.done.push(engine); continue }
          if (!program) { report[engine] = { state: 'unavailable', at, reason: 'not installed' }; batch.done.push(engine); continue }
          const exists = await lstat(spoolFile(key, true)).then(info => info.isFile(), () => false)
          if (!exists || await runEngine(engine, program, account, site, group.names, scheme, spoolFile(key, true), batch.months, report, config).catch(error => { options.onError?.(error); report[engine] = { state: 'failed', at, reason: 'run failed' }; return false })) batch.done.push(engine)
        }
        await exclusive(async () => {
          if (WEB_STATS_ENGINES.every(engine => batch.done.includes(engine))) { await admit(() => rm(spoolFile(key, true), { force: true })); delete current.batches[key] }
          await saveState()
        })
      }
      reports.updatedAt = now().toISOString()
      for (const site of Object.keys(reports.sites)) if (!groups.some(group => group.main.name === site)) delete reports.sites[site]
      await writeReports(reports)
      await exclusive(async () => { current.accounts[account.id] = now().toISOString(); await saveState() })
    }
    if (only) return
    // A site, account or log that no longer exists keeps no spool.
    await exclusive(async () => {
      for (const key of [...Object.keys(current.spools), ...Object.keys(current.batches)]) if (!live.has(key)) {
        await admit(async () => { await rm(spoolFile(key), { force: true }); await rm(spoolFile(key, true), { force: true }) })
        delete current.spools[key]; delete current.batches[key]
      }
      const logs = new Set([...live].map(key => edge.nginxAccessLog(key.split('/')[1]!)))
      for (const path of Object.keys(staged)) if (!logs.has(path)) delete staged[path]
      current.marks = Object.fromEntries(Object.entries(current.marks).filter(([path]) => logs.has(path)))
      const known = new Set(saved.accounts.map(account => account.id))
      current.accounts = Object.fromEntries(Object.entries(current.accounts).filter(([id]) => known.has(id)))
      current.lastRunAt = started.toISOString()
      await saveState()
    })
  }

  const launch = (work: () => Promise<void>): Promise<void> => running = work().catch(error => { try { options.onError?.(error) } catch { /* Diagnostics cannot stop statistics. */ } }).finally(() => { running = undefined })
  const tick = (force = false): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (running) return running
    return launch(async () => {
      const config = await options.readConfig()
      if (!config) throw new Error('saved statistics configuration requires review')
      if (!force && !statsRunDue(config.policy, (await loaded()).lastRunAt, now(), options.backupBusy?.() ?? false)) return
      if (!Object.values(options.engines()).some(Boolean)) return
      await runOnce()
    })
  }

  return {
    feed,
    /** Tees the meter's site reads into the spool; the analytics feed keeps its own behaviour. */
    tee(analytics: WebsiteAnalyticsFeed): WebsiteAnalyticsFeed {
      return {
        load: async () => { await Promise.all([analytics.load(), feed.load().catch(error => options.onError?.(error))]) },
        ingestSiteLog: chunk => { try { feed.ingestSiteLog(chunk) } catch (error) { options.onError?.(error) } return analytics.ingestSiteLog(chunk) },
        save: async at => { await feed.save(at).catch(error => options.onError?.(error)); await analytics.save(at) },
      }
    },
    tick,
    /** WHM process-now for one account, in the background; false while another run holds the slot. */
    processNow(accountId: string): boolean { if (stopped || running) return false; void launch(() => runOnce(accountId)); return true },
    config: options.readConfig,
    start(): void { if (!timer && !stopped) { timer = setInterval(() => { void tick() }, TICK_MS); timer.unref() } },
    async stop(): Promise<void> { stopped = true; clearInterval(timer); timer = undefined; await running },
    reports: readReports,
    engines: options.engines,
    geoipStatus: async () => options.geoip ? await options.geoip.status() : null,
    /** The Analog report of one site, when the plan and the saved choice keep it on. */
    async trafficView(snapshot: WebsiteAnalyticsSnapshot, account: Account, domain: Pick<Domain, 'name'>, store: { getPlan(id: Id): Promise<Plan | null>; getFeatureList(id: Id): Promise<FeatureList | null>; listDomains(filter: { accountId: Id }): Promise<Domain[]> }): Promise<WebsiteAnalyticsSnapshot> {
      const plan = await store.getPlan(account.planId), [features, config, domains] = await Promise.all([plan ? store.getFeatureList(plan.featureListId) : null, options.readConfig(), store.listDomains({ accountId: account.id })])
      let site: string | undefined
      try { site = edge.groupSites(account, domains).find(group => group.names.includes(domain.name))?.main.name } catch { site = undefined }
      if (!entitledEngines(features).analog || config && site && !selectedEngines(config, account, site).includes('analog')) return withoutAnalogReport(snapshot)
      return this.withVisitorCountries(snapshot)
    },
    /** Top client addresses with their countries; a missing or damaged database leaves them unresolved, never guessed. */
    async withVisitorCountries(snapshot: WebsiteAnalyticsSnapshot): Promise<WebsiteAnalyticsSnapshot> {
      const countries = await options.geoip?.countries(snapshot.topClientIps.map(row => row.key)).catch(() => null)
      return countries?.size ? { ...snapshot, topClientIps: snapshot.topClientIps.map(row => countries.has(row.key) ? { ...row, country: countries.get(row.key)! } : row) } : snapshot
    },
    /** One generated Webalizer file, read as the account; null when it does not exist or is larger than the bound. */
    async readWebalizerFile(account: Account, site: string, scheme: WebStatsScheme, file: string): Promise<Buffer | null> {
      if (!WEBALIZER_FILE.test(file) || !isStatsSiteName(site)) return null
      await admit(async () => { await ensureDir(root, 0o711); await ensureDir(reportDir, 0o700) })
      const copy = posix.join(reportDir, `.${randomUUID()}.read`)
      try {
        const read = await options.run({ argv: ['/usr/bin/cat', '--', posix.join(statsDirectories(account, site, scheme).webalizer, file)], runAsUser: account.username, stdoutPath: copy, maxStdoutBytes: WEBALIZER_FILE_MAX_BYTES, timeoutMs: 30_000 })
        return read.ok ? await readFile(copy) : null
      } finally { await rm(copy, { force: true }) }
    },
    async status(): Promise<{ lastRunAt: string | null; nextRunAt: string | null; running: boolean; accounts: Record<string, string>; spools: Record<string, SpoolState> }> {
      const current = await loaded(), config = await options.readConfig()
      const spools = { ...current.spools }
      for (const [key, batch] of Object.entries(current.batches)) spools[key] = { bytes: (spools[key]?.bytes ?? 0) + batch.bytes, dropped: (spools[key]?.dropped ?? 0) + batch.dropped, lostBytes: (spools[key]?.lostBytes ?? 0) + batch.lostBytes, months: batch.months }
      return { lastRunAt: current.lastRunAt, nextRunAt: current.lastRunAt && config ? new Date(Date.parse(current.lastRunAt) + config.policy.intervalHours * 3_600_000).toISOString() : null, running: running !== undefined, accounts: current.accounts, spools }
    },
  }
}
export type WebStats = ReturnType<typeof createWebStats>
