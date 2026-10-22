// Test fixtures shared by the system renderer tests. Not exported from the package.

import type { Account, FirewallRule, OsProfile, PackageRole, Plan, ResourceLimits, ServiceRole } from '@xpanel/core'

const SERVICE_ROLES: ServiceRole[] = [
  'nginx', 'apache', 'openlitespeed', 'mariadb', 'postgresql', 'postfix', 'dovecot', 'powerdns', 'redis', 'ftp', 'sshd', 'nftables',
]
const PACKAGE_ROLES: PackageRole[] = [...SERVICE_ROLES, 'apache-itk', 'apache-suexec', 'apache-fcgi', 'quota', 'acme', 'modsecurity']

const roles = <K extends string>(keys: K[], f: (k: K) => string): Record<K, string> =>
  Object.fromEntries(keys.map((k) => [k, f(k)])) as Record<K, string>

export const debianOs: OsProfile = {
  family: 'debian',
  id: 'ubuntu',
  versionId: '24.04',
  packageManager: 'apt',
  packages: Object.fromEntries(PACKAGE_ROLES.map((r) => [r, [r]])) as Record<PackageRole, string[]>,
  services: { ...roles(SERVICE_ROLES, (r) => r), apache: 'apache2', sshd: 'ssh' },
  phpPackages: (v) => [`php${v}-fpm`],
  phpFpmService: (v) => `php${v}-fpm`,
  phpFpmPoolDir: (v) => `/etc/php/${v}/fpm/pool.d`,
  phpFpmSocketDir: '/run/php',
  phpBinary: (v) => `/usr/bin/php${v}`,
  paths: {
    apacheRoot: '/etc/apache2',
    apacheVhostDir: '/etc/apache2/sites-enabled',
    apacheModulesConf: '/etc/apache2/mods-enabled',
    apacheUser: 'www-data',
    apacheCtl: '/usr/sbin/apachectl',
    nginxRoot: '/etc/nginx',
    nginxVhostDir: '/etc/nginx/conf.d',
    nginxUser: 'www-data',
    olsRoot: '/usr/local/lsws',
    suexecDocroot: '/home',
    systemdDir: '/etc/systemd/system',
    nftablesConf: '/etc/nftables.conf',
    sshdConfig: '/etc/ssh/sshd_config',
    powerdnsConf: '/etc/powerdns/pdns.conf',
    postfixDir: '/etc/postfix',
    dovecotDir: '/etc/dovecot',
  },
}

export const rhelOs: OsProfile = {
  ...debianOs,
  family: 'rhel',
  id: 'centos',
  versionId: '9',
  packageManager: 'dnf',
  services: { ...roles(SERVICE_ROLES, (r) => r), apache: 'httpd', sshd: 'sshd' },
  phpPackages: (v) => [`php${v.replace('.', '')}-php-fpm`],
  phpFpmService: (v) => `php${v.replace('.', '')}-php-fpm`,
  phpFpmPoolDir: (v) => `/etc/opt/remi/php${v.replace('.', '')}/php-fpm.d`,
  phpFpmSocketDir: '/run/php-fpm',
  phpBinary: (v) => `/opt/remi/php${v.replace('.', '')}/root/usr/bin/php`,
  paths: {
    ...debianOs.paths,
    apacheRoot: '/etc/httpd',
    apacheVhostDir: '/etc/httpd/conf.d',
    apacheModulesConf: '/etc/httpd/conf.modules.d',
    apacheUser: 'apache',
    nginxUser: 'nginx',
    nftablesConf: '/etc/sysconfig/nftables.conf',
    powerdnsConf: '/etc/pdns/pdns.conf',
  },
}

export const limited: ResourceLimits = {
  diskMb: 10240,
  bandwidthMbMonth: 102400,
  ioReadBps: 10485760,
  ioWriteBps: 5242880,
  ioReadIops: 1000,
  ioWriteIops: 500,
  memoryMb: 1024,
  maxProcesses: 100,
  cpuPercent: 150,
}

export const unlimited: ResourceLimits = {
  diskMb: 'unlimited',
  bandwidthMbMonth: 'unlimited',
  ioReadBps: 'unlimited',
  ioWriteBps: 'unlimited',
  ioReadIops: 'unlimited',
  ioWriteIops: 'unlimited',
  memoryMb: 'unlimited',
  maxProcesses: 'unlimited',
  cpuPercent: 'unlimited',
}

export const makeAccount = (o: Partial<Account> = {}): Account => ({
  id: 'acc-1',
  username: 'alice',
  uid: 1001,
  gid: 1001,
  home: '/home/alice',
  primaryDomain: 'alice.example',
  planId: 'plan-1',
  ownerId: null,
  status: 'active',
  suspendReason: null,
  contactEmail: 'alice@example.com',
  ipv4: '192.0.2.10',
  shell: 'none',
  createdAt: '2026-10-22T00:00:00Z',
  ...o,
})

export const makePlan = (o: Partial<Plan> = {}): Plan => ({
  id: 'plan-1',
  name: 'Basic',
  ownerId: null,
  featureListId: 'fl-1',
  resources: limited,
  caps: {
    addonDomains: 1, aliasDomains: 1, subdomains: 5, mailboxes: 5, forwarders: 5,
    mailingLists: 0, ftpAccounts: 1, databases: 2, phpWorkers: 5,
  },
  dedicatedIp: false,
  shell: 'none',
  defaultMailboxQuotaMb: 1024,
  ...o,
})

export const rule = (o: Partial<FirewallRule> & Pick<FirewallRule, 'id' | 'kind'>): FirewallRule => ({
  action: 'accept',
  protocol: null,
  port: null,
  source: null,
  forwardTo: null,
  list: null,
  comment: '',
  enabled: true,
  ...o,
})

/** The value of every `Key=` line in a unit file, in order. */
export const unitValues = (content: string, key: string): string[] =>
  content.split('\n').filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1))
