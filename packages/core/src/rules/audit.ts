// Audit entries for every management operation. Secrets never reach the log: any key that
// looks like a credential is redacted at every depth, credentials embedded in values (URL
// userinfo, PEM private keys, auth headers, `password=...` assignments) are masked, and
// strings are escaped so a hostile value cannot forge extra log lines, reorder the text with
// bidi controls, or carry a lone surrogate that Postgres jsonb would refuse.
import type { AuditEntry, Principal } from '../types.ts'
import { hasControlChars, invalid, isRecord, utf8Length } from './check.ts'

/** The STANDARDS minimum (pass|secret|token|key) plus other names credentials travel under. */
export const REDACT_KEY_RE = /pass|pwd|secret|token|key|auth|cookie|credential|otp|jwt|salt|signature|private/i
export const REDACTED = '[REDACTED]'
export const MAX_AUDIT_STRING = 2048
/** Serialized size of `detail`; the audit table accepts 64 KiB, this leaves room for the rest of the row. */
export const MAX_AUDIT_DETAIL_BYTES = 32 * 1024

interface Budget {
  string: number
  items: number
  depth: number
}

// Tried in order until the serialized detail fits MAX_AUDIT_DETAIL_BYTES.
const BUDGETS: readonly Budget[] = [
  { string: MAX_AUDIT_STRING, items: 200, depth: 8 },
  { string: 256, items: 32, depth: 4 },
  { string: 64, items: 8, depth: 2 },
]

const ESCAPE_RE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

const escapeControls = (s: string): string => s.replace(ESCAPE_RE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** First `n` code units without splitting a surrogate pair. */
const cut = (s: string, n: number): string => {
  const head = s.slice(0, n)
  return /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head
}

export const cleanString = (s: string, max = MAX_AUDIT_STRING): string => {
  // bound the work before escaping: the result is truncated to `max` anyway
  const escaped = escapeControls(s.length > max ? s.slice(0, max + 1) : s)
  return escaped.length > max ? `${cut(escaped, max)}...[truncated]` : escaped
}

// `mysql://bob:hunter2@db/x`, `https://ghp_token@github.com/...`: everything before the last
// `@` of the authority. The scheme is bounded so the scan stays linear.
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#]*@/gi
const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g
// an Authorization header value copied into a message or a header dump
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,}/gi
// `password=x`, `--db-pass=x`, `?token=x&a=b`, `"apiKey": "x"`, `client_secret: x`
const ASSIGNMENT_RE =
  /([A-Za-z0-9_.-]{0,40}(?:pass|pwd|secret|token|apikey|api_key|api-key|access_key|private_key)[A-Za-z0-9_.-]{0,40}["']?\s{0,8}[=:]\s{0,8})("[^"]{0,1024}"|'[^']{0,1024}'|[^\s"'&;,)}\]]{1,1024})/gi

/** Masks credentials that travel inside a value rather than under a credential-like key. */
export const redactInlineSecrets = (s: string): string =>
  s
    .replace(PEM_PRIVATE_KEY_RE, REDACTED)
    .replace(URL_USERINFO_RE, `$1${REDACTED}@`)
    .replace(AUTH_SCHEME_RE, `$1 ${REDACTED}`)
    .replace(ASSIGNMENT_RE, `$1${REDACTED}`)

// Redaction runs on the uncut text (a cut could split a secret past recognition) but on at
// most a bounded prefix, which also bounds the regex work.
const cleanValue = (s: string, max = MAX_AUDIT_STRING): string => {
  const head = s.length > max * 4 ? s.slice(0, max * 4) : s
  return cleanString(redactInlineSecrets(head), max)
}

const readProperty = (obj: object, key: string): unknown => {
  try {
    return (obj as Record<string, unknown>)[key]
  } catch {
    // a throwing getter must not stop the audit write
    return '[Unreadable]'
  }
}

/** One redaction pass under a budget; `bytes` approximates the serialized size so far. */
interface Pass extends Budget {
  bytes: number
}

// Thrown to abandon a pass as soon as it outgrows MAX_AUDIT_DETAIL_BYTES, so a huge detail
// costs a bounded amount of work instead of being fully copied and then discarded.
const TOO_LARGE = new Error('audit detail too large')

const spend = (pass: Pass, s: string): string => {
  pass.bytes += utf8Length(s) + 6
  if (pass.bytes > MAX_AUDIT_DETAIL_BYTES) throw TOO_LARGE
  return s
}

const redactValue = (value: unknown, depth: number, ancestors: object[], p: Pass): unknown => {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') return spend(p, cleanValue(value, p.string))
  if (typeof value === 'bigint') return spend(p, value.toString())
  if (typeof value !== 'object') return undefined
  if (depth >= p.depth) return '[Truncated]'
  if (ancestors.includes(value)) return '[Circular]'
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  if (value instanceof Error) return { name: spend(p, cleanString(value.name, p.string)), message: spend(p, cleanValue(value.message, p.string)) }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[Binary ${value.byteLength} bytes]`
  const next = [...ancestors, value]
  if (Array.isArray(value) || value instanceof Set) {
    const items = [...value]
    const out = items.slice(0, p.items).map((v) => redactValue(v, depth + 1, next, p) ?? null)
    if (items.length > p.items) out.push(`[${items.length - p.items} more]`)
    return out
  }
  const entries: [string, unknown][] = value instanceof Map
    ? [...value.entries()].map(([k, v]) => [String(k), v])
    : Object.keys(value).map((k) => [k, readProperty(value, k)])
  return redactEntries(entries, depth + 1, next, p)
}

const redactEntries = (entries: [string, unknown][], depth: number, ancestors: object[], p: Pass): Record<string, unknown> => {
  const out: [string, unknown][] = []
  for (const [key, v] of entries.slice(0, p.items)) {
    const k = spend(p, cleanString(key, Math.min(128, p.string)))
    // a flag such as passwordChanged: true carries no secret and is worth keeping
    if (REDACT_KEY_RE.test(key) && v !== null && typeof v !== 'boolean') {
      out.push([k, REDACTED])
      continue
    }
    const r = redactValue(v, depth, ancestors, p)
    if (r !== undefined) out.push([k, r])
  }
  if (entries.length > p.items) out.push(['[more]', entries.length - p.items])
  // fromEntries defines own properties, so a "__proto__" key cannot touch the prototype
  return Object.fromEntries(out)
}

/**
 * Deep copy of `detail` safe to persist: credential-like keys redacted, strings escaped, cycles
 * cut, and the whole object shrunk until it serializes within MAX_AUDIT_DETAIL_BYTES.
 */
export const redactSecrets = (detail: Record<string, unknown>): Record<string, unknown> => {
  if (!isRecord(detail)) return {}
  const entries: [string, unknown][] = Object.keys(detail).map((k) => [k, readProperty(detail, k)])
  for (const budget of BUDGETS) {
    try {
      const out = redactEntries(entries, 0, [detail], { ...budget, bytes: 0 })
      // the running count is an estimate; the serialized size is what the table checks
      if (utf8Length(JSON.stringify(out)) <= MAX_AUDIT_DETAIL_BYTES) return out
    } catch (e) {
      if (e !== TOO_LARGE) throw e
    }
  }
  return { '[truncated]': `detail exceeded ${MAX_AUDIT_DETAIL_BYTES} bytes`, keys: Object.keys(detail).length }
}

const ACTION_RE = /^[a-z][a-z0-9_.:-]{0,127}$/
const OUTCOMES: readonly AuditEntry['outcome'][] = ['ok', 'denied', 'failed']
const PRINCIPAL_KINDS: readonly unknown[] = ['root', 'reseller', 'user']

export interface AuditOptions {
  id?: string
  now?: Date
}

/** `kind:username`; the principal id is stored next to the entry by the audit repository. */
export const auditActor = (principal: Principal): string => {
  if (!isRecord(principal) || !PRINCIPAL_KINDS.includes(principal.kind) || typeof principal.username !== 'string' || principal.username.length === 0) {
    return invalid('audit actor must be a root, reseller or user principal')
  }
  return cleanString(`${principal.kind}:${principal.username}`, 128)
}

/** Builds the entry; `action` is a code-defined verb such as `account.suspend`. */
export const auditEntry = (
  principal: Principal,
  action: string,
  target: string,
  detail: Record<string, unknown>,
  outcome: AuditEntry['outcome'],
  opts: AuditOptions = {},
): AuditEntry => {
  if (typeof action !== 'string' || !ACTION_RE.test(action)) return invalid('audit action must look like "account.create"', { action: String(action).slice(0, 64) })
  if (!OUTCOMES.includes(outcome)) return invalid('audit outcome must be ok, denied or failed', { outcome: String(outcome) })
  const now = opts.now ?? new Date()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return invalid('audit time must be a valid Date')
  const id = opts.id ?? globalThis.crypto.randomUUID()
  if (typeof id !== 'string' || id.length === 0 || id.length > 128 || hasControlChars(id)) return invalid('audit id must be 1-128 printable characters')
  return {
    id,
    at: now.toISOString(),
    actor: auditActor(principal),
    action,
    target: cleanValue(String(target), 512),
    detail: redactSecrets(detail ?? {}),
    outcome,
  }
}
