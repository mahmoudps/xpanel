export const BENCHMARK_DIRECTORY = '/var/lib/xpanel-agent/benchmarks'
export const BENCHMARK_FILE = BENCHMARK_DIRECTORY + '/sample.bin'
export const BENCHMARK_BYTES = 64 * 1024 * 1024
export const BENCHMARK_KIND = 'system.monitoring.benchmark'
const low = ['/usr/bin/nice', '-n', '19', '/usr/bin/ionice', '-c', '3'] as const
/** OpenSSL speed(1): one SHA-256 block size and elapsed wall time; GNU dd(1): direct IO and fdatasync; ionice(1) class 3. */
export const benchmarkCommands = () => ({
  cpu: [...low, '/usr/bin/openssl', 'speed', '-elapsed', '-seconds', '5', '-bytes', '16384', '-evp', 'sha256', '-mr'],
  write: [...low, '/usr/bin/dd', 'if=/dev/zero', 'of=' + BENCHMARK_FILE, 'bs=1M', 'count=64', 'oflag=direct,nofollow', 'conv=excl,fdatasync'],
  read: [...low, '/usr/bin/dd', 'if=' + BENCHMARK_FILE, 'of=/dev/null', 'bs=1M', 'count=64', 'iflag=direct,nofollow'],
  cleanup: ['/usr/bin/rm', '-f', '--', BENCHMARK_FILE],
})
export const isBenchmarkCommand = (argv: readonly string[]): boolean => Object.values(benchmarkCommands()).some(expected => expected.length === argv.length && expected.every((v, index) => v === argv[index]))

// OpenSSL apps/speed.c emits +F:<index>:<name>:<bytes/second> for -mr with one -bytes size.
export function parseBenchmarkCpu(output: string): number | null {
  const rows = output.split(/\r?\n/).filter(line => line.startsWith('+F:'))
  if (rows.length !== 1) return null
  const match = /^\+F:[0-9]+:sha256:([0-9]+(?:\.[0-9]+)?)$/i.exec(rows[0]!)
  const value = match ? Number(match[1]) : NaN
  return Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? Math.round(value) : null
}
// GNU dd(1), LC_ALL=C: final transfer statistics; require the complete 64 MiB transfer rather than a partial result.
export function parseBenchmarkDisk(output: string): number | null {
  const matches = [...output.matchAll(/^([0-9]+) bytes(?: \([^\r\n]+\))? copied, ([0-9]+(?:\.[0-9]+)?) s, [^\r\n]+$/gm)]
  if (matches.length !== 1 || Number(matches[0]![1]) !== BENCHMARK_BYTES) return null
  const seconds = Number(matches[0]![2]), value = BENCHMARK_BYTES / seconds
  return seconds > 0 && Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER ? Math.round(value) : null
}
