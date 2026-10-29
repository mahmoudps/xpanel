import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account, Plan } from '@xpanel/core'
import { createHash } from 'node:crypto'
import { TerminalSessionManager, buildTerminalSystemdArgv, handleTerminalRoute, resizeFrame, revokeUnauthorizedTerminals, terminalFrame, verifyTerminalPtyHelper } from './terminal-sessions.ts'
import type { PtyProcess, TerminalLaunch, TerminalLimits, TerminalRouteDeps } from './terminal-sessions.ts'
import type { AgentCallerIdentity } from './server.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const account = { id: ACCOUNT, username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', status: 'active', shell: 'jailed', planId: 'plan' } as Account
const plan = { id: 'plan', name: 'Starter', shell: 'jailed' } as Plan
const owner: AgentCallerIdentity = { principalId: 'p-alice', actor: 'alice', role: 'user', accountId: ACCOUNT, resellerId: null }
const root: AgentCallerIdentity = { principalId: 'p-root', actor: 'root', role: 'root', accountId: null, resellerId: null }

class FakePty implements PtyProcess {
  writes: Buffer[] = []; sizes: Array<[number, number]> = []; paused = false; hungUp = false
  #data: Array<(chunk: Buffer) => void> = []; #exit: Array<(code: number | null) => void> = []
  readonly launch: TerminalLaunch
  constructor(launch: TerminalLaunch) { this.launch = launch }
  write(data: Buffer) { this.writes.push(data) }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]) }
  pause() { this.paused = true }
  resume() { this.paused = false }
  hangup() { this.hungUp = true }
  onData(listener: (chunk: Buffer) => void) { this.#data.push(listener) }
  onExit(listener: (code: number | null) => void) { this.#exit.push(listener) }
  emit(text: string | Buffer) { for (const listener of this.#data) listener(Buffer.isBuffer(text) ? text : Buffer.from(text)) }
  exit(code: number | null) { for (const listener of this.#exit) listener(code) }
}

const setup = (limits: Partial<TerminalLimits> = {}) => {
  const ptys: FakePty[] = []
  let clock = 0
  const manager = new TerminalSessionManager(launch => { const pty = new FakePty(launch); ptys.push(pty); return pty }, { limits, now: () => clock })
  return { manager, ptys, tick: (ms: number) => { clock += ms; vi.advanceTimersByTime(ms) } }
}
const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, any>>> => {
  const text = Buffer.from(await new Response(stream).arrayBuffer()).toString('utf8')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}
// Chunks may split a UTF-8 sequence; bytes are joined before decoding, as the API bridge does.
const output = (lines: Array<Record<string, any>>): string => Buffer.concat(lines.filter(line => line.o).map(line => Buffer.from(line.o, 'base64'))).toString('utf8')

afterEach(() => { vi.useRealTimers() })

describe('terminal session manager (fake PTY)', () => {
  it('frames input and resize for the helper, and streams UTF-8 output in order', async () => {
    const { manager, ptys } = setup()
    const session = manager.open('p-alice', { kind: 'account', account }, 100, 30)
    expect(session).toMatchObject({ idleTimeoutSeconds: 900, absoluteTimeoutSeconds: 3600 })
    const pty = ptys[0]!
    expect(pty.launch).toMatchObject({ cols: 100, rows: 30, target: { kind: 'account' } })
    manager.input(session.id, 'p-alice', 'ls é\r')
    expect(pty.writes[0]).toEqual(terminalFrame(0, Buffer.from('ls é\r')))
    manager.resize(session.id, 'p-alice', 120, 40)
    expect(pty.sizes).toEqual([[120, 40]])
    expect(resizeFrame(120, 40)).toEqual(Buffer.from([1, 0, 4, 0, 120, 0, 40]))
    pty.emit('before attach ')
    const stream = manager.attach(session.id, 'p-alice')
    pty.emit(Buffer.from('héllo', 'utf8').subarray(0, 2)); pty.emit(Buffer.from('héllo', 'utf8').subarray(2))
    pty.exit(0)
    const lines = await readAll(stream)
    expect(output(lines)).toBe('before attach héllo')
    expect(lines.at(-1)).toEqual({ end: { reason: 'exit', code: 0 } })
    expect(manager.size).toBe(0)
  })

  it('allows one live session per user and a host-wide maximum', () => {
    const { manager } = setup({ maxSessions: 2 })
    manager.open('p-alice', { kind: 'account', account }, 80, 24)
    expect(() => manager.open('p-alice', { kind: 'account', account }, 80, 24)).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    manager.open('p-root', { kind: 'root' }, 80, 24)
    expect(() => manager.open('p-other', { kind: 'root' }, 80, 24)).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }))
  })

  it('hides another user session and validates sizes and input limits', () => {
    const { manager } = setup()
    const { id } = manager.open('p-alice', { kind: 'account', account }, 80, 24)
    for (const action of [() => manager.input(id, 'p-bob', 'x'), () => manager.attach(id, 'p-bob'), () => manager.close(id, 'p-bob'), () => manager.input('not-a-uuid', 'p-alice', 'x')])
      expect(action).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => manager.input(id, 'p-alice', 'x'.repeat(4097))).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }))
    expect(() => manager.input(id, 'p-alice', '')).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => manager.resize(id, 'p-alice', 19, 24)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => manager.open('p-bob', { kind: 'root' }, 80.5, 24)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => manager.attach(id, 'p-alice')).not.toThrow()
    expect(() => manager.attach(id, 'p-alice')).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
  })

  it('ends an idle session, and input resets the idle timer', async () => {
    vi.useFakeTimers()
    const { manager, ptys, tick } = setup({ idleTimeoutMs: 1000, absoluteTimeoutMs: 60_000 })
    const { id } = manager.open('p-alice', { kind: 'account', account }, 80, 24)
    const stream = manager.attach(id, 'p-alice')
    tick(900); manager.input(id, 'p-alice', 'a'); tick(900)
    expect(ptys[0]!.hungUp).toBe(false)
    tick(200)
    expect(ptys[0]!.hungUp).toBe(true)
    expect(() => manager.input(id, 'p-alice', 'b')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    ptys[0]!.exit(129)
    expect((await readAll(stream)).at(-1)).toEqual({ end: { reason: 'idle', code: 129 } })
  })

  it('ends at the absolute timeout even with activity, and force-ends a shell that ignores the hangup', async () => {
    vi.useFakeTimers()
    const { manager, ptys, tick } = setup({ idleTimeoutMs: 1000, absoluteTimeoutMs: 2500, exitGraceMs: 500 })
    const { id } = manager.open('p-root', { kind: 'root' }, 80, 24)
    const stream = manager.attach(id, 'p-root')
    for (let i = 0; i < 5; i++) { tick(500); if (i < 4) manager.input(id, 'p-root', 'x') }
    expect(ptys[0]!.hungUp).toBe(true)
    tick(500)
    expect(manager.size).toBe(0)
    expect((await readAll(stream)).at(-1)).toEqual({ end: { reason: 'absolute', code: null } })
  })

  it('pauses the terminal above the output rate and resumes after the bucket refills', () => {
    vi.useFakeTimers()
    const { manager, ptys, tick } = setup({ outputBytesPerSecond: 1000, outputBurstBytes: 1000, maxBufferedOutputBytes: 1_000_000 })
    const { id } = manager.open('p-alice', { kind: 'account', account }, 80, 24)
    manager.attach(id, 'p-alice')
    const pty = ptys[0]!
    pty.emit('x'.repeat(900))
    expect(pty.paused).toBe(false)
    pty.emit('x'.repeat(600))
    expect(pty.paused).toBe(true)
    tick(499)
    expect(pty.paused).toBe(true)
    tick(2)
    expect(pty.paused).toBe(false)
  })

  it('pauses while nobody reads and the buffer is full; a closed reader ends the session', async () => {
    const { manager, ptys } = setup({ maxBufferedOutputBytes: 10, outputBurstBytes: 1_000_000 })
    const { id } = manager.open('p-alice', { kind: 'account', account }, 80, 24)
    ptys[0]!.emit('0123456789AB')
    expect(ptys[0]!.paused).toBe(true)
    const stream = manager.attach(id, 'p-alice')
    await stream.cancel()
    expect(ptys[0]!.hungUp).toBe(true)
  })
})

describe('terminal revocation sweep', () => {
  it('ends shells of a suspended or deleted account and of a disabled principal, and keeps the rest', async () => {
    const { manager, ptys } = setup()
    const bob = { ...account, id: '22222222-2222-4222-8222-222222222222', username: 'bob' } as Account
    manager.open('p-alice', { kind: 'account', account }, 80, 24)
    manager.open('p-bob', { kind: 'account', account: bob }, 80, 24)
    manager.open('p-root', { kind: 'root' }, 80, 24)
    manager.open('p-gone', { kind: 'root' }, 80, 24)
    const accounts = new Map([[ACCOUNT, { status: 'suspended' }], [bob.id, { status: 'active' }]])
    const principals = new Map([['p-alice', { disabled: false }], ['p-bob', { disabled: false }], ['p-root', { disabled: false }]])
    const ended = await revokeUnauthorizedTerminals(manager, { getPrincipal: async id => principals.get(id) ?? null, getAccount: async id => (accounts.get(id) as Account | undefined) ?? null })
    expect(ended).toBe(2)
    expect(ptys.map(pty => pty.hungUp)).toEqual([true, false, false, true])
    expect(manager.live().map(live => live.principalId).sort()).toEqual(['p-bob', 'p-root'])
    principals.set('p-bob', { disabled: true })
    expect(await revokeUnauthorizedTerminals(manager, { getPrincipal: async id => principals.get(id) ?? null, getAccount: async id => (accounts.get(id) as Account | undefined) ?? null })).toBe(1)
  })
})

describe('terminal helper verification', () => {
  const binary = Buffer.from('\x7fELF helper'), digest = createHash('sha256').update(binary).digest('hex')
  const files = (overrides: { mode?: number; uid?: number; digestMode?: number; digest?: string; missingDigest?: boolean; symlink?: boolean } = {}) => ({
    lstat: async (path: string) => path.endsWith('.sha256')
      ? overrides.missingDigest ? null : { isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: overrides.digestMode ?? 0o100644, size: 65 }
      : { isFile: () => true, isSymbolicLink: () => overrides.symlink ?? false, uid: overrides.uid ?? 0, mode: overrides.mode ?? 0o100755, size: binary.length },
    read: async (path: string) => path.endsWith('.sha256') ? Buffer.from((overrides.digest ?? digest) + '\n') : binary,
  })
  it('accepts only a root-owned helper that still matches its recorded digest', async () => {
    expect(await verifyTerminalPtyHelper('/opt/xpanel/bin/xpanel-terminal-pty', files())).toBe(true)
    for (const bad of [{ missingDigest: true }, { digest: 'f'.repeat(64) }, { digest: 'not-a-digest' }, { mode: 0o100775 }, { mode: 0o104755 }, { mode: 0o100644 }, { uid: 1000 }, { symlink: true }, { digestMode: 0o100666 }])
      expect(await verifyTerminalPtyHelper('/opt/xpanel/bin/xpanel-terminal-pty', files(bad)), JSON.stringify(bad)).toBe(false)
  })
})

describe('terminal systemd launch', () => {
  const launch = (target: TerminalLaunch['target']): TerminalLaunch => ({ id: '22222222-2222-4222-8222-222222222222', target, cols: 80, rows: 24, absoluteTimeoutMs: 3_600_000 })
  it('runs the account shell as the account user inside its slice and jail, never as root', () => {
    const argv = buildTerminalSystemdArgv(launch({ kind: 'account', account }), '/opt/xpanel/bin/xpanel-terminal-pty')
    const properties = argv.flatMap((value, index) => argv[index - 1] === '--property' ? [value] : [])
    expect(argv[0]).toBe('/usr/bin/systemd-run')
    expect(properties).toEqual(expect.arrayContaining(['User=alice', 'Group=alice', 'Slice=xpanel-20014.slice', 'ProtectHome=tmpfs', 'BindPaths=/home/alice', 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'RuntimeMaxSec=3630s', 'KillMode=control-group']))
    expect(properties.some(value => /^User=(root|0)$/.test(value))).toBe(false)
    expect(argv).toContain('--working-directory=/home/alice')
    expect(argv.slice(argv.lastIndexOf('--'))).toEqual(['--', '/opt/xpanel/bin/xpanel-terminal-pty', '80', '24', '/bin/bash', '--norc', '--noprofile', '--restricted'])
  })
  it('runs the root shell in its own transient unit with an absolute runtime bound', () => {
    const argv = buildTerminalSystemdArgv(launch({ kind: 'root' }))
    expect(argv).toEqual(expect.arrayContaining(['--unit=xpanel-terminal-22222222-2222-4222-8222-222222222222', '--working-directory=/root', 'RuntimeMaxSec=3630s']))
    expect(argv.slice(argv.lastIndexOf('--'))).toEqual(['--', '/opt/xpanel/bin/xpanel-terminal-pty', '80', '24', '/bin/bash', '-l'])
    expect(() => buildTerminalSystemdArgv({ ...launch({ kind: 'root' }), id: 'x; rm -rf /' })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })
})

describe('terminal agent route', () => {
  const deps = (caller: AgentCallerIdentity, overrides: Partial<TerminalRouteDeps> = {}) => {
    const { manager } = setup()
    const value: TerminalRouteDeps = {
      caller, terminals: manager,
      store: { getAccount: async id => id === ACCOUNT ? account : null, getPlan: async () => plan },
      assertRootCaller: async who => { if (who.role !== 'root') throw Object.assign(new Error('root required'), { code: 'FORBIDDEN' }) },
      ...overrides,
    }
    return value
  }
  const post = (path: string, body: unknown, d: TerminalRouteDeps) => {
    const url = new URL('http://agent.local' + path)
    return handleTerminalRoute(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), url, 'POST', d)
  }
  it('opens the owner account terminal from the caller identity and refuses an owner opening root', async () => {
    const response = await post('/terminal/sessions', { kind: 'account', cols: 80, rows: 24 }, deps(owner))
    expect(response!.status).toBe(201)
    await expect(post('/terminal/sessions', { kind: 'root', cols: 80, rows: 24 }, deps(owner))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(post('/terminal/sessions', { kind: 'account', cols: 80, rows: 24 }, deps(root))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(post('/terminal/sessions', { kind: 'account', cols: 80, rows: 24, username: 'bob' }, deps(owner))).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('refuses a plan or account without the jailed shell, and an unqualified host', async () => {
    await expect(post('/terminal/sessions', { kind: 'account', cols: 80, rows: 24 }, deps(owner, { store: { getAccount: async () => account, getPlan: async () => ({ ...plan, shell: 'none' }) as Plan } }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(post('/terminal/sessions', { kind: 'account', cols: 80, rows: 24 }, deps(owner, { store: { getAccount: async () => ({ ...account, status: 'suspended' }) as Account, getPlan: async () => plan } }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(post('/terminal/sessions', { kind: 'root', cols: 80, rows: 24 }, deps(root, { terminals: null }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
