import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildAuditUrl,
  checkRouteNavigation,
  classifySpacingScale,
  evaluateVisualBaseline,
  pickEffectiveTouchTarget,
  scanStaticDesignCompliance,
} from './design-qa-gates.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))

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
      const noDirStrict = evaluateVisualBaseline({
        baselinePath: null,
        screenshotBuffer: shot,
        updateBaselines: false,
        strictG16: true,
        pngModule: fakePng,
        pixelmatchFn: exactMatch,
      })
      expect(noDirStrict).toEqual({ passed: false, status: 'missing-baselines-dir' })

      const noDirSkip = evaluateVisualBaseline({
        baselinePath: null,
        screenshotBuffer: shot,
        updateBaselines: false,
        strictG16: false,
        pngModule: fakePng,
        pixelmatchFn: exactMatch,
      })
      expect(noDirSkip).toEqual({ passed: true, status: 'skipped' })

      const noDirUpdate = evaluateVisualBaseline({
        baselinePath: null,
        screenshotBuffer: shot,
        updateBaselines: true,
        strictG16: true,
        pngModule: fakePng,
        pixelmatchFn: exactMatch,
      })
      expect(noDirUpdate).toEqual({ passed: false, status: 'missing-baselines-dir' })

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

  it('builds clean audit URLs, rejects unexpected redirects, and uses CSP-safe axe injection', () => {
    expect(buildAuditUrl('http://127.0.0.1:4100/', '/whm/domains?page=2&lang=en', 'ar', 'dark'))
      .toBe('http://127.0.0.1:4100/whm/domains?page=2&lang=ar&theme=dark')

    expect(checkRouteNavigation({
      expectedRoute: '/whm',
      baseUrl: 'http://127.0.0.1:4100',
      finalUrl: 'http://127.0.0.1:4100/whm?lang=en&theme=light',
      status: 200,
    })).toEqual({
      expectedPath: '/whm',
      actualPath: '/whm',
      unexpectedRedirect: false,
      ok: true,
    })

    expect(checkRouteNavigation({
      expectedRoute: '/home',
      baseUrl: 'http://127.0.0.1:4100',
      finalUrl: 'http://127.0.0.1:4100/login?next=%2Fhome',
      status: 200,
    })).toEqual({
      expectedPath: '/home',
      actualPath: '/login',
      unexpectedRedirect: true,
      ok: false,
    })

    expect(checkRouteNavigation({
      expectedRoute: '/whm',
      baseUrl: 'http://127.0.0.1:4100',
      finalUrl: 'http://127.0.0.1:4100/whm',
      status: 401,
    }).ok).toBe(false)

    const source = readFileSync(resolve(SCRIPTS_DIR, 'design-qa-gates.mjs'), 'utf8')
    expect(source).toContain('injectTestScript')
    expect(source).toContain('recordCspViolations')
    expect(source).toContain('el.labels')
    expect(source).toContain("el.closest('label')")
    expect(source).not.toContain('addScriptTag')
  })

  it('counts associated label dimensions for checkbox and radio touch targets in G11', () => {
    expect(pickEffectiveTouchTarget({ width: 20, height: 20 }, [{ width: 358, height: 44 }])).toEqual({
      width: 358,
      height: 44,
    })
    expect(pickEffectiveTouchTarget({ width: 16, height: 16 }, [{ width: 358, height: 76 }])).toEqual({
      width: 358,
      height: 76,
    })
    expect(pickEffectiveTouchTarget({ width: 20, height: 20 }, [{ width: 28, height: 24 }])).toEqual({
      width: 28,
      height: 24,
    })
    expect(pickEffectiveTouchTarget({ width: 30, height: 30 }, [])).toEqual({
      width: 30,
      height: 30,
    })
    expect(pickEffectiveTouchTarget({ width: 0, height: 0 }, [])).toBeNull()
  })
})
