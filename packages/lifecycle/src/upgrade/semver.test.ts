import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import { assertSemver, compareSemver, parseSemver } from './semver.ts'

describe('semver', () => {
  it('parses core, prerelease and build parts', () => {
    expect(parseSemver('1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: [], build: [] })
    expect(parseSemver('1.2.3-rc.1+sha.abc')).toMatchObject({ prerelease: ['rc', 1], build: ['sha', 'abc'] })
    expect(parseSemver('0.0.0-0')).toMatchObject({ prerelease: [0] })
  })

  it('rejects invalid or hostile strings', () => {
    for (const bad of ['', '1', '1.2', '01.2.3', '1.02.3', '1.2.3-', '1.2.3-01', 'v1.2.3', ' 1.2.3', '1.2.3 ',
      '1.2.3/../../etc', '1.2.3\n', '1.2.3-rc..1', '1.2.3+', `1.2.${'9'.repeat(200)}`, '99999999999999999999.0.0', null, 7]) {
      expect(parseSemver(bad), String(bad)).toBeNull()
    }
    expect(() => assertSemver('../1.0.0')).toThrow(XpanelError)
  })

  it('orders by SemVer precedence', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0']
    for (let i = 1; i < ordered.length; i++) {
      expect(compareSemver(ordered[i] as string, ordered[i - 1] as string), `${ordered[i]} > ${ordered[i - 1]}`).toBe(1)
      expect(compareSemver(ordered[i - 1] as string, ordered[i] as string)).toBe(-1)
    }
    expect(compareSemver('1.2.3+a', '1.2.3+b')).toBe(0)
    expect(compareSemver('1.10.0', '1.9.9')).toBe(1)
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
  })
})
