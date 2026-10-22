import type { Limit } from './types.ts'
import { fail } from './errors.ts'

export const isUnlimited = (l: Limit): l is 'unlimited' => l === 'unlimited'

/** True when `used + adding` stays within `limit`. */
export const fits = (limit: Limit, used: number, adding = 1): boolean =>
  isUnlimited(limit) || used + adding <= limit

/** Throws LIMIT_EXCEEDED when adding would break the cap. */
export const assertFits = (what: string, limit: Limit, used: number, adding = 1): void => {
  if (!fits(limit, used, adding)) {
    fail('LIMIT_EXCEEDED', `${what} limit reached (${used}/${limit})`, { what, limit, used, adding })
  }
}

/** Sum of limits; any unlimited makes the sum unlimited. */
export const sumLimits = (ls: Limit[]): Limit =>
  ls.some(isUnlimited) ? 'unlimited' : (ls as number[]).reduce((a, b) => a + b, 0)

/** `a <= b` where unlimited is the top element. */
export const limitLte = (a: Limit, b: Limit): boolean =>
  isUnlimited(b) || (!isUnlimited(a) && a <= b)

export const parseLimit = (v: unknown): Limit => {
  if (v === 'unlimited') return 'unlimited'
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return fail('VALIDATION', `invalid limit: ${String(v)}`)
}
