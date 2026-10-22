// Certificate placement, host matching, AutoSSL selection and ACME order planning.
// Files go exactly where the edge renderers read them (edge/paths.ts): certificates under
// <sslDir>/<certificate id>/, http-01 answers in the directory Nginx aliases for
// /.well-known/acme-challenge/. dns-01 writes TXT through PowerDNS.
import type { Certificate, HostAction, RenderedFile } from '@xpanel/core'
import { fail, normalizeHost, validateDomainName, validateWildcardName } from '@xpanel/core'
import { X509Certificate, createHash, createPrivateKey, type KeyObject } from 'node:crypto'
import { DEFAULT_TLS, XP_PATHS, certPaths } from '../edge/paths.ts'
import { acmeChallengeFqdn, acmeTxtChange, normalizeZone, type PdnsOptions, type PdnsRequest } from './dns.ts'
import { assertDate, assertInt, assertString, invalid, labeled } from './validate.ts'

export const ACME_CHALLENGE_PATH = '/.well-known/acme-challenge/'
/** Let's Encrypt's SAN limit per order */
export const MAX_CERT_NAMES = 100

// ---- names --------------------------------------------------------------------------------

/** `example.com` or `*.example.com` (wildcard only as the whole leftmost label), canonical. */
export const normalizeCertName = (v: unknown): string => {
  const s = assertString('certificate name', v, 256)
  return labeled('certificate name', s, () => (s.startsWith('*.') ? validateWildcardName(s) : validateDomainName(s)))
}

/**
 * RFC 6125 matching: exact name, or `*.base` for exactly one extra label. A wildcard
 * never covers the apex (list `example.com` too) nor deeper names (`a.b.example.com`).
 */
export const coversHost = (names: readonly string[], host: string): boolean => {
  const h = normalizeHost(host)
  if (!h) return false
  return names.some((raw) => {
    if (typeof raw !== 'string') return false
    const n = raw.toLowerCase().replace(/\.$/, '')
    if (n === h) return true
    if (!n.startsWith('*.')) return false
    const dot = h.indexOf('.')
    return dot > 0 && h.slice(dot + 1) === n.slice(2)
  })
}

export interface CertPaths {
  dir: string
  fullchain: string
  privkey: string
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

/** The edge's <sslDir>/<id>/{fullchain,privkey}.pem for one certificate id. */
export const certFiles = (certId: string): CertPaths => {
  const p = labeled('certificate id', certId, () => certPaths(certId))
  const dir = dirOf(p.cert)
  // the installer's self-signed fallback lives there; an issued certificate must not replace it
  if (dir === dirOf(DEFAULT_TLS.cert)) return invalid('certificate id', certId, 'is reserved for the default certificate')
  return { dir, fullchain: p.cert, privkey: p.key }
}

const PEM_CERT_RE = /^(?:-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]{1,76}\r?\n)+-----END CERTIFICATE-----\r?\n?)+$/
const PEM_KEY_RE = /^-----BEGIN (RSA |EC )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]{1,76}\r?\n)+-----END \1PRIVATE KEY-----\r?\n?$/

export const assertFullchainPem = (pem: unknown): string => {
  const s = assertString('certificate chain', pem, 256 * 1024).trim()
  return PEM_CERT_RE.test(`${s}\n`) ? `${s}\n` : invalid('certificate chain', '', 'must be one or more PEM CERTIFICATE blocks and nothing else')
}

export const assertPrivateKeyPem = (pem: unknown): string => {
  const s = assertString('private key', pem, 64 * 1024).trim()
  if (s.includes('ENCRYPTED')) return invalid('private key', '[redacted]', 'is passphrase-protected; servers cannot load it unattended')
  return PEM_KEY_RE.test(`${s}\n`) ? `${s}\n` : invalid('private key', '[redacted]', 'must be one unencrypted PEM private key')
}

const parseCert = (block: string): X509Certificate => {
  try {
    return new X509Certificate(block)
  } catch {
    return invalid('certificate chain', '', 'contains a block that is not a parsable X.509 certificate')
  }
}

/**
 * Every chain block must be real X.509 and the leaf (first block) must match the key. A
 * mismatch would only surface in `nginx -t`, which then holds back every later generation
 * on the server, so it is refused here.
 */
export const assertKeyPair = (fullchain: string, privkey: string): void => {
  const blocks = fullchain.split(/(?<=-----END CERTIFICATE-----)\r?\n?/).filter((b) => b.trim() !== '')
  const leaf = blocks.map(parseCert)[0]
  let key: KeyObject
  try {
    key = createPrivateKey(privkey)
  } catch {
    return invalid('private key', '[redacted]', 'is not a parsable private key')
  }
  if (!leaf || !leaf.checkPrivateKey(key)) invalid('private key', '[redacted]', 'does not match the first certificate of the chain')
}

/**
 * Directory 0700 root, fullchain 0644, privkey 0600 root. Nginx, Apache, Postfix and
 * Dovecot load keys in their root master or pre-jail phase, so nothing else needs access.
 */
export const certInstall = (certId: string, pem: { fullchain: string; privkey: string }): { actions: HostAction[]; files: RenderedFile[] } => {
  const p = certFiles(certId)
  const fullchain = assertFullchainPem(pem.fullchain)
  const privkey = assertPrivateKeyPem(pem.privkey)
  assertKeyPair(fullchain, privkey)
  return {
    actions: [
      { kind: 'ensure-dir', path: XP_PATHS.sslDir, mode: 0o755, owner: 'root', group: 'root' },
      { kind: 'ensure-dir', path: p.dir, mode: 0o700, owner: 'root', group: 'root' },
    ],
    files: [
      { path: p.fullchain, content: fullchain, mode: 0o644, owner: 'root', group: 'root' },
      { path: p.privkey, content: privkey, mode: 0o600, owner: 'root', group: 'root' },
    ],
  }
}

// ---- selection ----------------------------------------------------------------------------

const DAY_MS = 86400000

const expiry = (c: Certificate): number => {
  const t = Date.parse(c.notAfter)
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t
}

/**
 * AutoSSL candidates: autoRenew certificates we can reissue (ACME or self-signed
 * placeholders; never uploaded ones) expiring within `days`, soonest first. An
 * unparsable notAfter counts as expired.
 */
export const certsForAutoRenew = (certs: readonly Certificate[], now: Date, days = 30): Certificate[] => {
  const d = assertInt('renewal window (days)', days, 0, 365)
  const limit = assertDate('now', now).getTime() + d * DAY_MS
  return certs
    .filter((c) => c.autoRenew && c.source !== 'upload' && expiry(c) <= limit)
    .sort((a, b) => expiry(a) - expiry(b))
}

/** Best certificate for a host: unexpired, exact name over wildcard, then latest expiry. */
export const selectCertificate = (certs: readonly Certificate[], host: string, now: Date): Certificate | null => {
  const t = assertDate('now', now).getTime()
  const h = normalizeHost(host)
  if (!h) return null
  const live = certs.filter((c) => expiry(c) > t && coversHost(c.names, h))
  const exact = (c: Certificate): number => (c.names.some((n) => n.toLowerCase().replace(/\.$/, '') === h) ? 1 : 0)
  live.sort((a, b) => exact(b) - exact(a) || expiry(b) - expiry(a))
  return live[0] ?? null
}

// ---- ACME ---------------------------------------------------------------------------------

export type AcmeChallengeType = 'http-01' | 'dns-01'

export interface AcmeHttpStep {
  identifier: string
  challenge: 'http-01'
  /** directory Nginx serves for urlPath: the token file goes directly inside it */
  webroot: string
  /** URL path the CA fetches, token appended */
  urlPath: string
}

export interface AcmeDnsStep {
  identifier: string
  challenge: 'dns-01'
  zone: string
  /** `_acme-challenge.<base>` without trailing dot */
  recordName: string
}

export interface AcmeOrderPlan {
  identifiers: string[]
  challenge: AcmeChallengeType
  steps: (AcmeHttpStep | AcmeDnsStep)[]
}

export interface AcmePlanOptions {
  /** zones hosted on our PowerDNS (dns-01) */
  zones?: string[]
}

const longestZone = (fqdn: string, zones: string[]): string | null =>
  zones.filter((z) => fqdn === z || fqdn.endsWith(`.${z}`)).sort((a, b) => b.length - a.length)[0] ?? null

/**
 * Plan an order. http-01 cannot validate wildcards; dns-01 needs every name's
 * `_acme-challenge` inside a zone we host.
 */
export const planAcmeOrder = (names: string[], challenge: AcmeChallengeType, o: AcmePlanOptions = {}): AcmeOrderPlan => {
  if (!Array.isArray(names) || names.length === 0) return invalid('certificate names', names, 'are empty')
  if (names.length > MAX_CERT_NAMES) return invalid('certificate names', names.length, `allow at most ${MAX_CERT_NAMES}`)
  const ids = [...new Set(names.map(normalizeCertName))].sort((a, b) => {
    const base = (n: string): string => (n.startsWith('*.') ? n.slice(2) : n)
    return base(a).localeCompare(base(b)) || (a.startsWith('*.') ? 1 : 0) - (b.startsWith('*.') ? 1 : 0)
  })
  if (challenge === 'http-01') {
    const wild = ids.find((n) => n.startsWith('*.'))
    if (wild) return invalid('ACME challenge', wild, 'wildcard names need dns-01')
    const webroot = XP_PATHS.acmeDir
    return { identifiers: ids, challenge, steps: ids.map((identifier) => ({ identifier, challenge, webroot, urlPath: ACME_CHALLENGE_PATH })) }
  }
  if (challenge !== 'dns-01') return invalid('ACME challenge', challenge, 'must be http-01 or dns-01')
  const zones = (o.zones ?? []).map(normalizeZone)
  const steps = ids.map((identifier): AcmeDnsStep => {
    const recordName = acmeChallengeFqdn(identifier)
    const zone = longestZone(recordName, zones)
    if (!zone) return fail('PRECONDITION_FAILED', `no hosted DNS zone contains ${recordName}`, { identifier })
    return { identifier, challenge, zone, recordName }
  })
  return { identifiers: ids, challenge, steps }
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/

/**
 * http-01 response file. The edge's Nginx maps /.well-known/acme-challenge/ onto the ACME
 * directory with `alias`, so the token sits directly in it; world-readable for the workers.
 */
export const http01File = (token: string, keyAuthorization: string): RenderedFile => {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return invalid('ACME token', token, 'must be 16-256 base64url characters')
  if (typeof keyAuthorization !== 'string' || !new RegExp(`^${token}\\.[A-Za-z0-9_-]{43}$`).test(keyAuthorization)) {
    return invalid('ACME key authorization', '[redacted]', 'must be <token>.<thumbprint>')
  }
  return { path: `${XP_PATHS.acmeDir}/${token}`, content: keyAuthorization, mode: 0o644, owner: 'root', group: 'root' }
}

/** dns-01 TXT value: base64url(SHA-256(keyAuthorization)) (RFC 8555 §8.4). */
export const dns01Value = (keyAuthorization: string): string => {
  if (typeof keyAuthorization !== 'string' || !/^[A-Za-z0-9_-]{16,256}\.[A-Za-z0-9_-]{43}$/.test(keyAuthorization)) {
    return invalid('ACME key authorization', '[redacted]', 'must be <token>.<thumbprint>')
  }
  return createHash('sha256').update(keyAuthorization).digest('base64url')
}

/**
 * PowerDNS PATCHes for a dns-01 plan. `values` maps identifier → TXT value. Apex and
 * wildcard share `_acme-challenge.<base>`, so their values are published together and the
 * rrset is removed once validation is over.
 */
export const dns01Changes = (plan: AcmeOrderPlan, values: Record<string, string>, o: PdnsOptions = {}): { publish: PdnsRequest[]; cleanup: PdnsRequest[] } => {
  if (plan.challenge !== 'dns-01') return invalid('ACME plan', plan.challenge, 'is not dns-01')
  const byName = new Map<string, { zone: string; values: string[] }>()
  for (const s of plan.steps) {
    if (s.challenge !== 'dns-01') continue
    const v = values[s.identifier]
    if (v === undefined) return invalid('ACME TXT value', s.identifier, 'is missing for this identifier')
    const g = byName.get(s.recordName) ?? { zone: s.zone, values: [] }
    g.values.push(v)
    byName.set(s.recordName, g)
  }
  const publish: PdnsRequest[] = []
  const cleanup: PdnsRequest[] = []
  for (const [name, g] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    publish.push(acmeTxtChange(g.zone, name, g.values, 'add', o))
    cleanup.push(acmeTxtChange(g.zone, name, g.values, 'delete', o))
  }
  return { publish, cleanup }
}
