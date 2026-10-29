import { BlockList, isIP } from 'node:net'
import { fail } from '@xpanel/core'

/** Reviewed read-only network diagnostics. The target is always a checked public IP literal, never a name or an option. */
// iputils ping(8): -n numeric output, -c 4 probes, -W 2 s per reply, -w 10 s overall deadline. LC_ALL=C keeps the summary untranslated.
export const PING_ARGV_PREFIX = ['/usr/bin/env', 'LC_ALL=C', '/usr/bin/ping', '-n', '-c', '4', '-W', '2', '-w', '10'] as const
// traceroute(8): -n numeric, -q 1 probe per hop, -w 2 s wait, -m 20 hops. Probes go out in parallel (-N 16 default), so the run stays
// within a few seconds; tracepath(8) waits about 3 s per silent hop and has no deadline, which can exceed the agent transport timeout.
export const TRACEROUTE_ARGV_PREFIX = ['/usr/bin/env', 'LC_ALL=C', '/usr/bin/traceroute', '-n', '-q', '1', '-w', '2', '-m', '20'] as const
export const TRACEROUTE_MAX_HOPS = 20

/** Not globally reachable or embedding another address (RFC 6890 special-purpose registries, plus multicast and reserved). */
const NON_PUBLIC: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]
const nonPublic = new BlockList()
for (const [network, prefix] of NON_PUBLIC) nonPublic.addSubnet(network, prefix, network.includes(':') ? 'ipv6' : 'ipv4')

/** Canonical plain IPv4/IPv6 literal (no zone id, no brackets), or null. */
export function canonicalIp(value: unknown): { address: string; family: 4 | 6 } | null {
  if (typeof value !== 'string' || value.length > 45 || value.includes('%')) return null
  const family = isIP(value)
  if (family === 4) return { address: value, family }
  return family === 6 ? { address: new URL('http://[' + value + ']').hostname.slice(1, -1), family } : null
}

/** A canonical literal outside every loopback, private, link-local, shared, metadata, multicast and reserved range. */
export function isPublicAddress(value: unknown): value is string {
  const ip = canonicalIp(value)
  // A ::ffff:0:0/96 rule would make BlockList refuse every IPv4 address, so IPv4-mapped literals are refused by prefix.
  return ip !== null && ip.address === value && !ip.address.startsWith('::ffff:') && !nonPublic.check(ip.address, ip.family === 4 ? 'ipv4' : 'ipv6')
}

const target = (address: string): string => isPublicAddress(address) ? address : fail('VALIDATION', 'the diagnostic target is not a public address', { stateChanged: false })
export const pingArgv = (address: string): string[] => [...PING_ARGV_PREFIX, target(address)]
export const tracerouteArgv = (address: string): string[] => [...TRACEROUTE_ARGV_PREFIX, target(address)]

export function isNetworkToolsCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  const prefixed = (prefix: readonly string[]): boolean => argv.length === prefix.length + 1 && prefix.every((value, index) => value === argv[index])
  return (prefixed(PING_ARGV_PREFIX) || prefixed(TRACEROUTE_ARGV_PREFIX)) && isPublicAddress(argv.at(-1))
}
