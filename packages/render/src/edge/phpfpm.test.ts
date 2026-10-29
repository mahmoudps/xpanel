import { describe, expect, it } from 'vitest'
import { DANGEROUS_FUNCTIONS, disabledFunctions } from '@xpanel/core'
import { renderFpmUnit } from '../system/units.ts'
import { fpmConfigTest, fpmInstanceDirs, renderFpmMaster, renderFpmPool, renderUserIni } from './phpfpm.ts'
import { fpmSocketPath, phpFpmBinary } from './paths.ts'
import { account, codeOf, debianOs, php, rhelOs } from './testkit.ts'

const a = account()
const valueOf = (content: string, key: string): string | undefined =>
  content.split('\n').find((l) => l.startsWith(`${key} = `))?.slice(key.length + 3)

describe('renderFpmPool', () => {
  it('runs the pool as the account and listens on its own socket 0660', () => {
    const f = renderFpmPool(a, php(), debianOs)
    const c = f.content
    expect(f.path).toBe('/etc/xpanel/php-fpm/8.3/alice.pool.conf')
    expect(f).toMatchObject({ mode: 0o640, owner: 'root', group: 'alice' })
    expect(c).toContain('[alice]')
    expect(valueOf(c, 'user')).toBe(a.username)
    expect(valueOf(c, 'group')).toBe(a.username)
    expect(valueOf(c, 'listen')).toBe('/run/xpanel-fpm/alice-8.3/php-fpm.sock')
    expect(valueOf(c, 'listen.owner')).toBe('alice')
    expect(valueOf(c, 'listen.group')).toBe('alice')
    expect(valueOf(c, 'listen.mode')).toBe('0660')
    expect(c).not.toContain('listen.acl_users')
  })

  it('grants the shared Apache user socket access under prefork only', () => {
    expect(valueOf(renderFpmPool(a, php(), debianOs, { apacheMpm: 'prefork' }).content, 'listen.acl_users')).toBe('www-data')
    expect(valueOf(renderFpmPool(a, php(), rhelOs, { apacheMpm: 'prefork' }).content, 'listen.acl_users')).toBe('apache')
    expect(codeOf(() => renderFpmPool(a, php(), debianOs, { apacheMpm: 'event' as 'itk' }))).toBe('VALIDATION')
    const hostile = { ...debianOs, paths: { ...debianOs.paths, apacheUser: 'www-data\nlisten = 0.0.0.0:9000' } }
    expect(codeOf(() => renderFpmPool(a, php(), hostile, { apacheMpm: 'prefork' }))).toBe('VALIDATION')
  })

  it('renders the pm mode and all worker fields', () => {
    const c = renderFpmPool(a, php({ fpm: { mode: 'dynamic', maxChildren: 20, startServers: 4, minSpareServers: 2, maxSpareServers: 6, maxRequests: 1000, processIdleTimeoutSec: 30 } }), debianOs).content
    expect(valueOf(c, 'pm')).toBe('dynamic')
    expect(valueOf(c, 'pm.max_children')).toBe('20')
    expect(valueOf(c, 'pm.start_servers')).toBe('4')
    expect(valueOf(c, 'pm.min_spare_servers')).toBe('2')
    expect(valueOf(c, 'pm.max_spare_servers')).toBe('6')
    expect(valueOf(c, 'pm.max_requests')).toBe('1000')
    expect(valueOf(c, 'pm.process_idle_timeout')).toBe('30s')
  })

  it('confines open_basedir to the home and its tmp only', () => {
    const c = renderFpmPool(a, php(), debianOs).content
    const ob = valueOf(c, 'php_admin_value[open_basedir]')
    expect(ob).toBe('/home/alice:/home/alice/tmp')
    expect(ob?.split(':')).toEqual([a.home, `${a.home}/tmp`])
    expect(valueOf(c, 'php_admin_value[upload_tmp_dir]')).toBe('/home/alice/tmp')
    expect(valueOf(c, 'php_admin_value[session.save_path]')).toBe('/home/alice/tmp')
    expect(valueOf(c, 'env[TMPDIR]')).toBe('/home/alice/tmp')
  })

  it('adds the distribution PHP library dir only on request', () => {
    expect(valueOf(renderFpmPool(a, php(), debianOs, { includeSystemPhpLib: true }).content, 'php_admin_value[open_basedir]')).toBe(
      '/home/alice:/home/alice/tmp:/usr/share/php',
    )
    expect(valueOf(renderFpmPool(a, php(), rhelOs, { includeSystemPhpLib: true }).content, 'php_admin_value[open_basedir]')).toBe(
      '/home/alice:/home/alice/tmp:/usr/share/pear',
    )
  })

  it('disables the core dangerous-function list unless root grants exceptions from it', () => {
    const all = valueOf(renderFpmPool(a, php(), debianOs).content, 'php_admin_value[disable_functions]')?.split(',')
    expect(all).toEqual([...DANGEROUS_FUNCTIONS])
    expect(all).toEqual(expect.arrayContaining(['exec', 'shell_exec', 'system', 'proc_open', 'popen', 'passthru']))
    const granted = valueOf(renderFpmPool(a, php(), debianOs, { allowedFunctions: ['proc_open', 'putenv'] }).content, 'php_admin_value[disable_functions]')?.split(',')
    expect(granted).not.toContain('proc_open')
    expect(granted).not.toContain('putenv')
    expect(granted).toContain('exec')
    expect(codeOf(() => renderFpmPool(a, php(), debianOs, { allowedFunctions: ['phpinfo'] }))).toBe('VALIDATION')
    expect(codeOf(() => disabledFunctions(['exec,system']))).toBe('VALIDATION')
    expect(codeOf(() => renderFpmPool(a, php(), debianOs, { allowedFunctions: ['x\nphp_admin_value[open_basedir]=/'] }))).toBe('VALIDATION')
  })

  it('writes per-directory keys as php_value and startup-only keys as admin values', () => {
    const c = renderFpmPool(
      a,
      php({ ini: { memory_limit: '512m', 'date.timezone': 'Asia/Gaza', error_reporting: 'E_ALL & ~E_NOTICE', display_errors: 'off', allow_url_fopen: 'Off' } }),
      debianOs,
    ).content
    expect(c).toContain('php_value[memory_limit] = 512M')
    expect(c).toContain('php_value[date.timezone] = Asia/Gaza')
    expect(c).toContain('php_value[error_reporting] = E_ALL & ~E_NOTICE')
    expect(c).toContain('php_value[display_errors] = Off')
    expect(c).toContain('php_admin_flag[allow_url_fopen] = off')
    expect(c).not.toContain('php_value[allow_url_fopen]')
    expect(c).toContain('php_value[session.gc_probability] = 1')
  })

  it('refuses server-owned and unknown keys, as the panel does', () => {
    for (const key of ['open_basedir', 'disable_functions', 'extension', 'zend_extension', 'sendmail_path', 'session.save_path', 'user_ini.filename', 'auto_prepend_file', 'include_path', 'error_log', 'cgi.fix_pathinfo', 'opcache.preload']) {
      expect(codeOf(() => renderFpmPool(a, php({ ini: { [key]: 'x' } }), debianOs))).toBe('VALIDATION')
    }
  })

  it('caps memory_limit at the plan memory when given', () => {
    expect(codeOf(() => renderFpmPool(a, php({ ini: { memory_limit: '512M' } }), debianOs, { maxMemoryMb: 256 }))).toBe('VALIDATION')
    expect(codeOf(() => renderFpmPool(a, php({ ini: { memory_limit: '256M' } }), debianOs, { maxMemoryMb: 256 }))).toBeNull()
    expect(codeOf(() => renderFpmPool(a, php({ ini: { memory_limit: '64G' } }), debianOs, { maxMemoryMb: 'unlimited' }))).toBeNull()
  })

  it('rejects ini injection', () => {
    const bad: Record<string, string>[] = [
      { 'memory_limit]': '1' },
      { 'memory_limit\nphp_admin_value[open_basedir]': '/' },
      { memory_limit: '128M\nphp_admin_value[open_basedir] = /' },
      { memory_limit: '"128M"' },
      { memory_limit: '${HOME}' },
      { memory_limit: 'a\\b' },
      { MEMORY_LIMIT: '1' },
      { 'date.timezone': "UTC'; rm -rf /" },
      { default_charset: 'UTF-8"\nextension=evil.so' },
    ]
    for (const ini of bad) expect(codeOf(() => renderFpmPool(a, php({ ini }), debianOs))).toBe('VALIDATION')
  })

  it('validates workers like php-fpm does and enforces the plan cap', () => {
    const w = (fpm: Partial<ReturnType<typeof php>['fpm']>, cap?: number | 'unlimited') =>
      codeOf(() => renderFpmPool(a, php({ fpm: { ...php().fpm, mode: 'dynamic', ...fpm } }), debianOs, cap === undefined ? {} : { workerCap: cap }))
    expect(w({})).toBeNull()
    expect(w({ maxChildren: 0 })).toBe('VALIDATION')
    expect(w({ maxChildren: 1025, maxSpareServers: 3 })).toBe('VALIDATION')
    expect(w({ minSpareServers: 0 })).toBe('VALIDATION')
    expect(w({ minSpareServers: 4, maxSpareServers: 3 })).toBe('VALIDATION')
    expect(w({ maxSpareServers: 6, maxChildren: 5 })).toBe('VALIDATION')
    expect(w({ startServers: 4 })).toBe('VALIDATION')
    expect(w({ maxChildren: 5 }, 5)).toBeNull()
    expect(w({ maxChildren: 6, maxSpareServers: 3 }, 5)).toBe('LIMIT_EXCEEDED')
    expect(w({ maxChildren: 500, maxSpareServers: 3 }, 'unlimited')).toBeNull()
    const ondemand = (fpm: Partial<ReturnType<typeof php>['fpm']>) =>
      codeOf(() => renderFpmPool(a, php({ fpm: { ...php().fpm, mode: 'ondemand', ...fpm } }), debianOs))
    expect(ondemand({ startServers: 0, minSpareServers: 0, maxSpareServers: 0 })).toBeNull()
    expect(ondemand({ processIdleTimeoutSec: 0 })).toBe('VALIDATION')
    expect(codeOf(() => renderFpmPool(a, php({ fpm: { ...php().fpm, mode: 'turbo' as 'static' } }), debianOs))).toBe('VALIDATION')
  })

  it('refuses non-FPM handlers and hostile accounts', () => {
    expect(codeOf(() => renderFpmPool(a, php({ handler: 'cgi' }), debianOs))).toBe('VALIDATION')
    for (const over of [{ username: 'root' }, { username: 'sudo' }, { username: 'docker' }, { uid: 65534 }, { uid: 999 }, { gid: 70000 }, { home: '/home/bob' }]) {
      expect(codeOf(() => renderFpmPool(account(over), php(), debianOs))).toBe('VALIDATION')
    }
    expect(codeOf(() => renderFpmPool(a, php({ version: '../8.3' }), debianOs))).toBe('VALIDATION')
  })
})

describe('renderFpmMaster', () => {
  it('keeps pid in the instance run dir and the log in xPanel log dir, foreground', () => {
    const f = renderFpmMaster(a, '8.3', debianOs)
    expect(f.path).toBe('/etc/xpanel/php-fpm/8.3/alice.conf')
    expect(f).toMatchObject({ mode: 0o640, owner: 'root', group: 'alice' })
    expect(valueOf(f.content, 'pid')).toBe('/run/xpanel-fpm/alice-8.3/php-fpm.pid')
    expect(valueOf(f.content, 'error_log')).toBe('/var/log/xpanel/php-fpm/alice/8.3.error.log')
    expect(valueOf(f.content, 'daemonize')).toBe('no')
    expect(valueOf(f.content, 'include')).toBe('/etc/xpanel/php-fpm/8.3/alice.pool.conf')
    expect(f.content).toContain('xpanel-1001.slice')
  })

  it('is exactly the config the system module unit starts, with the socket Apache connects to', () => {
    const unit = renderFpmUnit(a, '8.3', debianOs).content
    expect(unit).toContain(`--fpm-config ${renderFpmMaster(a, '8.3', debianOs).path}`)
    expect(unit).toContain(`ExecStart=${phpFpmBinary(debianOs, '8.3')} `)
    expect(unit).toContain('RuntimeDirectory=xpanel-fpm/alice-8.3')
    expect(valueOf(renderFpmPool(a, php(), debianOs).content, 'listen')?.startsWith('/run/xpanel-fpm/alice-8.3/')).toBe(true)
    expect(fpmSocketPath('alice', '8.3')).toBe(valueOf(renderFpmPool(a, php(), debianOs).content, 'listen'))
    const log = valueOf(renderFpmMaster(a, '8.3', debianOs).content, 'error_log') ?? ''
    expect(unit).toContain(`LogsDirectory=${log.slice('/var/log/'.length, log.lastIndexOf('/'))}`)
  })

  it('keeps every socket, pid and runtime path out of the agent runtime dir that systemd wipes on agent stop', () => {
    for (const os of [debianOs, rhelOs]) {
      const rendered = [renderFpmPool(a, php(), os).content, renderFpmMaster(a, '8.3', os).content, renderFpmUnit(a, '8.3', os).content].join('\n')
      expect(rendered).not.toMatch(/\/run\/xpanel\//)
      expect(rendered).not.toMatch(/RuntimeDirectory=xpanel\//)
      expect(rendered).toContain('/run/xpanel-fpm/alice-8.3/php-fpm.sock')
      expect(os.phpFpmSocketDir.startsWith('/run/xpanel/')).toBe(false)
    }
  })

  it('rejects bad versions', () => {
    for (const v of ['8', '8.3.1', '83', '8.3/..', '10.0']) expect(codeOf(() => renderFpmMaster(a, v, debianOs))).toBe('VALIDATION')
  })

  it('creates the per-instance directories with account ownership where it writes', () => {
    const dirs = fpmInstanceDirs(a, '8.3')
    expect(dirs).toContainEqual({ kind: 'ensure-dir', path: '/var/log/xpanel/php-fpm/alice', mode: 0o750, owner: 'alice', group: 'alice' })
    expect(dirs).toContainEqual({ kind: 'ensure-dir', path: '/etc/xpanel/php-fpm/8.3', mode: 0o755, owner: 'root', group: 'root' })
    expect(dirs).toContainEqual({ kind: 'ensure-dir', path: '/home/alice/tmp', mode: 0o700, owner: 'alice', group: 'alice' })
    // the socket dir is the unit's RuntimeDirectory=; nothing else may pre-create it
    expect(dirs.some((d) => d.kind === 'ensure-dir' && d.path.startsWith('/run/'))).toBe(false)
  })

  it('derives the php-fpm binary for both families and tests the config as the account', () => {
    expect(phpFpmBinary(debianOs, '8.3')).toBe('/usr/sbin/php-fpm8.3')
    expect(phpFpmBinary(rhelOs, '8.2')).toBe('/opt/remi/php82/root/usr/sbin/php-fpm')
    const own = { ...debianOs, phpFpmBinary: (v: string) => `/opt/xpanel/php/${v}/sbin/php-fpm` }
    expect(phpFpmBinary(own, '8.4')).toBe('/opt/xpanel/php/8.4/sbin/php-fpm')
    expect(fpmConfigTest(a, '8.3', debianOs).argv).toEqual([
      'runuser', '-u', 'alice', '--', '/usr/sbin/php-fpm8.3', '--test', '--fpm-config', '/etc/xpanel/php-fpm/8.3/alice.conf',
    ])
    expect(codeOf(() => fpmConfigTest(account({ username: 'root' }), '8.3', debianOs))).toBe('VALIDATION')
  })
})

describe('renderUserIni', () => {
  it('renders key = value lines with canonical values', () => {
    const c = renderUserIni({ memory_limit: '256m', upload_max_filesize: '64M', post_max_size: '64M', 'date.timezone': 'UTC', display_errors: 'on' })
    expect(c).toContain('memory_limit = 256M\n')
    expect(c).toContain('upload_max_filesize = 64M\n')
    expect(c).toContain('date.timezone = UTC\n')
    expect(c).toContain('display_errors = On\n')
  })

  it('refuses startup-only keys, server-owned keys and injection', () => {
    expect(codeOf(() => renderUserIni({ allow_url_fopen: 'Off' }))).toBe('VALIDATION')
    expect(codeOf(() => renderUserIni({ open_basedir: '/' }))).toBe('VALIDATION')
    expect(codeOf(() => renderUserIni({ memory_limit: '1\n[PATH=/]' }))).toBe('VALIDATION')
    expect(codeOf(() => renderUserIni({ '[section]': '1' }))).toBe('VALIDATION')
    expect(codeOf(() => renderUserIni({ upload_max_filesize: '128M', post_max_size: '64M' }))).toBe('VALIDATION')
    expect(renderUserIni({})).toBe('; Managed by xPanel: PHP settings for this directory\n')
  })
})
