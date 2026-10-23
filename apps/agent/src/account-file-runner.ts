import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fail, isXpanelError, XpanelError } from '@xpanel/core'
import type { ErrorCode } from '@xpanel/core'
import type { AccountFileContext, AccountFileRequest, AccountFileRunner } from './file-manager.ts'

export const ACCOUNT_FILE_HELPER_PROTOCOL_VERSION = 1
export const MAX_HELPER_STDIN_BYTES = 4 * 1024 * 1024
export const MAX_HELPER_STDOUT_BYTES = 4 * 1024 * 1024
export const MAX_HELPER_STDERR_BYTES = 64 * 1024
export const DEFAULT_HELPER_TIMEOUT_MS = 15_000
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

const defaultProcessSpawner: HelperProcessSpawner = ({
  binaryPath,
  stdinPayload,
  timeoutMs,
  maxStdoutBytes,
  maxStderrBytes,
  onStdoutLine,
}) =>
  new Promise<HelperProcessSpawnResult>((resolvePromise, rejectPromise) => {
    const child = spawn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' },
      windowsHide: true,
    })

    const pid = child.pid ?? 0
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutOversize = false
    let timedOut = false
    let lineDelivered = false
    let pendingHook: Promise<void> = Promise.resolve()

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref?.()

    child.on('error', (err) => {
      clearTimeout(timer)
      rejectPromise(err)
    })

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maxStdoutBytes) {
        stdoutOversize = true
        child.kill('SIGKILL')
        return
      }
      stdoutChunks.push(Buffer.from(chunk))
      if (onStdoutLine && !lineDelivered && pid > 0) {
        const combined = Buffer.concat(stdoutChunks).toString('utf8')
        const nlIdx = combined.indexOf('\n')
        if (nlIdx >= 0) {
          lineDelivered = true
          const firstLine = combined.slice(0, nlIdx)
          pendingHook = Promise.resolve(onStdoutLine(firstLine, pid)).catch(() => undefined)
        }
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < maxStderrBytes) {
        const remaining = maxStderrBytes - stderrBytes
        stderrChunks.push(Buffer.from(chunk.subarray(0, remaining)))
      }
      stderrBytes += chunk.length
    })

    child.stdin.on('error', () => {
      /* Child may close stdin early on validation failure; stdout response carries the structured error. */
    })
    child.stdin.end(stdinPayload, 'utf8')

    child.on('close', async (exitCode, signal) => {
      clearTimeout(timer)
      await pendingHook
      if (stdoutOversize) {
        rejectPromise(
          new XpanelError('CONFIG_TEST_FAILED', 'confined file helper output exceeded maximum response size'),
        )
        return
      }
      if (timedOut) {
        rejectPromise(
          new XpanelError('SERVICE_UNAVAILABLE', 'confined file helper timed out and was terminated'),
        )
        return
      }
      resolvePromise({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        pid,
      })
    })
  })

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
  }

  get lastObservation(): HelperExecutionObservation | undefined {
    return this.observations.at(-1)
  }

  async run(context: Readonly<AccountFileContext>, request: Readonly<AccountFileRequest>): Promise<unknown> {
    assertConfinedAccountIdentity(context.account)
    if (typeof context.homeRoot !== 'string' || !isAbsolute(context.homeRoot) || /[\u0000-\u001f\u007f]/.test(context.homeRoot)) {
      fail('VALIDATION', 'an absolute trusted homeRoot is required')
    }

    if (!this.spawner) {
      await verifyHelperBinary(this.binaryPath, this.expectedSha256)
    }

    const cgroupPath = this.cgroupPathForAccount?.(context.account)
    if (this.requireCgroup && (!cgroupPath || !cgroupPath.startsWith('/sys/fs/cgroup/'))) {
      fail('PRECONDITION_FAILED', 'account cgroup v2 slice path is required for confined file operations')
    }

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
        ...(this.holdOpenMs > 0 ? { holdOpenMs: this.holdOpenMs } : {}),
      },
      request,
    })

    if (Buffer.byteLength(stdinPayload, 'utf8') > MAX_HELPER_STDIN_BYTES) {
      fail('LIMIT_EXCEEDED', 'account file request exceeds maximum helper stdin size')
    }

    const spawner = this.spawner ?? defaultProcessSpawner
    let spawnResult: HelperProcessSpawnResult
    try {
      spawnResult = await spawner({
        binaryPath: this.binaryPath,
        stdinPayload,
        timeoutMs: this.timeoutMs,
        maxStdoutBytes: this.maxStdoutBytes,
        maxStderrBytes: MAX_HELPER_STDERR_BYTES,
        ...(this.onLiveWorker
          ? {
              onStdoutLine: async (line, pid) => {
                try {
                  const env = parseEnvelope(line, request.op)
                  await this.onLiveWorker?.({ pid, envelope: env })
                } catch {
                  /* Validation errors will be handled after process close. */
                }
              },
            }
          : {}),
      })
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

    if (
      envelope.worker.uid !== context.account.uid ||
      envelope.worker.gid !== context.account.gid ||
      envelope.worker.uid < MIN_CONFINED_ACCOUNT_ID ||
      envelope.worker.gid < MIN_CONFINED_ACCOUNT_ID ||
      envelope.worker.pid <= 0
    ) {
      return fail('CONFIG_TEST_FAILED', 'confined file helper worker UID/GID telemetry did not match account identity', {
        operation: request.op,
        expectedUid: context.account.uid,
        actualUid: envelope.worker.uid,
        expectedGid: context.account.gid,
        actualGid: envelope.worker.gid,
      })
    }

    if (this.requireCgroup && cgroupPath) {
      const expectedSuffix = cgroupPath.slice('/sys/fs/cgroup'.length)
      if (!envelope.worker.cgroup.includes(expectedSuffix)) {
        return fail('CONFIG_TEST_FAILED', 'confined file helper worker cgroup telemetry did not match required slice', {
          operation: request.op,
          expectedCgroup: expectedSuffix,
          actualCgroup: envelope.worker.cgroup,
        })
      }
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
