import { chown, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteJson, atomicWriteRootOwnedJson } from './atomic.ts'
import { setStateOwnershipDepsForTests } from './ownership.ts'
import { WriterLock } from './writer-lock.ts'

// Requires a genuine Linux root process and a private root-owned filesystem.
const nativeRoot = process.platform === 'linux' && process.getuid?.() === 0 && process.geteuid?.() === 0
describe.skipIf(!nativeRoot)('root-owned writer policy', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp('/root/xpanel-root-lock-test-'); await mkdir(join(root, 'state'), { mode: 0o700 }) })
  afterEach(async () => { setStateOwnershipDepsForTests(null); await rm(root, { recursive: true, force: true }) })
  const state = () => join(root, 'state')
  const metadata = async (path: string, mode: number) => {
    const info = await lstat(path)
    expect([info.uid, info.gid, info.mode & 0o7777]).toEqual([0, 0, mode])
  }

  it('keeps all lock metadata root-owned even when the API owner is configured', async () => {
    const claims: string[] = []
    setStateOwnershipDepsForTests({ euid: () => 0, lookup: () => ({ uid: 1234, gid: 1234 }), chown: async path => { claims.push(path) } })
    const lock = WriterLock.forRootOwnedDirectory(state())
    const lease = await lock.acquire()
    try {
      await metadata(state(), 0o700)
      await metadata(lock.mutexFilePath, 0o660)
      await metadata(lock.lockDirPath, 0o700)
      await metadata(lock.ownerFilePath, 0o640)
      await metadata(lock.authorityFilePath, 0o640)
      await lease.recordIntent({ op: 'root-test', createdRelPaths: [], backups: [] })
      await metadata(lock.intentFilePath, 0o640)
      await lease.commitAuthority()
      expect(claims).toEqual([])
    } finally { await lease.release() }
    await expect(lstat(lock.lockDirPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await metadata(state(), 0o700)
    await metadata(lock.authorityFilePath, 0o640)
    const api = join(root, 'api.json')
    await atomicWriteJson(api, { api: true })
    expect(claims).toContain(api)
  })

  it('refuses pre-existing foreign UID or GID and never repairs them', async () => {
    for (const [uid, gid] of [[1234, 0], [0, 1234]]) {
      const target = join(state(), 'authority.json')
      await writeFile(target, '{}', { mode: 0o640 })
      await chown(target, uid!, gid!)
      await expect(atomicWriteRootOwnedJson(target, { changed: true })).rejects.toBeDefined()
      expect([ (await lstat(target)).uid, (await lstat(target)).gid ]).toEqual([uid, gid])
      await rm(target)
    }
  })

  it('refuses symlinks, hardlinks, unsafe parents and foreign mutexes', async () => {
    const target = join(state(), 'authority.json'), other = join(state(), 'other')
    await writeFile(other, 'original')
    await symlink(other, target)
    await expect(atomicWriteRootOwnedJson(target, {})).rejects.toBeDefined()
    await rm(target)
    await link(other, target)
    await expect(atomicWriteRootOwnedJson(target, {})).rejects.toBeDefined()
    await rm(target)
    await chown(state(), 0, 1234)
    await expect(WriterLock.forRootOwnedDirectory(state()).acquire()).rejects.toBeDefined()
    await chown(state(), 0, 0)
    const mutex = join(state(), '.writer-mutex.sqlite')
    await writeFile(mutex, '', { mode: 0o660 }); await chown(mutex, 1234, 0)
    await expect(WriterLock.forRootOwnedDirectory(state()).acquire()).rejects.toBeDefined()
    expect((await lstat(mutex)).uid).toBe(1234)
    expect(await readFile(other, 'utf8')).toBe('original')
  })

  it('cleans only its own temporary file when fencing or directory identity changes', async () => {
    const target = join(state(), 'authority.json')
    await expect(atomicWriteRootOwnedJson(target, { a: 1 }, 0o640, () => { throw Error('fenced') })).rejects.toThrow('fenced')
    expect(await readdir(state())).toEqual([])
    const moved = join(root, 'moved')
    await expect(atomicWriteRootOwnedJson(target, { a: 2 }, 0o640, async () => {
      await rename(state(), moved); await mkdir(state(), { mode: 0o700 })
    })).rejects.toBeDefined()
    expect(await readdir(state())).toEqual([])
    expect(await readdir(moved)).toEqual([])
  })

  it('supports an actual root process with a non-root effective group', async () => {
    const script = `import { WriterLock } from ${JSON.stringify(new URL('./writer-lock.ts', import.meta.url).href)};
      process.setegid(1234);
      const lock = WriterLock.forRootOwnedDirectory(${JSON.stringify(state())});
      const lease = await lock.acquire();
      await lease.commitAuthority();
      await lease.release();`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(child.status, child.stderr).toBe(0)
    await metadata(join(state(), 'authority.json'), 0o640)
    await metadata(join(state(), '.writer-mutex.sqlite'), 0o660)
  })
})
