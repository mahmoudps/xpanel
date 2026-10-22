import { assertId, assertIdOrNull, fail, isUuid } from '@xpanel/core'

export { assertId, assertIdOrNull, isUuid }

export const first = <T>(rows: readonly T[]): T | null => rows[0] ?? null

export const mustExist = <T>(row: T | null | undefined, what: string, id: unknown): T =>
  row ?? fail('NOT_FOUND', `${what} not found`, { what, id: String(id).slice(0, 128) })

/** Removes keys whose value is undefined so partial updates only touch given fields. */
export const defined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

export const clampLimit = (n: number | undefined, def: number, max: number): number =>
  n === undefined ? def : Number.isSafeInteger(n) && n >= 1 ? Math.min(n, max) : fail('VALIDATION', 'invalid page size')

export const rejectErrors = (what: string, errors: readonly string[]): void => {
  if (errors.length > 0) fail('VALIDATION', `invalid ${what}: ${errors.join('; ')}`, { errors })
}

export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&')

export const nowIso = (): string => new Date().toISOString()
