import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { fail, msgid } from '@xpanel/core'
import type { ConfigGeneration } from '@xpanel/db'
import { DEFAULT_LAYOUT } from '@xpanel/lifecycle'
import { parseOsRelease } from '@xpanel/os'
import { MONITORING_LOG_MAX_LINES } from '../../../packages/os/src/monitoring-command.ts'
import type { HostJobView } from './host-job-contract.ts'
import { parseMeminfo, parseProcUptime } from './host-info.ts'
import { readDisk, readLogs } from './host-monitoring.ts'
import type { MonitoringRun } from './host-monitoring.ts'
import { readHostServices } from './host-services.ts'
import type { HostServiceStatus } from './host-services.ts'
import type { RepairDriftObservation } from './repair-center.ts'
import { createSupportRedactor, redactSupportValue, SUPPORT_HASH_RULE, SUPPORT_REDACTION_RULES } from './support-bundle-redaction.ts'
import type { SupportRedactor } from './support-bundle-redaction.ts'
import type { UpgradeHostFs } from './upgrade-observation.ts'

export const SUPPORT_JOURNAL_UNITS = ['xpanel-agent.service', 'xpanel-api.service'] as const
export const SUPPORT_LIMITS = Object.freeze({
  journalLines: MONITORING_LOG_MAX_LINES,
  journalBytesPerUnit: 384 * 1024,
  failedJobs: 10,
  filesystems: 64,
  jobErrorChars: 1024,
  jobSteps: 32,
  /** The API reads at most 1 MiB from the agent. */
  bundleBytes: 960 * 1024,
})
/** `text` is an English source message; its `{placeholders}` are named after SUPPORT_LIMITS keys. */
type Entry = Readonly<{ id: string; text: string }>
const entry = (id: string, text: string): Entry => Object.freeze({ id, text })
/** Exactly the bundle's content keys, in order, besides manifest and generatedAt. */
export const SUPPORT_BUNDLE_SECTIONS: readonly Entry[] = Object.freeze([
  entry('versions', msgid('Panel release named by /opt/xpanel/current and confirmed by its VERSION marker; the agent Node.js runtime version.')),
  entry('os', msgid('Detected OS profile (id, version, family) and PRETTY_NAME, ID and VERSION_ID from os-release.')),
  entry('uptime', msgid('Seconds since boot from /proc/uptime.')),
  entry('services', msgid('Panel-known services: systemd unit and ActiveState from systemctl show.')),
  entry('resources', msgid('MemTotal, MemAvailable, SwapTotal and SwapFree from /proc/meminfo; sizes and inode counts of at most {filesystems} filesystems from df.')),
  entry('generation', msgid('The active configuration generation: number, status, times and file-set checksum, without the actor.')),
  entry('drift', msgid('Configuration drift: generation number and counts of changed managed files by reason, without file paths.')),
  entry('failedJobs', msgid('The {failedJobs} most recent failed host jobs: persisted official reference (null when unnumbered), internal linking id, kind, failure class, times, step states and the redacted error, without summary, actor or account.')),
  entry('journal', msgid('Up to the last {journalLines} journal entries of each of xpanel-agent.service and xpanel-api.service: time, priority, pid and the redacted message, newest first, at most 384 KiB per unit after redaction.')),
])
export const SUPPORT_BUNDLE_EXCLUDED: readonly Entry[] = Object.freeze([
  entry('state', msgid('Panel state files and the SQLite index database.')),
  entry('secrets', msgid('Keys, certificates, tokens, passwords and the .secrets directory.')),
  entry('accounts', msgid('Account, domain, mailbox and database records, and any account file.')),
  entry('configuration', msgid('Rendered configuration files and drift file paths.')),
  entry('journal-fields', msgid('Journal fields other than time, priority, pid and message, such as the command line.')),
])
const MANIFEST_BODY = { schemaVersion: 1, format: 'application/json', sections: SUPPORT_BUNDLE_SECTIONS, excluded: SUPPORT_BUNDLE_EXCLUDED, redaction: SUPPORT_REDACTION_RULES, hashing: SUPPORT_HASH_RULE, limits: SUPPORT_LIMITS }
/** A change to any listed content or rule changes the id, so a download is bound to the manifest the administrator reviewed. */
export const SUPPORT_BUNDLE_MANIFEST = Object.freeze({ id: createHash('sha256').update(JSON.stringify(MANIFEST_BODY)).digest('hex').slice(0, 16), ...MANIFEST_BODY })
export type SupportBundleManifest = typeof SUPPORT_BUNDLE_MANIFEST

type Read = 'read' | 'unavailable'
export interface SupportRelease { state: Read; version: string | null; releasePath: string | null }
export interface SupportOs { profile: { id: string; versionId: string; family: string }; release: { state: Read; id: string | null; versionId: string | null; prettyName: string | null } }
export interface SupportGeneration { state: 'read' | 'none' | 'unavailable'; id: number | null; status: string | null; createdAt: string | null; testedAt: string | null; activatedAt: string | null; checksum: string | null }
export interface SupportDrift { state: 'read' | 'none' | 'unavailable'; generationId: number | null; manifestMissing: boolean | null; count: number | null; byReason: Record<string, number> }
export interface SupportFailedJob {
  id: string; referenceCode: string | null; kind: string; failureClass: HostJobView['failureClass']; createdAt: string; startedAt: string | null; finishedAt: string | null
  error: string | null; steps: { id: string; state: string; exitCode: number | null }[]
}
export interface SupportSummary {
  observedAt: string; host: Read
  versions: { panel: SupportRelease; node: string }
  os: SupportOs
  uptime: { state: Read; seconds: number | null }
  services: { state: Read; items: HostServiceStatus[] }
  generation: SupportGeneration
  drift: SupportDrift
  failedJobs: { state: Read; items: SupportFailedJob[] }
}
export interface SupportJournalEntry { at: string; priority: number | null; pid: number | null; message: string | null; messageTruncated: boolean }
export interface SupportJournalUnit { state: Read; reason: string | null; truncated: boolean; items: SupportJournalEntry[] }
export interface SupportResources {
  memory: { state: Read; totalBytes: number | null; availableBytes: number | null; swapTotalBytes: number | null; swapFreeBytes: number | null }
  filesystems: { state: Read; truncated: boolean; items: { filesystem: string; type: string; mount: string; totalBytes: number; usedBytes: number; availableBytes: number; inodes: { total: number; used: number; free: number } | null }[] }
}
export interface SupportBundle extends Omit<SupportSummary, 'observedAt' | 'host'> {
  manifest: SupportBundleManifest; generatedAt: string; resources: SupportResources; journal: Record<typeof SUPPORT_JOURNAL_UNITS[number], SupportJournalUnit>
}

export interface SupportRouteContext {
  /** Re-authenticates the current caller and requires root on every call. */
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Native Linux host only; null keeps every host observation unavailable. */
  host: { run: MonitoringRun; readFile: (path: string) => Promise<string | null>; releaseFs: UpgradeHostFs } | null
  os: { id: string; versionId: string; family: string }
  latestGeneration: () => Promise<ConfigGeneration | null>
  readDrift: (() => Promise<RepairDriftObservation>) | null
  /** The host job runner's failed jobs, newest first; null when no runner exists. */
  listFailedJobs: ((limit: number) => Promise<readonly HostJobView[]>) | null
  now?: () => Date
  /** Tests only: a fixed redaction key. */
  redactionKey?: Uint8Array
}

const unchanged = { stateChanged: false }
const attempt = async <T>(read: () => Promise<T>): Promise<T | null> => { try { return await read() } catch { return null } }
const EXACT_VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/

/** Same release identity rule as observeUpgradeInputs: the current link names releases/<exact version> and its VERSION marker agrees. */
export async function readPanelRelease(fs: UpgradeHostFs): Promise<SupportRelease> {
  const target = await attempt(() => fs.readlink(DEFAULT_LAYOUT.currentLink))
  const version = target && posix.dirname(target) === DEFAULT_LAYOUT.releasesDir && EXACT_VERSION.test(posix.basename(target)) ? posix.basename(target) : null
  const marker = version ? await attempt(async () => (await fs.read(target + '/VERSION', 64)).bytes.toString('utf8').trim()) : null
  return version && marker === version ? { state: 'read', version, releasePath: target } : { state: 'unavailable', version: null, releasePath: null }
}

async function readOs(ctx: SupportRouteContext): Promise<SupportOs> {
  const profile = { id: ctx.os.id, versionId: ctx.os.versionId, family: ctx.os.family }
  const host = ctx.host
  // os-release(5): /usr/lib/os-release is read only when /etc/os-release is absent.
  const text = host ? await attempt(async () => (await host.readFile('/etc/os-release')) ?? await host.readFile('/usr/lib/os-release')) : null
  const release = text ? await attempt(async () => parseOsRelease(text)) : null
  return { profile, release: release ? { state: 'read', id: release.id, versionId: release.versionId, prettyName: release.prettyName } : { state: 'unavailable', id: null, versionId: null, prettyName: null } }
}

async function readGeneration(ctx: SupportRouteContext): Promise<SupportGeneration> {
  const none = { id: null, status: null, createdAt: null, testedAt: null, activatedAt: null, checksum: null }
  let active: ConfigGeneration | null
  try { active = await ctx.latestGeneration() } catch { return { state: 'unavailable', ...none } }
  return active ? { state: 'read', id: active.id, status: active.status, createdAt: active.createdAt, testedAt: active.testedAt, activatedAt: active.activatedAt, checksum: active.checksum } : { state: 'none', ...none }
}

async function readDriftSummary(ctx: SupportRouteContext): Promise<SupportDrift> {
  const report = ctx.readDrift ? await attempt(ctx.readDrift) : null
  if (!report || typeof report.hasDrift !== 'boolean' || !Array.isArray(report.items)) return { state: 'unavailable', generationId: null, manifestMissing: null, count: null, byReason: {} }
  const byReason: Record<string, number> = {}
  for (const item of report.items) byReason[String(item.reason)] = (byReason[String(item.reason)] ?? 0) + 1
  return { state: report.generationId === null ? 'none' : 'read', generationId: report.generationId, manifestMissing: report.manifestMissing, count: report.items.length, byReason }
}

async function readFailedJobs(ctx: SupportRouteContext): Promise<SupportSummary['failedJobs']> {
  const jobs = ctx.listFailedJobs ? await attempt(() => ctx.listFailedJobs!(SUPPORT_LIMITS.failedJobs)) : null
  if (!jobs) return { state: 'unavailable', items: [] }
  return { state: 'read', items: jobs.filter(job => job.status === 'failed').slice(0, SUPPORT_LIMITS.failedJobs).map(job => ({
    id: job.id, referenceCode: job.referenceCode, kind: job.kind, failureClass: job.failureClass, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
    error: job.error === null ? null : job.error.slice(0, SUPPORT_LIMITS.jobErrorChars).toWellFormed(),
    steps: job.steps.slice(0, SUPPORT_LIMITS.jobSteps).map(step => ({ id: step.id, state: step.state, exitCode: step.exitCode })),
  })) }
}

/** The page summary: observed facts only; any failed read is unavailable, never assumed. */
export async function readSupportSummary(ctx: SupportRouteContext): Promise<SupportSummary> {
  const host = ctx.host
  const [panel, os, uptimeText, services, generation, drift, failedJobs] = await Promise.all([
    host ? readPanelRelease(host.releaseFs) : Promise.resolve<SupportRelease>({ state: 'unavailable', version: null, releasePath: null }),
    readOs(ctx), host ? attempt(() => host.readFile('/proc/uptime')) : null,
    host ? attempt(() => readHostServices(host.run)) : null, readGeneration(ctx), readDriftSummary(ctx), readFailedJobs(ctx),
  ])
  const seconds = uptimeText ? parseProcUptime(uptimeText) : null
  return {
    observedAt: (ctx.now ?? (() => new Date()))().toISOString(), host: host ? 'read' : 'unavailable',
    versions: { panel, node: process.version }, os,
    uptime: seconds === null ? { state: 'unavailable', seconds: null } : { state: 'read', seconds },
    services: services && services.some(row => row.state !== 'unchecked') ? { state: 'read', items: services } : { state: 'unavailable', items: services ?? [] },
    generation, drift, failedJobs,
  }
}

// proc(5): /proc/meminfo reports SwapTotal and SwapFree in kB.
const meminfoBytes = (text: string, key: string): number | null => { const match = new RegExp(`^${key}:\\s+(\\d{1,15})\\s+kB$`, 'm').exec(text); return match ? Number(match[1]) * 1024 : null }
async function readResources(host: NonNullable<SupportRouteContext['host']>): Promise<SupportResources> {
  const text = await attempt(() => host.readFile('/proc/meminfo'))
  const memory = text ? await attempt(async () => parseMeminfo(text)) : null
  // Accounts are not passed, so readDisk runs no quota report and reads no account data.
  const disk = await attempt(() => readDisk(host.run, undefined, []))
  const filesystems = disk?.filesystems.state === 'read' ? disk.filesystems.items : null
  return {
    memory: memory ? { state: 'read', totalBytes: memory.totalBytes, availableBytes: memory.availableBytes, swapTotalBytes: meminfoBytes(text!, 'SwapTotal'), swapFreeBytes: meminfoBytes(text!, 'SwapFree') }
      : { state: 'unavailable', totalBytes: null, availableBytes: null, swapTotalBytes: null, swapFreeBytes: null },
    filesystems: filesystems ? { state: 'read', truncated: filesystems.length > SUPPORT_LIMITS.filesystems, items: filesystems.slice(0, SUPPORT_LIMITS.filesystems) } : { state: 'unavailable', truncated: false, items: [] },
  }
}

async function readJournal(host: NonNullable<SupportRouteContext['host']>, unit: string, redact: SupportRedactor, now: () => Date): Promise<SupportJournalUnit> {
  const read = await attempt(() => readLogs(host.run, { unit, lines: SUPPORT_LIMITS.journalLines, since: null, priority: null }, now))
  if (!read || read.state !== 'read') return { state: 'unavailable', reason: read?.reason ?? 'journal-unavailable', truncated: false, items: [] }
  const items: SupportJournalEntry[] = []
  let bytes = 0, truncated = read.truncated
  for (const raw of read.items) {
    const item = redactSupportValue({ at: raw.at, priority: raw.priority, pid: raw.pid, message: raw.message, messageTruncated: raw.messageTruncated }, redact)
    bytes += Buffer.byteLength(JSON.stringify(item)) + 1
    if (bytes > SUPPORT_LIMITS.journalBytesPerUnit) { truncated = true; break }
    items.push(item)
  }
  return { state: 'read', reason: null, truncated, items }
}

/** The downloadable diagnostics: the summary plus resources and journals, all redacted, bounded below the transport limit. */
export async function buildSupportBundle(ctx: SupportRouteContext): Promise<SupportBundle> {
  const now = ctx.now ?? (() => new Date()), redact = createSupportRedactor(ctx.redactionKey)
  const { observedAt, host: _host, ...summary } = await readSupportSummary(ctx)
  const host = ctx.host
  const unavailable: SupportJournalUnit = { state: 'unavailable', reason: 'journal-unavailable', truncated: false, items: [] }
  const [resources, agent, api] = await Promise.all([
    host ? readResources(host) : Promise.resolve<SupportResources>({ memory: { state: 'unavailable', totalBytes: null, availableBytes: null, swapTotalBytes: null, swapFreeBytes: null }, filesystems: { state: 'unavailable', truncated: false, items: [] } }),
    host ? readJournal(host, SUPPORT_JOURNAL_UNITS[0], redact, now) : unavailable, host ? readJournal(host, SUPPORT_JOURNAL_UNITS[1], redact, now) : unavailable,
  ])
  const content = redactSupportValue({ versions: summary.versions, os: summary.os, uptime: summary.uptime, services: summary.services, resources, generation: summary.generation, drift: summary.drift, failedJobs: summary.failedJobs }, redact)
  const bundle: SupportBundle = { manifest: SUPPORT_BUNDLE_MANIFEST, generatedAt: observedAt, ...content, journal: { [SUPPORT_JOURNAL_UNITS[0]]: agent, [SUPPORT_JOURNAL_UNITS[1]]: api } as SupportBundle['journal'] }
  if (Buffer.byteLength(JSON.stringify(bundle)) > SUPPORT_LIMITS.bundleBytes) return fail('LIMIT_EXCEEDED', 'the support bundle exceeds its size bound', unchanged)
  return bundle
}

const ROUTES: Readonly<Record<string, string>> = { '/host/support': 'server.support.read', '/host/support/bundle': 'server.support.bundle' }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** GET /host/support (summary) and GET /host/support/bundle (redacted diagnostics). Root only, read-only. Returns null for other paths. */
export async function handleSupportRoute(req: Request, url: URL, method: string, ctx: SupportRouteContext): Promise<Response | null> {
  const action = ROUTES[url.pathname]
  if (!action) return null
  await ctx.assertRoot(action)
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search || req.body !== null) return fail('VALIDATION', 'support reads do not accept selectors or a body', unchanged)
  const body = url.pathname === '/host/support' ? await readSupportSummary(ctx) : await buildSupportBundle(ctx)
  // A caller whose root authority ended during the read never receives host facts.
  await ctx.assertRoot(action)
  return json(body)
}
