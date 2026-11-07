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
import { profileFor, serviceConfigTest } from '@xpanel/os'
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

const debian = profileFor('ID=ubuntu\nVERSION_ID=24.04'), el = profileFor('ID=almalinux\nVERSION_ID=9.4')
const FPM_UNITS = ['php8.3-fpm.service loaded inactive dead PHP 8.3 FastCGI', 'xpanel-php-fpm-alice-8.3.service loaded active running alice', 'xpanel-php-fpm-bob-8.2.service loaded failed failed bob',
  'xpanel-php-fpm-dave-8.2.service loaded active running dave', 'xpanel-php-fpm-carol-8.3.service loaded inactive dead carol', 'nginx.service loaded active running nginx'].join('\n')
const FPM_FILES = ['php8.3-fpm.service disabled enabled', 'php8.4-fpm.service disabled enabled', 'xpanel-php-fpm-alice-8.3.service enabled enabled', 'xpanel-php-fpm-bob-8.2.service enabled enabled',
  'xpanel-php-fpm-dave-8.2.service enabled enabled', 'xpanel-php-fpm-carol-8.3.service disabled enabled', 'nginx.service enabled enabled'].join('\n')
/** A host where `active` units are loaded and running; returns every non-observation argv it was asked to run. */
const fakeHost = (active: readonly string[], refuse: (argv: string[]) => string | null = () => null) => {
  const effects: string[][] = []
  const run = async (argv: string[]): Promise<HostCommandResult> => {
    if (argv[1] === 'show') return command(active.includes(argv.at(-1)!) ? 'loaded\nactive\n' : argv.at(-1) === 'php8.3-fpm.service' ? 'loaded\ninactive\n' : 'not-found\ninactive\n')
    if (argv[1] === 'list-units') return command(FPM_UNITS)
    if (argv[1] === 'list-unit-files') return command(FPM_FILES)
    effects.push(argv)
    const stderr = refuse(argv)
    return stderr === null ? command('') : { ok: false, stdout: 'secret = from doveconf', stderr }
  }
  return { run, effects }
}

describe('host services', () => {
  it.each([
    ['nginx', 'nginx.service', debian], ['apache', 'apache2.service', debian], ['apache', 'httpd.service', el], ['ssh', 'ssh.service', debian], ['ssh', 'sshd.service', el],
    ['postfix', 'postfix.service', el], ['dovecot', 'dovecot.service', debian], ['mariadb', 'mariadb.service', el], ['pdns', 'pdns.service', debian], ['opendkim', 'opendkim.service', el],
  ] as const)('runs the %s configuration test on %s before restarting it', async (id, unit, os) => {
    const host = fakeHost([unit])
    await expect(restartHostService(host.run, id, os)).resolves.toMatchObject({ id, unit, state: 'active' })
    expect(host.effects).toEqual([serviceConfigTest(unit, os), ['/usr/bin/systemctl', 'restart', '--', unit]])
  })

  it('restarts a daemon without an offline checker directly', async () => {
    const host = fakeHost(['postgresql.service'])
    await restartHostService(host.run, 'postgresql', el)
    expect(host.effects).toEqual([['/usr/bin/systemctl', 'restart', '--', 'postgresql.service']])
  })

  it('refuses the restart when the configuration test fails and keeps only its bounded stderr', async () => {
    const ssh = fakeHost(['ssh.service'], argv => argv[0] === '/usr/sbin/sshd' ? '/etc/ssh/sshd_config.d/50-x.conf line 3: Bad configuration option: Foo\n' : null)
    await expect(restartHostService(ssh.run, 'ssh', debian)).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED',
      detail: { stateChanged: false, reason: 'config_test_failed', unit: 'ssh.service', stderr: '/etc/ssh/sshd_config.d/50-x.conf line 3: Bad configuration option: Foo' } })
    expect(ssh.effects).toEqual([serviceConfigTest('ssh.service', debian)])
    const dovecot = fakeHost(['dovecot.service'], argv => argv[0] === 'doveconf' ? 'x'.repeat(5000) : null)
    await expect(restartHostService(dovecot.run, 'dovecot', debian)).rejects.toMatchObject({ detail: { stderr: 'x'.repeat(1000) }, message: expect.not.stringContaining('secret') })
    expect(dovecot.effects.some(argv => argv[1] === 'restart')).toBe(false)
  })

  it('restarts exactly one version of account masters after each passes its own test, and never the distro master', async () => {
    const masters = ['xpanel-php-fpm-bob-8.2.service', 'xpanel-php-fpm-dave-8.2.service']
    const host = fakeHost([])
    await expect(restartHostService(host.run, 'php-fpm-82', debian)).resolves.toMatchObject({ id: 'php-fpm-82', unit: null, fpm: { version: '8.2', masters: 2 } })
    expect(host.effects).toEqual([...masters.map(unit => serviceConfigTest(unit, debian)), ...masters.map(unit => ['/usr/bin/systemctl', 'restart', '--', unit])])
    const running = fakeHost(['php8.3-fpm.service'])
    await expect(restartHostService(running.run, 'php-fpm-83', debian)).resolves.toMatchObject({ id: 'php-fpm-83', state: 'active', fpm: { masters: 1, running: 1, failed: 0 } })
    expect(running.effects).toEqual([serviceConfigTest('xpanel-php-fpm-alice-8.3.service', debian), ['/usr/bin/systemctl', 'restart', '--', 'xpanel-php-fpm-alice-8.3.service']])
    const broken = fakeHost([], argv => argv.includes('bob') ? 'ERROR: [pool bob] unknown entry' : null)
    await expect(restartHostService(broken.run, 'php-fpm-82', debian)).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', detail: { stateChanged: false, unit: 'xpanel-php-fpm-bob-8.2.service' } })
    expect(broken.effects.some(argv => argv[1] === 'restart')).toBe(false)
  })

  it('refuses a PHP-FPM version without account masters and ids outside the supported versions', async () => {
    const host = fakeHost([])
    await expect(restartHostService(host.run, 'php-fpm-84', debian)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'PHP-FPM 8.4 has no enabled account master on this server', detail: { stateChanged: false } })
    await expect(restartHostService(host.run, 'php-fpm-74', debian)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    for (const id of ['php-fpm', 'php-fpm-99', 'php-fpm-8.3']) await expect(restartHostService(host.run, id, debian)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const unlisted = fakeHost([])
    await expect(restartHostService(async argv => argv[1] === 'list-units' ? command('', false) : unlisted.run(argv), 'php-fpm-83', debian)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'the account PHP-FPM masters could not be listed' })
    expect([...host.effects, ...unlisted.effects]).toEqual([])
  })

  it('reports one PHP-FPM row per installed version with running, failed and stopped master counts', async () => {
    const rows = await readHostServices(fakeHost([]).run)
    expect(rows.map(row => row.id).slice(0, 6)).toEqual(['nginx', 'apache', 'php-fpm-82', 'php-fpm-83', 'php-fpm-84', 'mariadb'])
    expect(rows.filter(row => row.fpm)).toEqual([
      { id: 'php-fpm-82', label: 'PHP-FPM 8.2', unit: null, state: 'failed', fpm: { version: '8.2', masters: 2, running: 1, failed: 1 } },
      { id: 'php-fpm-83', label: 'PHP-FPM 8.3', unit: null, state: 'active', fpm: { version: '8.3', masters: 1, running: 1, failed: 0 } },
      { id: 'php-fpm-84', label: 'PHP-FPM 8.4', unit: null, state: 'inactive', fpm: { version: '8.4', masters: 0, running: 0, failed: 0 } },
    ])
    const inventory = (units: string, files: string) => async (argv: string[]): Promise<HostCommandResult> =>
      command(argv[1] === 'list-units' ? units : argv[1] === 'list-unit-files' ? files : 'not-found\ninactive\n')
    const remi = await readHostServices(inventory('xpanel-php-fpm-alice-8.1.service loaded inactive dead alice', 'php81-php-fpm.service disabled disabled\nxpanel-php-fpm-alice-8.1.service enabled enabled'))
    expect(remi.filter(row => row.id.startsWith('php-fpm'))).toEqual([{ id: 'php-fpm-81', label: 'PHP-FPM 8.1', unit: null, state: 'inactive', fpm: { version: '8.1', masters: 1, running: 0, failed: 0 } }])
    const none = await readHostServices(inventory('nginx.service loaded active running nginx', 'nginx.service enabled enabled'))
    expect(none.filter(row => row.id.startsWith('php-fpm'))).toEqual([{ id: 'php-fpm', label: 'PHP-FPM', unit: null, state: 'not-installed' }])
  })

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
      return argv[1] === 'restart' ? command('systemctl restart failed', false) : command('')
    }
    const rows = await readHostServices(run)
    expect(rows.find(row => row.id === 'apache')).toEqual({ id: 'apache', label: 'Apache', unit: 'httpd.service', state: 'failed' })
    expect(rows.find(row => row.id === 'mariadb')).toMatchObject({ unit: 'mariadb.service', state: 'active' })
    expect(rows.find(row => row.id === 'pdns')).toMatchObject({ unit: null, state: 'not-installed' })
    const unchecked = await readHostServices(async () => command('systemctl missing', false))
    expect(unchecked.every(row => row.state === 'unchecked' && row.unit === null)).toBe(true)
    await expect(restartHostService(run, 'sshd', debian)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(calls.some(argv => argv.includes('sshd'))).toBe(false)
    await expect(restartHostService(run, 'pdns', debian)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'PowerDNS is not installed on this server' })
    await expect(restartHostService(run, 'apache', debian)).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', message: 'Apache did not restart (systemctl restart failed)' })
  })

  it('reports nginx, redis, and postgresql from systemctl and PHP-FPM as unchecked when the unit inventory is unreadable', async () => {
    const run = async (argv: string[]): Promise<HostCommandResult> => {
      const unit = argv.at(-1) ?? ''
      if (unit === 'nginx.service') return command('loaded\nactive\n')
      if (unit === 'redis-server.service') return command('loaded\ninactive\n')
      if (unit === 'postgresql.service') return command('not-found\ninactive\n')
      return command('not-found\ninactive\n')
    }
    const rows = await readHostServices(run)
    expect(rows.find(row => row.id === 'nginx')).toMatchObject({ unit: 'nginx.service', state: 'active' })
    expect(rows.filter(row => row.id.startsWith('php-fpm'))).toEqual([{ id: 'php-fpm', label: 'PHP-FPM', unit: null, state: 'unchecked' }])
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
    // The staging file is pre-created so tar does not change the archived home mtime mid-read.
    const stagingTouch = executor.executedActions.findIndex(action => action.kind === 'exec' && action.argv[0] === '/usr/bin/touch' && action.argv.includes('/home/alice/.xpanel-backup-20261023T165300Z.tar.gz'))
    const tarIndex = executor.executedActions.indexOf(tar!)
    expect(stagingTouch).toBeGreaterThanOrEqual(0)
    expect(stagingTouch).toBeLessThan(tarIndex)
    expect(executor.executedActions.some(action => action.kind === 'remove-path' && action.path === '/home/alice/.xpanel-backup-20261023T165300Z.tar.gz')).toBe(true)
    executor.executedActions.length = 0
    await expect(createAccountBackup({ executor, account, now: stamp, readSize: async () => MAX_BACKUP_BYTES + 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    executor.clearCommandFailures()
    executor.failCommand('/usr/bin/tar', 0, '', 'public_html/index.html\n')
    // The fake executor has no source inode; only this fixture supplies an inspection port.
    await expect(restoreAccountBackup({ executor, account, file: archiveName, inspectSource: async () => {} })).resolves.toEqual({ file: archiveName })
    const extract = executor.executedActions.find(action => action.kind === 'exec' && action.argv.includes('--extract'))
    expect(extract).toMatchObject({ kind: 'exec', runAsUser: 'alice' })
    // A full restore brings back every home member; only the root-written database dumps stay out of the home.
    expect(extract?.kind === 'exec' && extract.argv.filter(arg => arg.startsWith('--exclude='))).toEqual(['--exclude=./.xpanel-backup-data', '--exclude=.xpanel-backup-data'])
    // The existing strict FakeHostExecutor argv validator also checks the home-only variant.
    const beforeHomeRestore = executor.executedActions.length
    await expect(restoreAccountBackup({ executor, account, file: archiveName, preserveMail: true, inspectSource: async () => {} })).resolves.toEqual({ file: archiveName })
    const homeExtract = executor.executedActions.slice(beforeHomeRestore).find(action => action.kind === 'exec' && action.argv.includes('--extract'))
    expect(homeExtract?.kind === 'exec' && homeExtract.argv.includes('--exclude=./mail') && homeExtract.argv.includes('--exclude=./etc') && !homeExtract.argv.some(arg => arg.includes('*'))).toBe(true)
    expect(executor.executedActions.some(action => action.kind === 'ensure-dir' && action.path === '/run/xpanel/account-restores/alice' && action.owner === 'root' && action.mode === 0o710)).toBe(true)
    expect(executor.executedActions.some(action => action.kind === 'exec' && action.argv[0] === '/bin/chown' && action.argv[1] === 'root:alice')).toBe(true)
    expect(executor.executedActions.some(action => action.kind === 'exec' && action.argv[0] === '/usr/bin/cp' && action.argv.at(-1)?.startsWith('/home/alice/'))).toBe(false)
  })

  it('relabels the restored home on EL after the extraction, and only there', async () => {
    const restored = async (family: string) => {
      const executor = new FakeHostExecutor()
      executor.files.set('/sys/fs/selinux/enforce', { path: '/sys/fs/selinux/enforce', content: '1', mode: 0o644 })
      executor.failCommand('/usr/bin/tar', 0, '', 'public_html/index.html\n')
      await restoreAccountBackup({ executor, account, file: archiveName, family, inspectSource: async () => {} })
      return executor.executedCommands.filter(argv => argv.includes('/usr/sbin/restorecon'))
    }
    expect(await restored('rhel')).toEqual([['/usr/sbin/runuser', '-u', 'alice', '--', '/usr/sbin/restorecon', '-R', '-F', '-i', '/home/alice']])
    expect(await restored('debian')).toEqual([])
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
