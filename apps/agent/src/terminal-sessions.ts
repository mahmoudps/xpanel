import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { assertJailedShellAllowed, fail, isUuid } from '@xpanel/core'
import type { Account, Plan } from '@xpanel/core'
import { system } from '@xpanel/render'
import type { AgentCallerIdentity } from './server.ts'
import { hostHelperFiles, readInstalledHelperDigest } from './installed-helper-digest.ts'
import type { HelperDigestFiles } from './installed-helper-digest.ts'

export interface TerminalLimits {
  maxSessions: number; maxInputBytes: number; idleTimeoutMs: number; absoluteTimeoutMs: number
  outputBytesPerSecond: number; outputBurstBytes: number; maxBufferedOutputBytes: number
  minCols: number; maxCols: number; minRows: number; maxRows: number; exitGraceMs: number
}
/** Host-wide hard limits. The API adds its own per-user and token policy on top; these hold even if it does not. */
export const TERMINAL_LIMITS: Readonly<TerminalLimits> = Object.freeze({
  maxSessions: 8,
  maxInputBytes: 4096,
  idleTimeoutMs: 15 * 60_000,
  absoluteTimeoutMs: 60 * 60_000,
  outputBytesPerSecond: 64 * 1024,
  outputBurstBytes: 256 * 1024,
  /** Output held while no reader is attached or the reader lags; the shell is paused beyond it. */
  maxBufferedOutputBytes: 256 * 1024,
  minCols: 20, maxCols: 500, minRows: 5, maxRows: 200,
  /** A hung-up shell that has not exited by then is force-ended. */
  exitGraceMs: 3000,
})

export const DEFAULT_TERMINAL_PTY_HELPER = '/opt/xpanel/bin/xpanel-terminal-pty'
const SYSTEMD_RUN = '/usr/bin/systemd-run'
const SYSTEMCTL = '/usr/bin/systemctl'
const SAFE_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' }
/** The account jail's own login shell (renderJailShellBinary): restricted bash, no profile files. */
const ACCOUNT_SHELL = ['/bin/bash', '--norc', '--noprofile', '--restricted'] as const
const ROOT_SHELL = ['/bin/bash', '-l'] as const

export type TerminalTarget = { kind: 'root' } | { kind: 'account'; account: Pick<Account, 'id' | 'username' | 'uid' | 'gid' | 'home'> }
export type TerminalEndReason = 'exit' | 'idle' | 'absolute' | 'closed' | 'revoked' | 'error'
export interface TerminalLaunch { id: string; target: TerminalTarget; cols: number; rows: number; absoluteTimeoutMs: number }
/** The one seam between session policy and the host: a real systemd PTY or a test fake. */
export interface PtyProcess {
  write(data: Buffer): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
  /** Hang up the terminal; the process then exits through onExit. */
  hangup(): void
  onData(listener: (chunk: Buffer) => void): void
  onExit(listener: (code: number | null) => void): void
}
export type PtySpawner = (launch: TerminalLaunch) => PtyProcess

export interface TerminalSessionInfo { id: string; startedAt: string; idleTimeoutSeconds: number; absoluteTimeoutSeconds: number }
interface Session {
  id: string; principalId: string; accountId: string | null; startedAt: Date; pty: PtyProcess
  buffered: Buffer[]; bufferedBytes: number; reader: ReadableStreamDefaultController<Uint8Array> | null; readerAttached: boolean
  tokens: number; refilledAt: number; rateHold: ReturnType<typeof setTimeout> | null; paused: boolean
  idle: ReturnType<typeof setTimeout> | null; absolute: ReturnType<typeof setTimeout>; exitGrace: ReturnType<typeof setTimeout> | null
  ending: TerminalEndReason | null; ended: boolean; exitCode: number | null
}

const dimension = (value: unknown, min: number, max: number, name: string): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail('VALIDATION', `terminal ${name} must be an integer from ${min} to ${max}`, { stateChanged: false })

/** Frames for the helper's stdin: [type][u16 length][payload]; 0 = input, 1 = resize. */
export const terminalFrame = (type: 0 | 1, payload: Buffer): Buffer => {
  const header = Buffer.alloc(3)
  header.writeUInt8(type, 0); header.writeUInt16BE(payload.length, 1)
  return Buffer.concat([header, payload])
}
export const resizeFrame = (cols: number, rows: number): Buffer => {
  const payload = Buffer.alloc(4)
  payload.writeUInt16BE(cols, 0); payload.writeUInt16BE(rows, 2)
  return terminalFrame(1, payload)
}

export class TerminalSessionManager {
  readonly #sessions = new Map<string, Session>()
  readonly #spawn: PtySpawner
  readonly #limits: TerminalLimits
  readonly #now: () => number

  constructor(spawnPty: PtySpawner, options: { limits?: Partial<TerminalLimits>; now?: () => number } = {}) {
    this.#spawn = spawnPty
    this.#limits = Object.freeze({ ...TERMINAL_LIMITS, ...options.limits })
    this.#now = options.now ?? Date.now
  }

  get size(): number { return this.#sessions.size }
  get limits(): TerminalLimits { return this.#limits }

  open(principalId: string, target: TerminalTarget, cols: unknown, rows: unknown): TerminalSessionInfo {
    const limits = this.#limits
    const width = dimension(cols, limits.minCols, limits.maxCols, 'columns'), height = dimension(rows, limits.minRows, limits.maxRows, 'rows')
    if ([...this.#sessions.values()].some(session => session.principalId === principalId)) return fail('CONFLICT', 'a terminal session is already open for this user', { stateChanged: false })
    if (this.#sessions.size >= limits.maxSessions) return fail('LIMIT_EXCEEDED', 'the host terminal session limit is reached', { stateChanged: false })
    const id = randomUUID()
    const pty = this.#spawn({ id, target, cols: width, rows: height, absoluteTimeoutMs: limits.absoluteTimeoutMs })
    const session: Session = {
      id, principalId, accountId: target.kind === 'account' ? target.account.id : null, startedAt: new Date(this.#now()), pty, buffered: [], bufferedBytes: 0, reader: null, readerAttached: false,
      tokens: limits.outputBurstBytes, refilledAt: this.#now(), rateHold: null, paused: false,
      idle: null, absolute: setTimeout(() => this.#end(session, 'absolute'), limits.absoluteTimeoutMs), exitGrace: null,
      ending: null, ended: false, exitCode: null,
    }
    session.absolute.unref?.()
    this.#sessions.set(id, session)
    this.#touch(session)
    pty.onData(chunk => this.#output(session, chunk))
    pty.onExit(code => { session.exitCode = code; this.#finish(session) })
    return { id, startedAt: session.startedAt.toISOString(), idleTimeoutSeconds: limits.idleTimeoutMs / 1000, absoluteTimeoutSeconds: limits.absoluteTimeoutMs / 1000 }
  }

  /** The single NDJSON output stream: `{"o":"<base64>"}` lines, then one `{"end":{...}}` line. */
  attach(id: string, principalId: string): ReadableStream<Uint8Array> {
    const session = this.#owned(id, principalId)
    if (session.readerAttached) return fail('CONFLICT', 'the terminal output is already attached', { stateChanged: false })
    session.readerAttached = true
    return new ReadableStream<Uint8Array>({
      start: controller => {
        session.reader = controller
        for (const chunk of session.buffered.splice(0)) this.#emit(session, chunk)
        session.bufferedBytes = 0
        this.#flow(session)
      },
      pull: () => this.#flow(session),
      cancel: () => { session.reader = null; this.#end(session, 'closed') },
    }, { highWaterMark: this.#limits.maxBufferedOutputBytes, size: chunk => chunk.byteLength })
  }

  input(id: string, principalId: string, data: unknown): void {
    const session = this.#owned(id, principalId)
    if (typeof data !== 'string' || data.length === 0) return fail('VALIDATION', 'terminal input must be a non-empty string', { stateChanged: false })
    const bytes = Buffer.from(data, 'utf8')
    if (bytes.length > this.#limits.maxInputBytes) return fail('LIMIT_EXCEEDED', `terminal input is limited to ${this.#limits.maxInputBytes} bytes per message`, { stateChanged: false })
    session.pty.write(terminalFrame(0, bytes))
    this.#touch(session)
  }

  resize(id: string, principalId: string, cols: unknown, rows: unknown): void {
    const session = this.#owned(id, principalId), limits = this.#limits
    session.pty.resize(dimension(cols, limits.minCols, limits.maxCols, 'columns'), dimension(rows, limits.minRows, limits.maxRows, 'rows'))
  }

  close(id: string, principalId: string): void { this.#end(this.#owned(id, principalId), 'closed') }

  closeAll(): void { for (const session of this.#sessions.values()) this.#end(session, 'closed') }

  /** Live sessions with their owner, for revocation sweeps. */
  live(): Array<{ id: string; principalId: string; accountId: string | null }> {
    return [...this.#sessions.values()].filter(session => !session.ending).map(({ id, principalId, accountId }) => ({ id, principalId, accountId }))
  }

  revoke(id: string): void { const session = this.#sessions.get(id); if (session) this.#end(session, 'revoked') }

  #owned(id: string, principalId: string): Session {
    const session = isUuid(id) ? this.#sessions.get(id) : undefined
    // Another user's session is indistinguishable from a missing one.
    if (!session || session.principalId !== principalId || session.ending) return fail('NOT_FOUND', 'terminal session not found', { stateChanged: false })
    return session
  }

  #touch(session: Session): void {
    if (session.idle) clearTimeout(session.idle)
    session.idle = setTimeout(() => this.#end(session, 'idle'), this.#limits.idleTimeoutMs)
    session.idle.unref?.()
  }

  #output(session: Session, chunk: Buffer): void {
    if (session.ended) return
    const limits = this.#limits, now = this.#now()
    session.tokens = Math.min(limits.outputBurstBytes, session.tokens + (now - session.refilledAt) * limits.outputBytesPerSecond / 1000)
    session.refilledAt = now
    session.tokens -= chunk.length
    if (session.reader) this.#emit(session, chunk)
    else { session.buffered.push(chunk); session.bufferedBytes += chunk.length }
    if (session.tokens < 0 && !session.rateHold) {
      // Over the output rate: stop reading the terminal until the bucket refills; the shell blocks on its own writes.
      session.rateHold = setTimeout(() => { session.rateHold = null; this.#flow(session) }, Math.ceil(-session.tokens * 1000 / limits.outputBytesPerSecond))
      session.rateHold.unref?.()
    }
    this.#flow(session)
  }

  #emit(session: Session, chunk: Buffer): void {
    session.reader?.enqueue(Buffer.from(JSON.stringify({ o: chunk.toString('base64') }) + '\n'))
  }

  /** Pause the terminal while rate-limited, unread, or the reader lags; resume as soon as none holds. */
  #flow(session: Session): void {
    if (session.ended) return
    const lagging = session.reader ? (session.reader.desiredSize ?? 0) <= 0 : session.bufferedBytes >= this.#limits.maxBufferedOutputBytes
    const hold = Boolean(session.rateHold) || lagging
    if (hold && !session.paused) { session.paused = true; session.pty.pause() }
    else if (!hold && session.paused) { session.paused = false; session.pty.resume() }
  }

  #end(session: Session, reason: TerminalEndReason): void {
    if (session.ending || session.ended) return
    session.ending = reason
    if (session.paused) { session.paused = false; session.pty.resume() }
    try { session.pty.hangup() } catch { session.ending = 'error' }
    session.exitGrace = setTimeout(() => this.#finish(session), this.#limits.exitGraceMs)
    session.exitGrace.unref?.()
  }

  #finish(session: Session): void {
    if (session.ended) return
    session.ended = true
    for (const timer of [session.idle, session.absolute, session.exitGrace, session.rateHold]) if (timer) clearTimeout(timer)
    this.#sessions.delete(session.id)
    const end = { reason: session.ending ?? 'exit', code: session.exitCode }
    if (session.reader) {
      try { session.reader.enqueue(Buffer.from(JSON.stringify({ end }) + '\n')); session.reader.close() } catch { /* the reader already went away */ }
      session.reader = null
    }
  }
}

export interface TerminalAuthorityLookups {
  getPrincipal(id: string): Promise<{ disabled: boolean } | null>
  getAccount(id: string): Promise<Pick<Account, 'status'> | null>
}
/**
 * Ends every live terminal whose owner lost authority: a disabled or deleted principal, or an account that is no
 * longer active. Runs on every reconciler event (suspend, terminate and purge all reconcile), so a suspended or
 * deleted account's shells end as soon as the change is applied on the host.
 */
export async function revokeUnauthorizedTerminals(terminals: TerminalSessionManager, lookups: TerminalAuthorityLookups): Promise<number> {
  let ended = 0
  for (const live of terminals.live()) {
    const principal = await lookups.getPrincipal(live.principalId)
    const account = live.accountId === null ? null : await lookups.getAccount(live.accountId)
    if (!principal || principal.disabled || (live.accountId !== null && account?.status !== 'active')) { terminals.revoke(live.id); ended++ }
  }
  return ended
}

/**
 * Accept the helper only as the installer left it: a root-owned executable and a root-owned `<helper>.sha256`
 * digest file, neither writable by group or others, and the binary still matching that digest. Anything else
 * keeps terminals unavailable.
 */
export async function verifyTerminalPtyHelper(path = DEFAULT_TERMINAL_PTY_HELPER, files: HelperDigestFiles = hostHelperFiles): Promise<boolean> {
  const binary = await files.lstat(path), expected = await readInstalledHelperDigest(path, files)
  if (!binary || !binary.isFile() || binary.isSymbolicLink() || binary.uid !== 0 || (binary.mode & 0o6022) !== 0 || (binary.mode & 0o111) === 0 || !expected) return false
  try { return createHash('sha256').update(await files.read(path)).digest('hex') === expected } catch { return false }
}

const limitProperties = (launch: TerminalLaunch): string[] => [
  `RuntimeMaxSec=${Math.ceil(launch.absoluteTimeoutMs / 1000) + 30}s`, 'KillMode=control-group', 'TimeoutStopSec=2s', 'SendSIGKILL=yes',
].flatMap(property => ['--property', property])

/** systemd-run argv. An account shell gets the account jail (its UID, slice, private /tmp, only its own home); never root. */
export function buildTerminalSystemdArgv(launch: TerminalLaunch, helperPath = DEFAULT_TERMINAL_PTY_HELPER): string[] {
  if (!isUuid(launch.id)) return fail('VALIDATION', 'terminal session id is invalid')
  const unit = `--unit=xpanel-terminal-${launch.id}`
  const tail = ['--setenv=TERM=xterm-256color', '--', helperPath, String(launch.cols), String(launch.rows)]
  if (launch.target.kind === 'account') {
    // The jail prefix comes from the shared account sandbox; the probe command only marks where it ends.
    const skeleton = system.buildJailedFileOpArgv(launch.target.account, ['/usr/bin/id'])
    const prefix = skeleton.slice(0, skeleton.lastIndexOf('--'))
    if (prefix[0] !== SYSTEMD_RUN || !prefix.includes(`User=${launch.target.account.username}`) || !prefix.includes(`Slice=xpanel-${launch.target.account.uid}.slice`)) return fail('PRECONDITION_FAILED', 'the account terminal jail could not be built')
    return [...prefix, unit, ...limitProperties(launch), '--property', 'TasksMax=64', ...tail, ...ACCOUNT_SHELL]
  }
  return [SYSTEMD_RUN, '--pipe', '--wait', '--collect', '--quiet', unit, '--working-directory=/root', ...limitProperties(launch),
    '--setenv=HOME=/root', '--setenv=USER=root', '--setenv=LOGNAME=root', '--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...tail, ...ROOT_SHELL]
}

/** The production PTY: systemd-run starts the native helper as a transient unit and pipes its frames. */
export const createSystemdPtySpawner = (helperPath = DEFAULT_TERMINAL_PTY_HELPER): PtySpawner => launch => {
  const argv = buildTerminalSystemdArgv(launch, helperPath)
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: SAFE_ENV, shell: false, windowsHide: true })
  let exited = false
  child.stdin.on('error', () => undefined)
  child.stderr.resume()
  child.on('exit', () => { exited = true })
  return {
    write: data => { if (!exited) child.stdin.write(data) },
    resize: (cols, rows) => { if (!exited) child.stdin.write(resizeFrame(cols, rows)) },
    pause: () => child.stdout.pause(),
    resume: () => child.stdout.resume(),
    hangup: () => {
      child.stdin.end()
      // The helper hangs up on stdin EOF; the unit stop is the backstop for a wedged client.
      setTimeout(() => {
        if (exited) return
        spawn(SYSTEMCTL, ['stop', '--no-block', '--no-ask-password', `xpanel-terminal-${launch.id}.service`], { stdio: 'ignore', env: SAFE_ENV, shell: false }).on('error', () => undefined)
        child.kill('SIGKILL')
      }, 2000).unref()
    },
    onData: listener => { child.stdout.on('data', listener) },
    onExit: listener => {
      child.once('close', code => listener(code))
      child.once('error', () => listener(null))
    },
  }
}

export interface TerminalRouteDeps {
  caller: AgentCallerIdentity
  /** Absent until the PTY helper is verified on this host: every request reports unavailable. */
  terminals: TerminalSessionManager | null
  store: { getAccount(id: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null> }
  assertRootCaller(caller: AgentCallerIdentity, target: string): Promise<void>
}

const SESSION_ROUTE = /^\/terminal\/sessions\/([0-9a-f-]{36})(?:\/(output|input|resize))?$/
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const objectBody = async (req: Request): Promise<Record<string, unknown>> => {
  let value: unknown
  try { value = await req.json() } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('VALIDATION', 'request body must be a JSON object', { stateChanged: false })
}
const exactKeys = (body: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(body).some(key => !keys.includes(key))) fail('VALIDATION', 'terminal request has unsupported fields', { stateChanged: false })
}

/** Terminal sessions on the agent's authenticated socket. The account comes from the caller's identity, never from the request. */
export async function handleTerminalRoute(req: Request, url: URL, method: string, deps: TerminalRouteDeps): Promise<Response | null> {
  const capability = url.pathname === '/terminal', open = url.pathname === '/terminal/sessions'
  const match = capability || open ? null : SESSION_ROUTE.exec(url.pathname)
  if (!capability && !open && !match) return null
  if (url.search) return fail('VALIDATION', 'terminal requests accept no query selectors', { stateChanged: false })
  if (capability) {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    return json(deps.terminals
      ? { execution: { state: 'available', idleTimeoutSeconds: deps.terminals.limits.idleTimeoutMs / 1000, absoluteTimeoutSeconds: deps.terminals.limits.absoluteTimeoutMs / 1000, maxInputBytes: deps.terminals.limits.maxInputBytes } }
      : { execution: { state: 'unavailable', reason: 'terminal_helper_not_installed' } })
  }
  const terminals = deps.terminals ?? fail('PRECONDITION_FAILED', 'terminal sessions are unavailable on this host', { stateChanged: false })
  const caller = deps.caller
  if (open) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const body = await objectBody(req)
    exactKeys(body, ['kind', 'cols', 'rows'])
    let target: TerminalTarget
    if (body.kind === 'root') {
      await deps.assertRootCaller(caller, 'server:terminal')
      target = { kind: 'root' }
    } else if (body.kind === 'account') {
      if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'an account terminal is opened by the signed-in account owner', { stateChanged: false })
      const account = await deps.store.getAccount(caller.accountId) ?? fail('FORBIDDEN', 'account is not available', { stateChanged: false })
      const plan = await deps.store.getPlan(account.planId) ?? fail('FORBIDDEN', 'account plan is not available', { stateChanged: false })
      assertJailedShellAllowed(account, plan)
      target = { kind: 'account', account }
    } else return fail('VALIDATION', 'terminal kind must be account or root', { stateChanged: false })
    return json({ session: terminals.open(caller.principalId, target, body.cols, body.rows) }, 201)
  }
  const id = match![1]!, action = match![2]
  if (action === 'output') {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    return new Response(terminals.attach(id, caller.principalId), { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
  }
  if (action === undefined) {
    if (method !== 'DELETE') return new Response(null, { status: 405, headers: { allow: 'DELETE' } })
    terminals.close(id, caller.principalId)
    return new Response(null, { status: 204 })
  }
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const body = await objectBody(req)
  if (action === 'input') { exactKeys(body, ['data']); terminals.input(id, caller.principalId, body.data) }
  else { exactKeys(body, ['cols', 'rows']); terminals.resize(id, caller.principalId, body.cols, body.rows) }
  return new Response(null, { status: 204 })
}
