import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import type { PackageRole, ServiceRole } from '@xpanel/core'
import { aptProfile } from './apt.ts'
import { dnfProfile } from './dnf.ts'
import { profileFor } from './detect.ts'
import { parseOsRelease } from './osRelease.ts'
import { itkAvailable } from './install.ts'
import { SUPPORTED_PHP_VERSIONS } from './php.ts'
import { assertAbsolutePath, assertPackageName, assertUnitName } from './validate.ts'
import { ALMA_10, ALMA_9, CENTOS_STREAM_10, CENTOS_STREAM_9, ROCKY_9, SUPPORTED_FIXTURES, UBUNTU_2204, UBUNTU_2404 } from './fixtures.ts'

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return e instanceof XpanelError ? e.code : 'NOT_XPANEL'
  }
  return undefined
}

const PACKAGE_ROLES: PackageRole[] = [
  'nginx', 'apache', 'openlitespeed', 'mariadb', 'postgresql', 'postfix', 'dovecot', 'powerdns', 'redis', 'ftp', 'sshd',
  'nftables', 'apache-itk', 'apache-suexec', 'apache-fcgi', 'quota', 'acme', 'modsecurity',
]
const SERVICE_ROLES: ServiceRole[] = [
  'nginx', 'apache', 'openlitespeed', 'mariadb', 'postgresql', 'postfix', 'dovecot', 'powerdns', 'redis', 'ftp', 'sshd', 'nftables',
]
const HOSTILE_VERSIONS: unknown[] = ['8.3; rm -rf /', '8.3 ', ' 8.3', '8.3\n', '../8.3', '83', '8.5', '7.3', '8', '', 8.3, null, undefined, {}]

const ubuntu24 = profileFor(UBUNTU_2404)
const ubuntu22 = profileFor(UBUNTU_2204)
const centos9 = profileFor(CENTOS_STREAM_9)
const centos10 = profileFor(CENTOS_STREAM_10)

describe('apt profile (Ubuntu)', () => {
  it('names Debian services and packages', () => {
    expect(ubuntu24.services.apache).toBe('apache2')
    expect(ubuntu24.services.sshd).toBe('ssh')
    expect(ubuntu24.services.redis).toBe('redis-server')
    expect(ubuntu24.services.powerdns).toBe('pdns')
    expect(ubuntu24.services.ftp).toBe('pure-ftpd')
    expect(ubuntu24.packages['apache-itk']).toEqual(['libapache2-mpm-itk'])
    expect(ubuntu24.packages['apache-suexec']).toEqual(['apache2-suexec-custom'])
    expect(ubuntu24.packages['apache-fcgi']).toEqual(['libapache2-mod-fcgid'])
    expect(ubuntu24.packages.powerdns).toEqual(['pdns-server', 'pdns-backend-pgsql'])
    expect(ubuntu24.packages.dovecot).toEqual(expect.arrayContaining(['dovecot-imapd', 'dovecot-pop3d', 'dovecot-lmtpd']))
    expect(ubuntu24.packages.acme).toEqual(['certbot'])
    expect(ubuntu24.packages.modsecurity).toContain('libapache2-mod-security2')
    expect(itkAvailable(ubuntu24)).toBe(true)
  })

  it('uses Debian paths', () => {
    // renderers write real files into apacheVhostDir; apache2.conf only includes sites-enabled
    expect(ubuntu24.paths.apacheVhostDir).toBe('/etc/apache2/sites-enabled')
    expect(ubuntu24.paths.apacheSitesAvailableDir).toBe('/etc/apache2/sites-available')
    expect(ubuntu24.paths.apacheUser).toBe('www-data')
    expect(ubuntu24.paths.apacheCtl).toBe('/usr/sbin/apachectl')
    expect(ubuntu24.paths.apachePortsConf).toBe('/etc/apache2/ports.conf')
    expect(ubuntu24.paths.apacheSslConf).toBeNull()
    expect(ubuntu24.paths.nftablesConf).toBe('/etc/nftables.conf')
    expect(ubuntu24.paths.sshdConfig).toBe('/etc/ssh/sshd_config')
    expect(ubuntu24.paths.sshdConfigDir).toBe('/etc/ssh/sshd_config.d')
    expect(ubuntu24.paths.powerdnsConf).toBe('/etc/powerdns/pdns.conf')
    expect(ubuntu24.paths.powerdnsConfDir).toBe('/etc/powerdns')
    expect(ubuntu24.paths.suexecConfigFile).toBe('/etc/apache2/suexec/www-data')
  })

  it('runs Nginx as its own user, not as Apache www-data', () => {
    expect(ubuntu24.paths.nginxUser).toBe('nginx')
    expect(ubuntu24.extraSystemUsers).toEqual(['nginx'])
    expect(ubuntu24.bootstrapPackages).toContain('adduser')
    expect(ubuntu24.bin.adduser).toBe('/usr/sbin/adduser')
  })

  it('maps ondrej/php side-by-side PHP', () => {
    expect(ubuntu24.phpPackages('8.3')).toEqual(expect.arrayContaining(['php8.3-fpm', 'php8.3-cli', 'php8.3-mysql', 'php8.3-opcache']))
    expect(ubuntu24.phpPackages('8.3')).not.toContain('php8.3-json')
    expect(ubuntu24.phpPackages('7.4')).toContain('php7.4-json')
    expect(ubuntu24.phpFpmService('8.3')).toBe('php8.3-fpm')
    expect(ubuntu24.phpFpmPoolDir('8.3')).toBe('/etc/php/8.3/fpm/pool.d')
    expect(ubuntu24.phpBinary('8.3')).toBe('/usr/bin/php8.3')
    expect(ubuntu24.phpFpmBinary('8.3')).toBe('/usr/sbin/php-fpm8.3')
    expect(ubuntu24.phpIniFile('8.1')).toBe('/etc/php/8.1/fpm/php.ini')
    expect(ubuntu24.lsphpBinary('8.3')).toBe('/usr/local/lsws/lsphp83/bin/lsphp')
  })

  it('packages php-cgi separately, as the CGI-based handlers need it', () => {
    for (const v of SUPPORTED_PHP_VERSIONS) expect(ubuntu22.phpPackages(v)).toContain(`php${v}-cgi`)
    expect(ubuntu24.phpCgiBinary('8.3')).toBe('/usr/bin/php-cgi8.3')
    expect(ubuntu24.phpCgiBinary('7.4')).toBe('/usr/bin/php-cgi7.4')
  })

  it('points at the PostgreSQL cluster each LTS actually ships', () => {
    expect(ubuntu22.paths.postgresqlDataDir).toBe('/var/lib/postgresql/14/main')
    expect(ubuntu24.paths.postgresqlDataDir).toBe('/var/lib/postgresql/16/main')
  })

  it('carries the Debian site tools and no EL test page', () => {
    expect(ubuntu24.bin.a2dissite).toBe('/usr/sbin/a2dissite')
    expect(ubuntu24.paths.apacheWelcomeConf).toBeNull()
  })

  it('knows SSH socket activation on 24.04 only', () => {
    expect(ubuntu24.sshSocketUnit).toBe('ssh.socket')
    expect(ubuntu22.sshSocketUnit).toBeNull()
    expect(ubuntu22.codename).toBe('jammy')
    expect(ubuntu24.codename).toBe('noble')
  })

  it('refuses EL releases', () => {
    expect(code(() => aptProfile(parseOsRelease(CENTOS_STREAM_9)))).toBe('UNSUPPORTED_OS')
  })
})

describe('dnf profile (CentOS Stream / Alma / Rocky)', () => {
  it('names RHEL services and packages', () => {
    expect(centos9.services.apache).toBe('httpd')
    expect(centos9.services.sshd).toBe('sshd')
    expect(centos9.services.redis).toBe('redis')
    expect(centos9.packages.apache).toContain('httpd')
    expect(centos9.packages.postgresql).toEqual(['postgresql-server'])
    expect(centos9.packages.powerdns).toEqual(['pdns', 'pdns-backend-postgresql'])
    expect(centos9.packages['apache-fcgi']).toEqual(['mod_fcgid'])
    expect(centos9.packages.modsecurity).toContain('mod_security')
  })

  it('models missing mpm_itk as an empty package list', () => {
    for (const p of [centos9, centos10, profileFor(ALMA_9), profileFor(ROCKY_9)]) {
      expect(p.packages['apache-itk']).toEqual([])
      expect(itkAvailable(p)).toBe(false)
    }
  })

  it('switches Redis to Valkey on EL10', () => {
    expect(centos10.packages.redis).toEqual(['valkey'])
    expect(centos10.services.redis).toBe('valkey')
    expect(profileFor(ALMA_10).services.redis).toBe('valkey')
  })

  it('uses RHEL paths', () => {
    expect(centos9.paths.apacheVhostDir).toBe('/etc/httpd/conf.d')
    expect(centos9.paths.apacheModulesConf).toBe('/etc/httpd/conf.modules.d')
    expect(centos9.paths.apacheUser).toBe('apache')
    expect(centos9.paths.nginxUser).toBe('nginx')
    expect(centos9.paths.nftablesConf).toBe('/etc/sysconfig/nftables.conf')
    expect(centos9.paths.sshdConfig).toBe('/etc/ssh/sshd_config')
    expect(centos9.paths.sshdConfigDir).toBe('/etc/ssh/sshd_config.d')
    expect(centos9.paths.powerdnsConf).toBe('/etc/pdns/pdns.conf')
    expect(centos9.paths.powerdnsConfDir).toBe('/etc/pdns')
    expect(centos9.paths.apachePortsConf).toBe('/etc/httpd/conf/httpd.conf')
    expect(centos9.paths.apacheSslConf).toBe('/etc/httpd/conf.d/ssl.conf')
    expect(centos9.paths.apacheSitesAvailableDir).toBeNull()
    expect(centos9.paths.suexecDocroot).toBe('/var/www')
    expect(centos9.paths.suexecConfigFile).toBeNull()
    expect(centos9.extraSystemUsers).toEqual([])
    expect(centos9.bin.adduser).toBeNull()
  })

  it('maps Remi SCL side-by-side PHP', () => {
    expect(centos9.phpPackages('8.3')).toEqual(expect.arrayContaining(['php83-php-fpm', 'php83-php-cli', 'php83-php-mysqlnd']))
    expect(centos9.phpPackages('7.4')).toContain('php74-php-json')
    expect(centos9.phpFpmService('8.3')).toBe('php83-php-fpm')
    expect(centos9.phpFpmPoolDir('8.3')).toBe('/etc/opt/remi/php83/php-fpm.d')
    expect(centos9.phpBinary('8.3')).toBe('/opt/remi/php83/root/usr/bin/php')
    expect(centos9.phpFpmBinary('8.3')).toBe('/opt/remi/php83/root/usr/sbin/php-fpm')
    expect(centos9.phpIniFile('8.0')).toBe('/etc/opt/remi/php80/php.ini')
  })

  it('finds php-cgi inside the Remi cli package', () => {
    expect(centos9.phpCgiBinary('8.3')).toBe('/opt/remi/php83/root/usr/bin/php-cgi')
    expect(centos10.phpCgiBinary('7.4')).toBe('/opt/remi/php74/root/usr/bin/php-cgi')
    for (const v of SUPPORTED_PHP_VERSIONS) {
      expect(centos9.phpPackages(v)).toContain(`php${v.replace('.', '')}-php-cli`)
      expect(centos9.phpPackages(v).some(n => n.endsWith('-cgi'))).toBe(false)
    }
  })

  it('knows the EL test page and the PostgreSQL data directory', () => {
    expect(centos9.paths.apacheWelcomeConf).toBe('/etc/httpd/conf.d/welcome.conf')
    expect(centos9.paths.postgresqlDataDir).toBe('/var/lib/pgsql/data')
    expect(centos9.bin.a2dissite).toBeNull()
  })

  it('refuses Ubuntu releases', () => {
    expect(code(() => dnfProfile(parseOsRelease(UBUNTU_2404)))).toBe('UNSUPPORTED_OS')
  })
})

describe('every supported profile', () => {
  for (const [name, text] of Object.entries(SUPPORTED_FIXTURES)) {
    const p = profileFor(text)

    it(`${name}: covers every role with valid names`, () => {
      for (const role of PACKAGE_ROLES) {
        const list = p.packages[role]
        expect(Array.isArray(list)).toBe(true)
        if (role !== 'apache-itk') expect(list.length).toBeGreaterThan(0)
        for (const n of list) expect(assertPackageName(p.family, n)).toBe(n)
      }
      for (const role of SERVICE_ROLES) expect(assertUnitName(p.services[role])).toBe(p.services[role])
      for (const n of p.bootstrapPackages) expect(assertPackageName(p.family, n)).toBe(n)
    })

    it(`${name}: uses only absolute paths`, () => {
      for (const [key, value] of Object.entries(p.paths)) {
        if (key === 'apacheUser' || key === 'nginxUser') expect(value).toMatch(/^[a-z][a-z0-9-]*$/)
        else if (value !== null) expect(assertAbsolutePath(value)).toBe(value)
      }
      for (const value of Object.values(p.bin)) if (value !== null) expect(assertAbsolutePath(value)).toBe(value)
      expect(assertAbsolutePath(p.phpFpmSocketDir)).toBe(p.phpFpmSocketDir)
    })

    it(`${name}: produces valid PHP names for every supported version`, () => {
      for (const v of SUPPORTED_PHP_VERSIONS) {
        for (const n of p.phpPackages(v)) expect(assertPackageName(p.family, n)).toBe(n)
        for (const n of p.lsphpPackages(v)) expect(assertPackageName(p.family, n)).toBe(n)
        expect(assertUnitName(p.phpFpmService(v))).toBe(p.phpFpmService(v))
        for (const path of [p.phpBinary(v), p.phpFpmBinary(v), p.phpCgiBinary(v), p.phpFpmPoolDir(v), p.phpIniFile(v), p.lsphpBinary(v)]) {
          expect(assertAbsolutePath(path)).toBe(path)
        }
        // php-cgi sits beside the CLI binary on both families
        const cli = p.phpBinary(v)
        expect(p.phpCgiBinary(v).slice(0, p.phpCgiBinary(v).lastIndexOf('/'))).toBe(cli.slice(0, cli.lastIndexOf('/')))
      }
    })

    it(`${name}: PHP helpers reject hostile versions`, () => {
      for (const v of HOSTILE_VERSIONS) {
        for (const fn of [p.phpPackages, p.phpFpmService, p.phpFpmPoolDir, p.phpBinary, p.phpFpmBinary, p.phpCgiBinary, p.phpIniFile, p.lsphpPackages, p.lsphpBinary]) {
          expect(code(() => fn(v as string))).toBe('VALIDATION')
        }
      }
    })

    it(`${name}: honours the path semantics consumers rely on`, () => {
      // the SSH renderer writes `${sshdConfig}.d/00-xpanel.conf` and runs `sshd -t -f ${sshdConfig}`
      expect(p.paths.sshdConfig).toBe('/etc/ssh/sshd_config')
      expect(`${p.paths.sshdConfig}.d`).toBe(p.paths.sshdConfigDir)
      expect(p.paths.powerdnsConf.startsWith(`${p.paths.powerdnsConfDir}/`)).toBe(true)
      expect(p.paths.powerdnsConf).toMatch(/\/pdns\.conf$/)
      // Nginx never shares an identity with Apache, whose shared children may read docroots
      expect(p.paths.nginxUser).not.toBe(p.paths.apacheUser)
      expect(p.phpFpmSocketDir).toBe('/run/xpanel-fpm')
      for (const u of p.extraSystemUsers) expect(u).toMatch(/^[a-z_][a-z0-9_-]{0,31}$/)
      if (p.extraSystemUsers.length > 0) expect(p.bin.adduser).not.toBeNull()
    })

    it(`${name}: is deeply frozen`, () => {
      expect(Object.isFrozen(p)).toBe(true)
      expect(Object.isFrozen(p.packages)).toBe(true)
      expect(Object.isFrozen(p.packages.nginx)).toBe(true)
      expect(Object.isFrozen(p.paths)).toBe(true)
      expect(() => (p.packages.nginx as string[]).push('evil')).toThrow()
    })
  }

  it('returns fresh PHP arrays so callers cannot poison the profile', () => {
    const a = ubuntu24.phpPackages('8.3')
    a.push('evil')
    expect(ubuntu24.phpPackages('8.3')).not.toContain('evil')
  })
})
