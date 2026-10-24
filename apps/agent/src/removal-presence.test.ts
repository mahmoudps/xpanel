import { mkdtemp, mkdir, lstat, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinuxHostExecutor } from './executor.ts'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat) }
})

describe('removal target absence observation', () => {
  let root: string, target: string, executor: LinuxHostExecutor
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'xpanel-presence-'))
    target = join(root, 'home')
    executor = new LinuxHostExecutor({ trustedHostTargets: [{ path: target, operations: ['remove'] }] })
  })
  afterEach(async () => { vi.mocked(lstat).mockClear(); await rm(root, { recursive: true, force: true }) })
  it('reports a missing final target absent', async () => { expect(await executor.probeRemovalTarget(target)).toBe('absent') })
  it('reports a real directory present', async () => { await mkdir(target); expect(await executor.probeRemovalTarget(target)).toBe('present') })
  it('reports a file present', async () => { await writeFile(target, 'fixture'); expect(await executor.probeRemovalTarget(target)).toBe('present') })
  it('reports a dangling link present without following it', async () => {
    await symlink(join(root, 'missing'), target, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await executor.probeRemovalTarget(target)).toBe('present')
  })
  it.each(['EACCES', 'EPERM', 'EIO', 'ETIMEDOUT', 'ENOTDIR', undefined])('keeps %s observation failures unknown', async code => {
    vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error('observation unavailable'), { code }))
    expect(await executor.probeRemovalTarget(target)).toBe('unknown')
  })
  it('refuses a neighboring target before filesystem observation', async () => {
    await expect(executor.probeRemovalTarget(join(root, 'neighbor'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(lstat).not.toHaveBeenCalled()
  })
})
