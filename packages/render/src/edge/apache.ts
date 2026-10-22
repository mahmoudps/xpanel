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
import { assertAccount, assertBackendPort, assertDomainName, assertInt, assertSafeAbsPath, assertSystemUser, invalid } from './validate.ts'

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
  /** optional mpm-itk default MaxClientsVHost cap across vhosts */
  maxClientsVHost?: number
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
    if (opts.maxClientsVHost !== undefined) {
      lines.push(`MaxClientsVHost ${assertInt('MaxClientsVHost', opts.maxClientsVHost, 1, a.maxRequestWorkers)}`)
    }
  } else if (opts.uidRange || opts.gidRange) {
    invalid('LimitUIDRange', opts.uidRange, 'only applies to mpm_itk')
  } else if (opts.maxClientsVHost !== undefined) {
    invalid('MaxClientsVHost', opts.maxClientsVHost, 'only applies to mpm_itk')
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
  /** optional mpm-itk per-vhost concurrency limit (MaxClientsVHost) */
  maxClientsVHost?: number
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

const vhostBody = (
  account: Account,
  g: SiteGroup,
  os: OsProfile,
  mpm: ApacheMpm,
  settings: ServerSettings,
  opts: { now?: RenderTime; maxClientsVHost?: number } = {},
): string[] => {
  const d = g.main
  const user = account.username
  const names = serverNameLines(g)
  const identity: string[] = []
  if (mpm === 'itk') {
    identity.push(`AssignUserId ${user} ${user}`)
    if (opts.maxClientsVHost !== undefined) {
      const a = assertApacheTuning(settings)
      identity.push(`MaxClientsVHost ${assertInt('MaxClientsVHost', opts.maxClientsVHost, 1, a.maxRequestWorkers)}`)
    }
  } else if (opts.maxClientsVHost !== undefined) {
    return invalid('MaxClientsVHost', opts.maxClientsVHost, 'only applies to mpm_itk')
  }
  const wiring = d.siteType === 'php' ? phpWiring(d.php.handler, mpm) : null
  const mode = siteMode(account, d, opts.now)

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

const renderGroupVhost = (
  account: Account,
  g: SiteGroup,
  settings: ServerSettings,
  os: OsProfile,
  opts: { now?: RenderTime; maxClientsVHost?: number } = {},
): RenderedFile => {
  const mpm = assertApacheEngine(settings)
  const addr = `127.0.0.1:${assertBackendPort(settings)}`
  const lines = [
    `# Managed by xPanel: ${g.main.name} (account ${account.username})`,
    ...section(`VirtualHost ${addr}`, 'VirtualHost', vhostBody(account, g, os, mpm, settings, opts)),
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
  return renderGroupVhost(account, g, settings, os, {
    ...(opts.now !== undefined && { now: opts.now }),
    ...(opts.maxClientsVHost !== undefined && { maxClientsVHost: opts.maxClientsVHost }),
  })
}

/** Every vhost of one account, grouped exactly like the Nginx sites. */
export const renderApacheVhosts = (
  account: Account,
  domains: Domain[],
  settings: ServerSettings,
  os: OsProfile,
  opts: { now?: RenderTime; maxClientsVHost?: number } = {},
): RenderedFile[] => {
  assertApacheEngine(settings)
  return groupSites(account, domains).map((g) => renderGroupVhost(account, g, settings, os, opts))
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

// ---- H05 isolation & backend bypass validators --------------------------------------------

export interface HtaccessIsolationViolation {
  line: number
  directive: string
  reason: string
}

const joinApacheLogicalLines = (content: string): { line: number; text: string }[] => {
  const raw = content.split(/\r?\n/)
  const out: { line: number; text: string }[] = []
  for (let i = 0; i < raw.length; i++) {
    const startLine = i + 1
    let text = raw[i] ?? ''
    while (text.endsWith('\\') && i + 1 < raw.length) {
      i++
      text = `${text.slice(0, -1)}${raw[i] ?? ''}`
    }
    out.push({ line: startLine, text: text.trim() })
  }
  return out
}

const HTACCESS_IDENTITY_RE = /^\s*(AssignUserId|AssignUserID|SuexecUserGroup|MaxClientsVHost|LimitUIDRange|LimitGIDRange)\b/i
const HTACCESS_PROXY_HANDLER_RE = /^\s*(SetHandler|AddHandler|AddType|ForceType|Action|ProxyPass|ProxyPassMatch|FcgidWrapper|ScriptAlias)\b(.*)$/i
const HTACCESS_REWRITE_PROXY_RE = /^\s*RewriteRule\b.*\s\[[^\]]*\bP\b[^\]]*\]/i

/**
 * Inspects tenant `.htaccess` content for directives that attempt to:
 * - Reference a FastCGI / UNIX socket (`proxy:unix:`, `.sock`, `fcgi://`) or another tenant's PHP-FPM pool
 * - Proxy to internal loopback ports via `ProxyPass`, `ProxyPassMatch`, or `RewriteRule ... [P]`
 * - Override process identity or handler wrappers (`AssignUserId`, `SuexecUserGroup`, `FcgidWrapper`, `Action`)
 */
export const inspectHtaccessIsolation = (account: Account, htaccessContent: string): HtaccessIsolationViolation[] => {
  assertAccount(account)
  if (typeof htaccessContent !== 'string') return invalid('.htaccess', htaccessContent, 'must be a string')
  if (htaccessContent.includes('\u0000')) return invalid('.htaccess', htaccessContent.slice(0, 64), 'contains NUL bytes')

  const violations: HtaccessIsolationViolation[] = []
  const user = account.username

  for (const { line, text } of joinApacheLogicalLines(htaccessContent)) {
    if (!text || text.startsWith('#')) continue

    const idMatch = HTACCESS_IDENTITY_RE.exec(text)
    if (idMatch) {
      violations.push({
        line,
        directive: idMatch[1] ?? text,
        reason: `identity/MPM directive ${idMatch[1]} is forbidden in tenant .htaccess`,
      })
      continue
    }

    if (HTACCESS_REWRITE_PROXY_RE.test(text)) {
      violations.push({
        line,
        directive: 'RewriteRule [P]',
        reason: 'RewriteRule proxy flag [P] is forbidden in tenant .htaccess to prevent backend/socket bypass',
      })
      continue
    }

    const handlerMatch = HTACCESS_PROXY_HANDLER_RE.exec(text)
    if (handlerMatch) {
      const directive = handlerMatch[1] ?? ''
      const args = (handlerMatch[2] ?? '').trim()
      const lowerArgs = args.toLowerCase()

      if (
        /^(ProxyPass|ProxyPassMatch|FcgidWrapper|ScriptAlias|Action)$/i.test(directive) ||
        lowerArgs.includes('proxy:') ||
        lowerArgs.includes('fcgi://') ||
        lowerArgs.includes('unix:') ||
        lowerArgs.includes('.sock') ||
        lowerArgs.includes('/run/')
      ) {
        const foreignSocket =
          lowerArgs.includes('/run/xpanel/fpm/') && !lowerArgs.includes(`/run/xpanel/fpm/${user.toLowerCase()}-`)
        violations.push({
          line,
          directive: `${directive} ${args}`.trim(),
          reason: foreignSocket
            ? `cross-tenant PHP-FPM socket reference in ${directive} is forbidden (account ${user})`
            : `custom proxy/socket/handler binding via ${directive} is forbidden in tenant .htaccess`,
        })
      }
    }
  }

  return violations
}

/**
 * Throws a VALIDATION error if `.htaccess` attempts to bind `proxy:unix:` / `fcgi://`, reference
 * another tenant's PHP-FPM socket, proxy via `RewriteRule [P]`, or alter worker UID/GID.
 */
export const assertHtaccessIsolation = (account: Account, htaccessContent: string): string => {
  const violations = inspectHtaccessIsolation(account, htaccessContent)
  if (violations.length > 0) {
    const first = violations[0]!
    return invalid('.htaccess', first.directive, `${first.reason} (line ${first.line})`)
  }
  return htaccessContent
}

export interface ApacheBackendIsolationProof {
  listenAddress: string
  mpm: ApacheMpm
  refusesMissingItk: boolean
  keepAliveOff: boolean
  defaultCatchallVhost: {
    file: string
    documentRoot: string
    allowOverrideNone: boolean
    phpHandlerAbsent: boolean
  }
  tenantVhost: {
    file: string
    accountUsername: string
    assignUserId: string | null
    maxClientsVHost: number | null
    documentRoot: string
    fpmSocketPath: string | null
  }
}

/**
 * Verifies the complete Apache loopback backend contract for an account domain (H05 — A31, A32, A33, A35):
 * 1. Binds exclusively to `127.0.0.1:<backendPort>` with `KeepAlive Off`
 * 2. Refuses startup if `mpm_itk` is selected but not loaded (`<IfModule !mpm_itk_module>` Error)
 * 3. Places `000-xpanel-base.conf` first with a catch-all default `<VirtualHost>` that serves
 *    `/usr/share/xpanel/default` (`AllowOverride None`, `Options None`, no PHP handler) so forged
 *    `Host` headers sent directly to `127.0.0.1:<backendPort>` never fall into a tenant vhost
 * 4. Binds the tenant `<VirtualHost>` to `AssignUserId <user> <user>` and the account's own
 *    PHP-FPM UNIX socket `/run/xpanel/fpm/<user>-<ver>/php-fpm.sock`
 */
export const verifyApacheBackendIsolation = (
  account: Account,
  domain: Domain,
  settings: ServerSettings,
  os: OsProfile,
  opts: ApacheVhostOptions = {},
): ApacheBackendIsolationProof => {
  const mpm = assertApacheEngine(settings)
  const mpmRendered = apacheMpmFile(settings, os, {
    ...(opts.maxClientsVHost !== undefined && { maxClientsVHost: opts.maxClientsVHost }),
  })
  const baseRendered = renderApacheBase(settings, os)
  const vhostRendered = renderApacheVhost(account, domain, settings, os, opts)

  const addr = `127.0.0.1:${assertBackendPort(settings)}`
  const refusesMissingItk =
    mpm === 'itk' &&
    mpmRendered.content.includes('<IfModule !mpm_itk_module>') &&
    mpmRendered.content.includes('Error "xPanel: mpm_itk is selected but not loaded')

  if (mpm === 'itk' && !refusesMissingItk) {
    return invalid('Apache MPM config', mpmRendered.path, 'must refuse startup when mpm_itk is missing')
  }

  const listens = baseRendered.content.split('\n').filter((l) => /^\s*Listen\b/.test(l))
  if (listens.length !== 1 || listens[0]?.trim() !== `Listen ${addr}`) {
    return invalid('Apache Listen', listens.join(', '), `must listen exclusively on ${addr}`)
  }

  const keepAliveOff = baseRendered.content.includes('KeepAlive Off')
  const defaultVhostMatch = /<VirtualHost\s+[^>]+>([\s\S]*?)<\/VirtualHost>/.exec(baseRendered.content)
  const defaultVhostBody = defaultVhostMatch?.[1] ?? ''
  const allowOverrideNone = defaultVhostBody.includes('AllowOverride None') && defaultVhostBody.includes('Options None')
  const phpHandlerAbsent = !defaultVhostBody.includes('SetHandler') && !defaultVhostBody.includes('AssignUserId')

  const expectedAssign = `AssignUserId ${account.username} ${account.username}`
  const hasAssign = vhostRendered.content.includes(expectedAssign)
  if (mpm === 'itk' && !hasAssign) {
    return invalid('Apache tenant vhost', vhostRendered.path, `missing ${expectedAssign}`)
  }

  const expectedSocket =
    domain.siteType === 'php' && domain.php.handler === 'fpm' && account.status === 'active' && !domain.suspended && !domain.redirect
      ? fpmSocketPath(account.username, domain.php.version)
      : null
  if (expectedSocket && !vhostRendered.content.includes(`proxy:unix:${expectedSocket}|fcgi://localhost`)) {
    return invalid('Apache tenant vhost FPM socket', vhostRendered.path, `must bind exclusivamente to ${expectedSocket}`)
  }

  return {
    listenAddress: addr,
    mpm,
    refusesMissingItk,
    keepAliveOff,
    defaultCatchallVhost: {
      file: baseRendered.path,
      documentRoot: XP_PATHS.defaultSiteDir,
      allowOverrideNone,
      phpHandlerAbsent,
    },
    tenantVhost: {
      file: vhostRendered.path,
      accountUsername: account.username,
      assignUserId: mpm === 'itk' ? `${account.username} ${account.username}` : null,
      maxClientsVHost: opts.maxClientsVHost ?? null,
      documentRoot: domain.docRoot,
      fpmSocketPath: expectedSocket,
    },
  }
}
