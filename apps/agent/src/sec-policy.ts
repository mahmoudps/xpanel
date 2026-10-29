import { createHash } from 'node:crypto'
import { cidrContains, fail, formatCidr, parseCidr, parseIp, validateDomainName } from '@xpanel/core'

/** Desired-state files under the StateStore root. The API writes them; the agent and reconciler only read them. */
export const SEC_WAF_STATE = 'extended/server/sec-waf.json'
export const SEC_WAF_SITES_STATE = 'extended/server/sec-waf-sites.json'
export const SEC_FLOOD_STATE = 'extended/server/sec-flood.json'
export const SEC_PANEL_ACCESS_STATE = 'extended/server/sec-panel-access.json'
export const SEC_DNS_CLUSTER_STATE = 'extended/dns/sec-cluster.json'
export const SEC_LISTENERS = ['xpanel', 'xwhm', 'xmail'] as const
export type SecListener = typeof SEC_LISTENERS[number]
export const SEC_LISTENER_PORTS: Readonly<Record<SecListener, number>> = { xpanel: 2083, xwhm: 2087, xmail: 2096 }

export interface SecWafPolicy {
  /** null = no per-address request limit */
  requestsPerSecond: number | null
  burst: number | null
  /** null = unlimited body */
  maxBodyMb: number | null
  deniedResponse: 403 | 444
  denyIps: string[]
  denyPaths: string[]
  denyUserAgents: string[]
  /** honoured only when the ModSecurity connector for the installed web server is present */
  modsecurity: boolean
}
export interface SecFloodPolicy {
  enabled: boolean
  connectionsPerAddress: number | null
  newConnectionsPerSecond: number | null
  newConnectionsBurst: number | null
  pingPerSecond: number | null
  webConnectionsPerAddress: number | null
}
export interface SecAccessEntry { cidr: string; note: string }
export interface SecPanelAccessPolicy { listeners: Record<SecListener, SecAccessEntry[]> }
export interface SecDnsPeer { name: string; address: string }
export interface SecDnsClusterConfig { peers: SecDnsPeer[] }
export interface SecWafSites { sites: Record<string, { accountId: string; modsecurity: boolean }> }
export interface SecRecord<T> { version: 1; policy: T; updatedAt: string }
export type SecKind = 'waf' | 'flood' | 'panel-access' | 'dns-cluster' | 'waf-sites'

export const SEC_DEFAULTS: { waf: SecWafPolicy; flood: SecFloodPolicy; 'panel-access': SecPanelAccessPolicy; 'dns-cluster': SecDnsClusterConfig; 'waf-sites': SecWafSites } = {
  waf: { requestsPerSecond: null, burst: null, maxBodyMb: 128, deniedResponse: 403, denyIps: [], denyPaths: [], denyUserAgents: [], modsecurity: true },
  flood: { enabled: false, connectionsPerAddress: null, newConnectionsPerSecond: null, newConnectionsBurst: null, pingPerSecond: null, webConnectionsPerAddress: null },
  'panel-access': { listeners: { xpanel: [], xwhm: [], xmail: [] } },
  'dns-cluster': { peers: [] },
  'waf-sites': { sites: {} },
}
export const SEC_STATE_PATHS: Readonly<Record<SecKind, string>> = { waf: SEC_WAF_STATE, flood: SEC_FLOOD_STATE, 'panel-access': SEC_PANEL_ACCESS_STATE, 'dns-cluster': SEC_DNS_CLUSTER_STATE, 'waf-sites': SEC_WAF_SITES_STATE }

const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean => Object.keys(value).sort().join() === [...expected].sort().join()
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const int = (value: unknown, min: number, max: number, what: string): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid(`${what} must be a whole number from ${min} to ${max}`)
const limit = (value: unknown, min: number, max: number, what: string): number | null => value === null ? null : int(value, min, max, what)
const list = (value: unknown, max: number, what: string): unknown[] => Array.isArray(value) && value.length <= max ? value : invalid(`${what} must be a list of at most ${max} entries`)
const distinct = <T>(items: T[], what: string): T[] => new Set(items.map(item => JSON.stringify(item))).size === items.length ? items : invalid(`${what} entries must be distinct`)

/** One canonical address or network (host bits zero, no leading zeros); a single host is written without a prefix. */
export function canonicalNetwork(value: unknown, what: string): string {
  const parsed = typeof value === 'string' && value.length <= 49 && value.trim() === value ? parseCidr(value) : null
  if (!parsed || formatCidr(parsed) !== value) return invalid(`${what} must be a canonical IP address or network`)
  return value
}
// nginx compiles these with PCRE when the configuration is tested; here only size and characters are bounded.
const pattern = (value: unknown, what: string): string => typeof value === 'string' && value.length >= 1 && value.length <= 256 && !UNSAFE.test(value) && !/[\s"'`;{}\\]$/.test(value) && !/["'`;{}]/.test(value) ? value : invalid(`${what} must be one pattern of 1 to 256 characters without quotes, braces or semicolons`)

export function parseSecWafPolicy(value: unknown): SecWafPolicy {
  if (!object(value) || !keys(value, ['requestsPerSecond', 'burst', 'maxBodyMb', 'deniedResponse', 'denyIps', 'denyPaths', 'denyUserAgents', 'modsecurity'])) return invalid('WAF policy fields are incomplete or unknown')
  const requestsPerSecond = limit(value.requestsPerSecond, 1, 10000, 'requests per address')
  const burst = requestsPerSecond === null ? (value.burst === null ? null : invalid('burst requires a request limit')) : int(value.burst, 0, 100000, 'burst')
  if (value.deniedResponse !== 403 && value.deniedResponse !== 444) return invalid('the denied response must be 403 or 444')
  if (typeof value.modsecurity !== 'boolean') return invalid('modsecurity must be true or false')
  return {
    requestsPerSecond, burst, maxBodyMb: limit(value.maxBodyMb, 1, 102400, 'largest request body (MB)'), deniedResponse: value.deniedResponse,
    denyIps: distinct(list(value.denyIps, 1000, 'denied addresses').map(item => canonicalNetwork(item, 'a denied address')), 'denied address'),
    denyPaths: distinct(list(value.denyPaths, 100, 'path patterns').map(item => pattern(item, 'a path pattern')), 'path pattern'),
    denyUserAgents: distinct(list(value.denyUserAgents, 100, 'user-agent patterns').map(item => pattern(item, 'a user-agent pattern')), 'user-agent pattern'),
    modsecurity: value.modsecurity,
  }
}

export function parseSecFloodPolicy(value: unknown): SecFloodPolicy {
  if (!object(value) || !keys(value, ['enabled', 'connectionsPerAddress', 'newConnectionsPerSecond', 'newConnectionsBurst', 'pingPerSecond', 'webConnectionsPerAddress']) || typeof value.enabled !== 'boolean') return invalid('flood policy fields are incomplete or unknown')
  const newConnectionsPerSecond = limit(value.newConnectionsPerSecond, 1, 100000, 'new connections per second')
  const newConnectionsBurst = newConnectionsPerSecond === null ? (value.newConnectionsBurst === null ? null : invalid('a burst requires a new-connection rate')) : int(value.newConnectionsBurst, 1, 100000, 'new-connection burst')
  return { enabled: value.enabled, connectionsPerAddress: limit(value.connectionsPerAddress, 1, 100000, 'connections per address'), newConnectionsPerSecond, newConnectionsBurst,
    pingPerSecond: limit(value.pingPerSecond, 1, 10000, 'ping requests per second'), webConnectionsPerAddress: limit(value.webConnectionsPerAddress, 1, 100000, 'web server connections per address') }
}

export function parseSecPanelAccessPolicy(value: unknown): SecPanelAccessPolicy {
  if (!object(value) || !keys(value, ['listeners']) || !object(value.listeners) || !keys(value.listeners, SEC_LISTENERS)) return invalid('panel access needs exactly the xpanel, xwhm and xmail lists')
  const listeners = {} as Record<SecListener, SecAccessEntry[]>
  for (const name of SEC_LISTENERS) {
    listeners[name] = distinct(list(value.listeners[name], 256, `${name} allowlist`).map(entry => {
      if (!object(entry) || !keys(entry, ['cidr', 'note']) || typeof entry.note !== 'string' || entry.note.length > 64 || UNSAFE.test(entry.note) || entry.note.trim() !== entry.note) return invalid('each allowlist entry needs a network and a note of at most 64 characters')
      const parsed = parseCidr(canonicalNetwork(entry.cidr, 'an allowlist entry'))!
      if (parsed.prefix < (parsed.version === 4 ? 8 : 16)) return invalid('allowlist networks must be at least /8 (IPv4) or /16 (IPv6)')
      return { cidr: entry.cidr as string, note: entry.note }
    }), `${name} allowlist`)
    if (new Set(listeners[name].map(entry => entry.cidr)).size !== listeners[name].length) return invalid('allowlist networks must be distinct')
  }
  return { listeners }
}
/** Empty list = open listener. Otherwise the client must fall inside one listed network. */
export function secPanelAccessAdmits(policy: SecPanelAccessPolicy, listener: SecListener, client: string | null): boolean {
  const entries = policy.listeners[listener]
  if (!entries.length) return true
  const ip = client === null ? null : parseIp(client)
  return !!ip && entries.some(entry => cidrContains(parseCidr(entry.cidr)!, ip))
}

const LOOPBACK_OR_SPECIAL = ['0.0.0.0/8', '127.0.0.0/8', '224.0.0.0/4', '240.0.0.0/4', '::/128', '::1/128', 'ff00::/8'].map(net => parseCidr(net)!)
export function parseSecDnsClusterConfig(value: unknown): SecDnsClusterConfig {
  if (!object(value) || !keys(value, ['peers'])) return invalid('the DNS cluster needs exactly a peer list')
  const peers = list(value.peers, 16, 'DNS cluster peers').map(peer => {
    if (!object(peer) || !keys(peer, ['name', 'address'])) return invalid('each peer needs a name and an address')
    let name: string
    try { name = validateDomainName(peer.name) } catch { return invalid('the peer name must be a fully qualified host name') }
    if (name !== peer.name) return invalid('the peer name must be written in canonical lowercase form')
    const ip = typeof peer.address === 'string' ? parseIp(peer.address) : null
    if (!ip || peer.address !== formatCidr({ ...ip, prefix: ip.version === 4 ? 32 : 128 }) || LOOPBACK_OR_SPECIAL.some(net => cidrContains(net, ip))) return invalid('the peer address must be one canonical unicast IP address')
    return { name, address: peer.address as string }
  })
  if (new Set(peers.map(peer => peer.name)).size !== peers.length || new Set(peers.map(peer => peer.address)).size !== peers.length) return invalid('peer names and addresses must be distinct')
  return { peers }
}

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export function parseSecWafSites(value: unknown): SecWafSites {
  if (!object(value) || !keys(value, ['sites']) || !object(value.sites) || Object.keys(value.sites).length > 10000) return invalid('site WAF switches are invalid')
  const sites: SecWafSites['sites'] = {}
  for (const [domain, entry] of Object.entries(value.sites)) {
    let name: string
    try { name = validateDomainName(domain) } catch { return invalid('site WAF switches name an invalid domain') }
    if (name !== domain || !object(entry) || !keys(entry, ['accountId', 'modsecurity']) || typeof entry.accountId !== 'string' || !ACCOUNT_ID.test(entry.accountId) || typeof entry.modsecurity !== 'boolean') return invalid('site WAF switches are invalid')
    sites[domain] = { accountId: entry.accountId, modsecurity: entry.modsecurity }
  }
  return { sites }
}

const PARSERS: Readonly<Record<SecKind, (value: unknown) => unknown>> = { waf: parseSecWafPolicy, flood: parseSecFloodPolicy, 'panel-access': parseSecPanelAccessPolicy, 'dns-cluster': parseSecDnsClusterConfig, 'waf-sites': parseSecWafSites }
export const parseSecPolicy = <K extends SecKind>(kind: K, value: unknown): typeof SEC_DEFAULTS[K] => PARSERS[kind](value) as typeof SEC_DEFAULTS[K]
/** A saved record is accepted only when it round-trips exactly through its grammar. */
export function readSecRecord<K extends SecKind>(kind: K, value: unknown): SecRecord<typeof SEC_DEFAULTS[K]> | null {
  try {
    if (!object(value) || !keys(value, ['version', 'policy', 'updatedAt']) || value.version !== 1 || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString() !== value.updatedAt) return null
    const policy = parseSecPolicy(kind, value.policy)
    return JSON.stringify(policy) === JSON.stringify(value.policy) ? { version: 1, policy, updatedAt: value.updatedAt } : null
  } catch { return null }
}
/** Absent file = defaults; an unreadable or non-canonical file is refused, never silently replaced. */
export function effectiveSecPolicy<K extends SecKind>(kind: K, raw: unknown): typeof SEC_DEFAULTS[K] {
  if (raw === null) return structuredClone(SEC_DEFAULTS[kind])
  return readSecRecord(kind, raw)?.policy ?? fail('PRECONDITION_FAILED', `saved ${kind} configuration is invalid; review it before reconciliation`, unchanged)
}
export const secRevision = (kind: SecKind, raw: unknown): string => createHash('sha256').update(JSON.stringify({ namespace: 'sec:' + kind + ':v1', raw })).digest('hex')
