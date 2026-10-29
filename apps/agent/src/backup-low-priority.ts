import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

/** nice(1) 19 and ionice(1) best-effort level 7: backup work yields CPU and disk to sites on a 1 vCPU host but still finishes. */
export const BACKUP_LOW_PRIORITY = ['/usr/bin/nice', '-n', '19', '/usr/bin/ionice', '-c', '2', '-n', '7'] as const
export const BACKUP_COMMAND_TIMEOUT_MS = 2 * 60 * 60_000
const MAX_STDERR_BYTES = 64 * 1024

export interface BackupCommand {
  argv: readonly string[]
  /** runuser(1) drops to the account before the command runs; the priority prefix applies to both. */
  runAsUser?: string
  /** File read into stdin, or a short text such as an sftp(1) batch. */
  stdinPath?: string
  stdinText?: string
  /** File created exclusively (0600, no link) for stdout; otherwise stdout is captured up to maxStdoutBytes. */
  stdoutPath?: string
  maxStdoutBytes: number
  timeoutMs?: number
  signal?: AbortSignal
}
export interface BackupCommandResult { ok: boolean; code: number; stdout: string; stderr: string; stdoutBytes: number; killed: string | null }
export type BackupCommandRunner = (command: BackupCommand) => Promise<BackupCommandResult>

export const lowPriorityArgv = (command: Pick<BackupCommand, 'argv' | 'runAsUser'>): string[] => {
  if (!command.argv.length || !command.argv[0]!.startsWith('/') || command.argv.some(arg => typeof arg !== 'string' || arg.includes('\u0000'))) throw new Error('invalid_backup_command')
  if (command.runAsUser !== undefined && !/^[a-z][a-z0-9]{0,15}$/.test(command.runAsUser)) throw new Error('invalid_backup_user')
  return [...BACKUP_LOW_PRIORITY, ...(command.runAsUser ? ['/usr/sbin/runuser', '-u', command.runAsUser, '--'] : []), ...command.argv]
}

/** argv-only child process (no shell) with a bounded stdout, a hard timeout and SIGKILL on overrun. */
export const runBackupCommand: BackupCommandRunner = async command => {
  const [cmd, ...args] = lowPriorityArgv(command)
  let output: FileHandle | null = null, input: FileHandle | null = null
  if (command.stdoutPath) output = await open(command.stdoutPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    if (command.stdinPath) input = await open(command.stdinPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    return await new Promise<BackupCommandResult>((resolve, reject) => {
      const child = spawn(cmd!, args, { stdio: [input ? input.fd : command.stdinText !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' }, windowsHide: true })
      if (command.stdinText !== undefined) { child.stdin!.on('error', () => undefined); child.stdin!.end(command.stdinText) }
      const out = child.stdout!, err = child.stderr!, stdout: Buffer[] = [], stderr: Buffer[] = []
      let stdoutBytes = 0, stderrBytes = 0, killed: string | null = null, writes = Promise.resolve()
      const kill = (reason: string): void => { if (!killed) { killed = reason; child.kill('SIGKILL') } }
      const timer = setTimeout(() => kill('timed out'), command.timeoutMs ?? BACKUP_COMMAND_TIMEOUT_MS)
      const abort = (): void => kill('aborted')
      if (command.signal?.aborted) abort(); else command.signal?.addEventListener('abort', abort, { once: true })
      out.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > command.maxStdoutBytes) return kill('output limit')
        if (output) { const handle = output; out.pause(); writes = writes.then(() => handle.write(chunk).then(() => undefined)).then(() => { out.resume() }, () => kill('write failed')) }
        else stdout.push(chunk)
      })
      err.on('data', (chunk: Buffer) => { if (stderrBytes < MAX_STDERR_BYTES) stderr.push(chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes)); stderrBytes += chunk.byteLength })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => {
        clearTimeout(timer); command.signal?.removeEventListener('abort', abort)
        void writes.then(async () => {
          if (output) await output.sync()
          const text = Buffer.concat(stderr).toString('utf8')
          resolve({ ok: code === 0 && !killed, code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: text, stdoutBytes, killed })
        }, reject)
      })
    })
  } finally {
    await output?.close().catch(() => undefined)
    await input?.close().catch(() => undefined)
  }
}
