// The agent runs as root. Desired-state files must still be owned by the unprivileged
// xpanel user, or the API cannot update the tree it is responsible for.
import { readFileSync } from 'node:fs'
import { chown as chownPath, lstat } from 'node:fs/promises'

export interface StateFileOwner {
  uid: number
  gid: number
}

interface OwnershipDeps {
  euid: () => number
  lookup: (name: string) => StateFileOwner | null
  chown: (path: string, uid: number, gid: number) => Promise<void>
}

const parsePasswd = (text: string, name: string): StateFileOwner | null => {
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const [user, , uidText, gidText] = line.split(':')
    if (user !== name) continue
    const uid = Number(uidText)
    const gid = Number(gidText)
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0) return null
    return { uid, gid }
  }
  return null
}

const defaultDeps = (): OwnershipDeps => ({
  euid: () => (typeof process.geteuid === 'function' ? process.geteuid() : -1),
  lookup: name => {
    try {
      return parsePasswd(readFileSync('/etc/passwd', 'utf8'), name)
    } catch {
      return null
    }
  },
  chown: (path, uid, gid) => chownPath(path, uid, gid),
})

let deps: OwnershipDeps = defaultDeps()

/** Test seam. Pass null to restore the process owner lookup. */
export const setStateOwnershipDepsForTests = (next: Partial<OwnershipDeps> | null): void => {
  deps = next === null ? defaultDeps() : { ...defaultDeps(), ...next }
}

/**
 * When this process is root, make `target` owned by the xpanel user and group.
 * A non-root writer already owns the file as xpanel. A host without that user leaves the file unchanged.
 */
export const claimStateOwnership = async (target: string): Promise<void> => {
  if (process.platform === 'win32') return
  if (deps.euid() !== 0) return
  const owner = deps.lookup('xpanel')
  if (!owner) return
  let current: { uid: number; gid: number }
  try {
    current = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (current.uid === owner.uid && current.gid === owner.gid) return
  await deps.chown(target, owner.uid, owner.gid)
}
