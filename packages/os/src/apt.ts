import { fail } from '@xpanel/core'
import type { OsRelease, XpanelOsProfile } from './types.ts'
import { classifyRelease } from './support.ts'
import { XPANEL_FPM_SOCKET_DIR, assertPhpVersion, phpCompact } from './php.ts'
import { deepFreeze } from './freeze.ts'

// ondrej/php naming: php<ver>-<module>. json is built in from 8.0. cgi ships php-cgi<ver>, which the
// cgi, fcgid and suphp handler wrappers execute; Debian packages it apart from the CLI.
const PHP_MODULES = ['fpm', 'cgi', 'cli', 'common', 'mysql', 'curl', 'gd', 'mbstring', 'xml', 'zip', 'intl', 'bcmath', 'soap', 'opcache', 'readline', 'sqlite3']
// the archive's PostgreSQL major per LTS (postgresql-common keeps clusters in /var/lib/postgresql/<major>/main)
const POSTGRESQL_MAJOR: Readonly<Record<string, number>> = { '22.04': 14, '24.04': 16 }

const postgresqlMajor = (versionId: string): number =>
  POSTGRESQL_MAJOR[versionId] ?? fail('UNSUPPORTED_OS', `no PostgreSQL release is known for Ubuntu ${versionId}`, { versionId })

/** Ubuntu 22.04 / 24.04. */
export const aptProfile = (release: OsRelease): XpanelOsProfile => {
  const os = classifyRelease(release)
  if (os.family !== 'debian') return fail('UNSUPPORTED_OS', `${os.id} ${os.versionId} does not use apt`, { id: os.id, versionId: os.versionId })
  const php = (v: string): string => assertPhpVersion(v)
  return deepFreeze<XpanelOsProfile>({
    family: 'debian',
    id: os.id,
    versionId: os.versionId,
    major: os.major,
    codename: os.codename,
    packageManager: 'apt',
    // add-apt-repository imports the PPA signing key with gpg; adduser creates the nginx user
    bootstrapPackages: ['software-properties-common', 'ca-certificates', 'gnupg', 'adduser', 'acl'],
    // Ubuntu's nginx runs as www-data, Apache's user; a separate identity keeps Nginx out of
    // anything Apache's shared children can read (temp bodies, cache, prefork docroots)
    extraSystemUsers: ['nginx'],
    packages: {
      nginx: ['nginx'],
      apache: ['apache2'],
      openlitespeed: ['openlitespeed'],
      mariadb: ['mariadb-server'],
      postgresql: ['postgresql'],
      postfix: ['postfix'],
      dovecot: ['dovecot-core', 'dovecot-imapd', 'dovecot-pop3d', 'dovecot-lmtpd', 'dovecot-sieve', 'dovecot-managesieved'],
      // The reconciler publishes BIND zone files; include its candidate validator and observer.
      powerdns: ['pdns-server', 'pdns-backend-bind', 'bind9-utils', 'dnsutils'],
      redis: ['redis-server'],
      // PureDB virtual users carry the account UID/GID, so FTP logins map onto the account
      ftp: ['pure-ftpd'],
      sshd: ['openssh-server'],
      nftables: ['nftables'],
      'apache-itk': ['libapache2-mpm-itk'],
      'apache-suexec': ['apache2-suexec-custom'],
      'apache-fcgi': ['libapache2-mod-fcgid'],
      quota: ['quota'],
      acme: ['certbot'],
      modsecurity: ['libapache2-mod-security2', 'modsecurity-crs'],
    },
    services: {
      nginx: 'nginx',
      apache: 'apache2',
      openlitespeed: 'lshttpd',
      mariadb: 'mariadb',
      postgresql: 'postgresql',
      postfix: 'postfix',
      dovecot: 'dovecot',
      powerdns: 'pdns',
      redis: 'redis-server',
      ftp: 'pure-ftpd',
      sshd: 'ssh',
      nftables: 'nftables',
    },
    phpPackages: v => {
      const ver = php(v)
      return [...PHP_MODULES.map(m => `php${ver}-${m}`), ...(ver === '7.4' ? ['php7.4-json'] : [])]
    },
    phpFpmService: v => `php${php(v)}-fpm`,
    phpFpmPoolDir: v => `/etc/php/${php(v)}/fpm/pool.d`,
    phpFpmSocketDir: XPANEL_FPM_SOCKET_DIR,
    phpBinary: v => `/usr/bin/php${php(v)}`,
    phpFpmBinary: v => `/usr/sbin/php-fpm${php(v)}`,
    phpCgiBinary: v => `/usr/bin/php-cgi${php(v)}`,
    phpIniFile: v => `/etc/php/${php(v)}/fpm/php.ini`,
    lsphpPackages: v => {
      const c = phpCompact(v)
      return [`lsphp${c}`, `lsphp${c}-common`, `lsphp${c}-mysql`]
    },
    lsphpBinary: v => `/usr/local/lsws/lsphp${phpCompact(v)}/bin/lsphp`,
    sshSocketUnit: os.versionId === '24.04' ? 'ssh.socket' : null,
    paths: {
      apacheRoot: '/etc/apache2',
      // renderers write real files here: apache2.conf includes sites-enabled, never sites-available
      apacheVhostDir: '/etc/apache2/sites-enabled',
      // apache2.conf includes mods-enabled/*.load and *.conf, the counterpart of conf.modules.d
      apacheModulesConf: '/etc/apache2/mods-enabled',
      apacheUser: 'www-data',
      apacheCtl: '/usr/sbin/apachectl',
      nginxRoot: '/etc/nginx',
      nginxVhostDir: '/etc/nginx/conf.d',
      nginxUser: 'nginx',
      olsRoot: '/usr/local/lsws',
      // apache2-suexec-custom reads its docroot from suexecConfigFile; the installer writes /home there
      suexecDocroot: '/home',
      systemdDir: '/etc/systemd/system',
      nftablesConf: '/etc/nftables.conf',
      // main files; consumers derive drop-ins as `${sshdConfig}.d` and test with `sshd -t -f`
      sshdConfig: '/etc/ssh/sshd_config',
      powerdnsConf: '/etc/powerdns/pdns.conf',
      postfixDir: '/etc/postfix',
      dovecotDir: '/etc/dovecot',
      apacheMainConf: '/etc/apache2/apache2.conf',
      apachePortsConf: '/etc/apache2/ports.conf',
      apacheSslConf: null,
      // the Debian counterpart, sites-enabled/000-default.conf, is disabled with a2dissite instead
      apacheWelcomeConf: null,
      apacheSitesAvailableDir: '/etc/apache2/sites-available',
      apacheLogDir: '/var/log/apache2',
      nginxLogDir: '/var/log/nginx',
      suexecConfigFile: '/etc/apache2/suexec/www-data',
      sshdConfigDir: '/etc/ssh/sshd_config.d',
      powerdnsConfDir: '/etc/powerdns',
      postgresqlDataDir: `/var/lib/postgresql/${postgresqlMajor(os.versionId)}/main`,
    },
    bin: {
      env: '/usr/bin/env',
      systemctl: '/usr/bin/systemctl',
      nginx: '/usr/sbin/nginx',
      aptGet: '/usr/bin/apt-get',
      addAptRepository: '/usr/bin/add-apt-repository',
      a2enmod: '/usr/sbin/a2enmod',
      a2dismod: '/usr/sbin/a2dismod',
      a2disconf: '/usr/sbin/a2disconf',
      a2dissite: '/usr/sbin/a2dissite',
      adduser: '/usr/sbin/adduser',
      dnf: null,
      postgresqlSetup: null,
    },
  })
}
