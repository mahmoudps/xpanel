import { fail } from '@xpanel/core'
import type { OsRelease, XpanelOsProfile } from './types.ts'
import { classifyRelease } from './support.ts'
import { XPANEL_FPM_SOCKET_DIR, phpCompact } from './php.ts'
import { deepFreeze } from './freeze.ts'

// Remi SCL naming: php<ver>-php-<module>. curl is part of common; zip is a PECL build;
// php-cgi ships inside the cli package, next to the php binary.
const PHP_MODULES = ['fpm', 'cli', 'common', 'mysqlnd', 'pdo', 'gd', 'mbstring', 'xml', 'intl', 'bcmath', 'soap', 'opcache', 'process', 'pecl-zip', 'sodium']

/** CentOS Stream, AlmaLinux and Rocky Linux 9 / 10. */
export const dnfProfile = (release: OsRelease): XpanelOsProfile => {
  const os = classifyRelease(release)
  if (os.family !== 'rhel') return fail('UNSUPPORTED_OS', `${os.id} ${os.versionId} does not use dnf`, { id: os.id, versionId: os.versionId })
  // EL10 dropped Redis for its fork Valkey
  const redis = os.major >= 10 ? 'valkey' : 'redis'
  const scl = (v: string): string => `php${phpCompact(v)}`
  return deepFreeze<XpanelOsProfile>({
    family: 'rhel',
    id: os.id,
    versionId: os.versionId,
    major: os.major,
    codename: '',
    packageManager: 'dnf',
    bootstrapPackages: ['dnf-plugins-core'],
    // the nginx and httpd packages create their own users
    extraSystemUsers: [],
    packages: {
      nginx: ['nginx'],
      apache: ['httpd', 'mod_ssl'],
      openlitespeed: ['openlitespeed'],
      mariadb: ['mariadb-server'],
      postgresql: ['postgresql-server'],
      postfix: ['postfix'],
      dovecot: ['dovecot', 'dovecot-pigeonhole'],
      powerdns: ['pdns', 'pdns-backend-postgresql'],
      redis: [redis],
      ftp: ['pure-ftpd'],
      sshd: ['openssh-server'],
      nftables: ['nftables'],
      // no maintained mpm-itk build exists in EL9/EL10 base or EPEL; see itkAvailable()
      'apache-itk': [],
      // suexec ships inside httpd itself
      'apache-suexec': ['httpd'],
      'apache-fcgi': ['mod_fcgid'],
      quota: ['quota'],
      acme: ['certbot'],
      modsecurity: ['mod_security', 'mod_security_crs'],
    },
    services: {
      nginx: 'nginx',
      apache: 'httpd',
      openlitespeed: 'lshttpd',
      mariadb: 'mariadb',
      postgresql: 'postgresql',
      postfix: 'postfix',
      dovecot: 'dovecot',
      powerdns: 'pdns',
      redis,
      ftp: 'pure-ftpd',
      sshd: 'sshd',
      nftables: 'nftables',
    },
    phpPackages: v => {
      const p = scl(v)
      return [...PHP_MODULES.map(m => `${p}-php-${m}`), ...(p === 'php74' ? ['php74-php-json'] : [])]
    },
    phpFpmService: v => `${scl(v)}-php-fpm`,
    phpFpmPoolDir: v => `/etc/opt/remi/${scl(v)}/php-fpm.d`,
    phpFpmSocketDir: XPANEL_FPM_SOCKET_DIR,
    phpBinary: v => `/opt/remi/${scl(v)}/root/usr/bin/php`,
    phpFpmBinary: v => `/opt/remi/${scl(v)}/root/usr/sbin/php-fpm`,
    phpCgiBinary: v => `/opt/remi/${scl(v)}/root/usr/bin/php-cgi`,
    phpIniFile: v => `/etc/opt/remi/${scl(v)}/php.ini`,
    lsphpPackages: v => {
      const c = phpCompact(v)
      return [`lsphp${c}`, `lsphp${c}-common`, `lsphp${c}-mysqlnd`]
    },
    lsphpBinary: v => `/usr/local/lsws/lsphp${phpCompact(v)}/bin/lsphp`,
    sshSocketUnit: null,
    paths: {
      apacheRoot: '/etc/httpd',
      apacheVhostDir: '/etc/httpd/conf.d',
      apacheModulesConf: '/etc/httpd/conf.modules.d',
      apacheUser: 'apache',
      apacheCtl: '/usr/sbin/apachectl',
      nginxRoot: '/etc/nginx',
      nginxVhostDir: '/etc/nginx/conf.d',
      nginxUser: 'nginx',
      olsRoot: '/usr/local/lsws',
      // compiled into the EL httpd suexec binary (AP_DOC_ROOT); cannot be changed by config
      suexecDocroot: '/var/www',
      systemdDir: '/etc/systemd/system',
      nftablesConf: '/etc/sysconfig/nftables.conf',
      sshdConfig: '/etc/ssh/sshd_config',
      powerdnsConf: '/etc/pdns/pdns.conf',
      postfixDir: '/etc/postfix',
      dovecotDir: '/etc/dovecot',
      apacheMainConf: '/etc/httpd/conf/httpd.conf',
      apachePortsConf: '/etc/httpd/conf/httpd.conf',
      // mod_ssl ships `Listen 443 https` here
      apacheSslConf: '/etc/httpd/conf.d/ssl.conf',
      // its <LocationMatch "^/+$"> serves the distribution test page on every vhost without an index
      apacheWelcomeConf: '/etc/httpd/conf.d/welcome.conf',
      apacheSitesAvailableDir: null,
      apacheLogDir: '/var/log/httpd',
      nginxLogDir: '/var/log/nginx',
      suexecConfigFile: null,
      sshdConfigDir: '/etc/ssh/sshd_config.d',
      powerdnsConfDir: '/etc/pdns',
      postgresqlDataDir: '/var/lib/pgsql/data',
    },
    bin: {
      env: '/usr/bin/env',
      systemctl: '/usr/bin/systemctl',
      nginx: '/usr/sbin/nginx',
      aptGet: null,
      addAptRepository: null,
      a2enmod: null,
      a2dismod: null,
      a2disconf: null,
      a2dissite: null,
      adduser: null,
      dnf: '/usr/bin/dnf',
      postgresqlSetup: '/usr/bin/postgresql-setup',
    },
  })
}
