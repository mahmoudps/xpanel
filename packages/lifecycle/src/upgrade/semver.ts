import { fail } from '@xpanel/core'

// SemVer 2.0.0 (https://semver.org) without dependencies.

export interface SemVer {
  major: number
  minor: number
  patch: number
  prerelease: (string | number)[]
  build: string[]
  raw: string
}

const NUM = '0|[1-9]\\d*'
const PRE_ID = `(?:${NUM}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const SEMVER = new RegExp(
  `^(${NUM})\\.(${NUM})\\.(${NUM})` +
    `(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?` +
    `(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$`,
)
const MAX_LENGTH = 128

const toSafeInt = (s: string): number | null => {
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : null
}

export const parseSemver = (v: unknown): SemVer | null => {
  if (typeof v !== 'string' || v.length > MAX_LENGTH) return null
  const m = SEMVER.exec(v)
  if (!m) return null
  const [major, minor, patch] = [m[1], m[2], m[3]].map((x) => toSafeInt(x ?? ''))
  if (major == null || minor == null || patch == null) return null
  const prerelease: (string | number)[] = []
  for (const id of m[4] ? m[4].split('.') : []) {
    if (/^\d+$/.test(id)) {
      const n = toSafeInt(id)
      if (n == null) return null
      prerelease.push(n)
    } else prerelease.push(id)
  }
  return { major, minor, patch, prerelease, build: m[5] ? m[5].split('.') : [], raw: v }
}

export const assertSemver = (v: unknown, what = 'version'): SemVer =>
  parseSemver(v) ?? fail('VALIDATION', `invalid ${what}: ${String(v).slice(0, 80)}`, { what })

const cmpNum = (a: number, b: number): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0)

const cmpPre = (a: (string | number)[], b: (string | number)[]): -1 | 0 | 1 => {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return cmpNum(x, y)
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Precedence per SemVer section 11; build metadata is ignored. */
export const compareSemver = (a: SemVer | string, b: SemVer | string): -1 | 0 | 1 => {
  const x = typeof a === 'string' ? assertSemver(a) : a
  const y = typeof b === 'string' ? assertSemver(b) : b
  return (
    cmpNum(x.major, y.major) ||
    cmpNum(x.minor, y.minor) ||
    cmpNum(x.patch, y.patch) ||
    cmpPre(x.prerelease, y.prerelease)
  )
}
