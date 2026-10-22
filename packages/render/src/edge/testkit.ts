// Fixtures for the edge tests. Not exported from the package.
import type { Account, Certificate, Domain, OsProfile, PackageRole, PhpSettings, ServerSettings, ServiceRole } from '@xpanel/core'

const services: Record<ServiceRole, string> = {
  nginx: 'nginx',
  apache: 'apache2',
  openlitespeed: 'lsws',
  mariadb: 'mariadb',
  postgresql: 'postgresql',
  postfix: 'postfix',
  dovecot: 'dovecot',
  powerdns: 'pdns',
  redis: 'redis-server',
  ftp: 'pure-ftpd',
  sshd: 'ssh',
  nftables: 'nftables',
}

const packages = Object.fromEntries(
  ['nginx', 'apache', 'openlitespeed', 'mariadb', 'postgresql', 'postfix', 'dovecot', 'powerdns', 'redis', 'ftp', 'sshd',
    'nftables', 'apache-itk', 'apache-suexec', 'apache-fcgi', 'quota', 'acme', 'modsecurity'].map((r) => [r, [r]]),
) as Record<PackageRole, string[]>

export const debianOs: OsProfile = {
  family: 'debian',
  id: 'ubuntu',
  versionId: '24.04',
  packageManager: 'apt',
  packages,
  services,
  phpPackages: (v) => [`php${v}-fpm`, `php${v}-cgi`],
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
    suexecDocroot: '/var/www',
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
  services: { ...services, apache: 'httpd', redis: 'redis', sshd: 'sshd' },
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
  },
}

export const settings = (over: Partial<ServerSettings> = {}): ServerSettings => ({
  hostname: 'server1.host.example',
  nameservers: ['ns1.host.example', 'ns2.host.example'],
  adminEmail: 'admin@host.example',
  engine: 'apache',
  apacheMpm: 'itk',
  panelPort: 2087,
  sshPort: 22,
  nginx: { workerProcesses: 'auto', workerConnections: 4096, workerRlimitNofile: 65535, multiAccept: true, keepaliveTimeoutSec: 30 },
  apache: { startServers: 5, minSpareServers: 5, maxSpareServers: 10, maxRequestWorkers: 150, maxConnectionsPerChild: 0, serverLimit: 256 },
  backendPort: 8080,
  backendTlsPort: 8443,
  ...over,
})

export const account = (over: Partial<Account> = {}): Account => ({
  id: 'acc1',
  username: 'alice',
  uid: 1001,
  gid: 1001,
  home: '/home/alice',
  primaryDomain: 'example.com',
  planId: 'plan1',
  ownerId: null,
  status: 'active',
  suspendReason: null,
  contactEmail: 'alice@example.com',
  ipv4: '203.0.113.10',
  shell: 'none',
  createdAt: '2026-10-01T00:00:00Z',
  ...over,
})

export const php = (over: Partial<PhpSettings> = {}): PhpSettings => ({
  version: '8.3',
  handler: 'fpm',
  fpm: {
    mode: 'ondemand',
    maxChildren: 5,
    startServers: 2,
    minSpareServers: 1,
    maxSpareServers: 3,
    maxRequests: 500,
    processIdleTimeoutSec: 10,
  },
  ini: {},
  ...over,
})

export const domain = (over: Partial<Domain> = {}): Domain => ({
  id: 'd1',
  accountId: 'acc1',
  name: 'example.com',
  kind: 'primary',
  parentId: null,
  docRoot: '/home/alice/public_html',
  siteType: 'php',
  upstream: null,
  redirect: null,
  php: php(),
  wildcard: false,
  certificateId: null,
  suspended: false,
  expiresAt: null,
  pathQuotaMb: 'unlimited',
  ...over,
})

export const cert = (over: Partial<Certificate> = {}): Certificate => ({
  id: 'cert1',
  accountId: 'acc1',
  names: ['example.com', '*.example.com'],
  source: 'acme',
  challenge: 'dns-01',
  notAfter: '2027-01-01T00:00:00Z',
  autoRenew: true,
  ...over,
})

/** Runs fn and returns the thrown XpanelError code, or null. */
export const codeOf = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    return (e as { code?: string }).code ?? 'NON_XPANEL_ERROR'
  }
}

/** Lines of `text` inside the first `head {` block, balanced by braces. */
export const blockOf = (text: string, head: string): string => {
  const start = text.indexOf(`${head} {`)
  if (start < 0) return ''
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return text.slice(start)
}

/** Every `server { ... }` block. */
export const serverBlocks = (text: string): string[] => {
  const out: string[] = []
  let rest = text
  for (;;) {
    const b = blockOf(rest, 'server')
    if (!b) return out
    out.push(b)
    rest = rest.slice(rest.indexOf(b) + b.length)
  }
}
