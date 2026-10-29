import { PHP_DPKG_QUERY_ARGV } from './php-inventory-command.ts'

/**
 * Reviewed software-center package grammar. Exact argv only: fixed binaries, fixed flags, an
 * explicit `--` end-of-options marker and 1..64 strictly named packages. No shell, no URL, no
 * purge, no autoremove, no caller-selected option. Which names are admitted is decided by the
 * agent catalog; this grammar only bounds their syntax.
 */
export type SoftwareCenterFamily = 'debian' | 'rhel'
export const SOFTWARE_CENTER_MAX_NAMES = 64
// Debian policy 5.6.1 package names; RPM names additionally allow upper case and underscore.
const debianName = /^[a-z0-9][a-z0-9+.-]{1,63}$/
const rpmName = /^[A-Za-z0-9][A-Za-z0-9+._-]{1,63}$/
export const isSoftwareCenterPackageName = (family: SoftwareCenterFamily, name: unknown): name is string =>
  typeof name === 'string' && (family === 'debian' ? debianName : family === 'rhel' ? rpmName : null)?.test(name) === true

/** dpkg-query(1) -W without names lists every package dpkg knows (same argv as the PHP inventory). */
export const SOFTWARE_CENTER_DPKG_LIST_ARGV = PHP_DPKG_QUERY_ARGV
const confOptions = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'] as const
const commands = {
  'dpkg-query': { family: 'debian', prefix: [...PHP_DPKG_QUERY_ARGV, '--'] },
  'apt-cache-policy': { family: 'debian', prefix: ['/usr/bin/apt-cache', 'policy', '--'] },
  'apt-simulate-install': { family: 'debian', prefix: ['/usr/bin/apt-get', '-s', '-q', 'install', '--no-install-recommends', '--'] },
  'apt-simulate-remove': { family: 'debian', prefix: ['/usr/bin/apt-get', '-s', '-q', 'remove', '--'] },
  'apt-install': { family: 'debian', prefix: ['/usr/bin/apt-get', 'install', '-y', '-q', '--no-install-recommends', ...confOptions, '--'] },
  'apt-remove': { family: 'debian', prefix: ['/usr/bin/apt-get', 'remove', '-y', '-q', '--'] },
  'rpm-query': { family: 'rhel', prefix: ['/usr/bin/rpm', '-q', '--qf', '%{NAME}\t%{VERSION}-%{RELEASE}\n', '--'] },
  // No -q here: dnf(8) -q lowers the log level that prints the transaction table this preview parses.
  'dnf-simulate-install': { family: 'rhel', prefix: ['/usr/bin/dnf', '--assumeno', 'install', '--'] },
  'dnf-simulate-remove': { family: 'rhel', prefix: ['/usr/bin/dnf', '--assumeno', 'remove', '--'] },
  'dnf-install': { family: 'rhel', prefix: ['/usr/bin/dnf', '-y', '-q', 'install', '--'] },
  'dnf-remove': { family: 'rhel', prefix: ['/usr/bin/dnf', '-y', '-q', 'remove', '--'] },
} as const satisfies Record<string, { family: SoftwareCenterFamily; prefix: readonly string[] }>
export type SoftwareCenterCommandKind = keyof typeof commands

const validNames = (family: SoftwareCenterFamily, names: readonly unknown[]): boolean =>
  names.length >= 1 && names.length <= SOFTWARE_CENTER_MAX_NAMES && new Set(names).size === names.length && names.every(name => isSoftwareCenterPackageName(family, name))

export function softwareCenterArgv(kind: SoftwareCenterCommandKind, names: readonly string[]): string[] {
  const command = commands[kind]
  if (!command || !Array.isArray(names) || !validNames(command.family, names)) throw new Error('invalid_software_center_command')
  return [...command.prefix, ...names]
}

export function isSoftwareCenterCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  if (argv.length === SOFTWARE_CENTER_DPKG_LIST_ARGV.length && SOFTWARE_CENTER_DPKG_LIST_ARGV.every((value, index) => argv[index] === value)) return true
  return Object.values(commands).some(({ family, prefix }) => argv.length > prefix.length && prefix.every((value, index) => argv[index] === value) && validNames(family, argv.slice(prefix.length)))
}
