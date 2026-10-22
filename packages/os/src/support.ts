import { fail } from '@xpanel/core'
import type { OsFamily } from '@xpanel/core'
import type { OsRelease } from './types.ts'
import { preview } from './validate.ts'

export type SupportedOsId = 'ubuntu' | 'centos' | 'almalinux' | 'rocky'

export interface SupportedOs {
  family: OsFamily
  id: SupportedOsId
  versionId: string
  major: number
  codename: string
}

export interface SupportedOsEntry {
  id: SupportedOsId
  name: string
  /** VERSION_ID values; EL rebuilds also accept point releases such as 9.4 */
  versions: readonly string[]
}

const MATRIX: SupportedOsEntry[] = [
  { id: 'ubuntu', name: 'Ubuntu LTS', versions: ['22.04', '24.04'] },
  { id: 'centos', name: 'CentOS Stream', versions: ['9', '10'] },
  { id: 'almalinux', name: 'AlmaLinux', versions: ['9', '10'] },
  { id: 'rocky', name: 'Rocky Linux', versions: ['9', '10'] },
]

/** The support matrix, for UI and docs. */
export const SUPPORTED_OS: readonly SupportedOsEntry[] = Object.freeze(
  MATRIX.map(e => Object.freeze({ ...e, versions: Object.freeze([...e.versions]) })),
)

const UBUNTU_CODENAMES = new Map([['22.04', 'jammy'], ['24.04', 'noble']])
const CENTOS_STREAM_VERSION = /^(9|10)$/
const EL_REBUILD_VERSION = /^(9|10)(?:\.\d{1,3})?$/

const unsupported = (r: OsRelease, reason: string): never =>
  fail('UNSUPPORTED_OS', `unsupported operating system: ${reason}`, {
    id: preview(r.id),
    versionId: preview(r.versionId),
    prettyName: preview(r.prettyName),
  })

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

const ubuntu = (r: OsRelease): SupportedOs => {
  const codename = UBUNTU_CODENAMES.get(r.versionId)
  if (!codename) return unsupported(r, 'only Ubuntu 22.04 and 24.04 LTS are supported')
  const claimed = text(r.versionCodename)
  if (claimed !== '' && claimed !== codename) return unsupported(r, 'Ubuntu codename does not match VERSION_ID')
  return { family: 'debian', id: 'ubuntu', versionId: r.versionId, major: Number(r.versionId.slice(0, 2)), codename }
}

const enterprise = (r: OsRelease, id: 'centos' | 'almalinux' | 'rocky'): SupportedOs => {
  const m = (id === 'centos' ? CENTOS_STREAM_VERSION : EL_REBUILD_VERSION).exec(r.versionId)
  if (!m) {
    if (id === 'centos' && r.versionId === '7') return unsupported(r, 'CentOS Linux 7 is end-of-life')
    return unsupported(r, id === 'centos' ? 'only CentOS Stream 9 and 10 are supported' : `only ${id} 9 and 10 are supported`)
  }
  const major = Number(m[1])
  const platform = text(r.platformId)
  if (platform !== '' && platform !== `platform:el${major}`) return unsupported(r, 'PLATFORM_ID does not match VERSION_ID')
  return { family: 'rhel', id, versionId: r.versionId, major, codename: '' }
}

/** Decides support from os-release alone. Anything not on the matrix stops installation. */
export const classifyRelease = (r: OsRelease): SupportedOs => {
  if (r === null || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.versionId !== 'string') {
    return fail('UNSUPPORTED_OS', 'unsupported operating system: os-release could not be read')
  }
  switch (r.id) {
    case 'ubuntu':
      return ubuntu(r)
    case 'centos':
    case 'almalinux':
    case 'rocky':
      return enterprise(r, r.id)
    case 'debian':
      return unsupported(r, 'Debian is not supported, use Ubuntu 22.04 or 24.04')
    default:
      return unsupported(r, 'unknown distribution')
  }
}
