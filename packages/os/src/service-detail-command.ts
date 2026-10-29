/** Reviewed read-only PowerDNS grammar. No reload, zone mutation, socket path or config directory is admitted. */
export const PDNS_CONTROL = '/usr/bin/pdns_control'
export const PDNSUTIL = '/usr/bin/pdnsutil'
// pdns_control(1): rping checks that the server is alive; version returns the running daemon version.
export const PDNS_RPING_ARGV = [PDNS_CONTROL, 'rping'] as const
export const PDNS_VERSION_ARGV = [PDNS_CONTROL, 'version'] as const
const ZONE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Lowercase ASCII (punycode) zone names only; never an option, path or trailing dot. */
export const isServiceDetailZone = (value: unknown): value is string => typeof value === 'string' && ZONE.test(value)

// pdnsutil(1): check-zone ZONE checks the zone for correctness and changes nothing.
export function pdnsCheckZoneArgv(zone: string): string[] {
  if (!isServiceDetailZone(zone)) throw new Error('unsupported_zone')
  return [PDNSUTIL, 'check-zone', zone]
}

export function isServiceDetailCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  if (argv.length === 2) return argv[0] === PDNS_CONTROL && (argv[1] === 'rping' || argv[1] === 'version')
  return argv.length === 3 && argv[0] === PDNSUTIL && argv[1] === 'check-zone' && isServiceDetailZone(argv[2])
}
