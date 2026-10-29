import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CRON_COMMAND_RUNNER } from './units.ts'

// This is an unprivileged shell-semantics test over synthetic temporary files, not systemd,
// tenant DAC or native hosting qualification. Windows requires an explicitly provided POSIX shell.
const shell = process.env.XPANEL_TEST_POSIX_SHELL ?? (process.platform === 'win32' ? undefined : '/bin/sh')
const available = !!shell && existsSync(shell)

describe('private cron source shell semantics', () => {
  it.skipIf(!available || !existsSync('/proc/self/cmdline'))('keeps private command text out of the running shell process argv', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xpanel-cron-semantics-'))
    const path = join(directory, 'private.command')
    const marker = 'SYNTHETIC_PRIVATE_CRON_ARGV_VALUE'
    try {
      await writeFile(path, '# ' + marker + '\n/bin/cat "/proc/$$/cmdline"\nprintf "\\ndone\\n"\n', { encoding: 'utf8', mode: 0o600 })
      const result = spawnSync(shell!, ['-c', CRON_COMMAND_RUNNER, '/bin/sh', path], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0)
      expect(result.stdout).not.toContain(marker)
      expect(result.stdout).toContain(CRON_COMMAND_RUNNER)
      expect(result.stdout).toContain('done')
    } finally {
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xpanel-cron-semantics-')) throw new Error('unsafe cron fixture cleanup target')
      await rm(directory, { recursive: true, force: true })
    }
  })
  it.skipIf(!available)('preserves source bytes, argv identity, stdin, exit status and trailing newlines without putting source in argv', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xpanel-cron-semantics-'))
    const path = join(directory, 'private.command'), sourcePath = path.replaceAll('\\', '/')
    const environment = { ...process.env }; delete environment._xpanel_cron_source
    const run = (source: string, privateFile: boolean) => spawnSync(shell!, ['-c', privateFile ? CRON_COMMAND_RUNNER : source, '/bin/sh', ...(privateFile ? [sourcePath] : [])], { encoding: 'utf8', env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      for (const source of [
        'printf "<%s>" "  quoted % text  "',
        'printf "%s:%s:%s" "$0" "$#" "${_xpanel_cron_source-unset}"',
        'IFS= read -r value; printf "%s" "$?"',
        'printf "%s" literal\\\n',
        'printf "%s" "SYNTHETIC_PRIVATE_CRON_VALUE"\n\n',
        'printf "%s" "$(printf nested)"; exit 7',
        '# comment only\n\n',
      ]) {
        await writeFile(path, source, { encoding: 'utf8', mode: 0o600 })
        expect(await readFile(path)).toEqual(Buffer.from(source, 'utf8'))
        const expected = run(source, false), actual = run(source, true)
        expect(actual.error).toBeUndefined(); expect(expected.error).toBeUndefined()
        expect({ status: actual.status, signal: actual.signal, stdout: actual.stdout, stderr: actual.stderr }).toEqual({ status: expected.status, signal: expected.signal, stdout: expected.stdout, stderr: expected.stderr })
      }
      const missing = spawnSync(shell!, ['-c', CRON_COMMAND_RUNNER, '/bin/sh', join(directory, 'missing.command').replaceAll('\\', '/')], { encoding: 'utf8', env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      expect(missing.status).not.toBe(0); expect(missing.stdout).toBe('')
    } finally {
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xpanel-cron-semantics-')) throw new Error('unsafe cron fixture cleanup target')
      await rm(directory, { recursive: true, force: true })
    }
  })
})
