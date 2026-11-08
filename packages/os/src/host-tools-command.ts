const SYSTEMCTL = '/usr/bin/systemctl'
const TASK_UNIT = /^xpanel-task-[a-z0-9]{12}\.service$/
const DAEMON_UNIT = /^xpanel-daemon-[a-z][a-z0-9-]{0,30}\.service$/
const FRP_UNIT = /^xpanel-frp[sc]\.service$/
const FPM_UNIT = /^xpanel-php-fpm-[a-z][a-z0-9]{0,15}-[5-9]\.[0-9]{1,2}\.service$/
const SWAP_UNIT = 'var-swapfile.swap'
export const SWAP_FILE = '/var/swapfile'
export const SWAP_UNIT_PATH = `/etc/systemd/system/${SWAP_UNIT}`
export const RAM_DISK_ROOT = '/mnt'
export const ramDiskPath = (name: string): string => `${RAM_DISK_ROOT}/ram-${name}`
const RAM_PATH = /^\/mnt\/ram-[a-z][a-z0-9]{0,30}$/
export const FRP_VERSION = '0.71.1'
/** Release digests of github.com/fatedier/frp, pinned here so a host never runs a binary nobody reviewed. */
export const FRP_DIGESTS: Readonly<Record<string, string>> = {
  x64: '1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803',
  arm64: '8edf590b0c396fa42f9c147121a76af83cfc2002b08f5aef0ea1008c43482019',
}
export const frpArchive = (arch: 'x64' | 'arm64'): { name: string; url: string } => {
  const name = `frp_${FRP_VERSION}_linux_${arch === 'x64' ? 'amd64' : 'arm64'}`
  return { name, url: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${name}.tar.gz` }
}
export const FRP_ARCHIVE_PATH = '/var/lib/xpanel/frp.tar.gz'
export const frpExtractArgv = (name: string): string[] => ['/usr/bin/tar', '--extract', '--gzip', `--file=${FRP_ARCHIVE_PATH}`, '--directory=/usr/local/bin', '--strip-components=1', '--no-same-owner', '--', `${name}/frps`, `${name}/frpc`]

export const hostTaskStartArgv = (unit: string): string[] => [SYSTEMCTL, 'start', '--no-block', unit]
export const hostUnitVerbArgv = (verb: 'start' | 'stop' | 'restart', unit: string): string[] => [SYSTEMCTL, verb, unit]
export const hostUnitShowArgv = (unit: string): string[] => [SYSTEMCTL, 'show', '--property=LoadState,ActiveState,SubState,UnitFileState,NRestarts,ExecMainStartTimestamp', unit]
export const hostUnitLogArgv = (unit: string): string[] => ['/usr/bin/journalctl', '--no-pager', '--output=short-iso', '--lines=200', `--unit=${unit}`]
export const TIMEZONE_READ_ARGV = ['/usr/bin/timedatectl', 'show', '--property=Timezone', '--value'] as const
export const timezoneSetArgv = (zone: string): string[] => ['/usr/bin/timedatectl', 'set-timezone', zone]
export const SWAP_ARGV = {
  off: ['/usr/sbin/swapoff', SWAP_FILE], remove: ['/usr/bin/rm', '--force', '--', SWAP_FILE], chmod: ['/usr/bin/chmod', '600', SWAP_FILE],
  format: ['/usr/sbin/mkswap', SWAP_FILE], on: ['/usr/sbin/swapon', SWAP_FILE], reload: [SYSTEMCTL, 'daemon-reload'], enable: [SYSTEMCTL, 'enable', SWAP_UNIT], disable: [SYSTEMCTL, 'disable', SWAP_UNIT], removeUnit: ['/usr/bin/rm', '--force', '--', SWAP_UNIT_PATH],
} as const
export const swapAllocateArgv = (sizeMb: number): string[] => ['/usr/bin/fallocate', '--length', `${sizeMb}MiB`, SWAP_FILE]
export const ramDiskArgv = {
  dir: (path: string): string[] => ['/usr/bin/mkdir', '--parents', path],
  mount: (path: string, sizeMb: number): string[] => ['/usr/bin/mount', '-t', 'tmpfs', '-o', `size=${sizeMb}m,mode=0755,nosuid,nodev`, 'tmpfs', path],
  unmount: (path: string): string[] => ['/usr/bin/umount', path],
}
export const hostsLookupArgv = (name: string): string[] => ['/usr/bin/getent', 'hosts', name]

const same = (argv: readonly unknown[], expected: readonly string[]): boolean => argv.length === expected.length && expected.every((value, index) => value === argv[index])

/** Reviewed grammar of the host tools: fixed binaries and flags, and units only from the product's own name families. */
export function isHostToolsCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(item => typeof item !== 'string')) return false
  const items = argv as string[], unit = items.at(-1) ?? ''
  if (same(items, hostTaskStartArgv(unit)) && TASK_UNIT.test(unit)) return true
  if ((['start', 'stop', 'restart'] as const).some(verb => same(items, hostUnitVerbArgv(verb, unit))) && (DAEMON_UNIT.test(unit) || FRP_UNIT.test(unit))) return true
  if (same(items, hostUnitVerbArgv('restart', unit)) && FPM_UNIT.test(unit)) return true
  if (same(items, hostUnitShowArgv(unit)) && (DAEMON_UNIT.test(unit) || FRP_UNIT.test(unit))) return true
  if (same(items, hostUnitLogArgv(unit.replace('--unit=', ''))) && (DAEMON_UNIT.test(unit.slice(7)) || FRP_UNIT.test(unit.slice(7)))) return true
  if (same(items, TIMEZONE_READ_ARGV)) return true
  if (items.length === 3 && items[0] === '/usr/bin/timedatectl' && items[1] === 'set-timezone' && /^[A-Za-z0-9_+/-]{1,64}$/.test(unit)) return true
  if (Object.values(SWAP_ARGV).some(known => same(items, known))) return true
  if (items.length === 4 && items[0] === '/usr/bin/fallocate' && items[1] === '--length' && /^[1-9][0-9]{0,4}MiB$/.test(items[2]!) && unit === SWAP_FILE) return true
  if (RAM_PATH.test(unit) && (same(items, ramDiskArgv.dir(unit)) || same(items, ramDiskArgv.unmount(unit)))) return true
  if (RAM_PATH.test(unit) && items.length === 7 && same(items, ramDiskArgv.mount(unit, Number(/^size=([1-9][0-9]{0,4})m,/.exec(items[4] ?? '')?.[1])))) return true
  if (items.length === 3 && items[0] === '/usr/bin/getent' && items[1] === 'hosts' && /^[a-z0-9.-]{1,253}$/.test(unit)) return true
  return /^frp_[0-9.]+_linux_(?:amd64|arm64)\/frpc$/.test(unit) && same(items, frpExtractArgv(unit.slice(0, -'/frpc'.length)))
}
