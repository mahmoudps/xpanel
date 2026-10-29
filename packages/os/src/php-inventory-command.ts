/** Reviewed read-only command grammar. Provisioning support alone does not admit a new binary. */
const probeVersion = /^(?:7\.4|8\.[0-4])$/
export const PHP_DPKG_QUERY_ARGV = ['/usr/bin/dpkg-query', '-W', '-f=${Package}\t${Version}\t${Status}\n'] as const
export const PHP_RPM_QUERY_ARGV = ['/usr/bin/rpm', '-qa', '--qf', '%{NAME}\t%{VERSION}-%{RELEASE}\tinstalled\n'] as const
export const PHP_BINARY_PROBE = 'echo json_encode(["version"=>PHP_VERSION,"sapi"=>PHP_SAPI,"builtInExtensions"=>get_loaded_extensions()],JSON_THROW_ON_ERROR);'
export const isPhpInventoryProbeVersion = (version: unknown): version is string => typeof version === 'string' && probeVersion.test(version)

export function phpBinaryProbeArgv(version: string, source: 'dpkg' | 'rpm', systemPackage = false): string[] {
  if (!isPhpInventoryProbeVersion(version)) throw new Error('unsupported_php_probe_version')
  const binary = systemPackage ? '/usr/bin/php' : source === 'dpkg' ? '/usr/bin/php' + version : '/opt/remi/php' + version.replace('.', '') + '/root/usr/bin/php'
  return [binary, '-n', '-r', PHP_BINARY_PROBE]
}

export function isPhpInventoryCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  const exact = (allowed: readonly string[]): boolean => allowed.length === argv.length && allowed.every((value, index) => value === argv[index])
  if (exact(PHP_DPKG_QUERY_ARGV) || exact(PHP_RPM_QUERY_ARGV)) return true
  if (argv.length !== 4 || argv[1] !== '-n' || argv[2] !== '-r' || argv[3] !== PHP_BINARY_PROBE) return false
  if (argv[0] === '/usr/bin/php') return true
  const versioned = /^\/usr\/bin\/php([0-9]+\.[0-9]+)$/.exec(argv[0] as string)
  const remi = /^\/opt\/remi\/php([0-9])([0-9]{1,2})\/root\/usr\/bin\/php$/.exec(argv[0] as string)
  return isPhpInventoryProbeVersion(versioned?.[1] ?? (remi ? remi[1] + '.' + remi[2] : ''))
}
