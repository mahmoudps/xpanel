import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The real replaceManagedFile on a private temporary directory. Root ownership and trusted
// ancestry are modeled (this run is unprivileged); inode identity, rename and read-back are real.
const { asRoot } = vi.hoisted(() => ({ asRoot: <T extends object>(stat: T): T => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
  typeof (stat as { uid?: unknown }).uid === 'bigint' ? { uid: 0n, gid: 0n } : { uid: 0, gid: 0 }) }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => asRoot(await actual.lstat(...args)),
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      return new Proxy(handle, { get: (target, key) => key === 'chown' ? async () => undefined
        : typeof Reflect.get(target, key) === 'function' ? Reflect.get(target, key).bind(target) : Reflect.get(target, key) })
    },
  }
})
vi.mock('./lifecycle-ownership.mjs', async original => {
  const actual = await original<typeof import('./lifecycle-ownership.mjs')>()
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const { createHash } = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  const stat = async (path: string) => asRoot(await fs.lstat(path, { bigint: true }))
  return { ...actual,
    requireLinuxRoot: () => undefined,
    withTrustedDirectory: async (_path: string, callback: (pin: { verify(): Promise<void> }) => unknown) => callback({ verify: async () => undefined }),
    readTrustedFile: async (path: string) => { const bytes = await fs.readFile(path); return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), info: await stat(path) } },
    assertOwnedFile: async (entry: Parameters<typeof actual.ownedFileDriftField>[0]) => {
      const field = actual.ownedFileDriftField(entry, await stat(entry.path))
      if (field) throw Object.assign(new Error('OWNED_FILE_DRIFT'), { code: 'OWNED_FILE_DRIFT', entryPath: entry.path, field })
    },
  }
})
import { assertOwnedFile } from './lifecycle-ownership.mjs'
import { replaceManagedFile } from './lifecycle-managed-files.mjs'

let dir = ''
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = '' })
const claim = async () => {
  dir = await mkdtemp(join(tmpdir(), 'xpanel-stop-journal-'))
  const path = join(dir, 'stop.json')
  return { path, claimed: await replaceManagedFile(path, Buffer.from('{"phase":"claimed"}\n'), 0o600, null, async () => undefined) }
}

describe.runIf(process.platform === 'linux')('recovery stop journal replacement', () => {
  it('an authority that pins the pre-rename journal reports OWNED_FILE_DRIFT after the rename (the recovery defect)', async () => {
    const { path, claimed } = await claim()
    await expect(replaceManagedFile(path, Buffer.from('{"phase":"quiescent"}\n'), 0o600, claimed.entry, () => assertOwnedFile(claimed.entry)))
      .rejects.toMatchObject({ code: 'OWNED_FILE_DRIFT', entryPath: path, field: 'inode' })
  })

  it('the final authority check receives the read-back replacement and verifies that identity', async () => {
    const { path, claimed } = await claim()
    let journal = claimed
    const authority = async (replaced?: typeof claimed) => { if (replaced) journal = replaced; await assertOwnedFile(journal.entry) }
    const written = await replaceManagedFile(path, Buffer.from('{"phase":"quiescent"}\n'), 0o600, journal.entry, authority)
    expect(journal).toBe(written)
    expect(written.entry.inode).not.toBe(claimed.entry.inode)
    expect(await readFile(path, 'utf8')).toBe('{"phase":"quiescent"}\n')
  })
})
