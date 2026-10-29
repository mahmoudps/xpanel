import { createHash } from 'node:crypto'
import { fail, msgid, sanitizePhpIni } from '@xpanel/core'
import { SUPPORTED_PHP_VERSIONS } from '@xpanel/os'
import { isSoftwareCenterCommand, softwareCenterArgv } from '../../../packages/os/src/software-center-command.ts'
import type { HostJobCommandStep, HostJobPlan, HostJobRun, HostJobStepResult, HostJobVerification } from './host-job-contract.ts'
import { PHP_DPKG_QUERY_ARGV, PHP_RPM_QUERY_ARGV, parsePhpPackages } from './php-inventory.ts'
import { simulate, type SimulationPlan } from './software-center.ts'

/**
 * Server-wide PHP management: versions (packages), FPM extensions and a managed php.ini drop-in per
 * version. The host is the source of truth; every write is a reviewed host job bound to the
 * observed revision, tested with php-fpm -t and reverted when the test fails.
 */
export type PhpFamily = 'debian' | 'rhel'
export type PhpManagerRun = (argv: readonly string[]) => Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }>
export interface PhpManagerHost {
  family: PhpFamily
  /** OsProfile.phpPackages: the installer's reviewed package set for one version */
  phpPackages(version: string): readonly string[]
  phpFpmBinary(version: string): string
  phpIniFile(version: string): string
  run: PhpManagerRun
  readFile(path: string): Promise<string | null>
  listDir(path: string): Promise<string[] | null>
  /** Writes a root-only staging file the job installs from; never a path the request chose. */
  writeStaged(path: string, content: string): Promise<void>
  now?(): Date
}

export const PHP_STAGING_DIR = '/var/lib/xpanel/php-ini'
export const MANAGED_INI_NAME = '99-xpanel.ini'
const compact = (version: string): string => version.replace('.', '')
const supported = new Set<string>(SUPPORTED_PHP_VERSIONS)
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const extensionName = /^[a-z][a-z0-9_]{0,31}$/

/** Extensions the design offers by package; installing the package enables the module on Debian. */
export const CURATED_PHP_EXTENSIONS: readonly { module: string; package: string }[] = [
  { module: 'opcache', package: 'opcache' },
  { module: 'mysqli', package: 'mysql' },
  { module: 'pdo_mysql', package: 'mysql' },
  { module: 'pgsql', package: 'pgsql' },
  { module: 'pdo_pgsql', package: 'pgsql' },
  { module: 'curl', package: 'curl' },
  { module: 'gd', package: 'gd' },
  { module: 'imagick', package: 'imagick' },
  { module: 'intl', package: 'intl' },
  { module: 'mbstring', package: 'mbstring' },
  { module: 'xml', package: 'xml' },
  { module: 'zip', package: 'zip' },
  { module: 'bcmath', package: 'bcmath' },
  { module: 'soap', package: 'soap' },
  { module: 'redis', package: 'redis' },
  { module: 'xdebug', package: 'xdebug' },
]

export const phpPaths = (family: PhpFamily, version: string, iniFile: string) => {
  const dir = iniFile.slice(0, iniFile.lastIndexOf('/'))
  const confD = family === 'debian' ? dir + '/conf.d' : dir + '/php.d'
  return { confD, modsAvailable: family === 'debian' ? `/etc/php/${version}/mods-available` : null, managedIni: confD + '/' + MANAGED_INI_NAME, iniFile }
}

export interface PhpExtensionObservation {
  module: string; package: string | null; installed: boolean; enabled: boolean | null
  /** Remi: the module's file in php.d, NN-name.ini when on, NN-name.ini.disabled when switched off here */
  file?: string
}
export interface PhpManagedVersion {
  version: string
  packages: string[]
  fpmInstalled: boolean
  fpmBinary: string
  iniFile: string
  managedIni: string
  /** values of the managed drop-in; null when it exists but is not one xPanel wrote */
  ini: Record<string, string> | null
  extensions: PhpExtensionObservation[]
}
export interface PhpManagementObservation {
  state: 'read' | 'unavailable'
  reason: 'package-database-unavailable' | 'invalid-package-database' | null
  family: PhpFamily
  observedAt: string
  revision: string | null
  versions: PhpManagedVersion[]
  installable: string[]
  capabilities: { install: boolean; remove: boolean; extensions: boolean; ini: boolean }
}

const HEADER = '; Managed by xPanel: server-wide php.ini values for PHP-FPM. Change them in xWHM > PHP.'
export const renderManagedIni = (version: string, ini: Record<string, string>): string =>
  [HEADER, `; PHP ${version}`, ...Object.entries(ini).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key} = ${value}`)].join('\n') + '\n'

/** Reads back only files xPanel wrote; anything else is reported, never rewritten silently. */
export function parseManagedIni(text: string | null): Record<string, string> | null {
  if (text === null) return {}
  if (!text.startsWith(HEADER + '\n')) return null
  const out: Record<string, string> = {}
  for (const line of text.split('\n').slice(1)) {
    if (!line || line.startsWith(';')) continue
    const match = /^([a-z_.]{1,64}) = (.{1,256})$/.exec(line)
    if (!match) return null
    out[match[1]!] = match[2]!
  }
  try { return sanitizePhpIni(out) } catch { return null }
}

/** Distro package that provides a curated extension; Remi uses its own names for some PECL builds. */
const REMI_PACKAGE: Readonly<Record<string, string>> = { mysql: 'mysqlnd', zip: 'pecl-zip', redis: 'pecl-redis5', imagick: 'pecl-imagick-im7', xdebug: 'pecl-xdebug3' }
export const extensionPackage = (family: PhpFamily, version: string, key: string): string | null =>
  family === 'debian' ? 'php' + version + '-' + key : 'php' + compact(version) + '-php-' + (REMI_PACKAGE[key] ?? key)

async function readExtensions(host: PhpManagerHost, version: string, packages: readonly string[]): Promise<PhpExtensionObservation[]> {
  const paths = phpPaths(host.family, version, host.phpIniFile(version))
  const listing = await host.listDir(paths.confD) ?? []
  const enabled = new Set(listing.map(name => /^[0-9]{1,3}-([a-z][a-z0-9_]{0,31})\.ini$/.exec(name)?.[1]).filter((name): name is string => !!name))
  const curated = new Map(CURATED_PHP_EXTENSIONS.map(item => [item.module, item]))
  const installedPackage = (name: string | null): boolean => name !== null && packages.includes(extensionPackage(host.family, version, name) ?? '')
  const rows = new Map<string, PhpExtensionObservation>()
  if (host.family === 'debian') {
    const modules = (await host.listDir(paths.modsAvailable!) ?? []).map(name => /^([a-z][a-z0-9_]{0,31})\.ini$/.exec(name)?.[1]).filter((name): name is string => !!name)
    for (const module of modules) rows.set(module, { module, package: curated.get(module)?.package ?? null, installed: true, enabled: enabled.has(module) })
  } else {
    // Remi ships one NN-name.ini per module in php.d; a module switched off here keeps its file as NN-name.ini.disabled
    for (const file of listing) {
      const match = /^[0-9]{1,3}-([a-z][a-z0-9_]{0,31})\.ini(\.disabled)?$/.exec(file)
      if (!match || rows.has(match[1]!) && !match[2]) continue
      rows.set(match[1]!, { module: match[1]!, package: curated.get(match[1]!)?.package ?? null, installed: true, enabled: !match[2], file })
    }
  }
  for (const item of CURATED_PHP_EXTENSIONS) if (!rows.has(item.module)) rows.set(item.module, { module: item.module, package: item.package, installed: installedPackage(item.package), enabled: false })
  return [...rows.values()].sort((left, right) => left.module.localeCompare(right.module))
}

async function readPackages(host: PhpManagerHost): Promise<Map<string, string[]> | 'unavailable' | 'invalid'> {
  let result: Awaited<ReturnType<PhpManagerRun>>
  try { result = await host.run(host.family === 'debian' ? PHP_DPKG_QUERY_ARGV : PHP_RPM_QUERY_ARGV) } catch { return 'unavailable' }
  if (!result.ok) return 'unavailable'
  try {
    const parsed = parsePhpPackages(result.stdout, host.family === 'debian' ? 'dpkg' : 'rpm')
    // only the version's own runtime packages; lsphp builds and the unversioned php-* metapackages are not part of it
    const own = (version: string, name: string): boolean => host.family === 'debian' ? name === 'php' + version || name.startsWith('php' + version + '-') : name.startsWith('php' + compact(version) + '-php')
    return new Map([...parsed].map(([version, entries]) => [version, entries.map(entry => entry.name.replace(/:[a-z0-9_-]+$/, '')).filter(name => own(version, name)).sort()] as const).filter(([, names]) => names.length > 0))
  } catch { return 'invalid' }
}

export async function readPhpManagement(host: PhpManagerHost): Promise<PhpManagementObservation> {
  const observedAt = (host.now?.() ?? new Date()).toISOString()
  const capabilities = { install: true, remove: true, extensions: true, ini: true }
  const packages = await readPackages(host)
  if (packages === 'unavailable' || packages === 'invalid') {
    return { state: 'unavailable', reason: packages === 'unavailable' ? 'package-database-unavailable' : 'invalid-package-database', family: host.family, observedAt, revision: null, versions: [], installable: [], capabilities: { install: false, remove: false, extensions: false, ini: false } }
  }
  const fpmPackage = (version: string): string => host.family === 'debian' ? `php${version}-fpm` : `php${compact(version)}-php-fpm`
  const versions: PhpManagedVersion[] = []
  for (const version of [...packages.keys()].filter(version => supported.has(version)).sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))) {
    const names = packages.get(version)!
    const paths = phpPaths(host.family, version, host.phpIniFile(version))
    versions.push({
      version, packages: names, fpmInstalled: names.includes(fpmPackage(version)), fpmBinary: host.phpFpmBinary(version), iniFile: paths.iniFile, managedIni: paths.managedIni,
      ini: parseManagedIni(await host.readFile(paths.managedIni)), extensions: await readExtensions(host, version, names),
    })
  }
  const installable = SUPPORTED_PHP_VERSIONS.filter(version => !versions.some(item => item.version === version && item.fpmInstalled))
  const revision = sha256(JSON.stringify({ family: host.family, versions }))
  return { state: 'read', reason: null, family: host.family, observedAt, revision, versions, installable, capabilities }
}

// ---- operations ----------------------------------------------------------------------

export type PhpOperation =
  | { operation: 'install-version'; version: string }
  | { operation: 'remove-version'; version: string }
  | { operation: 'set-extension'; version: string; extension: string; enabled: boolean }
  | { operation: 'set-ini'; version: string; ini: Record<string, string> }

export function readPhpOperation(value: Record<string, unknown>): PhpOperation {
  const version = value.version
  if (typeof version !== 'string' || !supported.has(version)) return fail('VALIDATION', 'a supported PHP version is required', { stateChanged: false })
  switch (value.operation) {
    case 'install-version': case 'remove-version':
      if (Object.keys(value).some(key => !['operation', 'version'].includes(key))) break
      return { operation: value.operation, version }
    case 'set-extension':
      if (Object.keys(value).some(key => !['operation', 'version', 'extension', 'enabled'].includes(key)) || typeof value.extension !== 'string' || !extensionName.test(value.extension) || typeof value.enabled !== 'boolean') break
      return { operation: 'set-extension', version, extension: value.extension, enabled: value.enabled }
    case 'set-ini':
      if (Object.keys(value).some(key => !['operation', 'version', 'ini'].includes(key))) break
      return { operation: 'set-ini', version, ini: sanitizePhpIni(value.ini) }
  }
  return fail('VALIDATION', 'operation must be install-version, remove-version, set-extension or set-ini with its fields', { stateChanged: false })
}

export interface PhpPreview {
  state: 'ready' | 'blocked'
  reason: string | null
  operation: PhpOperation
  revision: string
  steps: { id: string; title: string }[]
  packages: SimulationPlan | null
  ini: { before: Record<string, string> | null; after: Record<string, string> } | null
  /** systemd unit pattern reloaded after a passing php-fpm -t */
  reloads: string | null
  fingerprint: string
}

type PlannedStep = HostJobCommandStep
const fpmTest = (host: PhpManagerHost, version: string): string[] => [host.phpFpmBinary(version), '-t']
const reloadPattern = (version: string): string => `xpanel-php-fpm-*-${version}.service`
const reloadArgv = (version: string): string[] => ['/usr/bin/systemctl', 'try-reload-or-restart', '--', reloadPattern(version)]
const modArgv = (enable: boolean, version: string, module: string): string[] => [enable ? '/usr/sbin/phpenmod' : '/usr/sbin/phpdismod', '-v', version, '-s', 'fpm', module]
const packageEnv = (host: PhpManagerHost): Pick<PlannedStep, 'env'> => host.family === 'debian' ? { env: { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l' } } : {}
const stagedPaths = (version: string, fingerprint: string) => ({ candidate: `${PHP_STAGING_DIR}/${version}-${fingerprint.slice(0, 16)}.candidate.ini`, previous: `${PHP_STAGING_DIR}/${version}-${fingerprint.slice(0, 16)}.previous.ini` })

interface Built { steps: PlannedStep[]; packages: SimulationPlan | null; ini: PhpPreview['ini']; reloads: string | null; blocked: string | null; undo: PlannedStep | null; target: (after: PhpManagementObservation) => boolean; stage?: { candidate: string; previous: string | null } }

async function build(host: PhpManagerHost, op: PhpOperation, observed: PhpManagementObservation): Promise<Built> {
  const current = observed.versions.find(item => item.version === op.version)
  const none = (blocked: string): Built => ({ steps: [], packages: null, ini: null, reloads: null, blocked, undo: null, target: () => false })
  const test: PlannedStep = { id: 'test-config', title: msgid('Check the PHP {version} configuration with php-fpm -t'), titleValues: { version: op.version }, argv: fpmTest(host, op.version), mutates: false, timeoutMs: 60_000 }
  const reload: PlannedStep = { id: 'reload-pools', title: msgid('Reload the account pools on PHP {version}'), titleValues: { version: op.version }, argv: reloadArgv(op.version), mutates: true, timeoutMs: 300_000 }
  const installKind = host.family === 'debian' ? 'apt-install' : 'dnf-install'
  if (op.operation === 'install-version') {
    if (current?.fpmInstalled) return none('already-installed')
    const names = [...host.phpPackages(op.version)]
    const outcome = await simulate(host.family, 'install', host.run, names)
    if ('refusal' in outcome) return { ...none(outcome.refusal), packages: null }
    return { steps: [{ id: 'install-packages', title: msgid('Install the PHP {version} packages'), titleValues: { version: op.version }, argv: softwareCenterArgv(installKind, names), mutates: true, timeoutMs: 1_800_000, ...packageEnv(host) }, test],
      packages: outcome.plan, ini: null, reloads: null, blocked: null, undo: null, target: after => after.versions.some(item => item.version === op.version && item.fpmInstalled) }
  }
  if (!current) return none('not-installed')
  if (op.operation === 'remove-version') {
    const outcome = await simulate(host.family, 'remove', host.run, current.packages)
    if ('refusal' in outcome) return none(outcome.refusal)
    // the removal may not reach outside this version's own packages
    const own = new Set(current.packages)
    if (outcome.plan.remove.some(change => !own.has(change.name.replace(/:[a-z0-9-]+$/, '')))) return { ...none('removes-other-packages'), packages: outcome.plan }
    return { steps: [{ id: 'remove-packages', title: msgid('Remove the PHP {version} packages'), titleValues: { version: op.version }, argv: softwareCenterArgv(host.family === 'debian' ? 'apt-remove' : 'dnf-remove', current.packages), mutates: true, timeoutMs: 1_800_000, ...packageEnv(host) }],
      packages: outcome.plan, ini: null, reloads: null, blocked: null, undo: null, target: after => !after.versions.some(item => item.version === op.version) }
  }
  if (!current.fpmInstalled) return none('fpm-not-installed')
  if (op.operation === 'set-extension') {
    if (!observed.capabilities.extensions) return none('extensions-not-supported-on-this-os')
    const row = current.extensions.find(item => item.module === op.extension)
    if (!row) return none('unknown-extension')
    if (row.enabled === op.enabled) return none('nothing-to-do')
    const target = (after: PhpManagementObservation): boolean => after.versions.find(item => item.version === op.version)?.extensions.find(item => item.module === op.extension)?.enabled === op.enabled
    const confD = phpPaths(host.family, op.version, host.phpIniFile(op.version)).confD
    // Debian switches the fpm SAPI symlink; Remi renames the module's own php.d file
    const toggle = (enable: boolean): string[] => {
      if (host.family === 'debian') return modArgv(enable, op.version, op.extension)
      const on = row.file!.replace(/\.disabled$/, ''), off = on + '.disabled'
      return enable ? ['/usr/bin/mv', '-T', '--', confD + '/' + off, confD + '/' + on] : ['/usr/bin/mv', '-T', '--', confD + '/' + on, confD + '/' + off]
    }
    // after a fresh install on Remi the module file name is not known yet, so a failed test leaves it for review
    const undo: PlannedStep | null = row.installed || host.family === 'debian' ? { id: 'undo-extension', title: msgid('Restore {extension} for PHP {version}'), titleValues: { extension: op.extension, version: op.version }, argv: row.installed ? toggle(!op.enabled) : modArgv(false, op.version, op.extension), mutates: true, timeoutMs: 60_000 } : null
    if (!row.installed) {
      if (!op.enabled || !row.package) return none('package-not-installed')
      const names = [extensionPackage(host.family, op.version, row.package)!]
      const outcome = await simulate(host.family, 'install', host.run, names)
      if ('refusal' in outcome) return none(outcome.refusal)
      return { steps: [{ id: 'install-extension', title: msgid('Install {package}'), titleValues: { package: names[0]! }, argv: softwareCenterArgv(installKind, names), mutates: true, timeoutMs: 1_800_000, ...packageEnv(host) }, test, reload],
        packages: outcome.plan, ini: null, reloads: reloadPattern(op.version), blocked: null, undo, target }
    }
    return { steps: [{ id: 'switch-extension', title: op.enabled ? msgid('Enable {extension} for PHP {version}') : msgid('Disable {extension} for PHP {version}'), titleValues: { extension: op.extension, version: op.version }, argv: toggle(op.enabled), mutates: true, timeoutMs: 60_000 }, test, reload],
      packages: null, ini: null, reloads: reloadPattern(op.version), blocked: null, undo, target }
  }
  if (current.ini === null) return none('managed-ini-modified-outside-xpanel')
  if (JSON.stringify(Object.entries(current.ini).sort()) === JSON.stringify(Object.entries(op.ini).sort())) return none('nothing-to-do')
  const fingerprint = sha256(JSON.stringify({ revision: observed.revision, op }))
  const staged = stagedPaths(op.version, fingerprint)
  const existed = (await host.readFile(current.managedIni)) !== null
  const install = (from: string, id: string, title: string): PlannedStep => ({ id, title, titleValues: { version: op.version }, argv: ['/usr/bin/install', '-m', '0644', '-o', 'root', '-g', 'root', '--', from, current.managedIni], mutates: true, timeoutMs: 60_000 })
  const undo: PlannedStep = existed ? install(staged.previous, 'undo-ini', msgid('Restore the previous php.ini values for PHP {version}')) : { id: 'undo-ini', title: msgid('Restore the previous php.ini values for PHP {version}'), titleValues: { version: op.version }, argv: ['/usr/bin/rm', '-f', '--', current.managedIni], mutates: true, timeoutMs: 60_000 }
  return { steps: [install(staged.candidate, 'write-ini', msgid('Write the php.ini values for PHP {version}')), test, reload],
    packages: null, ini: { before: current.ini, after: op.ini }, reloads: reloadPattern(op.version), blocked: null, undo,
    target: after => JSON.stringify(Object.entries(after.versions.find(item => item.version === op.version)?.ini ?? {}).sort()) === JSON.stringify(Object.entries(op.ini).sort()),
    stage: { candidate: staged.candidate, previous: existed ? staged.previous : null } }
}

export async function previewPhpOperation(host: PhpManagerHost, op: PhpOperation, observed: PhpManagementObservation): Promise<PhpPreview & { built: Built }> {
  if (observed.state !== 'read' || observed.revision === null) return fail('PRECONDITION_FAILED', 'the PHP packages could not be observed', { stateChanged: false })
  const built = await build(host, op, observed)
  const fingerprint = sha256(JSON.stringify({ revision: observed.revision, op, steps: built.steps.map(step => step.argv) }))
  return { state: built.blocked ? 'blocked' : 'ready', reason: built.blocked, operation: op, revision: observed.revision, steps: built.steps.map(step => ({ id: step.id, title: step.title })), packages: built.packages, ini: built.ini, reloads: built.reloads, fingerprint, built }
}

const TITLES: Record<PhpOperation['operation'], string> = { 'install-version': 'Install PHP', 'remove-version': 'Remove PHP', 'set-extension': 'Change PHP extension', 'set-ini': 'Change php.ini' }

/** Stages the ini files when needed and builds the reviewed job; the agent submits it unchanged. */
export async function buildPhpJobPlan(host: PhpManagerHost, preview: PhpPreview & { built: Built }, observed: PhpManagementObservation): Promise<HostJobPlan> {
  const { built, operation: op } = preview
  if (preview.state !== 'ready' || observed.revision !== preview.revision) return fail('CONFLICT', 'the reviewed PHP change no longer matches the host', { stateChanged: false })
  if (built.stage && op.operation === 'set-ini') {
    await host.writeStaged(built.stage.candidate, renderManagedIni(op.version, op.ini))
    if (built.stage.previous) {
      const previous = await host.readFile(observed.versions.find(item => item.version === op.version)!.managedIni)
      if (previous === null) return fail('CONFLICT', 'the php.ini values changed while the job was prepared', { stateChanged: false })
      await host.writeStaged(built.stage.previous, previous)
    }
  }
  const allowed = new Set([...built.steps, ...(built.undo ? [built.undo] : [])].map(step => JSON.stringify(step.argv)))
  const verify = async (_run: HostJobRun): Promise<HostJobVerification> => {
    const after = await readPhpManagement(host)
    const reached = after.state === 'read' && built.target(after)
    return { ok: reached, detail: { operation: op.operation, version: op.version, reached, revision: after.revision } }
  }
  const finalize = async (run: (step: HostJobCommandStep) => Promise<{ ok: boolean }>, results: readonly HostJobStepResult[]): Promise<HostJobVerification> => {
    const failed = results.some(item => item.result === null || !item.result.ok)
    const changed = results.some(item => built.steps.find(step => step.id === item.id)?.mutates && item.result?.ok)
    if (!failed || !changed || !built.undo) return { ok: true, detail: { reverted: false } }
    // the change failed php-fpm -t or the reload: put the previous configuration back and test it again
    const undo = await run(built.undo)
    const retest = await run({ ...built.steps.find(step => step.id === 'test-config')!, id: 'retest-config' })
    return { ok: undo.ok && retest.ok, detail: { reverted: undo.ok, retested: retest.ok } }
  }
  return {
    kind: 'php.' + op.operation,
    summary: `${TITLES[op.operation]} ${op.version}${op.operation === 'set-extension' ? ` ${op.extension} ${op.enabled ? 'on' : 'off'}` : ''}`,
    accountId: null,
    fingerprint: { operation: op, observedRevision: preview.revision, previewFingerprint: preview.fingerprint },
    detail: { family: host.family, packages: built.packages, ini: built.ini, reloads: built.reloads },
    steps: built.steps,
    // the plan's own reviewed argv, its undo, and read-only package queries for verification; nothing else
    policy: argv => allowed.has(JSON.stringify(argv)) || (isSoftwareCenterCommand(argv) && (argv[0] === '/usr/bin/dpkg-query' || argv[0] === '/usr/bin/rpm')),
    verify,
    ...(built.undo ? { finalize } : {}),
  }
}
