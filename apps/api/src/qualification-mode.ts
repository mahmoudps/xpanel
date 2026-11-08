import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { deliveryTarget } from '@xpanel/catalog'

/** Never created by the installer or a package. Agent and API writes never name this path. */
export const QUALIFICATION_MODE_FILE = '/etc/xpanel/qualification-mode'
const QUALIFICATION_MODE_DIRECTORY = '/etc/xpanel'
const MACHINE_ID_FILE = '/etc/machine-id'
const MACHINE_ID = /^[0-9a-f]{32}$/

export interface QualificationHostFacts {
  directory: { directory: boolean; uid: number; mode: number }
  file: { regular: boolean; uid: number; mode: number; links: number }
  content: string
  machineId: string
}

const readHostFacts = (): QualificationHostFacts => {
  const parent = lstatSync(QUALIFICATION_MODE_DIRECTORY)
  // One descriptor for the stat and the read, so a swapped path cannot pass one and supply the other.
  const descriptor = openSync(QUALIFICATION_MODE_FILE, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > 64) throw new Error('not the switch file')
    return {
      directory: { directory: parent.isDirectory(), uid: parent.uid, mode: parent.mode & 0o7777 },
      file: { regular: true, uid: stat.uid, mode: stat.mode & 0o7777, links: stat.nlink },
      content: readFileSync(descriptor, 'utf8'), machineId: readFileSync(MACHINE_ID_FILE, 'utf8'),
    }
  } finally { closeSync(descriptor) }
}

/**
 * Owner decision 11: on only for an operator's hand-made root-owned file that names this machine. A published
 * release is production and never honours it. Nothing here reads a request, and every doubt means off.
 */
export const readQualificationMode = (facts: () => QualificationHostFacts = readHostFacts, published = deliveryTarget !== null): boolean => {
  if (published) return false
  try {
    const { directory, file, content, machineId } = facts()
    return directory.directory && directory.uid === 0 && (directory.mode & 0o022) === 0
      && file.regular && file.uid === 0 && file.mode === 0o444 && file.links === 1
      && MACHINE_ID.test(content.trim()) && content.trim() === machineId.trim()
  } catch { return false }
}
