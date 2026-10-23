import { describe, expect, it } from 'vitest'
import { resolveResourceUsage } from './resource-usage.ts'

describe('resource utilization semantics', () => {
  it('keeps an explicit unlimited cap non-comparable without claiming health', () => {
    const result = resolveResourceUsage(42, 'unlimited')
    expect(result.kind).toBe('unlimited')
    expect(result).not.toHaveProperty('percent')
    expect(result).not.toHaveProperty('threshold')
    expect(result.used.value).toBe(42)
  })

  it.each([undefined, null, Number.NaN, Infinity, -Infinity, -1, '0', {}, true, Number.MAX_SAFE_INTEGER + 1])(
    'does not convert missing or invalid usage %j into zero', value => {
      const result = resolveResourceUsage(value, 100)
      expect(result.kind).toBe('unavailable')
      expect(result.used.value).toBeNull()
      expect(result.limit.value).toBe(100)
      expect(result).not.toHaveProperty('percent')
    },
  )

  it.each([undefined, null, Number.NaN, Infinity, -1, '100', {}, true])(
    'does not turn unknown cap %j into unlimited or a cap of 1', value => {
      const result = resolveResourceUsage(7, value)
      expect(result.kind).toBe('unavailable')
      expect(result.used.value).toBe(7)
      expect(result.limit.value).toBeNull()
    },
  )

  it('distinguishes zero allocation, zero measured use, and excess use', () => {
    expect(resolveResourceUsage(0, 0)).toMatchObject({ kind: 'zero-limit', exceeded: false })
    expect(resolveResourceUsage(7, 0)).toMatchObject({ kind: 'zero-limit', exceeded: true })
    expect(resolveResourceUsage(0, 100)).toMatchObject({ kind: 'bounded', percent: 0, threshold: 'ok' })
    expect(resolveResourceUsage(-0, 0).used.value).toBe(0)
  })

  it.each([
    [79.999, 'ok'], [80, 'warn'], [94.999, 'warn'], [95, 'critical'], [100, 'critical'], [120, 'critical'],
  ] as const)('uses raw value %s with threshold %s', (used, threshold) => {
    const result = resolveResourceUsage(used, 100)
    expect(result).toMatchObject({ kind: 'bounded', usedValue: used, limitValue: 100, threshold })
    if (result.kind === 'bounded') expect(result.fillPercent).toBeCloseTo(Math.min(100, used))
  })

  it('retains excess values and clamps only the decorative fill', () => {
    expect(resolveResourceUsage(250, 100)).toMatchObject({ kind: 'bounded', usedValue: 250, limitValue: 100, percent: 250, fillPercent: 100 })
    expect(resolveResourceUsage(150, 200)).toMatchObject({ kind: 'bounded', percent: 75, threshold: 'ok' })
    expect(resolveResourceUsage(0.5, 2)).toMatchObject({ kind: 'bounded', percent: 25 })
  })

  it('preserves unbounded allocation without manufacturing an infinite percentage', () => {
    expect(resolveResourceUsage('unlimited', 100)).toMatchObject({ kind: 'unbounded-allocation', threshold: 'critical' })
    expect(resolveResourceUsage('unlimited', 0).kind).toBe('unbounded-allocation')
    expect(resolveResourceUsage('unlimited', 'unlimited').kind).toBe('unlimited')
    expect(resolveResourceUsage('unlimited', undefined).kind).toBe('unavailable')
  })

  it('does not emit Infinity when a finite denominator produces an unrepresentable ratio', () => {
    const result = resolveResourceUsage(Number.MAX_SAFE_INTEGER, Number.MIN_VALUE)
    expect(result).toMatchObject({ kind: 'bounded', percent: null, fillPercent: 100, threshold: 'critical' })
    expect(JSON.stringify(result)).not.toContain('Infinity')
  })
})
