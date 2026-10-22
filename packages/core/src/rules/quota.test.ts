import { describe, expect, it } from 'vitest'
import { XpanelError } from '../errors.ts'
import type { Limit } from '../types.ts'
import { BYTES_PER_MB, MAX_DISK_MB, assertUploadWithinQuota, quotaBytes, remainingBytes, usagePercent } from './quota.ts'

const code = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
}

describe('assertUploadWithinQuota', () => {
  const cap = 100 * BYTES_PER_MB

  it('allows uploads up to exactly the cap', () => {
    expect(() => assertUploadWithinQuota(0, cap, 100)).not.toThrow()
    expect(() => assertUploadWithinQuota(cap - 1, 1, 100)).not.toThrow()
    expect(() => assertUploadWithinQuota(cap, 0, 100)).not.toThrow()
  })

  it('refuses one byte past the cap with detail', () => {
    try {
      assertUploadWithinQuota(cap, 1, 100)
      expect.unreachable()
    } catch (e) {
      expect((e as XpanelError).code).toBe('LIMIT_EXCEEDED')
      expect((e as XpanelError).detail).toMatchObject({ limitBytes: cap, remainingBytes: 0, incomingBytes: 1 })
    }
    expect(code(() => assertUploadWithinQuota(0, cap + 1, 100))).toBe('LIMIT_EXCEEDED')
  })

  it('refuses everything on an account already over quota', () => {
    expect(code(() => assertUploadWithinQuota(cap + 500, 1, 100))).toBe('LIMIT_EXCEEDED')
  })

  it('never limits unlimited and refuses any byte on a zero cap', () => {
    expect(() => assertUploadWithinQuota(Number.MAX_SAFE_INTEGER, 1, 'unlimited')).not.toThrow()
    expect(code(() => assertUploadWithinQuota(0, 1, 0))).toBe('LIMIT_EXCEEDED')
    expect(() => assertUploadWithinQuota(0, 0, 0)).not.toThrow()
  })

  it('counts single bytes exactly at the largest cap', () => {
    const cap = MAX_DISK_MB * BYTES_PER_MB
    expect(Number.isSafeInteger(cap)).toBe(true)
    expect(code(() => assertUploadWithinQuota(cap, 1, MAX_DISK_MB))).toBe('LIMIT_EXCEEDED')
    expect(() => assertUploadWithinQuota(cap - 1, 1, MAX_DISK_MB)).not.toThrow()
    expect(code(() => assertUploadWithinQuota(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, MAX_DISK_MB))).toBe('LIMIT_EXCEEDED')
  })

  it('refuses a disk cap whose byte count would not be exact', () => {
    expect(code(() => assertUploadWithinQuota(0, 1, MAX_DISK_MB + 1))).toBe('VALIDATION')
    expect(code(() => quotaBytes(Number.MAX_SAFE_INTEGER))).toBe('VALIDATION')
  })

  it.each<[unknown, unknown, unknown]>([
    [-1, 1, 100],
    [0, -1, 100],
    [0.5, 1, 100],
    [Number.NaN, 1, 100],
    [0, Number.POSITIVE_INFINITY, 100],
    ['10', 1, 100],
    [0, 1, -1],
    [0, 1, 1.5],
    [0, 1, 'infinite'],
  ])('rejects malformed input (%j, %j, %j)', (used, incoming, disk) => {
    expect(code(() => assertUploadWithinQuota(used as number, incoming as number, disk as Limit))).toBe('VALIDATION')
  })
})

describe('usagePercent and helpers', () => {
  it('computes two-decimal percentages without clamping', () => {
    expect(usagePercent(0, 100)).toBe(0)
    expect(usagePercent(50 * BYTES_PER_MB, 100)).toBe(50)
    expect(usagePercent(BYTES_PER_MB, 3)).toBe(33.33)
    expect(usagePercent(150 * BYTES_PER_MB, 100)).toBe(150)
  })

  it('handles unlimited and zero caps', () => {
    expect(usagePercent(123, 'unlimited')).toBeNull()
    expect(usagePercent(0, 0)).toBe(0)
    expect(usagePercent(1, 0)).toBe(100)
  })

  it('reports remaining bytes and the cap in bytes', () => {
    expect(quotaBytes(2)).toBe(2 * BYTES_PER_MB)
    expect(quotaBytes('unlimited')).toBeNull()
    expect(remainingBytes(BYTES_PER_MB, 2)).toBe(BYTES_PER_MB)
    expect(remainingBytes(5 * BYTES_PER_MB, 2)).toBe(0)
    expect(remainingBytes(5, 'unlimited')).toBeNull()
    expect(code(() => usagePercent(-5, 10))).toBe('VALIDATION')
  })
})
