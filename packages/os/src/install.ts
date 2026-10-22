import { fail } from '@xpanel/core'
import type { ApacheMpm, Engine, OsProfile, PackageRole, RenderedFile, ServiceRole } from '@xpanel/core'
import { assertPhpVersionList } from './php.ts'
import type { PhpVersion } from './php.ts'
import { assertAbsolutePath, assertPackageName, assertSafeArgv, assertTrustedPackageUrl, assertUnitName, preview } from './validate.ts'
import type {
  InstallAction,
  InstallBundle,
  InstallOptions,
  InstallWarning,
  ResolvedInstallOptions,
  XpanelOsProfile,
} from './types.ts'

type Verb = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable'

export const ONDREJ_PHP_PPA = 'ppa:ondrej/php'
const EPEL = 'https://dl.fedoraproject.org/pub/epel'
const REMI = 'https://rpms.remirepo.net/enterprise'
// Everything the edge renderer's requiredApacheModules() can ask for. EL loads all of them from
// conf.modules.d by default; Debian leaves actions, cgi, suexec, proxy_fcgi and friends off.
const DEBIAN_APACHE_MODULES = [
  'alias', 'dir', 'mime', 'authz_core', 'authz_host', 'setenvif', 'rewrite', 'headers', 'remoteip', 'ssl',
  'proxy', 'proxy_fcgi', 'actions', 'cgi', 'suexec', 'fcgid',
]
// status.conf serves /server-status to `Require local`, and every tenant process can reach the
// loopback backend directly: it would list all accounts' requests
const DEBIAN_DISABLED_MODULES = ['status']
// serve-cgi-bin.conf puts a server-wide `ScriptAlias /cgi-bin/ /usr/lib/cgi-bin/` into every vhost once mod_cgi loads
const DEBIAN_DISABLED_CONFS = ['serve-cgi-bin']
// the stock *:80 vhost on /var/www/html; xPanel's base config owns the default site
const DEBIAN_DISABLED_SITES = ['000-default']
// unattended-upgrades often holds the dpkg lock on a freshly booted host
const DPKG_LOCK_TIMEOUT_SEC = 600
const SYSTEM_USER = /^[a-z_][a-z0-9_-]{0,31}$/
const BASE_ROLES: readonly PackageRole[] = ['mariadb', 'postgresql', 'redis', 'sshd', 'nftables', 'quota', 'acme']
/** started right away: the panel needs its databases before the first reconcile */
const DATA_SERVICES: readonly ServiceRole[] = ['mariadb', 'postgresql', 'redis']
const OPTION_KEYS = new Set(['engine', 'phpVersions', 'withMail', 'withDns', 'withFtp', 'apacheMpm', 'withModSecurity', 'withMariaDb'])

type ExtendedInstallOptions = InstallOptions & { withMariaDb?: boolean }
type ExtendedResolvedInstallOptions = ResolvedInstallOptions & { withMariaDb?: boolean }

export const itkAvailable = (profile: OsProfile): boolean => profile.packages['apache-itk'].length > 0

// ---------- options ----------

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const flag = (o: Record<string, unknown>, key: string, fallback?: boolean): boolean => {
  const v = o[key]
  if (v === undefined && fallback !== undefined) return fallback
  return typeof v === 'boolean' ? v : fail('VALIDATION', `${key} must be a boolean`, { field: key, value: preview(v) })
}

/** Strict validation of hostile input: unknown keys, wrong types and bad versions are rejected. */
export const resolveInstallOptions = (raw: unknown): ExtendedResolvedInstallOptions => {
  if (!isPlainObject(raw)) return fail('VALIDATION', 'install options must be a plain object')
  const extra = Object.keys(raw).filter(k => !OPTION_KEYS.has(k))
  if (extra.length > 0) return fail('VALIDATION', 'unknown install options', { fields: extra.slice(0, 8).map(preview) })
  const engine: Engine = raw.engine === 'apache' || raw.engine === 'openlitespeed'
    ? raw.engine
    : fail('VALIDATION', 'engine must be apache or openlitespeed', { engine: preview(raw.engine) })
  const mpm = raw.apacheMpm === undefined ? 'itk' : raw.apacheMpm
  const apacheMpm: ApacheMpm = mpm === 'itk' || mpm === 'prefork'
    ? mpm
    : fail('VALIDATION', 'apacheMpm must be itk or prefork', { apacheMpm: preview(mpm) })
  const withMariaDb = raw.withMariaDb !== undefined ? flag(raw, 'withMariaDb', true) : undefined
  return {
    engine,
    phpVersions: assertPhpVersionList(raw.phpVersions),
    withMail: flag(raw, 'withMail'),
    withDns: flag(raw, 'withDns'),
    withFtp: flag(raw, 'withFtp'),
    apacheMpm,
    withModSecurity: flag(raw, 'withModSecurity', false),
    ...(withMariaDb !== undefined ? { withMariaDb } : {}),
  }
}

const assertProfile = (p: XpanelOsProfile): void => {
  const ok = p !== null && typeof p === 'object' && p.bin !== null && typeof p.bin === 'object' &&
    ((p.family === 'debian' && p.packageManager === 'apt') ||
      (p.family === 'rhel' && p.packageManager === 'dnf' && (p.major === 9 || p.major === 10)))
  if (!ok) fail('UNSUPPORTED_OS', 'not an xPanel OS profile; resolve one with profileFor()')
}

const assertMpmAvailable = (p: XpanelOsProfile, mpm: ApacheMpm): void => {
  if (mpm === 'itk' && !itkAvailable(p)) {
    fail('ENGINE_UNAVAILABLE', `Apache mpm_itk is not packaged for ${p.id} ${p.versionId}`, {
      engine: 'apache',
      apacheMpm: 'itk',
      os: `${p.id} ${p.versionId}`,
      alternatives: ['apacheMpm: prefork (Apache children keep the shared apache identity)'],
    })
  }
}

const assertEngineAvailable = (p: XpanelOsProfile, o: ResolvedInstallOptions): void => {
  if (o.engine === 'openlitespeed') {
    fail('ENGINE_UNAVAILABLE', 'OpenLiteSpeed needs the LiteSpeed vendor repository, which the install planner cannot set up yet', {
      engine: 'openlitespeed',
      reason: 'vendor-repository',
    })
  }
  assertMpmAvailable(p, o.apacheMpm)
}

const prepare = (profile: XpanelOsProfile, options: ExtendedInstallOptions): ExtendedResolvedInstallOptions => {
  assertProfile(profile)
  const o = resolveInstallOptions(options)
  assertEngineAvailable(profile, o)
  return o
}

// ---------- action builders ----------

const requireBin = (path: string | null, name: string): string =>
  path === null ? fail('UNSUPPORTED_OS', `${name} is not available on this OS profile`) : assertAbsolutePath(path)

const exec = (argv: string[], creates?: string): InstallAction =>
  creates === undefined
    ? { kind: 'exec', argv: assertSafeArgv(argv) }
    : { kind: 'exec', argv: assertSafeArgv(argv), creates: assertAbsolutePath(creates) }

const systemd = (verb: Verb, unit: string): InstallAction => ({ kind: 'systemd', verb, unit: assertUnitName(unit) })

const assertSystemUser = (name: unknown): string =>
  typeof name === 'string' && SYSTEM_USER.test(name) ? name : fail('VALIDATION', 'invalid system user name', { user: preview(name) })

const unique = (xs: readonly string[]): string[] => [...new Set(xs)]
const without = (xs: readonly string[], drop: readonly string[]): string[] => xs.filter(x => !drop.includes(x))
const rolePackages = (p: OsProfile, roles: readonly PackageRole[]): string[] => roles.flatMap(r => p.packages[r])
const phpPackages = (p: OsProfile, versions: readonly PhpVersion[]): string[] => versions.flatMap(v => p.phpPackages(v))

const aptGet = (p: XpanelOsProfile) => {
  const bin = requireBin(p.bin.aptGet, 'apt-get')
  // needrestart's apt hook would otherwise restart services on its own; the plan decides what runs
  const env = [p.bin.env, 'DEBIAN_FRONTEND=noninteractive', 'NEEDRESTART_MODE=l', bin]
  return {
    update: (): InstallAction => exec([...env, 'update']),
    install: (names: readonly string[]): InstallAction[] =>
      names.length === 0
        ? []
        : [exec([
            ...env, '-y',
            '-o', `DPkg::Lock::Timeout=${DPKG_LOCK_TIMEOUT_SEC}`,
            '-o', 'Dpkg::Options::=--force-confdef',
            '-o', 'Dpkg::Options::=--force-confold',
            'install', '--no-install-recommends',
            ...names.map(n => assertPackageName('debian', n)),
          ])],
  }
}

const dnf = (p: XpanelOsProfile) => {
  const bin = requireBin(p.bin.dnf, 'dnf')
  return {
    bin,
    install: (names: readonly string[], urls: readonly string[] = []): InstallAction[] =>
      names.length + urls.length === 0
        ? []
        : [exec([
            bin, 'install', '-y', '--setopt=install_weak_deps=False',
            ...names.map(n => assertPackageName('rhel', n)),
            ...urls.map(assertTrustedPackageUrl),
          ])],
  }
}

// ---------- repositories ----------

const debianRepos = (p: XpanelOsProfile, php: boolean): InstallAction[] => {
  const apt = aptGet(p)
  const addRepo = [p.bin.env, 'LC_ALL=C.UTF-8', requireBin(p.bin.addAptRepository, 'add-apt-repository'), '-y', '-n']
  return [
    apt.update(),
    ...apt.install(p.bootstrapPackages),
    // itk, pdns, pure-ftpd and certbot live in universe
    exec([...addRepo, 'universe']),
    ...(php ? [exec([...addRepo, ONDREJ_PHP_PPA])] : []),
    apt.update(),
  ]
}

/** EPEL per its getting-started guide: CentOS Stream uses the release RPMs, the rebuilds ship epel-release in extras. */
const epelSource = (p: XpanelOsProfile): { names: string[]; urls: string[] } =>
  p.id === 'centos'
    ? {
        names: [],
        urls: [
          `${EPEL}/epel-release-latest-${p.major}.noarch.rpm`,
          ...(p.major === 9 ? [`${EPEL}/epel-next-release-latest-9.noarch.rpm`] : []),
        ],
      }
    : { names: ['epel-release'], urls: [] }

const rhelRepos = (p: XpanelOsProfile, php: boolean): InstallAction[] => {
  const d = dnf(p)
  const epel = epelSource(p)
  return [
    ...d.install(p.bootstrapPackages),
    // CRB (formerly PowerTools) carries build deps that EPEL packages link against
    exec([d.bin, 'config-manager', '--set-enabled', 'crb']),
    ...d.install(epel.names, epel.urls),
    // remi-release requires epel-release, so it comes after EPEL
    ...(php ? d.install([], [`${REMI}/remi-release-${p.major}.rpm`]) : []),
  ]
}

// ---------- packages and services ----------

const engineRoles = (o: ResolvedInstallOptions): PackageRole[] => {
  const roles: PackageRole[] = ['apache']
  if (o.apacheMpm === 'itk') roles.push('apache-itk')
  roles.push('apache-suexec', 'apache-fcgi')
  if (o.withModSecurity) roles.push('modsecurity')
  return roles
}

const optionalRoles = (o: ResolvedInstallOptions): ServiceRole[] => {
  const roles: ServiceRole[] = []
  if (o.withMail) roles.push('postfix', 'dovecot')
  if (o.withDns) roles.push('powerdns')
  if (o.withFtp) roles.push('ftp')
  return roles
}

const baseRoles = (o: ExtendedResolvedInstallOptions): readonly PackageRole[] =>
  o.withMariaDb === false ? BASE_ROLES.filter(r => r !== 'mariadb') : BASE_ROLES

const dataServices = (o: ExtendedResolvedInstallOptions): readonly ServiceRole[] =>
  o.withMariaDb === false ? DATA_SERVICES.filter(r => r !== 'mariadb') : DATA_SERVICES

/** sshd is never touched: the installer itself usually runs over SSH. nftables is enabled, not started, until xPanel's ruleset exists. */
const serviceActions = (p: XpanelOsProfile, o: ExtendedResolvedInstallOptions): InstallAction[] => {
  const enabled: ServiceRole[] = ['nginx', 'apache', ...dataServices(o), 'nftables', ...optionalRoles(o)]
  return [
    ...enabled.map(r => systemd('enable', p.services[r])),
    ...dataServices(o).map(r => systemd('start', p.services[r])),
  ]
}

/** xPanel runs one FPM master per account in its slice; the distro master and its shared www pool stay off. */
const distroFpmOff = (p: XpanelOsProfile, versions: readonly PhpVersion[]): InstallAction[] =>
  versions.flatMap(v => [systemd('stop', p.phpFpmService(v)), systemd('disable', p.phpFpmService(v))])

/**
 * MPM selection for a fresh install. Debian switches with a2dismod/a2enmod (mpm_itk sits on prefork);
 * EL selects the MPM through the 00-mpm.conf file from apacheMpmFiles(). itk where it is not packaged
 * throws ENGINE_UNAVAILABLE instead of falling back to the shared apache identity.
 */
export const apacheMpmActions = (profile: XpanelOsProfile, mpm: ApacheMpm): InstallAction[] => {
  assertProfile(profile)
  assertMpmAvailable(profile, mpm)
  if (profile.family === 'rhel') return []
  const en = requireBin(profile.bin.a2enmod, 'a2enmod')
  const dis = requireBin(profile.bin.a2dismod, 'a2dismod')
  return [
    exec([dis, 'mpm_event', 'mpm_worker']),
    exec([en, 'mpm_prefork']),
    ...(mpm === 'itk' ? [exec([en, 'mpm_itk'])] : []),
  ]
}

export const apacheMpmFiles = (profile: XpanelOsProfile, mpm: ApacheMpm): RenderedFile[] => {
  assertProfile(profile)
  assertMpmAvailable(profile, mpm)
  if (profile.family === 'debian') return []
  return [{
    path: assertAbsolutePath(`${profile.paths.apacheModulesConf}/00-mpm.conf`),
    content: '# Managed by xPanel: Apache MPM selection.\nLoadModule mpm_prefork_module modules/mod_mpm_prefork.so\n',
    mode: 0o644,
    owner: 'root',
    group: 'root',
  }]
}

/** Debian's a2* tools exit 0 when a module, conf or site is already in the requested state. */
const apacheModuleActions = (p: XpanelOsProfile): InstallAction[] =>
  p.family === 'debian'
    ? [
        exec([requireBin(p.bin.a2enmod, 'a2enmod'), ...DEBIAN_APACHE_MODULES]),
        exec([requireBin(p.bin.a2dismod, 'a2dismod'), ...DEBIAN_DISABLED_MODULES]),
        exec([requireBin(p.bin.a2disconf, 'a2disconf'), ...DEBIAN_DISABLED_CONFS]),
        exec([requireBin(p.bin.a2dissite, 'a2dissite'), ...DEBIAN_DISABLED_SITES]),
      ]
    : []

/** adduser --system is idempotent: it exits 0 when the system user already exists. */
const systemUserActions = (p: XpanelOsProfile): InstallAction[] => {
  if (p.extraSystemUsers.length === 0) return []
  const adduser = requireBin(p.bin.adduser, 'adduser')
  return unique(p.extraSystemUsers).map(name => exec([
    adduser, '--system', '--group', '--no-create-home', '--home', '/nonexistent', '--shell', '/usr/sbin/nologin', '--quiet',
    assertSystemUser(name),
  ]))
}

const debianPlan = (p: XpanelOsProfile, o: ExtendedResolvedInstallOptions): InstallAction[] => {
  const apt = aptGet(p)
  const nginx = unique(rolePackages(p, ['nginx']))
  const engine = without(unique(rolePackages(p, engineRoles(o))), nginx)
  const rest = without(
    unique([...rolePackages(p, [...baseRoles(o), ...optionalRoles(o)]), ...phpPackages(p, o.phpVersions)]),
    [...nginx, ...engine],
  )
  // Debian starts a service on install. nginx and apache2 both want :80, so each is installed
  // while the other is stopped, and both stay stopped until the first config generation passes.
  // Mail, DNS and FTP daemons would otherwise keep running on distro defaults (PAM logins, a
  // bind-backend pdns) before xPanel's config and firewall exist, so they are stopped as on EL.
  return [
    ...debianRepos(p, o.phpVersions.length > 0),
    ...systemUserActions(p),
    ...apt.install(nginx),
    systemd('stop', p.services.nginx),
    ...apt.install(engine),
    systemd('stop', p.services.apache),
    ...apt.install(rest),
    ...optionalRoles(o).map(r => systemd('stop', p.services[r])),
    ...apacheMpmActions(p, o.apacheMpm),
    ...apacheModuleActions(p),
    ...distroFpmOff(p, o.phpVersions),
    ...serviceActions(p, o),
  ]
}

const rhelPlan = (p: XpanelOsProfile, o: ExtendedResolvedInstallOptions): InstallAction[] => {
  const all = unique([
    ...rolePackages(p, ['nginx', ...engineRoles(o), ...baseRoles(o), ...optionalRoles(o)]),
    ...phpPackages(p, o.phpVersions),
  ])
  const initdb = exec([requireBin(p.bin.postgresqlSetup, 'postgresql-setup'), '--initdb'], `${p.paths.postgresqlDataDir}/PG_VERSION`)
  return [
    ...rhelRepos(p, o.phpVersions.length > 0),
    ...systemUserActions(p),
    ...dnf(p).install(all),
    initdb,
    ...distroFpmOff(p, o.phpVersions),
    ...serviceActions(p, o),
  ]
}

// ---------- public plans ----------

/**
 * Ordered host actions for a fresh server install. Pure: nothing runs here, so the result is a dry run.
 * Throws VALIDATION for bad options and ENGINE_UNAVAILABLE when the engine cannot be built on this OS.
 * Files from installFiles() are written after these actions; the reconciler starts the web servers.
 */
export const installPlan = (profile: XpanelOsProfile, options: ExtendedInstallOptions): InstallAction[] => {
  const o = prepare(profile, options)
  return profile.family === 'debian' ? debianPlan(profile, o) : rhelPlan(profile, o)
}

const rootFile = (path: string, lines: string[]): RenderedFile => ({
  path: assertAbsolutePath(path),
  content: `${lines.join('\n')}\n`,
  mode: 0o644,
  owner: 'root',
  group: 'root',
})

const NO_LISTEN_NOTE = [
  '# Nginx owns ports 80 and 443. Apache listens only on the loopback backend ports',
  "# declared in xPanel's base configuration, so this file carries no Listen directive.",
]

/** Debian: ports.conf without `Listen 80/443`; apache2.conf still includes it, so it must exist. */
const debianPortsFile = (p: XpanelOsProfile): RenderedFile =>
  rootFile(p.paths.apachePortsConf, ['# Managed by xPanel.', ...NO_LISTEN_NOTE])

/**
 * EL: httpd.conf carries `Listen 80` inline, so the installer owns the whole main file.
 * Server-wide defaults only; every listener and vhost comes from xPanel's generated config.
 */
const rhelMainFile = (p: XpanelOsProfile): RenderedFile => {
  const user = assertSystemUser(p.paths.apacheUser)
  // validated paths hold no quote, space or glob, so plain double quotes are exact
  const q = (path: string): string => `"${assertAbsolutePath(path)}"`
  const glob = (dir: string): string => `"${assertAbsolutePath(dir).replace(/\/$/, '')}/*.conf"`
  return rootFile(p.paths.apacheMainConf, [
    '# Managed by xPanel: Apache main configuration.',
    ...NO_LISTEN_NOTE,
    `ServerRoot ${q(p.paths.apacheRoot)}`,
    `Include ${glob(p.paths.apacheModulesConf)}`,
    `User ${user}`,
    `Group ${user}`,
    'ServerAdmin root@localhost',
    '<Directory />',
    '    AllowOverride None',
    '    Require all denied',
    '</Directory>',
    'DocumentRoot "/var/www/html"',
    '<Files ".ht*">',
    '    Require all denied',
    '</Files>',
    `ErrorLog ${q(`${p.paths.apacheLogDir}/error_log`)}`,
    'LogLevel warn',
    '<IfModule log_config_module>',
    '    LogFormat "%h %l %u %t \\"%r\\" %>s %b \\"%{Referer}i\\" \\"%{User-Agent}i\\"" combined',
    `    CustomLog ${q(`${p.paths.apacheLogDir}/access_log`)} combined`,
    '</IfModule>',
    '<IfModule mime_module>',
    '    TypesConfig /etc/mime.types',
    '</IfModule>',
    'AddDefaultCharset UTF-8',
    'EnableSendfile on',
    `IncludeOptional ${glob(p.paths.apacheVhostDir)}`,
  ])
}

/** EL mod_ssl ships `Listen 443 https` and a localhost-cert default vhost in ssl.conf; keep only its globals. */
const rhelSslFile = (p: XpanelOsProfile): RenderedFile[] =>
  p.paths.apacheSslConf === null
    ? []
    : [rootFile(p.paths.apacheSslConf, [
        '# Managed by xPanel: mod_ssl globals only.',
        ...NO_LISTEN_NOTE,
        'SSLSessionCache shmcb:/run/httpd/sslcache(512000)',
        'SSLSessionCacheTimeout 300',
      ])]

/** EL welcome.conf stays as an empty managed file: httpd updates restore it when it is deleted. */
const rhelWelcomeFile = (p: XpanelOsProfile): RenderedFile[] =>
  p.paths.apacheWelcomeConf === null
    ? []
    : [rootFile(p.paths.apacheWelcomeConf, [
        '# Managed by xPanel: the distribution test page is disabled.',
        '# Kept in place so that httpd package updates do not restore the stock file.',
      ])]

const suexecFile = (p: XpanelOsProfile): RenderedFile[] =>
  p.paths.suexecConfigFile === null
    ? []
    : [rootFile(p.paths.suexecConfigFile, [assertAbsolutePath(p.paths.suexecDocroot), 'public_html'])]

/**
 * Config files the installer owns, written after installPlan() and before the reconciler starts
 * the web servers. The distribution's `Listen 80/443` lines are removed here (the edge renderer
 * relies on it): otherwise Apache cannot bind next to Nginx.
 */
export const installFiles = (profile: XpanelOsProfile, options: ExtendedInstallOptions): RenderedFile[] => {
  const o = prepare(profile, options)
  if (profile.family === 'rhel') {
    return [
      ...apacheMpmFiles(profile, o.apacheMpm),
      rhelMainFile(profile),
      ...rhelSslFile(profile),
      ...rhelWelcomeFile(profile),
      ...suexecFile(profile),
    ]
  }
  return [debianPortsFile(profile), ...suexecFile(profile)]
}

export const installWarnings = (profile: XpanelOsProfile, options: ExtendedInstallOptions): InstallWarning[] => {
  const o = prepare(profile, options)
  const w: InstallWarning[] = [{
    code: 'EDGE_NOT_STARTED',
    message: `${profile.services.nginx} and ${profile.services.apache} are installed and enabled but left stopped; the reconciler starts them after the first config generation passes its tests`,
  }]
  const optional = optionalRoles(o).map(r => profile.services[r])
  if (optional.length > 0) {
    w.push({
      code: 'SERVICES_NOT_STARTED',
      message: `${optional.join(', ')} are installed and enabled but left stopped until the reconciler writes their configuration`,
    })
  }
  if (o.apacheMpm === 'prefork') {
    w.push({
      code: 'APACHE_SHARED_IDENTITY',
      message: `Apache children run as ${profile.paths.apacheUser}, not the account UID; per-account FPM pools and suexec keep PHP and CGI isolated`,
    })
  }
  if (profile.family === 'rhel') {
    w.push(
      { code: 'SELINUX_UNMANAGED', message: 'SELinux booleans and file contexts for /home vhosts, the backend port and FPM sockets are not set by this plan' },
      { code: 'FIREWALLD_CONFLICT', message: 'firewalld must be disabled once the xPanel nftables ruleset is loaded' },
      { code: 'SUEXEC_DOCROOT_FIXED', message: `EL suexec only runs CGI below its compiled docroot ${profile.paths.suexecDocroot}` },
    )
  }
  if (profile.sshSocketUnit !== null) {
    w.push({ code: 'SSH_SOCKET_ACTIVATION', message: `SSH listens through ${profile.sshSocketUnit}; port changes need daemon-reload and a restart of that socket` })
  }
  if (profile.family === 'debian' && o.withDns) {
    w.push({ code: 'RESOLVED_STUB_PORT_53', message: 'systemd-resolved holds 127.0.0.53:53; PowerDNS must bind explicit public addresses or the stub listener must be disabled' })
  }
  return w
}

export const installBundle = (profile: XpanelOsProfile, options: ExtendedInstallOptions): InstallBundle => ({
  actions: installPlan(profile, options),
  files: installFiles(profile, options),
  warnings: installWarnings(profile, options),
})

/** Adds PHP versions to a running server: repositories and packages only, web servers untouched. */
export const phpInstallPlan = (profile: XpanelOsProfile, versions: string[]): InstallAction[] => {
  assertProfile(profile)
  const vs = assertPhpVersionList(versions)
  if (vs.length === 0) return []
  const packages = unique(phpPackages(profile, vs))
  const install = profile.family === 'debian'
    ? [...debianRepos(profile, true), ...aptGet(profile).install(packages)]
    : [...rhelRepos(profile, true), ...dnf(profile).install(packages)]
  return [...install, ...distroFpmOff(profile, vs)]
}

export * from './install-runner.ts'
