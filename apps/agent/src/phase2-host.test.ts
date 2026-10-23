import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeHostExecutor } from './executor.ts'
import {
  MAX_BACKUP_BYTES,
  assertBackupFileName,
  createAccountBackup,
  listAccountBackups,
  restoreAccountBackup,
  type BackupAccountTarget,
} from './account-backup.ts'
import { parseDf, parseLoadavg, parseMeminfo } from './host-info.ts'
import { readHostServices, restartHostService, type HostCommandResult } from './host-services.ts'

const account: BackupAccountTarget = { username: 'alice', home: '/home/alice', uid: 20014, status: 'active' }
const stamp = new Date('2026-10-23T16:53:00.000Z')
const archiveName = 'xpanel-backup-alice-20261023T165300Z.tar.gz'
const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const command = (stdout: string, ok = true): HostCommandResult => ({ ok, stdout, stderr: ok ? '' : stdout })

describe('host measurements', () => {
  it('reads load, memory and one POSIX df row', () => {
    expect(parseLoadavg('0.15 0.20 0.25 1/120 9\n')).toEqual({ load1: 0.15, load5: 0.2, load15: 0.25 })
    expect(parseMeminfo('MemTotal:        1024 kB\nMemFree:          100 kB\nMemAvailable:     512 kB\n')).toEqual({ totalBytes: 1024 * 1024, availableBytes: 512 * 1024 })
    expect(parseDf('Filesystem 1B-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /\n')).toEqual({
      filesystem: '/dev/sda1', mount: '/', totalBytes: 1000, usedBytes: 400, availableBytes: 600,
    })
  })

  it('refuses unreadable figures', () => {
    expect(() => parseLoadavg('not-a-load')).toThrow(/load average is unreadable/)
    expect(() => parseMeminfo('MemTotal: 10 kB\n')).toThrow(/memory figures are unreadable/)
    expect(() => parseDf('Filesystem 1B-blocks\n')).toThrow(/disk figures are unreadable/)
  })
})

describe('host services', () => {
  it('reports the loaded unit and refuses anything outside the allowlist', async () => {
    const calls: string[][] = []
    const run = async (argv: string[]): Promise<HostCommandResult> => {
      calls.push(argv)
      const unit = argv.at(-1) ?? ''
      if (argv[1] === 'show') {
        if (unit === 'httpd.service') return command('loaded\nfailed\n')
        if (unit === 'mariadb.service') return command('loaded\nactive\n')
        return command('not-found\ninactive\n')
      }
      return command('systemctl restart failed', false)
    }
    const rows = await readHostServices(run)
    expect(rows.find(row => row.id === 'apache')).toEqual({ id: 'apache', label: 'Apache', unit: 'httpd.service', state: 'failed' })
    expect(rows.find(row => row.id === 'mariadb')).toMatchObject({ unit: 'mariadb.service', state: 'active' })
    expect(rows.find(row => row.id === 'pdns')).toMatchObject({ unit: null, state: 'not-installed' })
    await expect(restartHostService(run, 'sshd')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(calls.some(argv => argv.includes('sshd'))).toBe(false)
    await expect(restartHostService(run, 'pdns')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'PowerDNS is not installed on this server' })
    await expect(restartHostService(run, 'apache')).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', message: 'Apache did not restart (systemctl restart failed)' })
  })
})

describe('account backups', () => {
  it('refuses a home, uid, name or archive member outside the account', async () => {
    const executor = new FakeHostExecutor()
    await expect(createAccountBackup({ executor, account: { ...account, home: '/tmp/alice' }, readSize: async () => 1 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(createAccountBackup({ executor, account: { ...account, uid: 19999 }, readSize: async () => 1 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(createAccountBackup({ executor, account: { ...account, status: 'terminating' }, readSize: async () => 1 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(() => assertBackupFileName('alice', '../xpanel-backup-alice-20261023T165300Z.tar.gz')).toThrow(/backup file name is invalid/)
    expect(() => assertBackupFileName('alice', 'xpanel-backup-bob-20261023T165300Z.tar.gz')).toThrow(/backup file name is invalid/)
    executor.failCommand('/usr/bin/tar', 0, '', '/etc/passwd\n')
    await expect(restoreAccountBackup({ executor, account, file: archiveName, root: '/var/lib/xpanel/backups' })).rejects.toMatchObject({
      code: 'VALIDATION', message: 'the archive contains a path outside the account home',
    })
    expect(executor.executedActions.some(action => action.kind === 'exec' && action.argv[1] === '--extract')).toBe(false)
  })

  it('archives as the account user, caps the size, and restores only after the member list is safe', async () => {
    const executor = new FakeHostExecutor()
    await expect(createAccountBackup({ executor, account, now: stamp })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'the backup archive size could not be read' })
    const created = await createAccountBackup({ executor, account, now: stamp, root: '/var/lib/xpanel/backups', readSize: async () => 100 })
    expect(created).toEqual({ file: archiveName, bytes: 100 })
    const tar = executor.executedActions.find(action => action.kind === 'exec' && action.argv[0] === '/usr/bin/tar' && action.argv.includes('--create'))
    expect(tar).toMatchObject({ kind: 'exec', runAsUser: 'alice' })
    expect(executor.executedActions.some(action => action.kind === 'remove-path' && action.path === '/home/alice/.xpanel-backup-20261023T165300Z.tar.gz')).toBe(true)
    executor.executedActions.length = 0
    await expect(createAccountBackup({ executor, account, now: stamp, readSize: async () => MAX_BACKUP_BYTES + 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    executor.clearCommandFailures()
    executor.failCommand('/usr/bin/tar', 0, '', 'public_html/index.html\n')
    await expect(restoreAccountBackup({ executor, account, file: archiveName })).resolves.toEqual({ file: archiveName })
    const extract = executor.executedActions.find(action => action.kind === 'exec' && action.argv.includes('--extract'))
    expect(extract).toMatchObject({ kind: 'exec', runAsUser: 'alice' })
  })

  it('lists only regular archives named for that account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xpanel-backup-'))
    roots.push(root)
    await mkdir(join(root, 'alice'), { recursive: true })
    await writeFile(join(root, 'alice', archiveName), 'archive')
    await writeFile(join(root, 'alice', 'notes.txt'), 'nope')
    await mkdir(join(root, 'alice', 'xpanel-backup-alice-20261023T165301Z.tar.gz'))
    await expect(listAccountBackups(root, account)).resolves.toEqual([{ file: archiveName, bytes: 7 }])
    await expect(listAccountBackups(root, { ...account, username: 'bob', home: '/home/bob' })).resolves.toEqual([])
  })
})
