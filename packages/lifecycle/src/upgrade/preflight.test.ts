import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import { osRelease } from '../testing/fakes.ts'
import { assertHotPathMigrations } from './migrations.ts'
import type { PendingMigration } from './migrations.ts'
import { preflight } from './preflight.ts'
import type { PreflightInput } from './preflight.ts'

const base: PreflightInput = {
  freeBytes: 2_000,
  releaseBytes: 1_000,
  os: osRelease('ubuntu', '24.04', 'VERSION_CODENAME=noble\n'),
  activeTransfers: 0,
  currentVersion: '1.0.0',
  targetVersion: '1.1.0',
  schemaVersions: { current: 4, target: 6 },
}

const failing = (i: PreflightInput): string[] => preflight(i).checks.filter((c) => !c.ok).map((c) => c.id)

describe('preflight', () => {
  it('passes a healthy request with exactly 2x free space and reports every check', () => {
    const r = preflight(base)
    expect(r.ok).toBe(true)
    expect(r.checks.map((c) => c.id)).toEqual(['disk-space', 'os-supported', 'no-active-transfer', 'version-newer', 'schema-compatible'])
  })

  it('needs free >= 2x release bytes and valid counts', () => {
    expect(failing({ ...base, freeBytes: 1_999 })).toEqual(['disk-space'])
    expect(failing({ ...base, releaseBytes: 0 })).toEqual(['disk-space'])
    expect(failing({ ...base, freeBytes: -1 })).toEqual(['disk-space'])
    expect(failing({ ...base, freeBytes: Number.NaN })).toEqual(['disk-space'])
    expect(failing({ ...base, freeBytes: 2.5e3 + 0.5 })).toEqual(['disk-space'])
    expect(failing({ ...base, releaseBytes: Number.MAX_SAFE_INTEGER, freeBytes: Number.MAX_SAFE_INTEGER })).toEqual(['disk-space'])
  })

  it('uses the @xpanel/os support matrix', () => {
    for (const [id, v, extra] of [['ubuntu', '22.04', ''], ['centos', '9', 'PLATFORM_ID="platform:el9"\n'], ['centos', '10', ''], ['almalinux', '9.4', ''], ['rocky', '10', '']] as const) {
      expect(failing({ ...base, os: osRelease(id, v, extra) }), `${id} ${v}`).toEqual([])
    }
    for (const [id, v] of [['ubuntu', '20.04'], ['ubuntu', '24.10'], ['centos', '7'], ['centos', '8'], ['debian', '12'], ['arch', '1'], ['ubuntu', '24.04;rm']] as const) {
      expect(failing({ ...base, os: osRelease(id, v) }), `${id} ${v}`).toEqual(['os-supported'])
    }
    expect(preflight({ ...base, os: osRelease('centos', '7') }).checks[1]?.message).toMatch(/end-of-life/)
    expect(failing({ ...base, os: null as never })).toEqual(['os-supported'])
  })

  it('refuses while a transfer runs', () => {
    expect(failing({ ...base, activeTransfers: 1 })).toEqual(['no-active-transfer'])
    expect(failing({ ...base, activeTransfers: -1 })).toEqual(['no-active-transfer'])
  })

  it('needs a strictly newer SemVer target', () => {
    expect(failing({ ...base, targetVersion: '1.0.0' })).toEqual(['version-newer'])
    expect(failing({ ...base, targetVersion: '0.9.9' })).toEqual(['version-newer'])
    expect(failing({ ...base, targetVersion: '1.0.0-rc.1' })).toEqual(['version-newer'])
    expect(failing({ ...base, currentVersion: '1.1.0-rc.1' })).toEqual([])
    expect(failing({ ...base, targetVersion: 'latest' })).toEqual(['version-newer'])
  })

  it('needs a target schema at least as new as the database', () => {
    expect(failing({ ...base, schemaVersions: { current: 6, target: 6 } })).toEqual([])
    expect(failing({ ...base, schemaVersions: { current: 6, target: 5 } })).toEqual(['schema-compatible'])
    expect(failing({ ...base, schemaVersions: { current: -1, target: 5 } })).toEqual(['schema-compatible'])
    expect(failing({ ...base, schemaVersions: undefined as never })).toEqual(['schema-compatible'])
  })

  it('reports all failures together', () => {
    expect(failing({ ...base, freeBytes: 0, activeTransfers: 2, targetVersion: '0.1.0' })).toEqual(['disk-space', 'no-active-transfer', 'version-newer'])
  })
})

const m = (version: number, contract = false): PendingMigration => ({ version, name: `${String(version).padStart(4, '0')}_x${contract ? '_contract' : ''}.sql`, contract })

describe('assertHotPathMigrations', () => {
  it('accepts a contiguous expand-only run ending at the release schema', () => {
    expect(() => assertHotPathMigrations([m(5), m(6)], 4, 6)).not.toThrow()
    expect(() => assertHotPathMigrations([], 6, 6)).not.toThrow()
  })

  it('rejects gaps, reordering, overshoot and a short run', () => {
    for (const [list, from, to] of [[[m(6)], 4, 6], [[m(6), m(5)], 4, 6], [[m(5), m(6), m(7)], 4, 6], [[m(5)], 4, 6], [[], 4, 6]] as const) {
      expect(() => assertHotPathMigrations(list, from, to)).toThrow(XpanelError)
    }
  })

  it('never runs a contract migration during a switch', () => {
    expect(() => assertHotPathMigrations([m(5), m(6, true)], 4, 6)).toThrow(/contract step/)
  })
})
