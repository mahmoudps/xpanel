import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HelperDigestFiles } from './installed-helper-digest.ts'
import { refreshAccountFileHelperIfStale } from './refresh-account-file-helper.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const testDigestFiles: HelperDigestFiles = {
  async lstat(path) {
    try {
      const info = statSync(path)
      return { isFile: () => info.isFile(), isSymbolicLink: () => false, uid: 0, mode: 0o100644, size: info.size }
    } catch {
      return null
    }
  },
  async read(path) {
    return readFileSync(path)
  },
}

describe('refreshAccountFileHelperIfStale', { tags: ['unit'] }, () => {
  it('rebuilds an authentic older binary once and skips when source digest matches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xpanel-helper-refresh-'))
    dirs.push(root)
    const binaryPath = join(root, 'xpanel-account-files')
    const sourcePath = join(root, 'xpanel-account-files.c')
    writeFileSync(binaryPath, 'old-binary-v1', { mode: 0o755 })
    writeFileSync(binaryPath + '.sha256', `${sha256('old-binary-v1')}\n`, { mode: 0o644 })
    writeFileSync(sourcePath, '/* source v2 */\n', { mode: 0o644 })

    let compiles = 0
    const compile = (_compiler: string, args: readonly string[]) => {
      compiles += 1
      const out = args[args.indexOf('-o') + 1]!
      writeFileSync(out, 'new-binary-v2', { mode: 0o755 })
    }

    const first = await refreshAccountFileHelperIfStale(binaryPath, {
      sourcePath,
      digestFiles: testDigestFiles,
      chownRoot: false,
      verifyBinary: async (_path, expected) => expected!,
      compile,
    })
    expect(first).toBe('refreshed')
    expect(compiles).toBe(1)
    expect(readFileSync(binaryPath, 'utf8')).toBe('new-binary-v2')
    expect(readFileSync(binaryPath + '.sha256', 'utf8').trim()).toBe(sha256('new-binary-v2'))
    expect(readFileSync(binaryPath + '.source.sha256', 'utf8').trim()).toBe(sha256('/* source v2 */\n'))

    const second = await refreshAccountFileHelperIfStale(binaryPath, {
      sourcePath,
      digestFiles: testDigestFiles,
      chownRoot: false,
      verifyBinary: async (_path, expected) => expected!,
      compile,
    })
    expect(second).toBe('unchanged')
    expect(compiles).toBe(1)
  })

  it('refuses to compile when installed binary verification fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xpanel-helper-refresh-'))
    dirs.push(root)
    const binaryPath = join(root, 'xpanel-account-files')
    const sourcePath = join(root, 'xpanel-account-files.c')
    writeFileSync(binaryPath, 'tampered-binary', { mode: 0o755 })
    writeFileSync(binaryPath + '.sha256', `${sha256('authentic-binary')}\n`, { mode: 0o644 })
    writeFileSync(sourcePath, '/* source v2 */\n', { mode: 0o644 })

    let compiles = 0
    await expect(refreshAccountFileHelperIfStale(binaryPath, {
      sourcePath,
      digestFiles: testDigestFiles,
      chownRoot: false,
      verifyBinary: async () => { throw new Error('digest mismatch') },
      compile: () => { compiles += 1 },
    })).rejects.toThrow('digest mismatch')
    expect(compiles).toBe(0)
  })
})
