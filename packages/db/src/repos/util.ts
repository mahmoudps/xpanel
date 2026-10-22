import { sql } from 'drizzle-orm'
import { fail } from '@xpanel/core'
import type { Db } from '../client.ts'
import type { LockKey } from '../locks.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Lookups by a malformed id simply find nothing (no driver error, no 400). */
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

export const first = <T>(rows: T[]): T | null => rows[0] ?? null

export const mustExist = <T>(row: T | null | undefined, what: string, id: unknown): T =>
  row ?? fail('NOT_FOUND', `${what} not found`, { what, id: String(id).slice(0, 128) })

export const assertId = (v: unknown, what: string): string =>
  isUuid(v) ? v.toLowerCase() : fail('VALIDATION', `invalid ${what}`, { what })

export const assertIdOrNull = (v: unknown, what: string): string | null => (v === null ? null : assertId(v, what))

/** Removes keys whose value is undefined so partial updates only touch given fields. */
export const defined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

export const clampLimit = (n: number | undefined, def: number, max: number): number =>
  n === undefined ? def : Number.isSafeInteger(n) && n >= 1 ? Math.min(n, max) : fail('VALIDATION', 'invalid page size')

/** Fails with every problem a core `*Errors` rule found, as one VALIDATION error. */
export const rejectErrors = (what: string, errors: readonly string[]): void => {
  if (errors.length > 0) fail('VALIDATION', `invalid ${what}: ${errors.join('; ')}`, { errors })
}

/** Holds the lock until the surrounding transaction ends. */
export const advisoryLock = async (tx: Db, key: LockKey): Promise<void> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${sql.raw(String(key))}::bigint)`)
}

/** `%`, `_` and `\` taken literally in a LIKE pattern (Postgres' default escape is `\`). */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&')
