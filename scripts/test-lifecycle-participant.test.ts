import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The real participant on a real Unix socket, its fixed /run directory mapped onto a private
// temporary directory. This proves the protocol and close path, not systemd or root ownership.
const seam = vi.hoisted(() => ({ dir: '', barrier: null as Buffer | null, foreignUid: false }))
const DIRECTORY = '/run/xpanel/lifecycle-agent'
const mapped = (path: unknown) => typeof path === 'string' && path.startsWith(DIRECTORY) ? seam.dir + path.slice(DIRECTORY.length) : path
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  const rootDirectory = { isDirectory: () => true, isSymbolicLink: () => false, uid: 0n, mode: 0o40755n }
  return { ...actual,
    readFile: (path: string, ...rest: [BufferEncoding]) => path === `/proc/${process.pid}/cgroup` ? Promise.resolve('0::/system.slice/xpanel-agent.service\n') : actual.readFile(path, ...rest),
    lstat: (path: string, ...rest: [{ bigint: true }]) => path === '/run' || path === '/run/xpanel' ? Promise.resolve(rootDirectory)
      : path === '/var/lib/xpanel-lifecycle' ? Promise.resolve({}) : actual.lstat(mapped(path) as string, ...rest)
        .then(stat => seam.foreignUid && path.endsWith('/participant.sock') ? Object.assign(stat, { uid: stat.uid + 1n }) : stat),
    unlink: (path: string) => actual.unlink(mapped(path) as string),
    open: (path: string, ...rest: [number]) => actual.open(mapped(path) as string, ...rest),
    chmod: (path: string, mode: number) => actual.chmod(mapped(path) as string, mode),
  }
})
vi.mock('node:net', async original => {
  const actual = await original<typeof import('node:net')>()
  return { ...actual, createServer: ((...args: Parameters<typeof actual.createServer>) => {
    const server = actual.createServer(...args), listen = server.listen.bind(server)
    return Object.assign(server, { listen: (path: string, callback: () => void) => listen(mapped(path) as string, callback) })
  }) as typeof actual.createServer, connect: ((path: string) => actual.connect(mapped(path) as string)) as typeof actual.connect }
})
vi.mock('./lifecycle-ownership.mjs', () => ({
  withTrustedDirectory: async (_path: string, callback: () => unknown) => callback(),
  withTrustedFile: async (_path: string, _options: unknown, callback: (pin: { bytes: Buffer }) => unknown) => {
    if (!seam.barrier) throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    return callback({ bytes: seam.barrier })
  },
}))
import { exchangeParticipantHandshake, startLifecycleWriterParticipant, withLifecycleWriterAdmission } from './lifecycle-admission.mjs'

const operationId = '12345678-1234-4234-8234-123456789abc'
const barrier = { schemaVersion: 1, operationId, reference: 'XP-JOB-2026-000001', kind: 'upgrade', phase: 'pending', requestFingerprint: 'a'.repeat(64), sequence: 1, createdAt: '2026-11-06T12:49:27.000Z' }
const handshake = (path: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const client = connect(path); let bytes = ''
  client.on('error', reject)
  client.on('connect', () => client.end(JSON.stringify({ nonce: 'b'.repeat(64), operationId }) + '\n'))
  client.on('data', chunk => { bytes += chunk })
  client.on('end', () => { try { resolve(JSON.parse(bytes)) } catch (error) { reject(error) } })
})
// A daemon aborted by V8 heap exhaustion or SIGKILL never runs close(), so its bound name stays on disk.
const leaveStale = (path: string) => expect(spawnSync(process.execPath, ['-e', "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))", path]).signal).toBe('SIGKILL')
const fixture = async () => { seam.dir = await mkdtemp(join(tmpdir(), 'xpanel-participant-')); return join(seam.dir, 'participant.sock') }

afterEach(async () => { seam.barrier = null; seam.foreignUid = false; if (seam.dir) await rm(seam.dir, { recursive: true, force: true }); seam.dir = '' })

describe.runIf(process.platform === 'linux')('lifecycle writer participant stop during an upgrade', () => {
  it('Node unlinks a bound Unix socket name inside server.close()', async () => {
    const path = await fixture(), server = createServer()
    await new Promise<void>(resolve => server.listen(path, resolve))
    expect(existsSync(path)).toBe(true)
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    expect(existsSync(path)).toBe(false)
  })

  it('fences on the upgrade handshake, then closes cleanly and leaves no socket name', async () => {
    const path = await fixture(), onFence = vi.fn(async () => undefined)
    const participant = await startLifecycleWriterParticipant('agent', { onFence })
    seam.barrier = Buffer.from(JSON.stringify(barrier))
    expect(await handshake(path)).toMatchObject({ operationId, role: 'agent', pid: process.pid, activeWriters: 0, fenced: true })
    expect(onFence).toHaveBeenCalledTimes(1)
    await expect(participant.close()).resolves.toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('replaces the name a killed participant left behind, then serves and closes cleanly', async () => {
    const path = await fixture()
    leaveStale(path); expect(existsSync(path)).toBe(true)
    const participant = await startLifecycleWriterParticipant('agent')
    expect(await handshake(path)).toMatchObject({ role: 'agent', pid: process.pid, activeWriters: 0, fenced: false })
    await expect(participant.close()).resolves.toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('refuses a live participant, a symlink, a regular file and a socket of another uid, and keeps each', async () => {
    const path = await fixture(), live = createServer()
    await new Promise<void>(resolve => live.listen(path, resolve))
    await expect(startLifecycleWriterParticipant('agent')).rejects.toMatchObject({ code: 'LIFECYCLE_PARTICIPANT_SOCKET_EXISTS' })
    await new Promise<void>(resolve => connect(path).once('connect', function (this: Socket) { this.destroy(); resolve() }))
    await new Promise<void>(resolve => live.close(() => resolve()))
    leaveStale(path + '.dead')
    const cases: [() => Promise<unknown>, string][] = [
      [() => symlink(path + '.dead', path), path + '.dead'],
      [() => writeFile(path, ''), path],
      [async () => { leaveStale(path); seam.foreignUid = true }, path],
    ]
    for (const [arrange, kept] of cases) {
      await rm(path, { force: true }); await arrange()
      await expect(startLifecycleWriterParticipant('agent')).rejects.toMatchObject({ code: 'LIFECYCLE_PARTICIPANT_SOCKET_EXISTS' })
      expect(existsSync(kept)).toBe(true)
    }
  })

  it('reports a replaced socket name instead of a clean close', async () => {
    const path = await fixture()
    const participant = await startLifecycleWriterParticipant('agent')
    await rm(path); await writeFile(path, '')
    await expect(participant.close()).rejects.toMatchObject({ code: 'LIFECYCLE_PARTICIPANT_SOCKET_CHANGED' })
  })

  it('answers a fenced handshake while a writer admission outlasts the old 2 s window', { tags: ['slow'] }, async () => {
    const path = await fixture()
    const participant = await startLifecycleWriterParticipant('agent', { onFence: async () => undefined })
    // A writer admitted before the barrier lands holds the drain, like one queued behind the shared lock.
    let entered!: () => void
    const inside = new Promise<void>(resolve => { entered = resolve })
    const held = withLifecycleWriterAdmission(async () => { entered(); await new Promise(resolve => setTimeout(resolve, 2500)) })
    await inside
    seam.barrier = Buffer.from(JSON.stringify(barrier))
    expect(await handshake(path)).toMatchObject({ operationId, role: 'agent', pid: process.pid, activeWriters: 0, fenced: true })
    await held
    await expect(participant.close()).resolves.toBeUndefined()
  })

  it('answers a failed fence with a refusal frame instead of dropping the socket', async () => {
    const path = await fixture()
    const participant = await startLifecycleWriterParticipant('agent', { onFence: async () => { throw new Error('metrics stop failed') } })
    seam.barrier = Buffer.from(JSON.stringify(barrier))
    expect(await handshake(path)).toEqual({ nonce: 'b'.repeat(64), refused: 'LIFECYCLE_WRITER_FENCE_FAILED' })
    await expect(exchangeParticipantHandshake(path, { nonce: 'b'.repeat(64), operationId })).rejects.toMatchObject({ code: 'LIFECYCLE_WRITER_FENCE_FAILED' })
    await expect(participant.close()).resolves.toBeUndefined()
  })

  it('asks again after a dropped or truncated reply, then names an empty reply with a stable code', async () => {
    const path = await fixture(), request = { nonce: 'b'.repeat(64), operationId }
    let connections = 0, answerFrom = 3
    const server = createServer({ allowHalfOpen: true }, socket => {
      const seen = ++connections
      socket.on('error', () => {}); socket.resume()
      socket.on('end', () => seen >= answerFrom ? socket.end(JSON.stringify({ nonce: request.nonce, fenced: true }) + '\n') : seen % 2 ? socket.destroy() : socket.end('{"nonce":'))
    })
    await new Promise<void>(resolve => server.listen(path, resolve))
    await expect(exchangeParticipantHandshake(path, request, 2000)).resolves.toEqual({ nonce: request.nonce, fenced: true })
    expect(connections).toBe(3)
    connections = 0; answerFrom = Infinity
    await expect(exchangeParticipantHandshake(path, request, 450)).rejects.toMatchObject({ code: 'LIFECYCLE_WRITER_HANDSHAKE_EMPTY' })
    expect(connections).toBeGreaterThan(1)
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})
