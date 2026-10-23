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
import { readHostConfigChecks, readHostIdentity } from './host-identity.ts'
import { parseApacheVersion, parseDf, parseKernelRelease, parseLoadavg, parseMeminfo, parseNginxVersion, parseOsRelease, parsePackageVersion, parseProcUptime } from './host-info.ts'
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

  it('reads the operating system, kernel, uptime and engine only from the probed text', async () => {
    expect(parseOsRelease('NAME="Debian GNU/Linux"\nVERSION="12 (bookworm)"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n')).toBe('Debian GNU/Linux 12 (bookworm)')
    expect(parseOsRelease('PRETTY_NAME="bad\\nname"\n')).toBeNull()
    expect(parseProcUptime('3564000.50 10.0\n')).toBe(3564000)
    expect(parseProcUptime('nope')).toBeNull()
    expect(parseKernelRelease('6.8.0-45-generic\n')).toBe('6.8.0-45-generic')
    expect(parseKernelRelease('6.8.0;rm\n')).toBeNull()
    expect(parseNginxVersion('nginx version: nginx/1.24.0\n')).toBe('1.24.0')
    expect(parseApacheVersion('Server version: Apache/2.4.58 (Debian)\n')).toBe('2.4.58')
    expect(parsePackageVersion('{"version":"0.1.0"}')).toBe('0.1.0')
    expect(parsePackageVersion('{"version":"0.1.0-audit-ar.20261024.1"}')).toBe('0.1.0-audit-ar.20261024.1')
    expect(parsePackageVersion('{"version":"../etc"}')).toBeNull()
    const calls: string[][] = []
    const identity = await readHostIdentity({
      readFile: async (path) => {
        if (path === '/etc/os-release') return 'PRETTY_NAME="Debian GNU/Linux 12"\n'
        if (path === '/proc/uptime') return '3564000.10 1\n'
        return null
      },
      runCommand: async (argv) => {
        calls.push(argv)
        const bin = argv[0] ?? ''
        if (bin.endsWith('/uname')) return { ok: true, stdout: '6.1.0-lab\n', stderr: '' }
        if (bin.endsWith('/nginx')) return { ok: bin.startsWith('/usr/sbin/'), stdout: '', stderr: 'nginx version: nginx/1.24.0\n' }
        if (bin.endsWith('/apache2')) return { ok: false, stdout: '', stderr: 'not found' }
        if (bin.endsWith('/httpd')) return { ok: true, stdout: 'Server version: Apache/2.4.58\n', stderr: '' }
        return { ok: false, stdout: '', stderr: '' }
      },
    })
    expect(identity.system).toBe('Debian GNU/Linux 12')
    expect(identity.kernel).toBe('6.1.0-lab')
    expect(identity.uptimeSeconds).toBe(3564000)
    expect(identity.engine).toBe('nginx 1.24.0 → httpd 2.4.58')
    expect(identity.version).toBe('0.1.0')
    expect(identity.hostname).toBeUndefined()
    expect(identity.cores).toBeUndefined()
    expect(calls.every(argv => argv.every(arg => /^[A-Za-z0-9@+=:./_-]+$/.test(arg)))).toBe(true)
    const missing = await readHostIdentity({
      readFile: async () => null,
      runCommand: async () => { throw new Error('denied') },
    })
    expect(missing.system).toBeUndefined()
    expect(missing.kernel).toBeUndefined()
    expect(missing.engine).toBeUndefined()
    expect(missing.version).toBe('0.1.0')
  })

  it('records nginx -t and apachectl configtest without failing when a binary is missing', async () => {
    const seen: string[][] = []
    const checks = await readHostConfigChecks({
      readFile: async () => null,
      runCommand: async (argv) => {
        seen.push(argv)
        const bin = argv[0] ?? ''
        if (bin.endsWith('/nginx') && argv[1] === '-t') return { ok: true, stdout: '', stderr: 'syntax is ok\n' }
        return { ok: false, stdout: '', stderr: 'spawn ENOENT' }
      },
    }, new Date('2026-10-23T13:48:00.000Z'))
    expect(checks.nginx).toEqual({ ok: true, at: '2026-10-23T13:48:00.000Z' })
    expect(checks.apache).toBeUndefined()
    expect(seen.some(argv => argv[0] === '/usr/sbin/nginx' && argv[1] === '-t')).toBe(true)
    expect(seen.some(argv => argv[1] === 'configtest')).toBe(true)
    expect(seen.every(argv => argv.every(arg => /^[A-Za-z0-9@+=:./_-]+$/.test(arg)))).toBe(true)
    const failed = await readHostConfigChecks({
      readFile: async () => null,
      runCommand: async (argv) => ({ ok: argv[1] !== 'configtest', stdout: '', stderr: argv[1] === 'configtest' ? 'AH00526: Syntax error\n' : '' }),
    }, new Date('2026-10-23T13:48:00.000Z'))
    expect(failed.nginx?.ok).toBe(true)
    expect(failed.apache?.ok).toBe(false)
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
    const unchecked = await readHostServices(async () => command('systemctl missing', false))
    expect(unchecked.every(row => row.state === 'unchecked' && row.unit === null)).toBe(true)
    await expect(restartHostService(run, 'sshd')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(calls.some(argv => argv.includes('sshd'))).toBe(false)
    await expect(restartHostService(run, 'pdns')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'PowerDNS is not installed on this server' })
    await expect(restartHostService(run, 'apache')).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', message: 'Apache did not restart (systemctl restart failed)' })
  })

  it('prefers the active PHP-FPM unit and reports nginx, redis, and postgresql from systemctl', async () => {
    const run = async (argv: string[]): Promise<HostCommandResult> => {
      const unit = argv.at(-1) ?? ''
      if (unit === 'nginx.service') return command('loaded\nactive\n')
      if (unit === 'php8.3-fpm.service') return command('not-found\ninactive\n')
      if (unit === 'php8.1-fpm.service') return command('loaded\nactive\n')
      if (unit === 'redis-server.service') return command('loaded\ninactive\n')
      if (unit === 'postgresql.service') return command('not-found\ninactive\n')
      return command('not-found\ninactive\n')
    }
    const rows = await readHostServices(run)
    expect(rows.find(row => row.id === 'nginx')).toMatchObject({ unit: 'nginx.service', state: 'active' })
    expect(rows.find(row => row.id === 'php-fpm')).toMatchObject({ label: 'PHP-FPM', unit: 'php8.1-fpm.service', state: 'active' })
    expect(rows.find(row => row.id === 'redis')).toMatchObject({ unit: 'redis-server.service', state: 'inactive' })
    expect(rows.find(row => row.id === 'postgresql')).toMatchObject({ unit: null, state: 'not-installed' })
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
