// One shared Apache on a loopback port behind Nginx. With mpm_itk the child serving a vhost
// drops to the account UID (AssignUserId); handlers then run as that same UID.
import { assertHandlerAvailable, fail, validateApacheWorkers } from '@xpanel/core'
import type { Account, ApacheMpm, ConfigTest, Domain, HostAction, OsProfile, PhpHandler, RenderedFile, ServerSettings } from '@xpanel/core'
import {
  cgiWrapperDir,
  cgiWrapperName,
  cgiWrapperPath,
  cgiWrapperRoot,
  fpmSocketPath,
  phpCgiBinary,
  XP_PATHS,
} from './paths.ts'
import { phpIsolation, iniEntries, type PhpIsolationOptions } from './php.ts'
import { apacheQuote, iniValue, shQuote } from './quote.ts'
import { groupSites, siteMode, type RenderTime, type SiteGroup } from './sites.ts'
import { assertBackendPort, assertDomainName, assertInt, assertSafeAbsPath, assertSystemUser, invalid } from './validate.ts'

const indent = (lines: string[], n = 1): string[] => lines.map((l) => (l === '' ? l : `${'    '.repeat(n)}${l}`))
const section = (open: string, close: string, body: string[]): string[] => [`<${open}>`, ...indent(body), `</${close}>`]

export const assertApacheEngine = (settings: ServerSettings): ApacheMpm => {
  if (settings.engine !== 'apache') {
    return fail('ENGINE_UNAVAILABLE', 'Apache configuration requested while OpenLiteSpeed is the engine', { engine: settings.engine })
  }
  if (settings.apacheMpm !== 'itk' && settings.apacheMpm !== 'prefork') {
    return invalid('apacheMpm', settings.apacheMpm, 'must be itk or prefork')
  }
  return settings.apacheMpm
}

// ---- MPM ----------------------------------------------------------------------------------

/** MPM numbers by the core rule: spare/start ordering as prefork enforces it, ServerLimit >= MaxRequestWorkers. */
export const assertApacheTuning = (settings: ServerSettings): ServerSettings['apache'] => validateApacheWorkers(settings.apache)

export interface ApacheMpmOptions {
  /** mpm-itk >= 2.4.7 seccomp limit on the UIDs a child may switch to */
  uidRange?: [number, number]
  gidRange?: [number, number]
}

const idRange = (what: string, r: [number, number] | undefined): string | null => {
  if (!r) return null
  if (!Array.isArray(r) || r.length !== 2) return invalid(what, r, 'must be [min, max]')
  const lo = assertInt(what, r[0], 1, 4294967294)
  const hi = assertInt(what, r[1], lo, 4294967294)
  return `${lo} ${hi}`
}

/**
 * MPM tuning. Unwrapped on purpose: a missing itk module is a config-test failure,
 * never a silent fallback to serving accounts as the shared Apache user.
 */
export const renderApacheMpm = (settings: ServerSettings, opts: ApacheMpmOptions = {}): string => {
  const mpm = assertApacheEngine(settings)
  const a = assertApacheTuning(settings)
  const lines = [
    `# Managed by xPanel: Apache MPM (${mpm === 'itk' ? 'mpm_itk on prefork' : 'prefork'})`,
    ...section('IfModule !mpm_prefork_module', 'IfModule', [
      `Error "xPanel: the prefork MPM must be loaded${mpm === 'itk' ? ' (mpm_itk runs on top of it)' : ''}"`,
    ]),
  ]
  if (mpm === 'itk') {
    lines.push(
      ...section('IfModule !mpm_itk_module', 'IfModule', [
        'Error "xPanel: mpm_itk is selected but not loaded; refusing to serve accounts as the shared Apache user"',
      ]),
    )
  } else {
    lines.push(
      ...section('IfModule mpm_itk_module', 'IfModule', [
        'Error "xPanel: mpm_itk is loaded but prefork is selected; disable mpm_itk to keep handler identities consistent"',
      ]),
    )
  }
  lines.push(
    `StartServers ${a.startServers}`,
    `MinSpareServers ${a.minSpareServers}`,
    `MaxSpareServers ${a.maxSpareServers}`,
    `ServerLimit ${a.serverLimit}`,
    `MaxRequestWorkers ${a.maxRequestWorkers}`,
    `MaxConnectionsPerChild ${a.maxConnectionsPerChild}`,
  )
  if (mpm === 'itk') {
    const uid = idRange('LimitUIDRange', opts.uidRange)
    const gid = idRange('LimitGIDRange', opts.gidRange)
    if (uid) lines.push(`LimitUIDRange ${uid}`)
    if (gid) lines.push(`LimitGIDRange ${gid}`)
  } else if (opts.uidRange || opts.gidRange) {
    invalid('LimitUIDRange', opts.uidRange, 'only applies to mpm_itk')
  }
  return `${lines.join('\n')}\n`
}

const vhostDir = (os: OsProfile): string => assertSafeAbsPath(os.paths.apacheVhostDir, 'Apache vhost dir')

export const apacheMpmFile = (settings: ServerSettings, os: OsProfile, opts: ApacheMpmOptions = {}): RenderedFile => ({
  path: `${vhostDir(os)}/000-xpanel-mpm.conf`,
  content: renderApacheMpm(settings, opts),
  mode: 0o644,
  owner: 'root',
  group: 'root',
})

// ---- base ---------------------------------------------------------------------------------

/**
 * Loopback-only listener, client IP restored from Nginx's X-Real-IP, a default backend vhost
 * for unknown Host headers, and denial of INI/htaccess files. The distribution's own
 * `Listen 80/443` lines must be removed by the OS layer (ports.conf / httpd.conf).
 */
export const renderApacheBase = (settings: ServerSettings, os: OsProfile): RenderedFile => {
  assertApacheEngine(settings)
  const port = assertBackendPort(settings)
  const hostname = assertDomainName(settings.hostname, 'hostname')
  assertSystemUser(os.paths.apacheUser, 'Apache user')
  const addr = `127.0.0.1:${port}`
  const lines = [
    '# Managed by xPanel: Apache behind the Nginx edge',
    `Listen ${addr}`,
    `ServerName ${hostname}`,
    'ServerTokens Prod',
    'ServerSignature Off',
    'TraceEnable Off',
    'HostnameLookups Off',
    // itk children cannot switch identity on a reused connection; Nginx opens one per request
    'KeepAlive Off',
    'Timeout 300',
    '',
    'RemoteIPHeader X-Real-IP',
    'RemoteIPInternalProxy 127.0.0.1 ::1',
    'SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on',
    'LogFormat "%a %v %l %u %t \\"%r\\" %>s %O %D \\"%{Referer}i\\" \\"%{User-Agent}i\\"" xpanel_vhost',
    `CustomLog ${apacheQuote(`${XP_PATHS.apacheLogDir}/access.log`)} xpanel_vhost`,
    `ErrorLog ${apacheQuote(`${XP_PATHS.apacheLogDir}/error.log`)}`,
    '',
    'DirectoryIndex index.php index.html index.htm',
    ...section('FilesMatch "^(\\.ht.*|\\.user\\.ini|php\\.ini)$"', 'FilesMatch', ['Require all denied']),
    ...section('IfModule mod_userdir.c', 'IfModule', ['UserDir disabled']),
    '',
    '# first vhost on the address: answers Host headers no account has bound',
    ...section(`VirtualHost ${addr}`, 'VirtualHost', [
      `ServerName ${hostname}`,
      `DocumentRoot ${apacheQuote(XP_PATHS.defaultSiteDir)}`,
      ...section(`Directory ${apacheQuote(XP_PATHS.defaultSiteDir)}`, 'Directory', [
        'AllowOverride None',
        'Options None',
        'Require all granted',
      ]),
    ]),
  ]
  return { path: `${vhostDir(os)}/000-xpanel-base.conf`, content: `${lines.join('\n')}\n`, mode: 0o644, owner: 'root', group: 'root' }
}

export const apacheConfigTest = (os: OsProfile): ConfigTest => ({
  name: 'apache',
  argv: [assertSafeAbsPath(os.paths.apacheCtl, 'apachectl'), 'configtest'],
})

export const apacheLogDirs = (): HostAction[] => [
  { kind: 'ensure-dir', path: XP_PATHS.apacheLogDir, mode: 0o750, owner: 'root', group: 'root' },
]

// ---- handlers -----------------------------------------------------------------------------

export type ApachePhpWiring = 'fpm' | 'cgi-action' | 'fcgid' | 'suphp-action'

/**
 * How a handler runs under the selected MPM:
 * - fpm: proxy_fcgi to the account's own FPM master
 * - cgi + itk: mod_cgi via Action; the itk child is already the account (suexec would refuse it)
 * - cgi + prefork: mod_fcgid through suexec
 * - suphp: suexec + php-cgi wrapper with suPHP's per-directory php.ini rule; never with itk
 */
export const phpWiring = (handler: PhpHandler, mpm: ApacheMpm): ApachePhpWiring => {
  // the MPM file's Error guard fails configtest when itk is selected but missing
  assertHandlerAvailable(handler, { engine: 'apache', mpm, itkAvailable: true })
  if (handler === 'fpm') return 'fpm'
  if (handler === 'cgi') return mpm === 'itk' ? 'cgi-action' : 'fcgid'
  return 'suphp-action'
}

const ACTION_PREFIX = '/.xpanel-php/'

const actionBlock = (account: Account, version: string, os: OsProfile): string[] => {
  const dir = cgiWrapperDir(account.username, os)
  const handler = `xpanel-php${version.replace('.', '')}`
  return [
    `ScriptAlias ${ACTION_PREFIX} ${apacheQuote(`${dir}/`)}`,
    ...section(`Directory ${apacheQuote(dir)}`, 'Directory', ['AllowOverride None', 'Options +ExecCGI -Indexes', 'Require all granted']),
    // the wrapper is reachable only through the Action internal redirect
    ...section(`Location ${apacheQuote(ACTION_PREFIX)}`, 'Location', ['Require env REDIRECT_STATUS']),
    `Action ${handler} ${ACTION_PREFIX}${cgiWrapperName(version, 'cgi')}`,
    ...section('FilesMatch "\\.php$"', 'FilesMatch', [`SetHandler ${handler}`]),
  ]
}

const DENY_PHP = section('FilesMatch "\\.(php|phtml|phar|phps)$"', 'FilesMatch', ['Require all denied'])

export interface ApacheVhostOptions {
  /** alias (parked) domains served by this vhost */
  aliases?: Domain[]
  /** time used to stop expired sites (default: the time of rendering) */
  now?: RenderTime
}

/** Apache reads config lines of at most 8 KiB (MAX_STRING_LEN); keep each ServerAlias well below. */
const ALIASES_PER_LINE = 16

const serverNameLines = (g: SiteGroup): string[] => {
  const alias = [...g.names.slice(1), ...g.wildcards]
  const lines = [`ServerName ${g.main.name}`]
  for (let i = 0; i < alias.length; i += ALIASES_PER_LINE) lines.push(`ServerAlias ${alias.slice(i, i + ALIASES_PER_LINE).join(' ')}`)
  return lines
}

const docDirectory = (docRoot: string, extra: string[], execCgi: boolean): string[] =>
  section(`Directory ${apacheQuote(docRoot)}`, 'Directory', [
    'AllowOverride All',
    `Options -Indexes +SymLinksIfOwnerMatch${execCgi ? ' +ExecCGI' : ''}`,
    'Require all granted',
    ...extra,
  ])

const vhostBody = (account: Account, g: SiteGroup, os: OsProfile, mpm: ApacheMpm, now?: RenderTime): string[] => {
  const d = g.main
  const user = account.username
  const names = serverNameLines(g)
  const identity = mpm === 'itk' ? [`AssignUserId ${user} ${user}`] : []
  const wiring = d.siteType === 'php' ? phpWiring(d.php.handler, mpm) : null
  const mode = siteMode(account, d, now)

  if (mode === 'suspended') {
    return [
      ...names,
      `DocumentRoot ${apacheQuote(XP_PATHS.suspendedDir)}`,
      ...identity,
      ...section(`Directory ${apacheQuote(XP_PATHS.suspendedDir)}`, 'Directory', ['AllowOverride None', 'Options None', 'Require all granted']),
      'RedirectMatch 302 "^/(?!index\\.html$)" "/index.html"',
    ]
  }
  const head = [...names, `DocumentRoot ${apacheQuote(d.docRoot)}`, ...identity]
  if (mode === 'redirect' && d.redirect) {
    return [...head, `RedirectMatch ${d.redirect.code} "^/" ${apacheQuote(d.redirect.to)}`]
  }
  if (mode === 'upstream' || wiring === null) {
    const note = mode === 'upstream' ? [`# ${d.siteType} site: Nginx proxies it to its app upstream directly`] : []
    return [...head, ...note, ...docDirectory(d.docRoot, [], false), ...DENY_PHP]
  }
  const version = d.php.version
  if (wiring === 'fpm') {
    return [
      ...head,
      ...docDirectory(d.docRoot, [], false),
      ...section('FilesMatch "\\.php$"', 'FilesMatch', [
        `SetHandler ${apacheQuote(`proxy:unix:${fpmSocketPath(user, version)}|fcgi://localhost`)}`,
      ]),
    ]
  }
  if (wiring === 'fcgid') {
    return [
      ...head,
      `SuexecUserGroup ${user} ${user}`,
      ...docDirectory(d.docRoot, [`FcgidWrapper ${apacheQuote(cgiWrapperPath(user, version, 'fcgi', os))} .php`], true),
      ...section('FilesMatch "\\.php$"', 'FilesMatch', ['SetHandler fcgid-script']),
    ]
  }
  const suexec = wiring === 'suphp-action' ? [`SuexecUserGroup ${user} ${user}`] : []
  return [...head, ...suexec, ...docDirectory(d.docRoot, [], false), ...actionBlock(account, version, os)]
}

/** Deepest base name first; more labels than any legal name could have keeps the prefix positive. */
const WILDCARD_ORDER_BASE = 200

/**
 * Apache serves a request with the first vhost, in load (file name) order, whose ServerName or
 * ServerAlias matches, and `*` in ServerAlias also spans dots. Exact-only vhosts therefore load
 * first, then wildcard vhosts from the deepest base name up, so an explicit subdomain beats its
 * parent's `*.name` exactly as in Nginx.
 */
export const apacheVhostFileName = (g: SiteGroup): string => {
  if (g.wildcards.length === 0) return `xpanel-site-${g.main.name}.conf`
  const depth = Math.max(...g.wildcards.map((w) => w.split('.').length))
  return `xpanel-wild-${String(WILDCARD_ORDER_BASE - depth).padStart(3, '0')}-${g.main.name}.conf`
}

const renderGroupVhost = (account: Account, g: SiteGroup, settings: ServerSettings, os: OsProfile, now?: RenderTime): RenderedFile => {
  const mpm = assertApacheEngine(settings)
  const addr = `127.0.0.1:${assertBackendPort(settings)}`
  const lines = [
    `# Managed by xPanel: ${g.main.name} (account ${account.username})`,
    ...section(`VirtualHost ${addr}`, 'VirtualHost', vhostBody(account, g, os, mpm, now)),
  ]
  return {
    path: `${vhostDir(os)}/${apacheVhostFileName(g)}`,
    content: `${lines.join('\n')}\n`,
    mode: 0o644,
    owner: 'root',
    group: 'root',
  }
}

/** One vhost for `domain` and the alias domains passed in `opts.aliases`. */
export const renderApacheVhost = (
  account: Account,
  domain: Domain,
  settings: ServerSettings,
  os: OsProfile,
  opts: ApacheVhostOptions = {},
): RenderedFile => {
  assertApacheEngine(settings)
  const groups = groupSites(account, [domain, ...(opts.aliases ?? [])])
  const g = groups.find((x) => x.main.id === domain?.id)
  if (!g || groups.length !== 1) return invalid('aliases', opts.aliases?.map((a) => a.name), `must all be plain aliases of ${domain?.name}`)
  return renderGroupVhost(account, g, settings, os, opts.now)
}

/** Every vhost of one account, grouped exactly like the Nginx sites. */
export const renderApacheVhosts = (
  account: Account,
  domains: Domain[],
  settings: ServerSettings,
  os: OsProfile,
  opts: { now?: RenderTime } = {},
): RenderedFile[] => {
  assertApacheEngine(settings)
  return groupSites(account, domains).map((g) => renderGroupVhost(account, g, settings, os, opts.now))
}

// ---- CGI wrappers -------------------------------------------------------------------------

const wrapperKind = (w: ApachePhpWiring): 'cgi' | 'fcgi' => (w === 'fcgid' ? 'fcgi' : 'cgi')

/** Wrappers run through suexec under prefork (then suexec demands the account owns them). */
const wrapperOwner = (account: Account, mpm: ApacheMpm): string => (mpm === 'prefork' ? account.username : 'root')

/** `-d key=value` lines; values are already in INI syntax because php-cgi parses them as INI. */
const phpArgs = (pairs: [string, string][]): string[] => pairs.map(([k, v]) => `    -d ${shQuote(`${k}=${v}`)} \\`)

/**
 * php-cgi wrapper for the cgi and suphp handlers. Isolation values and the account's panel
 * settings are passed with -d, which php-cgi applies after every php.ini (so a per-directory
 * php.ini cannot undo them) and .user.ini can only tighten open_basedir.
 */
export const renderPhpCgiWrapper = (
  account: Account,
  domain: Domain,
  settings: ServerSettings,
  os: OsProfile,
  opts: PhpIsolationOptions = {},
): RenderedFile => {
  const mpm = assertApacheEngine(settings)
  const [g] = groupSites(account, [domain])
  if (!g) return invalid('domain', domain, 'is required')
  const wiring = phpWiring(domain.php.handler, mpm)
  if (wiring === 'fpm') return invalid('PHP handler', domain.php.handler, 'PHP-FPM does not use a CGI wrapper')
  const version = domain.php.version
  const kind = wrapperKind(wiring)
  const iso = phpIsolation(account, os, opts)
  const bin = phpCgiBinary(os, version)
  const admin: [string, string][] = [...iso.admin]
  if (kind === 'cgi') admin.push(['cgi.force_redirect', '1'])
  const ini = iniEntries(domain.php.ini)
  const args = phpArgs([...ini.user, ...ini.pool, ...admin.map(([k, v]): [string, string] => [k, iniValue(v, k)])])
  const last = args.length - 1
  args[last] = (args[last] ?? '').replace(/ \\$/, '')

  const head = [
    wiring === 'suphp-action' ? '#!/bin/bash' : '#!/bin/sh',
    `# Managed by xPanel: PHP ${version} (${wiring}) for ${account.username}. Regenerated on every config generation.`,
  ]
  const env = [`export TMPDIR=${shQuote(iso.tmpDir)}`]
  if (kind === 'fcgi') {
    env.push('export PHP_FCGI_CHILDREN=0', `export PHP_FCGI_MAX_REQUESTS=${assertInt('pm.max_requests', domain.php.fpm.maxRequests, 0, 1_000_000)}`)
  }
  const guard =
    wiring === 'suphp-action'
      ? [
          `home=${shQuote(account.home)}`,
          'script="${PATH_TRANSLATED:-}"',
          'deny() { printf \'Status: 403 Forbidden\\r\\nContent-Type: text/plain\\r\\n\\r\\nForbidden\\n\'; exit 0; }',
          'case "$script" in "$home"/*) ;; *) deny ;; esac',
          '[ -f "$script" ] && [ -O "$script" ] || deny',
          '# suPHP rules: the script and its directory must not be writable by group or others',
          '[ -z "$(find -H "$script" -maxdepth 0 -perm /022 2>/dev/null)" ] || deny',
          'dir="${script%/*}"',
          '[ -z "$(find -H "$dir" -maxdepth 0 -perm /022 2>/dev/null)" ] || deny',
          '# per-directory php.ini, as suPHP did, when the account owns it',
          'if [ -f "$dir/php.ini" ] && [ -O "$dir/php.ini" ]; then export PHPRC="$dir"; else unset PHPRC; fi',
        ]
      : []
  const lines = [...head, ...guard, ...env, `exec ${shQuote(bin)} \\`, ...args]
  const owner = wrapperOwner(account, mpm)
  return {
    path: cgiWrapperPath(account.username, version, kind, os),
    content: `${lines.join('\n')}\n`,
    mode: 0o755,
    owner,
    group: owner === 'root' ? 'root' : account.username,
  }
}

/** suexec checks: directory under its docroot, owned by the target user, not group/other-writable. */
export const cgiWrapperDirs = (account: Account, settings: ServerSettings, os: OsProfile): HostAction[] => {
  const mpm = assertApacheEngine(settings)
  const owner = wrapperOwner(account, mpm)
  return [
    { kind: 'ensure-dir', path: cgiWrapperRoot(os), mode: 0o755, owner: 'root', group: 'root' },
    {
      kind: 'ensure-dir',
      path: cgiWrapperDir(account.username, os),
      mode: 0o755,
      owner,
      group: owner === 'root' ? 'root' : account.username,
    },
  ]
}

/** Modules the rendered configuration needs; the OS layer enables them (a2enmod / conf.modules.d). */
export const requiredApacheModules = (settings: ServerSettings, domains: Domain[] = []): string[] => {
  const mpm = assertApacheEngine(settings)
  const mods = new Set(['mpm_prefork', 'remoteip', 'setenvif', 'alias', 'dir', 'mime', 'authz_core', 'authz_host', 'rewrite', 'headers'])
  if (mpm === 'itk') mods.add('mpm_itk')
  for (const d of domains) {
    if (d.siteType !== 'php') continue
    const w = phpWiring(d.php.handler, mpm)
    if (w === 'fpm') ['proxy', 'proxy_fcgi'].forEach((m) => mods.add(m))
    if (w === 'cgi-action') ['actions', 'cgi'].forEach((m) => mods.add(m))
    if (w === 'fcgid') ['fcgid', 'suexec'].forEach((m) => mods.add(m))
    if (w === 'suphp-action') ['actions', 'cgi', 'suexec'].forEach((m) => mods.add(m))
  }
  return [...mods]
}
