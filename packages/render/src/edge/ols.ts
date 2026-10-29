// OpenLiteSpeed as the server-wide alternative engine behind Nginx: lsphp external apps per
// account (extUser/extGroup = account), one virtual host per site, a loopback listener.
import { assertHandlerAvailable, fail, validateDomainIndexFiles } from '@xpanel/core'
import type { Account, Domain, Limit, OsProfile, PhpSettings, RenderedFile, ServerSettings } from '@xpanel/core'
import { lsphpBinary, XP_PATHS } from './paths.ts'
import { assertWorkers, iniEntries, phpIsolation, type PhpIsolationOptions } from './php.ts'
import { olsValue } from './quote.ts'
import { groupSites, siteMode, type RenderTime, type SiteGroup } from './sites.ts'
import {
  assertAccount,
  assertBackendPort,
  assertDomainName,
  assertPhpVersion,
  assertSafeAbsPath,
  assertServedName,
  assertUsername,
  invalid,
} from './validate.ts'

export const assertOlsEngine = (settings: ServerSettings): void => {
  if (settings.engine !== 'openlitespeed') {
    fail('ENGINE_UNAVAILABLE', 'OpenLiteSpeed configuration requested while Apache is the engine', { engine: settings.engine })
  }
}

/** ENGINE_UNAVAILABLE for Apache handlers, by the core handler matrix. */
const assertLsphp = (php: PhpSettings): PhpSettings => {
  assertHandlerAvailable(php.handler, { engine: 'openlitespeed', mpm: 'prefork', itkAvailable: false })
  return php
}

const indent = (lines: string[]): string[] => lines.map((l) => (l === '' ? l : `  ${l}`))
const block = (head: string, body: string[]): string[] => [`${head} {`, ...indent(body), '}']
const kv = (k: string, v: string | number): string => `${k.padEnd(24)}${olsValue(String(v), k)}`

const verTag = (version: string): string => assertPhpVersion(version).replace('.', '')

export const lsphpAppName = (user: string, version: string): string => `lsphp-${assertUsername(user)}-${verTag(version)}`

export const lsphpSocket = (user: string, version: string): string => `uds://tmp/lshttpd/xpanel-${assertUsername(user)}-${verTag(version)}.sock`

export interface OlsPhpOptions extends PhpIsolationOptions {
  workerCap?: Limit
}

/** Server-level lsphp external app for one account and PHP version, run as the account. */
export const renderOlsExtProcessor = (
  account: Account,
  php: PhpSettings,
  settings: ServerSettings,
  os: OsProfile,
  opts: OlsPhpOptions = {},
): string => {
  assertOlsEngine(settings)
  assertAccount(account)
  assertLsphp(php)
  const w = assertWorkers(php.fpm, opts.workerCap)
  const user = account.username
  const iso = phpIsolation(account, os, opts)
  const body = [
    kv('type', 'lsapi'),
    kv('address', lsphpSocket(user, php.version)),
    kv('maxConns', w.maxChildren),
    kv('env', `PHP_LSAPI_CHILDREN=${w.maxChildren}`),
    kv('env', `PHP_LSAPI_MAX_REQUESTS=${w.maxRequests || 10000}`),
    kv('env', `LSAPI_MAX_IDLE=${w.processIdleTimeoutSec}`),
    kv('env', `TMPDIR=${iso.tmpDir}`),
    kv('initTimeout', 60),
    kv('retryTimeout', 0),
    kv('persistConn', 1),
    kv('respBuffer', 0),
    kv('autoStart', 2),
    kv('path', lsphpBinary(os, php.version)),
    kv('backlog', 100),
    kv('instances', 1),
    kv('extUser', user),
    kv('extGroup', user),
    kv('priority', 0),
  ]
  return `${block(`extprocessor ${lsphpAppName(user, php.version)}`, body).join('\n')}\n`
}

const vhostConfPath = (os: OsProfile, name: string): string =>
  `${assertSafeAbsPath(os.paths.olsRoot, 'OpenLiteSpeed root')}/conf/vhosts/${name}/vhconf.conf`

export interface OlsVhost {
  /** `virtualhost` block for httpd_config.conf */
  server: string
  vhconf: RenderedFile
  /** listener map entry: vhost name -> served names */
  map: { vhost: string; names: string[] }
}

const E_LEVELS: Readonly<Record<string, number>> = {
  E_ERROR: 1, E_WARNING: 2, E_PARSE: 4, E_NOTICE: 8, E_CORE_ERROR: 16, E_CORE_WARNING: 32,
  E_COMPILE_ERROR: 64, E_COMPILE_WARNING: 128, E_USER_ERROR: 256, E_USER_WARNING: 512,
  E_USER_NOTICE: 1024, E_STRICT: 2048, E_RECOVERABLE_ERROR: 4096, E_DEPRECATED: 8192,
  E_USER_DEPRECATED: 16384, E_ALL: 32767,
}

/**
 * OLS hands php_value strings to PHP without INI constant evaluation, so `E_ALL & ~E_NOTICE`
 * would reach PHP as text. The expression (already canonical from core) is evaluated the way
 * the INI parser does: `~` binds tightest, `& | ^` share one level, left to right.
 */
export const errorLevelValue = (expr: string): string => {
  if (/^-?\d+$/.test(expr)) return expr
  const terms = expr.split(/\s*([&|^])\s*/)
  const term = (t: string): number => {
    const neg = t.startsWith('~')
    const name = neg ? t.slice(1) : t
    const n = /^\d+$/.test(name) ? Number(name) : E_LEVELS[name]
    if (n === undefined) return invalid('error_reporting', expr, `unknown constant ${name}`)
    return neg ? ~n : n
  }
  let acc = term(terms[0] ?? '')
  for (let i = 1; i < terms.length; i += 2) {
    const op = terms[i]
    const n = term(terms[i + 1] ?? '')
    acc = op === '&' ? acc & n : op === '|' ? acc | n : acc ^ n
  }
  return String(acc)
}

const quoted = (k: string, v: string): string => {
  const raw = v.startsWith('"') ? v.slice(1, -1) : v
  return `"${olsValue(k === 'error_reporting' ? errorLevelValue(raw) : raw, k)}"`
}

/** Isolation and PHP_INI_SYSTEM keys as admin values; the account's other keys stay per-directory. */
const phpOverride = (account: Account, php: PhpSettings, os: OsProfile, opts: OlsPhpOptions): string[] => {
  const iso = phpIsolation(account, os, opts)
  const ini = iniEntries(php.ini)
  return block('phpIniOverride', [
    ...[...iso.admin, ...ini.pool].map(([k, v]) => `php_admin_value ${k} ${quoted(k, v)}`),
    ...ini.user.map(([k, v]) => `php_value ${k} ${quoted(k, v)}`),
  ])
}

type VhostOptions = OlsPhpOptions & { now?: RenderTime }

const vhconfBody = (account: Account, g: SiteGroup, os: OsProfile, opts: VhostOptions): string[] => {
  const d = g.main
  const mode = siteMode(account, d, opts.now)
  const names = [kv('vhDomain', d.name)]
  const aliases = [...g.names.slice(1), ...g.wildcards]
  if (aliases.length) names.push(kv('vhAliases', aliases.join(', ')))
  if (mode === 'suspended') {
    return [
      kv('docRoot', XP_PATHS.suspendedDir),
      ...names,
      ...block('rewrite', [kv('enable', 1), kv('autoLoadHtaccess', 0), 'rules                   <<<END_rules', 'RewriteRule ^(?!index\\.html$) /index.html [R=302,L]', 'END_rules']),
    ]
  }
  if (mode === 'redirect' && d.redirect) {
    return [
      kv('docRoot', d.docRoot),
      ...names,
      ...block('context /', [kv('type', 'redirect'), kv('uri', '/'), kv('externalRedirect', 1), kv('statusCode', d.redirect.code), kv('location', d.redirect.to)]),
    ]
  }
  const common = [
    kv('docRoot', d.docRoot),
    ...names,
    kv('enableGzip', 1),
    // useServer=0 replaces server indexes; filenames are ordered and comma-delimited (https://www.litespeedtech.com/docs/webserver/config/vhostgeneral).
    ...block('index', [kv('useServer', 0), kv('indexFiles', d.indexFiles === undefined || mode === 'upstream' ? 'index.php, index.html, index.htm' : validateDomainIndexFiles(d.indexFiles).join(', '))]),
    // .htaccess rewrite rules work because OLS reads them per directory
    ...block('rewrite', [kv('enable', 1), kv('autoLoadHtaccess', 1)]),
  ]
  if (mode === 'upstream' || d.siteType !== 'php') {
    return [...common, `# ${d.siteType} site: no PHP handler`]
  }
  assertLsphp(d.php)
  return [
    ...common,
    ...block('scripthandler', [kv('add', `lsapi:${lsphpAppName(account.username, d.php.version)} php`)]),
    ...phpOverride(account, d.php, os, opts),
  ]
}

const renderGroup = (account: Account, g: SiteGroup, os: OsProfile, opts: VhostOptions): OlsVhost => {
  const name = g.main.name
  const confPath = vhostConfPath(os, name)
  // restrained=1 confines the vhost to vhRoot, so a suspended site's root is the suspended page
  const suspended = siteMode(account, g.main, opts.now) === 'suspended'
  const server = block(`virtualhost ${name}`, [
    kv('vhRoot', suspended ? XP_PATHS.suspendedDir : account.home),
    kv('configFile', confPath),
    kv('allowSymbolLink', 2),
    kv('enableScript', 1),
    kv('restrained', 1),
    kv('setUIDMode', 2),
  ])
  const vhconf = [`# Managed by xPanel: ${name} (account ${account.username})`, ...vhconfBody(account, g, os, opts)]
  return {
    server: `${server.join('\n')}\n`,
    vhconf: { path: confPath, content: `${vhconf.join('\n')}\n`, mode: 0o644, owner: 'root', group: 'root' },
    map: { vhost: name, names: [...g.names, ...g.wildcards] },
  }
}

/** One OLS virtual host for `domain` (plus plain alias domains). */
export const renderOlsVhost = (
  account: Account,
  domain: Domain,
  settings: ServerSettings,
  os: OsProfile,
  opts: VhostOptions & { aliases?: Domain[] } = {},
): OlsVhost => {
  assertOlsEngine(settings)
  const groups = groupSites(account, [domain, ...(opts.aliases ?? [])])
  const g = groups.find((x) => x.main.id === domain.id)
  if (!g || groups.length !== 1) return fail('VALIDATION', `aliases must all be plain aliases of ${domain.name}`)
  return renderGroup(account, g, os, opts)
}

export interface OlsAccountRender {
  /** extprocessors + virtualhosts, to splice into httpd_config.conf */
  server: string
  vhconfs: RenderedFile[]
  maps: { vhost: string; names: string[] }[]
}

/** Every vhost of one account plus one lsphp app per PHP version in use. */
export const renderOlsAccount = (
  account: Account,
  domains: Domain[],
  settings: ServerSettings,
  os: OsProfile,
  opts: VhostOptions = {},
): OlsAccountRender => {
  assertOlsEngine(settings)
  const groups = groupSites(account, domains)
  const vhosts = groups.map((g) => renderGroup(account, g, os, opts))
  const apps = new Map<string, PhpSettings>()
  for (const g of groups) {
    const d = g.main
    if (d.siteType === 'php' && siteMode(account, d, opts.now) === 'backend' && !apps.has(d.php.version)) apps.set(d.php.version, d.php)
  }
  const procs = [...apps.values()].map((php) => renderOlsExtProcessor(account, php, settings, os, opts))
  return {
    server: [`# Managed by xPanel: account ${account.username}`, ...procs, ...vhosts.map((v) => v.server)].join('\n'),
    vhconfs: vhosts.map((v) => v.vhconf),
    maps: vhosts.map((v) => v.map),
  }
}

/**
 * Loopback listener Nginx proxies to, mapping every served name to its vhost. The maps of all
 * accounts meet here, so every vhost and name is validated again and must be unique.
 */
export const renderOlsListener = (settings: ServerSettings, maps: { vhost: string; names: string[] }[]): string => {
  assertOlsEngine(settings)
  const port = assertBackendPort(settings)
  if (!Array.isArray(maps)) return invalid('listener maps', maps, 'must be an array')
  const vhosts = new Set<string>()
  const seen = new Set<string>()
  const lines = [kv('address', `127.0.0.1:${port}`), kv('secure', 0)]
  for (const m of maps) {
    const vhost = assertDomainName(m?.vhost, 'OpenLiteSpeed vhost name')
    if (vhosts.has(vhost)) invalid('OpenLiteSpeed vhost name', vhost, 'is declared twice')
    vhosts.add(vhost)
    if (!Array.isArray(m.names) || m.names.length === 0) invalid('listener map', vhost, 'needs at least one name')
    for (const n of m.names.map((x) => assertServedName(x))) {
      if (seen.has(n)) invalid('server name', n, 'is mapped to more than one vhost')
      seen.add(n)
    }
    lines.push(kv('map', `${vhost} ${m.names.join(', ')}`))
  }
  return `${block('listener xpanel-backend', lines).join('\n')}\n`
}

/** Server-level settings: trust Nginx on loopback for the client IP. */
export const renderOlsServerBase = (settings: ServerSettings): string => {
  assertOlsEngine(settings)
  return [
    '# Managed by xPanel: OpenLiteSpeed behind the Nginx edge',
    kv('useIpInProxyHeader', 2),
    ...block('accessControl', [kv('allow', 'ALL, 127.0.0.1T, ::1T')]),
  ].join('\n') + '\n'
}
