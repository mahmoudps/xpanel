/** Reviewed package-manager argv grammar. Exact argv only: no shell, caller-selected binary, option or path. */
export type PackageManagerFamily = 'debian' | 'rhel'

/** apt-get(8) -s: simulation only; Debug::NoLocking avoids taking the dpkg/lists locks for a read. */
export const APT_SIMULATE_UPGRADE_ARGV = ['/usr/bin/apt-get', '-s', '-q', '-o', 'Debug::NoLocking=1', 'dist-upgrade'] as const
export const APT_SHOW_HOLDS_ARGV = ['/usr/bin/apt-mark', 'showhold'] as const
export const APT_UPDATE_ARGV = ['/usr/bin/apt-get', 'update', '-q'] as const
/** --no-remove: apt-get(8) aborts instead of removing packages; an upgrade request never removes software. */
export const APT_UPGRADE_PREFIX = ['/usr/bin/apt-get', 'install', '-y', '-q', '--only-upgrade', '--no-remove', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', '--'] as const
/** NEEDRESTART_MODE=l lists services needing a restart and never restarts them. */
export const APT_UPGRADE_ENV = Object.freeze({ DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l', APT_LISTCHANGES_FRONTEND: 'none' } as const)
/** dnf(8) check-update exits 100 when updates exist, 0 when none, other codes on failure. */
export const DNF_CHECK_UPDATE_ARGV = ['/usr/bin/dnf', '-q', '--cacheonly', 'check-update'] as const
export const DNF_SECURITY_ARGV = ['/usr/bin/dnf', '-q', '--cacheonly', 'updateinfo', 'list', '--security'] as const
export const DNF_MAKECACHE_ARGV = ['/usr/bin/dnf', '-q', 'makecache'] as const
export const DNF_UPGRADE_PREFIX = ['/usr/bin/dnf', '-y', '-q', 'upgrade', '--'] as const
/** apt-get(8) --simulate and dnf(8) --assumeno resolve the exact selected transaction without applying it. */
export const APT_SELECTED_SIMULATION_PREFIX = ['/usr/bin/apt-get', '-s', '-q', '--only-upgrade', '--no-remove', '-o', 'Debug::NoLocking=1', 'install', '--'] as const
export const DNF_SELECTED_SIMULATION_PREFIX = ['/usr/bin/dnf', '-q', '--cacheonly', '--assumeno'] as const

export const MAX_PACKAGE_SELECTION = 500
// Debian names may carry a multiarch qualifier; a trailing '-' would make apt-get(8) treat the name as a removal.
const DEBIAN_PACKAGE = /^[a-z0-9](?:[a-z0-9+.-]{0,126}[a-z0-9+])?(?::[a-z0-9]{1,16})?$/
// RPM identities are name.arch exactly as check-update prints them; glob, @group, module and path forms are excluded.
const RPM_PACKAGE = /^[A-Za-z0-9_+](?:[A-Za-z0-9_.+-]{0,126}[A-Za-z0-9_+])?\.(?:noarch|x86_64|aarch64|i686|ppc64le|s390x)$/

export const isPackageName = (family: PackageManagerFamily, value: unknown): value is string =>
  typeof value === 'string' && (family === 'debian' ? DEBIAN_PACKAGE : RPM_PACKAGE).test(value)

/** Canonical family identities, never caller-provided globs; arch qualifiers are removed before classification. */
export const isKernelPackageName = (family: PackageManagerFamily, name: string): boolean => isPackageName(family, name) && (family === 'debian'
  ? /^linux-(?:image|headers|modules|generic|virtual|signed|kvm|lowlatency|aws|azure|gcp|oracle|hwe|oem|raspi)(?:-|$)/.test(name.split(':')[0]!)
  : /^kernel(?:-[A-Za-z0-9_+.-]+)?$/.test(name.slice(0, name.lastIndexOf('.'))))

export const isPackageSelection = (family: PackageManagerFamily, names: unknown): names is string[] =>
  Array.isArray(names) && names.length >= 1 && names.length <= MAX_PACKAGE_SELECTION && new Set(names).size === names.length && names.every(name => isPackageName(family, name))

export function packageUpgradeArgv(family: PackageManagerFamily, names: readonly string[]): string[] {
  if (!isPackageSelection(family, names)) throw new Error('invalid_package_selection')
  return [...(family === 'debian' ? APT_UPGRADE_PREFIX : DNF_UPGRADE_PREFIX), ...names]
}

const kernelExclusionOption = (family: PackageManagerFamily, excluded: readonly string[]): string[] => {
  if (excluded.length > 40 || new Set(excluded).size !== excluded.length || excluded.some(name => !isKernelExclusionSpec(family, name)) || excluded.join(',').length > 4000) throw new Error('invalid_kernel_exclusion')
  return family === 'rhel' && excluded.length ? ['--exclude=' + excluded.join(',')] : []
}
const isKernelExclusionSpec = (family: PackageManagerFamily, spec: string): boolean => {
  if (family === 'rhel') return isKernelPackageName(family, spec)
  const match = /^(.+?)(?:=([A-Za-z0-9.+~:^_-]{1,256})|(-))$/.exec(spec)
  return !!match && isKernelPackageName(family, match[1]!)
}
const isKernelExcludedAptSelection = (args: readonly unknown[]): boolean => {
  const names = args.filter(arg => typeof arg === 'string' && isPackageName('debian', arg)) as string[]
  const excluded = args.filter(arg => !names.includes(String(arg)))
  if (!isPackageSelection('debian', names) || names.some(name => isKernelPackageName('debian', name)) || !excluded.every(arg => typeof arg === 'string')) return false
  try { kernelExclusionOption('debian', excluded as string[]); return excluded.length > 0 && args.length === names.length + excluded.length } catch { return false }
}
export function packageSelectionSimulationArgv(family: PackageManagerFamily, names: readonly string[], excluded: readonly string[] = []): string[] {
  if (!isPackageSelection(family, names)) throw new Error('invalid_package_selection')
  const exclusion = kernelExclusionOption(family, excluded)
  return family === 'debian' ? [...APT_SELECTED_SIMULATION_PREFIX, ...names, ...excluded] : [...DNF_SELECTED_SIMULATION_PREFIX, ...exclusion, 'upgrade', '--', ...names]
}
/** DNF excludes apply only to this invocation; persistent versionlock/excludepkgs configuration is untouched. */
export function packageKernelExcludedUpgradeArgv(family: PackageManagerFamily, names: readonly string[], excluded: readonly string[]): string[] {
  if (!isPackageSelection(family, names) || names.some(name => isKernelPackageName(family, name))) throw new Error('invalid_package_selection')
  const exclusion = kernelExclusionOption(family, excluded)
  return family === 'debian' ? [...packageUpgradeArgv(family, names), ...excluded] : ['/usr/bin/dnf', '-y', '-q', '--cacheonly', ...exclusion, 'upgrade', '--', ...names]
}

const EXACT: readonly (readonly string[])[] = [APT_SIMULATE_UPGRADE_ARGV, APT_SHOW_HOLDS_ARGV, APT_UPDATE_ARGV, DNF_CHECK_UPDATE_ARGV, DNF_SECURITY_ARGV, DNF_MAKECACHE_ARGV]

export function isPackageManagerCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  if (EXACT.some(allowed => allowed.length === argv.length && allowed.every((value, index) => value === argv[index]))) return true
  for (const [family, prefix] of [['debian', APT_UPGRADE_PREFIX], ['rhel', DNF_UPGRADE_PREFIX]] as const) {
    if (argv.length > prefix.length && prefix.every((value, index) => value === argv[index])) return isPackageSelection(family, argv.slice(prefix.length)) || family === 'debian' && isKernelExcludedAptSelection(argv.slice(prefix.length))
  }
  if (APT_SELECTED_SIMULATION_PREFIX.every((value, index) => value === argv[index])) return isPackageSelection('debian', argv.slice(APT_SELECTED_SIMULATION_PREFIX.length)) || isKernelExcludedAptSelection(argv.slice(APT_SELECTED_SIMULATION_PREFIX.length))
  for (const prefix of [DNF_SELECTED_SIMULATION_PREFIX, ['/usr/bin/dnf', '-y', '-q', '--cacheonly']] as const) {
    if (!prefix.every((value, index) => value === argv[index])) continue
    let index = prefix.length
    const option = argv[index] as string | undefined
    if (option?.startsWith('--exclude=')) {
      const excluded = option.slice(10).split(',')
      try { if (kernelExclusionOption('rhel', excluded)[0] !== option) return false } catch { return false }
      index++
    }
    if (argv[index] === 'upgrade' && argv[index + 1] === '--') return isPackageSelection('rhel', argv.slice(index + 2)) && ((prefix as readonly string[]).includes('--assumeno') || !(argv.slice(index + 2) as string[]).some(name => isKernelPackageName('rhel', name)))
  }
  return false
}
