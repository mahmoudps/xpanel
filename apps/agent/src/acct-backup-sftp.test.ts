import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, posix } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backupDestinationTargetDigest } from '../../../packages/core/src/backup-destination.ts'
import type { BackupDestinationTarget } from '../../../packages/core/src/backup-destination.ts'
import { probeBackupDestination } from './backup-destination.ts'
import { readBackupCredentialFile } from './acct-backup-s3.ts'
import type { BackupTransferProvider, StoredCredential } from './acct-backup-s3.ts'
import { createBackupTransportProvider, createSftpBackupProvider, readSftpArchives, readSftpNames, readSftpSpace, sftpArgv, sftpDestinationBinding } from './acct-backup-sftp.ts'
import { LOCAL_DISK_PROFILE } from './acct-backup-local.ts'
import type { BackupCommand, BackupCommandResult } from './backup-low-priority.ts'

// A fake sftp(1) batch interpreter over an in-memory remote tree: it checks the commands and options the provider sends,
// not OpenSSH or a real SFTP server.
const ID = '11111111-1111-4111-8111-111111111111', REVISION = 'c'.repeat(64)
const target: BackupDestinationTarget = { id: ID, name: 'Vault', kind: 'sftp', endpoint: 'sftp://vault.xpanel.test:2222', bucket: null, region: null, pathPrefix: '/backups/daily', username: 'xpanel', retentionDays: 30, createdAt: '2026-10-01T00:00:00.000Z', credentialRef: 'vault' }
const credential: StoredCredential = { profile: { ref: 'vault', label: 'Vault key', kinds: ['sftp'], revision: REVISION }, privateKeyPath: '/etc/xpanel/backup-keys/vault' }
const FILE = 'alice/xpanel-backup-alice-20261028T020000Z.tar.gz'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) if (basename(root).startsWith('xpanel-sftp-')) await rm(root, { recursive: true, force: true }) })

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'xpanel-sftp-')); roots.push(root)
  const remote = new Map<string, Buffer>(), calls: BackupCommand[] = []
  const run = vi.fn(async (command: BackupCommand): Promise<BackupCommandResult> => {
    calls.push(command)
    let stdout = '', stderr = '', ok = true
    for (const line of command.stdinText!.trim().split('\n')) {
      const soft = line.startsWith('-'), text = soft ? line.slice(1) : line, args = [...text.matchAll(/"([^"]*)"/g)].map(match => match[1]!), op = text.split(' ')[0]
      stdout += 'sftp> ' + line + '\n'
      let failed = false
      if (op === 'put') remote.set(args[1]!, await readFile(args[0]!))
      else if (op === 'rename') { const bytes = remote.get(args[0]!); if (bytes) { remote.set(args[1]!, bytes); remote.delete(args[0]!) } else failed = true }
      else if (op === 'get') { const bytes = remote.get(args[0]!); if (bytes) await writeFile(args[1]!, bytes); else { failed = true; stderr += `File "${args[0]}" not found.\n` } }
      else if (op === 'rm') failed = !remote.delete(args[0]!)
      else if (text.startsWith('ls -1')) {
        const children = new Set([...remote.keys()].filter(key => key.startsWith(args[0] + '/')).map(key => key.slice(args[0]!.length + 1).split('/')[0]!))
        if (children.size) stdout += [...children].map(child => args[0] + '/' + child).join('\n') + '\n'; else { failed = true; stderr += `Can't ls: "${args[0]}" not found\n` }
      } else if (text.startsWith('ls -ln')) for (const [key, bytes] of remote) if (posix.dirname(key) === args[0]) stdout += `-rw-------    ? 1000     1000     ${bytes.length} Oct 28 02:00 ${key}\n`
      if (failed && !soft) { ok = false; break }
    }
    return { ok, code: ok ? 0 : 1, stdout, stderr, stdoutBytes: stdout.length, killed: null }
  })
  let creds = [credential]
  const provider = createSftpBackupProvider({ readDestination: async id => id === ID ? target : null, readCredentials: async () => creds, run, knownHostsDir: join(root, 'known'), transferDir: join(root, 'transfer') })
  const binding = { destinationId: ID, targetDigest: backupDestinationTargetDigest(target), credentialRef: 'vault', credentialRevision: REVISION }
  return { root, remote, calls, run, provider, binding, rotate: () => { creds = [{ ...credential, profile: { ...credential.profile, revision: 'd'.repeat(64) } }] } }
}

describe('SFTP destination binding and options', () => {
  it('connects only to a saved host, port, login and absolute segment-confined directory', () => {
    expect(sftpDestinationBinding(target)).toEqual({ host: 'vault.xpanel.test', port: 2222, user: 'xpanel', prefix: '/backups/daily' })
    expect(sftpDestinationBinding({ ...target, endpoint: 'sftp://[2001:db8::7]' }).port).toBe(22)
    for (const change of [{ endpoint: 'sftp://vault.xpanel.test/home' }, { endpoint: 'sftp://root:pw@vault.xpanel.test' }, { endpoint: 'https://vault.xpanel.test' }, { endpoint: 'sftp://vault.xpanel.test?x=1' },
      { pathPrefix: 'backups' }, { pathPrefix: '/backups/../etc' }, { pathPrefix: '/back ups' }, { username: null }, { username: '-oProxyCommand=x' }, { kind: 's3' as const }])
      expect(() => sftpDestinationBinding({ ...target, ...change })).toThrow()
  })
  it('uses the key only, refuses agents and forwarding and pins the host key per target', () => {
    const argv = sftpArgv({ host: 'vault.xpanel.test', port: 2222, user: 'xpanel', keyPath: '/etc/xpanel/backup-keys/vault', knownHosts: '/var/lib/xpanel/backup-known-hosts/' + 'e'.repeat(64) })
    expect(argv.slice(0, 5)).toEqual(['/usr/bin/sftp', '-F', '/dev/null', '-b', '-'])
    expect(argv.slice(-3)).toEqual(['2222', '--', 'xpanel@vault.xpanel.test'])
    for (const option of ['BatchMode=yes', 'IdentitiesOnly=yes', 'StrictHostKeyChecking=accept-new', 'GlobalKnownHostsFile=/dev/null', 'PasswordAuthentication=no', 'ForwardAgent=no', 'ClearAllForwardings=yes', 'UserKnownHostsFile=/var/lib/xpanel/backup-known-hosts/' + 'e'.repeat(64)])
      expect(argv).toContain(option)
  })
  it('parses directory listings and ignores echoed batch lines and foreign names', () => {
    expect(readSftpNames('sftp> ls -1 "/b"\n/b/alice\n/b/.xpanel-probe\n/b/Bob\nbob\n')).toEqual(['alice', 'bob'])
    expect(readSftpNames('/b/_control\n')).toEqual(['_control'])
    expect(readSftpSpace('sftp> df "/b"\n        Size         Used        Avail       (root)    %Capacity\n  3906250000   200000000   3706250000   3706250000          5%\n')).toEqual({ freeBytes: 3706250000 * 1024, totalBytes: 3906250000 * 1024 })
    expect(readSftpSpace('sftp> df "/b"\nServer does not support statvfs@openssh.com extension\n')).toBeNull()
    const listing = 'sftp> -ls -ln "/b/alice"\n-rw-------    ? 0 0 7 Oct 28 02:00 /b/alice/xpanel-backup-alice-20261028T020000Z.tar.gz\ndrwx------    ? 0 0 4096 Oct 28 02:00 /b/alice/dir\n'
      + 'sftp> -ls -ln "/b/bob"\n-rw-------    ? 0 0 9 Oct 28 02:00 xpanel-backup-bob-20261027T020000Z.tar.gz\n-rw-------    ? 0 0 9 Oct 28 02:00 xpanel-backup-alice-20261027T020000Z.tar.gz\n'
    expect(readSftpArchives(listing)).toEqual([{ name: FILE, bytes: 7, lastModified: '2026-10-28T02:00:00.000Z' }, { name: 'bob/xpanel-backup-bob-20261027T020000Z.tar.gz', bytes: 9, lastModified: '2026-10-27T02:00:00.000Z' }])
  })
})

describe('SFTP transport sessions', () => {
  it('passes the destination test probe: write, read back, delete and confirm it is gone', async () => {
    const t = await setup()
    const result = await probeBackupDestination(target, t.provider, async () => undefined)
    expect(result).toMatchObject({ destinationId: ID, outcome: 'verified', cleanupVerified: true, verificationRequired: false })
    expect(t.remote.size).toBe(0)
    expect(t.calls[0]!.argv).toContain('IdentityFile=/etc/xpanel/backup-keys/vault')
    expect(t.calls[0]!.argv).toContain('UserKnownHostsFile=' + posix.join(join(t.root, 'known'), backupDestinationTargetDigest(target)))
  })
  it('uploads to a unique part name, renames it into place, reads it back, lists and deletes it', async () => {
    const t = await setup(), local = join(t.root, 'archive.tar.gz'), bytes = Buffer.from('archive bytes')
    await writeFile(local, bytes)
    const session = await t.provider.open(t.binding, AbortSignal.timeout(1000))
    await session.putArchive(FILE, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), path: local, chunks: async function* () { yield bytes } }, AbortSignal.timeout(1000))
    const upload = t.calls.at(-1)!.stdinText!
    expect(upload).toMatch(/^-mkdir "\/backups"\n-mkdir "\/backups\/daily"\n-mkdir "\/backups\/daily\/alice"\nput ".+archive\.tar\.gz" "\/backups\/daily\/alice\/xpanel-backup-alice-20261028T020000Z\.tar\.gz\.part-[0-9a-f-]{36}"\nrename "[^"]+\.part-[0-9a-f-]{36}" "\/backups\/daily\/alice\/xpanel-backup-alice-20261028T020000Z\.tar\.gz"\n$/)
    expect([...t.remote.keys()]).toEqual(['/backups/daily/' + FILE])
    const parts: Uint8Array[] = []
    for await (const chunk of (await session.readArchive(FILE, bytes.length, AbortSignal.timeout(1000)))!) parts.push(chunk)
    expect(Buffer.concat(parts)).toEqual(bytes)
    expect(await readdir(join(t.root, 'transfer'))).toEqual([])
    await expect(session.readArchive(FILE, 3, AbortSignal.timeout(1000))).rejects.toThrow('remote_response_limit')
    expect(await session.readArchive('alice/xpanel-backup-alice-20261027T020000Z.tar.gz', 100, AbortSignal.timeout(1000))).toBeNull()
    expect(await session.listArchives(AbortSignal.timeout(1000))).toEqual([{ name: FILE, bytes: bytes.length, lastModified: '2026-10-28T02:00:00.000Z' }])
    await session.deleteArchive(FILE, AbortSignal.timeout(1000))
    expect(t.remote.size).toBe(0)
    expect(await session.listArchives(AbortSignal.timeout(1000))).toEqual([])
    await expect(session.putArchive('../etc/passwd', { bytes: 1, sha256: 'a'.repeat(64), path: local, chunks: async function* () {} }, AbortSignal.timeout(1000))).rejects.toThrow('invalid_remote_archive_name')
  })
  it('refuses a session when the key was rotated or the destination changed after verification', async () => {
    const t = await setup()
    await expect(t.provider.open({ ...t.binding, targetDigest: 'f'.repeat(64) }, AbortSignal.timeout(1000))).rejects.toThrow('backup_destination_binding_changed')
    t.rotate()
    await expect(t.provider.open(t.binding, AbortSignal.timeout(1000))).rejects.toThrow('backup_destination_binding_changed')
    expect(t.run).not.toHaveBeenCalled()
  })
})

describe('transport selection and SFTP credentials', () => {
  it('opens sessions by the saved destination kind and lists every credential profile once', async () => {
    const s3: BackupTransferProvider = { profiles: async () => [], open: vi.fn(async () => { throw new Error('s3') }) }
    const sftp: BackupTransferProvider = { profiles: async () => [], open: vi.fn(async () => { throw new Error('sftp') }) }
    const s3Target = { ...target, id: '22222222-2222-4222-8222-222222222222', kind: 's3' as const }
    const local: BackupTransferProvider = { profiles: async () => [LOCAL_DISK_PROFILE], open: vi.fn(async () => { throw new Error('local') }) }
    const localTarget = { ...target, id: '33333333-3333-4333-8333-333333333333', kind: 'local' as const }
    const provider = createBackupTransportProvider({ readDestination: async id => [target, s3Target, localTarget].find(item => item.id === id) ?? null, readCredentials: async () => [credential], archiveRoot: '/backups', s3, sftp, local })
    expect(await provider.profiles(AbortSignal.timeout(1000))).toEqual([LOCAL_DISK_PROFILE, credential.profile])
    await expect(provider.open({ destinationId: localTarget.id, targetDigest: '', credentialRef: 'local-disk', credentialRevision: REVISION }, AbortSignal.timeout(1000))).rejects.toThrow('local')
    await expect(provider.open({ ...{ destinationId: ID, targetDigest: '', credentialRef: 'vault', credentialRevision: REVISION } }, AbortSignal.timeout(1000))).rejects.toThrow('sftp')
    await expect(provider.open({ destinationId: s3Target.id, targetDigest: '', credentialRef: 'vault', credentialRevision: REVISION }, AbortSignal.timeout(1000))).rejects.toThrow('s3')
  })
  it('reads an SFTP profile that names a private root-only key in the key directory, revised when the key changes', async () => {
    let key = 'key-one'
    const files: Record<string, { mode: number; uid: number; content: () => string }> = {
      '/x': { mode: 0o100600, uid: 0, content: () => JSON.stringify({ version: 1, profiles: [{ ref: 'vault', label: 'Vault key', kinds: ['sftp'], privateKeyPath: '/etc/xpanel/backup-keys/vault' }] }) },
      '/etc/xpanel/backup-keys/vault': { mode: 0o100600, uid: 0, content: () => key },
    }
    const io = { lstat: async (path: string) => ({ isFile: () => true, isSymbolicLink: () => false, mode: files[path]!.mode, uid: files[path]!.uid, size: 10 }), readFile: async (path: string) => files[path]!.content() } as never
    const [first] = await readBackupCredentialFile('/x', io)
    expect(first).toMatchObject({ profile: { ref: 'vault', kinds: ['sftp'] }, privateKeyPath: '/etc/xpanel/backup-keys/vault' })
    expect(JSON.stringify(first)).not.toContain('key-one')
    key = 'key-two'
    expect((await readBackupCredentialFile('/x', io))[0]!.profile.revision).not.toBe(first!.profile.revision)
    files['/etc/xpanel/backup-keys/vault']!.mode = 0o100644
    await expect(readBackupCredentialFile('/x', io)).rejects.toThrow()
    files['/etc/xpanel/backup-keys/vault']!.mode = 0o100600
    for (const privateKeyPath of ['/root/.ssh/id_ed25519', '/etc/xpanel/backup-keys/../shadow', '/etc/xpanel/backup-keys/a/b']) {
      files['/x']!.content = () => JSON.stringify({ version: 1, profiles: [{ ref: 'vault', label: 'Vault key', kinds: ['sftp'], privateKeyPath }] })
      await expect(readBackupCredentialFile('/x', io)).rejects.toThrow()
    }
  })
})
