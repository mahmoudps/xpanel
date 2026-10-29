import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backupDestinationTargetDigest } from '../../../packages/core/src/backup-destination.ts'
import type { BackupDestinationTarget } from '../../../packages/core/src/backup-destination.ts'
import { probeBackupDestination } from './backup-destination.ts'
import { createLocalDiskBackupProvider, LOCAL_DISK_PROFILE, localDiskDirectory } from './acct-backup-local.ts'
import { createSftpBackupCredential, listBackupCredentials } from './acct-backup-credentials.ts'
import type { BackupCredentialStore } from './acct-backup-credentials.ts'
import type { StoredCredential } from './acct-backup-s3.ts'
import type { BackupCommand } from './backup-low-priority.ts'

// Real temporary directories stand in for a separate disk; the device check is the one thing a single test filesystem cannot show.
const ID = '11111111-1111-4111-8111-111111111111'
const target = (pathPrefix: string): BackupDestinationTarget => ({ id: ID, name: 'Second disk', kind: 'local', endpoint: pathPrefix, bucket: null, region: null, pathPrefix, username: null, retentionDays: 30, createdAt: '2026-10-01T00:00:00.000Z', credentialRef: 'local-disk' })
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) if (basename(root).startsWith('xpanel-local-disk-')) await rm(root, { recursive: true, force: true }) })
const temp = async (): Promise<string> => { const root = await mkdtemp(join(tmpdir(), 'xpanel-local-disk-')); roots.push(root); return root }

describe('separate local disk destination', () => {
  it('accepts only an absolute directory outside system and panel trees', () => {
    expect(localDiskDirectory(target('/mnt/backup/xpanel'))).toBe('/mnt/backup/xpanel')
    for (const path of ['backup', '/', '/etc/xpanel', '/home/alice', '/var/lib/xpanel/backups', '/mnt/../etc', '/mnt/b c', '/proc/1']) expect(() => localDiskDirectory(target(path))).toThrow()
    expect(() => localDiskDirectory({ ...target('/mnt/backup'), credentialRef: 'vault' })).toThrow()
  })
  it('refuses a directory on the same filesystem as the archive store', async () => {
    const disk = await temp(), store = await temp()
    const destination = { ...target('/mnt/x'), pathPrefix: disk }
    const provider = createLocalDiskBackupProvider({ readDestination: async () => destination, archiveRoot: store })
    const binding = { destinationId: ID, targetDigest: backupDestinationTargetDigest(destination), credentialRef: 'local-disk', credentialRevision: LOCAL_DISK_PROFILE.revision }
    // Windows temp paths are not absolute POSIX paths, so the saved-directory check refuses before the device check on that platform.
    await expect(provider.open(binding, AbortSignal.timeout(1000))).rejects.toThrow()
  })
  it.runIf(process.platform === 'linux')('passes the probe and moves archives on a directory of another filesystem (lab host with /dev/shm)', async () => {
    const disk = join('/dev/shm', 'xpanel-local-disk-test-' + process.pid), store = await temp()
    await mkdir(disk, { recursive: true })
    try {
      const destination = { ...target('/mnt/x'), pathPrefix: disk }
      if ((await stat(disk)).dev === (await stat(store)).dev || process.getuid?.() !== 0) return
      const provider = createLocalDiskBackupProvider({ readDestination: async () => destination, archiveRoot: store })
      expect(await probeBackupDestination(destination, provider, async () => undefined)).toMatchObject({ outcome: 'verified', cleanupVerified: true })
      const session = await provider.open({ destinationId: ID, targetDigest: backupDestinationTargetDigest(destination), credentialRef: 'local-disk', credentialRevision: LOCAL_DISK_PROFILE.revision }, AbortSignal.timeout(1000))
      const bytes = Buffer.from('archive'), name = 'alice/xpanel-backup-alice-20261028T020000Z.tar.gz'
      await session.putArchive(name, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), chunks: async function* () { yield bytes } }, AbortSignal.timeout(1000))
      expect(await session.listArchives(AbortSignal.timeout(1000))).toEqual([{ name, bytes: bytes.length, lastModified: '2026-10-28T02:00:00.000Z' }])
      expect(await session.space!(AbortSignal.timeout(1000))).toMatchObject({ freeBytes: expect.any(Number) })
      await session.deleteArchive(name, AbortSignal.timeout(1000))
      expect(await readdir(join(disk, 'alice'))).toEqual([])
    } finally { await rm(disk, { recursive: true, force: true }) }
  })
})

describe('SFTP key pair creation', () => {
  const setup = async (stored: StoredCredential[] = []) => {
    const root = await temp(), keyDir = join(root, 'keys')
    let raw: unknown = stored.length ? { version: 1, profiles: [] } : null, profiles = [...stored]
    const run = vi.fn(async (command: BackupCommand) => {
      const keyPath = command.argv[command.argv.indexOf('-f') + 1]!
      await writeFile(keyPath + '.pub', 'ssh-ed25519 ' + 'A'.repeat(68) + ' xpanel-backup-vault\n')
      return { ok: true, code: 0, stdout: '', stderr: '', stdoutBytes: 0, killed: null }
    })
    const store: BackupCredentialStore = { path: join(root, 'credentials.json'), keyDir, run,
      read: async () => profiles, readRaw: async () => raw,
      write: async value => { raw = value; profiles = (value as { profiles: { ref: string; label: string; privateKeyPath: string }[] }).profiles.map(item => ({ profile: { ref: item.ref, label: item.label, kinds: ['sftp'], revision: 'c'.repeat(64) }, privateKeyPath: item.privateKeyPath })) },
      readPublicKey: async path => { try { const text = (await import('node:fs/promises')).readFile(path + '.pub', 'utf8'); return (await text).trim() } catch { return null } } }
    return { store, run, raw: () => raw, keyDir }
  }
  it('creates an ed25519 key pair without a passphrase in the key directory and returns only the public key', async () => {
    const t = await setup()
    const created = await createSftpBackupCredential(t.store, { ref: 'vault', label: 'Vault key' })
    expect(created).toEqual({ ref: 'vault', label: 'Vault key', kinds: ['sftp'], revision: 'c'.repeat(64), publicKey: 'ssh-ed25519 ' + 'A'.repeat(68) + ' xpanel-backup-vault' })
    expect(t.run.mock.calls[0]![0].argv).toEqual(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'xpanel-backup-vault', '-f', t.keyDir + '/vault'])
    expect(t.raw()).toEqual({ version: 1, profiles: [{ ref: 'vault', label: 'Vault key', kinds: ['sftp'], privateKeyPath: t.keyDir + '/vault' }] })
    expect(JSON.stringify(created)).not.toContain('PRIVATE')
    expect((await listBackupCredentials(t.store)).map(item => item.ref)).toEqual(['local-disk', 'vault'])
  })
  it('refuses reserved, repeated and malformed names before any key is made', async () => {
    const t = await setup([{ profile: { ref: 'vault', label: 'Vault', kinds: ['sftp'], revision: 'c'.repeat(64) }, privateKeyPath: '/etc/xpanel/backup-keys/vault' }])
    for (const input of [{ ref: 'local-disk', label: 'x' }, { ref: '../root', label: 'x' }, { ref: 'Vault', label: 'x' }, { ref: 'ok', label: '' }, { ref: 'ok', label: 'a\nb' }])
      await expect(createSftpBackupCredential(t.store, input)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(createSftpBackupCredential(t.store, { ref: 'vault', label: 'Again' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(t.run).not.toHaveBeenCalled()
  })
})
