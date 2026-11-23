import { describe, expect, it } from 'vitest'
import { classifySpacingScale, scanStaticDesignCompliance } from './design-qa-gates.mjs'

describe('design-qa-gates static compliance & scale checks', () => {
  it('passes strict G4/G6/G8 static checks across apps/web/src/design-system', () => {
    const res = scanStaticDesignCompliance({ scope: 'design-system' })
    expect(res.violations).toEqual([])
    expect(res.passed).toBe(true)
    expect(res.gates).toEqual({ G4: true, G6: true, G8: true })
  })

  it('tracks repo-wide ratchet ceilings cleanly without regressions', () => {
    const res = scanStaticDesignCompliance({ scope: 'ratchet' })
    expect(res.passed).toBe(true)
    expect(res.metrics.notReadCount).toBeLessThanOrEqual(1002)
    expect(res.metrics.importantCount).toBeLessThanOrEqual(456)
  })

  it('flags off-scale spacing values cleanly', () => {
    expect(classifySpacingScale([4, 8, 12, 16, 24, 32]).valid).toBe(true)
    const bad = classifySpacingScale([8, 10, 14, 24])
    expect(bad.valid).toBe(false)
    expect(bad.offScale).toEqual([10, 14])
  })
})
