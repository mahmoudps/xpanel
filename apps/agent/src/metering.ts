import { fail } from '@xpanel/core'
import type { Account, Domain, Plan } from '@xpanel/core'
import { edge } from '@xpanel/render'
import type { LogSlice } from './account-logs.ts'
import type { IoAccountsView } from './analytics.ts'
import type { FtpLogObservation } from './ftp-log.ts'
import { UNAVAILABLE_DISK_LATENCY, type DiskLatency } from './host-metrics.ts'
import type { MailLogObservation } from './mail-log.ts'

export const BANDWIDTH_LEDGER_PATH = '/var/lib/xpanel/bandwidth.json'
/** Minimum spacing of collections; the caller's timer may tick more often. */
export const BANDWIDTH_INTERVAL_MS = 300_000
/** The current and the previous UTC month, so lines read just after a month boundary still count. */
export const BANDWIDTH_MONTHS_KEPT = 2
export const BANDWIDTH_SITE_READ_BYTES = 1024 * 1024
export const BANDWIDTH_TICK_READ_BYTES = 8 * 1024 * 1024
export const BANDWIDTH_MAX_SITES = 512
/** Longest journal window read per collection; a longer gap is caught up over later collections. */
export const BANDWIDTH_JOURNAL_WINDOW_MS = 6 * 3_600_000
/** Queue ids whose size was logged in an earlier window than their delivery. */
export const BANDWIDTH_MAIL_QUEUE_MAX = 5_000
const MAIL_QUEUE_MAX_AGE_MS = 7 * 86_400_000
/** Plan usage share that marks an account as near its monthly limit. */
export const BANDWIDTH_NEAR_PERCENT = 80
const LINE_MAX_BYTES = 16 * 1024

export const BANDWIDTH_SOURCES = ['web', 'mail', 'ftp'] as const
export type BandwidthSource = typeof BANDWIDTH_SOURCES[number]
/** count is requests (web), messages (mail) or transfers (FTP); received is uploads and inbound mail. */
export interface BandwidthTotals { count: number; receivedBytes: number; sentBytes: number }
export type BandwidthMonth = Record<BandwidthSource, BandwidthTotals>
/** A journal source read by whole-second windows: next is the first second not yet read. */
export interface JournalCursor { state: 'not-read' | 'read' | 'unavailable'; since: string | null; next: string | null; truncatedWindows: number }
/** File state: per-log read cursors, journal cursors and per-account monthly totals, written atomically together. */
export interface BandwidthLedger {
  since: string
  updatedAt: string | null
  pendingBytes: number
  unavailableSites: number
  skippedLines: number
  cursors: Record<string, { accountId: string; identity: string; offset: number }>
  journals: Record<'mail' | 'ftp', JournalCursor>
  mailQueue: Record<string, { size: number; sender: string | null; at: string }>
  /** 'YYYY-MM' (UTC) to account id to per-source totals. */
  months: Record<string, Record<string, BandwidthMonth>>
}
export type BandwidthLimitState = 'within' | 'near' | 'over' | 'unlimited' | 'unmeasured'
export interface BandwidthAccountRow {
  username: string; domain: string; status: Account['status']
  /** Per source: null when that source was not measured for this account. */
  month: Record<BandwidthSource, BandwidthTotals | null>
  totalBytes: number | null; limitBytes: number | null; usedPercent: number | null; limitState: BandwidthLimitState
  /** The plan's enforcement switch, and whether the websites serve the bandwidth-exceeded page this month. */
  enforced: boolean; limited: boolean
}
export interface BandwidthSourceState { state: 'read' | 'partial' | 'unavailable'; since: string | null }
export interface BandwidthReport {
  state: 'read' | 'partial' | 'unavailable'
  month: string
  since: string | null; updatedAt: string | null
  sources: Record<BandwidthSource, BandwidthSourceState>
  pendingBytes: number; unavailableSites: number; skippedLines: number
  accounts: BandwidthAccountRow[]
}
export interface BandwidthMeterOptions {
  readState: () => Promise<{ accounts: readonly Account[]; domains: readonly Domain[]; plans: readonly Plan[] }>
  readFrom: (path: string, offset: number, maxBytes: number) => Promise<LogSlice>
  /** Bounded Postfix journal window (observeMailLog); null off a native host. */
  readMail: ((since: string, until: string) => Promise<MailLogObservation>) | null
  /** Bounded pure-ftpd journal window (observeFtpLog); null off a native host. */
  readFtp: ((since: string, until: string) => Promise<FtpLogObservation>) | null
  readLedger: () => Promise<unknown>
  writeLedger: (ledger: BandwidthLedger) => Promise<void>
  /** Runs after each recorded collection (plan enforcement); its failure is reported through onError. */
  afterCollect?: () => Promise<void>
  now?: () => Date
  onError?: (error: unknown) => void
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const instant = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
const totals = (v: unknown): v is BandwidthTotals => object(v) && count(v.count) && count(v.receivedBytes) && count(v.sentBytes)
const monthOf = (date: Date): string => date.toISOString().slice(0, 7)
const monthBefore = (month: string, steps: number): string => { const [year, number] = month.split('-').map(Number); return monthOf(new Date(Date.UTC(year!, number! - 1 - steps, 1))) }
const second = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + 'Z'
const zero = (): BandwidthTotals => ({ count: 0, receivedBytes: 0, sentBytes: 0 })
const emptyMonth = (): BandwidthMonth => ({ web: zero(), mail: zero(), ftp: zero() })
const notRead = (): JournalCursor => ({ state: 'not-read', since: null, next: null, truncatedWindows: 0 })

export const emptyBandwidthLedger = (now: Date): BandwidthLedger => ({ since: now.toISOString(), updatedAt: null, pendingBytes: 0, unavailableSites: 0, skippedLines: 0, cursors: {}, journals: { mail: notRead(), ftp: notRead() }, mailQueue: {}, months: {} })

/** Accepts only a well-formed ledger; anything else is not trusted and counting restarts. */
export function parseBandwidthLedger(raw: unknown): BandwidthLedger | null {
  if (!object(raw) || !instant(raw.since) || raw.updatedAt !== null && !instant(raw.updatedAt) || !count(raw.pendingBytes) || !count(raw.unavailableSites) || !count(raw.skippedLines) || !object(raw.cursors) || !object(raw.months) || !object(raw.journals) || !object(raw.mailQueue)) return null
  for (const cursor of Object.values(raw.cursors)) if (!object(cursor) || typeof cursor.accountId !== 'string' || typeof cursor.identity !== 'string' || !count(cursor.offset)) return null
  for (const key of ['mail', 'ftp']) {
    const cursor = raw.journals[key]
    if (!object(cursor) || !['not-read', 'read', 'unavailable'].includes(String(cursor.state)) || cursor.since !== null && !instant(cursor.since) || cursor.next !== null && !instant(cursor.next) || !count(cursor.truncatedWindows)) return null
  }
  if (Object.keys(raw.mailQueue).length > BANDWIDTH_MAIL_QUEUE_MAX) return null
  for (const entry of Object.values(raw.mailQueue)) if (!object(entry) || !count(entry.size) || entry.sender !== null && typeof entry.sender !== 'string' || !instant(entry.at)) return null
  for (const [month, rows] of Object.entries(raw.months)) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !object(rows)) return null
    for (const row of Object.values(rows)) if (!object(row) || !BANDWIDTH_SOURCES.every(source => totals(row[source]))) return null
  }
  return raw as unknown as BandwidthLedger
}

const add = (ledger: BandwidthLedger, at: Date, accountId: string, source: BandwidthSource, received: number, sent: number, keep: ReadonlySet<string>): boolean => {
  const month = monthOf(at)
  if (!keep.has(month)) return true
  const row = (ledger.months[month] ??= {})[accountId] ??= emptyMonth(), totals = row[source]
  if (!Number.isSafeInteger(totals.receivedBytes + received) || !Number.isSafeInteger(totals.sentBytes + sent)) return false
  totals.count++; totals.receivedBytes += received; totals.sentBytes += sent
  return true
}

/** Sums complete xpanel_metrics lines (packages/render/src/edge/nginx.ts) into monthly account totals.
 * Returns the bytes consumed: a trailing partial line stays for the next read. */
export function addLogLines(ledger: BandwidthLedger, accountId: string, bytes: Buffer, full: boolean, keep: ReadonlySet<string>): number {
  const end = bytes.lastIndexOf(10)
  // A full read without any newline is one oversized line; skip it rather than stall.
  if (end < 0) { if (full && bytes.length >= LINE_MAX_BYTES) { ledger.skippedLines++; return bytes.length } return 0 }
  for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
    if (!line) continue
    let v: unknown
    try { v = line.length <= LINE_MAX_BYTES ? JSON.parse(line) : null } catch { v = null }
    const at = object(v) && typeof v.time === 'string' ? new Date(v.time) : null
    if (!object(v) || !at || !Number.isFinite(at.getTime()) || !count(v.bytes) || !count(v.request_bytes) || !add(ledger, at, accountId, 'web', v.request_bytes, v.bytes, keep)) ledger.skippedLines++
  }
  return end + 1
}

const domainOf = (address: string | null): string | null => address && address.includes('@') ? address.slice(address.lastIndexOf('@') + 1).toLowerCase() : null

/** Delivered copies only: a message counts for each recipient Postfix reported sent in this window.
 * Inbound copies count as received by the recipient domain's account, outbound copies as sent by the sender domain's account. */
export function addMailObservation(ledger: BandwidthLedger, observation: MailLogObservation, owners: ReadonlyMap<string, string>, keep: ReadonlySet<string>, now: Date): void {
  for (const message of observation.messages) {
    const queued = message.queueId === null ? undefined : ledger.mailQueue[message.queueId]
    const size = message.size ?? queued?.size ?? null, sender = message.sender ?? queued?.sender ?? null
    if (message.queueId !== null && size !== null) {
      if (message.lines.some(line => line.kind === 'removed')) delete ledger.mailQueue[message.queueId]
      else ledger.mailQueue[message.queueId] = { size, sender, at: message.lastSeen }
    }
    const sent = [...message.recipients.values()].filter(recipient => recipient.status === 'sent')
    if (!sent.length) continue
    if (size === null) { ledger.skippedLines++; continue }
    const from = owners.get(domainOf(sender) ?? '') ?? null, inbound = new Map<string, number>()
    let outbound = 0
    for (const recipient of sent) {
      const to = owners.get(domainOf(recipient.address) ?? '') ?? null
      if (to !== null) inbound.set(to, (inbound.get(to) ?? 0) + 1)
      if (from !== null && to !== from) outbound++
    }
    const at = new Date(sent[sent.length - 1]!.at)
    for (const [accountId, copies] of inbound) if (!add(ledger, at, accountId, 'mail', size * copies, 0, keep)) ledger.skippedLines++
    if (from !== null && outbound > 0 && !add(ledger, at, from, 'mail', 0, size * outbound, keep)) ledger.skippedLines++
  }
  const queue = Object.entries(ledger.mailQueue).filter(([, entry]) => now.getTime() - Date.parse(entry.at) <= MAIL_QUEUE_MAX_AGE_MS)
    .sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, BANDWIDTH_MAIL_QUEUE_MAX)
  ledger.mailQueue = Object.fromEntries(queue)
}

/** pure-ftpd transfer lines: uploads are received, downloads sent, by the account of the logged-in FTP user. */
export function addFtpObservation(ledger: BandwidthLedger, observation: FtpLogObservation, accounts: ReadonlyMap<string, string>, keep: ReadonlySet<string>): void {
  for (const event of observation.events) {
    if (event.kind !== 'upload' && event.kind !== 'download' || event.bytes === null) continue
    const accountId = event.account === null ? undefined : accounts.get(event.account)
    if (accountId === undefined) { ledger.skippedLines++; continue }
    if (!add(ledger, new Date(event.at), accountId, 'ftp', event.kind === 'upload' ? event.bytes : 0, event.kind === 'download' ? event.bytes : 0, keep)) ledger.skippedLines++
  }
}

/** Site logs per account; an account whose saved sites cannot be grouped is listed in failed, not skipped silently. */
const sitesOf = (saved: { accounts: readonly Account[]; domains: readonly Domain[] }): { sites: { accountId: string; path: string }[]; failed: Set<string> } => {
  const seen = new Map<string, string>(), failed = new Set<string>()
  for (const account of saved.accounts) {
    try { for (const group of edge.groupSites(account, saved.domains.filter(domain => domain.accountId === account.id))) seen.set(edge.nginxAccessLog(group.main.name), account.id) }
    catch { failed.add(account.id) }
  }
  return { sites: [...seen].map(([path, accountId]) => ({ path, accountId })).sort((a, b) => a.path.localeCompare(b.path)), failed }
}

/** Incremental per-account bandwidth from the saved site access logs and the mail and FTP journals. One collection at a time. */
export function createBandwidthMeter(options: BandwidthMeterOptions) {
  const now = options.now ?? (() => new Date())
  let active: Promise<void> | undefined, lastRun = -Infinity, stopped = false
  const readJournal = async <T extends { state: 'read' | 'unavailable'; lineLimitReached: boolean }>(cursor: JournalCursor, at: Date, read: ((since: string, until: string) => Promise<T>) | null, apply: (observation: T) => void): Promise<void> => {
    if (!read) return
    // Whole seconds: journalctl --since and --until are inclusive, so the next window starts one second later.
    const last = Math.floor(at.getTime() / 1000) * 1000 - 1000, start = cursor.next !== null ? Date.parse(cursor.next) : last - BANDWIDTH_INTERVAL_MS + 1000
    const end = Math.min(last, start + BANDWIDTH_JOURNAL_WINDOW_MS - 1000)
    if (end <= start) return
    let observation: T
    try { observation = await read(second(start), second(end)) } catch { cursor.state = 'unavailable'; return }
    if (observation.state !== 'read') { cursor.state = 'unavailable'; return }
    apply(observation)
    if (observation.lineLimitReached) cursor.truncatedWindows++
    cursor.state = 'read'; cursor.since ??= second(start); cursor.next = second(end + 1000)
  }
  const collectOnce = async (): Promise<void> => {
    const at = now(), saved = await options.readState()
    const ledger = parseBandwidthLedger(await options.readLedger()) ?? emptyBandwidthLedger(at)
    const current = monthOf(at), keep = new Set(Array.from({ length: BANDWIDTH_MONTHS_KEPT }, (_, index) => monthBefore(current, index)))
    const { sites, failed } = sitesOf(saved), listed = sites.slice(0, BANDWIDTH_MAX_SITES), cursors: BandwidthLedger['cursors'] = {}
    let budget = BANDWIDTH_TICK_READ_BYTES
    // Coverage fields describe the latest collection only; totals and cursors carry over.
    ledger.pendingBytes = 0; ledger.skippedLines = 0; ledger.unavailableSites = sites.length - listed.length + failed.size
    for (const site of listed) {
      const previous = ledger.cursors[site.path]
      const known = previous?.accountId === site.accountId ? previous : undefined
      try {
        const max = Math.min(BANDWIDTH_SITE_READ_BYTES, Math.max(1, budget))
        let slice = await options.readFrom(site.path, known?.offset ?? 0, max)
        // shortcut: a rotated file restarts at 0; lines written to it after the last read are not counted.
        if (slice.exists && known && (slice.identity !== known.identity || slice.sizeBytes < known.offset)) slice = await options.readFrom(site.path, 0, max)
        if (!slice.exists || slice.identity === null) { ledger.unavailableSites++; continue }
        const consumed = budget > 0 ? addLogLines(ledger, site.accountId, slice.bytes, slice.bytes.length === max, keep) : 0
        budget -= slice.bytes.length
        cursors[site.path] = { accountId: site.accountId, identity: slice.identity, offset: slice.start + consumed }
        ledger.pendingBytes += slice.sizeBytes - (slice.start + consumed)
      } catch { ledger.unavailableSites++; if (known) cursors[site.path] = known }
    }
    ledger.cursors = cursors
    const owners = new Map(saved.domains.map(domain => [domain.name.toLowerCase(), domain.accountId]))
    const usernames = new Map(saved.accounts.map(account => [account.username, account.id]))
    await readJournal(ledger.journals.mail, at, options.readMail, observation => addMailObservation(ledger, observation, owners, keep, at))
    await readJournal(ledger.journals.ftp, at, options.readFtp, observation => addFtpObservation(ledger, observation, usernames, keep))
    for (const month of Object.keys(ledger.months)) if (!keep.has(month)) delete ledger.months[month]
    ledger.updatedAt = at.toISOString()
    if (stopped) return
    await options.writeLedger(ledger)
    if (!stopped && options.afterCollect) await options.afterCollect()
  }
  const collect = (force = false): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (active) return active
    if (!force && now().getTime() - lastRun < BANDWIDTH_INTERVAL_MS) return Promise.resolve()
    lastRun = now().getTime()
    active = collectOnce().catch(error => { try { options.onError?.(error) } catch { /* Diagnostics cannot stop metering. */ } }).finally(() => { active = undefined })
    return active
  }
  return {
    collect,
    async report(): Promise<BandwidthReport> {
      const month = monthOf(now()), monthStart = month + '-01T00:00:00Z', saved = await options.readState()
      const ledger = parseBandwidthLedger(await options.readLedger())
      const plans = new Map(saved.plans.map(plan => [plan.id, plan]))
      const unread: Record<BandwidthSource, BandwidthSourceState> = { web: { state: 'unavailable', since: null }, mail: { state: 'unavailable', since: null }, ftp: { state: 'unavailable', since: null } }
      const base = { month }
      const row = (account: Account, month: BandwidthAccountRow['month']): BandwidthAccountRow => {
        const measured = BANDWIDTH_SOURCES.filter(source => month[source] !== null)
        const totalBytes = measured.length ? measured.reduce((sum, source) => sum + month[source]!.receivedBytes + month[source]!.sentBytes, 0) : null
        const limit = plans.get(account.planId)?.resources.bandwidthMbMonth
        const limitBytes = typeof limit === 'number' ? limit * 1024 * 1024 : null
        const usedPercent = totalBytes !== null && limitBytes ? Math.round(totalBytes / limitBytes * 1000) / 10 : null
        const limitState: BandwidthLimitState = totalBytes === null ? 'unmeasured' : limitBytes === null ? 'unlimited' : usedPercent! >= 100 ? 'over' : usedPercent! >= BANDWIDTH_NEAR_PERCENT ? 'near' : 'within'
        const plan = plans.get(account.planId)
        return { username: account.username, domain: account.primaryDomain, status: account.status, month, totalBytes, limitBytes, usedPercent, limitState, enforced: plan?.enforceBandwidth === true, limited: account.bandwidthLimitedMonth !== undefined }
      }
      if (!ledger || ledger.updatedAt === null) return { ...base, state: 'unavailable', since: null, updatedAt: null, sources: unread, pendingBytes: 0, unavailableSites: 0, skippedLines: 0, accounts: saved.accounts.map(account => row(account, { web: null, mail: null, ftp: null })).sort((a, b) => a.username.localeCompare(b.username)) }
      const { sites, failed } = sitesOf(saved)
      const journal = (cursor: JournalCursor): BandwidthSourceState => cursor.state !== 'read' || cursor.since === null ? { state: 'unavailable', since: cursor.since }
        : { state: cursor.truncatedWindows > 0 || cursor.since > monthStart ? 'partial' : 'read', since: cursor.since }
      const sources: Record<BandwidthSource, BandwidthSourceState> = {
        web: { state: ledger.pendingBytes > 0 || ledger.unavailableSites > 0 || ledger.skippedLines > 0 || ledger.since > monthStart ? 'partial' : 'read', since: ledger.since },
        mail: journal(ledger.journals.mail), ftp: journal(ledger.journals.ftp),
      }
      const accounts = saved.accounts.map(account => {
        const totals = ledger.months[month]?.[account.id] ?? emptyMonth()
        const web = !failed.has(account.id) && sites.filter(site => site.accountId === account.id).every(site => ledger.cursors[site.path]?.accountId === account.id)
        return row(account, { web: web ? totals.web : null, mail: sources.mail.state === 'unavailable' ? null : totals.mail, ftp: sources.ftp.state === 'unavailable' ? null : totals.ftp })
      }).sort((a, b) => (b.totalBytes ?? -1) - (a.totalBytes ?? -1) || a.username.localeCompare(b.username))
      const partial = BANDWIDTH_SOURCES.some(source => sources[source].state !== 'read') || accounts.some(account => account.month.web === null)
      return { ...base, state: partial ? 'partial' : 'read', since: ledger.since, updatedAt: ledger.updatedAt, sources, pendingBytes: ledger.pendingBytes, unavailableSites: ledger.unavailableSites, skippedLines: ledger.skippedLines, accounts }
    },
    async stop(): Promise<void> { stopped = true; await active },
  }
}
export type BandwidthMeter = ReturnType<typeof createBandwidthMeter>

export interface BandwidthLimitChange { accountId: string; month: string | null }
export interface BandwidthEnforcementDeps {
  /** Writes every account.bandwidthLimitedMonth change in one state mutation bound to the snapshot revision the decisions were made on. */
  setLimits: (changes: BandwidthLimitChange[], expectedRevision: number | undefined) => Promise<unknown>
  audit: (entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed' }) => Promise<unknown>
  /** One reconcile after a committed change, so the edge serves or stops serving the limit page. */
  reconcile: () => Promise<unknown>
}
export type BandwidthLiftReason = 'month-rollover' | 'limit-raised' | 'enforcement-off' | 'account-inactive'

/** Applies each plan's enforcement switch to the measured month. A limit is set only on proven use over the plan limit and is
 * never lifted on missing data; it is lifted when the month rolls over, the limit is raised or made unlimited, enforcement is
 * switched off or the account is no longer active. Every transition is audited. A revision conflict changes nothing; the next
 * collection decides again on fresh state. */
export async function enforceBandwidthLimits(report: BandwidthReport, saved: { revision?: number; accounts: readonly Account[]; plans: readonly Plan[] }, deps: BandwidthEnforcementDeps): Promise<{ limited: string[]; lifted: string[] }> {
  const rows = new Map(report.accounts.map(row => [row.username, row])), plans = new Map(saved.plans.map(plan => [plan.id, plan]))
  const decisions: { account: Account; change: BandwidthLimitChange; detail: Record<string, unknown> }[] = []
  for (const account of saved.accounts) {
    const row = rows.get(account.username), enforced = plans.get(account.planId)?.enforceBandwidth === true
    const current = account.bandwidthLimitedMonth ?? null
    const over = enforced && account.status === 'active' && report.state !== 'unavailable' && row?.limitState === 'over'
    let next = current, reason: BandwidthLiftReason | null = null
    if (over) next = report.month
    else if (current !== null) {
      reason = current !== report.month ? 'month-rollover' : !enforced ? 'enforcement-off' : account.status !== 'active' ? 'account-inactive'
        : row && (row.limitState === 'within' || row.limitState === 'near' || row.limitState === 'unlimited') ? 'limit-raised' : null
      if (reason !== null) next = null
    }
    if (next === current) continue
    decisions.push({ account, change: { accountId: account.id, month: next },
      detail: { month: report.month, usedPercent: row?.usedPercent ?? null, limitBytes: row?.limitBytes ?? null, totalBytes: row?.totalBytes ?? null, ...(reason ? { reason } : {}) } })
  }
  if (!decisions.length) return { limited: [], lifted: [] }
  const action = (change: BandwidthLimitChange): string => change.month === null ? 'account.bandwidth_limit_lifted' : 'account.bandwidth_limited'
  try { await deps.setLimits(decisions.map(entry => entry.change), saved.revision) }
  catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : 'state write failed'
    for (const entry of decisions) await deps.audit({ actor: 'system', action: action(entry.change), target: 'account:' + entry.account.username, detail: { ...entry.detail, error: message }, outcome: 'failed' }).catch(() => undefined)
    return { limited: [], lifted: [] }
  }
  for (const entry of decisions) await deps.audit({ actor: 'system', action: action(entry.change), target: 'account:' + entry.account.username, detail: entry.detail, outcome: 'ok' })
  await deps.reconcile()
  return { limited: decisions.filter(entry => entry.change.month !== null).map(entry => entry.account.username), lifted: decisions.filter(entry => entry.change.month === null).map(entry => entry.account.username) }
}

export interface MeteringRouteContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** The daemon-owned IO sampler view; null off a native host. */
  readIo: (() => Promise<IoAccountsView>) | null
  /** The host collector's latest /proc/diskstats interval; null off a native host. */
  readDiskLatency: (() => DiskLatency) | null
  bandwidth: BandwidthMeter | null
}
export type IoMeteringView = IoAccountsView & { disk: DiskLatency }

/** Fills the sampler's never-measured latency field from the host collector. An idle interval has no wait to measure, so it does not make the view partial. */
export function withDiskLatency(view: IoAccountsView, disk: DiskLatency): IoMeteringView {
  if (!view.host) return { ...view, disk }
  const host = { ...view.host, awaitMs: disk.awaitMs }
  const missing = Object.entries(host).some(([key, value]) => value === null && !(key === 'awaitMs' && disk.state === 'idle'))
  return { ...view, host, disk, state: view.unmeasuredAccounts > 0 || missing ? 'partial' : 'read' }
}

/** GET /host/monitoring/io and /host/monitoring/bandwidth: cached reads only, no caller-chosen paths or accounts. */
export async function handleMeteringRoute(req: Request, url: URL, method: string, ctx: MeteringRouteContext): Promise<Response | null> {
  const io = url.pathname === '/host/monitoring/io'
  if (!io && url.pathname !== '/host/monitoring/bandwidth') return null
  const action = io ? 'server.io.read' : 'server.bandwidth.read'
  await ctx.assertRoot(action)
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search || req.body !== null) return fail('VALIDATION', 'metering reads accept no selectors or body', { stateChanged: false })
  const body: IoMeteringView | BandwidthReport | null = io
    ? withDiskLatency(ctx.readIo ? await ctx.readIo() : { state: 'unavailable', reason: 'not-sampled', observedAt: null, host: null, accounts: [], unmeasuredAccounts: 0 }, ctx.readDiskLatency?.() ?? UNAVAILABLE_DISK_LATENCY)
    : ctx.bandwidth ? await ctx.bandwidth.report() : null
  if (body === null) return fail('SERVICE_UNAVAILABLE', 'bandwidth metering is not running on this host', { stateChanged: false })
  await ctx.assertRoot(action)
  return Response.json(body, { headers: { 'cache-control': 'no-store' } })
}
