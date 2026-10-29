/** Reviewed package-recovery grammar: exact argv only, no caller-selected package, path or option. */

/** rpm(8) -qa with --queryformat %{NEVRA}: one installed header identity per line; read-only. */
export const RPM_INSTALLED_IDENTITY_ARGV = ['/usr/bin/rpm', '-qa', '--qf', '%{NEVRA}\\n'] as const
/** rpmdb(8) --rebuilddb rebuilds the database from its installed headers; it runs only after a verified snapshot. */
export const RPMDB_REBUILD_ARGV = ['/usr/bin/rpmdb', '--rebuilddb'] as const

const COMMANDS: readonly (readonly string[])[] = [RPM_INSTALLED_IDENTITY_ARGV, RPMDB_REBUILD_ARGV]
const exactly = (argv: readonly unknown[], allowed: readonly (readonly string[])[]): boolean =>
  Array.isArray(argv) && allowed.some(expected => expected.length === argv.length && expected.every((value, index) => value === argv[index]))
/** Job-plan grammar: both commands. The rebuild runs only as a host-job step under its own plan policy. */
export const isOpsPackageRecoveryCommand = (argv: readonly unknown[]): boolean => exactly(argv, COMMANDS)
/** Executor admission for direct runs: the read-only identity query only, never the rebuild. */
export const isRpmInstalledIdentityCommand = (argv: readonly unknown[]): boolean => exactly(argv, [RPM_INSTALLED_IDENTITY_ARGV])
