// Strict validators for every value that reaches an edge config file or path. Naming, home and
// docroot rules come from @xpanel/core (the single source of truth); this module adds what only
// config rendering needs (canonical form, IP/URL/regex parsing). They reject; they never repair.
import { posix } from 'node:path'
import { isIP } from 'node:net'
import {
  fail,
  MANAGEMENT_PUBLIC_PORTS,
  MANAGEMENT_BACKEND_PORTS,
  MAX_ACCOUNT_UID,
  MIN_ACCOUNT_UID,
  validateDocRoot,
  validateDomainName,
  validateHome,
  validateUsername,
  validateWildcardName,
} from '@xpanel/core'
import type { Account, Domain, ServerSettings } from '@xpanel/core'
import { assertPhpVersion } from '../system/validate.ts'

export { assertPhpVersion }

export const invalid = (what: string, value: unknown, why: string): never =>
  fail('VALIDATION', `invalid ${what}: ${why}`, {
    what,
    value: typeof value === 'string' ? value.slice(0, 256) : String(value),
  })

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

export const hasControl = (s: string): boolean => CONTROL.test(s)

export const assertString = (what: string, v: unknown, max: number): string => {
  if (typeof v !== 'string') return invalid(what, v, 'must be a string')
  if (v.length > max) return invalid(what, v, `longer than ${max} characters`)
  return v
}

export const assertInt = (what: string, v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) return invalid(what, v, 'must be an integer')
  if (v < min || v > max) return invalid(what, v, `must be within ${min}..${max}`)
  return v
}

export const assertPort = (what: string, v: unknown): number => assertInt(what, v, 1, 65535)

// ---- accounts ---------------------------------------------------------------------------

/** Account username, by the core rule (reserved system and service names included). */
export const assertUsername = (v: unknown): string => validateUsername(v)

/** Unix account names owned by the distribution (nginx, www-data, apache, nobody). */
export const assertSystemUser = (v: unknown, what = 'system user'): string => {
  const s = assertString(what, v, 32)
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(s) ? s : invalid(what, s, 'is not a unix user name')
}

/** UID/GID in the account range of core (login.defs UID_MIN..60000, never nobody). */
export const assertAccountId = (what: 'uid' | 'gid', v: unknown): number => assertInt(what, v, MIN_ACCOUNT_UID, MAX_ACCOUNT_UID)

const SEGMENT = /^[A-Za-z0-9._-]+$/

/** Absolute, normalized POSIX path of conservative characters, no `.`/`..`, no trailing slash. */
export const isSafeAbsPath = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length < 2 || v.length > 1024 || !v.startsWith('/')) return false
  if (v.endsWith('/') || posix.normalize(v) !== v) return false
  return v.slice(1).split('/').every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')
}

export const assertSafeAbsPath = (v: unknown, what = 'path'): string =>
  isSafeAbsPath(v) ? v : invalid(what, v, 'must be an absolute normalized path of [A-Za-z0-9._-] segments')

/** Like assertSafeAbsPath but the last segment may be a `*.conf`-style glob. */
export const assertIncludeGlob = (v: unknown, what = 'include path'): string => {
  const s = assertString(what, v, 1024)
  const i = s.lastIndexOf('/')
  const dir = s.slice(0, i)
  const base = s.slice(i + 1)
  if (i <= 0 || !isSafeAbsPath(dir) || !/^(?:\*|[A-Za-z0-9_-]+)?(?:\.[A-Za-z0-9_-]+)*\.?[A-Za-z0-9_*-]*$/.test(base) || base === '') {
    return invalid(what, s, 'must be an absolute path whose last segment is a file name or *.ext glob')
  }
  return s
}

/** Account home: the core home rule, plus the last segment must be the username. */
export const assertHome = (v: unknown, username: string): string => {
  const h = validateHome(v)
  if (posix.basename(h) !== username) return invalid('home directory', h, `must end with /${username}`)
  return h
}

export const assertAccount = (a: Account): Account => {
  if (!a || typeof a !== 'object') return invalid('account', a, 'is required')
  const username = assertUsername(a.username)
  assertAccountId('uid', a.uid)
  assertAccountId('gid', a.gid)
  assertHome(a.home, username)
  if (!['active', 'suspended', 'terminating'].includes(a.status)) invalid('account status', a.status, 'is unknown')
  return a
}

// ---- names ------------------------------------------------------------------------------

/** Core's FQDN rule, and the value must already be in canonical (lowercase, punycode) form. */
export const isDomainName = (v: unknown): v is string => {
  try {
    return validateDomainName(v) === v
  } catch {
    return false
  }
}

export const assertDomainName = (v: unknown, what = 'domain'): string =>
  isDomainName(v) ? v : invalid(what, v, 'must be a canonical (lowercase, punycode) fully qualified name')

/** `*.name` in canonical form. */
export const assertWildcardName = (v: unknown, what = 'wildcard name'): string => {
  try {
    if (validateWildcardName(v) === v) return v as string
  } catch {
    // reported below with the field name
  }
  return invalid(what, v, 'must look like *.example.com in canonical form')
}

/** Exact or wildcard server name, as served by a vhost. */
export const assertServedName = (v: unknown, what = 'server name'): string =>
  typeof v === 'string' && v.startsWith('*.') ? assertWildcardName(v, what) : assertDomainName(v, what)

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const assertId = (v: unknown, what = 'id'): string =>
  typeof v === 'string' && ID.test(v) ? v : invalid(what, v, 'must be 1-64 of [A-Za-z0-9_-]')

/** Document root: the core rule (strictly inside home, no hidden or protected dirs), already absolute. */
export const assertDocRoot = (v: unknown, home: string): string => {
  const d = validateDocRoot(home, v)
  return d === v ? d : invalid('document root', v, 'must be the absolute path inside the home')
}

// ---- IP addresses -----------------------------------------------------------------------

export interface Cidr {
  family: 4 | 6
  address: string
  prefix: number
}

/** IP literal or CIDR. IPv4 octets with leading zeros and IPv6 zone ids are refused. */
export const parseCidr = (v: unknown, what = 'IP/CIDR'): Cidr => {
  const s = assertString(what, v, 64)
  const [address = '', prefixText, extra] = s.split('/')
  if (extra !== undefined) return invalid(what, s, 'has more than one "/"')
  if (address.includes('%')) return invalid(what, s, 'zone ids are not allowed')
  const ipFamily = isIP(address)
  if (ipFamily !== 4 && ipFamily !== 6) return invalid(what, s, 'is not an IP address')
  const family: 4 | 6 = ipFamily
  if (family === 4 && address.split('.').some((o) => o.length > 1 && o.startsWith('0'))) {
    return invalid(what, s, 'IPv4 octets must not have leading zeros')
  }
  const max = family === 4 ? 32 : 128
  if (prefixText === undefined) return { family, address: address.toLowerCase(), prefix: max }
  if (!/^\d{1,3}$/.test(prefixText)) return invalid(what, s, 'prefix length must be a number')
  const prefix = Number(prefixText)
  if (prefix > max) return invalid(what, s, `prefix length must be 0..${max}`)
  return { family, address: address.toLowerCase(), prefix }
}

export const formatCidr = (c: Cidr): string =>
  c.prefix === (c.family === 4 ? 32 : 128) ? c.address : `${c.address}/${c.prefix}`

const v4ToInt = (a: string): number => a.split('.').reduce((n, o) => n * 256 + Number(o), 0)

const inV4 = (a: string, net: string, bits: number): boolean =>
  bits === 0 || v4ToInt(a) >>> (32 - bits) === v4ToInt(net) >>> (32 - bits)

/** Eight 16-bit groups of an address that isIP() already accepted as IPv6. */
const expandV6 = (ip: string): number[] => {
  let s = ip.toLowerCase()
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number]
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', tail] = s.split('::')
  const h = head === '' ? [] : head.split(':')
  const t = tail === undefined || tail === '' ? [] : tail.split(':')
  const fill = tail === undefined ? 0 : 8 - h.length - t.length
  return [...h, ...Array<string>(fill).fill('0'), ...t].map((x) => parseInt(x, 16))
}

export type AddressClass = 'loopback' | 'private' | 'forbidden' | 'public'

/** Classifies an IP literal for SSRF decisions. */
export const classifyIp = (ip: string): AddressClass => {
  const family = isIP(ip)
  if (family === 4) {
    if (inV4(ip, '127.0.0.0', 8)) return 'loopback'
    if (inV4(ip, '0.0.0.0', 8) || inV4(ip, '169.254.0.0', 16) || inV4(ip, '224.0.0.0', 4) || inV4(ip, '240.0.0.0', 4)) {
      return 'forbidden'
    }
    if (inV4(ip, '10.0.0.0', 8) || inV4(ip, '172.16.0.0', 12) || inV4(ip, '192.168.0.0', 16) || inV4(ip, '100.64.0.0', 10)) {
      return 'private'
    }
    return 'public'
  }
  if (family !== 6) return 'forbidden'
  const g = expandV6(ip)
  const g0 = g[0] ?? 0
  const zeros = (n: number): boolean => g.slice(0, n).every((x) => x === 0)
  if (zeros(7) && g[7] === 1) return 'loopback'
  if (zeros(8)) return 'forbidden'
  // IPv4-mapped / -compatible and NAT64 forms would smuggle an IPv4 target past the v4 checks
  if (zeros(5) && (g[5] === 0xffff || g[5] === 0)) return 'forbidden'
  if (g0 === 0x64 && g[1] === 0xff9b) return 'forbidden'
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00) return 'forbidden'
  if ((g0 & 0xfe00) === 0xfc00) return 'private'
  return 'public'
}

// ---- URLs -------------------------------------------------------------------------------

export interface Upstream {
  scheme: 'http' | 'https'
  host: string
  /** host as written in config: IPv6 in brackets */
  hostLiteral: string
  port: number
  path: string
  /** normalized `scheme://host:port[/path]` */
  url: string
  hostKind: 'ip' | 'name'
  addressClass: AddressClass | 'name'
}

const URL_RE = /^(https?):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(\/[A-Za-z0-9._~\/-]*)?$/

export const parseUpstream = (v: unknown, what = 'upstream'): Upstream => {
  const s = assertString(what, v, 512)
  const m = URL_RE.exec(s)
  if (!m) return invalid(what, s, 'must be http(s)://host[:port][/path] without credentials, query or spaces')
  const scheme = m[1] as 'http' | 'https'
  const rawHost = m[2] ?? ''
  const bracketed = rawHost.startsWith('[')
  const host = bracketed ? rawHost.slice(1, -1).toLowerCase() : rawHost.toLowerCase()
  const family = isIP(host)
  if (bracketed && family !== 6) return invalid(what, s, 'bracketed host must be IPv6')
  if (!bracketed && family === 6) return invalid(what, s, 'IPv6 hosts must be bracketed')
  if (family === 4 && host.split('.').some((o) => o.length > 1 && o.startsWith('0'))) {
    return invalid(what, s, 'IPv4 octets must not have leading zeros')
  }
  if (family === 0 && host !== 'localhost' && !isDomainName(host)) return invalid(what, s, 'host is not a valid name')
  const port = m[3] === undefined ? (scheme === 'https' ? 443 : 80) : assertPort(`${what} port`, Number(m[3]))
  const path = m[4] ?? ''
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return invalid(what, s, 'path must not contain dot segments')
  const hostLiteral = family === 6 ? `[${host}]` : host
  const addressClass: AddressClass | 'name' =
    host === 'localhost' ? 'loopback' : family === 0 ? 'name' : classifyIp(host)
  return {
    scheme,
    host,
    hostLiteral,
    port,
    path,
    url: `${scheme}://${hostLiteral}:${port}${path}`,
    hostKind: family === 0 && host !== 'localhost' ? 'name' : 'ip',
    addressClass,
  }
}

const REDIRECT_RE = /^https?:\/\/(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?(?:[/?#][A-Za-z0-9._~:/?#\[\]@!&'()*+,;=%-]*)?$/

/** Redirect target. `$`, quotes, backslash, braces and whitespace are refused for every target syntax. */
export const assertRedirectUrl = (v: unknown, what = 'redirect target'): string => {
  const s = assertString(what, v, 2048)
  if (!REDIRECT_RE.test(s)) return invalid(what, s, 'must be an absolute http(s) URL of URL-safe characters')
  const host = /^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/.exec(s)?.[1] ?? ''
  const bare = host.startsWith('[') ? host.slice(1, -1) : host
  if (isIP(bare) === 0 && !isDomainName(bare.toLowerCase())) return invalid(what, s, 'host is not a valid name')
  return s
}

// ---- regex ------------------------------------------------------------------------------

/**
 * A quantified group that itself contains a quantifier, e.g. `(a+)+` or `(\w*)*`. PCRE
 * backtracks exponentially on such patterns, and one hostile deny rule would then stall
 * every Nginx worker for every tenant.
 */
const OPEN_COUNT = /^\{\d+,\}/
const RANGE_COUNT = /^\{\d+,\d*\}/

/** `+`, `*` or `{n,}` at i: unbounded repetition. */
const unboundedAt = (s: string, i: number): boolean => s[i] === '+' || s[i] === '*' || OPEN_COUNT.test(s.slice(i))

/** `+`, `*`, `{n,}` or `{n,m}` at i: repetition that lets an inner unbounded group backtrack. */
const repeatsAt = (s: string, i: number): boolean => s[i] === '+' || s[i] === '*' || RANGE_COUNT.test(s.slice(i))

const hasNestedQuantifier = (s: string): boolean => {
  const stack: boolean[] = []
  let unbounded = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      i++
    } else if (c === '[') {
      for (i++; i < s.length && s[i] !== ']'; i++) if (s[i] === '\\') i++
    } else if (c === '(') {
      stack.push(unbounded)
      unbounded = false
    } else if (c === ')') {
      const inner: boolean = unbounded
      if (inner && repeatsAt(s, i + 1)) return true
      unbounded = (stack.pop() ?? false) || inner
    } else if (unboundedAt(s, i)) {
      unbounded = true
    }
  }
  return false
}

/** PCRE pattern for nginx `~`: bounded, single line, compiles, no quote/brace breakout, no ReDoS nesting. */
export const assertRegex = (v: unknown, what = 'pattern'): string => {
  const s = assertString(what, v, 256)
  if (s.length === 0) return invalid(what, s, 'is empty')
  if (hasControl(s)) return invalid(what, s, 'contains control characters or newlines')
  if (/["'`]/.test(s)) return invalid(what, s, 'must not contain quotes')
  if (/\\$/.test(s.replace(/\\\\/g, ''))) return invalid(what, s, 'ends with a dangling backslash')
  if (/\$\{|\$[A-Za-z_]/.test(s)) return invalid(what, s, 'must not reference nginx variables')
  if (/\(\?[^:=!<i]/.test(s)) return invalid(what, s, 'only (?:, (?=, (?!, (?<, (?i) groups are allowed')
  try {
    new RegExp(s.replace(/\(\?i\)/g, ''))
  } catch {
    return invalid(what, s, 'does not compile')
  }
  if (hasNestedQuantifier(s)) return invalid(what, s, 'nests quantifiers (catastrophic backtracking)')
  return s
}

// ---- settings ---------------------------------------------------------------------------

export const assertBackendPort = (settings: ServerSettings): number => {
  const p = assertInt('backendPort', settings.backendPort, 1024, 65535)
  if ([settings.panelPort, settings.sshPort, ...MANAGEMENT_PUBLIC_PORTS, ...MANAGEMENT_BACKEND_PORTS].includes(p)) invalid('backendPort', p, 'collides with a management or SSH port')
  return p
}

export const assertDomainBelongs = (account: Account, d: Domain): Domain => {
  if (!d || typeof d !== 'object') return invalid('domain', d, 'is required')
  assertDomainName(d.name)
  if (d.accountId !== account.id) return invalid('domain', d.name, `does not belong to account ${account.username}`)
  assertDocRoot(d.docRoot, account.home)
  assertPhpVersion(d.php?.version)
  if (!['php', 'static', 'proxy', 'node', 'python'].includes(d.siteType)) invalid('site type', d.siteType, 'is unknown')
  if (!['primary', 'addon', 'alias', 'subdomain'].includes(d.kind)) invalid('domain kind', d.kind, 'is unknown')
  if (d.redirect) {
    assertRedirectUrl(d.redirect.to)
    if (d.redirect.code !== 301 && d.redirect.code !== 302) invalid('redirect code', d.redirect.code, 'must be 301 or 302')
  }
  if (d.certificateId !== null && d.certificateId !== undefined) assertId(d.certificateId, 'certificate id')
  return d
}
