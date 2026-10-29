import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { assertPgpHome } from './account-pgp.ts'

vi.mock('node:fs/promises', () => ({ lstat: vi.fn(), readdir: vi.fn(), realpath: vi.fn() }))
const identity = { username: 'alice', home: '/home/alice', uid: 1001, gid: 1001 }
const entry = (kind = 'directory', mode = 0o700, uid = 1001, gid = 1001, nlink = 1) => ({ uid, gid, mode, nlink, isDirectory: () => kind === 'directory', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'symlink', isSocket: () => kind === 'socket' })
let entries: Record<string, ReturnType<typeof entry>>
beforeEach(() => {
  vi.resetAllMocks()
  entries = { '/home': entry('directory', 0o755, 0, 0), '/home/alice': entry(), '/home/alice/.gnupg': entry(), '/home/alice/.gnupg/pubring.kbx': entry('file', 0o600) }
  vi.mocked(lstat).mockImplementation(async path => { const value = entries[String(path)]; if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return value as never })
  vi.mocked(realpath).mockImplementation(async path => String(path))
  vi.mocked(readdir).mockImplementation(async path => Object.keys(entries).filter(name => name.startsWith(String(path) + '/') && !name.slice(String(path).length + 1).includes('/')).map(name => name.slice(String(path).length + 1)) as never)
})
describe('OpenPGP filesystem preflight', () => {
  it('accepts a private owned keyring and only permits a missing directory for version probes', async () => {
    await expect(assertPgpHome(identity)).resolves.toBeUndefined()
    delete entries['/home/alice/.gnupg']
    await expect(assertPgpHome(identity, true)).resolves.toBeUndefined()
    await expect(assertPgpHome(identity)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses symlink, realpath escape, foreign ownership, readable private files and hardlinks', async () => {
    for (const value of [entry('symlink'), entry('file', 0o644), entry('file', 0o600, 1002), entry('file', 0o600, 1001, 1002), entry('file', 0o600, 1001, 1001, 2), entry('directory', 0o750), entry('directory', 0o2700)]) {
      entries['/home/alice/.gnupg/pubring.kbx'] = value
      await expect(assertPgpHome(identity)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    }
    entries['/home/alice/.gnupg/pubring.kbx'] = entry('file', 0o600)
    vi.mocked(realpath).mockImplementation(async path => String(path).endsWith('pubring.kbx') ? '/home/bob/pubring.kbx' : String(path))
    await expect(assertPgpHome(identity)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('refuses writable parent paths and bounds traversal before visiting unbounded trees', async () => {
    entries['/home'] = entry('directory', 0o777, 0, 0)
    await expect(assertPgpHome(identity)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    entries['/home'] = entry('directory', 0o755, 0, 0)
    vi.mocked(readdir).mockResolvedValue(Array.from({ length: 4097 }, (_, index) => String(index)) as never)
    await expect(assertPgpHome(identity)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
