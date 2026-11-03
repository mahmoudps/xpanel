import { mkdtemp, lstat, mkdir, chmod, readFile, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureManagedFile, ensureManagedPrivateDirectory, replaceManagedFile } from './lifecycle-managed-files.mjs'

// These filesystem regressions require actual Linux root. They are not native service acceptance.
const supported = process.platform === 'linux' && process.getuid?.() === 0 && process.geteuid?.() === 0
const roots: string[] = []
const fixture = async () => { const path = await mkdtemp('/root/xpanel-managed-file-test-'); roots.push(path); return path }
const authority = async () => { if (!supported) throw new Error('actual Linux root required') }
afterEach(async () => {
  for (const path of roots.splice(0)) {
    const checked = resolve(path)
    if (!checked.startsWith('/root/xpanel-managed-file-test-') || checked === '/root') throw new Error('test cleanup escaped its exact fixture')
    await rm(checked, { recursive: true, force: false })
  }
})

describe.skipIf(!supported)('real descriptor metadata under restrictive service umask', () => {
  it('publishes a 0644 barrier even under coordinator UMask=0077 and reads back its actual inode', async () => {
    const root = await fixture(), path = join(root, 'writer-barrier.json'), before = process.umask(0o077)
    try {
      const written = await replaceManagedFile(path, Buffer.from('{"phase":"pending"}\n'), 0o644, null, authority)
      const actual = await lstat(path, { bigint: true })
      expect(Number(actual.mode & 0o7777n)).toBe(0o644)
      expect(actual.uid).toBe(0n); expect(actual.gid).toBe(0n)
      expect(written.entry.inode).toBe(String(actual.ino))
      expect((await captureManagedFile(path)).entry.sha256).toBe(written.entry.sha256)
      expect(await readFile(path, 'utf8')).toBe('{"phase":"pending"}\n')
    } finally { process.umask(before) }
  })
  it('creates a missing terminal directory as root:root 0700 and never repairs a foreign existing directory', async () => {
    const root = await fixture(), terminal = join(root, 'terminal')
    expect((await ensureManagedPrivateDirectory(terminal, authority)).created).toBe(true)
    expect((await ensureManagedPrivateDirectory(terminal, authority)).created).toBe(false)
    expect(Number((await lstat(terminal)).mode & 0o7777)).toBe(0o700)
    const foreign = join(root, 'foreign'); await mkdir(foreign, { mode: 0o755 }); await chmod(foreign, 0o755)
    await expect(ensureManagedPrivateDirectory(foreign, authority)).rejects.toThrow('MANAGED_DIRECTORY_UNTRUSTED')
    expect(Number((await lstat(foreign)).mode & 0o7777)).toBe(0o755)
  })
  it('preserves a foreign terminal symlink and refuses a stale metadata inode', async () => {
    const root = await fixture(), target = join(root, 'target'), terminal = join(root, 'terminal')
    await mkdir(target, { mode: 0o700 }); await symlink(target, terminal)
    await expect(ensureManagedPrivateDirectory(terminal, authority)).rejects.toThrow()
    expect((await lstat(terminal)).isSymbolicLink()).toBe(true)
    const path = join(root, 'record.json'), old = await replaceManagedFile(path, Buffer.from('old\n'), 0o600, null, authority)
    await replaceManagedFile(path, Buffer.from('next\n'), 0o600, old.entry, authority)
    await expect(replaceManagedFile(path, Buffer.from('unsafe\n'), 0o600, old.entry, authority)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('next\n')
  })
})
