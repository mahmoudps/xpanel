import { constants } from 'node:fs'
import { lstat, open, opendir, readlink, type FileHandle } from 'node:fs/promises'
import type { Dir } from 'node:fs'
import { fail, isXpanelError } from '@xpanel/core'
import { openNativeProvisioningProcess, parseProvisioningProcessFiles, type ProvisioningProcessIdentity } from './account-provisioning-observer.ts'
import type { HostEffectAuthority } from './host-effect-authority.ts'
import type { NativePeerIdentityAddon } from './peer-identity.ts'

export interface UnixSocketPeerPin {
  readonly socketInode: number
  readonly peerInode: number
  readonly cookieLo: number
  readonly cookieHi: number
}

const deny: (reason: string) => never = reason => fail('PRECONDITION_FAILED', 'the Unix socket peer relation was not verified', {
  stateChanged: false, verificationRequired: true, reason,
})
const nativeRoot = (): void => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) deny('unix_socket_peer_root_linux_required')
}
const uint32 = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff

/** Snapshot only. Caller must own and keep this exact connected FD open. No authorization is granted. */
export function inspectHeldUnixSocketPeer(addon: Pick<NativePeerIdentityAddon, 'getUnixSocketPeer'>, fd: number): UnixSocketPeerPin {
  nativeRoot()
  if (!Number.isSafeInteger(fd) || fd < 0 || fd > 0x7fffffff) return deny('unix_socket_peer_fd_invalid')
  const inspect = addon.getUnixSocketPeer
  if (typeof inspect !== 'function') return deny('unix_socket_peer_query_unavailable')
  let value: unknown
  try { value = inspect.call(addon, fd) } catch { return deny('unix_socket_peer_query_failed') }
  if (value === null || typeof value !== 'object' || !('socketInode' in value) || !('peerInode' in value)
    || !('cookieLo' in value) || !('cookieHi' in value)) return deny('unix_socket_peer_query_malformed')
  const { socketInode, peerInode, cookieLo, cookieHi } = value
  if (!uint32(socketInode) || socketInode === 0 || !uint32(peerInode) || peerInode === 0 || socketInode === peerInode
    || !uint32(cookieLo) || !uint32(cookieHi) || (cookieLo === 0 && cookieHi === 0)
    || (cookieLo === 0xffffffff && cookieHi === 0xffffffff)) return deny('unix_socket_peer_query_malformed')
  return Object.freeze({ socketInode, peerInode, cookieLo, cookieHi })
}

const samePin = (a: UnixSocketPeerPin, b: UnixSocketPeerPin): boolean =>
  a.socketInode === b.socketInode && a.peerInode === b.peerInode && a.cookieLo === b.cookieLo && a.cookieHi === b.cookieHi
const sameProcess = (a: ProvisioningProcessIdentity, b: ProvisioningProcessIdentity): boolean =>
  a.pid === b.pid && a.parentPid === b.parentPid && a.startTime === b.startTime && a.cgroup === b.cgroup
  && a.uids.length === 4 && b.uids.length === 4 && a.uids.every((uid, index) => uid === b.uids[index])
  && a.gids.length === 4 && b.gids.length === 4 && a.gids.every((gid, index) => gid === b.gids[index])
  && !['Z', 'X', 'x'].includes(a.state) && !['Z', 'X', 'x'].includes(b.state)
const disappeared = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'

/**
 * A bounded snapshot of exact socket ownership, not a worker lease or HTTP proof by itself.
 * Caller supplies kernel-derived worker identity and keeps its immutable canary/HTTP transport live.
 * Existing account/lifecycle authority and proc/account binding remain required independently.
 */
export async function assertUnixSocketPeerHeldByProcess(
  addon: Pick<NativePeerIdentityAddon, 'getUnixSocketPeer'>,
  fd: number,
  pin: UnixSocketPeerPin,
  expected: ProvisioningProcessIdentity,
  context: HostEffectAuthority,
): Promise<void> {
  nativeRoot()
  const guard = async (): Promise<void> => {
    if (context.readOnly !== true || context.signal.aborted) deny('unix_socket_peer_authority_unavailable')
    await context.assertAuthority()
    if (context.signal.aborted) deny('unix_socket_peer_authority_unavailable')
  }
  await guard()
  if (!samePin(pin, inspectHeldUnixSocketPeer(addon, fd))) deny('unix_socket_peer_changed')
  let processFiles: Awaited<ReturnType<typeof openNativeProvisioningProcess>> | undefined
  let directory: FileHandle | undefined
  let entries: Dir | undefined
  let failed = false
  try {
    const heldProcess = await openNativeProvisioningProcess(expected.pid)
    processFiles = heldProcess
    await guard()
    const snapshot = async (): Promise<ProvisioningProcessIdentity> => {
      const stat = await heldProcess.read('stat'); await guard()
      const status = await heldProcess.read('status'); await guard()
      const cgroup = await heldProcess.read('cgroup'); await guard()
      await heldProcess.assertCurrent(); await guard()
      return parseProvisioningProcessFiles(expected.pid, { stat, status, cgroup })
    }
    const before = await snapshot()
    if (!sameProcess(expected, before)) deny('unix_socket_peer_process_changed')
    const name = '/proc/' + expected.pid + '/fd'
    const heldDirectory = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    directory = heldDirectory
    await guard()
    const initial = await heldDirectory.stat(); await guard()
    if (!initial.isDirectory()) deny('unix_socket_peer_fd_directory_invalid')
    const heldPath = '/proc/self/fd/' + heldDirectory.fd
    const stream = await opendir(heldPath, { bufferSize: 32 })
    entries = stream
    await guard()
    let matchingName: string | undefined
    for (let count = 0; count <= 4096; count++) {
      const entry = await stream.read()
      if (!entry) break
      if (count === 4096) deny('unix_socket_peer_fd_limit')
      if (count % 32 === 0) await guard()
      if (!/^[0-9]+$/.test(entry.name)) continue
      let target: string
      try { target = await readlink(heldPath + '/' + entry.name) }
      catch (error) { if (disappeared(error)) continue; throw error }
      if (target === 'socket:[' + pin.peerInode + ']') { matchingName = entry.name; break }
    }
    await guard()
    if (matchingName === undefined) deny('unix_socket_peer_not_held_by_process')
    const after = await snapshot()
    if (!sameProcess(before, after) || !sameProcess(expected, after)) deny('unix_socket_peer_process_changed')
    const [held, named, target] = await Promise.all([
      heldDirectory.stat(), lstat(name), readlink(heldPath + '/' + matchingName),
    ])
    await guard()
    if (!held.isDirectory() || !named.isDirectory() || held.dev !== initial.dev || held.ino !== initial.ino
      || named.dev !== initial.dev || named.ino !== initial.ino || target !== 'socket:[' + pin.peerInode + ']') deny('unix_socket_peer_fd_changed')
    if (!samePin(pin, inspectHeldUnixSocketPeer(addon, fd))) deny('unix_socket_peer_changed')
    await heldProcess.assertCurrent()
    await guard()
  } catch (error) {
    failed = true
    if (isXpanelError(error)) throw error
    return deny('unix_socket_peer_process_unavailable')
  } finally {
    const closed = await Promise.allSettled([
      () => entries?.close(), () => directory?.close(), () => processFiles?.close(),
    ].map(close => Promise.resolve().then(close)))
    if (!failed && closed.some(result => result.status === 'rejected')) deny('unix_socket_peer_release_failed')
  }
  await guard()
}
