import { posix } from 'node:path'
import { USERNAME_MAX, fail, isXpanelError, parseServiceLogin, validateDomainName, validateHome, validateUsername } from '@xpanel/core'
import type { Principal } from '@xpanel/core'
import { services } from '@xpanel/render'

// Naming rules come from @xpanel/core (usernames, domains, mailboxes, homes) and
// @xpanel/render (database names, external addresses). This file adds what the
// long-running flows need on top: canonical-form checks for untrusted manifests, safe
// absolute paths, digests and ids. Every validator rejects; none repairs input.

/** C0/C1 controls, line separators, bidi overrides and the BOM (same set the core audit rules escape). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const CONTROL_ALL = new RegExp(CONTROL.source, 'g')
export const hasControlChars = (s: string): boolean => CONTROL.test(s)

/** Bounded and free of control characters: error messages end up in logs and the UI. */
const preview = (v: unknown): string => {
  const s = (typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v))).slice(0, 81).replace(CONTROL_ALL, '?')
  return s.length > 80 ? `${s.slice(0, 80)}...` : s
}

export const invalid = (what: string, v: unknown, why = 'is invalid'): never =>
  fail('VALIDATION', `${what} ${why}: ${preview(v)}`, { what })

/** Boolean form of a throwing validator; only validation errors count as "no". */
export const passes = (validate: (v: unknown) => unknown) => (v: unknown): boolean => {
  try {
    validate(v)
    return true
  } catch (e) {
    if (isXpanelError(e)) return false
    throw e
  }
}

/** Same as the core rule but the input must already be canonical: manifests are never rewritten. */
const canonical = <T>(what: string, v: unknown, normalize: (v: unknown) => T, form: (t: T) => string): string => {
  const out = form(normalize(v))
  return out === v ? out : invalid(what, v, 'is not in canonical form')
}

export const assertUsername = (v: unknown, what = 'username'): string => {
  try {
    return validateUsername(v)
  } catch (e) {
    if (isXpanelError(e)) return fail('VALIDATION', `invalid ${what}: ${e.message}`, { what })
    throw e
  }
}
export const isUsername = passes(validateUsername)

export const assertDomain = (v: unknown, what = 'domain'): string => canonical(what, v, validateDomainName, (d) => d)
export const isDomain = passes(assertDomain)

/** local@domain on a hosted domain (mailbox, forwarder source). */
export const assertHostedAddress = (v: unknown, what = 'address'): string =>
  canonical(what, v, parseServiceLogin, (p) => `${p.local}@${p.domain}`)
export const isHostedAddress = passes(assertHostedAddress)

/** Any deliverable address (forward targets, contact email). */
export const assertAddress = (v: unknown, what = 'email address'): string =>
  canonical(what, v, (x) => services.normalizeEmail(x, what), (p) => p.address)
export const isAddress = passes(assertAddress)

export const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1)

export const assertDatabaseName = (v: unknown, owner: string): string =>
  canonical('database name', v, (x) => services.assertDatabaseName(x, owner), (n) => n)

export const assertDbUserName = (v: unknown, owner: string): string =>
  canonical('database user', v, (x) => services.assertDbUser(x, owner), (n) => n)

// Names that come from another server or an archive may be reserved here (an account called
// `admin` elsewhere). They are checked for syntax only; the local rules apply to the name the
// import actually creates.
const USERNAME_SYNTAX = new RegExp(`^[a-z][a-z0-9]{0,${USERNAME_MAX - 1}}$`)
export const isUsernameSyntax = (v: unknown): v is string => typeof v === 'string' && USERNAME_SYNTAX.test(v)

/** `<owner>_<suffix>` on the source side, within the MariaDB limit `max`. */
export const assertSourceDbName = (v: unknown, owner: string, max: number, what = 'database name'): string => {
  const ok = isUsernameSyntax(owner) && typeof v === 'string' && v.length <= max && v.startsWith(`${owner}_`) && /^[a-z0-9_]+$/.test(v.slice(owner.length + 1))
  return ok ? (v as string) : invalid(what, v, `is not ${owner}_<suffix> within ${max} characters`)
}

export const isIpv4 = passes((v) => canonical('IPv4 address', v, (x) => services.canonicalIpv4(x), (a) => a))

const SAFE_SEGMENT = /^[A-Za-z0-9._@+-]+$/

/** Absolute, normalized POSIX path made of conservative characters only. */
export const isSafeAbsPath = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length < 2 || v.length > 4096 || !v.startsWith('/')) return false
  if (posix.normalize(v) !== v || v.endsWith('/')) return false
  return v.slice(1).split('/').every((s) => SAFE_SEGMENT.test(s) && s !== '.' && s !== '..')
}

export const assertSafeAbsPath = (v: unknown, what = 'path'): string => (isSafeAbsPath(v) ? v : invalid(what, v))

/** /home, /home2, ... or anything below them: account homes, and the mail stored inside them. */
export const isUnderHomes = (p: string): boolean => /^\/home\d*(\/|$)/.test(p)

/** True when `path` is `root` or inside it. Both must already be normalized. */
export const isUnder = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)

/** Home from the core rule, which also requires the last segment to be the account's own name. */
export const assertAccountHome = (home: unknown, username: string): string => validateHome(home, username)

const SHA256 = /^[0-9a-f]{64}$/
export const isSha256 = (v: unknown): v is string => typeof v === 'string' && SHA256.test(v)

export const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
export const assertId = (v: unknown, what = 'id'): string => (isId(v) ? v : invalid(what, v))

export const assertText = (v: unknown, what: string, max: number): string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !hasControlChars(v) ? v : invalid(what, v)

export const isIsoDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) && !Number.isNaN(Date.parse(v))

/** Compact UTC stamp used in snapshot, staging and backup names: 20261022T013500Z. */
export const compactStamp = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')
export const isCompactStamp = (v: unknown): v is string => typeof v === 'string' && /^\d{8}T\d{6}Z$/.test(v)

const PRINCIPAL_KINDS: readonly Principal['kind'][] = ['root', 'reseller', 'user']

const assertPrincipal = (p: unknown): Principal => {
  const o = p as Record<string, unknown> | null
  if (typeof o !== 'object' || o === null || !PRINCIPAL_KINDS.includes(o.kind as Principal['kind'])) return invalid('principal', p)
  assertText(o.id, 'principal id', 128)
  assertText(o.username, 'principal username', 128)
  if (o.kind === 'user') assertText(o.accountId, 'principal account', 128)
  return p as Principal
}

export const assertRoot = (p: unknown, action: string): Principal => {
  const principal = assertPrincipal(p)
  return principal.kind === 'root' ? principal : fail('FORBIDDEN', `only root may ${action}`, { kind: principal.kind })
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Untrusted objects may carry only the documented keys. */
export const exactKeys = (o: Record<string, unknown>, keys: readonly string[], what: string): void => {
  const extra = Object.keys(o).filter((k) => !keys.includes(k))
  if (extra.length) fail('VALIDATION', `${what} has unknown fields: ${extra.slice(0, 5).map((k) => preview(k)).join(', ')}`)
}
