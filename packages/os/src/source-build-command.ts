/** Reviewed grammar of the EL source rebuilds (apps/agent/src/source-builds.ts): exact argv only. */

export const SOURCE_BUILD_MODULES = ['mpm-itk', 'fts-xapian', 'webalizer', 'awstats'] as const
export type SourceBuildModule = (typeof SOURCE_BUILD_MODULES)[number]

/** rpm(8) -q with --queryformat: one NAME VERSION line per installed package, a sentence for a missing one; read-only. */
export const SOURCE_BUILD_PACKAGES_ARGV = ['/usr/bin/rpm', '-q', '--qf', '%{NAME} %{VERSION}\\n', 'httpd', 'dovecot'] as const

// The unit keeps a compile behind the sites and mail of a 1 vCPU / 1 GB host: idle priority, half a CPU, room for the measured
// 275 MB peak, and first in line for the OOM killer. Its fixed name refuses a second run, and it outlives an agent restart.
const UNIT: readonly string[] = ['/usr/bin/systemd-run', '--wait', '--collect', '--quiet', '--unit=xpanel-source-build', '--property=Nice=19', '--property=IOSchedulingClass=idle', '--property=CPUQuota=50%', '--property=MemoryMax=512M', '--property=OOMScoreAdjust=1000', '--property=RuntimeMaxSec=1800', '--', '/bin/bash']
const SCRIPT = /^(?:\/(?!\.\.?\/)[A-Za-z0-9_.-]+)+\/scripts\/el-source-builds\.sh$/

export const sourceBuildArgv = (script: string, module: SourceBuildModule): string[] => [...UNIT, script, module]

const same = (argv: readonly unknown[], expected: readonly string[]): boolean => expected.every((value, index) => argv[index] === value)
export const isSourceBuildCommand = (argv: readonly unknown[]): boolean => Array.isArray(argv) && (
  argv.length === SOURCE_BUILD_PACKAGES_ARGV.length && same(argv, SOURCE_BUILD_PACKAGES_ARGV)
  || argv.length === UNIT.length + 2 && same(argv, UNIT) && typeof argv[UNIT.length] === 'string' && SCRIPT.test(argv[UNIT.length] as string) && SOURCE_BUILD_MODULES.includes(argv[UNIT.length + 1] as SourceBuildModule))
