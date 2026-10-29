/**
 * Reviewed package-database diagnostic and repair grammar. Exact argv only: no caller-selected
 * package, path, option or binary. RHEL writes are metadata-only and require a recovery provider.
 */
export type RepairCommandFamily = 'debian' | 'rhel'

/** dpkg(1) -C, --audit: database sanity and consistency checks, read-only. */
export const DPKG_AUDIT_ARGV = ['/usr/bin/dpkg', '--audit'] as const
/** apt-get(8) check: diagnostic for broken dependencies, read-only. */
export const APT_CHECK_ARGV = ['/usr/bin/apt-get', 'check', '-q'] as const
/** apt-get(8) -s: simulation of `-f install`; prints Inst/Remv/Conf lines and changes nothing. */
export const APT_FIX_PREVIEW_ARGV = ['/usr/bin/apt-get', '-s', '-q', '-f', 'install'] as const
/** dnf(8) check: reports problems in the local package database, read-only. */
export const DNF_CHECK_ARGV = ['/usr/bin/dnf', '-q', 'check'] as const
/** rpmdb(8) low-level integrity check only: https://rpm.org/docs/6.0.x/man/rpmdb.8 */
export const RPMDB_VERIFY_ARGV = ['/usr/bin/rpmdb', '--verifydb'] as const
/** DNF --cacheonly prevents cache updates/network; makecache tests cached enabled-repository metadata. */
export const DNF_CACHE_CHECK_ARGV = ['/usr/bin/dnf', '--noplugins', '--cacheonly', '-q', 'makecache'] as const
/** DNF clean metadata removes repository metadata, never installed packages or downloaded RPMs. */
export const DNF_CACHE_CLEAN_ARGV = ['/usr/bin/dnf', '--noplugins', '-q', 'clean', 'metadata'] as const
/** Refresh metadata only; do not ignore unavailable repositories or run plugins/package transactions.
 * https://dnf.readthedocs.io/en/latest/command_ref.html#clean-command and #makecache-command */
export const DNF_CACHE_REFRESH_ARGV = ['/usr/bin/dnf', '--noplugins', '-q', '--refresh', '--setopt=*.skip_if_unavailable=False', '--setopt=timeout=30', '--setopt=retries=1', 'makecache'] as const

/**
 * dpkg(1) --configure -a with --force-confdef/--force-confold: a modified conffile keeps the
 * local version instead of opening an interactive prompt that would stall a job without a terminal.
 */
export const DPKG_CONFIGURE_PENDING_ARGV = ['/usr/bin/dpkg', '--force-confdef', '--force-confold', '--configure', '-a'] as const
/** apt-get(8) -f install, non-interactive, keeping locally modified conffiles. */
export const APT_FIX_BROKEN_ARGV = ['/usr/bin/apt-get', '-f', 'install', '-y', '-q', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'] as const
/** apt-get(8) --no-remove: aborts instead of removing any package. Used when no removal was accepted. */
export const APT_FIX_BROKEN_NO_REMOVE_ARGV = [...APT_FIX_BROKEN_ARGV, '--no-remove'] as const

/** Environment for mutating Debian repair steps: no debconf prompt, needrestart lists only. */
export const REPAIR_MUTATION_ENV = Object.freeze({ DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l' } as const)

const READ_COMMANDS: readonly (readonly string[])[] = [DPKG_AUDIT_ARGV, APT_CHECK_ARGV, APT_FIX_PREVIEW_ARGV, DNF_CHECK_ARGV, RPMDB_VERIFY_ARGV, DNF_CACHE_CHECK_ARGV]
const MUTATING_COMMANDS: readonly (readonly string[])[] = [DPKG_CONFIGURE_PENDING_ARGV, APT_FIX_BROKEN_ARGV, APT_FIX_BROKEN_NO_REMOVE_ARGV, DNF_CACHE_CLEAN_ARGV, DNF_CACHE_REFRESH_ARGV]

const matchesOne = (argv: readonly unknown[], allowed: readonly (readonly string[])[]): boolean =>
  Array.isArray(argv) && argv.every(value => typeof value === 'string')
  && allowed.some(expected => expected.length === argv.length && expected.every((value, index) => value === argv[index]))

export const isRepairReadCommand = (argv: readonly unknown[]): boolean => matchesOne(argv, READ_COMMANDS)
export const isRepairMutationCommand = (argv: readonly unknown[]): boolean => matchesOne(argv, MUTATING_COMMANDS)
/** Job policy and executor admission: exactly one of the reviewed argv vectors above. */
export const isRepairCommand = (argv: readonly unknown[]): boolean => matchesOne(argv, [...READ_COMMANDS, ...MUTATING_COMMANDS])
