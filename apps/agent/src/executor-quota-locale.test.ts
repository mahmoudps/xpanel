import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ calls: [] as { argv: string[]; options: { env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } }[] }))
vi.mock('node:child_process', async () => ({
  ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
  execFile(binary: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number }, callback: (error: (Error & { code: number; killed: boolean }) | null, stdout: string, stderr: string) => void) {
    native.calls.push({ argv: [binary, ...args], options })
    if (binary === '/usr/bin/findmnt') callback(null, (({ TARGET: '/', SOURCE: '/dev/sda1', FSTYPE: 'ext4' } as Record<string, string>)[args[3]!] ?? '') + '\n', '')
    else if (binary === '/usr/sbin/quotaon') callback(Object.assign(new Error('quota state exit'), { code: 1, killed: false }),
      options.env?.LC_ALL === 'C' ? 'user quota on / (/dev/sda1) is on\n' : 'synthetic translated quota output\n', '')
    else callback(null, '20000\n', '')
    return { pid: 1 }
  },
}))

import { LinuxHostExecutor } from './executor.ts'
import { observeHomeUserQuota } from './services/quota.ts'

afterEach(() => { native.calls.length = 0; vi.unstubAllEnvs() })
describe('native quota read locale boundary with mocked subprocesses', () => {
  it('observes enabled quota under a non-C daemon locale without changing the daemon or unrelated commands', async () => {
    vi.stubEnv('LC_ALL', 'de_DE.UTF-8'); vi.stubEnv('LANG', 'de_DE.UTF-8')
    const executor = new LinuxHostExecutor()
    expect(await observeHomeUserQuota(argv => executor.runCommand(argv), '/home')).toMatchObject({ status: 'enabled', filesystem: '/', filesystemType: 'ext4' })
    expect(native.calls).toHaveLength(5)
    for (const { options } of native.calls) {
      expect(options.env).toMatchObject({ LC_ALL: 'C', LANG: 'C' })
      expect(options.timeout).toBe(30_000); expect(options.maxBuffer).toBeGreaterThan(0)
    }
    expect(process.env.LC_ALL).toBe('de_DE.UTF-8'); expect(process.env.LANG).toBe('de_DE.UTF-8')
    await executor.runCommand(['/usr/bin/id', '-u', 'alice'])
    expect(native.calls.at(-1)?.options.env).toBeUndefined()
  })
})
