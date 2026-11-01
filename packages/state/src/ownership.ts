// The agent runs as root. Desired-state files must still be owned by the unprivileged
// xpanel user, or the API cannot update the tree it is responsible for.
import { constants, readFileSync } from 'node:fs'
import { chown as chownPath, lstat, open } from 'node:fs/promises'

export interface StateFileOwner {
  uid: number
  gid: number
}

interface StateDirectoryMetadata extends StateFileOwner {
  dev: number
  ino: number
  mode: number
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

interface StateDirectoryHandle {
  stat(): Promise<StateDirectoryMetadata>
  chmod(mode: number): Promise<void>
  close(): Promise<void>
}

interface OwnershipDeps {
  platform: () => NodeJS.Platform
  euid: () => number
  lookup: (name: string) => StateFileOwner | null
  chown: (path: string, uid: number, gid: number) => Promise<void>
  inspectPath: (path: string) => Promise<StateDirectoryMetadata>
  openInstalledParent: () => Promise<StateDirectoryHandle>
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

const INSTALLED_STATE_PARENT = '/var/lib/xpanel'

const defaultDeps = (): OwnershipDeps => ({
  platform: () => process.platform,
  euid: () => (typeof process.geteuid === 'function' ? process.geteuid() : -1),
  lookup: name => {
    try {
      return parsePasswd(readFileSync('/etc/passwd', 'utf8'), name)
    } catch {
      return null
    }
  },
  chown: (path, uid, gid) => chownPath(path, uid, gid),
  inspectPath: path => lstat(path),
  openInstalledParent: async () => {
    const handle = await open(INSTALLED_STATE_PARENT, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    return {
      stat: () => handle.stat(),
      chmod: mode => handle.chmod(mode),
      close: () => handle.close(),
    }
  },
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

const directory = (node: StateDirectoryMetadata): boolean => node.isDirectory() && !node.isSymbolicLink()
const sameNode = (left: StateDirectoryMetadata, right: StateDirectoryMetadata): boolean =>
  left.dev === right.dev && left.ino === right.ino
const installedParentFailure = (): never => {
  throw new Error('the installed xpanel state parent requires an inspected ownership or permission repair')
}

/**
 * Narrow the legacy installer-owned parent without broadening either protected reader.
 * Trusted startup supplies its actual configured paths before opening writer resources.
 * Custom stores return before any inspection; no operation target is derived from those strings.
 */
export const protectInstalledStateParent = async (configuration: { readonly dbPath: string; readonly stateDir: string }): Promise<void> => {
  if (deps.platform() !== 'linux' || configuration.dbPath !== '/var/lib/xpanel/control.db'
    || configuration.stateDir !== '/var/lib/xpanel/state') return
  let named: StateDirectoryMetadata
  try { named = await deps.inspectPath(INSTALLED_STATE_PARENT) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const owner = deps.lookup('xpanel')
  if (!owner || !Number.isSafeInteger(owner.uid) || owner.uid <= 0 || !Number.isSafeInteger(owner.gid) || owner.gid <= 0
    || (deps.euid() !== 0 && deps.euid() !== owner.uid)) return installedParentFailure()
  const apiOwner = owner
  const parents = ['/', '/var', '/var/lib'] as const
  const assertParents = async (): Promise<void> => {
    for (const path of parents) {
      const node = await deps.inspectPath(path)
      if (!directory(node) || node.uid !== 0 || (node.mode & 0o022) !== 0) installedParentFailure()
    }
  }
  await assertParents()
  const handle = await deps.openInstalledParent()
  try {
    const held = await handle.stat()
    const initialMode = held.mode & 0o7777
    const namedMode = named.mode & 0o7777
    const consistentMode = namedMode === initialMode || (namedMode === 0o2770 && initialMode === 0o2750)
    const valid = (node: StateDirectoryMetadata): boolean =>
      directory(node) && node.uid === apiOwner.uid && node.gid === apiOwner.gid
    if (!valid(held) || !valid(named) || !sameNode(held, named) || !consistentMode
      || (initialMode !== 0o2770 && initialMode !== 0o2750)) installedParentFailure()
    // Both API and root agent retain their existing writes; only group write is removed.
    if (initialMode === 0o2770) await handle.chmod(0o2750)
    await assertParents()
    const current = await handle.stat()
    named = await deps.inspectPath(INSTALLED_STATE_PARENT)
    if (!valid(current) || !valid(named) || !sameNode(held, current) || !sameNode(held, named)
      || (current.mode & 0o7777) !== 0o2750 || (named.mode & 0o7777) !== 0o2750) installedParentFailure()
  } finally { await handle.close() }
}

