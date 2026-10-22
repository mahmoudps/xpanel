import { isXpanelError } from '@xpanel/core'
import { SUPPORTED_OS, classifyRelease } from '@xpanel/os'
import type { OsRelease } from '@xpanel/os'
import { compareSemver, parseSemver } from './semver.ts'

export interface PreflightInput {
  freeBytes: number
  /** unpacked size of the release */
  releaseBytes: number
  /** parsed /etc/os-release of this host */
  os: OsRelease
  activeTransfers: number
  currentVersion: string
  targetVersion: string
  /** control-DB schema numbers; independent of the product version */
  schemaVersions: { current: number; target: number }
}

export type PreflightCheckId = 'disk-space' | 'os-supported' | 'no-active-transfer' | 'version-newer' | 'schema-compatible'

export interface PreflightCheck {
  id: PreflightCheckId
  ok: boolean
  message: string
  detail: Record<string, unknown>
}

export interface PreflightReport {
  ok: boolean
  checks: PreflightCheck[]
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

const diskCheck = (free: number, release: number): PreflightCheck => {
  if (!isCount(free) || !isCount(release) || release === 0 || !Number.isSafeInteger(release * 2)) {
    return { id: 'disk-space', ok: false, message: 'free space or release size is not a valid byte count', detail: { free, release } }
  }
  const required = release * 2
  const ok = free >= required
  return {
    id: 'disk-space',
    ok,
    message: ok ? 'enough space for two releases side by side' : `need ${required} bytes free, have ${free}`,
    detail: { free, release, required },
  }
}

/** The support matrix and its rules (exact Ubuntu LTS, EL majors, no CentOS 7) live in @xpanel/os. */
const osCheck = (os: OsRelease): PreflightCheck => {
  const supported = SUPPORTED_OS.map((e) => `${e.name} ${e.versions.join('/')}`)
  try {
    const s = classifyRelease(os)
    return { id: 'os-supported', ok: true, message: `${s.id} ${s.versionId} is supported`, detail: { id: s.id, versionId: s.versionId, supported } }
  } catch (e) {
    if (!isXpanelError(e)) throw e
    return { id: 'os-supported', ok: false, message: e.message, detail: { id: String(os?.id), versionId: String(os?.versionId), supported } }
  }
}

const transferCheck = (active: number): PreflightCheck => {
  const ok = isCount(active) && active === 0
  return {
    id: 'no-active-transfer',
    ok,
    message: ok ? 'no transfer session running' : `${String(active)} transfer session(s) in progress`,
    detail: { active },
  }
}

const versionCheck = (current: string, target: string): PreflightCheck => {
  const c = parseSemver(current)
  const t = parseSemver(target)
  if (!c || !t) return { id: 'version-newer', ok: false, message: 'current or target version is not valid SemVer', detail: { current, target } }
  const ok = compareSemver(t, c) > 0
  return { id: 'version-newer', ok, message: ok ? `${current} -> ${target}` : `target ${target} is not newer than ${current}`, detail: { current, target } }
}

const schemaCheck = (s: { current: number; target: number } | undefined): PreflightCheck => {
  if (!isCount(s?.current) || !isCount(s?.target)) {
    return { id: 'schema-compatible', ok: false, message: 'schema versions must be non-negative integers', detail: { ...s } }
  }
  const ok = s.target >= s.current
  return {
    id: 'schema-compatible',
    ok,
    message: ok ? `schema ${s.current} -> ${s.target}` : `target schema ${s.target} is older than the database schema ${s.current}`,
    detail: { ...s },
  }
}

/** Pure: every check always runs so the report shows all problems at once. */
export const preflight = (input: PreflightInput): PreflightReport => {
  const checks = [
    diskCheck(input.freeBytes, input.releaseBytes),
    osCheck(input.os),
    transferCheck(input.activeTransfers),
    versionCheck(input.currentVersion, input.targetVersion),
    schemaCheck(input.schemaVersions),
  ]
  return { ok: checks.every((c) => c.ok), checks }
}
