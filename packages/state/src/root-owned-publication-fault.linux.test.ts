import { mkdir, mkdtemp, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WriterLock } from './writer-lock.ts'
import { atomicWriteRootOwnedJson } from './atomic.ts'

const fault = vi.hoisted(() => ({ root: '', enabled: false, published: false, shortWrite: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      if (fault.shortWrite && String(args[0]).endsWith('.tmp')) {
        handle.writeFile = async data => {
          const bytes = Buffer.from(String(data), 'utf8')
          await handle.write(bytes.subarray(0, 3))
          throw Object.assign(Error('injected incomplete write'), { code: 'ENOSPC' })
        }
      }
      if (String(args[0]) === fault.root && typeof args[1] === 'number') {
        const close = handle.close.bind(handle)
        handle.close = async () => {
          await close()
          if (fault.enabled && fault.published) { fault.enabled = false; throw Error('injected descriptor close failure') }
        }
      }
      return handle
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args)
      if (fault.enabled && String(args[1]).endsWith('/authority.json')) fault.published = true
    },
  }
})
let directory = ''
afterEach(async () => { fault.enabled = false; fault.shortWrite = false; if (directory) await rm(directory, { recursive: true, force: true }) })
it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0)(
  'keeps recovery evidence and refuses a second commit when descriptor close fails after publication', async () => {
    directory = await mkdtemp('/root/xpanel-root-lock-fault-')
    const state = join(directory, 'state'); await mkdir(state, { mode: 0o700 }); fault.root = state
    const lock = WriterLock.forRootOwnedDirectory(state), lease = await lock.acquire()
    fault.enabled = true; fault.published = false
    await expect(lease.commitAuthority()).rejects.toMatchObject({ code: 'STATE_DIRECTORY_DURABILITY' })
    await expect(lease.commitAuthority()).rejects.toMatchObject({ code: 'CONFLICT' })
    await lease.release()
    expect((await lstat(lock.lockDirPath)).isDirectory()).toBe(true)
  },
)
it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0)(
  'retains the prior file and removes the created temporary file after an incomplete write', async () => {
    directory = await mkdtemp('/root/xpanel-root-lock-short-')
    const state = join(directory, 'state'); await mkdir(state, { mode: 0o700 })
    const target = join(state, 'authority.json'); await writeFile(target, 'old', { mode: 0o640 })
    fault.root = state; fault.shortWrite = true
    await expect(atomicWriteRootOwnedJson(target, { new: 'value' })).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readdir(state)).toEqual(['authority.json'])
  },
)
