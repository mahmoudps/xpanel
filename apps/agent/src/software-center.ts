import { createHash } from 'node:crypto'
import { fail, msgid } from '@xpanel/core'
import { SUPPORTED_PHP_VERSIONS } from '@xpanel/os'
import { isSoftwareCenterCommand, softwareCenterArgv, SOFTWARE_CENTER_DPKG_LIST_ARGV, SOFTWARE_CENTER_MAX_NAMES } from '../../../packages/os/src/software-center-command.ts'
import type { SoftwareCenterFamily } from '../../../packages/os/src/software-center-command.ts'
import type { HostJobPlan, HostJobRun, HostJobVerification } from './host-job-contract.ts'
import { componentPackages, isProtectedPackage, phpModuleComponents, phpRuntimeMarkers, protectedPackageNames, SOFTWARE_CENTER_CATALOG, softwareCenterComponents } from './software-center-catalog.ts'
import type { SoftwareComponent } from './software-center-catalog.ts'

export type { SoftwareCenterFamily } from '../../../packages/os/src/software-center-command.ts'
export type SoftwareCenterRun = (argv: readonly string[]) => Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }>
export type SoftwareCenterAction = 'install' | 'remove'
export type ComponentState = 'installed' | 'partial' | 'absent' | 'unavailable'
export interface PackageObservation { installed: boolean; consistent: boolean; versions: string[] }
export interface ComponentObservation {
  id: string; page: SoftwareComponent['page']; category: string; name: string; description: string
  phpVersion: string | null; packages: string[]; state: ComponentState; needsReview: boolean
  installed: { name: string; versions: string[] }[]
  /** apt-cache(8) policy candidates; null when not read (RHEL, or the read failed) */
  candidates: { name: string; version: string | null }[] | null
  services: string[]; requires: string[]; conflicts: string[]; requiredBy: string[]
  estimate: { memoryMb: number; diskMb: number }
}
export interface SoftwareCenterObservation {
  state: 'read' | 'unavailable'
  reason: 'unsupported-host' | 'package-database-unavailable' | 'invalid-package-database' | null
  family: SoftwareCenterFamily | null
  observedAt: string
  revision: string | null
  phpVersions: string[]
  candidates: 'read' | 'unavailable' | 'not-read'
  components: ComponentObservation[]
  /** Internal: package database observation used for revision and job verification; never serialized. */
  packages: ReadonlyMap<string, PackageObservation>
}
export interface PackageChange { name: string; from: string | null; to: string | null }
export type PreviewRefusal = 'nothing-to-do' | 'unknown-component' | 'unavailable-on-this-os' | 'protected-package' | 'required-by-installed' | 'conflict' | 'too-many-packages'
  | 'package-not-found' | 'dependency-problem' | 'simulation-unavailable' | 'invalid-simulation'
export interface SoftwareCenterPreview {
  state: 'ready' | 'refused' | 'unavailable'
  reason: PreviewRefusal | null
  blockers: string[]
  action: SoftwareCenterAction
  family: SoftwareCenterFamily
  revision: string
  componentIds: string[]
  resolvedComponentIds: string[]
  pulledComponentIds: string[]
  requestedPackages: string[]
  packages: { install: PackageChange[]; upgrade: PackageChange[]; remove: PackageChange[]; configure: string[] }
  extraRemovals: string[]
  extraRemovalsFingerprint: string | null
  protectedUpgrades: string[]
  estimate: { memoryMb: number; diskMb: number }
  observed: { downloadBytes: number | null; sizeDeltaBytes: number | null }
  fingerprint: string
}

const MAX_OUTPUT = 2 * 1024 * 1024
const MAX_LINES = 20000
export const MAX_SELECTED_COMPONENTS = 16
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const debianPackage = /^[a-z0-9][a-z0-9+.-]{0,127}$/
const rpmPackage = /^[A-Za-z0-9][A-Za-z0-9+._-]{0,127}$/
const versionText = /^[A-Za-z0-9.+~:_-]{1,256}$/
const lines = (stdout: string): string[] => {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT || /[\u0000\r]/.test(stdout)) throw new Error('invalid_package_output')
  const result = stdout.split('\n').filter(line => line.length > 0)
  if (result.length > MAX_LINES) throw new Error('invalid_package_output')
  return result
}
const chunks = <T>(items: readonly T[]): T[][] => Array.from({ length: Math.ceil(items.length / SOFTWARE_CENTER_MAX_NAMES) }, (_, index) => items.slice(index * SOFTWARE_CENTER_MAX_NAMES, (index + 1) * SOFTWARE_CENTER_MAX_NAMES))
async function invoke(run: SoftwareCenterRun, argv: readonly string[]): ReturnType<SoftwareCenterRun> {
  try { return await run(argv) } catch { return { ok: false, code: null, stdout: '', stderr: '' } }
}

// dpkg-query(1) --showformat ${Status} is "want eflag status"; dpkg(1) PACKAGE STATES lists the values.
const dpkgStates = new Set(['not-installed', 'config-files', 'half-installed', 'unpacked', 'half-configured', 'triggers-awaited', 'triggers-pending', 'installed'])
export function parseDpkgPackages(stdout: string): Map<string, PackageObservation> {
  const packages = new Map<string, PackageObservation>()
  for (const line of lines(stdout)) {
    const parts = line.split('\t')
    if (parts.length !== 3) throw new Error('invalid_dpkg_line')
    const [name, version, status] = parts as [string, string, string]
    const words = status.split(' ')
    if (!debianPackage.test(name) || version !== '' && !versionText.test(version) || words.length !== 3 || !['unknown', 'install', 'hold', 'deinstall', 'purge'].includes(words[0]!) || !['ok', 'reinstreq'].includes(words[1]!) || !dpkgStates.has(words[2]!)) throw new Error('invalid_dpkg_line')
    if (words[2] === 'not-installed' || words[2] === 'config-files') continue
    const installed = words[1] === 'ok' && ['installed', 'triggers-awaited', 'triggers-pending'].includes(words[2]!)
    const current = packages.get(name) ?? { installed: true, consistent: true, versions: [] }
    // Multi-Arch: same packages appear once per architecture; every instance must be healthy.
    packages.set(name, { installed: current.installed && installed, consistent: current.consistent && installed, versions: [...new Set([...current.versions, version].filter(Boolean))].sort() })
  }
  return packages
}

/** rpm(8) -q prints one --qf line per installed match and "package NAME is not installed" otherwise. */
export function parseRpmPackages(stdout: string, requested: readonly string[]): Map<string, PackageObservation> {
  const wanted = new Set(requested), seen = new Set<string>(), packages = new Map<string, PackageObservation>()
  for (const line of lines(stdout)) {
    const missing = /^package (\S+) is not installed$/.exec(line)
    if (missing) {
      if (!wanted.has(missing[1]!) || packages.has(missing[1]!)) throw new Error('invalid_rpm_line')
      seen.add(missing[1]!); continue
    }
    const parts = line.split('\t')
    if (parts.length !== 2 || !rpmPackage.test(parts[0]!) || !versionText.test(parts[1]!) || !wanted.has(parts[0]!) || seen.has(parts[0]!) && !packages.has(parts[0]!)) throw new Error('invalid_rpm_line')
    seen.add(parts[0]!)
    const current = packages.get(parts[0]!)
    packages.set(parts[0]!, { installed: true, consistent: true, versions: [...new Set([...(current?.versions ?? []), parts[1]!])].sort() })
  }
  if (seen.size !== wanted.size) throw new Error('incomplete_rpm_observation')
  return packages
}

/** apt-cache(8) policy blocks: "<name>:", "  Installed: <v|(none)>", "  Candidate: <v|(none)>". */
export function parseAptPolicy(stdout: string): Map<string, string | null> {
  const candidates = new Map<string, string | null>()
  let current: string | null = null
  for (const line of lines(stdout)) {
    const header = /^([a-z0-9][a-z0-9+.-]{0,127})(?::[a-z0-9-]+)?:$/.exec(line)
    if (header) { current = header[1]!; continue }
    const candidate = /^ {2}Candidate: (\S+)$/.exec(line)
    if (candidate) {
      if (current === null || candidate[1] !== '(none)' && !versionText.test(candidate[1]!)) throw new Error('invalid_apt_policy')
      if (!candidates.has(current) || candidates.get(current) === null) candidates.set(current, candidate[1] === '(none)' ? null : candidate[1]!)
    }
  }
  return candidates
}

const watchedNames = (family: SoftwareCenterFamily): string[] => {
  const names = new Set<string>(protectedPackageNames(family))
  for (const item of [...SOFTWARE_CENTER_CATALOG, ...phpModuleComponents(SUPPORTED_PHP_VERSIONS)]) for (const name of componentPackages(item, family) ?? []) names.add(name)
  for (const marker of phpRuntimeMarkers(family)) for (const name of marker.packages) names.add(name)
  return [...names].sort()
}

async function readPackages(family: SoftwareCenterFamily, run: SoftwareCenterRun, names: readonly string[]): Promise<Map<string, PackageObservation> | 'unavailable' | 'invalid'> {
  if (family === 'debian') {
    const result = await invoke(run, SOFTWARE_CENTER_DPKG_LIST_ARGV)
    if (!result.ok) return 'unavailable'
    try { return parseDpkgPackages(result.stdout) } catch { return 'invalid' }
  }
  const packages = new Map<string, PackageObservation>()
  for (const group of chunks(names)) {
    const result = await invoke(run, softwareCenterArgv('rpm-query', group))
    // rpm exits non-zero when any queried name is not installed; only a complete parse is accepted.
    if (result.code === null) return 'unavailable'
    try { for (const [name, value] of parseRpmPackages(result.stdout, group)) packages.set(name, value) } catch { return result.ok ? 'invalid' : 'unavailable' }
  }
  return packages
}

const stateOf = (item: SoftwareComponent, family: SoftwareCenterFamily, packages: ReadonlyMap<string, PackageObservation>): { state: ComponentState; needsReview: boolean } => {
  const names = componentPackages(item, family)
  if (!names || names.length === 0) return { state: 'unavailable', needsReview: false }
  const observed = names.map(name => packages.get(name))
  const needsReview = observed.some(value => value !== undefined && !value.consistent)
  const installed = observed.filter(value => value?.installed).length
  return { state: needsReview ? 'partial' : installed === names.length ? 'installed' : installed === 0 ? 'absent' : 'partial', needsReview }
}

/** Observed package database state only. Desired configuration is never an input. */
export async function readSoftwareCenter(input: { family: SoftwareCenterFamily | null; run: SoftwareCenterRun | null; now?: () => Date }): Promise<SoftwareCenterObservation> {
  const observedAt = (input.now ?? (() => new Date()))().toISOString()
  const unavailable = (reason: NonNullable<SoftwareCenterObservation['reason']>, family: SoftwareCenterFamily | null): SoftwareCenterObservation => ({ state: 'unavailable', reason, family, observedAt, revision: null, phpVersions: [], candidates: 'not-read', components: [], packages: new Map() })
  const family = input.family === 'debian' || input.family === 'rhel' ? input.family : null
  if (!family || typeof input.run !== 'function') return unavailable('unsupported-host', family)
  const watched = watchedNames(family)
  const all = await readPackages(family, input.run, watched)
  if (all === 'unavailable') return unavailable('package-database-unavailable', family)
  if (all === 'invalid') return unavailable('invalid-package-database', family)
  const phpVersions = phpRuntimeMarkers(family).filter(marker => marker.packages.some(name => all.get(name)?.installed)).map(marker => marker.version)
  const items = softwareCenterComponents(phpVersions)
  let candidates: SoftwareCenterObservation['candidates'] = 'not-read'
  let policy = new Map<string, string | null>()
  if (family === 'debian') {
    candidates = 'read'
    const names = [...new Set(items.flatMap(item => [...item.packages.debian]))].sort()
    for (const group of chunks(names)) {
      const result = await invoke(input.run, softwareCenterArgv('apt-cache-policy', group))
      try { if (!result.ok) throw new Error('policy_unavailable'); for (const [name, value] of parseAptPolicy(result.stdout)) policy.set(name, value) } catch { candidates = 'unavailable'; policy = new Map(); break }
    }
  }
  const revisionSource = watched.flatMap(name => { const value = all.get(name); return value ? [[name, value.installed, value.consistent, value.versions]] : [] })
  const states = new Map(items.map(item => [item.id, stateOf(item, family, all)]))
  const components = items.map((item): ComponentObservation => {
    const packages = [...(componentPackages(item, family) ?? [])]
    const current = states.get(item.id)!
    return {
      id: item.id, page: item.page, category: item.category, name: item.name, description: item.description, phpVersion: item.phpVersion ?? null, packages,
      state: current.state, needsReview: current.needsReview,
      installed: packages.flatMap(name => { const value = all.get(name); return value?.installed ? [{ name, versions: value.versions }] : [] }),
      candidates: candidates === 'read' ? packages.map(name => ({ name, version: policy.get(name) ?? null })) : null,
      services: [...(item.services ?? [])], requires: [...(item.requires ?? [])], conflicts: [...(item.conflicts ?? [])],
      requiredBy: items.filter(other => other.requires?.includes(item.id) && ['installed', 'partial'].includes(states.get(other.id)!.state)).map(other => other.id),
      estimate: { ...item.estimate },
    }
  })
  return { state: 'read', reason: null, family, observedAt, revision: sha256(JSON.stringify({ family, phpVersions, packages: revisionSource })), phpVersions, candidates, components, packages: all }
}

export interface SimulationPlan { install: PackageChange[]; upgrade: PackageChange[]; remove: PackageChange[]; configure: string[]; downgrade: string[]; downloadBytes: number | null; sizeDeltaBytes: number | null }
const units: Record<string, number> = { B: 1, kB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, '': 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }
const bytes = (amount: string, unit: string): number | null => { const value = Number(amount.replaceAll(',', '')); return Number.isFinite(value) && unit in units ? Math.round(value * units[unit]!) : null }
const bareName = (name: string): string => name.replace(/:[a-z0-9-]+$/, '')

/** apt-get(8) -s prints pkgSimulate lines: Inst <pkg> [<old>] (<new> <release> [<arch>]), Conf, Remv. */
export function parseAptSimulation(stdout: string): SimulationPlan {
  const plan: SimulationPlan = { install: [], upgrade: [], remove: [], configure: [], downgrade: [], downloadBytes: null, sizeDeltaBytes: null }
  const name = (value: string): string => { if (!/^[a-z0-9][a-z0-9+.-]{0,127}(?::[a-z0-9-]+)?$/.test(value)) throw new Error('invalid_apt_simulation'); return bareName(value) }
  for (const line of lines(stdout)) {
    if (/^(?:Inst|Conf|Remv|Purg) /.test(line)) {
      const inst = /^Inst (\S+)(?: \[([^\]\s]+)\])? \(([^\s)]+) [^)]*\)(?: \[[^\]]*\])?$/.exec(line)
      const conf = /^Conf (\S+) \(([^\s)]+) [^)]*\)(?: \[[^\]]*\])?$/.exec(line)
      const remv = /^Remv (\S+)(?: \[([^\]\s]+)\])?(?: \[[^\]]*\])?$/.exec(line)
      if (inst) { if (!versionText.test(inst[3]!) || inst[2] && !versionText.test(inst[2])) throw new Error('invalid_apt_simulation'); (inst[2] ? plan.upgrade : plan.install).push({ name: name(inst[1]!), from: inst[2] ?? null, to: inst[3]! }) }
      else if (conf) plan.configure.push(name(conf[1]!))
      else if (remv) plan.remove.push({ name: name(remv[1]!), from: remv[2] ?? null, to: null })
      else throw new Error('invalid_apt_simulation')
      continue
    }
    const download = /^Need to get ([0-9.,]+) ([kMG]?B)(?:\/[0-9.,]+ [kMG]?B)? of archives\.$/.exec(line)
    if (download) plan.downloadBytes = bytes(download[1]!, download[2]!)
    const used = /^After this operation, ([0-9.,]+) ([kMG]?B) of additional disk space will be used\.$/.exec(line)
    if (used) plan.sizeDeltaBytes = bytes(used[1]!, used[2]!)
    const freed = /^After this operation, ([0-9.,]+) ([kMG]?B) disk space will be freed\.$/.exec(line)
    if (freed) { const value = bytes(freed[1]!, freed[2]!); plan.sizeDeltaBytes = value === null ? null : -value }
  }
  return plan
}

const dnfSections: Record<string, 'install' | 'upgrade' | 'remove' | 'downgrade'> = {
  'Installing': 'install', 'Installing dependencies': 'install', 'Installing weak dependencies': 'install',
  'Upgrading': 'upgrade', 'Reinstalling': 'upgrade', 'Removing': 'remove', 'Removing dependent packages': 'remove',
  'Removing unused dependencies': 'remove', 'Downgrading': 'downgrade',
}
/** dnf(8) --assumeno prints the resolved transaction table, then aborts; the table is the evidence. */
export function parseDnfSimulation(stdout: string): SimulationPlan {
  const plan: SimulationPlan = { install: [], upgrade: [], remove: [], configure: [], downgrade: [], downloadBytes: null, sizeDeltaBytes: null }
  const all = lines(stdout)
  const header = all.findIndex(line => /^ ?Package\s+Arch(?:itecture)?\s+Version\s+Repo(?:sitory)?\s+Size\s*$/.test(line))
  const summary = all.findIndex(line => line === 'Transaction Summary')
  if (header < 0 || summary < header) throw new Error('invalid_dnf_simulation')
  let section: SimulationPlan['install'] | string[] | null = null, kind: string | null = null, pending: string | null = null
  for (const line of all.slice(header + 1, summary)) {
    if (/^=+$/.test(line)) continue
    const title = /^([A-Z][A-Za-z /]+):$/.exec(line)
    if (title) {
      kind = dnfSections[title[1]!] ?? null
      if (!kind) throw new Error('unsupported_dnf_section')
      section = kind === 'downgrade' ? plan.downgrade : plan[kind as 'install' | 'upgrade' | 'remove']; pending = null; continue
    }
    if (!section) throw new Error('invalid_dnf_simulation')
    const replacing = /^\s+replacing\s+(\S+)\.([A-Za-z0-9_]+)\s+(\S+)\s*$/.exec(line)
    if (replacing) { if (!rpmPackage.test(replacing[1]!)) throw new Error('invalid_dnf_simulation'); plan.remove.push({ name: replacing[1]!, from: replacing[3]!, to: null }); continue }
    const tokens = line.trim().split(/\s+/)
    if (tokens.length === 1 && pending === null) { pending = tokens[0]!; continue }
    const row = pending === null ? tokens : [pending, ...tokens]
    pending = null
    if (row.length < 5 || row.length > 6 || !rpmPackage.test(row[0]!) || !/^[A-Za-z0-9_]+$/.test(row[1]!) || !versionText.test(row[2]!)) throw new Error('invalid_dnf_simulation')
    if (kind === 'downgrade') (section as string[]).push(row[0]!)
    else (section as PackageChange[]).push({ name: row[0]!, from: kind === 'remove' ? row[2]! : null, to: kind === 'remove' ? null : row[2]! })
  }
  if (pending !== null) throw new Error('invalid_dnf_simulation')
  for (const line of all.slice(summary)) {
    const download = /^Total download size: ([0-9.]+)(?: ([kMGT]))?$/.exec(line)
    if (download) plan.downloadBytes = bytes(download[1]!, download[2] ?? '')
    const installed = /^Installed size: ([0-9.]+)(?: ([kMGT]))?$/.exec(line)
    if (installed) plan.sizeDeltaBytes = bytes(installed[1]!, installed[2] ?? '')
    const freed = /^Freed space: ([0-9.]+)(?: ([kMGT]))?$/.exec(line)
    if (freed) { const value = bytes(freed[1]!, freed[2] ?? ''); plan.sizeDeltaBytes = value === null ? null : -value }
  }
  return plan
}

type Outcome = { plan: SimulationPlan } | { refusal: PreviewRefusal }
async function simulate(family: SoftwareCenterFamily, action: SoftwareCenterAction, run: SoftwareCenterRun, names: readonly string[]): Promise<Outcome> {
  const kind = family === 'debian' ? (action === 'install' ? 'apt-simulate-install' : 'apt-simulate-remove') : (action === 'install' ? 'dnf-simulate-install' : 'dnf-simulate-remove')
  const result = await invoke(run, softwareCenterArgv(kind, names))
  if (result.code === null) return { refusal: 'simulation-unavailable' }
  const text = result.stdout + '\n' + result.stderr
  if (family === 'debian') {
    if (!result.ok) return { refusal: /Unable to locate package|has no installation candidate|is not available, but is referred to/.test(text) ? 'package-not-found' : /unmet dependencies|Unable to correct problems|held broken packages/.test(text) ? 'dependency-problem' : 'simulation-unavailable' }
    try { return { plan: parseAptSimulation(result.stdout) } } catch { return { refusal: 'invalid-simulation' } }
  }
  if (/No match for argument|Unable to find a match|No packages marked for removal/.test(text)) return { refusal: 'package-not-found' }
  if (/^\s*Problem( \d+)?:|conflicting requests|nothing provides|Transaction test error|Skipping packages with/m.test(text)) return { refusal: 'dependency-problem' }
  if (/^Nothing to do\.$/m.test(result.stdout)) return { plan: { install: [], upgrade: [], remove: [], configure: [], downgrade: [], downloadBytes: null, sizeDeltaBytes: null } }
  // --assumeno answers the confirmation with "no": the documented outcome is "Operation aborted." with a non-zero exit.
  if (!/Operation aborted\./.test(text)) return { refusal: result.ok ? 'invalid-simulation' : 'simulation-unavailable' }
  try { return { plan: parseDnfSimulation(result.stdout) } } catch { return { refusal: 'invalid-simulation' } }
}

const extraFingerprint = (names: readonly string[]): string | null => names.length ? sha256('software-center-extra-removals\n' + [...names].sort().join('\n')) : null
const isComponentId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{1,48}$/.test(value)
export const isComponentSelection = (value: unknown): value is string[] => Array.isArray(value) && value.length >= 1 && value.length <= MAX_SELECTED_COMPONENTS && value.every(isComponentId) && new Set(value).size === value.length

/** Simulates the exact change; refusals are truthful outcomes, never synthetic success. */
export async function previewComponentChange(input: { action: SoftwareCenterAction; componentIds: readonly string[]; family: SoftwareCenterFamily; run: SoftwareCenterRun; observed: SoftwareCenterObservation }): Promise<SoftwareCenterPreview> {
  const { action, family, observed } = input
  if (action !== 'install' && action !== 'remove') return fail('VALIDATION', 'action must be install or remove', { stateChanged: false })
  if (!isComponentSelection(input.componentIds)) return fail('VALIDATION', 'between 1 and 16 distinct catalog component ids are required', { stateChanged: false })
  if (observed.state !== 'read' || observed.family !== family || !observed.revision) return fail('PRECONDITION_FAILED', 'software center observation is unavailable', { stateChanged: false })
  const componentIds = [...input.componentIds].sort()
  const byId = new Map(observed.components.map(item => [item.id, item]))
  const base = (): SoftwareCenterPreview => ({ state: 'refused', reason: null, blockers: [], action, family, revision: observed.revision!, componentIds, resolvedComponentIds: [], pulledComponentIds: [], requestedPackages: [],
    packages: { install: [], upgrade: [], remove: [], configure: [] }, extraRemovals: [], extraRemovalsFingerprint: null, protectedUpgrades: [], estimate: { memoryMb: 0, diskMb: 0 }, observed: { downloadBytes: null, sizeDeltaBytes: null }, fingerprint: '' })
  const finish = (preview: SoftwareCenterPreview): SoftwareCenterPreview => ({ ...preview, fingerprint: sha256(JSON.stringify({ ...preview, fingerprint: '' })) })
  const refuse = (reason: PreviewRefusal, blockers: readonly string[], extra: Partial<SoftwareCenterPreview> = {}): SoftwareCenterPreview => finish({ ...base(), ...extra, state: ['simulation-unavailable', 'invalid-simulation'].includes(reason) ? 'unavailable' : 'refused', reason, blockers: [...blockers].sort() })
  const unknown = componentIds.filter(id => !byId.has(id))
  if (unknown.length) return refuse('unknown-component', unknown)
  const unavailable = componentIds.filter(id => byId.get(id)!.state === 'unavailable')
  if (unavailable.length) return refuse('unavailable-on-this-os', unavailable)
  const present = (item: ComponentObservation): boolean => item.state === 'installed' || item.state === 'partial'
  let resolved: string[], pulled: string[] = []
  if (action === 'install') {
    const closure = new Set<string>(componentIds), queue = [...componentIds]
    while (queue.length) {
      for (const required of byId.get(queue.shift()!)?.requires ?? []) {
        const target = byId.get(required)
        if (!target || target.state === 'unavailable') return refuse('unavailable-on-this-os', [required])
        if (!closure.has(required) && target.state !== 'installed') { closure.add(required); queue.push(required); pulled.push(required) }
      }
    }
    resolved = [...closure].filter(id => byId.get(id)!.state !== 'installed').sort()
    pulled = pulled.sort()
    const conflicts = resolved.flatMap(id => byId.get(id)!.conflicts.filter(other => closure.has(other) || byId.get(other) && present(byId.get(other)!)).map(other => id + ':' + other))
    if (conflicts.length) return refuse('conflict', conflicts, { resolvedComponentIds: resolved, pulledComponentIds: pulled })
  } else {
    resolved = componentIds.filter(id => present(byId.get(id)!))
    const selected = new Set(componentIds)
    const dependents = resolved.flatMap(id => byId.get(id)!.requiredBy.filter(other => !selected.has(other)).map(other => other + ':' + id))
    if (dependents.length) return refuse('required-by-installed', dependents, { resolvedComponentIds: resolved })
  }
  const requested = [...new Set(resolved.flatMap(id => {
    const item = byId.get(id)!
    return action === 'install' ? item.packages.filter(name => !observed.packages.get(name)?.installed) : item.installed.map(entry => entry.name)
  }))].sort()
  const estimate = resolved.reduce((total, id) => ({ memoryMb: total.memoryMb + byId.get(id)!.estimate.memoryMb, diskMb: total.diskMb + byId.get(id)!.estimate.diskMb }), { memoryMb: 0, diskMb: 0 })
  const context = { resolvedComponentIds: resolved, pulledComponentIds: pulled, requestedPackages: requested, estimate }
  if (!requested.length) return refuse('nothing-to-do', [], context)
  if (requested.length > SOFTWARE_CENTER_MAX_NAMES) return refuse('too-many-packages', [], context)
  const guarded = requested.filter(name => isProtectedPackage(family, name))
  if (guarded.length) return refuse('protected-package', guarded, context)
  const outcome = await simulate(family, action, input.run, requested)
  if ('refusal' in outcome) return refuse(outcome.refusal, [], context)
  const plan = outcome.plan
  const packages = { install: plan.install, upgrade: plan.upgrade, remove: plan.remove, configure: [...new Set(plan.configure)].sort() }
  if (plan.downgrade.length) return refuse('dependency-problem', plan.downgrade, { ...context, packages })
  const removing = new Set(plan.remove.map(change => change.name)), changing = new Set([...plan.install, ...plan.upgrade].map(change => change.name))
  const protectedRemovals = [...removing].filter(name => isProtectedPackage(family, name))
  if (protectedRemovals.length) return refuse('protected-package', protectedRemovals, { ...context, packages })
  const missing = requested.filter(name => action === 'install' ? !changing.has(name) : !removing.has(name))
  if (missing.length) return refuse('invalid-simulation', missing, { ...context, packages })
  const extraRemovals = [...removing].filter(name => action === 'install' || !requested.includes(name)).sort()
  return finish({ ...base(), ...context, state: 'ready', packages, extraRemovals, extraRemovalsFingerprint: extraFingerprint(extraRemovals),
    protectedUpgrades: plan.upgrade.map(change => change.name).filter(name => isProtectedPackage(family, name)).sort(), observed: { downloadBytes: plan.downloadBytes, sizeDeltaBytes: plan.sizeDeltaBytes } })
}

/** Exact package names this agent admits for a family and the observed installed PHP versions. */
export const admittedPackageNames = (family: SoftwareCenterFamily, phpVersions: readonly string[]): ReadonlySet<string> =>
  new Set(softwareCenterComponents(phpVersions).flatMap(item => [...(componentPackages(item, family) ?? [])]))

/** Builds a reviewed host job; success is decided only by the post-job package re-read. */
export function buildComponentJobPlan(input: { action: SoftwareCenterAction; componentIds: readonly string[]; family: SoftwareCenterFamily; observedRevision: string; preview: SoftwareCenterPreview; observed: SoftwareCenterObservation; acceptExtraRemovals?: string | undefined }): HostJobPlan {
  const { action, family, preview, observed } = input
  const ids = isComponentSelection(input.componentIds) ? [...input.componentIds].sort() : fail('VALIDATION', 'invalid component selection', { stateChanged: false })
  if (preview.state !== 'ready' || preview.action !== action || preview.family !== family || observed.family !== family || preview.revision !== input.observedRevision || observed.revision !== input.observedRevision || JSON.stringify(preview.componentIds) !== JSON.stringify(ids)) return fail('CONFLICT', 'the reviewed preview no longer matches the observed host', { stateChanged: false })
  if (preview.extraRemovalsFingerprint !== (input.acceptExtraRemovals ?? null)) return fail('CONFLICT', preview.extraRemovals.length ? 'extra package removals require explicit review' : 'the reviewed extra removals no longer match', { stateChanged: false, extraRemovals: preview.extraRemovals, extraRemovalsFingerprint: preview.extraRemovalsFingerprint })
  const admitted = admittedPackageNames(family, observed.phpVersions)
  if (!preview.requestedPackages.length || preview.requestedPackages.some(name => !admitted.has(name) || isProtectedPackage(family, name)) || preview.packages.remove.some(change => isProtectedPackage(family, change.name))) return fail('PRECONDITION_FAILED', 'the preview names packages outside the reviewed catalog', { stateChanged: false })
  const kind = family === 'debian' ? (action === 'install' ? 'apt-install' : 'apt-remove') : (action === 'install' ? 'dnf-install' : 'dnf-remove')
  const argv = softwareCenterArgv(kind, preview.requestedPackages)
  const byId = new Map(observed.components.map(item => [item.id, item]))
  const targets = preview.resolvedComponentIds.map(id => ({ id, packages: byId.get(id)?.packages ?? [] }))
  if (targets.some(target => !target.packages.length)) return fail('CONFLICT', 'the reviewed components are no longer observed', { stateChanged: false })
  const before = [...observed.packages].filter(([, value]) => value.installed).map(([name]) => name)
  const previewedRemovals = new Set(preview.packages.remove.map(change => change.name))
  const protectedBefore = before.filter(name => isProtectedPackage(family, name))
  const watch = [...new Set([...targets.flatMap(target => target.packages), ...before])].sort()
  const names = observed.components.filter(item => preview.resolvedComponentIds.includes(item.id)).map(item => item.name)
  const summary = ((action === 'install' ? 'Install ' : 'Remove ') + names.join(', ')).slice(0, 512)
  const verify = async (run: HostJobRun): Promise<HostJobVerification> => {
    const after = await readPackages(family, run, watch)
    if (after === 'unavailable' || after === 'invalid') return { ok: false, detail: { reason: 'package-database-' + after } }
    const installed = (name: string): boolean => after.get(name)?.installed === true
    const components = Object.fromEntries(targets.map(target => {
      const count = target.packages.filter(installed).length
      return [target.id, count === target.packages.length ? 'installed' : count === 0 ? 'absent' : 'partial']
    }))
    const unexpectedRemovals = before.filter(name => !installed(name) && !previewedRemovals.has(name)).sort()
    const protectedMissing = protectedBefore.filter(name => !installed(name)).sort()
    const target = action === 'install' ? 'installed' : 'absent'
    const reached = Object.values(components).every(state => state === target)
    return { ok: reached && !unexpectedRemovals.length && !protectedMissing.length, detail: { target, components, unexpectedRemovals: unexpectedRemovals.slice(0, 64), protectedMissing: protectedMissing.slice(0, 64) } }
  }
  const same = (argvToCheck: readonly string[]): boolean => argvToCheck.length === argv.length && argv.every((value, index) => argvToCheck[index] === value)
  return {
    kind: 'software.component.' + action,
    summary,
    accountId: null,
    fingerprint: { action, family, componentIds: ids, resolvedComponentIds: preview.resolvedComponentIds, observedRevision: input.observedRevision, previewFingerprint: preview.fingerprint, extraRemovalsFingerprint: preview.extraRemovalsFingerprint },
    detail: { family, packages: preview.requestedPackages, extraRemovals: preview.extraRemovals, pulledComponentIds: preview.pulledComponentIds, estimate: preview.estimate },
    steps: [{
      id: action + '-packages',
      title: action === 'install' ? msgid('Install reviewed packages') : msgid('Remove reviewed packages'),
      argv, mutates: true, timeoutMs: 1_800_000,
      ...(family === 'debian' ? { env: { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l' } } : {}),
    }],
    // Read-only package queries for verification, or this plan's exact reviewed mutation; nothing else.
    policy: candidate => isSoftwareCenterCommand(candidate) && (candidate[0] === '/usr/bin/dpkg-query' || candidate[0] === '/usr/bin/rpm' || same(candidate)),
    verify,
  }
}
