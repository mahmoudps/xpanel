// DNS zone data and PowerDNS HTTP API payloads (PowerDNS Authoritative 4.x API,
// /api/v1/servers/{server}/zones). Pure: requests are returned, never sent.
import type { DnsRecordType } from '@xpanel/core'
import { isXpanelError } from '@xpanel/core'
import {
  DNS_LABEL_RE,
  assertInt,
  assertString,
  assertWellFormed,
  canonicalIpv4,
  canonicalIpv6,
  hasControl,
  invalid,
  normalizeDnsName,
  normalizeEmail,
  normalizeHostname,
} from './validate.ts'
import { TXT_MAX_BYTES, escapeCharString, decodeCharString, decodeOctets, parseTxtPresentation, quoteTxt, utf8Length } from './txt.ts'

/** core's DnsRecordType has no SOA; zones need it (see contractRequests). */
export type ZoneRecordType = DnsRecordType | 'SOA'

export const ZONE_RECORD_TYPES: readonly ZoneRecordType[] = ['SOA', 'NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA']

/**
 * Canonical record. `name` is relative ('@' apex, '*' wildcard). `content` is
 * presentation RDATA with absolute names ending in '.', except: TXT holds the logical
 * unquoted value, and MX/SRV keep their priority in `priority`.
 */
export interface ZoneRecord {
  zone: string
  name: string
  type: ZoneRecordType
  ttl: number
  content: string
  priority: number | null
}

/** Untrusted input shape (API body, BIND import, core DnsRecord). */
export interface RecordInput {
  zone: string
  name: string
  type: string
  ttl: number
  content: string
  priority?: number | null
}

export const DEFAULT_TTL = 14400
export const MAX_TTL = 2147483647
export const MAX_SERIAL = 4294967295
export const SOA_TIMERS = { refresh: 3600, retry: 1800, expire: 1209600, minimum: 3600 } as const

export const assertTtl = (ttl: unknown): number => assertInt('TTL', ttl, 0, MAX_TTL)

const u16 = (what: string, v: unknown): number => assertInt(what, v, 0, 65535)

const parseUint = (what: string, s: string | undefined, max: number): number => {
  if (s === undefined || !/^\d{1,10}$/.test(s)) return invalid(what, s ?? '', 'must be a non-negative integer')
  return assertInt(what, Number(s), 0, max)
}

export const normalizeZone = (zone: unknown): string => normalizeHostname(zone, 'zone')

export const toFqdn = (name: string, zone: string): string => (name === '@' ? zone : `${name}.${zone}`)

/** Relative owner name inside `zone`. Absolute names must end with '.'; bare names that already end in the zone are refused as ambiguous. */
export const normalizeOwner = (name: unknown, zone: string): string => {
  const raw = assertString('record name', name, 254)
  if (raw === '@' || raw === '') return '@'
  if (!/^[\x21-\x7e]+$/.test(raw)) return invalid('record name', raw, 'must be ASCII without spaces')
  let s = raw.toLowerCase()
  if (s.endsWith('.')) {
    s = s.slice(0, -1)
    if (s === zone) return '@'
    if (!s.endsWith(`.${zone}`)) return invalid('record name', raw, `is outside zone ${zone}`)
    s = s.slice(0, -(zone.length + 1))
  } else if (s === zone || s.endsWith(`.${zone}`)) {
    return invalid('record name', raw, `is ambiguous: use a relative name or "${s}." for an absolute one`)
  }
  const labels = s.split('.')
  labels.forEach((l, i) => {
    if (l === '*' && i === 0) return
    if (!DNS_LABEL_RE.test(l)) invalid('record name', raw, `bad label "${l.slice(0, 64)}"`)
  })
  if (s.length + 1 + zone.length > 253) return invalid('record name', raw, 'makes the name longer than 253 characters')
  return s
}

const noPriority = (type: string, p: number | null): null =>
  p === null ? null : invalid('priority', p, `${type} records do not take a priority`)

const hostTarget = (what: string, v: string): string => `${normalizeHostname(v, what)}.`

/** `rname` of SOA from an email: the local part's dots are escaped (RFC 1035 §8). */
export const soaRname = (email: string): string => {
  const { local, domain } = normalizeEmail(email, 'admin email')
  if (!/^[a-z0-9._+-]+$/.test(local)) return invalid('admin email', email, 'local part cannot be expressed as an SOA rname')
  return `${local.replace(/\./g, '\\.')}.${domain}.`
}

const validateRname = (raw: string): string => {
  const s = raw.toLowerCase().replace(/\.$/, '')
  const parts = s.split(/(?<!\\)\./)
  if (parts.length < 3) return invalid('SOA rname', raw, 'must be mailbox.domain.tld')
  const [first, ...rest] = parts
  if (!/^(?:[a-z0-9_+-]|\\\.)+$/.test(first ?? '')) return invalid('SOA rname', raw, 'bad mailbox label')
  normalizeHostname(rest.join('.'), 'SOA rname domain')
  return `${s}.`
}

const splitWords = (s: string): string[] => s.split(' ')

type ContentResult = { content: string; priority: number | null }
type ContentCheck = (content: string, priority: number | null, name: string, zone: string, o: ValidateOptions) => ContentResult

export interface ValidateOptions {
  /**
   * How TXT `content` is read. 'logical' (default) keeps it verbatim so validation is
   * idempotent; 'presentation' parses `"a" "b"` (PowerDNS/BIND form); 'auto' parses
   * only when it starts with a quote (pasted UI input).
   */
  txtInput?: 'logical' | 'presentation' | 'auto'
}

const CHECKS: Record<ZoneRecordType, ContentCheck> = {
  A: (c, p) => ({ content: canonicalIpv4(c, 'A content'), priority: noPriority('A', p) }),
  AAAA: (c, p) => ({ content: canonicalIpv6(c, 'AAAA content'), priority: noPriority('AAAA', p) }),
  NS: (c, p) => ({ content: hostTarget('NS target', c), priority: noPriority('NS', p) }),
  CNAME: (c, p, name) => {
    if (name === '@') return invalid('CNAME', name, 'is not allowed at the zone apex')
    return { content: `${normalizeDnsName(c, 'CNAME target')}.`, priority: noPriority('CNAME', p) }
  },
  MX: (c, p) => {
    let target = c
    let prio = p
    const w = splitWords(c)
    if (prio === null && w.length === 2) {
      prio = parseUint('MX priority', w[0], 65535)
      target = w[1] ?? ''
    }
    if (prio === null) return invalid('MX priority', p, 'is required')
    prio = u16('MX priority', prio)
    if (target === '.') {
      if (prio !== 0) return invalid('MX', c, 'null MX (".") must have priority 0')
      return { content: '.', priority: 0 }
    }
    return { content: hostTarget('MX target', target), priority: prio }
  },
  SRV: (c, p, name) => {
    const labels = name.split('.')
    if (labels.length < 2 || !/^_[a-z0-9-]{1,62}$/.test(labels[0] ?? '') || !/^_(tcp|udp|tls|sctp)$/.test(labels[1] ?? '')) {
      return invalid('SRV name', name, 'must start with _service._proto')
    }
    let w = splitWords(c)
    let prio = p
    if (prio === null && w.length === 4) {
      prio = parseUint('SRV priority', w[0], 65535)
      w = w.slice(1)
    }
    if (prio === null) return invalid('SRV priority', p, 'is required')
    if (w.length !== 3) return invalid('SRV content', c, 'must be "weight port target"')
    const weight = parseUint('SRV weight', w[0], 65535)
    const port = parseUint('SRV port', w[1], 65535)
    const target = w[2] === '.' ? '.' : hostTarget('SRV target', w[2] ?? '')
    return { content: `${weight} ${port} ${target}`, priority: u16('SRV priority', prio) }
  },
  TXT: (c, p, _n, _z, o) => {
    const mode = o.txtInput ?? 'logical'
    if (mode !== 'logical' && mode !== 'presentation' && mode !== 'auto') return invalid('TXT input mode', mode, 'must be logical, presentation or auto')
    const value = mode === 'presentation' || (mode === 'auto' && c.startsWith('"')) ? parseTxtPresentation(c) : c
    assertWellFormed('TXT content', value)
    if (value.length === 0) return invalid('TXT content', c, 'is empty')
    if (hasControl(value)) return invalid('TXT content', c, 'contains control characters or newlines')
    if (utf8Length(value) > TXT_MAX_BYTES) return invalid('TXT content', c, `is longer than ${TXT_MAX_BYTES} octets`)
    return { content: value, priority: noPriority('TXT', p) }
  },
  CAA: (c, p) => {
    const m = /^(\d{1,3}) ([A-Za-z0-9]{1,15}) (.+)$/.exec(c)
    if (!m) return invalid('CAA content', c, 'must be "flags tag value"')
    const flags = parseUint('CAA flags', m[1], 255)
    const tag = (m[2] ?? '').toLowerCase()
    let value = m[3] ?? ''
    if (value.startsWith('"')) {
      if (value.length < 2 || !value.endsWith('"') || /(?<!\\)(?:\\\\)*"/.test(value.slice(1, -1))) {
        return invalid('CAA value', value, 'has unbalanced quotes')
      }
      value = decodeOctets('CAA value', decodeCharString(value.slice(1, -1)))
    } else if (value.includes(' ')) {
      return invalid('CAA value', value, 'must be quoted when it contains spaces')
    }
    if (hasControl(value) || !/^[\x20-\x7e]*$/.test(value) || value.length > 1024) {
      return invalid('CAA value', value, 'must be printable ASCII up to 1024 characters')
    }
    if ((tag === 'issue' || tag === 'issuewild') && !/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)?\s*(?:;[\x20-\x7e]*)?$/i.test(value)) {
      return invalid('CAA value', value, `${tag} must be "ca-domain[; params]" or ";"`)
    }
    if (tag === 'iodef' && !/^(?:mailto:[^\s"]+|https?:\/\/[^\s"]+)$/.test(value)) {
      return invalid('CAA value', value, 'iodef must be a mailto: or http(s) URL')
    }
    return { content: `${flags} ${tag} "${escapeCharString(value)}"`, priority: noPriority('CAA', p) }
  },
  SOA: (c, p, name) => {
    if (name !== '@') return invalid('SOA', name, 'must be at the zone apex')
    const w = c.split(/\s+/)
    if (w.length !== 7) return invalid('SOA content', c, 'must be "mname rname serial refresh retry expire minimum"')
    const mname = hostTarget('SOA mname', w[0] ?? '')
    const rname = validateRname(w[1] ?? '')
    const serial = parseUint('SOA serial', w[2], MAX_SERIAL)
    const timers = w.slice(3).map((t, i) => parseUint(`SOA ${['refresh', 'retry', 'expire', 'minimum'][i]}`, t, MAX_TTL))
    return { content: [mname, rname, serial, ...timers].join(' '), priority: noPriority('SOA', p) }
  },
}

export const parseRecordType = (t: unknown): ZoneRecordType => {
  const s = typeof t === 'string' ? t.toUpperCase() : ''
  return (ZONE_RECORD_TYPES as readonly string[]).includes(s) ? (s as ZoneRecordType) : invalid('record type', t, `must be one of ${ZONE_RECORD_TYPES.join(', ')}`)
}

/** Validate one record and return its canonical form. Throws VALIDATION. */
export const validateRecord = (input: RecordInput, o: ValidateOptions = {}): ZoneRecord => {
  if (!input || typeof input !== 'object') return invalid('record', input, 'is required')
  const zone = normalizeZone(input.zone)
  const type = parseRecordType(input.type)
  const name = normalizeOwner(input.name, zone)
  const ttl = assertTtl(input.ttl)
  const raw = assertString('content', input.content, 16384)
  const pr = input.priority ?? null
  if (pr !== null && typeof pr !== 'number') return invalid('priority', pr, 'must be a number or null')
  const { content, priority } = CHECKS[type](raw, pr, name, zone, o)
  return { zone, name, type, ttl, content, priority }
}

const rrKey = (r: ZoneRecord): string => `${r.name}\u0000${r.type}`
const rdataKey = (r: ZoneRecord): string => `${r.priority ?? ''}\u0000${r.content}`

/**
 * Whole-zone checks on top of validateRecord: one zone, one apex SOA, apex NS present,
 * CNAME alone at its name. Identical duplicates are dropped (same RR in DNS terms).
 */
export const validateZone = (records: RecordInput[], opts: { requireSoa?: boolean } = {}): ZoneRecord[] => {
  const recs = records.map((r) => validateRecord(r))
  const zone = recs[0]?.zone
  const seen = new Set<string>()
  const out: ZoneRecord[] = []
  for (const r of recs) {
    if (r.zone !== zone) return invalid('zone', r.zone, `mixes zones ${zone} and ${r.zone}`)
    const k = `${rrKey(r)}\u0000${rdataKey(r)}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  const soa = out.filter((r) => r.type === 'SOA')
  if (soa.length > 1) return invalid('zone', zone, 'has more than one SOA')
  if (opts.requireSoa !== false && out.length > 0) {
    if (soa.length === 0) return invalid('zone', zone, 'has no SOA')
    if (!out.some((r) => r.type === 'NS' && r.name === '@')) return invalid('zone', zone, 'has no apex NS')
  }
  const byName = new Map<string, Set<ZoneRecordType>>()
  const cnames = new Map<string, number>()
  for (const r of out) {
    byName.set(r.name, (byName.get(r.name) ?? new Set()).add(r.type))
    if (r.type === 'CNAME') cnames.set(r.name, (cnames.get(r.name) ?? 0) + 1)
  }
  for (const [name, n] of cnames) {
    if (n > 1) return invalid('zone', name, 'has more than one CNAME at this name')
    if ((byName.get(name)?.size ?? 0) > 1) return invalid('zone', name, 'has a CNAME next to other records')
  }
  return out
}

// ---- serials ----------------------------------------------------------------------------

const dateBase = (today: Date): number => {
  if (!(today instanceof Date) || Number.isNaN(today.getTime())) return invalid('date', today, 'is not a valid date')
  const y = today.getUTCFullYear()
  if (y < 1970 || y > 4293) return invalid('date', today.toISOString(), 'year is outside the serial range')
  return (y * 10000 + (today.getUTCMonth() + 1) * 100 + today.getUTCDate()) * 100
}

/** YYYYMMDDnn in UTC. */
export const serialFor = (today: Date, nn = 1): number => dateBase(today) + assertInt('serial counter', nn, 0, 99)

/** Next serial: today's YYYYMMDD01 if the zone is older, otherwise +1 (may roll past nn=99, still monotonic). */
export const bumpSerial = (serial: number, today: Date): number => {
  const cur = assertInt('SOA serial', serial, 0, MAX_SERIAL)
  const next = Math.max(cur + 1, dateBase(today) + 1)
  return next > MAX_SERIAL ? invalid('SOA serial', cur, 'would overflow 32 bits') : next
}

/** Replace the serial inside an SOA record. */
export const withSerial = (soa: ZoneRecord, serial: number): ZoneRecord => {
  if (soa.type !== 'SOA') return invalid('record', soa.type, 'is not an SOA')
  const w = soa.content.split(' ')
  w[2] = String(assertInt('SOA serial', serial, 0, MAX_SERIAL))
  return validateRecord({ ...soa, content: w.join(' ') })
}

// ---- default zone -----------------------------------------------------------------------

export interface NameserverAddress {
  ipv4: string
  ipv6?: string | null
}

export interface ZoneDefaultsOptions {
  ipv4: string
  ipv6?: string | null
  nameservers: string[]
  /**
   * Glue for nameservers inside this zone (ns1.example.com for example.com). An in-zone
   * nameserver without an entry gets the zone's own ipv4/ipv6, the single-server layout.
   * Entries for the zone's out-of-zone nameservers are not needed here and are not used.
   */
  nameserverAddresses?: Record<string, NameserverAddress>
  /** MX target, e.g. mail.example.com or the server hostname */
  mailHost: string
  adminEmail: string
  /** adds `*` A/AAAA; explicit names still win (DNS wildcard semantics) */
  wildcard?: boolean
  ttl?: number
  /** serial date (UTC); required unless `serial` is given, so the output stays deterministic */
  today?: Date
  serial?: number
  dmarcPolicy?: 'none' | 'quarantine' | 'reject'
}

const HOST_LABELS = ['@', 'www', 'mail', 'ftp', 'autoconfig', 'autodiscover'] as const

const relativeIn = (fqdn: string, zone: string): string | null =>
  fqdn === zone ? '@' : fqdn.endsWith(`.${zone}`) ? fqdn.slice(0, -(zone.length + 1)) : null

interface Glue {
  ipv4: string
  ipv6: string | null
}

const glueFor = (ns: string[], zone: string, given: unknown, ipv4: string, ipv6: string | null): Map<string, Glue> => {
  const map = given ?? {}
  if (typeof map !== 'object' || Array.isArray(map)) return invalid('nameserver addresses', map, 'must map nameserver names to addresses')
  const known = new Map<string, NameserverAddress>()
  for (const [name, addr] of Object.entries(map as Record<string, NameserverAddress>)) {
    const host = normalizeHostname(name, 'nameserver')
    if (!ns.includes(host)) return invalid('nameserver addresses', name, 'name a host that is not one of the nameservers')
    if (!addr || typeof addr !== 'object') return invalid('nameserver addresses', name, 'need an ipv4 address')
    known.set(host, addr)
  }
  const glue = new Map<string, Glue>()
  for (const n of ns) {
    const rel = relativeIn(n, zone)
    if (rel === null) continue
    const a = known.get(n)
    if (rel === '@') {
      // the apex already carries the zone's own addresses
      if (a) return invalid('nameserver addresses', n, 'cannot move the zone apex; it always uses the zone ipv4/ipv6')
      continue
    }
    glue.set(rel, a ? { ipv4: canonicalIpv4(a.ipv4, `${n} IPv4`), ipv6: a.ipv6 ? canonicalIpv6(a.ipv6, `${n} IPv6`) : null } : { ipv4, ipv6 })
  }
  return glue
}

export const defaultZoneRecords = (domain: string, o: ZoneDefaultsOptions): ZoneRecord[] => {
  const zone = normalizeZone(domain)
  const ttl = assertTtl(o.ttl ?? DEFAULT_TTL)
  const ipv4 = canonicalIpv4(o.ipv4)
  const ipv6 = o.ipv6 ? canonicalIpv6(o.ipv6) : null
  if (!Array.isArray(o.nameservers) || o.nameservers.length === 0 || o.nameservers.length > 13) {
    return invalid('nameservers', o.nameservers, 'need 1 to 13 entries')
  }
  const ns = o.nameservers.map((n) => normalizeHostname(n, 'nameserver'))
  if (new Set(ns).size !== ns.length) return invalid('nameservers', ns.join(','), 'contain duplicates')
  const mailHost = normalizeHostname(o.mailHost, 'mail host')
  const serial = o.serial !== undefined ? assertInt('SOA serial', o.serial, 1, MAX_SERIAL) : serialFor(o.today as Date)
  const policy = o.dmarcPolicy ?? 'none'
  if (!['none', 'quarantine', 'reject'].includes(policy)) return invalid('DMARC policy', policy, 'must be none, quarantine or reject')

  const recs: RecordInput[] = []
  const add = (name: string, type: ZoneRecordType, content: string, priority: number | null = null): void => {
    recs.push({ zone, name, type, ttl, content, priority })
  }
  const t = SOA_TIMERS
  add('@', 'SOA', `${ns[0]}. ${soaRname(o.adminEmail)} ${serial} ${t.refresh} ${t.retry} ${t.expire} ${t.minimum}`)
  for (const n of ns) add('@', 'NS', `${n}.`)
  const hosts: string[] = [...HOST_LABELS]
  const mailRel = relativeIn(mailHost, zone)
  if (mailRel !== null && !hosts.includes(mailRel)) hosts.push(mailRel)
  if (o.wildcard) hosts.push('*')
  const glue = glueFor(ns, zone, o.nameserverAddresses, ipv4, ipv6)
  for (const h of hosts) {
    if (glue.has(h)) continue
    add(h, 'A', ipv4)
    if (ipv6) add(h, 'AAAA', ipv6)
  }
  for (const [h, a] of glue) {
    add(h, 'A', a.ipv4)
    if (a.ipv6) add(h, 'AAAA', a.ipv6)
  }
  add('@', 'MX', `${mailHost}.`, 10)
  add('@', 'TXT', `v=spf1 a mx ip4:${ipv4}${ipv6 ? ` ip6:${ipv6}` : ''} ~all`)
  add('_dmarc', 'TXT', `v=DMARC1; p=${policy}`)
  add('_autodiscover._tcp', 'SRV', `0 443 autodiscover.${zone}.`, 0)
  return validateZone(recs)
}

// ---- PowerDNS HTTP API --------------------------------------------------------------------

export interface PdnsRecord {
  content: string
  disabled: boolean
}

export interface PdnsRRset {
  /** absolute with trailing dot */
  name: string
  type: ZoneRecordType
  changetype: 'REPLACE' | 'DELETE'
  ttl?: number
  records?: PdnsRecord[]
}

export interface PdnsPatchBody {
  rrsets: PdnsRRset[]
}

export interface PdnsCreateZoneBody {
  name: string
  kind: 'Native' | 'Master'
  nameservers: string[]
  soa_edit_api: 'DEFAULT' | 'INCREASE' | 'EPOCH' | ''
  rrsets: Omit<PdnsRRset, 'changetype'>[]
}

/** Request the agent sends to the PowerDNS API (with its X-API-Key header). */
export interface PdnsRequest {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: string
  body?: PdnsPatchBody | PdnsCreateZoneBody
}

export interface PdnsOptions {
  serverId?: string
}

const serverIdOf = (o: PdnsOptions): string => {
  const id = o.serverId ?? 'localhost'
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(id) ? id : invalid('PowerDNS server id', id, 'must be a simple lowercase identifier')
}

/** Our zone names are LDH-only, so the PowerDNS zone id is just the name with its dot. */
export const pdnsZonePath = (zone: string, o: PdnsOptions = {}): string =>
  `/api/v1/servers/${serverIdOf(o)}/zones/${normalizeZone(zone)}.`

export const pdnsContent = (r: ZoneRecord): string => {
  if (r.type === 'TXT') return quoteTxt(r.content)
  if (r.type === 'MX' || r.type === 'SRV') return `${r.priority} ${r.content}`
  return r.content
}

interface Group {
  name: string
  type: ZoneRecordType
  ttl: number
  contents: string[]
}

const groupRrsets = (records: RecordInput[], zone: string | null): Map<string, Group> => {
  const groups = new Map<string, Group>()
  for (const r of records.map((x) => validateRecord(x))) {
    if (zone !== null && r.zone !== zone) invalid('record zone', r.zone, `expected ${zone}`)
    const key = rrKey(r)
    const g = groups.get(key) ?? { name: `${toFqdn(r.name, r.zone)}.`, type: r.type, ttl: r.ttl, contents: [] }
    // one TTL per RRset in PowerDNS: keep the lowest, the conservative choice for caches
    g.ttl = Math.min(g.ttl, r.ttl)
    const c = pdnsContent(r)
    if (!g.contents.includes(c)) g.contents.push(c)
    groups.set(key, g)
  }
  return groups
}

const cmpGroup = (a: Group, b: Group): number =>
  a.name === b.name ? a.type.localeCompare(b.type) : a.name.localeCompare(b.name)

const sortedGroups = (m: Map<string, Group>): Group[] => [...m.values()].sort(cmpGroup)

const replaceOf = (g: Group): PdnsRRset => ({
  name: g.name,
  type: g.type,
  changetype: 'REPLACE',
  ttl: g.ttl,
  records: [...g.contents].sort().map((content) => ({ content, disabled: false })),
})

/** REPLACE rrsets for the given records (grouped by name+type, duplicates removed). */
export const pdnsRrsets = (records: RecordInput[]): PdnsRRset[] => {
  const zone = records[0] ? normalizeZone(records[0].zone) : null
  return sortedGroups(groupRrsets(records, zone)).map(replaceOf)
}

export const pdnsDeleteRrset = (zone: string, name: string, type: ZoneRecordType): PdnsRRset => {
  const z = normalizeZone(zone)
  const rel = normalizeOwner(name, z)
  return { name: `${toFqdn(rel, z)}.`, type: parseRecordType(type), changetype: 'DELETE' }
}

const soaFields = (g: Group): { serial: number; rest: string } => {
  const w = (g.contents[0] ?? '').split(' ')
  return { serial: Number(w[2]), rest: [...w.slice(0, 2), ...w.slice(3), g.ttl].join(' ') }
}

/**
 * With soa_edit_api the live serial moves on every PATCH, so the stored serial is usually
 * behind it: a serial-only difference is no change, and a real change never sends a serial
 * at or below the live one (secondaries ignore a serial that does not grow).
 */
const soaChange = (cur: Group | undefined, want: Group): PdnsRRset | null => {
  if (!cur) return replaceOf(want)
  const c = soaFields(cur)
  const w = soaFields(want)
  if (c.rest === w.rest) return null
  if (w.serial > c.serial) return replaceOf(want)
  const next = c.serial + 1
  if (next > MAX_SERIAL) return invalid('SOA serial', c.serial, 'would overflow 32 bits')
  const parts = (want.contents[0] ?? '').split(' ')
  parts[2] = String(next)
  return replaceOf({ ...want, contents: [parts.join(' ')] })
}

/** Minimal PATCH turning `current` into `desired`. The SOA is never deleted and its serial never goes back. */
export const pdnsDiff = (zone: string, current: RecordInput[], desired: RecordInput[]): PdnsRRset[] => {
  const z = normalizeZone(zone)
  const cur = groupRrsets(current, z)
  const want = groupRrsets(desired, z)
  const sameSet = (a: Group, b: Group): boolean =>
    a.ttl === b.ttl && [...a.contents].sort().join('\n') === [...b.contents].sort().join('\n')
  const out: PdnsRRset[] = []
  for (const [key, g] of [...want.entries()].sort(([, a], [, b]) => cmpGroup(a, b))) {
    const c = cur.get(key)
    if (g.type === 'SOA') {
      const change = soaChange(c, g)
      if (change) out.push(change)
    } else if (!c || !sameSet(c, g)) {
      out.push(replaceOf(g))
    }
  }
  for (const [key, g] of [...cur.entries()].sort(([, a], [, b]) => cmpGroup(a, b))) {
    if (g.type !== 'SOA' && !want.has(key)) out.push({ name: g.name, type: g.type, changetype: 'DELETE' })
  }
  return out
}

export const pdnsPatchZone = (zone: string, rrsets: PdnsRRset[], o: PdnsOptions = {}): PdnsRequest => {
  if (rrsets.length === 0) return invalid('PowerDNS patch', zone, 'has no rrsets')
  return { method: 'PATCH', path: pdnsZonePath(zone, o), body: { rrsets } }
}

/**
 * Create a zone with its full rrsets. `nameservers` stays empty because the NS rrset is
 * included; soa_edit_api DEFAULT makes API edits bump the serial the same way bumpSerial does.
 */
export const pdnsCreateZone = (zone: string, records: RecordInput[], o: PdnsOptions & { kind?: 'Native' | 'Master' } = {}): PdnsRequest => {
  const z = normalizeZone(zone)
  const valid = validateZone(records)
  if (valid.some((r) => r.zone !== z)) return invalid('records', z, 'belong to another zone')
  const kind = o.kind ?? 'Native'
  if (kind !== 'Native' && kind !== 'Master') return invalid('zone kind', kind, 'must be Native or Master')
  const rrsets = pdnsRrsets(valid).map(({ changetype: _c, ...rest }) => rest)
  return {
    method: 'POST',
    path: `/api/v1/servers/${serverIdOf(o)}/zones`,
    body: { name: `${z}.`, kind, nameservers: [], soa_edit_api: 'DEFAULT', rrsets },
  }
}

export const pdnsDeleteZone = (zone: string, o: PdnsOptions = {}): PdnsRequest => ({ method: 'DELETE', path: pdnsZonePath(zone, o) })

/** Ask PowerDNS to NOTIFY secondaries (Master zones). */
export const pdnsNotify = (zone: string, o: PdnsOptions = {}): PdnsRequest => ({ method: 'PUT', path: `${pdnsZonePath(zone, o)}/notify` })

/** rrset as returned by GET /zones/{zone} */
export interface PdnsLiveRRset {
  name: string
  type: string
  ttl: number
  records: PdnsRecord[]
}

/**
 * Convert live PowerDNS rrsets back to canonical records so pdnsDiff can compare them.
 * Disabled records, unsupported types (DNSSEC, PTR, ...) and unparsable content are
 * reported in `skipped` and left untouched by the diff.
 */
export const fromPdnsRrsets = (zone: string, rrsets: PdnsLiveRRset[]): { records: ZoneRecord[]; skipped: { name: string; type: string; reason: string }[] } => {
  const z = normalizeZone(zone)
  const records: ZoneRecord[] = []
  const skipped: { name: string; type: string; reason: string }[] = []
  for (const rr of rrsets) {
    if (!(ZONE_RECORD_TYPES as readonly string[]).includes(rr.type)) {
      skipped.push({ name: rr.name, type: rr.type, reason: 'unsupported type' })
      continue
    }
    for (const r of rr.records ?? []) {
      if (r.disabled) {
        skipped.push({ name: rr.name, type: rr.type, reason: 'disabled record' })
        continue
      }
      try {
        records.push(validateRecord({ zone: z, name: rr.name, type: rr.type, ttl: rr.ttl, content: r.content, priority: null }, { txtInput: 'presentation' }))
      } catch (err) {
        if (!isXpanelError(err)) throw err
        skipped.push({ name: rr.name, type: rr.type, reason: err.message })
      }
    }
  }
  return { records, skipped }
}

// ---- ACME dns-01 --------------------------------------------------------------------------

export const ACME_TXT_TTL = 60
/** base64url(SHA-256(key authorization)), RFC 8555 §8.4 */
const ACME_TXT_RE = /^[A-Za-z0-9_-]{43}$/

/** `_acme-challenge.<base>` for an identifier; `*.example.com` validates at the apex. */
export const acmeChallengeFqdn = (identifier: string): string => {
  const raw = assertString('ACME identifier', identifier, 254)
  if (raw.toLowerCase().startsWith('_acme-challenge.')) return normalizeDnsName(raw, 'ACME challenge name')
  const base = raw.startsWith('*.') ? raw.slice(2) : raw
  return `_acme-challenge.${normalizeHostname(base, 'ACME identifier')}`
}

export interface AcmeTxtOptions extends PdnsOptions {
  /** tokens already published at this name that must survive (apex + wildcard share one name) */
  keep?: string[]
  ttl?: number
}

/**
 * PATCH that publishes (`add`) or withdraws (`delete`) dns-01 TXT values. Values at the
 * same name are kept together because REPLACE overwrites the whole rrset.
 */
export const acmeTxtChange = (
  zone: string,
  name: string,
  token: string | string[],
  op: 'add' | 'delete',
  o: AcmeTxtOptions = {},
): PdnsRequest => {
  if (op !== 'add' && op !== 'delete') return invalid('ACME operation', op, 'must be add or delete')
  const z = normalizeZone(zone)
  const fqdn = acmeChallengeFqdn(name)
  if (fqdn !== z && !fqdn.endsWith(`.${z}`)) return invalid('ACME name', name, `is outside zone ${z}`)
  const tokens = (Array.isArray(token) ? token : [token]).map((t) =>
    typeof t === 'string' && ACME_TXT_RE.test(t) ? t : invalid('ACME TXT value', t, 'must be 43 base64url characters'),
  )
  if (tokens.length === 0) return invalid('ACME TXT value', '', 'is required')
  const keep = (o.keep ?? []).map((t) => (ACME_TXT_RE.test(t) ? t : invalid('ACME TXT value', t, 'must be 43 base64url characters')))
  const ttl = assertTtl(o.ttl ?? ACME_TXT_TTL)
  const values = op === 'add' ? [...new Set([...keep, ...tokens])] : keep.filter((k) => !tokens.includes(k))
  const rrName = `${fqdn}.`
  const rrset: PdnsRRset =
    values.length === 0
      ? { name: rrName, type: 'TXT', changetype: 'DELETE' }
      : {
          name: rrName,
          type: 'TXT',
          changetype: 'REPLACE',
          ttl,
          records: values.sort().map((v) => ({ content: quoteTxt(v), disabled: false })),
        }
  return pdnsPatchZone(z, [rrset], o)
}
