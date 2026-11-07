// nftables ruleset for the whole host, owned as a single table: `table inet xpanel`.
//
// The operator's rule list is the policy, read exactly as core's evaluateFirewall() reads it: forwards
// are DNAT in prerouting, every other enabled rule is matched top-down, first match wins, and the input
// policy is drop. Management HTTPS, 80, 443 and SSH open because defaultFirewallRules() seeds the list
// with accepts for them, so disabling `default-ssh` really closes SSH and the firewall page shows what
// the kernel does. In front of the list the renderer adds only the base chain: loopback, invalid state,
// the brute-force ban sets, established traffic, the backend guard (Apache/OLS ports on lo only) and
// the ICMP/ICMPv6 messages IP cannot work without.
//
// Only our table is replaced (`table` + `delete table` + definition in one atomic `nft -f`), so tables
// of other tools survive. firewalld/ufw must be disabled by the installer: their base chains would
// still drop what ours accepts.

import {
  fail,
  MAX_ACCOUNT_UID,
  MIN_ACCOUNT_UID,
  MANAGEMENT_PUBLIC_PORTS,
  MANAGEMENT_BACKEND_PORTS,
  formatCidr,
  parseCidr,
  parseForwardTarget,
  parseIp,
  parsePortSpec,
  validateFirewallRules,
  validatePrefixList,
} from '@xpanel/core'
import type { Cidr, ConfigTest, FirewallRule, HostAction, IpAddress, OsProfile, PortRange, RenderedFile, ServerSettings } from '@xpanel/core'
import { formatIp, isLoopback, isLoopbackCidr, type IpFamily } from './ip.ts'
import { assertAbsPath, assertInt, assertPort, invalid } from './validate.ts'

export const NFT_BINARY = '/usr/sbin/nft'
export const SYSCTL_BINARY = '/usr/sbin/sysctl'
export const NFT_TABLE = 'xpanel'
export const BAN_SET_V4 = 'xpanel_banned'
export const BAN_SET_V6 = 'xpanel_banned6'
export const BAN_SET_SIZE = 65536
export const MAX_PREFIX_LISTS = 256
export const MAX_PREFIX_ENTRIES = 1048576
export const DEFAULT_WEB_PORTS: readonly number[] = [80, 443]
export const FORWARDING_SYSCTL_PATH = '/etc/sysctl.d/90-xpanel-forward.conf'
/** Sets owned by the remote-database provider; packages/os db-remote-command.ts uses the same names (render cannot import os). */
export const DB_REMOTE_SET_V4 = 'xpanel_dbremote4'
export const DB_REMOTE_SET_V6 = 'xpanel_dbremote6'

export interface FirewallBan {
  ip: string
  /** epoch seconds */
  expiresAt: number
}

export interface NftSettings {
  panelPort: number
  /** Active HTTPS management entry points; legacy direct callers may omit this collection. */
  managementPorts?: readonly number[]
  sshPort: number
  /** loopback-only ports of Apache/OLS behind Nginx */
  backendPorts: number[]
  /** ports Nginx serves; a forward may never take them over */
  webPorts?: number[]
  /** admin-uploaded prefix lists referenced by `prefix-list` rules */
  prefixLists?: Record<string, string[]>
  /** default lifetime of a ban set entry */
  banTimeoutSec: number
  /** active bans kept in the control DB, re-added on every render so a reload never unbans */
  bans?: FirewallBan[]
  /** epoch seconds; required when `bans` is not empty */
  now?: number
  forwardPolicy?: 'drop' | 'accept'
  /** Union of active accounts' remote-database sources (canonical CIDRs); opens TCP/3306 only. */
  databaseRemoteSources?: readonly string[]
  /** pure-ftpd's passive data ports; absent while FTP is disabled or not installed */
  ftpPassivePorts?: { min: number; max: number }
  /** the frp service port and tunnel range; absent while the frp server is off */
  frpPorts?: { bindPort: number; portMin: number; portMax: number }
  /** phpMyAdmin Access: nginx answers here, with 403 while public access is off */
  webClientPorts?: readonly number[]
  /** clients of the applied NFS exports: IPv4 addresses or CIDRs, or `*`; absent or empty keeps TCP/2049 closed */
  nfsClients?: readonly string[]
  /** per-source limits on the web ports and a global ping limit; absent or null renders no flood rules */
  flood?: NftFloodSettings | null
  /** Outbound SMTP Restrictions: hosting accounts reach remote SMTP only through the local MTA */
  smtpRestricted?: boolean
  /** false leaves the operator's list out and accepts what no guard refuses; absent means on */
  enabled?: boolean
  /** the server ignores ping from every address, whatever the list says */
  blockPing?: boolean
  /** Private TCP ports of Go and Java apps; `open` also accepts the port from outside */
  appPorts?: readonly { port: number; uid: number; open: boolean }[]
}

export interface NftContainerLoopback { port: number; protocol: 'tcp' | 'udp'; uid: number }

export interface NftFloodSettings {
  /** concurrent connections per source address (nft ct count) */
  connectionsPerAddress: number | null
  /** new connections per second per source address, with a packet burst */
  newPerSecond: number | null
  newBurst: number | null
  /** ICMP/ICMPv6 echo requests per second, all sources together */
  pingPerSecond: number | null
}
export const FLOOD_SETS = { conn4: 'xpanel_flood_conn4', conn6: 'xpanel_flood_conn6', rate4: 'xpanel_flood_rate4', rate6: 'xpanel_flood_rate6' } as const
export const FLOOD_COMMENT_PREFIX = 'xpanel-flood:'
export const SMTP_RESTRICTION_COMMENT = 'xpanel-smtp-restriction'
export const CONTAINER_LOOPBACK_COMMENT = 'xpanel-container-loopback'
export const SMTP_RESTRICTED_PORTS: readonly number[] = [25, 465, 587]

type Proto = 'tcp' | 'udp'

interface NormalRule {
  rule: FirewallRule
  protocols: Proto[] | null
  ports: PortRange | null
  source: Cidr | null
  forward: { ip: IpAddress; port: number } | null
}

interface PrefixSets {
  v4: Cidr[]
  v6: Cidr[]
}

interface NormalSettings {
  nfsClients: readonly string[]
  ftpPassivePorts?: { min: number; max: number }
  frpPorts?: { bindPort: number; portMin: number; portMax: number }
  webClientPorts: number[]
  panelPort: number
  managementPorts: number[]
  sshPort: number
  backendPorts: number[]
  webPorts: number[]
  lists: Map<string, PrefixSets>
  databaseRemote: PrefixSets
  banTimeoutSec: number
  bans: { ip: IpAddress; remaining: number }[]
  forwardPolicy: 'drop' | 'accept'
  flood: NftFloodSettings | null
  smtpRestricted: boolean
  appPorts: NftSettings['appPorts']
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

const covers = (r: PortRange, port: number): boolean => port >= r.from && port <= r.to

const overlaps = (r: PortRange, ports: readonly number[]): boolean => ports.some((p) => covers(r, p))

/** Core validates the shape (and rejects comments nft could misread); this adds the parsed fields. */
const parseRules = (rules: unknown): NormalRule[] =>
  validateFirewallRules(rules).map((rule) => ({
    rule,
    protocols: rule.protocol === null ? null : rule.protocol === 'both' ? ['tcp', 'udp'] : [rule.protocol],
    ports: rule.port === null ? null : parsePortSpec(rule.port),
    source: rule.source === null ? null : parseCidr(rule.source),
    forward: rule.forwardTo === null ? null : parseForwardTarget(rule.forwardTo),
  }))

const normalizeLists = (input: unknown): Map<string, PrefixSets> => {
  const out = new Map<string, PrefixSets>()
  if (input === undefined) return out
  if (!isPlainObject(input)) return invalid('prefixLists must be an object of name -> CIDR list')
  const names = Object.keys(input)
  if (names.length > MAX_PREFIX_LISTS) return invalid(`at most ${MAX_PREFIX_LISTS} prefix lists`)
  let total = 0
  for (const name of names) {
    const { entries } = validatePrefixList(name, input[name])
    total += entries.length
    if (total > MAX_PREFIX_ENTRIES) return invalid(`prefix lists hold more than ${MAX_PREFIX_ENTRIES} entries`)
    const sets: PrefixSets = { v4: [], v6: [] }
    for (const e of new Set(entries)) {
      const c = parseCidr(e) as Cidr
      ;(c.version === 4 ? sets.v4 : sets.v6).push(c)
    }
    out.set(name, sets)
  }
  return out
}

/** Same host rule as the remote-access policy: canonical CIDR, no /0, IPv6 exact addresses only. */
const normalizeDatabaseRemote = (input: unknown): PrefixSets => {
  const sets: PrefixSets = { v4: [], v6: [] }
  if (input === undefined) return sets
  if (!Array.isArray(input) || input.length > MAX_PREFIX_ENTRIES) return invalid('databaseRemoteSources must be a bounded list')
  const seen = new Set<string>()
  for (const raw of input) {
    const c = parseCidr(raw)
    if (!c || formatCidr(c) !== raw || c.prefix === 0 || (c.version === 6 && c.prefix !== 128)) return invalid('database remote source must be a canonical address or IPv4 network', { source: String(raw).slice(0, 64) })
    if (!seen.has(raw)) { seen.add(raw); (c.version === 4 ? sets.v4 : sets.v6).push(c) }
  }
  return sets
}

const normalizeSettings = (s: NftSettings): NormalSettings => {
  if (!isPlainObject(s)) return invalid('firewall settings must be an object')
  const panelPort = assertPort('panelPort', s.panelPort)
  const sshPort = assertPort('sshPort', s.sshPort)
  if (s.managementPorts !== undefined && (!Array.isArray(s.managementPorts) || new Set(s.managementPorts).size !== s.managementPorts.length)) return invalid('managementPorts must be a list of distinct ports')
  const managementPorts = [...new Set([panelPort, ...(s.managementPorts ?? []).map((p) => assertPort('managementPort', p))])]
  if (!Array.isArray(s.backendPorts) || s.backendPorts.length < 1 || s.backendPorts.length > 4) return invalid('backendPorts must hold 1-4 ports')
  const suppliedBackendPorts = s.backendPorts.map((p) => assertPort('backendPort', p))
  if (new Set(suppliedBackendPorts).size !== suppliedBackendPorts.length) return invalid('backendPorts must be distinct')
  const backendPorts = [...new Set([...suppliedBackendPorts, ...MANAGEMENT_BACKEND_PORTS])]
  const webPorts = (s.webPorts ?? DEFAULT_WEB_PORTS).map((p) => assertPort('webPort', p))
  const all = [...managementPorts, sshPort, ...webPorts, ...backendPorts]
  if (new Set(all).size !== all.length) return invalid('panel, ssh, web and backend ports must all differ', { ports: all })
  if (suppliedBackendPorts.some((p) => [...MANAGEMENT_PUBLIC_PORTS, ...MANAGEMENT_BACKEND_PORTS].includes(p))) return invalid('backend ports must not take management entry points or private listeners')
  const banTimeoutSec = assertInt('banTimeoutSec', s.banTimeoutSec, 60, 30 * 86400)
  const forwardPolicy = s.forwardPolicy ?? 'drop'
  if (forwardPolicy !== 'drop' && forwardPolicy !== 'accept') return invalid('forwardPolicy must be drop or accept')
  const rawBans = s.bans ?? []
  if (!Array.isArray(rawBans) || rawBans.length > BAN_SET_SIZE) return invalid(`bans must be an array of at most ${BAN_SET_SIZE}`)
  const now = rawBans.length ? assertInt('now', s.now, 0, 2 ** 40) : 0
  const bans = rawBans.flatMap((b) => {
    const ip = isPlainObject(b) ? parseIp(b.ip) : null
    if (!ip) return invalid('ban needs a valid ip', { ban: b })
    const remaining = assertInt('ban expiresAt', b.expiresAt, 0, 2 ** 40) - now
    return remaining > 0 ? [{ ip, remaining }] : []
  })
  const ftp = s.ftpPassivePorts
  if (ftp && !(Number.isInteger(ftp.min) && Number.isInteger(ftp.max) && ftp.min >= 1024 && ftp.max <= 65535 && ftp.min < ftp.max)) return invalid('ftpPassivePorts must be a port range from 1024 to 65535')
  const nfsClients = [...new Set(s.nfsClients ?? [])].filter(host => host === '*' || /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/.test(host))
  return { nfsClients, ...(ftp ? { ftpPassivePorts: { min: ftp.min, max: ftp.max } } : {}), ...(s.frpPorts ? { frpPorts: { bindPort: assertInt('frp port', s.frpPorts.bindPort, 1024, 65535), portMin: assertInt('frp port', s.frpPorts.portMin, 1024, 65535), portMax: assertInt('frp port', s.frpPorts.portMax, 1024, 65535) } } : {}), webClientPorts: (s.webClientPorts ?? []).map((p) => assertPort('webClientPort', p)), panelPort, managementPorts, sshPort, backendPorts, webPorts, lists: normalizeLists(s.prefixLists), databaseRemote: normalizeDatabaseRemote(s.databaseRemoteSources), banTimeoutSec, bans, forwardPolicy, flood: normalizeFlood(s.flood), smtpRestricted: s.smtpRestricted === true, appPorts: s.appPorts }
}

const normalizeFlood = (f: NftSettings['flood']): NftFloodSettings | null => {
  if (f === undefined || f === null) return null
  if (!isPlainObject(f)) return invalid('flood settings must be an object')
  const opt = (what: string, v: unknown, max: number): number | null => (v === null ? null : assertInt(what, v, 1, max))
  const newPerSecond = opt('new connections per second', f.newPerSecond, 100000)
  const newBurst = newPerSecond === null ? null : assertInt('new connection burst', f.newBurst, 1, 100000)
  return { connectionsPerAddress: opt('connections per address', f.connectionsPerAddress, 100000), newPerSecond, newBurst, pingPerSecond: opt('ping per second', f.pingPerSecond, 10000) }
}

// nftables wiki "Connlimits" and "Meters": dynamic sets keyed by source address; established traffic is accepted before these run.
const floodSets = (f: NftFloodSettings | null): string[] => {
  if (!f) return []
  const set = (name: string, type: string, timeout: boolean): string[] => [`  set ${name} {`, `    type ${type}`, `    size ${BAN_SET_SIZE}`, `    flags dynamic${timeout ? ',timeout' : ''}`, ...(timeout ? ['    timeout 60s'] : []), '  }']
  return [
    ...(f.connectionsPerAddress ? [...set(FLOOD_SETS.conn4, 'ipv4_addr', false), ...set(FLOOD_SETS.conn6, 'ipv6_addr', false)] : []),
    ...(f.newPerSecond ? [...set(FLOOD_SETS.rate4, 'ipv4_addr', true), ...set(FLOOD_SETS.rate6, 'ipv6_addr', true)] : []),
  ]
}
const floodRules = (f: NftFloodSettings | null, webPorts: readonly number[]): string[] => {
  if (!f) return []
  const web = `tcp dport ${portSet(webPorts)}`
  return [
    ...(f.connectionsPerAddress ? [
      `ct state new ${web} add @${FLOOD_SETS.conn4} { ip saddr ct count over ${f.connectionsPerAddress} } drop comment "${FLOOD_COMMENT_PREFIX} connections"`,
      `ct state new ${web} add @${FLOOD_SETS.conn6} { ip6 saddr ct count over ${f.connectionsPerAddress} } drop comment "${FLOOD_COMMENT_PREFIX} connections"`,
    ] : []),
    ...(f.newPerSecond ? [
      `ct state new ${web} update @${FLOOD_SETS.rate4} { ip saddr limit rate over ${f.newPerSecond}/second burst ${f.newBurst} packets } drop comment "${FLOOD_COMMENT_PREFIX} rate"`,
      `ct state new ${web} update @${FLOOD_SETS.rate6} { ip6 saddr limit rate over ${f.newPerSecond}/second burst ${f.newBurst} packets } drop comment "${FLOOD_COMMENT_PREFIX} rate"`,
    ] : []),
    ...(f.pingPerSecond ? [
      `icmp type echo-request limit rate over ${f.pingPerSecond}/second burst ${f.pingPerSecond * 2} packets drop comment "${FLOOD_COMMENT_PREFIX} ping"`,
      `icmpv6 type echo-request limit rate over ${f.pingPerSecond}/second burst ${f.pingPerSecond * 2} packets drop comment "${FLOOD_COMMENT_PREFIX} ping"`,
    ] : []),
  ]
}

/** Checks that need the host's ports and lists. Disabled rules never reach the kernel, so they pass. */
const assertRenderable = (r: NormalRule, ns: NormalSettings): void => {
  const { rule } = r
  if (!rule.enabled) return
  if (rule.kind === 'prefix-list' && !ns.lists.has(rule.list as string)) {
    invalid(`rule ${rule.id} uses prefix list ${String(rule.list)}, which does not exist`, { id: rule.id, list: rule.list })
  }
  const fromLoopback = r.source !== null && isLoopbackCidr(r.source)
  if (rule.action === 'accept' && rule.kind !== 'forward' && r.ports && overlaps(r.ports, ns.backendPorts) && !fromLoopback) {
    invalid(`rule ${rule.id} would open a backend port; backend ports are loopback-only`, { id: rule.id })
  }
  if (r.forward && r.ports && overlaps(r.ports, [...ns.managementPorts, ...MANAGEMENT_PUBLIC_PORTS, ns.sshPort, ...ns.webPorts, ...ns.backendPorts])) {
    invalid(`rule ${rule.id} would redirect a panel, ssh, web or backend port`, { id: rule.id })
  }
}

const listSize = (ns: NormalSettings, name: string | null): number => {
  const s = ns.lists.get(name as string)
  return s ? s.v4.length + s.v6.length : 0
}

/** True when the rule lets some remote address open a TCP connection to the panel. */
const opensPanel = (r: NormalRule, ns: NormalSettings, port: number): boolean =>
  r.rule.enabled &&
  r.rule.action === 'accept' &&
  (r.rule.kind === 'port' || r.rule.kind === 'ip' || r.rule.kind === 'prefix-list') &&
  (r.protocols === null || r.protocols.includes('tcp')) &&
  (r.ports === null || covers(r.ports, port)) &&
  !(r.source !== null && isLoopbackCidr(r.source)) &&
  (r.rule.kind !== 'prefix-list' || listSize(ns, r.rule.list) > 0)

// ---------------------------------------------------------------- rendering

const fam = (f: IpFamily): string => (f === 4 ? 'ip' : 'ip6')
const words = (...w: string[]): string => w.filter((x) => x !== '').join(' ')
const commentOf = (c: string): string => (c ? `comment "${c}"` : '')
const portSet = (ports: readonly number[]): string => (ports.length === 1 ? String(ports[0]) : `{ ${ports.join(', ')} }`)
const portText = (r: PortRange): string => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`)
const setName = (list: string, f: IpFamily): string => `pl_${list}_v${f}`
const srcMatch = (c: Cidr | null): string => (c ? `${fam(c.version)} saddr ${formatCidr(c)}` : '')
const target = (f: { ip: IpAddress; port: number }): string =>
  f.ip.version === 4 ? `${formatIp(f.ip)}:${f.port}` : `[${formatIp(f.ip)}]:${f.port}`

const l4Matches = (r: NormalRule): string[] =>
  r.protocols === null ? [''] : r.protocols.map((p) => (r.ports ? `${p} dport ${portText(r.ports)}` : `meta l4proto ${p}`))

const inputLines = (r: NormalRule, lists: Map<string, PrefixSets>): string[] => {
  const tail = words(r.rule.action, commentOf(r.rule.comment))
  switch (r.rule.kind) {
    case 'port':
    case 'ip':
      return l4Matches(r).map((m) => words(srcMatch(r.source), m, tail))
    case 'prefix-list': {
      const sets = lists.get(r.rule.list as string) as PrefixSets
      const families: [IpFamily, Cidr[]][] = [[4, sets.v4], [6, sets.v6]]
      return families
        .filter(([, items]) => items.length > 0)
        .flatMap(([f]) => l4Matches(r).map((m) => words(`${fam(f)} saddr @${setName(r.rule.list as string, f)}`, m, tail)))
    }
    case 'icmp': {
      // FirewallRule has no ICMP type: an icmp rule governs ping. Errors and ND are base-chain accepts.
      const out: string[] = []
      if (!r.source || r.source.version === 4) out.push(words(srcMatch(r.source), 'icmp type echo-request', tail))
      if (!r.source || r.source.version === 6) out.push(words(srcMatch(r.source), 'icmpv6 type echo-request', tail))
      return out
    }
    default:
      return []
  }
}

const chunk = <T>(xs: readonly T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

const elementsBlock = (items: string[]): string[] =>
  items.length === 0
    ? []
    : ['    elements = {', ...chunk(items, 8).map((c, i, all) => `      ${c.join(', ')}${i < all.length - 1 ? ',' : ''}`), '    }']

const banSet = (name: string, type: string, ns: NormalSettings, f: IpFamily): string[] => [
  `  set ${name} {`,
  `    type ${type}`,
  '    flags timeout',
  `    timeout ${ns.banTimeoutSec}s`,
  `    size ${BAN_SET_SIZE}`,
  ...elementsBlock(ns.bans.filter((b) => b.ip.version === f).map((b) => `${formatIp(b.ip)} timeout ${b.remaining}s`)),
  '  }',
]

const prefixSet = (name: string, type: string, items: Cidr[]): string[] => [
  `  set ${name} {`,
  `    type ${type}`,
  '    flags interval',
  '    auto-merge',
  ...elementsBlock(items.map(formatCidr)),
  '  }',
]

const chain = (name: string, decl: string, body: string[]): string[] => [`  chain ${name} {`, `    ${decl}`, ...body.map((l) => `    ${l}`), '  }']

/**
 * Renders the operator's list (core FirewallRule[], defaults from defaultFirewallRules()). Refuses with
 * SELF_LOCKOUT a list in which any configured management port has no enabled accept: on a remote server that
 * ruleset could only be undone from the console. The per-session check is core's assertNoSelfLockout().
 */
const appPorts = (list: NftSettings['appPorts']): readonly { port: number; uid: number; open: boolean }[] => {
  for (const app of list ?? []) { assertPort('app port', app.port); assertInt('app port owner', app.uid, MIN_ACCOUNT_UID, MAX_ACCOUNT_UID) }
  return list ?? []
}

export const renderNftables = (rules: readonly FirewallRule[], settings: NftSettings, os: Pick<OsProfile, 'paths'>): RenderedFile => {
  const ns = normalizeSettings(settings)
  const parsed = parseRules(rules)
  for (const r of parsed) assertRenderable(r, ns)
  const off = settings.enabled === false
  if (!off) for (const port of ns.managementPorts) {
    if (!parsed.some((r) => opensPanel(r, ns, port))) fail('SELF_LOCKOUT', `no enabled rule accepts the management port ${port}; the ruleset would lock everyone out`, { panelPort: port })
  }
  const active = off ? [] : parsed.filter((r) => r.rule.enabled)
  const filters = active.filter((r) => r.rule.kind !== 'forward')
  const forwards = active.filter((r) => r.rule.kind === 'forward')
  const guarded = portSet([ns.sshPort, ...ns.managementPorts])

  const usedLists = [...new Set(filters.filter((r) => r.rule.kind === 'prefix-list').map((r) => r.rule.list as string))]
  const sets = [
    ...banSet(BAN_SET_V4, 'ipv4_addr', ns, 4),
    ...banSet(BAN_SET_V6, 'ipv6_addr', ns, 6),
    // Always declared, even empty, so the remote-database provider can replace their elements in one nft batch.
    ...prefixSet(DB_REMOTE_SET_V4, 'ipv4_addr', ns.databaseRemote.v4),
    ...prefixSet(DB_REMOTE_SET_V6, 'ipv6_addr', ns.databaseRemote.v6),
    ...floodSets(ns.flood),
    ...usedLists.flatMap((name) => {
      const s = ns.lists.get(name) as PrefixSets
      return [
        ...(s.v4.length ? prefixSet(setName(name, 4), 'ipv4_addr', s.v4) : []),
        ...(s.v6.length ? prefixSet(setName(name, 6), 'ipv6_addr', s.v6) : []),
      ]
    }),
  ]

  const input = chain('input', `type filter hook input priority filter; policy ${off ? 'accept' : 'drop'};`, [
    'iif "lo" accept',
    'ct state invalid drop',
    // before established, so a new ban also cuts the attacker's open connections
    `ip saddr @${BAN_SET_V4} tcp dport ${guarded} drop`,
    `ip6 saddr @${BAN_SET_V6} tcp dport ${guarded} drop`,
    'ct state established,related accept',
    `tcp dport ${portSet(ns.backendPorts)} drop comment "xpanel: backend is loopback-only"`,
    'icmp type { destination-unreachable, time-exceeded, parameter-problem } accept',
    'icmpv6 type { destination-unreachable, packet-too-big, time-exceeded, parameter-problem } accept',
    'icmpv6 type { nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } ip6 hoplimit 255 accept',
    'icmpv6 type { mld-listener-query, mld-listener-report, mld-listener-done, mld2-listener-report } ip6 saddr fe80::/10 accept',
    // DHCPv6 replies come from another address than the multicast solicit, so conntrack misses them.
    'ip6 daddr fe80::/64 udp dport 546 accept comment "xpanel: dhcpv6 client"',
    ...floodRules(ns.flood, ns.webPorts),
    ...(settings.blockPing === true ? ['icmp type echo-request drop comment "xpanel: ping blocked"', 'icmpv6 type echo-request drop comment "xpanel: ping blocked"'] : []),
    ...filters.flatMap((r) => inputLines(r, ns.lists)),
    // After the operator's list: an administrator drop for a source or for 3306 always wins over tenant access.
    `ip saddr @${DB_REMOTE_SET_V4} tcp dport 3306 accept comment "xpanel: remote database access"`,
    `ip6 saddr @${DB_REMOTE_SET_V6} tcp dport 3306 accept comment "xpanel: remote database access"`,
    // Remote database access stays a list of addresses when the operator turns the firewall off.
    ...(off ? ['tcp dport 3306 drop comment "xpanel: remote database access"'] : []),
    ...(ns.ftpPassivePorts ? [`tcp dport ${ns.ftpPassivePorts.min}-${ns.ftpPassivePorts.max} accept comment "xpanel: ftp passive data"`] : []),
    ...(ns.frpPorts ? [`tcp dport { ${ns.frpPorts.bindPort}, ${ns.frpPorts.portMin}-${ns.frpPorts.portMax} } accept comment "xpanel: frp"`] : []),
    ...(ns.webClientPorts.length ? [`tcp dport ${portSet(ns.webClientPorts)} accept comment "xpanel: database web client"`] : []),
    ...(ns.nfsClients.length ? [`${ns.nfsClients.includes('*') ? '' : `ip saddr { ${ns.nfsClients.join(', ')} } `}tcp dport 2049 accept comment "xpanel: nfs clients"`] : []),
    ...appPorts(ns.appPorts).filter(app => app.open).map(app => `tcp dport ${app.port} accept comment "xpanel: app port"`),
  ])

  const forwardMatches = (r: NormalRule, verdict: string): string[] => {
    const f = r.forward as { ip: IpAddress; port: number }
    return (r.protocols ?? []).map((p) => words(`${fam(f.ip.version)} daddr ${formatIp(f.ip)}`, `${p} dport ${f.port}`, 'ct status dnat', verdict))
  }
  const forward = chain('forward', `type filter hook forward priority filter; policy ${ns.forwardPolicy};`, [
    'ct state established,related accept',
    ...forwards.flatMap((r) => forwardMatches(r, 'accept')),
  ])
  const nat = forwards.length === 0
    ? []
    : [
        '',
        ...chain('prerouting', 'type nat hook prerouting priority dstnat; policy accept;', forwards.flatMap((r) => {
          const f = r.forward as { ip: IpAddress; port: number }
          const scope = r.source ? srcMatch(r.source) : `meta nfproto ${f.ip.version === 4 ? 'ipv4' : 'ipv6'}`
          return l4Matches(r).map((m) => words(scope, m, `dnat ${fam(f.ip.version)} to ${target(f)}`, commentOf(r.rule.comment)))
        })),
        '',
        ...chain('postrouting', 'type nat hook postrouting priority srcnat; policy accept;', forwards.flatMap((r) => forwardMatches(r, 'masquerade'))),
      ]

  const content = [
    `#!${NFT_BINARY} -f`,
    '# Generated by xPanel. Manual edits are overwritten on the next firewall save.',
    '# Only table inet xpanel is managed here; tables of other tools are left alone.',
    '',
    `table inet ${NFT_TABLE}`,
    `delete table inet ${NFT_TABLE}`,
    '',
    `table inet ${NFT_TABLE} {`,
    ...sets,
    '',
    ...input,
    '',
    ...forward,
    ...nat,
    ...(ns.smtpRestricted || appPorts(ns.appPorts).length ? ['', ...chain('output', 'type filter hook output priority filter; policy accept;', [
      // A private app port answers its owner only: another account can neither reach it nor answer in its place while the app is down.
      ...appPorts(ns.appPorts).flatMap(app => [`oif "lo" tcp dport ${app.port} meta skuid != ${app.uid} reject with tcp reset comment "xpanel: app port"`, `oif "lo" tcp sport ${app.port} meta skuid != ${app.uid} drop comment "xpanel: app port"`]),
      ...(ns.smtpRestricted ? [
        // Local delivery stays open: every address of this host routes through lo. System users (the MTA, the list manager) sit below the account range.
        'oif "lo" accept',
        `meta skuid ${MIN_ACCOUNT_UID}-${MAX_ACCOUNT_UID} tcp dport ${portSet([...SMTP_RESTRICTED_PORTS])} reject with tcp reset comment "${SMTP_RESTRICTION_COMMENT}"`,
      ] : []),
    ])] : []),
    '}',
    '',
  ].join('\n')
  return { path: assertAbsPath('nftablesConf', os.paths.nftablesConf), content, mode: 0o600, owner: 'root', group: 'root' }
}

/** `nft -c -f` parses and checks the whole file against the kernel without applying it. */
export const nftConfigTest = (path: string): ConfigTest => ({ name: 'nftables', argv: [NFT_BINARY, '-c', '-f', assertAbsPath('nftables path', path)] })

/**
 * Activates a tested file with `nft -f` (atomic, our table only) and enables the distro unit so it
 * loads at boot. Never `systemctl reload nftables`: on EL its ExecReload runs `flush ruleset`, which
 * would also wipe the tables of other tools.
 */
export const nftApplyActions = (os: Pick<OsProfile, 'paths' | 'services'>): HostAction[] => [
  { kind: 'exec', argv: [NFT_BINARY, '-f', assertAbsPath('nftablesConf', os.paths.nftablesConf)] },
  { kind: 'systemd', verb: 'enable', unit: os.services.nftables },
]

export const CONTAINER_GUARD_TABLE = 'xpanel_ctr_guard'
export const CONTAINER_GUARD_PATH = '/etc/xpanel/container-guard.nft'
export const CONTAINER_GUARD_UNIT = 'xpanel-container-guard.service'

/**
 * A rootless container's loopback port is open to every local user. Other hosting accounts are refused here, in a
 * table and unit of their own: the guard holds with no firewall rules at all, and neither ruleset rewrites the other.
 * Nginx and system users stay below the account range, so a reverse proxy keeps working.
 */
export const renderContainerGuard = (ports: readonly NftContainerLoopback[], os: Pick<OsProfile, 'paths'>): { rules: RenderedFile; unit: RenderedFile; actions: HostAction[] } | null => {
  if (!ports.length) return null
  const lines = ports.map(({ port, protocol, uid }) => {
    assertInt('container port', port, 1024, 65535); assertInt('container owner', uid, MIN_ACCOUNT_UID, MAX_ACCOUNT_UID)
    return `ip daddr 127.0.0.1 ${protocol === 'udp' ? 'udp' : 'tcp'} dport ${port} meta skuid ${MIN_ACCOUNT_UID}-${MAX_ACCOUNT_UID} meta skuid != ${uid} reject${protocol === 'udp' ? '' : ' with tcp reset'} comment "${CONTAINER_LOOPBACK_COMMENT}"`
  })
  const rules = [`#!${NFT_BINARY} -f`, '# Generated by xPanel.', `table inet ${CONTAINER_GUARD_TABLE}`, `delete table inet ${CONTAINER_GUARD_TABLE}`, '', `table inet ${CONTAINER_GUARD_TABLE} {`, ...chain('output', 'type filter hook output priority filter; policy accept;', lines), '}', ''].join('\n')
  const unit = ['# Generated by xPanel.', '[Unit]', 'Description=xPanel guard for container loopback ports', 'After=nftables.service', '', '[Service]', 'Type=oneshot', 'RemainAfterExit=yes', `ExecStart=${NFT_BINARY} -f ${CONTAINER_GUARD_PATH}`, `ExecStop=${NFT_BINARY} delete table inet ${CONTAINER_GUARD_TABLE}`, '', '[Install]', 'WantedBy=multi-user.target', ''].join('\n')
  return {
    rules: { path: CONTAINER_GUARD_PATH, content: rules, mode: 0o600, owner: 'root', group: 'root' },
    unit: { path: `${assertAbsPath('systemdDir', os.paths.systemdDir)}/${CONTAINER_GUARD_UNIT}`, content: unit, mode: 0o644, owner: 'root', group: 'root' },
    // nft -f swaps the table in one transaction, so a changed port list never leaves a gap.
    actions: [{ kind: 'exec', argv: [NFT_BINARY, '-f', CONTAINER_GUARD_PATH] }, { kind: 'systemd', verb: 'enable', unit: CONTAINER_GUARD_UNIT }, { kind: 'systemd', verb: 'start', unit: CONTAINER_GUARD_UNIT }],
  }
}

/**
 * DNAT to other hosts needs routing for the family of each enabled forward target. IPv6 forwarding
 * makes the kernel ignore router advertisements; systemd-networkd (Ubuntu) and NetworkManager (EL)
 * process RAs in user space, so the default route survives. Null means no forward needs routing.
 */
export const renderForwardingSysctl = (rules: readonly FirewallRule[]): RenderedFile | null => {
  const families = new Set(
    parseRules(rules)
      .filter((r) => r.rule.enabled && r.forward)
      .map((r) => (r.forward as { ip: IpAddress }).ip.version),
  )
  if (families.size === 0) return null
  const lines = [
    '# Generated by xPanel: port forwarding rules need routing.',
    ...(families.has(4) ? ['net.ipv4.ip_forward = 1'] : []),
    ...(families.has(6) ? ['net.ipv6.conf.all.forwarding = 1'] : []),
  ]
  return { path: FORWARDING_SYSCTL_PATH, content: `${lines.join('\n')}\n`, mode: 0o644, owner: 'root', group: 'root' }
}

/** Loads a sysctl.d file now; at boot systemd-sysctl reads it. */
export const sysctlApplyActions = (file: Pick<RenderedFile, 'path'>): HostAction[] => [
  { kind: 'exec', argv: [SYSCTL_BINARY, '-p', assertAbsPath('sysctl file', file.path)] },
]

export const nftSettingsFromServer = (
  server: Pick<ServerSettings, 'panelPort' | 'sshPort' | 'backendPort' | 'backendTlsPort'>,
  extra: Omit<NftSettings, 'panelPort' | 'sshPort' | 'backendPorts'>,
): NftSettings => ({
  ...extra,
  panelPort: server.panelPort,
  managementPorts: extra.managementPorts ?? MANAGEMENT_PUBLIC_PORTS,
  sshPort: server.sshPort,
  backendPorts: [...new Set([server.backendPort, server.backendTlsPort])],
})

// ---------------------------------------------------------------- bans

const banTarget = (raw: unknown): { ip: string; set: string } => {
  const ip = parseIp(raw)
  if (!ip) return invalid('ban ip is not an IP address', { ip: String(raw).slice(0, 64) })
  if (isLoopback(ip)) return invalid('loopback addresses are never banned')
  return { ip: formatIp(ip), set: ip.version === 4 ? BAN_SET_V4 : BAN_SET_V6 }
}

/** Adds addresses to the live ban sets (argv only; the address is validated and canonical). */
export const banSetActions = (ips: readonly string[], banSec: number): HostAction[] => {
  const sec = assertInt('banSec', banSec, 60, 30 * 86400)
  return ips.map((raw): HostAction => {
    const t = banTarget(raw)
    return { kind: 'exec', argv: [NFT_BINARY, 'add', 'element', 'inet', NFT_TABLE, t.set, '{', t.ip, 'timeout', `${sec}s`, '}'] }
  })
}

export const unbanSetActions = (ips: readonly string[]): HostAction[] =>
  ips.map((raw): HostAction => {
    const t = banTarget(raw)
    return { kind: 'exec', argv: [NFT_BINARY, 'delete', 'element', 'inet', NFT_TABLE, t.set, '{', t.ip, '}'] }
  })

// ---------------------------------------------------------------- export / import

export const FIREWALL_EXPORT_FORMAT = 'xpanel.firewall'
export const FIREWALL_EXPORT_VERSION = 1
export const MAX_IMPORT_CHARS = 16 * 1024 * 1024

export interface FirewallExport {
  format: typeof FIREWALL_EXPORT_FORMAT
  version: typeof FIREWALL_EXPORT_VERSION
  /** RFC 3339 */
  exportedAt: string
  rules: FirewallRule[]
  prefixLists: Record<string, string[]>
}

export interface FirewallImport {
  rules: FirewallRule[]
  prefixLists: Record<string, string[]>
}

const RFC3339_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

const assertTimestamp = (v: unknown): string => {
  if (typeof v !== 'string' || !RFC3339_RE.test(v) || Number.isNaN(Date.parse(v))) {
    return invalid('exportedAt must be an RFC 3339 timestamp', { exportedAt: typeof v === 'string' ? v.slice(0, 64) : null })
  }
  return v
}

/** A bundle is self-contained: every prefix-list rule, enabled or not, names a list it carries. */
const validateBundle = (rules: unknown, prefixLists: unknown): FirewallImport => {
  const lists = normalizeLists(prefixLists ?? {})
  const clean = validateFirewallRules(rules)
  for (const r of clean) {
    if (r.kind === 'prefix-list' && !lists.has(r.list as string)) invalid(`rule ${r.id} uses prefix list ${String(r.list)}, which is not in the bundle`, { id: r.id })
  }
  const outLists: Record<string, string[]> = {}
  for (const [name, s] of lists) outLists[name] = [...s.v4, ...s.v6].map(formatCidr)
  return { rules: clean, prefixLists: outLists }
}

/** Serializes rules in our own versioned schema. Validates first, so every export imports again. */
export const exportRules = (rules: readonly FirewallRule[], prefixLists: Record<string, string[]>, exportedAt: string): string => {
  const at = assertTimestamp(exportedAt)
  const bundle = validateBundle(rules, prefixLists)
  const doc: FirewallExport = { format: FIREWALL_EXPORT_FORMAT, version: FIREWALL_EXPORT_VERSION, exportedAt: at, ...bundle }
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** Parses and fully validates an export. Unknown formats, versions and fields are rejected. */
export const importRules = (text: unknown): FirewallImport => {
  if (typeof text !== 'string' || text.length > MAX_IMPORT_CHARS) return invalid('import must be a JSON string of at most 16 MiB')
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return invalid('import is not valid JSON')
  }
  if (!isPlainObject(doc)) return invalid('import must be a JSON object')
  const extra = Object.keys(doc).filter((k) => !['format', 'version', 'exportedAt', 'rules', 'prefixLists'].includes(k))
  if (extra.length) return invalid('import has unknown fields', { fields: extra })
  if (doc.format !== FIREWALL_EXPORT_FORMAT) return invalid('not an xPanel firewall export', { format: String(doc.format).slice(0, 64) })
  if (doc.version !== FIREWALL_EXPORT_VERSION) return invalid(`unsupported export version ${String(doc.version).slice(0, 16)}`)
  assertTimestamp(doc.exportedAt)
  return validateBundle(doc.rules, doc.prefixLists)
}
