import { XpanelError, isXpanelError } from '@xpanel/core'
import type { ErrorCode } from '@xpanel/core'

interface PgErrorLike {
  code: string
  message?: string
  constraint?: string
  table?: string
  column?: string
}

const isPgError = (e: unknown): e is PgErrorLike =>
  typeof e === 'object' && e !== null && typeof (e as PgErrorLike).code === 'string' && /^[0-9A-Z]{5}$/.test((e as PgErrorLike).code)

/** Driver errors sit under Drizzle's DrizzleQueryError.cause (which also carries the SQL and params). */
export const findPgError = (e: unknown): PgErrorLike | undefined => {
  let cur: unknown = e
  for (let depth = 0; depth < 5 && cur; depth++) {
    if (isPgError(cur)) return cur
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

const BY_CODE: Record<string, ErrorCode> = {
  '23505': 'CONFLICT', // unique_violation
  '23514': 'VALIDATION', // check_violation
  '23502': 'VALIDATION', // not_null_violation
  '22P02': 'VALIDATION', // invalid_text_representation (bad uuid/inet/...)
  '22001': 'VALIDATION', // string_data_right_truncation
  '22003': 'VALIDATION', // numeric_value_out_of_range
  '22007': 'VALIDATION', // invalid_datetime_format
  '22008': 'VALIDATION', // datetime_field_overflow
  '2200H': 'LIMIT_EXCEEDED', // sequence_generator_limit_exceeded (UID space exhausted)
  '42501': 'FORBIDDEN', // insufficient_privilege (append-only triggers)
  '40001': 'CONFLICT', // serialization_failure
  '40P01': 'CONFLICT', // deadlock_detected
  '55P03': 'CONFLICT', // lock_not_available
}

/** Drizzle's DrizzleQueryError carries the SQL text and the bound parameters (password hashes, tokens). */
const carriesQuery = (e: unknown): e is Error & { cause?: unknown } =>
  e instanceof Error && ('params' in e || 'query' in e)

const causeCode = (e: unknown): string | undefined => {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined
}

/**
 * Converts a database error into an XpanelError with a safe message: the
 * constraint/table names only, never the SQL text, parameters or PG "detail"
 * (which can echo hashes and other values).
 */
export const toXpanelError = (e: unknown): unknown => {
  if (isXpanelError(e)) return e
  const pg = findPgError(e)
  if (!pg) {
    if (!carriesQuery(e)) return e
    // e.g. a connection failure under a query: keep the reason, drop the query and its parameters
    const cause = e.cause
    const code = causeCode(cause)
    const reason = cause instanceof Error ? cause.message : 'no cause reported'
    return Object.assign(new Error(`database query failed: ${reason}`), code ? { code } : {})
  }
  const where = { pgCode: pg.code, constraint: pg.constraint ?? null, table: pg.table ?? null, column: pg.column ?? null }
  if (pg.code === '23503') {
    const stillReferenced = /still referenced|update or delete on/i.test(pg.message ?? '')
    return stillReferenced
      ? new XpanelError('CONFLICT', `still in use (${pg.constraint ?? pg.table ?? 'foreign key'})`, where)
      : new XpanelError('NOT_FOUND', `referenced row does not exist (${pg.constraint ?? 'foreign key'})`, where)
  }
  const code = BY_CODE[pg.code]
  // unexpected (programming/infra) errors stay 500s, minus the query parameters
  if (!code) return Object.assign(new Error(`database error ${pg.code}: ${pg.message ?? ''}`), { pgCode: pg.code })
  const label = pg.constraint ?? pg.column ?? pg.table ?? pg.code
  const text: Record<string, string> = {
    CONFLICT: pg.code === '23505' ? `already exists (${label})` : `concurrent change, retry (${label})`,
    VALIDATION: pg.code === '23514' && pg.message && !pg.constraint ? pg.message : `invalid value (${label})`,
    FORBIDDEN: pg.message ?? 'operation not allowed',
    LIMIT_EXCEEDED: 'identifier space exhausted',
  }
  return new XpanelError(code, text[code] ?? `database error ${pg.code}`, where)
}

/** Runs fn and rethrows database errors as XpanelError. */
export const withPgErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (e) {
    throw toXpanelError(e)
  }
}
