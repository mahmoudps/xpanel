import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atomicRemove, atomicWriteJson } from './atomic.ts'

const fault = vi.hoisted(() => ({ directory: '', phase: '', code: '', renames: 0, closes: 0, fileSyncCode: '', closeCode: '', withoutCode: false, syscall: '', directoryKind: 'directory', stats: 0 }))
// Actual temporary files, file sync and rename/removal remain real. Only the
// directory-descriptor boundary and OS policy are modeled; no power-loss proof.
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const normalized = (path: unknown) => String(path).replace(/\\/g, '/')
  const failure = (code: string) => fault.withoutCode ? new Error('injected directory durability boundary without code') : Object.assign(new Error('injected directory durability boundary'), { code, ...(fault.syscall ? { syscall: fault.syscall } : {}) })
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (normalized(args[0]) === normalized(fault.directory) && args[1] === 'r') {
        if (fault.phase === 'open') throw failure(fault.code)
        return {
          stat: async () => { fault.stats++; if (fault.directoryKind === 'throws') throw failure('EIO'); return { isDirectory: () => fault.directoryKind === 'directory' } },
          sync: async () => { if (fault.phase === 'sync') throw failure(fault.code) },
          close: async () => { fault.closes++; if (fault.closeCode) throw failure(fault.closeCode); if (fault.phase === 'close') throw failure(fault.code) },
        }
      }
      const handle = await fs.open(...args)
      if (fault.fileSyncCode) handle.sync = async () => { throw failure(fault.fileSyncCode) }
      return handle
    },
    rename: async (...args: Parameters<typeof fs.rename>) => { await fs.rename(...args); fault.renames++ },
  }
})

const nativePlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
let root: string
beforeEach(async () => {
  fault.directory = ''; fault.phase = ''; fault.code = ''; fault.renames = 0; fault.closes = 0; fault.fileSyncCode = ''; fault.closeCode = ''; fault.withoutCode = false
  fault.syscall = ''; fault.directoryKind = 'directory'; fault.stats = 0
  root = await mkdtemp(join(tmpdir(), 'xpanel-atomic-durability-'))
  fault.directory = root
})
afterEach(async () => {
  Object.defineProperty(process, 'platform', nativePlatform)
  fault.directory = ''; fault.phase = ''; fault.fileSyncCode = ''
  await rm(root, { recursive: true, force: true })
})
const platform = (value: string) => Object.defineProperty(process, 'platform', { ...nativePlatform, value })

describe('directory durability acknowledgement after a real publication', () => {
  it.each([
    ['linux', 'open', 'EIO'], ['linux', 'sync', 'EIO'], ['linux', 'sync', 'ENOSPC'],
    ['linux', 'open', 'ENOTSUP'], ['linux', 'sync', 'EINVAL'], ['darwin', 'sync', 'ENOTSUP'],
    ['freebsd', 'sync', 'EIO'], ['openbsd', 'open', 'EACCES'],
    ['win32', 'open', 'EIO'], ['win32', 'open', 'ENOSPC'], ['win32', 'open', 'EACCES'],
    ['win32', 'sync', 'EIO'], ['win32', 'sync', 'ENOSPC'], ['win32', 'sync', 'UNEXPECTED_IO'],
    ['win32', 'sync', 'EACCES'],
    ['win32', 'close', 'EIO'], ['win32', 'close', 'EINVAL'], ['win32', 'close', 'ENOTSUP'],
    ['win32', 'open', 'EINVAL'], ['win32', 'open', 'ENOTSUP'], ['win32', 'sync', 'EISDIR'], ['win32', 'sync', 'EPERM'],
  ])('refuses success on %s directory %s failure %s although new bytes exist', async (os, phase, code) => {
    platform(os!)
    fault.phase = phase!; fault.code = code!
    const path = join(root, 'published.json')
    await writeFile(path, '{"value":"old"}')
    const error = await atomicWriteJson(path, { value: 'new' }).then(() => null, (reason: unknown) => reason)
    expect(fault.renames).toBe(1)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ value: 'new' })
    expect(error).toMatchObject({ name: 'StateDirectoryDurabilityError', code: 'STATE_DIRECTORY_DURABILITY', phase, cause: { code } })
    expect(fault.closes).toBe(phase === 'open' ? 0 : 1)
  })

  it.each([['open', 'EISDIR'], ['open', 'EPERM'], ['sync', 'EINVAL'], ['sync', 'ENOTSUP']])(
    'limits the modeled Windows unsupported exception to %s/%s', async (phase, code) => {
      platform('win32'); fault.phase = phase!; fault.code = code!
      const path = join(root, 'published.json')
      await atomicWriteJson(path, { value: 'new' })
      expect(fault.renames).toBe(1)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ value: 'new' })
      expect(fault.closes).toBe(phase === 'open' ? 0 : 1)
    },
  )

  it('does not turn a removal directory-sync failure into a successful or unchanged removal', async () => {
    platform('linux'); fault.phase = 'sync'; fault.code = 'EIO'
    const path = join(root, 'removed.json')
    await writeFile(path, '{}')
    await expect(atomicRemove(path)).rejects.toMatchObject({ code: 'STATE_DIRECTORY_DURABILITY', phase: 'sync', cause: { code: 'EIO' } })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never applies a Windows directory exception to temporary file sync', async () => {
    platform('win32'); fault.fileSyncCode = 'EINVAL'
    const path = join(root, 'not-published.json')
    await expect(atomicWriteJson(path, {})).rejects.toMatchObject({ code: 'EINVAL' })
    expect(fault.renames).toBe(0)
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an unclassified Windows directory error without a code', async () => {
    platform('win32'); fault.phase = 'open'; fault.withoutCode = true
    const path = join(root, 'published.json')
    const error = await atomicWriteJson(path, {}).then(() => null, (reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'STATE_DIRECTORY_DURABILITY', phase: 'open', cause: { message: 'injected directory durability boundary without code' } })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({})
  })

  it('closes after sync failure and retains its original cause when close also fails', async () => {
    platform('linux'); fault.phase = 'sync'; fault.code = 'EIO'; fault.closeCode = 'ENOSPC'
    const error = await atomicWriteJson(join(root, 'published.json'), {}).then(() => null, (reason: unknown) => reason)
    expect(fault.closes).toBe(1)
    expect(error).toMatchObject({ code: 'STATE_DIRECTORY_DURABILITY', phase: 'sync', cause: { code: 'EIO' }, closeCause: { code: 'ENOSPC' } })
  })

  it('limits measured Windows EPERM/fsync compatibility to the same proved directory descriptor', async () => {
    platform('win32'); fault.phase = 'sync'; fault.code = 'EPERM'; fault.syscall = 'fsync'
    const path = join(root, 'published.json')
    await atomicWriteJson(path, { value: 'new' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ value: 'new' })
    expect(fault.stats).toBe(1); expect(fault.closes).toBe(1)
  })

  it.each([
    ['directory', ''], ['directory', 'write'], ['file', 'fsync'], ['throws', 'fsync'],
  ])('refuses unproved Windows EPERM with descriptor %s and syscall %s', async (kind, syscall) => {
    platform('win32'); fault.phase = 'sync'; fault.code = 'EPERM'; fault.syscall = syscall!; fault.directoryKind = kind!
    await expect(atomicWriteJson(join(root, 'published.json'), {})).rejects.toMatchObject({ code: 'STATE_DIRECTORY_DURABILITY', phase: 'sync', cause: { code: 'EPERM' } })
    expect(fault.stats).toBe(syscall === 'fsync' ? 1 : 0)
    expect(fault.closes).toBe(1)
  })
})
