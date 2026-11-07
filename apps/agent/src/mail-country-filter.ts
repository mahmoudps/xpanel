import { fail } from '@xpanel/core'
import { renderMailxCountryMap } from './mailx-policy.ts'
import type { MailxFile } from './mailx-policy.ts'

/**
 * The country database, as the agent's GeoIP source provides it: `status` and the file at `path` from createGeoipSource,
 * with its exported lookupGeoipCountry and readGeoipMetadata. Null until that source is connected; a filter then refuses.
 */
export interface MailxGeoipPort {
  status: () => Promise<{ installed: boolean; month: string | null }>
  read: () => Promise<Buffer | null>
  lookup: (db: Buffer, ip: string) => string | null
  metadata: (db: Buffer) => { ipVersion: number; recordSize: number; nodeCount: number }
}

// shortcut: cidr_table(5) loads the whole table into every smtpd and scans it in order; a filter past this size is refused, move it to proxymap if operators need more.
export const MAILX_COUNTRY_MAX_NETWORKS = 200_000

const ipv4 = (bytes: Uint8Array, offset: number): string => [...bytes.subarray(offset, offset + 4)].join('.')
const ipv6 = (bytes: Uint8Array): string => Array.from({ length: 8 }, (_, index) => ((bytes[index * 2]! << 8) | bytes[index * 2 + 1]!).toString(16)).join(':')

/**
 * Walks the MaxMind DB search tree once and returns every network of the blocked countries. Each data record is resolved
 * by one lookup of an address inside it. Aliases of the IPv4 subtree (::ffff:0:0/96, 2002::/16) lead to the same node and are skipped.
 */
export function geoipCountryNetworks(db: Buffer, blocked: ReadonlySet<string>, port: Pick<MailxGeoipPort, 'lookup' | 'metadata'>): string[] {
  const { ipVersion, recordSize, nodeCount } = port.metadata(db), v6 = ipVersion === 6
  const record = (node: number, right: number): number => {
    const base = node * recordSize / 4
    if (recordSize === 24) return db.readUIntBE(base + right * 3, 3)
    if (recordSize === 32) return db.readUInt32BE(base + right * 4)
    // 28 bits: the middle byte carries the high nibble of each record.
    const middle = db[base + 3]!
    return (right ? middle & 15 : middle >> 4) * 16777216 + db.readUIntBE(base + right * 4, 3)
  }
  const bytes = new Uint8Array(v6 ? 16 : 4), countries = new Map<number, string | null>(), networks: string[] = []
  let ipv4Root = -1
  if (v6) { ipv4Root = 0; for (let bit = 0; bit < 96 && ipv4Root < nodeCount; bit++) ipv4Root = record(ipv4Root, 0) }
  const address = (depth: number): { ip: string; cidr: string } => {
    if (!v6) return { ip: ipv4(bytes, 0), cidr: `${ipv4(bytes, 0)}/${depth}` }
    const mapped = depth >= 96 && bytes.subarray(0, 12).every(byte => byte === 0)
    return mapped ? { ip: ipv4(bytes, 12), cidr: `${ipv4(bytes, 12)}/${depth - 96}` } : { ip: ipv6(bytes), cidr: `[${ipv6(bytes)}]/${depth}` }
  }
  const walk = (node: number, depth: number): void => {
    if (depth >= bytes.length * 8) return fail('PRECONDITION_FAILED', 'the country database is damaged, so nothing was changed', { stateChanged: false, reason: 'geoip_unavailable' })
    for (const side of [0, 1]) {
      const next = record(node, side), bit = 128 >> (depth & 7), index = depth >> 3
      if (side) bytes[index]! |= bit
      if (next > nodeCount) {
        const found = address(depth + 1)
        if (!countries.has(next)) countries.set(next, port.lookup(db, found.ip))
        if (blocked.has(countries.get(next) ?? '')) {
          networks.push(found.cidr)
          if (networks.length > MAILX_COUNTRY_MAX_NETWORKS) return fail('PRECONDITION_FAILED', 'the chosen countries hold more networks than a Postfix table can carry on this server, so nothing was changed', { stateChanged: false, reason: 'country_filter_too_large' })
        }
      } else if (next < nodeCount && (next !== ipv4Root || depth + 1 === 96)) walk(next, depth + 1)
      if (side) bytes[index]! &= ~bit
    }
  }
  walk(0, 0)
  return networks
}

/** The rendered table, or a stable refusal while the database is missing. */
export async function buildMailxCountryMap(geoip: MailxGeoipPort | null | undefined, blocked: readonly string[]): Promise<MailxFile> {
  const refuse = (): never => fail('PRECONDITION_FAILED', 'the country database is not installed on this server, so nothing was changed', { stateChanged: false, reason: 'geoip_unavailable' })
  if (!geoip) return refuse()
  const status = await geoip.status(), db = status.installed && status.month ? await geoip.read() : null
  if (!db || !status.month) return refuse()
  return renderMailxCountryMap(blocked, status.month, geoipCountryNetworks(db, new Set(blocked), geoip))
}
