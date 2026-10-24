import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readFile, readlink, readdir, chmod, unlink } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { withTrustedFile, withTrustedDirectory } from './lifecycle-ownership.mjs'

export const LIFECYCLE_ROOT = '/var/lib/xpanel-lifecycle'
export const LIFECYCLE_BARRIER = LIFECYCLE_ROOT + '/writer-barrier.json'
export const LIFECYCLE_LOCK = LIFECYCLE_ROOT + '/writer.lock'
const exclusives = new WeakMap(), exclusiveScope = new AsyncLocalStorage(), writerScope = new AsyncLocalStorage()
const fail = (code, cause) => { throw Object.assign(new Error(code, cause ? { cause } : undefined), { code }) }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{64}$/
let activeWriters = 0
const writerFlights = new Set()

/** Syntax only; this is never an authorization or a kernel ownership producer. */
export function parseLifecycleBarrier(value) {
  const fields = ['schemaVersion', 'operationId', 'reference', 'kind', 'phase', 'requestFingerprint', 'sequence', 'createdAt']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) || value.schemaVersion !== 1 || !UUID.test(value.operationId) || !(value.reference === null || /^XP-JOB-(?:[0-9]{4}-)?[0-9]{6,16}$/.test(value.reference)) || !['upgrade', 'rollback', 'recover', 'uninstall', 'adopt'].includes(value.kind) || !['pending', 'retirement_pending', 'attention'].includes(value.phase) || !SHA.test(value.requestFingerprint) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) fail('LIFECYCLE_BARRIER_INVALID')
  return Object.freeze({ ...value })
}

/** Missing barrier preserves ordinary existing operation. It never establishes privileged readiness. */
export async function readLifecycleBarrier() {
  try { await lstat(LIFECYCLE_ROOT) } catch (error) { if (error.code === 'ENOENT') return null; fail('LIFECYCLE_BARRIER_UNAVAILABLE', error) }
  try {
    return await withTrustedDirectory(LIFECYCLE_ROOT, async () => {
      try { return await withTrustedFile(LIFECYCLE_BARRIER, { exactMode: 0o644, maxBytes: 16384 }, async pin => parseLifecycleBarrier(JSON.parse(pin.bytes.toString('utf8')))) }
      catch (error) { if (error.code === 'ENOENT') return null; throw error }
    })
  } catch (error) {
    fail('LIFECYCLE_BARRIER_UNAVAILABLE', error)
  }
}

/** Validated native lock identifies managed startup; absence permits legacy behavior only. */
export async function isLifecycleManaged() {
  try { await lstat(LIFECYCLE_ROOT) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  try { return await withTrustedFile(LIFECYCLE_LOCK, { exactMode: 0o644, maxBytes: 0 }, async () => true) }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

export async function assertLifecycleWritesAllowed() {
  const barrier = await readLifecycleBarrier()
  if (barrier) fail('LIFECYCLE_WRITES_FENCED')
}

/** Must be called before authentication/session/audit writes; exact process health is read-only. */
export async function lifecycleAdmissionResponse(request, { surface = 'api' } = {}) {
  const url = new URL(request.url)
  if (surface === 'api' && request.method === 'GET' && url.pathname === '/api/health' && url.search === '') return null
  try { await assertLifecycleWritesAllowed(); return null }
  catch { return new Response(JSON.stringify({ error: 'Lifecycle maintenance requires attention before this request can run.' }), { status: 503, headers: { 'content-type': 'application/problem+json', 'retry-after': '5', 'cache-control': 'no-store' } }) }
}

async function flock(fd, exclusive, nonblocking = false) {
  return withTrustedFile('/usr/bin/flock', { maxBytes: 1024 * 1024 }, async tool => new Promise((resolve, reject) => {
    const args = [exclusive ? '--exclusive' : '--shared', ...(nonblocking ? ['--nonblock'] : ['--timeout', '15']), '3']
    const child = spawn('/proc/self/fd/4', args, { stdio: ['ignore', 'ignore', 'ignore', fd, tool.fd], env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
    let spawnError
    child.once('error', error => { spawnError = error })
    // Actual close is mandatory: a timeout result from an observer cannot release a physical lease.
    child.once('close', async (code, signal) => {
      try { await tool.verify() } catch (error) { reject(error); return }
      if (spawnError || signal || code === null) { reject(spawnError ?? new Error('LIFECYCLE_LOCK_CHILD_UNCERTAIN')); return }
      if (code !== 0) { reject(Object.assign(new Error('LIFECYCLE_BUSY'), { code: 'LIFECYCLE_BUSY' })); return }
      resolve()
    })
  }))
}

async function withKernelLock(exclusive, callback) {
  if (process.platform !== 'linux') fail('LIFECYCLE_LINUX_REQUIRED')
  return withTrustedFile(LIFECYCLE_LOCK, { exactMode: 0o644, maxBytes: 0 }, async pin => {
    await flock(pin.fd, exclusive)
    const before = await lstat(LIFECYCLE_LOCK, { bigint: true })
    const verify = async () => { await pin.verify(); const after = await lstat(LIFECYCLE_LOCK, { bigint: true }); if (before.dev !== after.dev || before.ino !== after.ino) fail('LIFECYCLE_LOCK_CHANGED') }
    await verify()
    const result = await callback({ fd: pin.fd, verify })
    await verify()
    return result
  })
}

async function admittedWriter(callback) {
  if (typeof callback !== 'function') fail('LIFECYCLE_CALLBACK_REQUIRED')
  const exclusive = exclusiveScope.getStore()
  if (exclusive) {
    await assertLifecycleExclusivePhysicalHeld(exclusive.capability)
    const native = await import('./lifecycle-root-safety.mjs')
    await native.assertLifecycleRootSafetyHeld(exclusive.capability, { effect: 'filesystem.write' })
    return callback()
  }
  const nested = writerScope.getStore()
  if (nested?.active) {
    await assertLifecycleWritesAllowed()
    const pending = Promise.resolve().then(callback); nested.pending.add(pending)
    try { return await pending } finally { nested.pending.delete(pending) }
  }
  await assertLifecycleWritesAllowed()
  try { await lstat(LIFECYCLE_LOCK) } catch (error) {
    // An installation without the native lifecycle protocol keeps its normal behavior.
    // The native upgrade factory separately requires adoption, strict DB and this actual lock.
    if (error.code === 'ENOENT') return callback()
    throw error
  }
  return withKernelLock(false, async lock => {
    await assertLifecycleWritesAllowed()
    const state = { ...lock, active: true, pending: new Set() }
    activeWriters++
    try { return await writerScope.run(state, callback) }
    finally { while (state.pending.size) await Promise.allSettled([...state.pending]); state.active = false; activeWriters-- }
  })
}

/** Tracks full admission retirement, including lock/FD closure, without observer deadlines. */
export function withLifecycleWriterAdmission(callback) {
  const flight = admittedWriter(callback)
  writerFlights.add(flight)
  return flight.then(value => { writerFlights.delete(flight); return value }, error => { writerFlights.delete(flight); throw error })
}
export async function awaitLifecycleWriterDrain() { while (writerFlights.size) await Promise.allSettled([...writerFlights]) }
/** Long-lived listeners/timers must create a fresh admission on each bounded callback. */
export function createLifecycleBackgroundResources(callback) { return writerScope.exit(callback) }

/** Called only with a genuine native scope. No receipt, environment value or callback grants EX. */
export async function withLifecycleExclusiveAdmission(capability, callback) {
  const native = await import('./lifecycle-root-safety.mjs')
  await native.assertLifecycleRootSafetyHeld(capability, { effect: 'filesystem.write' })
  if (exclusiveScope.getStore() || writerScope.getStore()) fail('LIFECYCLE_SCOPE_CONFLICT')
  return withKernelLock(true, async lock => {
    const state = { lock, active: true, capability }
    exclusives.set(capability, state)
    try { return await exclusiveScope.run(state, callback) }
    finally { state.active = false; exclusives.delete(capability) }
  })
}

export async function assertLifecycleExclusivePhysicalHeld(capability) {
  const state = capability && typeof capability === 'object' ? exclusives.get(capability) : undefined
  if (!state || !state.active || exclusiveScope.getStore() !== state) fail('LIFECYCLE_EXCLUSIVE_CAPABILITY_REQUIRED')
  await state.lock.verify(); await flock(state.lock.fd, true, true)
}

/** Native socket/PID/FD observations bind replacement writer participation to the current barrier. */
export async function verifyNativeWriterGeneration(capability, operationId) {
  await assertLifecycleExclusivePhysicalHeld(capability)
  const native = await import('./lifecycle-root-safety.mjs')
  const info = native.getLifecycleRootSafetyInfo(capability)
  if (info.operationId !== operationId) fail('LIFECYCLE_OPERATION_CHANGED')
  const barrier = await readLifecycleBarrier()
  if (!barrier || barrier.operationId !== operationId) return false
  for (const role of ['api', 'agent']) {
    const state = await native.observeLifecycleWriterService(capability, role)
    const path = `/run/xpanel/lifecycle-${role}/participant.sock`
    const socket = await lstat(path, { bigint: true })
    if (!socket.isSocket() || Number(socket.uid) !== state.uid || (socket.mode & 0o022n) !== 0n) fail('LIFECYCLE_WRITER_SOCKET_UNOWNED')
    const unix = await readFile('/proc/net/unix', 'utf8')
    const row = unix.split('\n').find(line => line.trim().split(/\s+/).at(-1) === path)
    const inode = row?.trim().split(/\s+/)[6]
    if (!inode || !/^[0-9]+$/.test(inode)) fail('LIFECYCLE_WRITER_SOCKET_UNBOUND')
    let owns = false
    for (const descriptor of await readdir(`/proc/${state.pid}/fd`)) { try { if (await readlink(`/proc/${state.pid}/fd/${descriptor}`) === `socket:[${inode}]`) owns = true } catch { /* A disappearing FD is not positive evidence. */ } }
    if (!owns) fail('LIFECYCLE_WRITER_SOCKET_PROCESS_MISMATCH')
    const nonce = randomBytes(32).toString('hex')
    const response = await new Promise((resolve, reject) => {
      const client = connect(path); let bytes = ''
      client.setTimeout(2000, () => client.destroy(new Error('LIFECYCLE_WRITER_HANDSHAKE_TIMEOUT')))
      client.on('error', reject)
      client.on('connect', () => client.end(JSON.stringify({ nonce, operationId }) + '\n'))
      client.on('data', chunk => { bytes += chunk; if (Buffer.byteLength(bytes) > 8192) client.destroy(new Error('LIFECYCLE_WRITER_HANDSHAKE_LIMIT')) })
      client.on('end', () => { try { resolve(JSON.parse(bytes)) } catch (error) { reject(error) } })
    })
    if (!response || response.nonce !== nonce || response.operationId !== operationId || response.pid !== state.pid || response.start !== state.start || response.role !== role || response.activeWriters !== 0 || response.fenced !== true) fail('LIFECYCLE_WRITER_GENERATION_MISMATCH')
    await native.observeLifecycleWriterService(capability, role, state)
  }
  return true
}

/** Reviewed daemon startup installs this read-only participant; it is never a public bypass. */
export async function startLifecycleWriterParticipant(role, { onFence } = {}) {
  if (process.platform !== 'linux' || !['api', 'agent'].includes(role)) fail('LIFECYCLE_PARTICIPANT_PLATFORM_REQUIRED')
  const cgroup = await readFile(`/proc/${process.pid}/cgroup`, 'utf8')
  if (cgroup.trim() !== `0::/system.slice/xpanel-${role}.service`) fail('LIFECYCLE_PARTICIPANT_SERVICE_REQUIRED')
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8'), start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  if (onFence !== undefined && typeof onFence !== 'function') fail('LIFECYCLE_PARTICIPANT_DRAIN_INVALID')
  const directory = `/run/xpanel/lifecycle-${role}`, path = directory + '/participant.sock'
  for (const ancestor of ['/run', '/run/xpanel']) {
    const info = await lstat(ancestor, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0n || (info.mode & 0o022n) !== 0n) fail('LIFECYCLE_PARTICIPANT_DIRECTORY_UNSAFE')
  }
  const parent = await lstat(directory, { bigint: true })
  if (!parent.isDirectory() || parent.isSymbolicLink() || Number(parent.uid) !== process.geteuid() || Number(parent.mode & 0o7777n) !== 0o700) fail('LIFECYCLE_PARTICIPANT_DIRECTORY_UNSAFE')
  const parentPin = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const verifyParent = async () => { const [opened, named] = await Promise.all([parentPin.stat({ bigint: true }), lstat(directory, { bigint: true })]); if (opened.dev !== parent.dev || opened.ino !== parent.ino || named.dev !== parent.dev || named.ino !== parent.ino || named.uid !== parent.uid || named.mode !== parent.mode) fail('LIFECYCLE_PARTICIPANT_DIRECTORY_CHANGED') }
  await verifyParent()
  try { await lstat(path); fail('LIFECYCLE_PARTICIPANT_SOCKET_EXISTS') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const server = createServer({ allowHalfOpen: true }, socket => {
    let bytes = ''; socket.setTimeout(2000, () => socket.destroy())
    socket.on('data', chunk => { bytes += chunk; if (Buffer.byteLength(bytes) > 4096) socket.destroy() })
    socket.on('error', () => {})
    socket.on('end', async () => {
      try {
        const request = JSON.parse(bytes), barrier = await readLifecycleBarrier()
        if (!request || !SHA.test(request.nonce) || !UUID.test(request.operationId)) { socket.destroy(); return }
        if (barrier) { await onFence?.(); await awaitLifecycleWriterDrain() }
        await verifyParent()
        socket.end(JSON.stringify({ nonce: request.nonce, operationId: barrier?.operationId ?? null, role, pid: process.pid, start, activeWriters, fenced: !!barrier }) + '\n')
      } catch { socket.destroy() }
    })
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
    await chmod(path, 0o600); await verifyParent()
    const owned = await lstat(path, { bigint: true })
    return Object.freeze({ close: async () => {
      try {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        await verifyParent()
        const current = await lstat(path, { bigint: true })
        if (!current.isSocket() || current.dev !== owned.dev || current.ino !== owned.ino || current.uid !== owned.uid) fail('LIFECYCLE_PARTICIPANT_SOCKET_CHANGED')
        await unlink(path)
      } finally { await parentPin.close() }
    } })
  } catch (error) { server.close(); await parentPin.close(); throw error }
}

export async function readLifecyclePublicStatus() {
  const barrier = await readLifecycleBarrier()
  return Object.freeze({ active: barrier !== null, reference: barrier?.reference ?? null, phase: barrier?.phase ?? 'normal', ...(barrier ? { kind: barrier.kind } : {}) })
}
