// Validators for every name that reaches a config file, path, SQL statement or DNS payload.
// Account, domain, mailbox, home and IP rules are core's (packages/core/src/rules): these
// wrappers only re-label core's error with the renderer's field name. What only renderers
// need lives here: DNS names with `_` labels, remote addresses, system paths and dates.
import {
  MAX_ACCOUNT_UID,
  MIN_ACCOUNT_UID,
  fail,
  formatCidr,
  isXpanelError,
  parseIp,
  parseServiceLogin,
  validateDomainName,
  validateEmailLocalPart,
  validateHome,
  validateUsername,
  type IpAddress,
} from '@xpanel/core'

export const invalid = (what: string, value: unknown, why: string): never =>
  fail('VALIDATION', `invalid ${what}: ${why}`, {
    what,
    value: typeof value === 'string' ? value.slice(0, 256) : String(value),
  })

/** Runs a core rule and re-labels its VALIDATION error with the renderer's field name. */
export const labeled = <T>(what: string, value: unknown, check: () => T): T => {
  try {
    return check()
  } catch (e) {
    if (isXpanelError(e) && e.code === 'VALIDATION') return invalid(what, value, e.message)
    throw e
  }
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/

/** DNS owner/target labels may carry `_` (service labels, `_domainkey`, `_acme-challenge`). */
export const DNS_LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/

export const assertString = (what: string, v: unknown, max: number): string => {
  if (typeof v !== 'string') return invalid(what, v, 'must be a string')
  if (v.length > max) return invalid(what, v, `longer than ${max} characters`)
  return v
}

export const hasControl = (v: string): boolean => CONTROL_RE.test(v)

export const assertNoControl = (what: string, v: string): string =>
  hasControl(v) ? invalid(what, v, 'contains control characters or newlines') : v

export const assertWellFormed = (what: string, v: string): string =>
  LONE_SURROGATE_RE.test(v) ? invalid(what, v, 'is not well-formed Unicode') : v

/** Single-line printable text (any script); rejects control characters and newlines. */
export const assertLine = (what: string, v: unknown, max: number): string =>
  assertWellFormed(what, assertNoControl(what, assertString(what, v, max)))

export const assertInt = (what: string, v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) return invalid(what, v, 'must be an integer')
  if (v < min || v > max) return invalid(what, v, `must be within ${min}..${max}`)
  return v
}

export const assertDate = (what: string, v: unknown): Date =>
  v instanceof Date && !Number.isNaN(v.getTime()) ? v : invalid(what, v, 'is not a valid date')

// ---- names --------------------------------------------------------------------------------

/** Hosted domain or host name in canonical form (lowercase, punycode, no trailing dot). */
export const normalizeHostname = (v: unknown, what = 'hostname'): string => labeled(what, v, () => validateDomainName(v))

/**
 * DNS name whose leading labels may contain `_` (`_dmarc.example.com`,
 * `sel._domainkey.example.com`, `host_name.example.com`). Everything after the last such
 * label must be a valid domain name.
 */
export const normalizeDnsName = (v: unknown, what = 'DNS name'): string => {
  const raw = assertString(what, v, 254)
  if (!raw.includes('_')) return normalizeHostname(raw, what)
  if (!PRINTABLE_ASCII_RE.test(raw)) return invalid(what, raw, 'must be ASCII without spaces')
  const s = (raw.endsWith('.') ? raw.slice(0, -1) : raw).toLowerCase()
  if (s.length > 253) return invalid(what, raw, 'longer than 253 characters')
  const labels = s.split('.')
  const last = labels.reduce((at, l, i) => (l.includes('_') ? i : at), -1)
  for (const l of labels.slice(0, last + 1)) {
    if (!DNS_LABEL_RE.test(l)) return invalid(what, raw, `bad label "${l.slice(0, 64)}"`)
  }
  const host = normalizeHostname(labels.slice(last + 1).join('.'), what)
  return `${labels.slice(0, last + 1).join('.')}.${host}`
}

/** Syntax and reserved-name policy are core's validateUsername. */
export const assertUsername = (v: unknown): string => labeled('username', v, () => validateUsername(v))

/** Account uid/gid inside core's account range (never root, a system id or nobody). */
export const assertAccountId = (what: 'uid' | 'gid', v: unknown): number => assertInt(what, v, MIN_ACCOUNT_UID, MAX_ACCOUNT_UID)

export const assertHome = (v: unknown): string => labeled('home directory', v, () => validateHome(v))

const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/

/** Absolute config/system path (from an OsProfile or option): ASCII, normalized, no `..`. */
export const assertAbsPath = (what: string, v: unknown): string => {
  const s = assertString(what, v, 1024)
  if (s === '/' || !s.startsWith('/') || s.endsWith('/')) return invalid(what, s, 'must be an absolute path without a trailing slash')
  for (const seg of s.slice(1).split('/')) {
    if (!PATH_SEGMENT_RE.test(seg) || seg === '.' || seg === '..') return invalid(what, s, `bad segment "${seg}"`)
  }
  return s
}

export interface AccountRef {
  username: string
  uid: number
  gid: number
  home: string
}

export const assertAccount = (a: AccountRef): AccountRef => {
  if (!a || typeof a !== 'object') return invalid('account', a, 'is required')
  return {
    username: assertUsername(a.username),
    uid: assertAccountId('uid', a.uid),
    gid: assertAccountId('gid', a.gid),
    home: assertHome(a.home),
  }
}

// ---- mail addresses -------------------------------------------------------------------

/** Hosted mailbox / forwarder local part (core's rule: no `+`, no quoting, no `..`). */
export const normalizeMailboxLocal = (v: unknown, what = 'local part'): string => labeled(what, v, () => validateEmailLocalPart(v))

export interface EmailParts {
  local: string
  domain: string
  address: string
}

/** An address on a hosted domain (mailbox, forwarder source, sieve :from). */
export const normalizeHostedEmail = (v: unknown, what = 'email address'): EmailParts => {
  const { local, domain } = labeled(what, v, () => parseServiceLogin(v))
  return { local, domain, address: `${local}@${domain}` }
}

/** Remote destination local part: RFC 5322 dot-atom minus quote, backtick, pipe and `$`. */
const REMOTE_LOCAL_RE = /^[a-z0-9!#%&*+/=?^_{}~-]+(?:\.[a-z0-9!#%&*+/=?^_{}~-]+)*$/

/** Any deliverable address (forward targets, redirects, DMARC/SOA contacts). */
export const normalizeEmail = (v: unknown, what = 'email address'): EmailParts => {
  const raw = assertString(what, v, 320)
  const at = raw.lastIndexOf('@')
  if (at <= 0 || at === raw.length - 1) return invalid(what, raw, 'must look like local@domain')
  const l = raw.slice(0, at)
  if (!PRINTABLE_ASCII_RE.test(l)) return invalid(what, l, 'local part must be ASCII without spaces')
  const local = l.toLowerCase()
  if (local.length > 64 || !REMOTE_LOCAL_RE.test(local)) return invalid(what, l, 'local part is not a plain dot-atom')
  const domain = normalizeHostname(raw.slice(at + 1), `${what} domain`)
  const address = `${local}@${domain}`
  if (address.length > 254) return invalid(what, address, 'longer than 254 characters')
  return { local, domain, address }
}

// ---- IP addresses -----------------------------------------------------------------------

/** Canonical text (RFC 5952 for IPv6) of an address parsed by core's parseIp. */
export const ipText = (ip: IpAddress): string => formatCidr({ ...ip, prefix: ip.version === 4 ? 32 : 128 })

export const canonicalIpv4 = (v: unknown, what = 'IPv4 address'): string => {
  const s = assertString(what, v, 64)
  const ip = s.includes(':') ? null : parseIp(s)
  return ip?.version === 4 ? ipText(ip) : invalid(what, s, 'is not a dotted-quad IPv4 address')
}

/** IPv4-mapped addresses are refused: core reads them as IPv4, so they belong in an A record. */
export const canonicalIpv6 = (v: unknown, what = 'IPv6 address'): string => {
  const s = assertString(what, v, 64)
  const ip = parseIp(s)
  if (ip?.version === 6) return ipText(ip)
  return invalid(what, s, ip ? 'is an IPv4 or IPv4-mapped address' : 'is not an IPv6 address')
}
