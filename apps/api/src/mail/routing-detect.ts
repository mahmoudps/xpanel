import type { MailxRoutingMode } from '../../../agent/src/mailx-policy.ts'

interface ZoneRecord { name: string; type: string; content: string; priority?: number | null }
export interface MailRoutingZone { name: string; records: readonly ZoneRecord[] }
export interface MailRoutingDetection { mode: MailxRoutingMode | null; mx: { priority: number | null; host: string }[] }

const bare = (name: string): string => name.toLowerCase().replace(/\.$/, '')
/** The owner label of `domain` inside `zone`: `@` at the apex. */
const relativeTo = (domain: string, zone: string): string | null => {
  const name = bare(domain), apex = bare(zone)
  return name === apex ? '@' : name.endsWith('.' + apex) ? name.slice(0, -(apex.length + 1)) : null
}

/**
 * cPanel "Automatically Detect Configuration", from the saved zone only and never from live DNS: the lowest MX on a server
 * address is local, a lower-ranked MX on one is backup, no MX here is remote. Without an MX record there is nothing to detect.
 */
export function detectMailRouting(domain: string, zone: MailRoutingZone | null | undefined, hostname: string | null, serverAddresses: readonly string[]): MailRoutingDetection {
  const owner = zone ? relativeTo(domain, zone.name) : null
  if (!zone || owner === null) return { mode: null, mx: [] }
  const mx = zone.records.filter(record => record.type === 'MX' && bare(record.name) === owner).slice(0, 20).map(record => ({ priority: record.priority ?? null, host: bare(record.content).slice(0, 255) }))
  if (!mx.length) return { mode: null, mx }
  const here = (host: string): boolean => {
    if (hostname && host === bare(hostname)) return true
    const label = relativeTo(host, zone.name)
    return label !== null && zone.records.some(record => (record.type === 'A' || record.type === 'AAAA') && bare(record.name) === label && serverAddresses.includes(record.content.toLowerCase()))
  }
  const ordered = [...mx].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  return { mode: here(ordered[0]!.host) ? 'local' : ordered.some(item => here(item.host)) ? 'backup' : 'remote', mx }
}
