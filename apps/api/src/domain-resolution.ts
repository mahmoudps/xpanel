import { resolve4, resolve6, resolveNs } from 'node:dns/promises'
import { cidrContains, parseCidr, parseIp } from '@xpanel/core'
import { readRemoteServiceIps } from '../../agent/src/remote-service-ips.ts'

export interface DomainResolutionOptions {
  /** State root directory containing `extended/server/remote-service-ips.json`. */
  rootDir?: string
  /** Explicit remote nameserver IP/CIDR allowlist; overrides reading `rootDir` when provided. */
  remoteNameserverIps?: readonly string[]
  resolveNs?: (name: string) => Promise<string[]>
  resolveNs4?: (host: string) => Promise<string[]>
  resolveNs6?: (host: string) => Promise<string[]>
}

const matchesRemoteIp = (address: string, allowed: readonly string[]): boolean => {
  const ip = parseIp(address.trim())
  if (!ip) return false
  for (const entry of allowed) {
    const cidr = parseCidr(entry)
    if (cidr && cidrContains(cidr, ip)) return true
  }
  return false
}

const hasAllowedRemoteNameserver = async (name: string, options: DomainResolutionOptions): Promise<boolean> => {
  let allowed = options.remoteNameserverIps
  if (allowed === undefined && options.rootDir) {
    try {
      allowed = (await readRemoteServiceIps(options.rootDir))?.nameservers ?? []
    } catch {
      return false
    }
  }
  if (!allowed || allowed.length === 0) return false
  const lookupNs = options.resolveNs ?? resolveNs
  const lookup4 = options.resolveNs4 ?? resolve4
  const lookup6 = options.resolveNs6 ?? resolve6
  let nsHosts: string[]
  try {
    nsHosts = await lookupNs(name)
  } catch {
    return false
  }
  for (const host of nsHosts) {
    const cleanHost = host.trim().replace(/\.$/, '')
    if (!cleanHost) continue
    const [v4, v6] = await Promise.all([
      lookup4(cleanHost).catch(() => [] as string[]),
      lookup6(cleanHost).catch(() => [] as string[]),
    ])
    if ([...v4, ...v6].some(addr => matchesRemoteIp(addr, allowed!))) return true
  }
  return false
}

/** Where a new domain points now. A resolver that cannot answer proves nothing, so it never refuses a domain. */
export async function observeDomainResolution(
  name: string,
  localAddresses: readonly string[],
  resolve: (name: string) => Promise<string[]> = resolve4,
  options: DomainResolutionOptions = {},
): Promise<'here' | 'elsewhere' | 'unregistered' | 'unknown'> {
  try {
    const addresses = await resolve(name)
    if (addresses.some(address => localAddresses.includes(address))) return 'here'
    return (await hasAllowedRemoteNameserver(name, options)) ? 'here' : 'elsewhere'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (code === 'ENODATA' && (await hasAllowedRemoteNameserver(name, options))) return 'here'
    return ['ENOTFOUND', 'ENODATA'].includes(code) ? 'unregistered' : 'unknown'
  }
}
