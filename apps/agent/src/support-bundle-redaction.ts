import { createHmac, randomBytes } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'
import { msgid } from '@xpanel/core'

/** `text` is an English source message; the web UI translates it. */
export interface SupportRedactionRule { id: string; text: string }

/** Applied in this order to every key and string value of the bundle content. Each output is a fixed point of the whole pass. */
export const SUPPORT_REDACTION_RULES: readonly SupportRedactionRule[] = Object.freeze([
  { id: 'pem-block', text: msgid('PEM blocks (private keys, certificates, public keys) become [redacted:pem], including a block cut off by a length limit.') },
  { id: 'authorization-header', text: msgid('Authorization and Proxy-Authorization values are replaced up to the end of the line.') },
  { id: 'cookie-header', text: msgid('Cookie and Set-Cookie values are replaced up to the end of the line.') },
  { id: 'bearer-token', text: msgid('Bearer token values are replaced.') },
  { id: 'url-credentials', text: msgid('user:password@ credentials inside URLs are replaced.') },
  { id: 'panel-token', text: msgid('Panel API tokens (xp_...) and JSON Web Tokens become [redacted:token].') },
  { id: 'secret-assignment', text: msgid('Values assigned with = or : to a name containing token, secret, password, passwd, pwd, api key, access key, private key, credential or session id become [redacted].') },
  { id: 'email-address', text: msgid('Email addresses become [email:<hash>].') },
  { id: 'ip-address', text: msgid('IPv6 and IPv4 addresses become [ipv6:<hash>] and [ipv4:<hash>].') },
])
export const SUPPORT_HASH_RULE = Object.freeze({
  text: msgid('A hash is the first 12 hex digits of HMAC-SHA256 under a random key created for this bundle and then discarded. The same value maps to the same hash within one bundle; hashes cannot be reversed or compared across bundles.'),
})

// Every pattern is bounded or anchored on a literal so a hostile 4 KiB log line stays linear.
const PEM = /-----BEGIN [A-Z0-9 ]{1,64}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,64}-----|$)/g
const AUTHORIZATION = /\b((?:proxy-)?authorization)\b(["']?\s*[:=]\s*)[^\r\n]*/gi
const COOKIE = /\b((?:set-)?cookie)\b(["']?\s*[:=]\s*)[^\r\n]*/gi
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,256}:[^\s/@]{0,256}@/gi
const PANEL_TOKEN = /\bxp_[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g
const SECRET_ASSIGNMENT = /(token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|session[_-]?id)([A-Za-z0-9_.-]{0,32})(["']?\s*[:=]\s*)("[^"\r\n]*"?|'[^'\r\n]*'?|[^\s"',;&]+)/gi
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g
const IPV6_RUN = /[0-9A-Fa-f:.]+/g
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g

export type SupportRedactor = (text: string) => string

/** The key never leaves this closure; tests pass a fixed key for stable hashes. */
export function createSupportRedactor(key: Uint8Array = randomBytes(32)): SupportRedactor {
  const hash = (kind: string, value: string): string => '[' + kind + ':' + createHmac('sha256', key).update(kind + '\u0000' + value.toLowerCase()).digest('hex').slice(0, 12) + ']'
  const ipv6 = (run: string): string => {
    if (run.split(':').length < 3) return run
    // A run can carry a sentence's trailing colon or period, or a leading field separator.
    const end = run.replace(/[.:]+$/, '').length, lead = run.startsWith(':') && !run.startsWith('::') ? 1 : 0
    for (const [from, to] of [[0, run.length], [0, end], [lead, run.length], [lead, end]] as const) {
      const core = run.slice(from, to)
      if (core.length > 1 && isIPv6(core)) return run.slice(0, from) + hash('ipv6', core) + run.slice(to)
    }
    return run
  }
  return text => text
    .replace(PEM, '[redacted:pem]')
    .replace(AUTHORIZATION, '$1$2[redacted]')
    .replace(COOKIE, '$1$2[redacted]')
    .replace(BEARER, '$1 [redacted]')
    .replace(URL_CREDENTIALS, '$1[redacted]@')
    .replace(PANEL_TOKEN, '[redacted:token]')
    .replace(SECRET_ASSIGNMENT, '$1$2$3[redacted]')
    .replace(EMAIL, match => hash('email', match))
    .replace(IPV6_RUN, ipv6)
    .replace(IPV4, match => isIPv4(match) ? hash('ipv4', match) : match)
}

/** Redacts every string and every object key of JSON-shaped data. */
export function redactSupportValue<T>(value: T, redact: SupportRedactor): T {
  const walk = (item: unknown): unknown => typeof item === 'string' ? redact(item)
    : Array.isArray(item) ? item.map(walk)
      : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [redact(key), walk(entry)]))
        : item
  return walk(value) as T
}

/** True when the redaction pass would change nothing: proof the pass ran, independent of the hash key. */
export const isSupportRedacted = (value: unknown): boolean => JSON.stringify(redactSupportValue(value, createSupportRedactor())) === JSON.stringify(value)
