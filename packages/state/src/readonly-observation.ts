import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fail } from '@xpanel/core'
import type { StateAuthorityMetadata, StateSnapshot } from './types.ts'
import { validateStateAuthority } from './validate-state.ts'

export interface ReadonlyStateObservation {
  readonly snapshot: StateSnapshot
  readonly authority: Readonly<StateAuthorityMetadata>
  assertCurrent(): Promise<void>
}
const refused = (): never => fail('PRECONDITION_FAILED', 'state changed or requires writer recovery; read-only observation cannot proceed', { stateChanged: false })
const sameNode = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }; return value }

/** Internal StateStore primitive. A supplied path/callback is not native host authority. */
export async function withReadonlyStateObservation<T>(root: string, readSnapshot: (revision: number) => Promise<StateSnapshot>,
  callback: (observation: ReadonlyStateObservation) => Promise<T>): Promise<T> {
  if (resolve(root) !== root || await realpath(root) !== root) return refused()
  const originalRoot = await lstat(root)
  if (!originalRoot.isDirectory() || originalRoot.isSymbolicLink()) return refused()
  const idle = async () => {
    const current = await lstat(root)
    if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(current, originalRoot)) return refused()
    // Reject the entire marker, including malformed/orphan intent. Never clean it during a read.
    try { await lstat(join(root, '.lock')); return refused() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const capture = async () => {
    await idle()
    const path = join(root, 'authority.json'), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const initial = await handle.stat()
      if (!initial.isFile() || initial.nlink !== 1 || initial.size < 1 || initial.size > 1024 * 1024) return refused()
      const bytes = await handle.readFile(), named = await lstat(path), held = await handle.stat()
      if (!named.isFile() || named.isSymbolicLink() || !sameNode(initial, named) || !sameNode(initial, held)
        || initial.size !== bytes.length || named.size !== initial.size || held.size !== initial.size
        || named.mtimeMs !== initial.mtimeMs || held.mtimeMs !== initial.mtimeMs || named.ctimeMs !== initial.ctimeMs || held.ctimeMs !== initial.ctimeMs) return refused()
      const authority = validateStateAuthority(JSON.parse(bytes.toString('utf8')))
      await idle()
      return { authority, node: initial, hash: createHash('sha256').update(bytes).digest('hex') }
    } finally { await handle.close() }
  }
  const initial = await capture()
  const snapshot = await readSnapshot(initial.authority.revision)
  if (snapshot.revision !== initial.authority.revision || !/^[0-9a-f]{64}$/.test(snapshot.checksum)) return refused()
  let active = true
  const assertCurrent = async () => {
    if (!active) return refused()
    const current = await capture()
    if (!active || !sameNode(initial.node, current.node) || current.hash !== initial.hash) return refused()
  }
  await assertCurrent()
  try {
    const result = await callback(Object.freeze({ snapshot: freeze(snapshot), authority: freeze(initial.authority), assertCurrent }))
    await assertCurrent()
    return result
  } finally { active = false }
}
