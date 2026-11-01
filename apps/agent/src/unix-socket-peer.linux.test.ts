import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, readFile, realpath, rm, type FileHandle } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disposableVmAcknowledgement } from '../../../scripts/test-linux-preflight.mjs'
import { parseProvisioningProcessFiles, type ProvisioningProcessIdentity } from './account-provisioning-observer.ts'
import type { HostEffectAuthority } from './host-effect-authority.ts'
import { loadNativePeerIdentityAddon, type NativePeerIdentityAddon } from './peer-identity.ts'
import { assertUnixSocketPeerHeldByProcess, inspectHeldUnixSocketPeer } from './unix-socket-peer.ts'

// Real kernel/FD relation only. Python socket holders are not PHP or hosted-workload proof.
const python = '/usr/bin/python3', uid = 65534, gid = 65534
const children: Worker[] = []
const clients: Socket[] = []
let root = '', nativeRoot = '', addon: NativePeerIdentityAddon
let nativeParentHandle: FileHandle | undefined, nativeRootHandle: FileHandle | undefined
let sequence = 0
const workerCode = [
  'import os,socket,sys',
  'os.setgroups([]); os.setgid(int(sys.argv[3])); os.setuid(int(sys.argv[2]))',
  'server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)',
  'server.bind(sys.argv[1]); server.listen(1)',
  'print("READY",flush=True)',
  'connection,_=server.accept()',
  'print("ACCEPTED",flush=True)',
  'try:',
  ' for command in sys.stdin:',
  '  command=command.strip()',
  '  if command=="CLOSE":',
  '   if connection is not None: connection.close(); connection=None',
  '   print("CLOSED",flush=True)',
  '  elif command=="EXIT": break',
  'finally:',
  ' if connection is not None: connection.close()',
  ' server.close()',
].join('\n')

interface Worker {
  child: ChildProcessWithoutNullStreams
  pid: number
  socketPath: string
  line(expected: string): Promise<void>
}
const guarded = (): HostEffectAuthority => ({ readOnly: true, signal: new AbortController().signal, async assertAuthority() {} })
const socketFd = (socket: object): number => {
  const handle: unknown = Reflect.get(socket, '_handle')
  if (handle === null || typeof handle !== 'object') throw new Error('fixture socket has no live native handle')
  const fd: unknown = Reflect.get(handle, 'fd')
  if (typeof fd !== 'number' || !Number.isSafeInteger(fd) || fd < 0) throw new Error('fixture socket has no FD')
  return fd
}
const identity = async (pid: number): Promise<ProvisioningProcessIdentity> => {
  const [stat, status, cgroup] = await Promise.all(['stat', 'status', 'cgroup'].map(name => readFile('/proc/' + pid + '/' + name, 'utf8')))
  if (stat === undefined || status === undefined || cgroup === undefined) throw new Error('fixture process metadata unavailable')
  return parseProvisioningProcessFiles(pid, { stat, status, cgroup })
}
const worker = async (): Promise<Worker> => {
  const directory = root + '/worker-' + ++sequence
  await mkdir(directory, { mode: 0o700 }); await chown(directory, uid, gid)
  const socketPath = directory + '/pool.sock'
  const child = spawn(python, ['-I', '-u', '-c', workerCode, socketPath, String(uid), String(gid)], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } })
  const pid = child.pid
  if (pid === undefined) throw new Error('fixture worker failed to spawn')
  let buffered = '', errorText = '', closed = false
  const lines: string[] = []
  const waiting: Array<{ expected: string; resolve(): void; reject(error: Error): void }> = []
  child.stderr.on('data', bytes => { errorText = (errorText + String(bytes)).slice(-2048) })
  const fail = (error: Error) => { closed = true; for (const item of waiting.splice(0)) item.reject(error) }
  child.once('error', fail)
  child.once('exit', () => fail(new Error('fixture worker exited: ' + errorText)))
  child.stdout.on('data', bytes => {
    buffered += String(bytes)
    while (buffered.includes('\n')) {
      const end = buffered.indexOf('\n'), value = buffered.slice(0, end).trim(); buffered = buffered.slice(end + 1)
      const pending = waiting.shift()
      if (pending) { if (pending.expected === value) pending.resolve(); else pending.reject(new Error('unexpected worker protocol')) }
      else lines.push(value)
    }
  })
  const result: Worker = { child, pid, socketPath, async line(expected) {
    const found = lines.shift()
    if (found !== undefined) { if (found !== expected) throw new Error('unexpected buffered worker protocol'); return }
    if (closed) throw new Error('fixture worker already exited')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture worker protocol timeout')) }, 4000)
      waiting.push({ expected, resolve() { clearTimeout(timer); resolve() }, reject(error) { clearTimeout(timer); reject(error) } })
    })
  } }
  children.push(result)
  await result.line('READY')
  return result
}
const connect = async (target: Worker): Promise<Socket> => {
  const socket = createConnection({ path: target.socketPath, allowHalfOpen: true })
  clients.push(socket); socket.pause()
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  await target.line('ACCEPTED')
  return socket
}
const pair = async () => {
  const a = await worker(), b = await worker()
  const clientA = await connect(a), clientB = await connect(b)
  return { a, b, clientA, clientB, fdA: socketFd(clientA), fdB: socketFd(clientB), expectedA: await identity(a.pid), expectedB: await identity(b.pid) }
}

beforeAll(async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0
    || process.env.XPANEL_TEST_DISPOSABLE_VM !== disposableVmAcknowledgement) throw new Error('BLOCKED: explicit root disposable Linux VM required')
  if (!existsSync(python)) throw new Error('BLOCKED: fixture Python3 required')
  root = '/run/xpanel-unix-peer-' + randomBytes(6).toString('hex')
  await mkdir(root, { mode: 0o711 }); await chmod(root, 0o711)
  // Shared-library mappings require an executable, root-owned directory chain.
  nativeParentHandle = await open('/var/cache', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const [parent, namedParent] = await Promise.all([nativeParentHandle.stat(), lstat('/var/cache')])
  if (!parent.isDirectory() || parent.uid !== 0 || parent.gid !== 0 || (parent.mode & 0o022) !== 0
    || parent.dev !== namedParent.dev || parent.ino !== namedParent.ino || await realpath('/var/cache') !== '/var/cache') throw new Error('fixture native-cache parent ownership mismatch')
  const directory = '/var/cache/xpanel-unix-peer-native-' + randomBytes(6).toString('hex')
  await mkdir(directory, { mode: 0o700 }); nativeRoot = directory
  nativeRootHandle = await open(nativeRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const native = await nativeRootHandle.stat()
  if (!native.isDirectory() || native.uid !== 0 || native.gid !== 0 || (native.mode & 0o7777) !== 0o700) throw new Error('fixture native-cache ownership mismatch')
  addon = await loadNativePeerIdentityAddon({ cacheDir: nativeRoot, forceRebuild: true })
  expect(typeof addon.getUnixSocketPeer).toBe('function')
})
afterAll(async () => {
  for (const socket of clients) socket.destroy()
  await Promise.all(children.map(async ({ child }) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL') }, 1000)
      const retirement = setTimeout(() => { clearTimeout(timer); reject(new Error('owned fixture child did not retire')) }, 4000)
      child.once('exit', () => { clearTimeout(timer); clearTimeout(retirement); resolve() })
      child.stdin.end('EXIT\n')
    })
  }))
  if (root) {
    const metadata = await lstat(root)
    if (!root.startsWith('/run/xpanel-unix-peer-') || await realpath(root) !== root || !metadata.isDirectory() || metadata.uid !== 0) throw new Error('fixture cleanup ownership mismatch')
    await rm(root, { recursive: true })
  }
})

afterAll(async () => {
  try {
    if (nativeRoot) {
      if (!nativeRootHandle || !nativeParentHandle) throw new Error('fixture native-cache identity unavailable')
      const [held, named, parent, namedParent] = await Promise.all([nativeRootHandle.stat(), lstat(nativeRoot), nativeParentHandle.stat(), lstat('/var/cache')])
      if (!nativeRoot.startsWith('/var/cache/xpanel-unix-peer-native-') || await realpath(nativeRoot) !== nativeRoot
        || !held.isDirectory() || !named.isDirectory() || held.dev !== named.dev || held.ino !== named.ino
        || held.uid !== 0 || held.gid !== 0 || named.uid !== 0 || named.gid !== 0
        || (held.mode & 0o7777) !== 0o700 || (named.mode & 0o7777) !== 0o700
        || !parent.isDirectory() || !namedParent.isDirectory() || parent.dev !== namedParent.dev || parent.ino !== namedParent.ino
        || parent.uid !== 0 || parent.gid !== 0 || namedParent.uid !== 0 || namedParent.gid !== 0
        || (parent.mode & 0o022) !== 0 || (namedParent.mode & 0o022) !== 0 || await realpath('/var/cache') !== '/var/cache') throw new Error('fixture native-cache cleanup identity mismatch')
      await rm(nativeRoot, { recursive: true })
    }
  } finally {
    await Promise.all([nativeRootHandle?.close(), nativeParentHandle?.close()])
  }
})
describe('real Unix diagnostic peer relation; not PHP qualification', { tags: ['feature'] }, () => {
  it('queries the connected peer inode and stable cookie without closing the owner FD', async () => {
    const f = await pair(), pin = inspectHeldUnixSocketPeer(addon, f.fdA)
    expect(pin.peerInode).toBeGreaterThan(0)
    expect(pin.peerInode).not.toBe(pin.socketInode)
    expect(inspectHeldUnixSocketPeer(addon, f.fdA)).toEqual(pin)
    expect(addon.getSocketPeerCred(f.fdA).pid).toBe(f.a.pid)
  })
  it('finds the exact accepted peer FD in the actual worker process', async () => {
    const f = await pair()
    await expect(assertUnixSocketPeerHeldByProcess(addon, f.fdA, inspectHeldUnixSocketPeer(addon, f.fdA), f.expectedA, guarded())).resolves.toBeUndefined()
  })
  it('rejects another genuine same-UID/GID/cgroup worker with a different connection', async () => {
    const f = await pair()
    expect(f.expectedA.uids).toEqual(f.expectedB.uids); expect(f.expectedA.gids).toEqual(f.expectedB.gids); expect(f.expectedA.cgroup).toBe(f.expectedB.cgroup)
    await expect(assertUnixSocketPeerHeldByProcess(addon, f.fdA, inspectHeldUnixSocketPeer(addon, f.fdA), f.expectedB, guarded())).rejects.toMatchObject({ detail: { reason: 'unix_socket_peer_not_held_by_process' } })
  })
  it('rejects substituting another held client FD for the original pin', async () => {
    const f = await pair()
    await expect(assertUnixSocketPeerHeldByProcess(addon, f.fdB, inspectHeldUnixSocketPeer(addon, f.fdA), f.expectedB, guarded())).rejects.toMatchObject({ detail: { reason: 'unix_socket_peer_changed' } })
  })
  it('rejects a changed process start identity', async () => {
    const f = await pair()
    await expect(assertUnixSocketPeerHeldByProcess(addon, f.fdA, inspectHeldUnixSocketPeer(addon, f.fdA), { ...f.expectedA, startTime: '1' }, guarded())).rejects.toMatchObject({ detail: { reason: 'unix_socket_peer_process_changed' } })
  })
  it('rejects changed cgroup identity', async () => {
    const f = await pair()
    await expect(assertUnixSocketPeerHeldByProcess(addon, f.fdA, inspectHeldUnixSocketPeer(addon, f.fdA), { ...f.expectedA, cgroup: '/unrelated.slice' }, guarded())).rejects.toMatchObject({ detail: { reason: 'unix_socket_peer_process_changed' } })
  })
  it('rejects changed UID identity', async () => {
    const f = await pair()
    await expect(assertUnixSocketPeerHeldByProcess(addon, f.fdA, inspectHeldUnixSocketPeer(addon, f.fdA), { ...f.expectedA, uids: [uid + 1, uid + 1, uid + 1, uid + 1] }, guarded())).rejects.toMatchObject({ detail: { reason: 'unix_socket_peer_process_changed' } })
  })
  it('rejects a closed peer while its process remains alive', async () => {
    const f = await pair()
    f.a.child.stdin.write('CLOSE\n'); await f.a.line('CLOSED')
    expect(() => process.kill(f.a.pid, 0)).not.toThrow()
    expect(() => inspectHeldUnixSocketPeer(addon, f.fdA)).toThrow()
  })
  it('rejects an owner FD after close', async () => {
    const f = await pair(), fd = f.fdA, pin = inspectHeldUnixSocketPeer(addon, f.fdA)
    await new Promise<void>(resolve => { f.clientA.once('close', () => resolve()); f.clientA.destroy() })
    await expect(assertUnixSocketPeerHeldByProcess(addon, fd, pin, f.expectedA, guarded())).rejects.toThrow()
  })
  it('rejects a regular file FD', async () => {
    const handle = await open('/proc/self/status', 'r')
    try { expect(() => inspectHeldUnixSocketPeer(addon, handle.fd)).toThrow() } finally { await handle.close() }
  })
  it('rejects a listening socket that has no connected peer', async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(root + '/listening.sock', resolve) })
    try { expect(() => inspectHeldUnixSocketPeer(addon, socketFd(server))).toThrow() }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
  it('fails closed for an old addon without the method', () => {
    expect(() => inspectHeldUnixSocketPeer({}, 0)).toThrow()
  })
  it('fails closed for malformed kernel result metadata and sentinel cookies', () => {
    for (const value of [null, {}, { socketInode: 1, peerInode: 0, cookieLo: 1, cookieHi: 0 },
      { socketInode: 1, peerInode: 2, cookieLo: 0, cookieHi: 0 }, { socketInode: 1, peerInode: 2, cookieLo: 0xffffffff, cookieHi: 0xffffffff }]) {
      expect(() => inspectHeldUnixSocketPeer({ getUnixSocketPeer() { return value } }, 0)).toThrow()
    }
  })
  it('refuses canceled authority before any native query', async () => {
    const f = await pair(), pin = inspectHeldUnixSocketPeer(addon, f.fdA), controller = new AbortController()
    controller.abort()
    let called = false
    await expect(assertUnixSocketPeerHeldByProcess({ getUnixSocketPeer() { called = true; throw new Error('must not query') } }, f.fdA, pin, f.expectedA,
      { readOnly: true, signal: controller.signal, async assertAuthority() {} })).rejects.toMatchObject({ detail: { reason: 'unix_socket_peer_authority_unavailable' } })
    expect(called).toBe(false)
  })
  it('rejects fractional, negative and non-finite native FD arguments', () => {
    const query = addon.getUnixSocketPeer
    if (typeof query !== 'function') throw new Error('missing tested native method')
    for (const fd of [-1, 0.25, Number.NaN, Number.POSITIVE_INFINITY, 0x80000000]) expect(() => query.call(addon, fd)).toThrow()
  })
})
