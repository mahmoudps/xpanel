// nftables-backed input firewall rules. Forward rules are DNAT in the prerouting hook, so they
// divert matching traffic before the input chain runs, wherever they sit in the list. The other
// rules are evaluated top-down, first match wins, and the input chain policy is drop. Renderers
// add the usual base chain in front (loopback, established/related, ICMPv6 neighbour
// discovery); this module only reasons about the operator's list.
import type { FirewallAction, FirewallRule, ServerSettings } from '../types.ts'
import { fail, isXpanelError } from '../errors.ts'
import { invalid, isInt, isRecord, throwIfErrors, utf8Length } from './check.ts'

export const FIREWALL_DEFAULT_POLICY: FirewallAction = 'drop'
/** nftables stores a rule comment in 128 bytes of user data (UTF-8 bytes, not characters). */
export const FIREWALL_COMMENT_MAX = 128

// ---- addresses -----------------------------------------------------------------------

export interface IpAddress {
  version: 4 | 6
  value: bigint
}

export interface Cidr extends IpAddress {
  prefix: number
}

const bitsOf = (v: 4 | 6): number => (v === 4 ? 32 : 128)

const parseIpv4 = (s: string): bigint | null => {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  let v = 0n
  for (const p of parts) {
    // leading zeros are refused: some parsers read them as octal
    if (!/^(?:0|[1-9]\d{0,2})$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    v = (v << 8n) | BigInt(n)
  }
  return v
}

const parseIpv6 = (s: string): bigint | null => {
  if (s.length < 2 || s.length > 45) return null
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : (halves[0] ?? '').split(':')
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] ?? '').split(':')) : []
  const last = halves.length === 2 ? tail : head
  let v4: bigint | null = null
  if (last.length > 0 && (last[last.length - 1] ?? '').includes('.')) {
    v4 = parseIpv4(last.pop() ?? '')
    if (v4 === null) return null
  }
  const groups = [...head, ...tail]
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null
  const count = groups.length + (v4 === null ? 0 : 2)
  if (halves.length === 1 ? count !== 8 : count > 7) return null
  const zeros = 8 - count
  const words = [...head, ...Array<string>(halves.length === 2 ? zeros : 0).fill('0'), ...tail].map((g) => BigInt(`0x${g}`))
  let v = 0n
  for (const w of words) v = (v << 16n) | w
  if (v4 !== null) v = (v << 32n) | v4
  return v
}

/** Parses an IPv4 or IPv6 literal. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) becomes IPv4. */
export const parseIp = (input: unknown): IpAddress | null => {
  if (typeof input !== 'string' || input.length === 0 || input.length > 45) return null
  if (input.includes(':')) {
    const value = parseIpv6(input)
    if (value === null) return null
    if (value >> 32n === 0xffffn) return { version: 4, value: value & 0xffffffffn }
    return { version: 6, value }
  }
  const value = parseIpv4(input)
  return value === null ? null : { version: 4, value }
}

/** `addr` or `addr/prefix`. Host bits must be zero so the stored rule means what it says. */
export const parseCidr = (input: unknown): Cidr | null => {
  if (typeof input !== 'string') return null
  const slash = input.indexOf('/')
  const addr = parseIp(slash === -1 ? input : input.slice(0, slash))
  if (!addr) return null
  // a mapped address written with an IPv6 prefix keeps v6 semantics; refuse the ambiguity
  if (slash !== -1 && addr.version === 4 && input.slice(0, slash).includes(':')) return null
  const bits = bitsOf(addr.version)
  let prefix = bits
  if (slash !== -1) {
    const p = input.slice(slash + 1)
    if (!/^(?:0|[1-9]\d{0,2})$/.test(p) || Number(p) > bits) return null
    prefix = Number(p)
  }
  const hostBits = BigInt(bits - prefix)
  if ((addr.value & ((1n << hostBits) - 1n)) !== 0n) return null
  return { ...addr, prefix }
}

export const cidrContains = (cidr: Cidr, ip: IpAddress): boolean => {
  if (cidr.version !== ip.version) return false
  const shift = BigInt(bitsOf(ip.version) - cidr.prefix)
  return ip.value >> shift === cidr.value >> shift
}

const formatIp = (ip: IpAddress): string => {
  if (ip.version === 4) return [24n, 16n, 8n, 0n].map((s) => String((ip.value >> s) & 0xffn)).join('.')
  const words = Array.from({ length: 8 }, (_, i) => Number((ip.value >> BigInt((7 - i) * 16)) & 0xffffn))
  // RFC 5952: compress the longest run (length >= 2) of zero words
  let best = -1
  let bestLen = 0
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && words[j] === 0) j++
    if (j - i > bestLen && j - i >= 2) {
      best = i
      bestLen = j - i
    }
    i = j
  }
  const hex = words.map((w) => w.toString(16))
  if (best === -1) return hex.join(':')
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`
}

/** Canonical text for a CIDR (`10.0.0.0/8`, `2001:db8::/32`, plain address for a host). */
export const formatCidr = (c: Cidr): string => (c.prefix === bitsOf(c.version) ? formatIp(c) : `${formatIp(c)}/${c.prefix}`)

const isLoopback = (ip: IpAddress): boolean =>
  ip.version === 4 ? ip.value >> 24n === 127n : ip.value === 1n

// "this network", loopback, link-local (cloud metadata lives at 169.254.169.254), multicast,
// reserved and broadcast: never a sane DNAT target.
const isUnusableTarget = (ip: IpAddress): boolean =>
  isLoopback(ip) ||
  ip.value === 0n ||
  (ip.version === 4 && (ip.value >> 24n === 0n || ip.value >> 16n === 0xa9fen || ip.value >> 28n >= 0xen)) ||
  (ip.version === 6 && (ip.value >> 118n === 0x3fan || ip.value >> 120n === 0xffn))

// ---- ports ---------------------------------------------------------------------------

export interface PortRange {
  from: number
  to: number
}

const PORT_RE = /^[1-9]\d{0,4}$/

/** `80` or `8000-8100`; a range must run upwards (`80-80` is written `80`). */
export const parsePortSpec = (input: unknown): PortRange | null => {
  if (typeof input !== 'string') return null
  const parts = input.split('-')
  if (parts.length > 2 || !parts.every((p) => PORT_RE.test(p))) return null
  const [from, to] = [Number(parts[0]), Number(parts[parts.length - 1])]
  if (from > 65535 || to > 65535 || (parts.length === 2 && from >= to)) return null
  return { from, to }
}

const isPort = (v: unknown): v is number => isInt(v, 1, 65535)

/** `a.b.c.d:port` or `[v6]:port`; refuses loopback, unspecified, link-local, multicast, reserved and broadcast. */
export const parseForwardTarget = (input: unknown): { ip: IpAddress; port: number } | null => {
  if (typeof input !== 'string' || input.length > 64) return null
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|(\d{1,3}(?:\.\d{1,3}){3})):([1-9]\d{0,4})$/.exec(input)
  if (!m) return null
  const ip = parseIp(m[1] ?? m[2])
  const port = Number(m[3])
  if (!ip || !isPort(port) || isUnusableTarget(ip)) return null
  if (m[1] !== undefined && ip.version !== 6) return null
  return { ip, port }
}

// ---- rule validation -----------------------------------------------------------------

const KINDS = ['port', 'ip', 'forward', 'icmp', 'prefix-list'] as const
const ACTIONS = ['accept', 'drop', 'reject'] as const
const PROTOCOLS = ['tcp', 'udp', 'both'] as const
const RULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** Becomes part of an nftables set name (`pl_<name>_v4`) and the prefix-list id in our JSON export. */
export const PREFIX_LIST_NAME_RE = /^[a-z][a-z0-9_]{0,23}$/
// nft strings have no escape syntax, so comments are an allowlist: letters of any script,
// digits, marks, spaces and a few punctuation marks.
const COMMENT_RE = /^[\p{L}\p{N}\p{M} _.,:;()/@+#=%&!?*'[\]-]*$/u

const RULE_KEYS = ['id', 'kind', 'action', 'protocol', 'port', 'source', 'forwardTo', 'list', 'comment', 'enabled']

export const firewallRuleErrors = (rule: unknown): string[] => {
  if (!isRecord(rule)) return ['rule must be an object']
  const errors = Object.keys(rule).filter((k) => !RULE_KEYS.includes(k)).map((k) => `${k} is not a known field`)
  const r = rule as Partial<Record<keyof FirewallRule, unknown>>
  if (typeof r.id !== 'string' || !RULE_ID_RE.test(r.id)) errors.push('id must be 1-64 letters, digits, "_" or "-"')
  if (!(KINDS as readonly unknown[]).includes(r.kind)) errors.push(`kind must be one of ${KINDS.join(', ')}`)
  if (!(ACTIONS as readonly unknown[]).includes(r.action)) errors.push('action must be accept, drop or reject')
  if (r.protocol !== null && !(PROTOCOLS as readonly unknown[]).includes(r.protocol)) errors.push('protocol must be tcp, udp, both or null')
  if (typeof r.enabled !== 'boolean') errors.push('enabled must be a boolean')
  if (typeof r.comment !== 'string' || !COMMENT_RE.test(r.comment) || utf8Length(r.comment) > FIREWALL_COMMENT_MAX) {
    errors.push(`comment must be at most ${FIREWALL_COMMENT_MAX} bytes of letters, digits, spaces and ._,:;()/@+#=%&!?*'[]-`)
  }
  for (const k of ['port', 'source', 'forwardTo', 'list'] as const) {
    if (r[k] !== null && typeof r[k] !== 'string') errors.push(`${k} must be a string or null`)
  }
  if (errors.length > 0) return errors

  const has = (k: 'port' | 'source' | 'forwardTo' | 'list'): boolean => r[k] !== null
  const forbid = (...keys: ('port' | 'source' | 'forwardTo' | 'list' | 'protocol')[]): void => {
    for (const k of keys) if (r[k] !== null) errors.push(`${k} is not used by ${String(r.kind)} rules`)
  }
  if (has('port') && parsePortSpec(r.port) === null) errors.push('port must be 1-65535 or a range like 8000-8100')
  if (has('source') && parseCidr(r.source) === null) errors.push('source must be an IPv4/IPv6 address or a CIDR with zero host bits')
  if (has('port') && r.protocol === null) errors.push('a port needs a protocol (tcp, udp or both)')

  switch (r.kind) {
    case 'port':
      if (!has('port')) errors.push('port rules need a port')
      forbid('forwardTo', 'list')
      break
    case 'ip':
      if (!has('source')) errors.push('ip rules need a source address or CIDR')
      forbid('forwardTo', 'list')
      break
    case 'forward': {
      if (!has('port')) errors.push('forward rules need the public port')
      else if ((r.port as string).includes('-')) errors.push('forward rules take a single public port, not a range')
      const target = has('forwardTo') ? parseForwardTarget(r.forwardTo) : null
      if (!has('forwardTo')) errors.push('forward rules need a target')
      else if (target === null) {
        errors.push('forwardTo must be ip:port or [ipv6]:port and may not be loopback, unspecified, link-local, multicast or broadcast')
      }
      const source = has('source') ? parseCidr(r.source) : null
      if (target && source && target.ip.version !== source.version) errors.push('source and forward target must be the same IP family')
      if (r.action !== 'accept') errors.push('forward rules must use action accept')
      forbid('list')
      break
    }
    case 'icmp':
      forbid('port', 'forwardTo', 'list', 'protocol')
      break
    case 'prefix-list':
      if (!has('list')) errors.push('prefix-list rules need a list name')
      else if (!PREFIX_LIST_NAME_RE.test(r.list as string)) errors.push('list name must match [a-z][a-z0-9_]{0,23}')
      forbid('source', 'forwardTo')
      break
  }
  return errors
}

const canonicalSource = (s: string | null): string | null => {
  if (s === null) return null
  const c = parseCidr(s)
  return c ? formatCidr(c) : s
}

export const validateFirewallRule = (rule: unknown): FirewallRule => {
  throwIfErrors('firewall rule', firewallRuleErrors(rule))
  const r = rule as FirewallRule
  return {
    id: r.id,
    kind: r.kind,
    action: r.action,
    protocol: r.protocol,
    port: r.port,
    source: canonicalSource(r.source),
    forwardTo: r.forwardTo,
    list: r.list,
    comment: r.comment,
    enabled: r.enabled,
  }
}

export const validateFirewallRules = (rules: unknown): FirewallRule[] => {
  if (!Array.isArray(rules)) return invalid('firewall rules must be an array')
  if (rules.length > 4096) return invalid('too many firewall rules')
  const out = rules.map((r, i) => {
    try {
      return validateFirewallRule(r)
    } catch (e) {
      const detail = isXpanelError(e) ? e.detail : {}
      return invalid(`rule #${i + 1}: ${(e as Error).message}`, { ...detail, index: i })
    }
  })
  const seen = new Set<string>()
  for (const r of out) {
    if (seen.has(r.id)) invalid(`duplicate rule id "${r.id}"`, { id: r.id })
    seen.add(r.id)
  }
  return out
}

/** Validates a prefix list's entries and returns them canonicalized. */
export const validatePrefixList = (name: unknown, entries: unknown): { name: string; entries: string[] } => {
  if (typeof name !== 'string' || !PREFIX_LIST_NAME_RE.test(name)) return invalid('list name must match [a-z][a-z0-9_]{0,23}')
  if (!Array.isArray(entries) || entries.length > 65536) return invalid('prefix list entries must be an array of at most 65536 CIDRs')
  const bad = entries.filter((e) => parseCidr(e) === null)
  if (bad.length > 0) return invalid(`invalid prefix list entries: ${bad.slice(0, 5).map(String).join(', ')}`, { invalid: bad.length })
  return { name, entries: entries.map((e) => formatCidr(parseCidr(e) as Cidr)) }
}

// ---- defaults ------------------------------------------------------------------------

/** Fixed HTTPS entry points and their private loopback listeners. Never tenant upstreams. */
export const MANAGEMENT_PUBLIC_PORTS: readonly number[] = [2083, 2087, 2096]
export const MANAGEMENT_BACKEND_PORTS: readonly number[] = [12083, 12087, 12096]

type PortSettings = Pick<ServerSettings, 'panelPort' | 'sshPort' | 'backendPort' | 'backendTlsPort'> & {
  /** Explicit public management ports; defaults to the fixed HTTPS entry points. */
  managementPorts?: readonly number[]
}

const managementPorts = (panelPort: number, ports: readonly number[] = MANAGEMENT_PUBLIC_PORTS): number[] =>
  [...new Set([panelPort, ...ports])]

const WEB_PORTS: readonly number[] = [80, 443]

const portSettingsErrors = (settings: PortSettings): string[] => {
  if (!isRecord(settings)) return ['server ports must be an object']
  const { panelPort, sshPort, backendPort, backendTlsPort } = settings
  const errors = Object.entries({ panelPort, sshPort, backendPort, backendTlsPort })
    .filter(([, v]) => !isPort(v))
    .map(([k]) => `${k} must be 1-65535`)
  if (errors.length > 0) return errors
  if (settings.managementPorts !== undefined && (!Array.isArray(settings.managementPorts) ||
      settings.managementPorts.some((p) => !isPort(p)) || new Set(settings.managementPorts).size !== settings.managementPorts.length)) {
    return ['managementPorts must contain distinct ports within 1-65535']
  }
  const publicPorts = new Set([...WEB_PORTS, panelPort, sshPort])
  if (publicPorts.size !== 4) errors.push('panelPort and sshPort must differ from each other and from 80/443')
  if (publicPorts.has(backendPort) || publicPorts.has(backendTlsPort)) errors.push('backend ports must not be public ports')
  if (backendPort === backendTlsPort) errors.push('backendPort and backendTlsPort must differ')
  const management = managementPorts(panelPort, settings.managementPorts)
  if (management.some((p) => WEB_PORTS.includes(p) || p === sshPort || p === backendPort || p === backendTlsPort || MANAGEMENT_BACKEND_PORTS.includes(p))) errors.push('management ports must differ from SSH, web and private backend ports')
  if ([panelPort, sshPort, backendPort, backendTlsPort].some((p) => MANAGEMENT_BACKEND_PORTS.includes(p))) errors.push('server ports must not take a private management listener')
  if ([backendPort, backendTlsPort].some((p) => MANAGEMENT_PUBLIC_PORTS.includes(p))) errors.push('web backend ports must not take management entry points')
  return errors
}

const rule = (id: string, partial: Partial<FirewallRule>): FirewallRule => ({
  id,
  kind: 'port',
  action: 'accept',
  protocol: 'tcp',
  port: null,
  source: null,
  forwardTo: null,
  list: null,
  comment: '',
  enabled: true,
  ...partial,
})

/**
 * Management HTTPS, HTTP and SSH open; the Apache/OLS backend ports reachable from loopback
 * only; ping allowed; everything else falls to the drop policy.
 */
export const defaultFirewallRules = (settings: PortSettings): FirewallRule[] => {
  throwIfErrors('server ports', portSettingsErrors(settings))
  const { panelPort, sshPort, backendPort, backendTlsPort } = settings

  const backend = (id: string, port: number, label: string): FirewallRule[] => [
    rule(`${id}-loopback-v4`, { port: String(port), source: '127.0.0.0/8', comment: `${label} from loopback` }),
    rule(`${id}-loopback-v6`, { port: String(port), source: '::1', comment: `${label} from loopback` }),
    rule(`${id}-drop`, { action: 'drop', port: String(port), comment: `${label} closed to the network` }),
  ]
  return [
    ...backend('default-backend', backendPort, 'web backend'),
    ...backend('default-backend-tls', backendTlsPort, 'web backend TLS'),
    rule('default-ssh', { port: String(sshPort), comment: 'SSH' }),
    rule('default-http', { port: '80', comment: 'HTTP' }),
    rule('default-https', { port: '443', comment: 'HTTPS' }),
    rule('default-panel', { port: String(panelPort), comment: 'xPanel' }),
    ...managementPorts(panelPort, settings.managementPorts).filter((p) => p !== panelPort).map((p) =>
      rule(`default-management-${p}`, { port: String(p), comment: 'management HTTPS' })),
    rule('default-icmp', { kind: 'icmp', protocol: null, comment: 'ping' }),
  ]
}

// ---- rule sets -----------------------------------------------------------------------

export type PrefixLists = Readonly<Record<string, readonly string[]>>

export interface FirewallRuleSetContext extends PortSettings {
  /** the prefix lists that exist; a prefix-list rule must name one of them */
  prefixLists: PrefixLists
}

const LOOPBACK_V4: Cidr = { version: 4, value: 0x7f000000n, prefix: 8 }

/** 127.0.0.0/8 or a subnet of it, or ::1: such sources only ever arrive on lo. */
const isLoopbackSource = (c: Cidr): boolean =>
  c.version === 4 ? c.prefix >= 8 && cidrContains(LOOPBACK_V4, c) : c.prefix === 128 && c.value === 1n

const coversAny = (range: PortRange, ports: readonly number[]): boolean => ports.some((p) => p >= range.from && p <= range.to)

/**
 * Checks that need the whole list and the server ports, the same ones the nftables renderer
 * enforces, so a list is refused when it is saved rather than when the agent renders it. A
 * stored rule must be safe to enable, so disabled rules are checked too:
 * - an accept may open a backend port only from loopback (Nginx is the only way in);
 * - a forward may not take the panel, SSH, HTTP(S) or a backend port;
 * - a prefix-list rule must name an existing list.
 */
export const firewallRuleSetErrors = (rules: readonly FirewallRule[], ctx: FirewallRuleSetContext): string[] => {
  const errors = portSettingsErrors(ctx)
  if (errors.length > 0) return errors
  if (!isRecord(ctx.prefixLists)) return ['prefixLists must be an object of list name to CIDRs']
  const backendPorts = [ctx.backendPort, ctx.backendTlsPort, ...MANAGEMENT_BACKEND_PORTS]
  const reservedPorts = [...managementPorts(ctx.panelPort, ctx.managementPorts), ...MANAGEMENT_PUBLIC_PORTS, ctx.sshPort, ...WEB_PORTS, ...backendPorts]
  for (const r of rules) {
    const range = r.port === null ? null : parsePortSpec(r.port)
    const source = r.source === null ? null : parseCidr(r.source)
    if (r.kind === 'forward') {
      if (range && coversAny(range, reservedPorts)) errors.push(`rule ${r.id}: forwards may not take the panel, SSH, HTTP(S) or backend ports`)
    } else if (r.action === 'accept' && range && coversAny(range, backendPorts) && !(source && isLoopbackSource(source))) {
      errors.push(`rule ${r.id}: backend ports ${backendPorts.join('/')} accept loopback only`)
    }
    if (r.kind === 'prefix-list' && (r.list === null || !Object.hasOwn(ctx.prefixLists, r.list))) {
      errors.push(`rule ${r.id}: prefix list "${String(r.list)}" does not exist`)
    }
  }
  return errors
}

/** validateFirewallRules plus the list-level checks; what the API stores. */
export const validateFirewallRuleSet = (rules: unknown, ctx: FirewallRuleSetContext): FirewallRule[] => {
  const valid = validateFirewallRules(rules)
  throwIfErrors('firewall rules', firewallRuleSetErrors(valid, ctx))
  return valid
}

// ---- evaluation ----------------------------------------------------------------------

export interface Packet {
  ip: IpAddress
  protocol: 'tcp' | 'udp'
  port: number
}

export interface Verdict {
  /** `forward` means the packet is DNATed away and never reaches the local service */
  action: FirewallAction | 'forward'
  /** null when no rule matched and the chain policy applied */
  ruleId: string | null
}

type Match = 'yes' | 'no' | 'unknown'

const sourceMatch = (rule: FirewallRule, ip: IpAddress, lists: PrefixLists): Match => {
  if (rule.kind === 'prefix-list') {
    const entries = rule.list !== null && Object.hasOwn(lists, rule.list) ? lists[rule.list] : undefined
    if (!entries) return 'unknown'
    let unknown = false
    for (const e of entries) {
      const c = parseCidr(e)
      if (!c) unknown = true
      else if (cidrContains(c, ip)) return 'yes'
    }
    return unknown ? 'unknown' : 'no'
  }
  if (rule.source === null) return 'yes'
  const c = parseCidr(rule.source)
  if (!c) return 'unknown'
  return cidrContains(c, ip) ? 'yes' : 'no'
}

const ruleMatches = (rule: FirewallRule, p: Packet, lists: PrefixLists): Match => {
  if (rule.kind === 'icmp') return 'no'
  if (rule.protocol !== null && rule.protocol !== 'both' && rule.protocol !== p.protocol) return 'no'
  if (rule.port !== null) {
    const range = parsePortSpec(rule.port)
    if (!range) return 'unknown'
    if (p.port < range.from || p.port > range.to) return 'no'
  }
  return sourceMatch(rule, p.ip, lists)
}

/**
 * Enabled forwards are checked first, in list order, because DNAT in prerouting diverts a
 * packet before the input chain sees it. Then the first matching enabled input rule decides.
 * When a match cannot be decided (unknown prefix list, unparsable field) a blocking rule or
 * forward is assumed to match and an accept is assumed not to, so the result errs toward
 * "blocked".
 */
export const evaluateFirewall = (rules: readonly FirewallRule[], packet: Packet, lists: PrefixLists = {}): Verdict => {
  for (const r of rules) {
    if (r.enabled !== true || r.kind !== 'forward') continue
    if (ruleMatches(r, packet, lists) !== 'no') return { action: 'forward', ruleId: r.id }
  }
  for (const r of rules) {
    if (r.enabled !== true || r.kind === 'forward') continue
    const m = ruleMatches(r, packet, lists)
    if (m === 'no') continue
    if (r.action === 'accept') {
      if (m === 'yes') return { action: 'accept', ruleId: r.id }
      continue
    }
    return { action: r.action, ruleId: r.id }
  }
  return { action: FIREWALL_DEFAULT_POLICY, ruleId: null }
}

export interface LockoutContext {
  /** the address of the admin session saving the rules */
  sessionIp: string
  panelPort: number
  /** Other active public management entry points, checked with the current session address. */
  managementPorts?: readonly number[]
  /** also kept reachable unless null */
  sshPort: number | null
  prefixLists?: PrefixLists
}

/**
 * SELF_LOCKOUT when the saved rules would stop the current session's address from
 * reaching the panel port (or SSH): a forward on that port anywhere in the list, a
 * drop/reject matching it first, a disabled accept, a prefix list that may contain it, or no
 * accept at all before the drop policy.
 */
export const assertNoSelfLockout = (rules: readonly FirewallRule[], ctx: LockoutContext): void => {
  if (!isRecord(ctx)) return invalid('lockout context must be an object')
  const ip = parseIp(ctx.sessionIp)
  if (!ip) return invalid('session IP is not a valid address', { sessionIp: String(ctx.sessionIp).slice(0, 64) })
  if (!isPort(ctx.panelPort)) return invalid('panelPort must be 1-65535')
  if (ctx.managementPorts !== undefined && (!Array.isArray(ctx.managementPorts) || ctx.managementPorts.some((p) => !isPort(p)) || new Set(ctx.managementPorts).size !== ctx.managementPorts.length)) return invalid('managementPorts must contain distinct ports within 1-65535')
  if (ctx.sshPort !== null && !isPort(ctx.sshPort)) return invalid('sshPort must be 1-65535 or null')
  const valid = validateFirewallRules(rules)
  const lists = ctx.prefixLists ?? {}
  const checks: { service: 'panel' | 'ssh'; port: number }[] = managementPorts(ctx.panelPort, ctx.managementPorts ?? []).map((port) => ({ service: 'panel', port }))
  if (ctx.sshPort !== null) checks.push({ service: 'ssh', port: ctx.sshPort })
  for (const { service, port } of checks) {
    const verdict = evaluateFirewall(valid, { ip, protocol: 'tcp', port }, lists)
    if (verdict.action !== 'accept') {
      fail('SELF_LOCKOUT', `these rules would block your address ${formatIp(ip)} from the ${service} port ${port}`, {
        sessionIp: formatIp(ip),
        service,
        port,
        ruleId: verdict.ruleId,
        verdict: verdict.action,
      })
    }
  }
}
