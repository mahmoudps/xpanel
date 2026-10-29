import { createHash } from 'node:crypto'
import { fail, msgid } from '@xpanel/core'
import type { HostJobCommandStep, HostJobPlan, HostJobRun } from './host-job-contract.ts'
import {
  APT_SHOW_HOLDS_ARGV, APT_SIMULATE_UPGRADE_ARGV, APT_UPDATE_ARGV, APT_UPGRADE_ENV, DNF_CHECK_UPDATE_ARGV, DNF_MAKECACHE_ARGV, DNF_SECURITY_ARGV,
  isKernelPackageName, isPackageManagerCommand, isPackageName, isPackageSelection, packageKernelExcludedUpgradeArgv, packageSelectionSimulationArgv, packageUpgradeArgv,
} from '../../../packages/os/src/package-manager-command.ts'
import type { PackageManagerFamily } from '../../../packages/os/src/package-manager-command.ts'

export type SystemUpdateFamily = PackageManagerFamily
export interface SystemUpdateCommandResult { ok: boolean; code: number | null; stdout: string; stderr: string }
export type SystemUpdateRun = (argv: string[]) => Promise<SystemUpdateCommandResult>
export type SystemUpdateMode = 'security' | 'all' | 'selected'
export type SystemUpdateReason = 'unsupported-host' | 'package-manager-busy' | 'package-manager-unavailable' | 'invalid-package-manager-output'

export interface SystemUpdatePackage {
  /** apt: package[:arch]; dnf: name.arch, exactly as accepted by the reviewed upgrade grammar. */
  name: string
  /** apt: installed version, or null for a new dependency; dnf: null (installed versions are not read). */
  current: string | null
  candidate: string
  origin: string
  security: boolean
  kernel: boolean
  held: boolean
  /** A new dependency is installed only through an upgraded package; it cannot be selected on its own. */
  newInstall: boolean
}

export interface SystemUpdatePlan {
  state: 'read' | 'unavailable'
  source: 'apt' | 'dnf' | null
  observedAt: string
  revision: string | null
  /** Omitted for the legacy inclusive plan; true is hashed into its separate observed revision. */
  excludeKernel?: true
  packages: SystemUpdatePackage[]
  /** null: holds were not read (dnf versionlock is outside the reviewed grammar). */
  holds: string[] | null
  rebootRequired: boolean | 'not-read'
  counts: { total: number; security: number; kernel: number; held: number | null }
  reason?: SystemUpdateReason
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_LINES = 50_000
const MAX_PACKAGES = 5_000
export const REBOOT_REQUIRED_PATH = '/run/reboot-required' // /var/run is a symlink to /run on supported hosts.
const BUSY = /Could not get lock|Unable to acquire the dpkg frontend lock|Unable to lock (?:the )?(?:administration )?directory|is another process using it|Waiting for process with pid|Failed to obtain the transaction lock|another copy is running/i
const VERSION = /^[A-Za-z0-9.+~:^_-]{1,256}$/

const invalid = (): never => { throw new Error('invalid_package_manager_output') }
const lines = (stdout: string): string[] => {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(stdout)) invalid()
  const all = stdout.split('\n')
  if (all.length > MAX_LINES) invalid()
  return all
}

/**
 * apt-get(8) -s prints pkgSimulate lines: "Inst name [current] (candidate release[, release...] [arch])",
 * optionally followed by " [broken...]"; Conf/Remv/Purg lines and progress/summary text are not plan entries.
 */
const INST = /^Inst (\S+?)(?: \[([^\]\s]+)\])? \(([^\s()]+) (.{0,1024}?)\[([a-z0-9-]{1,32})\]\)(?: \[[^\]]{0,4096}\])?$/
export function parseAptSimulation(stdout: string, holds: ReadonlySet<string>): SystemUpdatePackage[] {
  const packages: SystemUpdatePackage[] = []
  const seen = new Set<string>()
  for (const line of lines(stdout)) {
    if (!line.startsWith('Inst ')) continue
    const match = INST.exec(line)
    if (!match) return invalid()
    const name = match[1]!, current = match[2], candidate = match[3]!, release = match[4]!
    if (!isPackageName('debian', name) || seen.has(name) || current !== undefined && !VERSION.test(current) || !VERSION.test(candidate)) return invalid()
    seen.add(name)
    const origin = release.trim()
    packages.push({
      name, current: current ?? null, candidate, origin,
      security: origin.split(', ').some(item => /-security$/.test(item)),
      kernel: isKernelPackageName('debian', name), held: holds.has(name) || holds.has(name.split(':')[0]!), newInstall: current === undefined,
    })
    if (packages.length > MAX_PACKAGES) return invalid()
  }
  return packages
}

/** apt-mark(8) showhold prints one held package name per line. */
export function parseAptHolds(stdout: string): string[] {
  const names = lines(stdout).map(line => line.trim()).filter(Boolean)
  if (names.length > MAX_PACKAGES || new Set(names).size !== names.length || names.some(name => !isPackageName('debian', name))) return invalid()
  return names.sort()
}

/**
 * dnf(8) check-update rows are "name.arch  [epoch:]version-release  repo"; a field wider than its column wraps the
 * following fields onto the next line, so rows are read as whitespace-separated triples until "Obsoleting Packages".
 */
export function parseDnfCheckUpdate(stdout: string, security: ReadonlySet<string>): SystemUpdatePackage[] {
  const body: string[] = []
  for (const line of lines(stdout)) {
    if (line.trim() === 'Obsoleting Packages') break
    if (!line.startsWith('Security: ')) body.push(line)
  }
  const tokens = body.join(' ').split(/\s+/).filter(Boolean)
  if (tokens.length % 3 !== 0 || tokens.length / 3 > MAX_PACKAGES) return invalid()
  const packages: SystemUpdatePackage[] = []
  const seen = new Set<string>()
  for (let index = 0; index < tokens.length; index += 3) {
    const [name, candidate, origin] = tokens.slice(index, index + 3) as [string, string, string]
    if (!isPackageName('rhel', name) || seen.has(name) || !/^(?:[0-9]{1,10}:)?[A-Za-z0-9._+~^]{1,128}-[A-Za-z0-9._+~^]{1,128}$/.test(candidate) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(origin)) return invalid()
    seen.add(name)
    packages.push({ name, current: null, candidate, origin, security: security.has(name), kernel: isKernelPackageName('rhel', name), held: false, newInstall: false })
  }
  return packages
}

/** dnf(8) updateinfo list rows are "advisory type/severity name-[epoch:]version-release.arch"; returns name.arch identities. */
export function parseDnfSecurity(stdout: string): Set<string> {
  const identities = new Set<string>()
  for (const line of lines(stdout)) {
    if (!line.trim()) continue
    const fields = line.trim().split(/\s+/)
    const nevra = fields.length === 3 && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(fields[0]!) && /^\S{1,64}$/.test(fields[1]!) ? /^(.+)-[^-]+-[^-]+\.(noarch|x86_64|aarch64|i686|ppc64le|s390x)$/.exec(fields[2]!) : null
    if (!nevra || !isPackageName('rhel', nevra[1] + '.' + nevra[2])) return invalid()
    identities.add(nevra[1] + '.' + nevra[2])
  }
  return identities
}

export const systemUpdateRevision = (source: 'apt' | 'dnf', packages: readonly SystemUpdatePackage[], holds: readonly string[] | null, excludeKernel = false): string =>
  createHash('sha256').update(JSON.stringify([source, [...packages].sort((left, right) => left.name < right.name ? -1 : 1).map(item => [item.name, item.current, item.candidate, item.origin, item.security, item.kernel, item.held, item.newInstall]), holds, ...(excludeKernel ? [{ excludeKernel: true }] : [])])).digest('hex')

const execute = async (run: SystemUpdateRun, argv: readonly string[]): Promise<SystemUpdateCommandResult> => {
  try { return await run([...argv]) } catch { return { ok: false, code: null, stdout: '', stderr: '' } }
}

/** Fixed read-only observation. Malformed or partial output is unavailable, never a partial plan. */
export async function readSystemUpdatePlan(input: { run: SystemUpdateRun; family: SystemUpdateFamily | null; readFile?: (path: string) => Promise<string | null>; now?: () => Date; excludeKernel?: boolean }): Promise<SystemUpdatePlan> {
  const observedAt = (input.now ?? (() => new Date()))().toISOString()
  const source = input.family === 'debian' ? 'apt' : input.family === 'rhel' ? 'dnf' : null
  const option = input.excludeKernel ? { excludeKernel: true as const } : {}
  const unavailable = (reason: SystemUpdateReason): SystemUpdatePlan => ({ state: 'unavailable', source, observedAt, revision: null, packages: [], holds: null, rebootRequired: 'not-read', counts: { total: 0, security: 0, kernel: 0, held: null }, reason, ...option })
  if (!source) return unavailable('unsupported-host')
  const failed = (result: SystemUpdateCommandResult): SystemUpdatePlan => unavailable(BUSY.test(result.stderr) || BUSY.test(result.stdout) ? 'package-manager-busy' : 'package-manager-unavailable')
  let packages: SystemUpdatePackage[], holds: string[] | null = null
  if (source === 'apt') {
    const held = await execute(input.run, APT_SHOW_HOLDS_ARGV)
    if (!held.ok) return failed(held)
    const simulation = await execute(input.run, APT_SIMULATE_UPGRADE_ARGV)
    if (!simulation.ok) return failed(simulation)
    try { holds = parseAptHolds(held.stdout); packages = parseAptSimulation(simulation.stdout, new Set(holds)) }
    catch { return unavailable('invalid-package-manager-output') }
  } else {
    const advisories = await execute(input.run, DNF_SECURITY_ARGV)
    if (!advisories.ok) return failed(advisories)
    const check = await execute(input.run, DNF_CHECK_UPDATE_ARGV)
    if (check.code !== 0 && check.code !== 100) return failed(check)
    try {
      packages = parseDnfCheckUpdate(check.stdout, parseDnfSecurity(advisories.stdout))
      if ((check.code === 100) !== (packages.length > 0)) return unavailable('invalid-package-manager-output')
    } catch { return unavailable('invalid-package-manager-output') }
  }
  let rebootRequired: boolean | 'not-read' = 'not-read'
  if (source === 'apt' && input.readFile) {
    try { rebootRequired = (await input.readFile(REBOOT_REQUIRED_PATH)) !== null } catch { rebootRequired = 'not-read' }
  }
  packages.sort((left, right) => left.name < right.name ? -1 : 1)
  return {
    state: 'read', source, observedAt, revision: systemUpdateRevision(source, packages, holds, input.excludeKernel), packages, holds, rebootRequired, ...option,
    counts: { total: packages.length, security: packages.filter(item => item.security).length, kernel: packages.filter(item => item.kernel).length, held: holds ? holds.length : null },
  }
}

export const isSelectablePackage = (entry: SystemUpdatePackage): boolean => !entry.held && !entry.newInstall

// dpkg lib/dpkg/version.c verrevcmp: '~' sorts before everything, letters before other symbols.
const digit = (value: string | undefined): boolean => value !== undefined && value >= '0' && value <= '9'
const debOrder = (value: string | undefined): number => value === undefined || digit(value) ? 0 : /[A-Za-z]/.test(value) ? value.charCodeAt(0) : value === '~' ? -1 : value.charCodeAt(0) + 256
const debPart = (a: string, b: string): number => {
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    let first = 0
    while (i < a.length && !digit(a[i]) || j < b.length && !digit(b[j])) {
      const difference = debOrder(a[i]) - debOrder(b[j])
      if (difference) return difference
      i++; j++
    }
    while (a[i] === '0') i++
    while (b[j] === '0') j++
    while (digit(a[i]) && digit(b[j])) { if (!first) first = a.charCodeAt(i) - b.charCodeAt(j); i++; j++ }
    if (digit(a[i])) return 1
    if (digit(b[j])) return -1
    if (first) return first
  }
  return 0
}
// rpmio/rpmvercmp.c: alternating numeric/alpha segments; '~' sorts before and '^' after the end of a version.
const rpmPart = (a: string, b: string): number => {
  if (a === b) return 0
  let i = 0, j = 0
  const separator = (value: string | undefined): boolean => value !== undefined && !/[A-Za-z0-9~^]/.test(value)
  while (i < a.length || j < b.length) {
    while (separator(a[i])) i++
    while (separator(b[j])) j++
    if (a[i] === '~' || b[j] === '~') { if (a[i] !== '~') return 1; if (b[j] !== '~') return -1; i++; j++; continue }
    if (a[i] === '^' || b[j] === '^') { if (i >= a.length) return -1; if (j >= b.length) return 1; if (a[i] !== '^') return 1; if (b[j] !== '^') return -1; i++; j++; continue }
    if (i >= a.length || j >= b.length) break
    const numeric = digit(a[i]), pattern = numeric ? /^[0-9]+/ : /^[A-Za-z]+/
    const left = pattern.exec(a.slice(i))![0], right = pattern.exec(b.slice(j))?.[0] ?? ''
    i += left.length; j += right.length
    if (!right) return numeric ? 1 : -1
    const x = numeric ? left.replace(/^0+/, '') : left, y = numeric ? right.replace(/^0+/, '') : right
    if (numeric && x.length !== y.length) return x.length > y.length ? 1 : -1
    if (x !== y) return x > y ? 1 : -1
  }
  return i >= a.length && j >= b.length ? 0 : i >= a.length ? -1 : 1
}
/** Compares [epoch:]version[-revision] with the family's own documented ordering. */
export function comparePackageVersions(family: SystemUpdateFamily, left: string, right: string): number {
  const split = (value: string): [number, string, string] => {
    const epoch = /^([0-9]+):/.exec(value), rest = epoch ? value.slice(epoch[0].length) : value, dash = rest.lastIndexOf('-')
    return [epoch ? Number(epoch[1]) : 0, dash < 0 ? rest : rest.slice(0, dash), dash < 0 ? '' : rest.slice(dash + 1)]
  }
  const [le, lv, lr] = split(left), [re, rv, rr] = split(right), part = family === 'debian' ? debPart : rpmPart
  return Math.sign(le - re || part(lv, rv) || part(lr, rr))
}

const UPGRADE_CHUNK = 200
const UPGRADE_TITLE = msgid('Upgrade selected packages')
const REFRESH_TITLE = msgid('Refresh package lists')
const refreshStep = (family: SystemUpdateFamily): HostJobCommandStep => ({ id: 'refresh-lists', title: REFRESH_TITLE, argv: [...(family === 'debian' ? APT_UPDATE_ARGV : DNF_MAKECACHE_ARGV)], timeoutMs: 600_000, mutates: true })
const verificationRun = (run: HostJobRun): SystemUpdateRun => argv => run(argv, { env: { LC_ALL: 'C' }, timeoutMs: 300_000 })

/** DNF4 --assumeno transaction table: admit only install/upgrade sections and matching summary totals; any other shape is unavailable. */
export function parseDnfSelectedTransaction(stdout: string): string[] {
  const all = lines(stdout), rows: string[] = [], counts = { install: 0, upgrade: 0 }, summary = { install: 0, upgrade: 0 }
  let section: 'install' | 'upgrade' | null = null, inSummary = false, foundSummary = false, pending: string[] = []
  const flush = (): void => {
    if (!pending.length) return
    if (!section) return invalid()
    while (pending.length) {
      const [name, arch, candidate, repo, size] = pending.splice(0, 5)
      if (!name || !arch || !candidate || !repo || !size || !isPackageName('rhel', name + '.' + arch) || !VERSION.test(candidate) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(repo) || !/^[0-9]+(?:\.[0-9]+)?$/.test(size)) return invalid()
      if (pending[0] && /^[kMGTPE]$/.test(pending[0])) pending.shift()
      const identity = name + '.' + arch
      if (rows.includes(identity) || rows.length >= MAX_PACKAGES) return invalid()
      rows.push(identity); counts[section]++
    }
  }
  for (const raw of all) {
    const line = raw.trim()
    if (/^(?:Removing|Downgrading|Reinstalling|Obsoleting|Replacing)(?:\s|:)/.test(line)) return invalid()
    if (/^(?:Installing(?: dependencies| weak dependencies)?|Upgrading):$/.test(line)) { flush(); section = line === 'Upgrading:' ? 'upgrade' : 'install'; continue }
    if (line === 'Transaction Summary') { flush(); section = null; inSummary = true; foundSummary = true; continue }
    if (!line || /^=+$/.test(line)) continue
    if (section) { pending.push(...line.split(/\s+/)); continue }
    if (inSummary) {
      const match = /^(Install|Upgrade)\s+([0-9]{1,4})\s+Packages?$/.exec(line)
      if (match) { const key = match[1] === 'Install' ? 'install' : 'upgrade'; if (summary[key]) return invalid(); summary[key] = Number(match[2]); continue }
      if (/^(?:Remove|Downgrade|Reinstall)/.test(line)) return invalid()
    }
  }
  flush()
  if (!foundSummary || !rows.length || counts.install !== summary.install || counts.upgrade !== summary.upgrade) return invalid()
  return rows
}

const excludedKernelNames = (family: SystemUpdateFamily, observed: SystemUpdatePlan): string[] => observed.packages.filter(entry => isKernelPackageName(family, entry.name)).map(entry => family === 'debian' ? entry.name + (entry.current === null ? '-' : '=' + entry.current) : entry.name).sort()
export async function assertKernelExcludedTransaction(input: { family: SystemUpdateFamily; run: SystemUpdateRun; names: readonly string[]; excluded: readonly string[] }): Promise<void> {
  let argv: string[]
  try { argv = packageSelectionSimulationArgv(input.family, input.names, input.excluded) } catch { return fail('PRECONDITION_FAILED', 'kernel exclusion exceeds the reviewed command bounds', { stateChanged: false }) }
  const result = await execute(input.run, argv)
  let simulated: string[]
  try {
    if (input.family === 'debian') {
      if (!result.ok || result.code !== 0 || /^(?:Remv|Purg) /m.test(result.stdout)) return invalid()
      simulated = parseAptSimulation(result.stdout, new Set()).map(entry => entry.name)
    } else {
      // DNF --assumeno returns 1 after a resolved transaction is declined. Error output never qualifies as a preview.
      if (result.code !== 1 || !/^Operation aborted\.?$/m.test(result.stdout + '\n' + result.stderr) || /(?:^|\n)(?:Error|Problem):/i.test(result.stdout + '\n' + result.stderr)) return invalid()
      simulated = parseDnfSelectedTransaction(result.stdout)
    }
  } catch { return fail('PRECONDITION_FAILED', 'the kernel-excluded transaction could not be verified', { stateChanged: false, verificationRequired: true }) }
  if (simulated.some(name => isKernelPackageName(input.family, name))) return fail('PRECONDITION_FAILED', 'a dependency would change an excluded kernel package', { stateChanged: false })
  if (input.names.some(name => !simulated.includes(name))) return fail('CONFLICT', 'the selected transaction changed; read the plan again', { stateChanged: false })
}

/** Reviewed upgrade job. Held packages and new dependencies are never selected; an empty selection is refused. */
export function buildSystemUpdateJobPlan(input: { family: SystemUpdateFamily; observed: SystemUpdatePlan; selection: { mode: SystemUpdateMode; packages?: readonly string[] }; refreshFirst?: boolean; revalidate?: { run: SystemUpdateRun; assertRoot(): Promise<unknown> } }): HostJobPlan {
  const { family, observed, selection } = input
  if (observed.state !== 'read' || !observed.revision || observed.source !== (family === 'debian' ? 'apt' : 'dnf')) return fail('PRECONDITION_FAILED', 'a read update plan for this host is required', { stateChanged: false })
  if (!['security', 'all', 'selected'].includes(selection.mode) || (selection.mode === 'selected') !== (selection.packages !== undefined)) return fail('VALIDATION', 'update selection mode is invalid', { stateChanged: false })
  let chosen: SystemUpdatePackage[]
  if (selection.mode === 'selected') {
    if (!isPackageSelection(family, selection.packages)) return fail('VALIDATION', 'update selection must list 1 to 500 unique reviewed package names', { stateChanged: false })
    const byName = new Map(observed.packages.map(entry => [entry.name, entry]))
    const found = selection.packages.map(name => byName.get(name))
    if (found.some(entry => !entry || !isSelectablePackage(entry) || observed.excludeKernel && isKernelPackageName(family, entry.name))) return fail('PRECONDITION_FAILED', 'selected packages must be pending, not held, not new dependencies and not excluded kernels', { stateChanged: false })
    chosen = found as SystemUpdatePackage[]
  } else chosen = observed.packages.filter(entry => isSelectablePackage(entry) && (!observed.excludeKernel || !isKernelPackageName(family, entry.name)) && (selection.mode === 'all' || entry.security))
  if (chosen.length === 0) return fail('PRECONDITION_FAILED', 'no selectable package upgrade is pending for this selection', { stateChanged: false })
  if (chosen.length > 500) return fail('LIMIT_EXCEEDED', 'an upgrade job is limited to 500 packages', { stateChanged: false })
  const names = chosen.map(entry => entry.name).sort()
  const excluded = observed.excludeKernel ? excludedKernelNames(family, observed) : []
  if (observed.excludeKernel && (!input.revalidate || input.refreshFirst)) return fail('PRECONDITION_FAILED', 'kernel exclusion requires immediate native transaction revalidation without a list refresh', { stateChanged: false })
  if (observed.excludeKernel) try { packageKernelExcludedUpgradeArgv(family, names.slice(0, UPGRADE_CHUNK), excluded) } catch { return fail('PRECONDITION_FAILED', 'the observed kernel protections exceed the reviewed command bounds', { stateChanged: false }) }
  // The runner bounds argv to 256 items and plan data to 16 KiB: chunk the argv and keep only a bounded name preview.
  const upgrades: HostJobCommandStep[] = []
  for (let index = 0; index < names.length; index += UPGRADE_CHUNK) upgrades.push({ id: index ? 'upgrade-packages-' + (index / UPGRADE_CHUNK + 1) : 'upgrade-packages', title: UPGRADE_TITLE, argv: observed.excludeKernel ? packageKernelExcludedUpgradeArgv(family, names.slice(index, index + UPGRADE_CHUNK), excluded) : packageUpgradeArgv(family, names.slice(index, index + UPGRADE_CHUNK)), timeoutMs: 1_800_000, mutates: true, ...(family === 'debian' ? { env: APT_UPGRADE_ENV } : {}) })
  const preview: string[] = []
  let previewBytes = 0
  for (const name of names) { if ((previewBytes += name.length + 3) > 8192) break; preview.push(name) }
  const counts = { packages: chosen.length, security: chosen.filter(entry => entry.security).length, kernel: chosen.filter(entry => entry.kernel).length }
  return {
    kind: 'system.packages.upgrade',
    summary: `Upgrade ${chosen.length} package${chosen.length === 1 ? '' : 's'} (${selection.mode}) with ${observed.source}`,
    accountId: null,
    fingerprint: { revision: observed.revision, selection: { mode: selection.mode, count: names.length, sha256: createHash('sha256').update(names.join('\n')).digest('hex'), ...(observed.excludeKernel ? { excludeKernel: true, excludedKernelSha256: createHash('sha256').update(excluded.join('\n')).digest('hex') } : {}) } },
    detail: { source: observed.source, mode: selection.mode, counts, packages: preview, packagesTruncated: preview.length < names.length, servicesRestarted: false, ...(observed.excludeKernel ? { excludeKernel: true, excludedKernelCount: excluded.length } : {}) },
    steps: input.refreshFirst ? [refreshStep(family), ...upgrades] : upgrades,
    policy: isPackageManagerCommand,
    ...(observed.excludeKernel ? { beforeStep: async (step: HostJobCommandStep) => {
      const provider = input.revalidate!
      await provider.assertRoot()
      const current = await readSystemUpdatePlan({ family, run: provider.run, excludeKernel: true })
      const selected = step.argv.slice(step.argv.indexOf('--') + 1).filter(name => isPackageName(family, name)), pending = new Map(current.packages.map(entry => [entry.name, entry]))
      if (current.state !== 'read' || selected.some(name => !names.includes(name)) || JSON.stringify(current.holds) !== JSON.stringify(observed.holds) || JSON.stringify(excludedKernelNames(family, current)) !== JSON.stringify(excluded) || chosen.filter(entry => selected.includes(entry.name)).some(entry => JSON.stringify(pending.get(entry.name)) !== JSON.stringify(entry))) return fail('CONFLICT', 'the kernel-excluded update plan changed before execution', { stateChanged: false })
      await assertKernelExcludedTransaction({ family, run: provider.run, names: selected, excluded })
      await provider.assertRoot()
    } } : {}),
    verify: async run => {
      const after = await readSystemUpdatePlan({ run: verificationRun(run), family, excludeKernel: observed.excludeKernel === true })
      if (after.state !== 'read') return { ok: false, detail: { reason: after.reason ?? 'package-manager-unavailable' } }
      const pending = new Map(after.packages.map(entry => [entry.name, entry]))
      const remaining = chosen.filter(entry => { const next = pending.get(entry.name); return !!next && comparePackageVersions(family, next.candidate, entry.candidate) <= 0 }).map(entry => entry.name)
      const kernelExclusionVerified = !observed.excludeKernel || JSON.stringify(excludedKernelNames(family, after)) === JSON.stringify(excluded)
      return { ok: remaining.length === 0 && kernelExclusionVerified, detail: { revision: after.revision, upgraded: chosen.length - remaining.length, remainingCount: remaining.length, remaining: remaining.slice(0, 50), pendingTotal: after.counts.total, ...(observed.excludeKernel ? { kernelExclusionVerified } : {}) } }
    },
  }
}

export function buildPackageListRefreshJobPlan(family: SystemUpdateFamily): HostJobPlan {
  if (family !== 'debian' && family !== 'rhel') return fail('PRECONDITION_FAILED', 'package list refresh requires a supported package manager', { stateChanged: false })
  return {
    kind: 'system.packages.refresh',
    summary: `Refresh package lists with ${family === 'debian' ? 'apt' : 'dnf'}`,
    accountId: null,
    fingerprint: { family },
    detail: { source: family === 'debian' ? 'apt' : 'dnf' },
    steps: [refreshStep(family)],
    policy: isPackageManagerCommand,
    verify: async run => {
      const after = await readSystemUpdatePlan({ run: verificationRun(run), family })
      return after.state === 'read' ? { ok: true, detail: { revision: after.revision, pendingTotal: after.counts.total } } : { ok: false, detail: { reason: after.reason ?? 'package-manager-unavailable' } }
    },
  }
}
