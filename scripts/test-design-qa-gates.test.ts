import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifySpacingScale, evaluateVisualBaseline, scanStaticDesignCompliance } from './design-qa-gates.mjs'

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

  it('fails G16 when a baseline screenshot is missing unless updateBaselines is explicitly enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xpanel-g16-'))
    const baselinePath = join(dir, 'home__desktop-en-light.png')
    const shot = Buffer.from([1, 2, 3, 4])
    const fakePng = { sync: { read: (buf: Buffer) => ({ width: 2, height: 2, data: buf }) } }
    const exactMatch = (a: Buffer, b: Buffer) => (Buffer.compare(a, b) === 0 ? 0 : 1)

    try {
      const missing = evaluateVisualBaseline({
        baselinePath,
        screenshotBuffer: shot,
        updateBaselines: false,
        strictG16: true,
        pngModule: fakePng,
        pixelmatchFn: exactMatch,
      })
      expect(missing).toEqual({ passed: false, status: 'missing-baseline' })
      expect(existsSync(baselinePath)).toBe(false)

      const updated = evaluateVisualBaseline({
        baselinePath,
        screenshotBuffer: shot,
        updateBaselines: true,
        strictG16: true,
        pngModule: fakePng,
        pixelmatchFn: exactMatch,
      })
      expect(updated).toEqual({ passed: true, status: 'updated' })
      expect(existsSync(baselinePath)).toBe(true)

      const matched = evaluateVisualBaseline({
        baselinePath,
        screenshotBuffer: shot,
        updateBaselines: false,
        strictG16: true,
        pngModule: fakePng,
        pixelmatchFn: exactMatch,
      })
      expect(matched.passed).toBe(true)
      expect(matched.status).toBe('matched')

      writeFileSync(baselinePath, Buffer.from([9, 9, 9, 9]))
      const mismatch = evaluateVisualBaseline({
        baselinePath,
        screenshotBuffer: shot,
        updateBaselines: false,
        strictG16: true,
        pngModule: fakePng,
        pixelmatchFn: exactMatch,
      })
      expect(mismatch.passed).toBe(false)
      expect(mismatch.status).toBe('pixel-mismatch')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
