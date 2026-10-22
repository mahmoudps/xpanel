import { and, desc, eq, lt } from 'drizzle-orm'
import { cleanString, fail, redactInlineSecrets, redactSecrets } from '@xpanel/core'
import type { AuditEntry, Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { auditFromRow, auditToRow } from '../mappers.ts'
import { withPgErrors } from '../pg-errors.ts'
import { auditLog } from '../schema.ts'
import { assertIp } from '../validate.ts'
import { assertIdOrNull, clampLimit } from './util.ts'

/** What core's auditEntry builds, minus its id and time: the database assigns both. */
export interface NewAuditEntry {
  actor: string
  /** a code-defined verb such as account.suspend */
  action: string
  target: string
  detail?: Record<string, unknown>
  outcome: AuditEntry['outcome']
  principalId?: Id | null
  ip?: string | null
}

// the audit_log CHECK; core's auditEntry builds actions of this shape
const ACTION_RE = /^[a-z][a-z0-9_.:-]{0,127}$/
const OUTCOMES: readonly AuditEntry['outcome'][] = ['ok', 'denied', 'failed']
const MAX_DETAIL_BYTES = 64 * 1024
// below the column limits (255, 512) with room for cleanString's "...[truncated]" marker
const ACTOR_MAX = 128
const TARGET_MAX = 480

/**
 * Appends one entry. Defense in depth over core's auditEntry: credential-like keys and inline
 * secrets in `detail` are redacted again, and actor/target are escaped rather than refused, so
 * a hostile value can neither forge log lines nor make the audit write (and the action) fail.
 * The table rejects UPDATE/DELETE/TRUNCATE, so this is the only write.
 */
export const appendAudit = (db: Db, e: NewAuditEntry): Promise<AuditEntry> =>
  withPgErrors(async () => {
    if (typeof e !== 'object' || e === null) fail('VALIDATION', 'audit entry must be an object')
    if (typeof e.action !== 'string' || !ACTION_RE.test(e.action)) fail('VALIDATION', 'audit action must look like account.create')
    if (!OUTCOMES.includes(e.outcome)) fail('VALIDATION', 'audit outcome must be ok|denied|failed')
    if (typeof e.actor !== 'string' || e.actor.length === 0) fail('VALIDATION', 'audit actor is required')
    if (typeof e.target !== 'string') fail('VALIDATION', 'audit target must be a string')
    const raw = e.detail ?? {}
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('VALIDATION', 'audit detail must be an object')
    const detail = redactSecrets(raw)
    if (Buffer.byteLength(JSON.stringify(detail), 'utf8') > MAX_DETAIL_BYTES) fail('VALIDATION', 'audit detail too large')
    const [row] = await db
      .insert(auditLog)
      .values({
        ...auditToRow({
          actor: cleanString(e.actor, ACTOR_MAX),
          action: e.action,
          // bounded before the redaction regexes run, as core does
          target: cleanString(redactInlineSecrets(e.target.slice(0, TARGET_MAX * 4)), TARGET_MAX),
          detail,
          outcome: e.outcome,
        }),
        principalId: assertIdOrNull(e.principalId ?? null, 'principalId'),
        ip: e.ip == null ? null : assertIp(e.ip, 'ip'),
      })
      .returning()
    return auditFromRow(row as typeof auditLog.$inferSelect)
  })

export interface AuditQuery {
  /** page size, default 100, max 1000 */
  limit?: number
  /** entries older than this id (keyset pagination) */
  beforeId?: string
  actor?: string
  target?: string
  action?: string
}

/** Newest first. */
export const listAudit = async (db: Db, q: AuditQuery = {}): Promise<AuditEntry[]> => {
  const limit = clampLimit(q.limit, 100, 1000)
  const before = q.beforeId === undefined ? undefined : /^[1-9][0-9]{0,14}$/.test(q.beforeId) ? Number(q.beforeId) : fail('VALIDATION', 'beforeId must be an entry id')
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        before === undefined ? undefined : lt(auditLog.id, before),
        q.actor === undefined ? undefined : eq(auditLog.actor, q.actor),
        q.target === undefined ? undefined : eq(auditLog.target, q.target),
        q.action === undefined ? undefined : eq(auditLog.action, q.action),
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(limit)
  return rows.map(auditFromRow)
}
