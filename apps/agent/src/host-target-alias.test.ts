import { lstat, open, readlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withPinnedHostTargetParent } from './host-target-parent.ts'

vi.mock('node:fs/promises', () => ({ lstat: vi.fn(), open: vi.fn(), readlink: vi.fn() }))

describe.runIf(process.platform === 'linux')('managed host conventional alias policy', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    let fd = 100
    vi.mocked(open).mockImplementation(async () => ({ fd: fd++, close: async () => {} }) as FileHandle)
    vi.mocked(lstat).mockImplementation(async path => ({ uid: 0, mode: 0o755, isSymbolicLink: () => String(path) === '/var/run', isDirectory: () => String(path) === '/var' }) as Awaited<ReturnType<typeof lstat>>)
    vi.mocked(readlink).mockResolvedValue('/run')
  })
  const walk = () => withPinnedHostTargetParent('/var/run/xpanel-fixture', async path => path)
  it('uses the reviewed root-owned alias target', async () => {
    await walk()
    expect(vi.mocked(open).mock.calls.map(call => String(call[0]))).toEqual(['/', '/proc/self/fd/100/run'])
  })
  it('does not redirect a physical /var/run directory to a different /run directory', async () => {
    vi.mocked(lstat).mockResolvedValue({ isSymbolicLink: () => false } as Awaited<ReturnType<typeof lstat>>)
    await walk()
    expect(vi.mocked(open).mock.calls.map(call => String(call[0]))).toEqual(['/', '/proc/self/fd/100/var', '/proc/self/fd/101/run'])
    expect(readlink).not.toHaveBeenCalled()
  })
  it('refuses an alias to an unreviewed target before any operation', async () => {
    vi.mocked(readlink).mockResolvedValue('/unreviewed')
    await expect(walk()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(open).not.toHaveBeenCalled()
  })
  it('refuses a non-root alias owner', async () => {
    vi.mocked(lstat).mockResolvedValueOnce({ uid: 20000, isSymbolicLink: () => true } as Awaited<ReturnType<typeof lstat>>)
    await expect(walk()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(open).not.toHaveBeenCalled()
  })
  it('refuses a writable alias parent', async () => {
    vi.mocked(lstat).mockResolvedValueOnce({ uid: 0, isSymbolicLink: () => true } as Awaited<ReturnType<typeof lstat>>)
    vi.mocked(lstat).mockResolvedValueOnce({ uid: 0, mode: 0o777, isDirectory: () => true } as Awaited<ReturnType<typeof lstat>>)
    await expect(walk()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(open).not.toHaveBeenCalled()
  })
})
