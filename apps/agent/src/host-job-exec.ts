import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { fail } from '@xpanel/core'
import type { HostJobCommandResult, HostJobEnvName, HostJobRun } from './host-job-contract.ts'

export const HOST_JOB_ENV_NAMES: readonly HostJobEnvName[] = Object.freeze(['DEBIAN_FRONTEND', 'NEEDRESTART_MODE', 'APT_LISTCHANGES_FRONTEND', 'LC_ALL'])
export const HOST_JOB_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export const HOST_JOB_MAX_CAPTURE_BYTES = 1024 * 1024
export const HOST_JOB_MAX_TIMEOUT_MS = 3_600_000
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_KILL_GRACE_MS = 5_000
// A grandchild can keep inherited pipes open after the step itself exits.
const PIPE_DRAIN_MS = 1_000

const capture = (limit: number) => {
  const chunks: Buffer[] = []
  let bytes = 0, truncated = false
  return {
    push(chunk: Buffer): void {
      const room = limit - bytes
      if (chunk.length > room) truncated = true
      if (room <= 0) return
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk
      chunks.push(kept); bytes += kept.length
    },
    text: (): string => Buffer.concat(chunks).toString('utf8') + (truncated ? `\n[output truncated at ${limit} bytes]\n` : ''),
  }
}

const signal = (child: ChildProcess, name: NodeJS.Signals, group: boolean): void => {
  try {
    if (group && child.pid !== undefined) process.kill(-child.pid, name)
    else child.kill(name)
  } catch { try { child.kill(name) } catch { /* already exited */ } }
}

/**
 * Production step runner: an absolute binary and an argv array, never a shell; a fixed PATH plus
 * only the reviewed environment names; bounded capture; SIGTERM at the deadline, SIGKILL after grace.
 */
export const createHostJobRun = (options: { killGraceMs?: number; maxCaptureBytes?: number } = {}): HostJobRun => {
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const limit = options.maxCaptureBytes ?? HOST_JOB_MAX_CAPTURE_BYTES
  return async (argv, runOptions = {}) => {
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 256 || argv.some(item => typeof item !== 'string' || item.length > 4096 || item.includes('\0'))) {
      return fail('VALIDATION', 'host job commands require a bounded argv of strings', { stateChanged: false })
    }
    const [file, ...args] = argv as string[]
    if (!file || !isAbsolute(file)) return fail('VALIDATION', 'host job commands require an absolute binary path', { stateChanged: false })
    const timeoutMs = runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HOST_JOB_MAX_TIMEOUT_MS) return fail('VALIDATION', 'host job step timeout is out of range', { stateChanged: false })
    const env: Record<string, string> = { PATH: HOST_JOB_PATH }
    for (const [name, value] of Object.entries(runOptions.env ?? {})) {
      if (!(HOST_JOB_ENV_NAMES as readonly string[]).includes(name) || typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
        return fail('VALIDATION', 'host job environment is limited to reviewed names', { stateChanged: false })
      }
      env[name] = value
    }
    // A separate process group lets a timeout stop the whole step, not only its first process.
    const group = process.platform !== 'win32'
    return new Promise<HostJobCommandResult>(resolve => {
      const stdout = capture(limit), stderr = capture(limit)
      let timedOut = false, settled = false
      let child: ChildProcess
      let grace: ReturnType<typeof setTimeout> | undefined, drain: ReturnType<typeof setTimeout> | undefined
      const finish = (code: number | null, startError = false): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline); clearTimeout(grace); clearTimeout(drain)
        child?.stdout?.destroy(); child?.stderr?.destroy()
        const errText = stderr.text()
        resolve({ ok: !timedOut && !startError && code === 0, code: startError ? null : code, stdout: stdout.text(), stderr: startError && errText === '' ? 'the command could not be started' : errText, timedOut })
      }
      const deadline = setTimeout(() => {
        timedOut = true
        signal(child, 'SIGTERM', group)
        grace = setTimeout(() => signal(child, 'SIGKILL', group), killGraceMs)
      }, timeoutMs)
      try {
        child = spawn(file, args, { env, shell: false, detached: group, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch { finish(null, true); return }
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.once('error', () => finish(null, true))
      child.once('exit', code => { drain = setTimeout(() => finish(code), PIPE_DRAIN_MS) })
      child.once('close', code => finish(code))
    })
  }
}
