import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, statfs, unlink } from 'node:fs/promises'
import { posix } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isXpanelError, XpanelError } from '@xpanel/core'
import type { HelperProcessSpawnInput, HelperProcessSpawnResult } from './account-file-runner.ts'

const SYSTEMD_RUN = '/usr/bin/systemd-run'
const SYSTEMCTL = '/usr/bin/systemctl'
const CGROUP_ROOT = '/sys/fs/cgroup'
const CGROUP2_MAGIC = 0x63677270
const CONTROL_TIMEOUT_MS = 2000
const REAP_TIMEOUT_MS = 2000
const CLEANUP_ATTEMPTS = 6
const CLEANUP_RETRY_MS = 100
const MAX_CONTROL_OUTPUT = 16 * 1024
const MAX_REQUEST = 4 * 1024 * 1024
export const MAX_ACTIVE_FILE_WORKERS = 4
const SAFE_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' }

type FailureReason = 'timeout' | 'stdout-limit' | 'stderr-limit' | 'spawn-error' | 'observer-error' | 'closed' | 'wrapper-signal' | 'wrapper-failure' | 'cleanup-unknown'
type WorkerInput = HelperProcessSpawnInput & { uid: number; workerUnit: string; cgroupPath: string }
type WorkerPreparation = WorkerInput | ((signal: AbortSignal) => Promise<WorkerInput>)
interface Capture extends HelperProcessSpawnResult { reaped: boolean; spawned: boolean; failure?: FailureReason; observer?: Promise<void> }
interface ProcessHandle { result: Promise<Capture>; kill: () => void }
interface ActiveJob { prepare: WorkerPreparation; controller: AbortController; canceled: boolean; process?: ProcessHandle; cancelObserver?: () => void; completion?: Promise<HelperProcessSpawnResult> }
interface UnitStatus { load: string; active: string; cgroup: string; pending: boolean }

const refused = (message: string) => new XpanelError('PRECONDITION_FAILED', message)
const unavailable = (message: string) => new XpanelError('SERVICE_UNAVAILABLE', message)
const hasCode = (error: unknown, code: string): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === code
const canonicalPath = (value: string): boolean => typeof value === 'string' && value.startsWith('/') && posix.normalize(value) === value && !/[\u0000-\u0020\u007f%]/.test(value)

/** Check every ancestor without following symlinks. Only root may change this tree. */
const secureDirectory = async (path: string, create = false, privateLeaf = false): Promise<void> => {
  if (!canonicalPath(path) || path === '/') throw refused('file worker runtime directory must be a canonical absolute path')
  const paths = ['/']
  let current = ''
  for (const part of path.slice(1).split('/')) { current += '/' + part; paths.push(current) }
  for (const entry of paths) {
    let st
    try { st = await lstat(entry) } catch (error) {
      if (!create || !hasCode(error, 'ENOENT')) throw error
      let created = false
      try { await mkdir(entry, { mode: 0o700 }); created = true } catch (mkdirError) { if (!hasCode(mkdirError, 'EEXIST')) throw mkdirError }
      if (created) {
        const directory = await open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try {
          const createdStat = await directory.stat()
          if (!createdStat.isDirectory() || createdStat.uid !== 0) throw refused('new file worker runtime directory is not root-owned')
          // The daemon intentionally uses a nonzero primary group. Fix only the
          // directory created by this mkdir, through its no-follow handle.
          // Existing directories, including EEXIST races, are never repaired.
          await directory.chown(0, 0)
          await directory.chmod(0o700)
          await directory.sync()
        } finally { await directory.close() }
      }
      st = await lstat(entry)
      if (created) {
        const parent = await open(posix.dirname(entry), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await parent.sync() } finally { await parent.close() }
      }
    }
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || st.gid !== 0 || (st.mode & 0o022) !== 0) throw refused('file worker directory must be root-owned without group or world write access')
    if (privateLeaf && entry === path && (st.mode & 0o777) !== 0o700) throw refused('file worker incident directory must have mode 0700')
  }
}

const secureFile = async (path: string, limit = MAX_CONTROL_OUTPUT): Promise<string> => {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.gid !== 0 || (before.mode & 0o022) !== 0) throw refused('file worker policy or cgroup file is not trusted')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = await handle.stat()
    if (!st.isFile() || st.uid !== 0 || st.gid !== 0 || (st.mode & 0o022) !== 0 || st.size > limit) throw refused('file worker trusted file metadata is invalid')
    const bytes = await handle.readFile()
    if (bytes.length > limit) throw refused('file worker trusted file exceeds its size limit')
    return bytes.toString('utf8')
  } finally { await handle.close() }
}

const fields = (text: string, names: readonly string[]): Map<string, string> => {
  const result = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!line) continue
    const equal = line.indexOf('=')
    const key = line.slice(0, equal)
    const value = line.slice(equal + 1)
    if (equal < 1 || !names.includes(key) || result.has(key) || /[\r\u0000]/.test(line)) throw refused('file worker systemd response is ambiguous')
    result.set(key, value)
  }
  if (result.size !== names.length) throw refused('file worker systemd response is incomplete')
  return result
}

/** Capture a verified absolute executable without a shell or PATH lookup. */
const captureProcess = (executable: string, args: string[], input: Pick<HelperProcessSpawnInput, 'stdinPayload' | 'timeoutMs' | 'maxStdoutBytes' | 'maxStderrBytes' | 'onStdoutLine'>): ProcessHandle => {
  let child: ChildProcessWithoutNullStreams | undefined
  let failure: FailureReason | undefined
  let killed = false
  let settle: ((capture: Capture) => void) | undefined
  const result = new Promise<Capture>((resolve) => { settle = resolve })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let observer: Promise<void> | undefined
  let lineDelivered = false
  let reaped = false
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let reapTimer: ReturnType<typeof setTimeout> | undefined
  const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    if (finished) return
    finished = true
    clearTimeout(timer); clearTimeout(reapTimer)
    settle?.({ exitCode, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), pid: child?.pid ?? 0, reaped, spawned: Boolean(child?.pid), ...(failure ? { failure } : {}), ...(observer ? { observer } : {}) })
  }
  const kill = () => {
    if (killed || reaped || finished) return
    killed = true
    child?.kill('SIGKILL')
    reapTimer = setTimeout(() => finish(null, 'SIGKILL'), REAP_TIMEOUT_MS)
  }
  try {
    child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env: SAFE_ENV, shell: false, windowsHide: true })
    timer = setTimeout(() => { failure ??= 'timeout'; kill() }, input.timeoutMs)
    child.on('error', () => { failure ??= 'spawn-error'; kill() })
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > input.maxStdoutBytes) { failure ??= 'stdout-limit'; kill(); return }
      stdout.push(Buffer.from(chunk))
      if (input.onStdoutLine && !lineDelivered && (child?.pid ?? 0) > 0) {
        const text = Buffer.concat(stdout).toString('utf8')
        const newline = text.indexOf('\n')
        if (newline >= 0) {
          lineDelivered = true
          observer = Promise.resolve().then(() => input.onStdoutLine?.(text.slice(0, newline), child?.pid ?? 0)).then(() => undefined)
          observer.catch(() => { failure ??= 'observer-error'; kill() })
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > input.maxStderrBytes) { failure ??= 'stderr-limit'; kill(); return }
      stderr.push(Buffer.from(chunk))
    })
    child.stdin.on('error', () => { /* A rejecting helper may close stdin before consuming a request. */ })
    child.on('close', (exitCode, signal) => { reaped = true; finish(exitCode, signal) })
    child.stdin.end(input.stdinPayload, 'utf8')
  } catch {
    failure = 'spawn-error'
    if (child) kill()
    else { reaped = true; finish(null, null) }
  }
  return { result, kill }
}

/**
 * One transient service per operation. Loaded account policy must already exist;
 * this supervisor never creates or changes an account slice. Durable operational
 * receipts belong outside the canonical state tree and survive agent crashes.
 */
export class SystemdAccountFileWorkerPool {
  private readonly incidentDir: string
  private readonly verifyExecutable: (absolutePath: string) => Promise<string>
  private readonly onRecoveryRequired: (() => void | Promise<void>) | undefined
  private ready: Promise<void> | undefined
  private executableHashes: string[] = []
  private closed = false
  private admissionBlocked = false
  private recoveryNotified = false
  private readonly jobs = new Set<ActiveJob>()

  constructor(options: { incidentDir: string; verifyExecutable: (absolutePath: string) => Promise<string>; onRecoveryRequired?: () => void | Promise<void> }) {
    if (!options || !canonicalPath(options.incidentDir) || options.incidentDir === '/' || typeof options.verifyExecutable !== 'function' || (options.onRecoveryRequired !== undefined && typeof options.onRecoveryRequired !== 'function')) throw refused('a private trusted incident directory and executable verifier are required')
    this.incidentDir = options.incidentDir
    this.verifyExecutable = options.verifyExecutable
    this.onRecoveryRequired = options.onRecoveryRequired
  }

  initialize(): Promise<void> {
    if (this.closed) return Promise.reject(unavailable('account file worker admission is closed'))
    return this.ready ??= this.initializeOnce()
  }

  private blockAdmission(): void {
    this.admissionBlocked = true
    if (this.recoveryNotified) return
    this.recoveryNotified = true
    // The owner may close this pool in response. Never await the callback from
    // an owned operation: close() must be able to await that operation itself.
    void Promise.resolve().then(() => this.onRecoveryRequired?.()).catch(() => undefined)
  }

  private async initializeOnce(): Promise<void> {
    this.executableHashes = await this.verifyExecutables()
    if (this.closed) throw unavailable('account file worker admission is closed')
    let entries: string[]
    try {
      await secureDirectory(this.incidentDir, true, true)
      entries = await readdir(this.incidentDir)
    } catch (error) {
      this.blockAdmission()
      if (isXpanelError(error)) throw error
      throw unavailable('account file worker incident journal readiness is unproven')
    }
    // A crash may leave a queued start. Even temporary/incomplete receipts gate
    // admission until inspected recovery; restarting must not erase evidence.
    if (entries.length !== 0) {
      this.blockAdmission()
      throw unavailable('unresolved account file worker incidents require inspected recovery')
    }
  }

  private async verifyExecutables(): Promise<string[]> {
    const hashes: string[] = []
    for (const path of [SYSTEMD_RUN, SYSTEMCTL]) {
      const hash = await this.verifyExecutable(path)
      if (!/^[0-9a-f]{64}$/.test(hash)) throw refused('systemd executable identity verification failed')
      hashes.push(hash)
    }
    return hashes
  }

  private async command(args: string[]): Promise<Capture> {
    return captureProcess(SYSTEMCTL, args, { stdinPayload: '', timeoutMs: CONTROL_TIMEOUT_MS, maxStdoutBytes: MAX_CONTROL_OUTPUT, maxStderrBytes: MAX_CONTROL_OUTPUT }).result
  }

  private async show(unit: string, properties: readonly string[]): Promise<Map<string, string>> {
    const result = await this.command(['show', '--system', '--no-pager', '--all', ...properties.map((property) => '--property=' + property), unit])
    if (result.failure || !result.reaped || result.signal || result.exitCode !== 0 || result.stderr.trim()) throw refused('file worker systemd state could not be verified')
    return fields(result.stdout, properties)
  }

  private async inspectWorker(input: WorkerInput): Promise<UnitStatus> {
    const value = await this.show(input.workerUnit, ['LoadState', 'ActiveState', 'ControlGroup', 'Job'])
    const job = value.get('Job')!
    if (job !== '' && !/^\d+$/.test(job)) throw refused('file worker pending job state is malformed')
    const cgroup = value.get('ControlGroup')!
    const expected = input.cgroupPath.slice(CGROUP_ROOT.length) + '/' + input.workerUnit
    if (cgroup !== '' && cgroup !== expected) throw refused('file worker unit cgroup does not match its generated name')
    const load = value.get('LoadState')!
    const active = value.get('ActiveState')!
    if (!['loaded', 'not-found'].includes(load) || !['active', 'inactive', 'activating', 'deactivating', 'failed', 'reloading'].includes(active)) throw refused('file worker unit lifecycle state is unsupported')
    if (load === 'not-found' && (active !== 'inactive' || cgroup !== '' || (job !== '' && job !== '0'))) throw refused('file worker absent unit state is inconsistent')
    return { load, active, cgroup, pending: job !== '' && job !== '0' }
  }

  private async preflight(input: WorkerInput): Promise<void> {
    if (!Number.isSafeInteger(input.uid) || input.uid < 1000 || input.uid > 65_533 || typeof input.workerUnit !== 'string' || !new RegExp('^xpanel-files-' + input.uid + '-[0-9a-f]{32}\\.service$').test(input.workerUnit)) throw refused('file worker requires a generated per-account service identity')
    if (input.cgroupPath !== CGROUP_ROOT + '/xpanel.slice/xpanel-' + input.uid + '.slice' || !canonicalPath(input.binaryPath)) throw refused('file worker requires canonical executable and account cgroup paths')
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 50 || input.timeoutMs > 120_000 || !Number.isSafeInteger(input.maxStdoutBytes) || input.maxStdoutBytes < 1024 || input.maxStdoutBytes > 4 * 1024 * 1024 || !Number.isSafeInteger(input.maxStderrBytes) || input.maxStderrBytes < 1 || input.maxStderrBytes > 64 * 1024 || typeof input.stdinPayload !== 'string' || Buffer.byteLength(input.stdinPayload) > MAX_REQUEST) throw refused('file worker invocation budgets are invalid')
    const hashes = await this.verifyExecutables()
    if (hashes.some((hash, index) => hash !== this.executableHashes[index])) throw refused('systemd executable identity changed during this daemon lifetime')
    const slice = 'xpanel-' + input.uid + '.slice'
    const fragment = '/etc/systemd/system/' + slice
    const value = await this.show(slice, ['LoadState', 'ActiveState', 'FragmentPath', 'ControlGroup'])
    if (value.get('LoadState') !== 'loaded' || value.get('ActiveState') !== 'active' || value.get('FragmentPath') !== fragment || value.get('ControlGroup') !== input.cgroupPath.slice(CGROUP_ROOT.length)) throw refused('an active loaded canonical account slice is required')
    await secureDirectory('/etc/systemd/system')
    await secureFile(fragment)
    await secureDirectory(input.cgroupPath)
    if ((await statfs(CGROUP_ROOT)).type !== CGROUP2_MAGIC) throw refused('the unified cgroup v2 hierarchy is required')
    for (const directory of [CGROUP_ROOT, CGROUP_ROOT + '/xpanel.slice', input.cgroupPath]) {
      // systemd enables the account's subtree controllers when it creates its
      // first service; requiring that already populated child policy here would
      // reject a legitimate active empty account slice.
      const names = directory === input.cgroupPath ? ['cgroup.controllers'] : ['cgroup.controllers', 'cgroup.subtree_control']
      for (const name of names) {
        const controllers = new Set((await secureFile(directory + '/' + name)).trim().split(/\s+/))
        if (!['cpu', 'memory', 'pids', 'io'].every((controller) => controllers.has(controller))) throw refused('account CPU, memory, process and I/O controllers must be available from the enabled parent')
      }
    }
    if ((await secureFile(input.cgroupPath + '/cgroup.type')).trim() !== 'domain') throw refused('the account cgroup must be a domain')
    if (!/^(max|[1-9]\d*) [1-9]\d*$/.test((await secureFile(input.cgroupPath + '/cpu.max')).trim())) throw refused('account CPU enforcement is unavailable')
    for (const name of ['memory.max', 'pids.max']) if (!/^(max|[1-9]\d*)$/.test((await secureFile(input.cgroupPath + '/' + name)).trim())) throw refused('account resource enforcement is unavailable')
    // An empty io.max is the kernel's explicit unlimited per-device policy.
    // Its trusted interface must exist even if the plan sets no finite I/O cap.
    const io = (await secureFile(input.cgroupPath + '/io.max')).trim()
    if (io && io.split('\n').some((line) => !/^\d+:\d+(?: (?:rbps|wbps|riops|wiops)=(?:max|[1-9]\d*)){1,4}$/.test(line))) throw refused('account I/O enforcement is unavailable')
    const existing = await this.inspectWorker(input)
    if (existing.load !== 'not-found') throw refused('generated file worker service identity is already in use')
  }

  private async syncIncidentDirectory(): Promise<void> {
    const directory = await open(this.incidentDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
  }

  private async receipt(input: WorkerInput, reason: string, initial: boolean): Promise<void> {
    await secureDirectory(this.incidentDir, false, true)
    const path = posix.join(this.incidentDir, input.workerUnit + '.json')
    const target = initial ? path : posix.join(this.incidentDir, '.' + randomUUID() + '.tmp')
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      // O_EXCL proves this is a newly created receipt, not an existing incident
      // whose trust must be preserved. A root daemon's primary GID is not 0.
      await handle.chown(0, 0)
      await handle.chmod(0o600)
      const st = await handle.stat()
      if (!st.isFile() || st.uid !== 0 || st.gid !== 0 || (st.mode & 0o777) !== 0o600) throw unavailable('file worker incident journal metadata is unsafe')
      await handle.writeFile(JSON.stringify({ version: 1, unit: input.workerUnit, uid: input.uid, reason, status: initial ? 'in-flight' : 'unresolved', recordedAt: new Date().toISOString() }) + '\n', 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    if (!initial) await rename(target, path)
    await this.syncIncidentDirectory()
  }

  private async clearReceipt(input: WorkerInput): Promise<void> {
    await secureDirectory(this.incidentDir, false, true)
    const path = posix.join(this.incidentDir, input.workerUnit + '.json')
    const st = await lstat(path)
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || st.gid !== 0 || (st.mode & 0o777) !== 0o600) throw unavailable('file worker incident journal metadata changed')
    await unlink(path)
    await this.syncIncidentDirectory()
  }

  private async cgroupEmpty(input: WorkerInput): Promise<boolean> {
    const path = input.cgroupPath + '/' + input.workerUnit
    try { await secureDirectory(path) } catch (error) {
      if (hasCode(error, 'ENOENT')) return true
      throw error // Permission, parser and ownership errors never prove absence.
    }
    // An existing directory without readable events is unknown, not an absent cgroup.
    const text = await secureFile(path + '/cgroup.events', 1024)
    const values = new Map<string, string>()
    for (const row of text.trim().split('\n')) {
      const match = /^([a-z_]+) ([01])$/.exec(row)
      if (!match || values.has(match[1]!)) throw refused('file worker cgroup event state is malformed')
      values.set(match[1]!, match[2]!)
    }
    if (!values.has('populated')) throw refused('file worker cgroup population is unknown')
    return values.get('populated') === '0'
  }

  private async cleanup(input: WorkerInput, capture: Capture | undefined, launchAttempted: boolean): Promise<boolean> {
    let observed = false
    let quiet = 0
    const knownLaunchFinished = !launchAttempted || Boolean(capture && capture.reaped && (!capture.spawned || (!capture.failure && !capture.signal && capture.exitCode === 0) || this.helperAcknowledged(input, capture)))
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
      try {
        // Repeat after reaping: a queued start can appear after an initial stop
        // found no unit. Only this generated service is ever stopped.
        const stop = await this.command(['stop', '--system', '--no-ask-password', '--no-pager', input.workerUnit])
        if (stop.failure || !stop.reaped || stop.signal) throw unavailable('file worker stop command did not terminate normally')
        const state = await this.inspectWorker(input)
        observed ||= state.load === 'loaded'
        const terminal = state.active === 'inactive'
        if ((!launchAttempted || capture?.reaped === true) && terminal && !state.pending && (knownLaunchFinished || observed) && await this.cgroupEmpty(input)) quiet++
        else quiet = 0
        if (quiet >= 2) return true
      } catch { quiet = 0 }
      if (attempt + 1 < CLEANUP_ATTEMPTS) await delay(CLEANUP_RETRY_MS)
    }
    return false
  }

  private helperAcknowledged(input: WorkerInput, captured: Capture): boolean {
    try {
      const envelope = JSON.parse(captured.stdout) as { protocolVersion?: unknown; ok?: unknown; worker?: { pid?: unknown; cgroup?: unknown } }
      return envelope.protocolVersion === 2 && typeof envelope.ok === 'boolean' && typeof envelope.worker?.pid === 'number' && Number.isSafeInteger(envelope.worker.pid) && envelope.worker.pid > 0 && envelope.worker.cgroup === input.cgroupPath.slice(CGROUP_ROOT.length) + '/' + input.workerUnit
    } catch { return false }
  }

  run(input: WorkerPreparation): Promise<HelperProcessSpawnResult> {
    if (this.closed || this.admissionBlocked) return Promise.reject(unavailable('account file worker admission is closed'))
    // Reserve before initialization, verification, serialization or any await.
    // There is deliberately no queue and no unbounded retained request list.
    if (this.jobs.size >= MAX_ACTIVE_FILE_WORKERS) return Promise.reject(unavailable('account file worker capacity is exhausted'))
    const job: ActiveJob = { prepare: typeof input === 'function' ? input : { ...input }, controller: new AbortController(), canceled: false }
    this.jobs.add(job)
    const operation = this.execute(job).finally(() => this.jobs.delete(job))
    job.completion = operation
    return operation
  }

  private waitForJob<T>(job: ActiveJob, pending: Promise<T>): Promise<T> {
    const signal = job.controller.signal
    if (signal.aborted) return Promise.reject(unavailable('account file worker operation was canceled'))
    return new Promise<T>((resolve, reject) => {
      const aborted = () => { signal.removeEventListener('abort', aborted); reject(unavailable('account file worker operation was canceled')) }
      signal.addEventListener('abort', aborted, { once: true })
      pending.then(
        (value) => { signal.removeEventListener('abort', aborted); if (signal.aborted) aborted(); else resolve(value) },
        (error) => { signal.removeEventListener('abort', aborted); reject(error) },
      )
    })
  }

  private async execute(job: ActiveJob): Promise<HelperProcessSpawnResult> {
    await this.waitForJob(job, this.initialize())
    if (this.closed || job.canceled || this.admissionBlocked) throw unavailable('account file worker admission is closed')
    const prepared = typeof job.prepare === 'function'
      ? await this.waitForJob(job, Promise.resolve().then(() => {
        if (this.closed || job.canceled || this.admissionBlocked) throw unavailable('account file worker admission is closed')
        return (job.prepare as (signal: AbortSignal) => Promise<WorkerInput>)(job.controller.signal)
      }))
      : job.prepare
    if (this.closed || job.canceled || this.admissionBlocked) throw unavailable('account file worker admission is closed')
    const input = { ...prepared }
    try { await this.waitForJob(job, this.preflight(input)) } catch (error) {
      if (isXpanelError(error)) throw error
      throw refused('account file worker policy preflight could not be completed')
    }
    if (this.closed || job.canceled || this.admissionBlocked) throw unavailable('account file worker admission is closed')
    try { await this.receipt(input, 'launch', true) } catch {
      this.blockAdmission()
      throw unavailable('account file worker durable launch journal could not be persisted')
    }
    let captured: Capture | undefined
    let attempted = false
    let reason: FailureReason | undefined
    try {
      if (this.closed || job.canceled || this.admissionBlocked) reason = 'closed'
      else {
        const slice = 'xpanel-' + input.uid + '.slice'
        const properties = [
          'Restart=no', 'KillMode=control-group', 'RuntimeMaxSec=' + input.timeoutMs + 'ms', 'TimeoutStartSec=' + input.timeoutMs + 'ms',
          'TimeoutStopSec=2s', 'SendSIGKILL=yes', 'NoNewPrivileges=yes', 'MemoryMax=64M', 'MemorySwapMax=0', 'TasksMax=1', 'CPUQuota=100%',
          'ConditionPathExists=/etc/systemd/system/' + slice, 'BindsTo=' + slice,
        ]
        const args = ['--system', '--no-ask-password', '--quiet', '--pipe', '--wait', '--collect', '--service-type=exec', '--expand-environment=no', '--unit=' + input.workerUnit, '--slice=' + slice, ...properties.map((property) => '--property=' + property), '--', input.binaryPath]
        attempted = true
        job.process = captureProcess(SYSTEMD_RUN, args, input)
        captured = await job.process.result
        reason = job.canceled || this.closed ? 'closed' : captured.failure ?? (captured.signal ? 'wrapper-signal' : captured.exitCode !== 0 ? 'wrapper-failure' : undefined)
        if (captured.observer) {
          let observerTimer: ReturnType<typeof setTimeout> | undefined
          try { await Promise.race([
            captured.observer,
            new Promise<never>((_, reject) => { observerTimer = setTimeout(() => reject(unavailable('file worker observer timed out')), input.timeoutMs) }),
            new Promise<never>((_, reject) => { job.cancelObserver = () => reject(unavailable('file worker pool closed')) }),
          ]) }
          catch { reason ??= 'observer-error'; job.process.kill() }
          finally { clearTimeout(observerTimer); job.cancelObserver = undefined }
        }
      }
    } catch { reason ??= 'spawn-error'; job.process?.kill() }
    const cleaned = await this.cleanup(input, captured, attempted)
    if (!cleaned) {
      this.blockAdmission()
      try { await this.receipt(input, reason ?? 'cleanup-unknown', false) }
      catch { throw unavailable('file worker cleanup is unproven and its incident journal could not be persisted') }
      throw unavailable('file worker termination is unproven; incident retained for inspected recovery')
    }
    try { await this.clearReceipt(input) } catch {
      this.blockAdmission()
      throw unavailable('file worker termination was proved but its incident journal could not be cleared durably')
    }
    if (job.canceled || this.closed) reason = 'closed'
    // A native rejection is a completed operation, not a failed supervisor.
    // Preserve its structured envelope for the authoritative runner parser.
    if (captured && reason === 'wrapper-failure' && this.helperAcknowledged(input, captured)) {
      return { exitCode: captured.exitCode, signal: captured.signal, stdout: captured.stdout, stderr: captured.stderr, pid: captured.pid }
    }
    if (reason || !captured) {
      if (reason === 'stdout-limit' || reason === 'stderr-limit') throw new XpanelError('CONFIG_TEST_FAILED', 'confined file helper output exceeded its bounded response size')
      throw unavailable('confined file helper did not complete within its supervised operation')
    }
    return { exitCode: captured.exitCode, signal: captured.signal, stdout: captured.stdout, stderr: captured.stderr, pid: captured.pid }
  }

  async close(): Promise<void> {
    this.closed = true
    const jobs = [...this.jobs]
    for (const job of jobs) { job.canceled = true; job.controller.abort(); job.process?.kill(); job.cancelObserver?.() }
    await Promise.allSettled(jobs.map((job) => job.completion))
    if (this.admissionBlocked) throw unavailable('file worker pool closed with unresolved operational incidents')
  }
}
