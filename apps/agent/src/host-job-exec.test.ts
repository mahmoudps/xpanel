import { describe, expect, it } from 'vitest'
import { createHostJobRun, HOST_JOB_PATH } from './host-job-exec.ts'

const node = process.execPath
const run = createHostJobRun({ killGraceMs: 200 })

describe('host job step runner', () => {
  it('runs an absolute binary with argv and reports output and exit codes', async () => {
    const ok = await run([node, '-e', 'process.stdout.write(process.argv[1]); process.stderr.write("warn")', 'a b;$(x)'])
    expect(ok).toEqual({ ok: true, code: 0, stdout: 'a b;$(x)', stderr: 'warn', timedOut: false })
    const failed = await run([node, '-e', 'process.exit(7)'])
    expect(failed).toMatchObject({ ok: false, code: 7, timedOut: false })
  })

  it('passes only the fixed PATH and reviewed environment names', async () => {
    process.env.XPANEL_HOST_JOB_LEAK = 'leaked'
    try {
      const result = await run([node, '-e', 'process.stdout.write(JSON.stringify(process.env))'], { env: { DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C.UTF-8' } })
      const env = JSON.parse(result.stdout) as Record<string, string>
      expect(env.PATH).toBe(HOST_JOB_PATH)
      expect(env.DEBIAN_FRONTEND).toBe('noninteractive')
      expect(env.LC_ALL).toBe('C.UTF-8')
      expect(env.XPANEL_HOST_JOB_LEAK).toBeUndefined()
    } finally { delete process.env.XPANEL_HOST_JOB_LEAK }
    await expect(run([node, '-e', '0'], { env: { HOME: '/root' } as never })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(run([node, '-e', '0'], { env: { LC_ALL: 'C\nX=1' } })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('refuses relative binaries, empty argv and out-of-range timeouts before spawning', async () => {
    await expect(run(['node', '-e', '0'])).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(run([])).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(run([node, 'a\0b'])).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(run([node, '-e', '0'], { timeoutMs: 0 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(run([node, '-e', '0'], { timeoutMs: 3_600_001 })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('reports a missing absolute binary as a failed start, not a success', async () => {
    const missing = process.platform === 'win32' ? 'C:\\xpanel-missing\\none.exe' : '/nonexistent/xpanel-missing'
    expect(await run([missing])).toMatchObject({ ok: false, code: null, timedOut: false, stderr: 'the command could not be started' })
  })

  it('stops a step at its deadline, escalating when SIGTERM is ignored', async () => {
    const started = Date.now()
    const result = await run([node, '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { timeoutMs: 300 })
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('bounds each captured stream and marks the truncation', async () => {
    const small = createHostJobRun({ maxCaptureBytes: 1024 })
    const result = await small([node, '-e', 'process.stdout.write("x".repeat(5000)); process.stderr.write("y".repeat(10))'])
    expect(result.ok).toBe(true)
    expect(result.stdout.startsWith('x'.repeat(1024) + '\n[output truncated at 1024 bytes]')).toBe(true)
    expect(result.stderr).toBe('y'.repeat(10))
  })
})
