// Shared boundary and entity validators for values that reach paths, config files,
// state JSON files or the SQLite index. They reject; they never silently repair.
import { fail } from './errors.ts'
import { isUnlimited } from './limits.ts'
import { cidrContains, formatCidr, parseCidr, parseIp } from './rules/firewall.ts'
import { validateDomainName } from './rules/naming.ts'
import { PHP_HANDLERS, sanitizePhpIni, validateFpm } from './rules/php.ts'
import { validateApacheWorkers, validateNginxWorkers } from './rules/workers.ts'
import type { ApacheMpm, Engine, Limit, PhpSettings, ResellerAcl, ServerSettings } from './types.ts'

const bad = (what: string, value: unknown, why: string): never =>
  fail('VALIDATION', `invalid ${what}: ${why}`, { what, value: typeof value === 'string' ? value.slice(0, 256) : value })

const str = (what: string, v: unknown): string => (typeof v === 'string' ? v : bad(what, v, 'must be a string'))

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Lookups by a malformed id simply find nothing (no driver error, no 400). */
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

export const assertId = (v: unknown, what = 'id'): string =>
  isUuid(v) ? v.toLowerCase() : fail('VALIDATION', `invalid ${what}`, { what })

export const assertIdOrNull = (v: unknown, what = 'id'): string | null => (v === null ? null : assertId(v, what))

/** Root logins only; reseller and account logins follow validateUsername. */
export const PRINCIPAL_USERNAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

export const assertPrincipalUsername = (v: unknown): string => {
  const s = str('username', v)
  return PRINCIPAL_USERNAME_RE.test(s) ? s : bad('username', s, 'lowercase letters, digits, "_" or "-", starting with a letter, at most 32')
}

const PATH_SEGMENT = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*$/

/** No empty, hidden, "." or ".." segments; a config-safe alphabet. */
const segmentsOk = (segments: string[]): boolean => segments.every((seg) => PATH_SEGMENT.test(seg))

/** Absolute, normalised, config-safe path (certificate files, snapshots, archives). */
export const assertAbsPath = (v: unknown, what = 'path'): string => {
  const s = str(what, v)
  if (s.length > 1024 || !s.startsWith('/') || s === '/') return bad(what, s, 'must be an absolute path below /')
  if (!segmentsOk(s.slice(1).split('/'))) return bad(what, s, 'only A-Z a-z 0-9 . _ @ + - in segments; no empty, hidden or ".." segments')
  return s
}

/** Path relative to an account home ('' is the home itself); never a hidden directory such as .ssh. */
export const assertRelPath = (v: unknown, what = 'path'): string => {
  const s = str(what, v)
  if (s === '') return s
  if (s.length > 1024 || s.startsWith('/')) return bad(what, s, 'must be relative')
  if (!segmentsOk(s.split('/'))) return bad(what, s, 'only A-Z a-z 0-9 . _ @ + - in segments; no empty, hidden or ".." segments')
  return s
}

const EMAIL_LOCAL = /^[A-Za-z0-9._%+-]{1,64}$/

/** Contact and admin addresses (the domain part goes through validateDomainName). */
export const assertEmail = (v: unknown, what = 'email'): string => {
  const s = str(what, v)
  const at = s.lastIndexOf('@')
  if (s.length > 254 || at < 1) return bad(what, s, 'must be local@domain')
  const local = s.slice(0, at)
  if (!EMAIL_LOCAL.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return bad(what, s, 'unsupported characters in local part')
  }
  return `${local}@${validateDomainName(s.slice(at + 1))}`
}

/** A dotted-quad IPv4 address in canonical form (no leading zeros, no IPv4-mapped IPv6). */
export const assertIpv4 = (v: unknown, what = 'ipv4'): string => {
  const s = str(what, v)
  const ip = s.includes(':') ? null : parseIp(s)
  return ip?.version === 4 && formatCidr({ ...ip, prefix: 32 }) === s ? s : bad(what, s, 'must be a dotted-quad IPv4 address')
}

/** One IPv4/IPv6 address, returned in canonical form. */
export const assertIp = (v: unknown, what = 'address'): string => {
  const s = str(what, v)
  const ip = parseIp(s)
  return ip ? formatCidr({ ...ip, prefix: ip.version === 4 ? 32 : 128 }) : bad(what, s, 'not an IP address')
}

/** An address or a network with zero host bits, returned in canonical form. */
export const assertCidr = (v: unknown, what = 'network'): string => {
  const s = str(what, v)
  const c = parseCidr(s)
  return c ? formatCidr(c) : bad(what, s, 'must be an IP address or a CIDR with zero host bits')
}

export const MIN_ARGON2_MEMORY_KIB = 65_536

const ARGON2ID_PHC = /^\$argon2id\$v=19\$m=([1-9][0-9]{0,9}),t=([1-9][0-9]{0,9}),p=([1-9][0-9]{0,2})\$[A-Za-z0-9+/]{11,128}\$[A-Za-z0-9+/]{16,}$/

/** Panel passwords are Argon2id (RFC 9106) PHC strings with m >= 65536 KiB (64 MiB); anything else is refused. */
export const assertArgon2Hash = (v: unknown): string => {
  const s = str('password hash', v)
  if (s.length > 512) return bad('password hash', '<redacted>', 'must be an argon2id PHC string')
  const m = ARGON2ID_PHC.exec(s)
  if (!m) return bad('password hash', '<redacted>', 'must be an argon2id PHC string')
  if (Number(m[1]) < MIN_ARGON2_MEMORY_KIB) {
    return bad('password hash', '<redacted>', `argon2id memory cost m must be at least ${MIN_ARGON2_MEMORY_KIB} KiB (64 MiB)`)
  }
  return s
}

/** Scheme-tagged hash for mail/FTP passwd files ({ARGON2ID}..., {SHA512-CRYPT}...). Refuses argon2i and weak argon2id cost. */
export const assertServiceHash = (v: unknown): string => {
  const s = str('password hash', v)
  if (s.length < 1 || s.length > 512 || /[\s\p{Cc}:]/u.test(s)) {
    return bad('password hash', '<redacted>', 'no whitespace, control characters or ":"')
  }
  if (/^\{ARGON2I\}/i.test(s) || s.includes('$argon2i$')) {
    return bad('password hash', '<redacted>', 'argon2i is not permitted; use argon2id with m >= 65536')
  }
  const mCost = /\$argon2id\$v=19\$m=([0-9]+),/.exec(s)
  if (mCost && Number(mCost[1]) < MIN_ARGON2_MEMORY_KIB) {
    return bad('password hash', '<redacted>', `argon2id memory cost m must be at least ${MIN_ARGON2_MEMORY_KIB} KiB (64 MiB)`)
  }
  return s
}

export const assertSha256Hex = (v: unknown, what = 'checksum'): string => {
  const s = str(what, v)
  return /^[0-9a-f]{64}$/.test(s) ? s : bad(what, s, 'must be 64 lowercase hex characters')
}

// controls, line/paragraph separators, bidi embeddings, overrides and isolates, BOM
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/

/** One line of free text: no control, line-separator or bidi characters. */
export const assertLine = (v: unknown, max: number, what = 'text', { allowEmpty = true } = {}): string => {
  const s = str(what, v)
  if (!allowEmpty && s.length === 0) return bad(what, s, 'must not be empty')
  if (s.length > max) return bad(what, s, `at most ${max} characters`)
  if (UNSAFE_TEXT.test(s)) return bad(what, s, 'control and bidi characters are not allowed')
  return s
}

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

/** Display names of feature lists, tokens, backup jobs. */
export const assertName = (v: unknown, what = 'name'): string => {
  const s = str(what, v)
  return NAME_RE.test(s) ? s : bad(what, s, 'letters, digits, space . _ -; at most 64; starts with a letter or digit')
}

export const assertInt = (v: unknown, min: number, max: number, what: string): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : bad(what, v, `integer in ${min}..${max}`)

export const assertBool = (v: unknown, what: string): boolean => (typeof v === 'boolean' ? v : bad(what, v, 'must be a boolean'))

export const oneOf = <T extends string>(v: unknown, allowed: readonly T[], what: string): T =>
  allowed.includes(v as T) ? (v as T) : bad(what, v, `must be one of ${allowed.join('|')}`)

const MAX_LIMIT = Number.MAX_SAFE_INTEGER

/** Validates a Limit ('unlimited' or a safe integer >= min). */
export const assertLimit = (v: unknown, what = 'limit', { min = 0 } = {}): Limit => {
  if (isUnlimited(v as Limit)) return 'unlimited'
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > MAX_LIMIT) {
    return fail('VALIDATION', `${what} must be an integer >= ${min} or 'unlimited'`, { what, value: String(v) })
  }
  return v
}

/** Which versions are installed is host state (packages/os); here only the shape is checked. */
const PHP_VERSION_RE = /^[0-9]{1,2}\.[0-9]{1,2}$/
const PHP_KEYS = ['version', 'handler', 'fpm', 'ini']

export interface PhpCaps {
  /** plan caps.phpWorkers: the pool's pm.max_children ceiling */
  phpWorkers: Limit
  /** plan resources.memoryMb: memory_limit ceiling */
  memoryMb: Limit
}

/** Per-domain PHP: core validates the pool against the plan's worker cap and php.ini against its allowlist. */
export const assertPhpSettings = (v: unknown, caps: PhpCaps): PhpSettings => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return bad('php', v, 'must be an object')
  const p = v as Record<string, unknown>
  const unknown = Object.keys(p).filter((k) => !PHP_KEYS.includes(k))
  if (unknown.length > 0) return bad('php', unknown.join(','), 'unknown fields')
  if (typeof p.version !== 'string' || !PHP_VERSION_RE.test(p.version)) return bad('php.version', p.version, 'like 8.3')
  return {
    version: p.version,
    handler: oneOf(p.handler, PHP_HANDLERS, 'php.handler'),
    fpm: validateFpm(p.fpm, caps.phpWorkers),
    ini: sanitizePhpIni(p.ini, { maxMemoryMb: caps.memoryMb }),
  }
}

const UPSTREAM_RE = /^https?:\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::([0-9]{1,5}))?(\/[A-Za-z0-9._~%/-]*)?$/

// cloud metadata (169.254.169.254, fd00:ec2::254), link-local, "this network", multicast and
// reserved: a proxied site must never expose them to the internet
const FORBIDDEN_UPSTREAM_NETS = ['0.0.0.0/8', '169.254.0.0/16', '224.0.0.0/3', '::/128', 'fe80::/10', 'ff00::/8', 'fd00:ec2::254'].map(
  (c) => parseCidr(c)!,
)
const LOOPBACK_NETS = ['127.0.0.0/8', '::1'].map((c) => parseCidr(c)!)

export interface UpstreamTarget {
  url: string
  /** set when the host is an IP literal on loopback */
  loopbackPort: number | null
}

/** http(s)://host[:port][/path] without userinfo, query or config metacharacters. */
export const assertUpstream = (v: unknown): UpstreamTarget => {
  const s = str('upstream', v)
  const m = UPSTREAM_RE.exec(s)
  if (!m || s.length > 512) return bad('upstream', s, 'like http://127.0.0.1:3000')
  const port = m[2] === undefined ? (s.startsWith('https:') ? 443 : 80) : Number(m[2])
  if (port < 1 || port > 65535) return bad('upstream', s, 'port must be 1..65535')
  const host = (m[1] as string).replace(/^\[|\]$/g, '')
  const ip = parseIp(host)
  if (ip === null && /^[0-9.]+$/.test(host)) return bad('upstream', s, 'malformed IPv4 address')
  if (ip !== null && FORBIDDEN_UPSTREAM_NETS.some((n) => cidrContains(n, ip))) {
    return bad('upstream', s, 'link-local, unspecified and multicast addresses are not allowed')
  }
  const loopback = ip !== null && LOOPBACK_NETS.some((n) => cidrContains(n, ip))
  return { url: s, loopbackPort: loopback || host === 'localhost' ? port : null }
}

// characters that would break out of a config directive or a header
const REDIRECT_FORBIDDEN = /[\s\p{Cc}"'<>{}|^`;\\]/u

export const assertRedirectTarget = (v: unknown): string => {
  const s = str('redirect', v)
  if (s.length > 2048 || !/^https?:\/\/[^/]/.test(s) || REDIRECT_FORBIDDEN.test(s)) {
    return bad('redirect', s, 'absolute http(s) URL without spaces, quotes, braces, ";" or "\\"')
  }
  return s
}

/** ISO 8601 / RFC 3339 timestamp (or date) to a Date. */
export const assertIsoDate = (v: unknown, what: string): Date => {
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(v) ? new Date(v) : null
  return d && !Number.isNaN(d.getTime()) ? d : bad(what, v, 'must be an ISO 8601 date')
}

const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

export const assertSemver = (v: unknown, what: string): string =>
  typeof v === 'string' && v.length <= 64 && SEMVER_RE.test(v) ? v : fail('VALIDATION', `${what} must be SemVer`, { [what]: String(v) })

const ENGINES: readonly Engine[] = ['apache', 'openlitespeed']
const MPMS: readonly ApacheMpm[] = ['itk', 'prefork']
const NAMESERVERS_MAX = 8

const port = (v: unknown, what: string): number => assertInt(v, 1, 65535, what)

/** Workers follow core's nginx/Apache rules; ports must be distinct and off 80/443. */
export const validateServerSettings = (s: ServerSettings): ServerSettings => {
  if (typeof s !== 'object' || s === null) return fail('VALIDATION', 'settings must be an object')
  if (!Array.isArray(s.nameservers) || s.nameservers.length > NAMESERVERS_MAX) fail('VALIDATION', `at most ${NAMESERVERS_MAX} nameservers`)
  const ports = {
    panelPort: port(s.panelPort, 'panelPort'),
    sshPort: port(s.sshPort, 'sshPort'),
    backendPort: port(s.backendPort, 'backendPort'),
    backendTlsPort: port(s.backendTlsPort, 'backendTlsPort'),
  }
  const used = Object.values(ports)
  if (new Set([...used, 80, 443]).size !== used.length + 2) fail('VALIDATION', 'panel, ssh and backend ports must differ from each other and from 80/443')
  const nameservers = s.nameservers.map((x) => validateDomainName(x))
  if (new Set(nameservers).size !== nameservers.length) fail('VALIDATION', 'nameservers must be distinct')
  return {
    hostname: validateDomainName(s.hostname),
    nameservers,
    adminEmail: assertEmail(s.adminEmail, 'adminEmail'),
    engine: oneOf(s.engine, ENGINES, 'engine'),
    apacheMpm: oneOf(s.apacheMpm, MPMS, 'apacheMpm'),
    ...ports,
    nginx: validateNginxWorkers(s.nginx),
    apache: validateApacheWorkers(s.apache),
  }
}

const ACL_SET: Record<ResellerAcl, true> = {
  'create-account': true,
  'edit-account': true,
  'suspend-account': true,
  'terminate-account': true,
  'change-plan': true,
  'manage-plans': true,
  'manage-feature-lists': true,
  'manage-dns': true,
  'manage-ssl': true,
  'change-password': true,
  'list-accounts': true,
  'allow-unlimited-plans': true,
  'allow-oversell': true,
  transfer: true,
}

export const RESELLER_ACLS = Object.keys(ACL_SET) as readonly ResellerAcl[]

export const assertResellerAcl = (acl: unknown): ResellerAcl[] => {
  if (!Array.isArray(acl)) return fail('VALIDATION', 'acl must be a list')
  for (const a of acl) {
    if (typeof a !== 'string' || !Object.hasOwn(ACL_SET, a)) fail('VALIDATION', 'unknown reseller privilege', { acl: String(a).slice(0, 64) })
  }
  return [...new Set(acl as ResellerAcl[])].sort()
}

export const DB_PRIVILEGES = [
  'ALL PRIVILEGES',
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'INDEX',
  'ALTER',
  'CREATE TEMPORARY TABLES',
  'LOCK TABLES',
  'EXECUTE',
  'CREATE VIEW',
  'SHOW VIEW',
  'CREATE ROUTINE',
  'ALTER ROUTINE',
  'EVENT',
  'TRIGGER',
  'REFERENCES',
] as const

export type DbPrivilege = (typeof DB_PRIVILEGES)[number]

export const assertDbPrivileges = (privs: unknown): DbPrivilege[] => {
  if (!Array.isArray(privs) || privs.length === 0) return fail('VALIDATION', 'privileges must be a non-empty list')
  for (const p of privs) {
    if (!(DB_PRIVILEGES as readonly string[]).includes(p as string)) fail('VALIDATION', 'unknown privilege', { privilege: String(p) })
  }
  const set = [...new Set(privs as DbPrivilege[])]
  return set.includes('ALL PRIVILEGES') ? ['ALL PRIVILEGES'] : set.sort()
}
