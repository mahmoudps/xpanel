import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import {
  derivePhpFpmBinary,
  fpmAccountLogDir,
  fpmPaths,
  quoteExecArg,
  renderAppUnits,
  renderCacheUnit,
  renderContainerUnit,
  cachePaths,
  isContainerImage,
  renderCronUnits,
  CRON_COMMAND_RUNNER,
  cronCommandPath,
  renderFpmUnit,
  renderLoginSliceDropin,
  type AppSpec,
} from './units.ts'
import { debianOs, limited, makeAccount, rhelOs, unitValues, unlimited } from './testkit.ts'

const account = makeAccount()

describe('renderFpmUnit', () => {
  const unit = renderFpmUnit(account, '8.3', debianOs)

  it('runs php-fpm as the account inside its slice', () => {
    expect(unit.path).toBe('/etc/systemd/system/xpanel-php-fpm-alice-8.3.service')
    expect(unitValues(unit.content, 'User')).toEqual(['alice'])
    expect(unitValues(unit.content, 'Group')).toEqual(['alice'])
    expect(unitValues(unit.content, 'Slice')).toEqual(['xpanel-1001.slice'])
    expect(unitValues(unit.content, 'ExecStart')).toEqual(['/usr/sbin/php-fpm8.3 --nodaemonize --fpm-config /etc/xpanel/php-fpm/8.3/alice.conf'])
    expect(unitValues(unit.content, 'Type')).toEqual(['notify'])
    expect(unitValues(unit.content, 'LimitNOFILE')).toEqual(['65536'])
  })

  it('hides other homes and makes the OS read-only while keeping PHP writable paths', () => {
    expect(unitValues(unit.content, 'ProtectSystem')).toEqual(['strict'])
    expect(unitValues(unit.content, 'ProtectHome')).toEqual(['tmpfs'])
    expect(unitValues(unit.content, 'BindPaths')).toEqual(['/home/alice'])
    expect(unitValues(unit.content, 'ReadWritePaths')).toEqual(['/home/alice /run/xpanel-fpm/alice-8.3 /var/log/xpanel/php-fpm/alice'])
    expect(unitValues(unit.content, 'RuntimeDirectory')).toEqual(['xpanel-fpm/alice-8.3'])
    expect(unitValues(unit.content, 'LogsDirectory')).toEqual(['xpanel/php-fpm/alice'])
    expect(unitValues(unit.content, 'RuntimeDirectoryMode')).toEqual(['0750'])
    expect(unitValues(unit.content, 'LogsDirectoryMode')).toEqual(['0750'])
    for (const [k, v] of [
      ['PrivateTmp', 'yes'], ['NoNewPrivileges', 'yes'], ['RestrictSUIDSGID', 'yes'], ['ProtectProc', 'invisible'],
      ['PrivateDevices', 'yes'], ['CapabilityBoundingSet', ''], ['UMask', '0027'], ['LockPersonality', 'yes'],
    ] as const) {
      expect(unitValues(unit.content, k), k).toEqual([v])
    }
    expect(unit.content).not.toContain('MemoryDenyWriteExecute')
    expect(unit.content).not.toContain('TemporaryFileSystem')
    expect(unitValues(unit.content, 'RestrictAddressFamilies')).toEqual(['AF_UNIX AF_INET AF_INET6'])
  })

  it('stops PHP from binding TCP ports another account proxies to', () => {
    expect(unitValues(unit.content, 'SocketBindAllow')).toEqual(['udp'])
    expect(unitValues(unit.content, 'SocketBindDeny')).toEqual(['any'])
  })

  it('hides sibling homes on non-/home bases with an empty tmpfs', () => {
    const u = renderFpmUnit(makeAccount({ home: '/home2/alice' }), '8.3', debianOs)
    expect(unitValues(u.content, 'TemporaryFileSystem')).toEqual(['/home2:ro'])
    expect(unitValues(u.content, 'BindPaths')).toEqual(['/home2/alice'])
  })

  it('hides every configured home base, not only its own', () => {
    const homeBases = ['/home', '/home2', '/srv/homes']
    const onHome = renderFpmUnit(account, '8.3', debianOs, { homeBases })
    expect(unitValues(onHome.content, 'ProtectHome')).toEqual(['tmpfs'])
    expect(unitValues(onHome.content, 'TemporaryFileSystem')).toEqual(['/home2:ro', '/srv/homes:ro'])
    const onSrv = renderCronUnits(makeAccount({ home: '/srv/homes/alice' }), { id: 'x', schedule: '@daily', command: 'true' }, debianOs, { homeBases })
    expect(unitValues(onSrv.service.content, 'TemporaryFileSystem')).toEqual(['/home2:ro', '/srv/homes:ro'])
    expect(unitValues(onSrv.service.content, 'BindPaths')).toEqual(['/srv/homes/alice'])
    expect(() => renderFpmUnit(account, '8.3', debianOs, { homeBases: ['/home', '/etc'] })).toThrowError(XpanelError)
    expect(() => renderFpmUnit(account, '8.3', debianOs, { homeBases: ['/home', '/srv', '/srv/homes'] })).toThrowError(XpanelError)
    expect(() => renderFpmUnit(account, '8.3', debianOs, { homeBases: ['/home', '/home/sub'] })).toThrowError(XpanelError)
  })

  it('derives the FPM binary per distro and accepts an explicit one', () => {
    expect(derivePhpFpmBinary(debianOs, '8.3')).toBe('/usr/sbin/php-fpm8.3')
    expect(derivePhpFpmBinary(rhelOs, '8.3')).toBe('/opt/remi/php83/root/usr/sbin/php-fpm')
    expect(derivePhpFpmBinary({ ...debianOs, phpBinary: (v) => `/opt/xpanel/php/${v}/bin/php` }, '8.2')).toBe('/opt/xpanel/php/8.2/sbin/php-fpm')
    expect(() => derivePhpFpmBinary({ ...debianOs, phpBinary: () => '/usr/bin/python3' }, '8.3')).toThrowError(XpanelError)
    // packages/os profiles carry their own phpFpmBinary; it wins over the derivation
    const withOwn = { ...debianOs, phpFpmBinary: (v: string) => `/usr/local/sbin/php-fpm-${v}` }
    expect(derivePhpFpmBinary(withOwn, '8.4')).toBe('/usr/local/sbin/php-fpm-8.4')
    expect(unitValues(renderFpmUnit(account, '8.4', withOwn).content, 'ExecStart')[0]).toMatch(/^\/usr\/local\/sbin\/php-fpm-8\.4 /)
    expect(() => derivePhpFpmBinary({ ...debianOs, phpFpmBinary: () => 'php-fpm; id' } as typeof withOwn, '8.3')).toThrowError(XpanelError)
    const rhel = renderFpmUnit(account, '8.1', rhelOs)
    expect(unitValues(rhel.content, 'ExecStart')[0]).toMatch(/^\/opt\/remi\/php81\/root\/usr\/sbin\/php-fpm --nodaemonize/)
    const custom = renderFpmUnit(account, '8.3', debianOs, { fpmBinary: '/opt/php/sbin/php-fpm', limitNofile: 4096 })
    expect(unitValues(custom.content, 'ExecStart')[0]).toMatch(/^\/opt\/php\/sbin\/php-fpm /)
    expect(unitValues(custom.content, 'LimitNOFILE')).toEqual(['4096'])
  })

  it('rejects bad versions, binaries and limits', () => {
    for (const v of ['8', '8.3.1', '83', '8.3;', '../8.3', '8.3\n', 'x.y']) {
      expect(() => renderFpmUnit(account, v, debianOs), v).toThrowError(XpanelError)
    }
    expect(() => renderFpmUnit(account, '8.3', debianOs, { fpmBinary: 'php-fpm' })).toThrowError(XpanelError)
    expect(() => renderFpmUnit(account, '8.3', debianOs, { fpmBinary: '/usr/sbin/php-fpm --allow-to-run-as-root' })).toThrowError(XpanelError)
    expect(() => renderFpmUnit(account, '8.3', debianOs, { limitNofile: 100 })).toThrowError(XpanelError)
  })

  it('refuses web server and reserved identities', () => {
    expect(() => renderFpmUnit(makeAccount({ username: 'apache', home: '/home/apache' }), '8.3', rhelOs)).toThrowError(XpanelError)
    expect(() => renderFpmUnit(makeAccount({ username: 'root', home: '/home/root' }), '8.3', debianOs)).toThrowError(XpanelError)
  })

  it('exposes the paths the edge master/pool renderers use, and starts that exact master', () => {
    const p = fpmPaths('alice', '8.3')
    expect(p).toEqual({
      unit: 'xpanel-php-fpm-alice-8.3.service',
      config: '/etc/xpanel/php-fpm/8.3/alice.conf',
      pool: '/etc/xpanel/php-fpm/8.3/alice.pool.conf',
      runtimeDirectory: 'xpanel-fpm/alice-8.3',
      socketDir: '/run/xpanel-fpm/alice-8.3',
      socket: '/run/xpanel-fpm/alice-8.3/php-fpm.sock',
      logsDirectory: 'xpanel/php-fpm/alice',
      logDir: '/var/log/xpanel/php-fpm/alice',
    })
    expect(unit.path.endsWith(`/${p.unit}`)).toBe(true)
    expect(unitValues(unit.content, 'ExecStart')[0]?.endsWith(`--fpm-config ${p.config}`)).toBe(true)
    expect(`/run/${unitValues(unit.content, 'RuntimeDirectory')[0]}`).toBe(p.socketDir)
    expect(`/var/log/${unitValues(unit.content, 'LogsDirectory')[0]}`).toBe(p.logDir)
    expect(fpmAccountLogDir('alice')).toBe(p.logDir)
  })

  it('validates names before they become paths', () => {
    for (const [u, v] of [['../x', '8.3'], ['alice', '../8.3'], ['root', '8.3'], ['alice', '8.3/..']]) {
      expect(() => fpmPaths(u as string, v as string), `${u} ${v}`).toThrowError(XpanelError)
    }
    expect(() => fpmAccountLogDir('a/b')).toThrowError(XpanelError)
  })
})

describe('quoteExecArg', () => {
  it('neutralizes quotes, backslashes, specifiers and env expansion', () => {
    expect(quoteExecArg('plain')).toBe('"plain"')
    expect(quoteExecArg('a "b"')).toBe('"a \\"b\\""')
    expect(quoteExecArg('c:\\x')).toBe('"c:\\\\x"')
    expect(quoteExecArg('%h $HOME ${X}')).toBe('"%%h $$HOME $${X}"')
    expect(quoteExecArg("it's; rm -rf /")).toBe('"it\'s; rm -rf /"')
  })
})

describe('renderAppUnits', () => {
  const app: AppSpec = { name: 'api', kind: 'node', root: '/home/alice/apps/api', startup: 'server.js', env: { NODE_ENV: 'staging', DB_PASS: "p@ss'w$rd\"\\" } }
  const r = renderAppUnits(account, app, debianOs)

  it('runs the app isolated in the slice on a unix socket in its own runtime directory', () => {
    expect(r.service.path).toBe('/etc/systemd/system/xpanel-app-alice-api.service')
    expect(unitValues(r.service.content, 'Slice')).toEqual(['xpanel-1001.slice'])
    expect(unitValues(r.service.content, 'User')).toEqual(['alice'])
    expect(unitValues(r.service.content, 'Environment')).toEqual(['"PORT=/run/xpanel-apps/alice-api/app.sock" "NODE_ENV=production"'])
    expect(unitValues(r.service.content, 'ExecStart')).toEqual(['/usr/bin/node "/home/alice/apps/api/server.js"'])
    expect(unitValues(r.service.content, 'WorkingDirectory')).toEqual(['/home/alice/apps/api'])
    expect(unitValues(r.service.content, 'RuntimeDirectory')).toEqual(['xpanel-apps/alice-api'])
    expect(unitValues(r.service.content, 'RuntimeDirectoryMode')).toEqual(['0700'])
    expect(unitValues(r.service.content, 'SocketBindAllow')).toEqual(['udp'])
    expect(unitValues(r.service.content, 'SocketBindDeny')).toEqual(['any'])
    expect(unitValues(r.service.content, 'ProtectHome')).toEqual(['tmpfs'])
    expect(unitValues(r.service.content, 'NoNewPrivileges')).toEqual(['yes'])
  })

  it('fronts the app with a root-owned socket for the Nginx group, proxied as the account', () => {
    expect(unitValues(r.proxySocket.content, 'ListenStream')).toEqual(['/run/xpanel-app-proxy/alice-api.sock'])
    expect(unitValues(r.proxySocket.content, 'SocketUser')).toEqual(['root'])
    expect(unitValues(r.proxySocket.content, 'SocketGroup')).toEqual([debianOs.paths.nginxUser])
    expect(unitValues(r.proxySocket.content, 'SocketMode')).toEqual(['0660'])
    expect(unitValues(r.proxyService.content, 'ExecStart')).toEqual(['/usr/lib/systemd/systemd-socket-proxyd --exit-idle-time=10min /run/xpanel-apps/alice-api/app.sock'])
    expect(unitValues(r.proxyService.content, 'User')).toEqual(['alice'])
    expect(unitValues(r.proxyService.content, 'Slice')).toEqual(['xpanel-1001.slice'])
  })

  it('keeps secrets out of the unit, in a root-only EnvironmentFile', () => {
    expect(r.service.content).not.toContain('DB_PASS')
    expect(unitValues(r.service.content, 'EnvironmentFile')).toEqual(['/etc/xpanel/runtime/alice/api.env'])
    expect(r.envFile).toMatchObject({ mode: 0o600, owner: 'root', group: 'root' })
    expect(r.envFile.content).toContain("NODE_ENV='staging'\n")
    expect(r.envFile.content).toContain('DB_PASS="p@ss\'w\\$rd\\"\\\\"\n')
  })

  it('serves python through the venv and the stdlib launcher, ruby through bundle exec puma', () => {
    const py = renderAppUnits(account, { ...app, kind: 'python', startup: 'passenger_wsgi.py' }, rhelOs)
    expect(unitValues(py.service.content, 'ExecStart')).toEqual(['/home/alice/apps/api/.venv/bin/python /etc/xpanel/runtime/wsgi-unix.py "/run/xpanel-apps/alice-api/app.sock" "/home/alice/apps/api/passenger_wsgi.py"'])
    const rb = renderAppUnits(account, { ...app, kind: 'ruby', startup: 'config.ru' }, debianOs)
    expect(unitValues(rb.service.content, 'ExecStart')).toEqual(['/usr/bin/bundle exec puma --bind "unix:///run/xpanel-apps/alice-api/app.sock" "/home/alice/apps/api/config.ru"'])
    expect(unitValues(rb.service.content, 'Environment')[0]).toContain('"BUNDLE_PATH=/home/alice/apps/api/vendor/bundle"')
  })

  it.each([
    ['name with slash', { name: '../x' }],
    ['uppercase name', { name: 'API' }],
    ['kind', { kind: 'php' }],
    ['root outside home', { root: '/home/bob/app' }],
    ['root prefix trick', { root: '/home/alicex/app' }],
    ['root is the home', { root: '/home/alice' }],
    ['root traversal', { root: '/home/alice/../bob' }],
    ['startup traversal', { startup: '../../bob/x.js' }],
    ['startup newline', { startup: 'a\nExecStartPre=/bin/sh' }],
    ['env name', { env: { 'A-B': '1' } }],
    ['env PORT override', { env: { PORT: '1' } }],
    ['env newline', { env: { A: 'x\nB=y' } }],
  ])('rejects %s', (_, patch) => {
    expect(() => renderAppUnits(account, { ...app, ...patch } as AppSpec, debianOs)).toThrowError(XpanelError)
  })
})

describe('renderCacheUnit', () => {
  it('runs redis as the account on a socket in its home, no TCP, no persistence, memory capped', () => {
    const unit = renderCacheUnit(account, { service: 'redis', memoryMb: 64, binary: '/usr/bin/redis-server' }, debianOs)
    expect(unit.path).toBe('/etc/systemd/system/xpanel-redis-alice.service')
    expect(unitValues(unit.content, 'ExecStart')).toEqual(['/usr/bin/redis-server --port 0 --unixsocket "/home/alice/.xpanel-cache/redis.sock" --unixsocketperm 700 --maxmemory 64mb --maxmemory-policy allkeys-lru --save "" --appendonly no --dir "/home/alice/.xpanel-cache" --daemonize no --logfile ""'])
    expect(unitValues(unit.content, 'MemoryMax')).toEqual(['96M'])
    expect(unitValues(unit.content, 'Slice')).toEqual(['xpanel-1001.slice'])
    expect(unitValues(unit.content, 'SocketBindDeny')).toEqual(['any'])
  })

  it('runs memcached on a unix socket only (no network listener)', () => {
    const unit = renderCacheUnit(account, { service: 'memcached', memoryMb: 32, binary: '/usr/bin/memcached' }, debianOs)
    expect(unitValues(unit.content, 'ExecStart')).toEqual(['/usr/bin/memcached -s "/home/alice/.xpanel-cache/memcached.sock" -a 0700 -m 32 -c 256 -t 1'])
    expect(cachePaths(account, 'memcached').socket).toBe('/home/alice/.xpanel-cache/memcached.sock')
  })

  it.each([['memory below floor', { memoryMb: 4 }], ['relative binary', { binary: 'redis-server' }], ['service', { service: 'mongodb' }]])('rejects %s', (_, patch) => {
    expect(() => renderCacheUnit(account, { service: 'redis', memoryMb: 64, binary: '/usr/bin/redis-server', ...patch } as never, debianOs)).toThrowError(XpanelError)
  })
})

describe('renderContainerUnit', () => {
  const limits = { memoryMb: 512, cpuPercent: 50, maxProcesses: 64 }
  it('runs podman rootless as the account in a delegated cgroup with plan limits and no published port', () => {
    const r = renderContainerUnit(account, { name: 'kuma', image: 'docker.io/louislam/uptime-kuma:1', env: { TZ: 'UTC' } }, limits, debianOs)
    expect(r.unit).toBe('xpanel-ctr-alice-kuma.service')
    expect(unitValues(r.service.content, 'User')).toEqual(['alice'])
    expect(unitValues(r.service.content, 'Slice')).toEqual(['xpanel-1001.slice'])
    expect(unitValues(r.service.content, 'Delegate')).toEqual(['yes'])
    const exec = unitValues(r.service.content, 'ExecStart')[0]!
    expect(exec).toBe('/usr/bin/podman --cgroup-manager=cgroupfs run --rm --replace --name kuma --cgroups=split --log-driver=passthrough --security-opt=no-new-privileges --pull=missing --memory=512m --cpus=0.50 --pids-limit=64 --env TZ "docker.io/louislam/uptime-kuma:1"')
    expect(exec).not.toMatch(/ (?:-p|--publish)\b/)
    expect(r.envFile).toMatchObject({ path: '/etc/xpanel/runtime/alice/ctr-kuma.env', mode: 0o600, owner: 'root' })
  })

  it.each(['louislam/uptime-kuma:1', 'docker.io/louislam/uptime-kuma', 'evil.example/x:1', 'docker.io/../x:1', 'docker.io/X:1'])('rejects image %s', (image) => {
    expect(() => renderContainerUnit(account, { name: 'kuma', image }, limits, debianOs)).toThrowError(XpanelError)
    expect(isContainerImage(image)).toBe(false)
  })
})

describe('renderCronUnits', () => {
  const cron = renderCronUnits(account, { id: 'backup', schedule: '30 2 1,15 * 0', command: 'tar czf ~/b-$(date +%F).tgz "$HOME/public_html"' }, debianOs)

  it('renders a timer with one OnCalendar per expression', () => {
    expect(cron.timerName).toBe('xpanel-cron-alice-backup.timer')
    expect(cron.timer.path).toBe('/etc/systemd/system/xpanel-cron-alice-backup.timer')
    expect(unitValues(cron.timer.content, 'OnCalendar')).toEqual(['Sun *-*-* 02:30:00', '*-*-01,15 02:30:00'])
    expect(unitValues(cron.timer.content, 'Unit')).toEqual(['xpanel-cron-alice-backup.service'])
    expect(unitValues(cron.timer.content, 'WantedBy')).toEqual(['timers.target'])
  })

  it('runs the command as the user inside the slice, literally', () => {
    expect(unitValues(cron.service.content, 'Type')).toEqual(['oneshot'])
    expect(unitValues(cron.service.content, 'User')).toEqual(['alice'])
    expect(unitValues(cron.service.content, 'Slice')).toEqual(['xpanel-1001.slice'])
    expect(unitValues(cron.service.content, 'ExecStart')).toEqual([`/bin/sh -c ${quoteExecArg(CRON_COMMAND_RUNNER)} ${quoteExecArg('/bin/sh')} ${quoteExecArg(cron.commandFile.path)}`])
    expect(unitValues(cron.service.content, 'StandardInput')).toEqual(['null'])
    expect(cron.commandFile).toEqual({ path: '/etc/xpanel/cron/alice/backup.command', content: 'tar czf ~/b-$(date +%F).tgz "$HOME/public_html"', mode: 0o640, owner: 'root', group: 'alice' })
    expect(unitValues(cron.service.content, 'TimeoutStartSec')).toEqual(['infinity'])
    expect(unitValues(cron.service.content, 'ProtectSystem')).toEqual(['strict'])
    expect(cron.service.content).not.toContain('[Install]')
  })

  it('cannot start a TCP listener that would squat another account app port', () => {
    expect(unitValues(cron.service.content, 'SocketBindAllow')).toEqual(['udp'])
    expect(unitValues(cron.service.content, 'SocketBindDeny')).toEqual(['any'])
  })

  it('caps runtime when asked', () => {
    const c = renderCronUnits(account, { id: 'x', schedule: '@hourly', command: 'true', maxRuntimeSec: 600 }, rhelOs)
    expect(unitValues(c.service.content, 'TimeoutStartSec')).toEqual(['600s'])
  })

  it('keeps every public unit property and executable argv independent of the private command', () => {
    const command = '  printf "%s" "SYNTHETIC_PRIVATE_CRON_VALUE_%_$HOME"  '
    const first = renderCronUnits(account, { id: 'private', schedule: '@daily', command }, debianOs)
    const second = renderCronUnits(account, { id: 'private', schedule: '@daily', command: 'printf other' }, debianOs)
    expect(first.service).toEqual(second.service)
    expect(first.timer).toEqual(second.timer)
    expect(first.service.content + first.timer.content).not.toContain('SYNTHETIC_PRIVATE_CRON_VALUE')
    expect(Buffer.from(first.commandFile.content, 'utf8')).toEqual(Buffer.from(command, 'utf8'))
    expect(first.commandFile.mode & 0o007).toBe(0)
    expect(first.commandFile.mode & 0o070).toBe(0o040)
    expect(first.commandFile.owner).toBe('root')
    expect(first.commandFile.group).toBe(account.username)
    const other = renderCronUnits(makeAccount({ username: 'bob', home: '/home/bob', uid: 1002, gid: 1002 }), { id: 'private', schedule: '@daily', command: 'true' }, debianOs)
    expect(other.commandFile.group).toBe('bob')
    expect(other.commandFile.path).not.toBe(first.commandFile.path)
    expect(() => cronCommandPath('alice', '../../etc/shadow')).toThrowError(XpanelError)
  })

  it.each([
    ['bad schedule', { schedule: '61 * * * *' }],
    ['reboot', { schedule: '@reboot' }],
    ['newline command', { command: 'true\nExecStartPost=/bin/rm -rf /' }],
    ['empty command', { command: '   ' }],
    ['bad id', { id: 'Back Up' }],
    ['id traversal', { id: '../../etc/x' }],
    ['runtime 0', { maxRuntimeSec: 0 }],
  ])('rejects %s', (_, patch) => {
    expect(() => renderCronUnits(account, { id: 'x', schedule: '@daily', command: 'true', ...patch }, debianOs)).toThrowError(XpanelError)
  })
})

describe('renderLoginSliceDropin', () => {
  it('mirrors the slice limits into user-<uid>.slice.d', () => {
    const f = renderLoginSliceDropin(account, limited, ['/dev/sda'])
    expect(f.path).toBe('/etc/systemd/system/user-1001.slice.d/50-xpanel.conf')
    expect(f.content).toContain('Separate budget')
    expect(unitValues(f.content, 'MemoryMax')).toEqual(['1024M'])
    expect(unitValues(f.content, 'TasksMax')).toEqual(['100'])
    expect(unitValues(f.content, 'IOWriteBandwidthMax')).toEqual(['/dev/sda 5242880'])
  })

  it('overrides logind defaults explicitly for unlimited plans', () => {
    const f = renderLoginSliceDropin(account, unlimited)
    expect(unitValues(f.content, 'TasksMax')).toEqual(['infinity'])
    expect(unitValues(f.content, 'MemoryMax')).toEqual(['infinity'])
  })
})
