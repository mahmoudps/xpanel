import { spawn } from 'node:child_process'
import { fail } from '@xpanel/core'
import { isSwContainerCommand } from '../../../packages/os/src/sw-container-command.ts'
import { CTR_FOLLOW_SECONDS, isCtrCommand } from './ctr-command.ts'

export interface LogChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown; pause(): unknown; resume(): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  on(event: 'close' | 'error', listener: () => void): unknown
  kill(): unknown
}
export type LogFollower = (argv: readonly string[]) => ReadableStream<Uint8Array>
const SAFE_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' }
const MAX_FOLLOWERS = 4, HEARTBEAT_MS = 20_000
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** A bounded live log: at most four viewers, ten minutes each, and output stops being read when the reader lags. */
export function createLogFollower(start: (argv: readonly string[]) => LogChild = argv => spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: SAFE_ENV, shell: false }), seconds = CTR_FOLLOW_SECONDS): LogFollower {
  let live = 0
  return argv => {
    if (!isCtrCommand(argv) && !isSwContainerCommand(argv)) return fail('VALIDATION', 'invalid log command', { stateChanged: false })
    if (live >= MAX_FOLLOWERS) return fail('LIMIT_EXCEEDED', 'the live log limit is reached', { stateChanged: false, reason: 'log_viewers' })
    live++
    const child = start(argv), encoder = new TextEncoder()
    let pending = '', finished = false, controller: ReadableStreamDefaultController<Uint8Array> | null = null
    const write = (value: unknown): void => { if (!finished) controller?.enqueue(encoder.encode(JSON.stringify(value) + '\n')) }
    const finish = (reason: string | null): void => {
      if (finished) return
      if (reason) write({ end: reason })
      finished = true; live--
      clearTimeout(deadline); clearInterval(heartbeat)
      try { child.kill() } catch { /* already gone */ }
      if (reason) { try { controller?.close() } catch { /* the reader already went away */ } }
    }
    const deadline = setTimeout(() => finish('deadline'), seconds * 1000)
    // A quiet container must not look like a dead connection to the proxy in front of the panel.
    const heartbeat = setInterval(() => write({ alive: true }), HEARTBEAT_MS)
    deadline.unref?.(); heartbeat.unref?.()
    const take = (chunk: Buffer): void => {
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop()!.slice(-4000)
      for (const text of lines) write({ line: text.slice(0, 2000).replace(CONTROL, ' ') })
      if ((controller?.desiredSize ?? 1) <= 0) child.stdout?.pause()
    }
    return new ReadableStream<Uint8Array>({
      start(stream) {
        controller = stream
        child.stdout?.on('data', take); child.stderr?.on('data', take)
        child.on('close', () => finish('exit')); child.on('error', () => finish('error'))
      },
      pull() { child.stdout?.resume() },
      cancel() { finish(null) },
    }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength })
  }
}
