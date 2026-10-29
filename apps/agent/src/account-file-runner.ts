import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { ErrorCode } from '@xpanel/core'
import type { AccountFileContext, AccountFileRequest, AccountFileRunner } from './file-manager.ts'
import { SystemdAccountFileWorkerPool } from './systemd-file-worker.ts'

export const ACCOUNT_FILE_HELPER_PROTOCOL_VERSION = 2
export const MAX_HELPER_STDIN_BYTES = 4 * 1024 * 1024
export const MAX_HELPER_STDOUT_BYTES = 4 * 1024 * 1024
export const MAX_HELPER_STDERR_BYTES = 64 * 1024
export const DEFAULT_HELPER_TIMEOUT_MS = 15_000
export const DEFAULT_FILE_WORKER_INCIDENT_DIR = '/var/lib/xpanel-agent/file-worker-incidents'
export const MIN_CONFINED_ACCOUNT_ID = 1000
export const MAX_CONFINED_ACCOUNT_ID = 65_533

export interface HelperWorkerTelemetry {
  pid: number
  uid: number
  gid: number
  cgroup: string
}

export interface HelperErrorPayload {
  code: string
  errno: number
  errnoName: string
  message: string
}

export interface HelperResponseEnvelope {
  protocolVersion: number
  ok: boolean
  op: string
  worker: HelperWorkerTelemetry
  result?: unknown
  error?: HelperErrorPayload
}

export interface HelperExecutionObservation extends HelperWorkerTelemetry {
  op: AccountFileRequest['op']
  ok: boolean
  errorCode?: ErrorCode
  errno?: number
  errnoName?: string
}

export interface HelperProcessSpawnInput {
  binaryPath: string
  stdinPayload: string
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
  onStdoutLine?: (line: string, pid: number) => Promise<void> | void
}

export interface HelperProcessSpawnResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  pid: number
}

export type HelperProcessSpawner = (input: HelperProcessSpawnInput) => Promise<HelperProcessSpawnResult>

export interface NativeAccountFileRunnerOptions {
  /** Absolute path to the root-owned compiled `xpanel-account-files` binary. */
  binaryPath: string
  /** Optional expected lowercase hex SHA-256 digest of the compiled binary. */
  expectedSha256?: string
  /** Optional cgroup v2 slice path template or resolver, e.g. `(uid) => "/sys/fs/cgroup/xpanel.slice/xpanel-" + uid + ".slice"`. */
  cgroupPathForAccount?: (account: Readonly<AccountFileContext['account']>) => string | undefined
  /** Whether missing cgroup v2 slice must abort before tenant I/O (default: false unless cgroupPathForAccount is set). */
  requireCgroup?: boolean
  /** Per-invocation timeout in milliseconds (default: 15_000). */
  timeoutMs?: number
  /** Maximum stdout bytes accepted from the helper (default: 4 MiB). */
  maxStdoutBytes?: number
  /** Optional hold-open window in milliseconds (0..2000) after worker stdout flush so external observers can inspect live `/proc/<pid>`. */
  holdOpenMs?: number
  /** Optional observer callback invoked while the dropped-privilege worker process is still alive. */
  onLiveWorker?: (info: { pid: number; envelope: HelperResponseEnvelope }) => Promise<void> | void
  /** Optional callback receiving structured telemetry from each completed helper execution. */
  onObservation?: (observation: HelperExecutionObservation) => void
  /** Root-only operational incidents, outside the canonical StateStore tree. */
  incidentDir?: string
  /** Latched operational readiness failure; never awaited by a worker. */
  onRecoveryRequired?: () => void | Promise<void>
  /** Test-only process spawner override for portable protocol unit tests on non-Linux hosts. */
  spawner?: HelperProcessSpawner
}

const ALLOWED_ERROR_CODES = new Set<ErrorCode>([
  'VALIDATION',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'LIMIT_EXCEEDED',
  'PRECONDITION_FAILED',
  'CONFIG_TEST_FAILED',
  'SERVICE_UNAVAILABLE',
])

const assertConfinedAccountIdentity = (account: Readonly<AccountFileContext['account']>): void => {
  if (
    !Number.isSafeInteger(account.uid) ||
    account.uid < MIN_CONFINED_ACCOUNT_ID ||
    account.uid > MAX_CONFINED_ACCOUNT_ID ||
    !Number.isSafeInteger(account.gid) ||
    account.gid < MIN_CONFINED_ACCOUNT_ID ||
    account.gid > MAX_CONFINED_ACCOUNT_ID
  ) {
    fail('VALIDATION', `confined account UID and GID must be integers in ${MIN_CONFINED_ACCOUNT_ID}..${MAX_CONFINED_ACCOUNT_ID}`)
  }
}

/**
 * Verifies that the native helper binary and its parent directory are owned by `root:root`,
 * not symbolic links, not group- or world-writable, have mode `0755` without setuid/setgid bits,
 * and match the expected SHA-256 digest when supplied.
 */
export const verifyHelperBinary = async (binaryPath: string, expectedSha256?: string): Promise<string> => {
  if (process.platform !== 'linux') {
    fail('PRECONDITION_FAILED', 'native account file helper requires Linux')
  }
  if (typeof binaryPath !== 'string' || !isAbsolute(binaryPath) || /[\u0000-\u001f\u007f]/.test(binaryPath)) {
    fail('PRECONDITION_FAILED', 'helper binary path must be a canonical absolute Linux path')
  }
  const resolved = resolve(binaryPath)
  const parentDir = dirname(resolved)

  let parentStat
  try {
    parentStat = await lstat(parentDir)
  } catch {
    return fail('PRECONDITION_FAILED', 'helper binary parent directory does not exist')
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== 0 || parentStat.gid !== 0 || (parentStat.mode & 0o022) !== 0) {
    fail('PRECONDITION_FAILED', 'helper binary parent directory must be owned by root:root without group or world write access')
  }

  let binaryLstat
  try {
    binaryLstat = await lstat(resolved)
  } catch {
    return fail('PRECONDITION_FAILED', 'confined account file helper binary is not installed')
  }
  if (binaryLstat.isSymbolicLink() || !binaryLstat.isFile()) {
    fail('PRECONDITION_FAILED', 'helper binary must be a regular file, not a symlink')
  }

  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = await handle.stat()
    if (!st.isFile() || st.uid !== 0 || st.gid !== 0 || (st.mode & 0o7777) !== 0o755) {
      fail('PRECONDITION_FAILED', 'helper binary must be owned by root:root with mode 0755 and no setuid/setgid bits')
    }
    const bytes = await handle.readFile()
    const actualSha256 = createHash('sha256').update(bytes).digest('hex')
    if (expectedSha256 !== undefined) {
      const normalized = expectedSha256.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(normalized)) {
        fail('VALIDATION', 'expectedSha256 must be a 64-character hexadecimal SHA-256 digest')
      }
      const a = Buffer.from(actualSha256, 'utf8')
      const b = Buffer.from(normalized, 'utf8')
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        fail('PRECONDITION_FAILED', 'helper binary SHA-256 digest verification failed')
      }
    }
    return actualSha256
  } finally {
    await handle.close()
  }
}

const parseEnvelope = (rawStdout: string, expectedOp: AccountFileRequest['op']): HelperResponseEnvelope => {
  const trimmed = rawStdout.trim()
  if (!trimmed) {
    return fail('CONFIG_TEST_FAILED', 'confined file helper returned empty output', { operation: expectedOp })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return fail('CONFIG_TEST_FAILED', 'confined file helper returned malformed JSON', { operation: expectedOp })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('CONFIG_TEST_FAILED', 'confined file helper response must be a JSON object', { operation: expectedOp })
  }
  const obj = parsed as Record<string, unknown>
  if (expectedOp === 'write-checked' && Object.keys(obj).some(key => !['protocolVersion', 'ok', 'op', 'worker', 'result', 'error'].includes(key))) return fail('CONFIG_TEST_FAILED', 'checked file helper response has unexpected fields', { operation: expectedOp })
  if (obj.protocolVersion !== ACCOUNT_FILE_HELPER_PROTOCOL_VERSION) {
    return fail('CONFIG_TEST_FAILED', 'confined file helper returned an unsupported protocol version', {
      operation: expectedOp,
      protocolVersion: obj.protocolVersion ?? null,
    })
  }
  if (typeof obj.ok !== 'boolean' || typeof obj.op !== 'string') {
    return fail('CONFIG_TEST_FAILED', 'confined file helper response is missing status fields', { operation: expectedOp })
  }
  if (obj.op !== expectedOp && !(obj.ok === false && obj.op === 'init')) {
    return fail('CONFIG_TEST_FAILED', 'confined file helper operation mismatch', {
      operation: expectedOp,
      returnedOp: obj.op,
    })
  }
  const worker = obj.worker as Record<string, unknown> | undefined
  if (
    !worker ||
    typeof worker !== 'object' ||
    Array.isArray(worker) ||
    typeof worker.pid !== 'number' ||
    !Number.isSafeInteger(worker.pid) ||
    typeof worker.uid !== 'number' ||
    !Number.isSafeInteger(worker.uid) ||
    typeof worker.gid !== 'number' ||
    !Number.isSafeInteger(worker.gid) ||
    typeof worker.cgroup !== 'string'
  ) {
    return fail('CONFIG_TEST_FAILED', 'confined file helper response is missing worker telemetry', { operation: expectedOp })
  }
  return {
    protocolVersion: ACCOUNT_FILE_HELPER_PROTOCOL_VERSION,
    ok: obj.ok,
    op: obj.op,
    worker: {
      pid: worker.pid,
      uid: worker.uid,
      gid: worker.gid,
      cgroup: worker.cgroup,
    },
    ...(Object.hasOwn(obj, 'result') ? { result: obj.result } : {}),
    ...(obj.error && typeof obj.error === 'object' ? { error: obj.error as HelperErrorPayload } : {}),
  }
}

const canonicalCgroupPath = (path: string): boolean => {
  if (!path.startsWith('/') || /[\u0000-\u0020\u007f\\]/.test(path)) return false
  return path === '/' || path.slice(1).split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

const isWithinCgroup = (actual: string, expected: string): boolean =>
  canonicalCgroupPath(actual) && canonicalCgroupPath(expected) &&
  (actual === expected || actual.startsWith(expected + '/'))

export class NativeAccountFileRunner implements AccountFileRunner {
  readonly binaryPath: string
  readonly expectedSha256: string | undefined
  private readonly cgroupPathForAccount: ((account: Readonly<AccountFileContext['account']>) => string | undefined) | undefined
  private readonly requireCgroup: boolean
  private readonly timeoutMs: number
  private readonly maxStdoutBytes: number
  private readonly holdOpenMs: number
  private readonly onLiveWorker: ((info: { pid: number; envelope: HelperResponseEnvelope }) => Promise<void> | void) | undefined
  private readonly onObservation: ((observation: HelperExecutionObservation) => void) | undefined
  private readonly spawner: HelperProcessSpawner | undefined
  private readonly workerPool: SystemdAccountFileWorkerPool | undefined

  readonly observations: HelperExecutionObservation[] = []

  constructor(opts: NativeAccountFileRunnerOptions) {
    if (!opts || typeof opts.binaryPath !== 'string' || opts.binaryPath.length === 0) {
      fail('VALIDATION', 'NativeAccountFileRunner requires a binaryPath')
    }
    if (opts.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(opts.expectedSha256.trim())) {
      fail('VALIDATION', 'expectedSha256 must be a 64-character hexadecimal SHA-256 digest')
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120_000) {
      fail('VALIDATION', 'timeoutMs must be an integer in 50..120000')
    }
    const maxStdoutBytes = opts.maxStdoutBytes ?? MAX_HELPER_STDOUT_BYTES
    if (!Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1024 || maxStdoutBytes > MAX_HELPER_STDOUT_BYTES) {
      fail('VALIDATION', `maxStdoutBytes must be an integer in 1024..${MAX_HELPER_STDOUT_BYTES}`)
    }
    const holdOpenMs = opts.holdOpenMs ?? 0
    if (!Number.isSafeInteger(holdOpenMs) || holdOpenMs < 0 || holdOpenMs > 2000) {
      fail('VALIDATION', 'holdOpenMs must be an integer in 0..2000')
    }

    this.binaryPath = opts.binaryPath
    this.expectedSha256 = opts.expectedSha256?.trim().toLowerCase()
    this.cgroupPathForAccount = opts.cgroupPathForAccount
    this.requireCgroup = opts.requireCgroup ?? Boolean(opts.cgroupPathForAccount)
    this.timeoutMs = timeoutMs
    this.maxStdoutBytes = maxStdoutBytes
    this.holdOpenMs = holdOpenMs
    this.onLiveWorker = opts.onLiveWorker
    this.onObservation = opts.onObservation
    this.spawner = opts.spawner
    this.workerPool = opts.spawner ? undefined : new SystemdAccountFileWorkerPool({
      incidentDir: opts.incidentDir ?? DEFAULT_FILE_WORKER_INCIDENT_DIR,
      verifyExecutable: verifyHelperBinary,
      onRecoveryRequired: opts.onRecoveryRequired,
    })
  }

  async initialize(): Promise<void> {
    await this.workerPool?.initialize()
  }

  async close(): Promise<void> {
    await this.workerPool?.close()
  }

  get lastObservation(): HelperExecutionObservation | undefined {
    return this.observations.at(-1)
  }

  async run(context: Readonly<AccountFileContext>, request: Readonly<AccountFileRequest>): Promise<unknown> {
    if (request.op === 'write-checked') {
      const fields = ['op', 'path', 'content', 'remove', 'expectedExists', 'expectedContent', 'expectedMtime', 'mode']
      if (Object.keys(request).length !== fields.length || Object.keys(request).some(key => !fields.includes(key)) ||
          typeof request.path !== 'string' || request.path.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(request.path) || request.path.split('/').some(part => !part || part === '.' || part === '..' || part === '.trash') ||
          typeof request.content !== 'string' || !request.content.isWellFormed() || typeof request.expectedContent !== 'string' || !request.expectedContent.isWellFormed() ||
          Buffer.byteLength(request.content) > context.maxEditBytes || Buffer.byteLength(request.expectedContent) > context.maxEditBytes ||
          typeof request.remove !== 'boolean' || typeof request.expectedExists !== 'boolean' || typeof request.expectedMtime !== 'string' || request.expectedMtime.length >= 32 ||
          request.remove && request.content !== '' || !request.expectedExists && (request.expectedContent !== '' || request.expectedMtime !== '') ||
          request.expectedExists && !Number.isFinite(Date.parse(request.expectedMtime)) ||
          !Number.isSafeInteger(request.mode) || request.mode <= 0 || request.mode > context.maxFileMode || (request.mode & ~context.maxFileMode) !== 0) return fail('VALIDATION', 'checked file operation requires its exact bounded preimage', { stateChanged: false })
    }
    try { return await this.runConfined(context, request) }
    catch (error) {
      if (request.op !== 'write-checked' || isXpanelError(error) && error.detail?.stateChanged === false) throw error
      return fail('SERVICE_UNAVAILABLE', 'checked file outcome requires inspection', { operation: request.op, stateChanged: true, verificationRequired: true, unknownOutcome: true })
    }
  }

  private async runConfined(context: Readonly<AccountFileContext>, request: Readonly<AccountFileRequest>): Promise<unknown> {
    assertConfinedAccountIdentity(context.account)
    if (typeof context.homeRoot !== 'string' || !isAbsolute(context.homeRoot) || /[\u0000-\u001f\u007f]/.test(context.homeRoot)) {
      fail('VALIDATION', 'an absolute trusted homeRoot is required')
    }

    const cgroupPath = this.cgroupPathForAccount?.(context.account)
    if (this.requireCgroup && (!cgroupPath || !cgroupPath.startsWith('/sys/fs/cgroup/') || !canonicalCgroupPath(cgroupPath))) {
      fail('PRECONDITION_FAILED', 'account cgroup v2 slice path is required for confined file operations')
    }
    if (!this.spawner && (!this.requireCgroup || !cgroupPath)) {
      fail('PRECONDITION_FAILED', 'native file operations require a confined systemd worker')
    }
    const workerUnit = 'xpanel-files-' + context.account.uid + '-' + randomBytes(16).toString('hex') + '.service'
    const assertWorkerTelemetry = (envelope: HelperResponseEnvelope): void => {
      if (envelope.worker.uid !== context.account.uid || envelope.worker.gid !== context.account.gid ||
          envelope.worker.uid < MIN_CONFINED_ACCOUNT_ID || envelope.worker.gid < MIN_CONFINED_ACCOUNT_ID || envelope.worker.pid <= 0) {
        fail('CONFIG_TEST_FAILED', 'confined file helper worker UID/GID telemetry did not match account identity', { operation: request.op })
      }
      if (this.requireCgroup && cgroupPath) {
        const expected = cgroupPath.slice('/sys/fs/cgroup'.length)
        if (!isWithinCgroup(envelope.worker.cgroup, expected) ||
            (!this.spawner && envelope.worker.cgroup !== expected + '/' + workerUnit)) {
          fail('CONFIG_TEST_FAILED', 'confined file helper worker cgroup telemetry did not match required service', { operation: request.op })
        }
      }
    }

    const prepareInput = async (signal?: AbortSignal): Promise<HelperProcessSpawnInput> => {
      signal?.throwIfAborted()
      if (!this.spawner) await verifyHelperBinary(this.binaryPath, this.expectedSha256)
      signal?.throwIfAborted()
      const stdinPayload = JSON.stringify({
        protocolVersion: ACCOUNT_FILE_HELPER_PROTOCOL_VERSION,
        context: {
          username: context.account.username,
          uid: context.account.uid,
          gid: context.account.gid,
          home: context.account.home,
          homeRoot: context.homeRoot,
          diskQuotaMb: context.diskQuotaMb === 'unlimited' ? 0 : context.diskQuotaMb,
          maxEditBytes: context.maxEditBytes,
          maxFileMode: context.maxFileMode,
          maxDirMode: context.maxDirMode,
          maxListEntries: context.maxListEntries,
          ...(cgroupPath ? { cgroupPath } : {}),
          requireCgroup: this.requireCgroup,
          workerUnit,
          ...(this.holdOpenMs > 0 ? { holdOpenMs: this.holdOpenMs } : {}),
        },
        request,
      })
      if (Buffer.byteLength(stdinPayload, 'utf8') > MAX_HELPER_STDIN_BYTES) {
        fail('LIMIT_EXCEEDED', 'account file request exceeds maximum helper stdin size')
      }
      return {
        binaryPath: this.binaryPath, stdinPayload, timeoutMs: this.timeoutMs,
        maxStdoutBytes: this.maxStdoutBytes, maxStderrBytes: MAX_HELPER_STDERR_BYTES,
        ...(this.onLiveWorker ? {
          onStdoutLine: async (line: string) => {
            try {
              const envelope = parseEnvelope(line, request.op)
              if (!envelope.ok) return
              assertWorkerTelemetry(envelope)
              await this.onLiveWorker?.({ pid: envelope.worker.pid, envelope })
            } catch {
              /* Final protocol validation still decides the operation result. */
            }
          },
        } : {}),
      }
    }
    let spawnResult: HelperProcessSpawnResult
    try {
      spawnResult = this.spawner
        ? await this.spawner(await prepareInput())
        : await this.workerPool!.run(async (signal) => ({
            ...await prepareInput(signal), uid: context.account.uid, workerUnit, cgroupPath: cgroupPath!,
          }))
    } catch (err) {
      if (isXpanelError(err)) throw err
      return fail('PRECONDITION_FAILED', 'confined account file helper could not be executed', {
        operation: request.op,
      })
    }

    if (spawnResult.signal) {
      return fail('CONFIG_TEST_FAILED', `confined file helper terminated by signal ${spawnResult.signal}`, {
        operation: request.op,
        signal: spawnResult.signal,
      })
    }

    const envelope = parseEnvelope(spawnResult.stdout, request.op)

    if (!envelope.ok) {
      const errPayload = envelope.error
      if (
        !errPayload ||
        typeof errPayload.code !== 'string' ||
        typeof errPayload.errno !== 'number' ||
        typeof errPayload.errnoName !== 'string' ||
        typeof errPayload.message !== 'string'
      ) {
        return fail('CONFIG_TEST_FAILED', 'confined file helper returned an invalid error payload', {
          operation: request.op,
        })
      }
      const mappedCode: ErrorCode = ALLOWED_ERROR_CODES.has(errPayload.code as ErrorCode)
        ? (errPayload.code as ErrorCode)
        : 'CONFIG_TEST_FAILED'
      const observation: HelperExecutionObservation = {
        ...envelope.worker,
        op: request.op,
        ok: false,
        errorCode: mappedCode,
        errno: errPayload.errno,
        errnoName: errPayload.errnoName,
      }
      this.observations.push(observation)
      this.onObservation?.(observation)
      return fail(mappedCode, errPayload.message, {
        operation: request.op,
        ...(request.op === 'write-checked' && ['VALIDATION', 'CONFLICT', 'FORBIDDEN', 'NOT_FOUND', 'LIMIT_EXCEEDED', 'PRECONDITION_FAILED'].includes(mappedCode) ? { stateChanged: false } : {}),
        errno: errPayload.errno,
        errnoName: errPayload.errnoName,
        workerUid: envelope.worker.uid,
        workerGid: envelope.worker.gid,
        workerPid: envelope.worker.pid,
      })
    }

    if (spawnResult.exitCode !== 0) {
      return fail('CONFIG_TEST_FAILED', 'confined file helper reported ok with non-zero exit status', {
        operation: request.op,
        exitCode: spawnResult.exitCode,
      })
    }

    assertWorkerTelemetry(envelope)

    if (request.op === 'write-checked') {
      const entry = envelope.result
      const value = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null
      if (request.remove ? entry !== null : !value || Object.keys(value).some(key => !['name', 'path', 'kind', 'sizeBytes', 'mode', 'mtime'].includes(key)) || value.path !== request.path || value.name !== request.path.split('/').at(-1) || value.kind !== 'file' || value.mode !== request.mode || value.sizeBytes !== Buffer.byteLength(request.content) || typeof value.mtime !== 'string' || !Number.isFinite(Date.parse(value.mtime))) return fail('CONFIG_TEST_FAILED', 'checked file helper acknowledgement is invalid', { operation: request.op })
    }

    const observation: HelperExecutionObservation = {
      ...envelope.worker,
      op: request.op,
      ok: true,
    }
    this.observations.push(observation)
    this.onObservation?.(observation)
    return envelope.result
  }
}
