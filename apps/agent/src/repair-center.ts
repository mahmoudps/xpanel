import { createHash } from 'node:crypto'
import { fail, msgctxt, msgid, sourceMessage } from '@xpanel/core'
import type { ConfigTest } from '@xpanel/core'
import {
  APT_CHECK_ARGV, APT_FIX_BROKEN_ARGV, APT_FIX_BROKEN_NO_REMOVE_ARGV, APT_FIX_PREVIEW_ARGV, DNF_CHECK_ARGV, DPKG_AUDIT_ARGV,
  DPKG_CONFIGURE_PENDING_ARGV, REPAIR_MUTATION_ENV, isRepairCommand, RPMDB_VERIFY_ARGV, DNF_CACHE_CHECK_ARGV, DNF_CACHE_CLEAN_ARGV, DNF_CACHE_REFRESH_ARGV,
} from '../../../packages/os/src/repair-command.ts'
import { RPM_INSTALLED_IDENTITY_ARGV, RPMDB_REBUILD_ARGV } from '../../../packages/os/src/ops-package-recovery-command.ts'
import type { HostJobCommandStep, HostJobPlan, HostJobVerification } from './host-job-contract.ts'

export type RepairFamily = 'debian' | 'rhel'
export interface RepairCommandResult { ok: boolean; code: number | null; stdout: string; stderr: string; timedOut?: boolean }
export type RepairRun = (argv: readonly string[]) => Promise<RepairCommandResult>
export type RepairRunTest = (test: ConfigTest) => Promise<RepairCommandResult>
/** Structural subset of the reconciler DriftReport; the existing reviewed reader supplies it. */
export interface RepairDriftObservation {
  hasDrift: boolean
  manifestMissing: boolean
  generationId: number | null
  items: readonly { path: string; reason: string }[]
}

export type RepairState = 'ok' | 'problem' | 'unavailable'
export type RepairJobId = 'dpkg-configure' | 'apt-fix-broken' | 'dnf-cache-refresh' | 'rpmdb-rebuild'
export type RepairId = RepairJobId | 'dnf-repair' | 'configuration-generations'
export interface RepairAction { id: RepairId; available: boolean; reason?: string; kind: 'job' | 'existing-workflow'; href?: string }
export interface RepairDiagnostic {
  id: string
  area: 'packages' | 'services' | 'configuration'
  state: RepairState
  /** English source message (or a msgctxt key); the web UI translates it. */
  cause: string
  evidence: string
  repair: RepairAction
}
export interface RepairReport { observedAt: string; family: RepairFamily; revision: string; diagnostics: RepairDiagnostic[] }

export interface RepairPreview {
  repairId: RepairJobId
  source: 'apt-simulation' | 'dpkg-audit' | 'dnf-cache-only' | 'rpm-database'
  state: 'ready' | 'unavailable'
  reason?: string
  install: string[]
  remove: string[]
  configure: string[]
  counts: { install: number; remove: number; configure: number }
  removalFingerprint: string
  evidence: string
}

export const REPAIR_JOB_IDS: readonly RepairJobId[] = ['dpkg-configure', 'apt-fix-broken', 'dnf-cache-refresh', 'rpmdb-rebuild']
/** Repairs that run only on RHEL-family hosts; every other job id is Debian-only. */
export const RHEL_REPAIR_JOB_IDS: readonly RepairJobId[] = ['dnf-cache-refresh', 'rpmdb-rebuild']
export const isRepairJobId = (value: unknown): value is RepairJobId => REPAIR_JOB_IDS.includes(value as RepairJobId)
const DIAGNOSTIC_FOR: Readonly<Record<RepairJobId, string>> = { 'dpkg-configure': 'dpkg-interrupted', 'apt-fix-broken': 'apt-broken-dependencies', 'dnf-cache-refresh': 'dnf-metadata-cache', 'rpmdb-rebuild': 'rpm-database-integrity' }
export const repairDiagnosticId = (repairId: RepairJobId): string => DIAGNOSTIC_FOR[repairId]
const CONFIGURATION_HREF = '/whm/services/web'

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_LINES = 20000
const MAX_EVIDENCE_BYTES = 8192
const MAX_PACKAGES = 2000
const MAX_CONFIG_TESTS = 16
const DEB_PACKAGE = '[a-z0-9][a-z0-9+.-]{0,127}(?::[a-z0-9-]{1,32})?'

/** Control, bidi and ANSI sequences removed; at most 8 KiB of UTF-8. */
export function boundedEvidence(parts: readonly string[], maxBytes = MAX_EVIDENCE_BYTES): string {
  const text = parts.filter(part => typeof part === 'string' && part.length > 0).join('\n')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '').trim()
  if (Buffer.byteLength(text) <= maxBytes) return text
  return Buffer.from(text).subarray(0, maxBytes - 16).toString('utf8').replace(/\ufffd+$/, '') + '\n[truncated]'
}

const commandEvidence = (argv: readonly string[], result: RepairCommandResult | null): string =>
  boundedEvidence(['$ ' + argv.join(' '), result?.stdout ?? '', result?.stderr ?? '', result ? (result.timedOut ? '(timed out)' : '(exit ' + String(result.code) + ')') : '(not run)'])

const oversized = (result: RepairCommandResult): boolean =>
  typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
  || Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES || Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES

const lines = (text: string): string[] | null => {
  const split = text.replace(/\r\n?/g, '\n').split('\n')
  return split.length > MAX_LINES ? null : split
}

const locked = (text: string): boolean => /Could not get lock|Unable to acquire the dpkg frontend lock|Unable to lock the administration directory|Another process has locked the database/.test(text)

const safeRun = async (run: RepairRun, argv: readonly string[]): Promise<RepairCommandResult | null> => {
  try {
    const result = await run([...argv])
    return result && typeof result === 'object' ? result : null
  } catch { return null }
}

export type ParsedState<T> = { state: 'ok' } | { state: 'problem'; detail: T } | { state: 'unavailable'; reason: string }

export interface DpkgAuditFinding { packages: string[]; configurable: string[]; reinstallOnly: boolean }

/**
 * dpkg(1) --audit prints, per problem class, an explanation paragraph followed by
 * one ` <package> <description>` line per package (describebriefly). No output means no problem.
 */
export function parseDpkgAudit(result: RepairCommandResult): ParsedState<DpkgAuditFinding> {
  if (result.timedOut || oversized(result)) return { state: 'unavailable', reason: 'command-failed' }
  if (locked(result.stdout + '\n' + result.stderr)) return { state: 'unavailable', reason: 'locked' }
  if (result.code !== 0 && result.code !== 1) return { state: 'unavailable', reason: 'command-failed' }
  if (!result.stdout.trim()) return result.code === 0 && !result.stderr.trim() ? { state: 'ok' } : { state: 'unavailable', reason: 'command-failed' }
  const rows = lines(result.stdout)
  if (!rows) return { state: 'unavailable', reason: 'malformed' }
  const packageLine = new RegExp('^ (' + DEB_PACKAGE + ')(?: +.*)?$')
  const packages = new Set<string>(), configurable = new Set<string>()
  let header = '', sectionPackages: string[] = [], classified = false, anyConfigurable = false, anyUnclassified = false
  const close = (): void => {
    if (sectionPackages.length) {
      const text = header.toLowerCase().replace(/\s+/g, ' ')
      const configure = /not yet configured|half configured|awaiting processing of triggers|have been triggered/.test(text)
      const reinstall = !configure && /reinstall|half installed/.test(text)
      if (configure) { anyConfigurable = true; for (const name of sectionPackages) configurable.add(name) }
      else if (!reinstall) anyUnclassified = true
      classified = true
    }
    header = ''; sectionPackages = []
  }
  for (const row of rows) {
    if (!row.trim()) { close(); continue }
    const match = packageLine.exec(row)
    if (match) { packages.add(match[1]!); sectionPackages.push(match[1]!); continue }
    if (/^\s/.test(row)) return { state: 'unavailable', reason: 'malformed' }
    if (sectionPackages.length) close()
    header += ' ' + row
  }
  close()
  if (!classified || packages.size === 0 || packages.size > MAX_PACKAGES) return { state: 'unavailable', reason: 'malformed' }
  // An unrecognized (for example localized) explanation is not assumed to be reinstall-only.
  const reinstallOnly = !anyConfigurable && !anyUnclassified
  return { state: 'problem', detail: { packages: [...packages].sort(), configurable: [...(anyUnclassified && !anyConfigurable ? packages : configurable)].sort(), reinstallOnly } }
}

/** apt-get(8) check: exit 0 on success, 100 on error; unmet dependencies are listed as ` <pkg> : Depends: …`. */
export function parseAptCheck(result: RepairCommandResult): ParsedState<{ packages: string[] }> {
  if (result.timedOut || oversized(result)) return { state: 'unavailable', reason: 'command-failed' }
  const all = result.stdout + '\n' + result.stderr
  if (/dpkg was interrupted/.test(all)) return { state: 'unavailable', reason: 'blocked-by-dpkg' }
  if (locked(all)) return { state: 'unavailable', reason: 'locked' }
  const rows = lines(result.stdout)
  if (!rows) return { state: 'unavailable', reason: 'malformed' }
  const unmet = new RegExp('^ (' + DEB_PACKAGE + ') : [A-Z][A-Za-z-]+: ')
  const packages = [...new Set(rows.map(row => unmet.exec(row)?.[1]).filter((name): name is string => !!name))].sort()
  const errorLine = /^E: /m.test(result.stderr)
  if (result.code === 0) return !errorLine && packages.length === 0 && !/unmet dependencies/i.test(all) ? { state: 'ok' } : { state: 'unavailable', reason: 'malformed' }
  if (result.code !== 100 || packages.length > MAX_PACKAGES) return { state: 'unavailable', reason: 'command-failed' }
  if (packages.length || /^E: Unmet dependencies/m.test(result.stderr)) return { state: 'problem', detail: { packages } }
  return { state: 'unavailable', reason: 'command-failed' }
}

/** dnf(8) check: no output and exit 0 when clean; each problem is one `<nevra> <problem>` line. */
export function parseDnfCheck(result: RepairCommandResult): ParsedState<{ packages: string[] }> {
  if (result.timedOut || oversized(result)) return { state: 'unavailable', reason: 'command-failed' }
  const rows = lines(result.stdout + '\n' + result.stderr)
  if (!rows) return { state: 'unavailable', reason: 'malformed' }
  if (result.code === 0) return !result.stdout.trim() && !/^Error:/m.test(result.stderr) ? { state: 'ok' } : { state: 'unavailable', reason: 'malformed' }
  if (result.code !== 1) return { state: 'unavailable', reason: 'command-failed' }
  const problem = /^((?:[0-9]+:)?[A-Za-z0-9_.+-]+-(?:[0-9]+:)?[^\s-]+-[^\s-]+\.[A-Za-z0-9_]+) (?:has|is|provides) .+$/
  const packages = [...new Set(rows.map(row => problem.exec(row)?.[1]).filter((name): name is string => !!name))].sort()
  const counted = Number(/^Error: Check discovered (\d+) problem\(s\)/m.exec(result.stderr + '\n' + result.stdout)?.[1] ?? 0)
  if (packages.length > MAX_PACKAGES) return { state: 'unavailable', reason: 'malformed' }
  return packages.length || counted > 0 ? { state: 'problem', detail: { packages } } : { state: 'unavailable', reason: 'malformed' }
}

/** Only a verified empty success or the known cache-only missing-cache refusal is classified. */
export function parseDnfCache(result: RepairCommandResult): ParsedState<null> {
  if (result.timedOut || oversized(result) || result.code === 200) return { state: 'unavailable', reason: 'command-failed' }
  const output = result.stdout + '\n' + result.stderr
  if (result.ok && result.code === 0 && !result.stderr.trim() && (!result.stdout.trim() || result.stdout.trim() === 'Metadata cache created.')) return { state: 'ok' }
  if (!result.ok && result.code === 1 && /(?:^|\n)(?:Error: )?Cache-only enabled but no cache for ['"][A-Za-z0-9_.:-]{1,128}['"](?:\.|$)/m.test(output)) return { state: 'problem', detail: null }
  return { state: 'unavailable', reason: 'command-failed' }
}

/** A rebuild is offered only while the installed header list is readable, so its exact identity can be proven unchanged afterwards. */
async function diagnoseRpmDb(run: RepairRun, rebuildRecoveryAvailable = false): Promise<RepairDiagnostic> {
  const result = await safeRun(run, RPMDB_VERIFY_ARGV)
  const healthy = !!result && !result.timedOut && !oversized(result) && result.ok && result.code === 0 && !result.stdout.trim() && !result.stderr.trim()
  const corrupt = !!result && !result.timedOut && !oversized(result) && !result.ok && result.code !== 0 && /database disk image is malformed|DB_RUNRECOVERY|database corruption/i.test(result.stdout + '\n' + result.stderr)
  const identity = corrupt && rebuildRecoveryAvailable ? await safeRun(run, RPM_INSTALLED_IDENTITY_ARGV) : null
  const readable = !!identity && identity.ok && identity.code === 0 && !identity.timedOut && !oversized(identity) && !identity.stderr.trim() && identity.stdout.trim().length > 0
  const repair: RepairAction = { id: 'rpmdb-rebuild', kind: 'job', available: readable, ...(readable ? {} : { reason: healthy ? 'no_problem' : !corrupt ? 'diagnostic_unavailable' : rebuildRecoveryAvailable ? 'rpm_headers_unreadable' : 'rpm_recovery_unavailable' }) }
  return { id: 'rpm-database-integrity', area: 'packages', state: healthy ? 'ok' : corrupt ? 'problem' : 'unavailable', evidence: commandEvidence(RPMDB_VERIFY_ARGV, result), repair, cause: healthy ? msgid('The RPM database low-level integrity check passed. Installed files and dependencies are separate checks.') : readable ? msgid('The RPM database failed its integrity check while its installed package list is still readable. A rebuild runs after a verified snapshot and is restored unless the same packages remain installed.') : msgid('RPM database integrity could not be confirmed. Automatic database rebuild is unavailable because it can discard corrupt package headers.') }
}

async function diagnoseDnfCache(run: RepairRun, recoveryAvailable: boolean): Promise<RepairDiagnostic> {
  const result = await safeRun(run, DNF_CACHE_CHECK_ARGV), parsed = result ? parseDnfCache(result) : { state: 'unavailable' as const, reason: 'command-failed' }
  return { id: 'dnf-metadata-cache', area: 'packages', state: parsed.state, evidence: commandEvidence(DNF_CACHE_CHECK_ARGV, result), repair: { id: 'dnf-cache-refresh', kind: 'job', available: parsed.state === 'problem' && recoveryAvailable, ...(parsed.state === 'ok' ? { reason: 'no_problem' } : parsed.state === 'unavailable' ? { reason: 'diagnostic_unavailable' } : !recoveryAvailable ? { reason: 'cache_recovery_unavailable' } : {}) }, cause: parsed.state === 'ok' ? msgid('Enabled repository metadata can be read from the existing system cache. This does not prove it is current.') : parsed.state === 'problem' ? msgid('At least one enabled repository has no usable cached metadata. The bounded repair refreshes repository metadata only; it does not repair or change installed packages.') : msgid('Repository metadata cache could not be checked without a network update. Its state is unverified.') }
}

export interface AptSimulation { install: string[]; remove: string[]; configure: string[] }

/** apt-get(8) -s prints one `Inst|Remv|Purg|Conf <pkg> [current] (candidate …)` line per simulated dpkg operation. */
export function parseAptSimulation(result: RepairCommandResult): { state: 'ready'; plan: AptSimulation } | { state: 'unavailable'; reason: string } {
  if (result.timedOut || oversized(result)) return { state: 'unavailable', reason: 'command-failed' }
  const all = result.stdout + '\n' + result.stderr
  if (/dpkg was interrupted/.test(all)) return { state: 'unavailable', reason: 'blocked-by-dpkg' }
  if (locked(all)) return { state: 'unavailable', reason: 'locked' }
  if (result.code !== 0) return { state: 'unavailable', reason: /Unable to correct/.test(all) ? 'unresolvable' : 'command-failed' }
  if (/^E: /m.test(result.stderr)) return { state: 'unavailable', reason: 'malformed' }
  const rows = lines(result.stdout)
  if (!rows) return { state: 'unavailable', reason: 'malformed' }
  const operation = new RegExp('^(Inst|Remv|Purg|Conf) (' + DEB_PACKAGE + ')(?: \\[[^\\]]*\\])?(?: \\([^)]*\\))?(?: \\[[^\\]]*\\])*$')
  const install = new Set<string>(), remove = new Set<string>(), configure = new Set<string>()
  for (const row of rows) {
    if (!/^(?:Inst|Remv|Purg|Conf) /.test(row)) continue
    const match = operation.exec(row)
    if (!match) return { state: 'unavailable', reason: 'malformed' }
    const target = match[1] === 'Inst' ? install : match[1] === 'Conf' ? configure : remove
    target.add(match[2]!)
  }
  if (install.size + remove.size + configure.size > MAX_PACKAGES) return { state: 'unavailable', reason: 'malformed' }
  const summary = /^\d+ upgraded, \d+ newly installed, (?:\d+ reinstalled, )?(?:\d+ downgraded, )?(\d+) to remove and \d+ not upgraded\.$/m.exec(result.stdout)
  // The removal list is what a person accepts: an English summary that disagrees with it is refused.
  if (summary && Number(summary[1]) !== remove.size) return { state: 'unavailable', reason: 'malformed' }
  return { state: 'ready', plan: { install: [...install].sort(), remove: [...remove].sort(), configure: [...configure].sort() } }
}

export const removalFingerprint = (packages: readonly string[]): string =>
  createHash('sha256').update('xpanel-repair-removals:v1\n' + [...new Set(packages)].sort().join('\n')).digest('hex')

const UNAVAILABLE_REASON = (reason: string): string => reason === 'locked' ? 'package_database_locked' : reason === 'blocked-by-dpkg' ? 'blocked_by_dpkg' : 'diagnostic_unavailable'

async function diagnoseDpkg(run: RepairRun): Promise<RepairDiagnostic> {
  const result = await safeRun(run, DPKG_AUDIT_ARGV)
  const parsed = result ? parseDpkgAudit(result) : { state: 'unavailable' as const, reason: 'command-failed' }
  const base = { id: 'dpkg-interrupted', area: 'packages' as const, evidence: commandEvidence(DPKG_AUDIT_ARGV, result) }
  const job = (available: boolean, reason?: string): RepairAction => ({ id: 'dpkg-configure', available, kind: 'job', ...(reason ? { reason } : {}) })
  if (parsed.state === 'ok') return { ...base, state: 'ok', cause: msgid('No interrupted or partially installed packages were reported.'), repair: job(false, 'no_problem') }
  if (parsed.state === 'unavailable') return { ...base, state: 'unavailable', repair: job(false, UNAVAILABLE_REASON(parsed.reason)), cause: parsed.reason === 'locked'
    ? msgid('Another process holds the package database lock. Wait for it to finish, then run diagnostics again.')
    : msgid('The package database audit could not be completed or verified, so its state is unknown.') }
  if (parsed.detail.reinstallOnly) return { ...base, state: 'problem', repair: job(false, 'reinstall_required'),
    cause: msgid('Some packages are half installed or need reinstallation. Completing package configuration cannot repair this state.') }
  return { ...base, state: 'problem', repair: job(true),
    cause: msgid('Package configuration was interrupted. Some packages are unpacked or only partly configured, and other package operations are blocked until configuration completes.') }
}

async function diagnoseApt(run: RepairRun): Promise<RepairDiagnostic> {
  const result = await safeRun(run, APT_CHECK_ARGV)
  const parsed = result ? parseAptCheck(result) : { state: 'unavailable' as const, reason: 'command-failed' }
  const base = { id: 'apt-broken-dependencies', area: 'packages' as const, evidence: commandEvidence(APT_CHECK_ARGV, result) }
  const job = (available: boolean, reason?: string): RepairAction => ({ id: 'apt-fix-broken', available, kind: 'job', ...(reason ? { reason } : {}) })
  if (parsed.state === 'ok') return { ...base, state: 'ok', cause: msgid('APT reported no broken package dependencies.'), repair: job(false, 'no_problem') }
  if (parsed.state === 'problem') return { ...base, state: 'problem', repair: job(true),
    cause: msgid('Installed packages have unmet dependencies. Package installs and updates will fail until they are corrected.') }
  return { ...base, state: 'unavailable', repair: job(false, UNAVAILABLE_REASON(parsed.reason)), cause: parsed.reason === 'blocked-by-dpkg'
    ? msgid('The dependency check is blocked because package configuration was interrupted. Repair the interrupted configuration first.')
    : parsed.reason === 'locked' ? msgid('Another process holds the package database lock. Wait for it to finish, then run diagnostics again.')
      : msgid('The dependency check could not be completed or verified, so dependency state is unknown.') }
}

async function diagnoseDnf(run: RepairRun): Promise<RepairDiagnostic> {
  const result = await safeRun(run, DNF_CHECK_ARGV)
  const parsed = result ? parseDnfCheck(result) : { state: 'unavailable' as const, reason: 'command-failed' }
  const base = { id: 'dnf-package-problems', area: 'packages' as const, evidence: commandEvidence(DNF_CHECK_ARGV, result) }
  const repair = (reason: string): RepairAction => ({ id: 'dnf-repair', available: false, kind: 'job', reason })
  if (parsed.state === 'ok') return { ...base, state: 'ok', cause: msgid('DNF reported no problems in the local package database.'), repair: repair('no_problem') }
  if (parsed.state === 'problem') return { ...base, state: 'problem', repair: repair('rhel_repair_not_reviewed'),
    cause: msgid('DNF found problems in the local package database, such as missing dependencies or duplicate packages.') }
  return { ...base, state: 'unavailable', repair: repair('diagnostic_unavailable'), cause: msgid('The DNF package check could not be completed or verified, so package database state is unknown.') }
}

const configurationRepair = (available: boolean, reason?: string): RepairAction => ({ id: 'configuration-generations', available, kind: 'existing-workflow', href: CONFIGURATION_HREF, ...(reason ? { reason } : {}) })

async function diagnoseConfigTest(test: ConfigTest, runTest: RepairRunTest | undefined): Promise<RepairDiagnostic> {
  let result: RepairCommandResult | null = null
  if (runTest) try { result = await runTest({ name: test.name, argv: [...test.argv] }) } catch { result = null }
  const base = { id: 'service-config:' + test.name, area: 'services' as const, evidence: commandEvidence(test.argv, result) }
  // execFile reports a missing binary as `spawn <path> ENOENT`; a config error is a real problem.
  if (!result || result.timedOut || oversized(result) || !result.ok && /\bspawn \S+ ENOENT\b/.test(result.stderr))
    return { ...base, state: 'unavailable', repair: configurationRepair(false, 'diagnostic_unavailable'), cause: msgid('The configuration test could not run, so this configuration is unverified.') }
  if (result.ok) return { ...base, state: 'ok', repair: configurationRepair(false, 'no_problem'), cause: msgid('The configuration test passed.') }
  return { ...base, state: 'problem', repair: configurationRepair(true), cause: msgid('The configuration test failed. The service may refuse to start or reload until its configuration is corrected or a reviewed generation is restored.') }
}

async function diagnoseDrift(readDrift: (() => Promise<RepairDriftObservation>) | undefined): Promise<RepairDiagnostic> {
  const base = { id: 'configuration-drift', area: 'configuration' as const }
  let report: RepairDriftObservation | null = null
  if (readDrift) try { report = await readDrift() } catch { report = null }
  if (!report || typeof report.hasDrift !== 'boolean' || !Array.isArray(report.items)) return { ...base, state: 'unavailable', evidence: '', repair: configurationRepair(false, 'diagnostic_unavailable'), cause: msgid('Configuration drift could not be read.') }
  const listed = report.items.slice(0, 50).map(item => String(item.reason) + ' ' + String(item.path))
  const evidence = boundedEvidence(['generation ' + String(report.generationId), ...listed, report.items.length > 50 ? '… ' + String(report.items.length - 50) + ' more' : ''])
  if (report.manifestMissing) return { ...base, state: 'problem', evidence, repair: configurationRepair(true), cause: msgid('The active generation file manifest is missing, so managed files cannot be compared. Review configuration generations.') }
  if (report.generationId === null) return { ...base, state: 'unavailable', evidence, repair: configurationRepair(false, 'diagnostic_unavailable'), cause: msgctxt('repair-center', 'No configuration generation is active, so there is nothing to compare.') }
  if (report.hasDrift) return { ...base, state: 'problem', evidence, repair: configurationRepair(true), cause: msgid('Managed configuration files differ from the active generation. Review configuration generations to reapply or restore a reviewed generation.') }
  return { ...base, state: 'ok', evidence, repair: configurationRepair(false, 'no_problem'), cause: msgid('Managed configuration files match the active generation.') }
}

export const repairReportRevision = (family: RepairFamily, diagnostics: readonly RepairDiagnostic[]): string =>
  createHash('sha256').update(JSON.stringify({ family, diagnostics })).digest('hex')

export interface RepairDiagnosticsInput {
  family: RepairFamily
  run: RepairRun
  runTest?: RepairRunTest
  configTests?: readonly ConfigTest[]
  drift?: () => Promise<RepairDriftObservation>
  now?: () => Date
  cacheRecoveryAvailable?: boolean
  rpmRecoveryAvailable?: boolean
}

/** Read-only. Commands run one at a time; a missing or unparsable observation is never reported as ok. */
export async function runRepairDiagnostics(input: RepairDiagnosticsInput): Promise<RepairReport> {
  if (input.family !== 'debian' && input.family !== 'rhel') return fail('PRECONDITION_FAILED', 'repair diagnostics require a supported host profile', { stateChanged: false })
  const diagnostics: RepairDiagnostic[] = input.family === 'debian' ? [await diagnoseDpkg(input.run), await diagnoseApt(input.run)] : [await diagnoseRpmDb(input.run, input.rpmRecoveryAvailable === true), await diagnoseDnf(input.run), await diagnoseDnfCache(input.run, input.cacheRecoveryAvailable === true)]
  if (input.family === 'rhel' && diagnostics[0]?.state !== 'ok') {
    const cache = diagnostics.find(item => item.id === 'dnf-metadata-cache')
    if (cache?.repair.available) cache.repair = { ...cache.repair, available: false, reason: 'rpm_recovery_unavailable' }
  }
  const seen = new Set<string>()
  for (const test of (input.configTests ?? []).slice(0, MAX_CONFIG_TESTS)) {
    if (typeof test?.name !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(test.name) || seen.has(test.name) || !Array.isArray(test.argv) || !test.argv.length) continue
    seen.add(test.name)
    diagnostics.push(await diagnoseConfigTest(test, input.runTest))
  }
  diagnostics.push(await diagnoseDrift(input.drift))
  return { observedAt: (input.now?.() ?? new Date()).toISOString(), family: input.family, revision: repairReportRevision(input.family, diagnostics), diagnostics }
}

/** Re-runs only the diagnostic a repair targets. */
export async function runRepairDiagnostic(repairId: RepairJobId, run: RepairRun): Promise<RepairDiagnostic> {
  return repairId === 'dpkg-configure' ? diagnoseDpkg(run) : repairId === 'dnf-cache-refresh' ? diagnoseDnfCache(run, false) : repairId === 'rpmdb-rebuild' ? diagnoseRpmDb(run) : diagnoseApt(run)
}

const emptyPreview = (repairId: RepairJobId, source: RepairPreview['source'], reason: string, evidence: string): RepairPreview => ({
  repairId, source, state: 'unavailable', reason, install: [], remove: [], configure: [], counts: { install: 0, remove: 0, configure: 0 }, removalFingerprint: removalFingerprint([]), evidence,
})

/** Read-only preview: the apt simulation, or the dpkg audit list that configuration would process. */
export async function previewRepair(input: { repairId: RepairJobId; family: RepairFamily; run: RepairRun; cacheRecoveryAvailable?: boolean; rpmRecoveryAvailable?: boolean }): Promise<RepairPreview> {
  if (!isRepairJobId(input.repairId)) return fail('VALIDATION', 'unsupported repair', { stateChanged: false })
  if (input.repairId === 'rpmdb-rebuild') {
    const diagnostic = input.family === 'rhel' ? await diagnoseRpmDb(input.run, input.rpmRecoveryAvailable === true) : null
    const preview = emptyPreview(input.repairId, 'rpm-database', diagnostic?.repair.reason ?? 'repair_unavailable_for_family', diagnostic?.evidence ?? '')
    return diagnostic?.state === 'problem' && diagnostic.repair.available ? { ...preview, state: 'ready', reason: undefined } : preview
  }
  if (input.repairId === 'dnf-cache-refresh') {
    const diagnostic = input.family === 'rhel' ? await diagnoseDnfCache(input.run, input.cacheRecoveryAvailable === true) : null
    const preview = emptyPreview(input.repairId, 'dnf-cache-only', diagnostic?.repair.reason ?? 'repair_unavailable_for_family', diagnostic?.evidence ?? '')
    return diagnostic?.state === 'problem' && diagnostic.repair.available ? { ...preview, state: 'ready', reason: undefined } : preview
  }
  if (input.family !== 'debian') return emptyPreview(input.repairId, input.repairId === 'apt-fix-broken' ? 'apt-simulation' : 'dpkg-audit', 'repair_unavailable_for_family', '')
  if (input.repairId === 'dpkg-configure') {
    const result = await safeRun(input.run, DPKG_AUDIT_ARGV)
    const evidence = commandEvidence(DPKG_AUDIT_ARGV, result)
    const parsed = result ? parseDpkgAudit(result) : { state: 'unavailable' as const, reason: 'command-failed' }
    if (parsed.state !== 'problem') return emptyPreview('dpkg-configure', 'dpkg-audit', parsed.state === 'ok' ? 'no_problem' : UNAVAILABLE_REASON(parsed.reason), evidence)
    if (parsed.detail.reinstallOnly) return emptyPreview('dpkg-configure', 'dpkg-audit', 'reinstall_required', evidence)
    const configure = parsed.detail.configurable
    return { repairId: 'dpkg-configure', source: 'dpkg-audit', state: 'ready', install: [], remove: [], configure, counts: { install: 0, remove: 0, configure: configure.length }, removalFingerprint: removalFingerprint([]), evidence }
  }
  const result = await safeRun(input.run, APT_FIX_PREVIEW_ARGV)
  const evidence = commandEvidence(APT_FIX_PREVIEW_ARGV, result)
  const parsed = result ? parseAptSimulation(result) : { state: 'unavailable' as const, reason: 'command-failed' }
  if (parsed.state !== 'ready') return emptyPreview('apt-fix-broken', 'apt-simulation', parsed.reason === 'unresolvable' ? 'unresolvable' : UNAVAILABLE_REASON(parsed.reason), evidence)
  const { install, remove, configure } = parsed.plan
  return { repairId: 'apt-fix-broken', source: 'apt-simulation', state: 'ready', install, remove, configure, counts: { install: install.length, remove: remove.length, configure: configure.length }, removalFingerprint: removalFingerprint(remove), evidence }
}

const STEP_TITLES: Readonly<Record<RepairJobId, string>> = {
  'dpkg-configure': msgid('Complete interrupted package configuration'),
  'apt-fix-broken': msgid('Correct broken package dependencies'),
  'dnf-cache-refresh': msgid('Refresh repository metadata cache'),
  'rpmdb-rebuild': msgid('Rebuild the RPM database after a verified snapshot'),
}

/** Trusted native provider only. Acquire a durable exclusive cache/package lease, invoke currentRevision
 * under it, compare expectedRevision, snapshot cache+DNF metadata/config and installed-package identity,
 * verify a restorable preimage, and retain crash-recoverable recovery records until explicit release.
 * A process restart must retain/reconcile unfinished snapshots; it cannot claim callback recovery ran. */
export interface RhelCacheSnapshot {
  observedRevision: string
  snapshotRevision: string
  assertLeaseAndPackagesUnchanged(): Promise<void>
  restoreAndVerify(): Promise<boolean>
  release(): Promise<void>
}
export interface RhelCacheRecovery {
  begin(input: { expectedRevision: string; currentRevision(): Promise<string> }): Promise<RhelCacheSnapshot>
}

export interface RepairJobPlanInput {
  repairId: RepairJobId
  family: RepairFamily
  observedRevision: string
  /** Present only after the caller accepted this exact previewed removal list. */
  acceptedRemovals?: { fingerprint: string; packages: readonly string[] }
  cacheRecovery?: RhelCacheRecovery
  /** Snapshot provider for /var/lib/rpm with the same lease, preimage and identity contract as the cache recovery. */
  rpmRecovery?: RhelCacheRecovery
  currentRevision?: () => Promise<string>
  authorize?: () => Promise<void>
}

/** The job succeeds only when the re-run target diagnostic reports ok. */
export function buildRepairJobPlan(input: RepairJobPlanInput): HostJobPlan {
  if (input.repairId === 'dnf-cache-refresh') return buildRhelCacheJobPlan(input)
  if (input.repairId === 'rpmdb-rebuild') return buildRpmRebuildJobPlan(input)
  if (!isRepairJobId(input.repairId) || input.family !== 'debian') return fail('PRECONDITION_FAILED', 'no reviewed repair exists for this host profile', { stateChanged: false })
  if (typeof input.observedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(input.observedRevision)) return fail('VALIDATION', 'an observed diagnostics revision is required', { stateChanged: false })
  const accepted = input.acceptedRemovals
  if (accepted && (input.repairId !== 'apt-fix-broken' || !accepted.packages.length || accepted.packages.length > MAX_PACKAGES || removalFingerprint(accepted.packages) !== accepted.fingerprint))
    return fail('VALIDATION', 'accepted removals must match a previewed removal list', { stateChanged: false })
  const repairId = input.repairId
  const argv = repairId === 'dpkg-configure' ? DPKG_CONFIGURE_PENDING_ARGV : accepted ? APT_FIX_BROKEN_ARGV : APT_FIX_BROKEN_NO_REMOVE_ARGV
  const step: HostJobCommandStep = { id: repairId, title: STEP_TITLES[repairId], argv: [...argv], env: { ...REPAIR_MUTATION_ENV }, timeoutMs: 1_800_000, mutates: true }
  const diagnosticId = repairDiagnosticId(repairId)
  return {
    kind: 'system.repair.' + repairId,
    summary: 'Repair: ' + STEP_TITLES[repairId].toLowerCase(),
    accountId: null,
    fingerprint: { repairId, observedRevision: input.observedRevision, removalFingerprint: accepted?.fingerprint ?? removalFingerprint([]), removalsAccepted: !!accepted },
    detail: { diagnostic: diagnosticId, removals: accepted ? [...accepted.packages].sort().slice(0, 200) : [], removalCount: accepted?.packages.length ?? 0 },
    steps: [step],
    policy: isRepairCommand,
    verify: async (run): Promise<HostJobVerification> => {
      const diagnostic = await runRepairDiagnostic(repairId, argv => run(argv))
      return { ok: diagnostic.state === 'ok', detail: { diagnostic: diagnosticId, state: diagnostic.state, cause: sourceMessage(diagnostic.cause), evidence: boundedEvidence([diagnostic.evidence], 2048) } }
    },
  }
}

function buildRhelCacheJobPlan(input: RepairJobPlanInput): HostJobPlan {
  const recovery = input.cacheRecovery, currentRevision = input.currentRevision, authorize = input.authorize
  if (input.family !== 'rhel' || !recovery || !currentRevision || !authorize) return fail('PRECONDITION_FAILED', 'metadata repair requires a qualified snapshot, recovery and authorization provider', { stateChanged: false })
  if (!/^[a-f0-9]{64}$/.test(input.observedRevision) || input.acceptedRemovals) return fail('VALIDATION', 'metadata repair requires its current observation and cannot accept package removals', { stateChanged: false })
  let snapshot: RhelCacheSnapshot | null = null, verified = false
  return {
    kind: 'system.repair.dnf-cache-refresh', summary: 'Repair: refresh repository metadata cache only', accountId: null,
    fingerprint: { repairId: 'dnf-cache-refresh', observedRevision: input.observedRevision, scope: 'repository-metadata-only' },
    detail: { diagnostic: 'dnf-metadata-cache', installedPackagesChanged: false, recoveryRequired: true },
    steps: [
      { id: 'dnf-cache-clean', title: msgid('Clear repository metadata after verified snapshot'), argv: [...DNF_CACHE_CLEAN_ARGV], env: { LC_ALL: 'C' }, timeoutMs: 60_000, mutates: true },
      { id: 'dnf-cache-refresh', title: STEP_TITLES['dnf-cache-refresh'], argv: [...DNF_CACHE_REFRESH_ARGV], env: { LC_ALL: 'C' }, timeoutMs: 180_000, mutates: true },
    ],
    policy: argv => [DNF_CACHE_CLEAN_ARGV, DNF_CACHE_REFRESH_ARGV, DNF_CACHE_CHECK_ARGV, RPMDB_VERIFY_ARGV].some(expected => expected.length === argv.length && expected.every((value, index) => value === argv[index])),
    beforeStep: async () => {
      await authorize()
      if (!snapshot) {
        let observed = false
        snapshot = await recovery.begin({ expectedRevision: input.observedRevision, currentRevision: async () => {
          const revision = await currentRevision()
          if (revision !== input.observedRevision) return fail('CONFLICT', 'metadata diagnostics changed before the recovery snapshot', { stateChanged: false })
          observed = true; return revision
        } })
        if (!observed || snapshot.observedRevision !== input.observedRevision || !/^[a-f0-9]{64}$/.test(snapshot.snapshotRevision)) return fail('PRECONDITION_FAILED', 'the metadata recovery snapshot could not be verified', { stateChanged: false })
      }
      await snapshot.assertLeaseAndPackagesUnchanged()
      await authorize()
    },
    verify: async run => {
      if (!snapshot) return { ok: false, detail: { recoveryRequired: true } }
      await authorize(); await snapshot.assertLeaseAndPackagesUnchanged()
      const cache = await diagnoseDnfCache(argv => run(argv), true), rpm = await diagnoseRpmDb(argv => run(argv))
      verified = cache.state === 'ok' && rpm.state === 'ok'
      return { ok: verified, detail: { diagnostic: cache.id, state: cache.state, rpmIntegrity: rpm.state, installedPackagesChanged: false } }
    },
    finalize: async (_run, results) => {
      if (!snapshot) return { ok: true, detail: { cacheRecovery: 'not_started' } }
      // Do not retry a native mutation. Restore the retained preimage on failed, cancelled or partial jobs.
      const completed = results.length === 2 && results.every(item => item.result?.ok && item.result.code === 0 && !item.result.timedOut)
      try {
        if (verified && completed) { await snapshot.assertLeaseAndPackagesUnchanged(); await snapshot.release(); return { ok: true, detail: { cacheRecovery: 'not_required', installedPackagesChanged: false } } }
        const restored = await snapshot.restoreAndVerify()
        if (restored) await snapshot.release()
        return { ok: restored, detail: { cacheRecovery: restored ? 'restored' : 'recovery_required', verificationRequired: !restored } }
      } catch { return { ok: false, detail: { cacheRecovery: 'recovery_required', verificationRequired: true } } }
    },
  }
}

/** Same snapshot, lease and restore protocol as the cache repair; success additionally requires the identical installed NEVRA set. */
function buildRpmRebuildJobPlan(input: RepairJobPlanInput): HostJobPlan {
  const recovery = input.rpmRecovery, currentRevision = input.currentRevision, authorize = input.authorize
  if (input.family !== 'rhel' || !recovery || !currentRevision || !authorize) return fail('PRECONDITION_FAILED', 'an RPM database rebuild requires a qualified snapshot, recovery and authorization provider', { stateChanged: false })
  if (!/^[a-f0-9]{64}$/.test(input.observedRevision) || input.acceptedRemovals) return fail('VALIDATION', 'an RPM database rebuild requires its current observation and cannot accept package removals', { stateChanged: false })
  let snapshot: RhelCacheSnapshot | null = null, verified = false
  return {
    kind: 'system.repair.rpmdb-rebuild', summary: 'Repair: rebuild the RPM database after a verified snapshot', accountId: null,
    fingerprint: { repairId: 'rpmdb-rebuild', observedRevision: input.observedRevision, scope: 'rpm-database-only' },
    detail: { diagnostic: 'rpm-database-integrity', installedPackagesChanged: false, recoveryRequired: true },
    steps: [{ id: 'rpmdb-rebuild', title: STEP_TITLES['rpmdb-rebuild'], argv: [...RPMDB_REBUILD_ARGV], env: { LC_ALL: 'C' }, timeoutMs: 900_000, mutates: true }],
    policy: argv => [RPMDB_REBUILD_ARGV, RPMDB_VERIFY_ARGV, RPM_INSTALLED_IDENTITY_ARGV].some(expected => expected.length === argv.length && expected.every((value, index) => value === argv[index])),
    beforeStep: async () => {
      await authorize()
      if (!snapshot) {
        let observed = false
        snapshot = await recovery.begin({ expectedRevision: input.observedRevision, currentRevision: async () => {
          const revision = await currentRevision()
          if (revision !== input.observedRevision) return fail('CONFLICT', 'RPM diagnostics changed before the recovery snapshot', { stateChanged: false })
          observed = true; return revision
        } })
        if (!observed || snapshot.observedRevision !== input.observedRevision || !/^[a-f0-9]{64}$/.test(snapshot.snapshotRevision)) return fail('PRECONDITION_FAILED', 'the RPM database snapshot could not be verified', { stateChanged: false })
      }
      await snapshot.assertLeaseAndPackagesUnchanged()
      await authorize()
    },
    verify: async run => {
      if (!snapshot) return { ok: false, detail: { recoveryRequired: true } }
      await authorize()
      const rpm = await diagnoseRpmDb(argv => run(argv))
      let identical = false
      try { await snapshot.assertLeaseAndPackagesUnchanged(); identical = true } catch { identical = false }
      verified = rpm.state === 'ok' && identical
      return { ok: verified, detail: { diagnostic: rpm.id, state: rpm.state, installedPackagesChanged: !identical } }
    },
    finalize: async (_run, results) => {
      if (!snapshot) return { ok: true, detail: { rpmRecovery: 'not_started' } }
      // Never retry the rebuild; restore the retained database preimage unless the exact identity was verified.
      const completed = results.length === 1 && results.every(item => item.result?.ok && item.result.code === 0 && !item.result.timedOut)
      try {
        if (verified && completed) { await snapshot.release(); return { ok: true, detail: { rpmRecovery: 'not_required', installedPackagesChanged: false } } }
        const restored = await snapshot.restoreAndVerify()
        if (restored) await snapshot.release()
        return { ok: restored, detail: { rpmRecovery: restored ? 'restored' : 'recovery_required', verificationRequired: !restored } }
      } catch { return { ok: false, detail: { rpmRecovery: 'recovery_required', verificationRequired: true } } }
    },
  }
}
