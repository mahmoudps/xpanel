import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { posix } from 'node:path'
import { fail, type ProvisioningAuthorizationReadPorts } from '@xpanel/core'
import { findActiveApiTokenByHash, findActiveSessionByTokenHash, getPrincipal, type Db } from '@xpanel/db'
import type { ProvisioningPreparationOwner } from './account-provisioning-preparation.ts'
export { assertProvisioningAuthorization, parseProvisioningAuthorizationReference } from '@xpanel/core'
export type { ProvisioningAuthorizationReference, ProvisioningAuthorizationReadPorts } from '@xpanel/core'

const denied = (): never => fail('FORBIDDEN', 'the original provisioning credential no longer holds authority', { stateChanged: false })

/** A fixed read-only path under the same narrowly trusted StateStore owner boundary. */
async function readWhmcsAuthority(stateRoot: string, owner: ProvisioningPreparationOwner): Promise<unknown> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || !posix.isAbsolute(stateRoot) || posix.normalize(stateRoot) !== stateRoot) return denied()
  const path = posix.join(stateRoot, 'extended', 'integrations', 'whmcs.json')
  const pins: { path: string; handle: FileHandle; dev: number; ino: number }[] = []
  const verify = async (): Promise<void> => {
    for (const pin of pins) {
      const opened = await pin.handle.stat(), named = await lstat(pin.path)
      const state = pin.path === stateRoot && named.uid === owner.uid && named.gid === owner.gid && (named.mode & 0o7777) === 0o2770
      if (!named.isDirectory() || named.isSymbolicLink() || opened.dev !== pin.dev || opened.ino !== pin.ino || named.dev !== pin.dev || named.ino !== pin.ino
        || !state && ((named.uid !== 0 && named.uid !== owner.uid) || (named.mode & 0o022))) return denied()
    }
  }
  try {
    for (const segment of ['/', ...posix.dirname(path).split('/').filter(Boolean)]) {
      const parent = pins.at(-1), named = parent ? posix.join(parent.path, segment) : '/'
      const handle = await open(parent ? '/proc/self/fd/' + parent.handle.fd + '/' + segment : '/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      pins.push({ path: named, handle, dev: info.dev, ino: info.ino })
      await verify()
    }
    const held = '/proc/self/fd/' + pins.at(-1)!.handle.fd + '/whmcs.json'
    const handle = await open(held, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1 || before.size > 2 * 1024 * 1024 || ![0, owner.uid].includes(before.uid) || (before.mode & 0o022)) return denied()
      const bytes = await handle.readFile(), after = await handle.stat(), named = await lstat(held)
      if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid || before.nlink !== after.nlink
        || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino || named.mode !== after.mode || named.uid !== after.uid || named.gid !== after.gid
        || named.nlink !== after.nlink || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs || named.size !== after.size) return denied()
      await verify()
      return JSON.parse(bytes.toString('utf8')) as unknown
    } finally { await handle.close() }
  } catch { return denied() }
  finally { for (const pin of pins.reverse()) await pin.handle.close() }
}

export const provisioningAuthorizationPorts = (input: { readonly db: Db; readonly stateRoot: string; readonly owner: ProvisioningPreparationOwner }): ProvisioningAuthorizationReadPorts => ({
  principal: id => getPrincipal(input.db, id),
  session: tokenHash => findActiveSessionByTokenHash(input.db, tokenHash),
  apiToken: tokenHash => findActiveApiTokenByHash(input.db, tokenHash),
  whmcs: () => readWhmcsAuthority(input.stateRoot, input.owner),
})
