import { accountProbeNginxLocation } from '../system/account-probe.ts'
import { davWellKnownLocations } from '../system/dav.ts'
import { movedTarget, renderAccountEdgeServer, type AccountEdgePolicy } from './account-edge.ts'
// Nginx edge on 80/443. It proxies to the loopback backend (Apache or OpenLiteSpeed) or to an
// app upstream, caches responses (never files), and never opens anything inside a home.
import { assertProxyOptions, resolveDomainEffectiveIps, validateDefaultSitePolicy } from '@xpanel/core'
import type { Account, Certificate, Domain, Limit, OsProfile, ProxyOptions, RenderedFile, ServerSettings } from '@xpanel/core'
import { certPaths, DEFAULT_TLS, nginxAccessLog, nginxErrorLog, XP_PATHS } from './paths.ts'
import type { NginxHttp2Style } from '../../../../scripts/nginx-http2.mjs'
import { accountPageDir, panelRedirectLocations, type PanelRedirect } from './account-pages.ts'
import { renderNginxMain } from './nginx-main.ts'
import { withProxyRules, type ProxyRule } from './proxy-rules.ts'
import { block, extras, indent } from './nginx-syntax.ts'
import { nginxQuote } from './quote.ts'
import { mailAutoconfigLocations, renderMailAutoconfigServers, type MailAutoconfigOption } from './mail-autoconfig.ts'
import { asCertList, certForName, groupSites, siteMode, siteUpstream, type RenderTime, type SiteGroup, type UpstreamPolicy } from './sites.ts'
import {
  assertBackendPort,
  assertDomainName,
  assertSafeAbsPath,
  formatCidr,
  parseCidr,
  invalid,
} from './validate.ts'
import { renderWafSite, type ModsecuritySettings, type WafGlobalPolicy, type WafSitePolicy } from './waf.ts'
import { renderSiteEdge, siteStoppedLocations } from './site-options.ts'

/**
 * Edge settings not in the shared ServerSettings contract. Optional so a plain
 * ServerSettings is accepted.
 */
export interface EdgeExtras {
  /** present only when ModSecurity v3 + the nginx connector are installed */
  modsecurity?: ModsecuritySettings | null
  waf?: WafGlobalPolicy | null
  /** Legacy alternate authority; rendering refuses this field. Use the guarded third renderer argument. */
  trustedProxies?: string[]
  /** Legacy alternate authority; custom and PROXY-protocol headers are not admitted here. */
  realIpHeader?: string
  /** default request body cap per site, MB (default 128) */
  clientMaxBodyMb?: Limit
  /** proxy cache size cap, MB (default 1024) */
  proxyCacheMaxMb?: number
  /** listen on [::] too (default true) */
  ipv6?: boolean
  /** 'listen' = `listen 443 ssl http2` (nginx < 1.25.1), 'directive' = `http2 on;`; the agent sets the installed binary's style */
  http2?: NginxHttp2Style
  /** nginx >= 1.19.4: refuse TLS for unbound names instead of using the fallback certificate */
  sslRejectHandshake?: boolean
  /** override the distribution's dynamic-module includes */
  nginxModuleIncludes?: string[]
  /** DNS resolvers for proxy sites whose upstream is a hostname (resolved per request) */
  resolvers?: string[]
}

export type EdgeSettings = ServerSettings & { edge?: EdgeExtras }

// ---- sites --------------------------------------------------------------------------------

export interface NginxSiteOptions extends UpstreamPolicy {
  /** WAF policy per site, keyed by the site's main domain name */
  waf?: Record<string, WafSitePolicy>
  /** response cache for proxied sites (default true) */
  cache?: boolean
  /** time used to stop expired sites (default: the time of rendering) */
  now?: RenderTime
  /** runtime apps per site, keyed by the site's main domain name */
  appRoutes?: Record<string, AppRoute[]>
  /** canonical pool addresses with the dedicated role: a site on one listens on that address only */
  dedicatedAddresses?: ReadonlySet<string>
  /** reverse proxy rules per site, keyed by the site's main domain name (proxy-rules.ts) */
  proxyRules?: Record<string, ProxyRule[]>
  /** the account's IP Blocker list and cache epoch (account-edge.ts) */
  accountEdge?: AccountEdgePolicy | null
  /** mail client autoconfiguration for the account's domains that receive mail */
  mailAutoconfig?: MailAutoconfigOption
  /** the account's names on the calendar port, which the site's .well-known paths redirect to */
  calDavNames?: readonly string[]
  /** account compression choice; absent keeps the server default from the main configuration */
  compression?: { mode: 'disabled' | 'all' | 'types'; types: string[] }
  /** panel paths the site answers with a redirect (Tweak Settings: Redirection) */
  panelRedirects?: readonly PanelRedirect[]
  /** the account's Web Template Editor page set; absent is the server's own */
  pageScope?: string
}

/** A runtime app served on a URL path of a site through its root-owned front socket. */
export interface AppRoute {
  /** '/' or a lowercase path without trailing slash, e.g. '/api' */
  path: string
  /** front socket under /run/xpanel-app-proxy/ */
  socket: string
}

const APP_ROUTE_PATH_RE = /^\/(?:[a-z0-9][a-z0-9._-]{0,62}(?:\/[a-z0-9][a-z0-9._-]{0,62}){0,3})?$/
const APP_SOCKET_RE = /^\/run\/xpanel-app-proxy\/[a-z][a-z0-9]{0,15}-[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\.sock$/

/** A dedicated address of a site, or null for every address; `default*` makes the site that address's default server. */
interface Bind { v4: string | null; v6: string | null; default4: boolean; default6: boolean }

// A specific-address listen shares the wildcard socket of the default site, so nginx needs no bound alias to start.
const listen = (port: 80 | 443, e: EdgeExtras, extra = '', bind?: Bind): string[] => {
  const h2 = port === 443 && (e.http2 ?? 'listen') === 'listen' ? ' http2' : ''
  const ssl = port === 443 ? ' ssl' : ''
  const flag = (on: boolean | undefined): string => on ? ' default_server' : ''
  const out = [`listen ${bind?.v4 ? `${bind.v4}:` : ''}${port}${ssl}${h2}${extra}${flag(bind?.default4)};`]
  if (e.ipv6 !== false) out.push(`listen [${bind?.v6 ?? '::'}]:${port}${ssl}${h2}${extra}${flag(bind?.default6)};`)
  if (port === 443 && e.http2 === 'directive') out.push('http2 on;')
  return out
}

// alias without try_files: try_files resolves $uri against the alias inconsistently (nginx #97)
const acmeLocation = (): string[] =>
  block('location ^~ /.well-known/acme-challenge/', [`alias ${XP_PATHS.acmeDir}/;`, 'default_type text/plain;'])

const suspendedLocations = (pageScope?: string): string[] => [
  'error_page 404 503 /index.html;',
  ...block('location = /index.html', [`root ${accountPageDir('suspended', pageScope)};`, 'internal;', 'add_header Retry-After 3600 always;']),
  ...block('location /', ['return 503;']),
]

/** Served by the edge itself while account.bandwidthLimitedMonth is set: no file, no backend, no tenant path. */
export const BANDWIDTH_LIMIT_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bandwidth limit exceeded</title></head>'
  + '<body><h1>Bandwidth limit exceeded</h1><p>This website has used its monthly bandwidth. It will be available again at the start of next month (UTC) or when the hosting administrator raises the limit.</p></body></html>'
const bandwidthLimitLocations = (): string[] =>
  block('location /', ['default_type text/html;', 'add_header Cache-Control "no-store" always;', 'add_header Retry-After 3600 always;', `return 503 ${nginxQuote(BANDWIDTH_LIMIT_PAGE)};`])

interface ProxyTarget {
  url: string
  tls: boolean
  pre?: string[]
  /** owner options of a reverse-proxy site; absent keeps the defaults */
  options?: ProxyOptions
  /** fixed backend Host: the default site answers for names no vhost knows */
  host?: string
}

const proxyLocation = (t: ProxyTarget, cache: boolean, at = '/'): string[] => {
  const o = t.options
  const body = [
    ...(t.pre ?? []),
    `proxy_pass ${t.url};`,
    t.host ? `proxy_set_header Host ${t.host};` : o?.hostHeader === 'upstream' ? 'proxy_set_header Host $proxy_host;' : 'proxy_set_header Host $host;',
    'proxy_set_header X-Real-IP $remote_addr;',
    'proxy_set_header X-Forwarded-For $remote_addr;',
    'proxy_set_header Forwarded "";',
    'proxy_set_header X-Forwarded-Proto $scheme;',
    'proxy_set_header X-Forwarded-Host $host;',
    'proxy_set_header X-Forwarded-Port $server_port;',
    ...(o?.websocket === false
      ? ['proxy_set_header Upgrade "";', 'proxy_set_header Connection close;']
      : ['proxy_set_header Upgrade $http_upgrade;', 'proxy_set_header Connection $xpanel_connection;']),
    // httpoxy (CVE-2016-5385): a client "Proxy:" header must never become HTTP_PROXY for PHP/CGI
    'proxy_set_header Proxy "";',
    ...(o?.headers ?? []).map((h) => `proxy_set_header ${h.name} ${nginxQuote(h.value, 'proxy header value')};`),
  ]
  if (t.tls) body.push('proxy_ssl_server_name on;')
  if (cache) {
    body.push(
      'proxy_cache xpanel_cache;',
      // $host keeps tenants apart: the default key would use the shared backend address
      'proxy_cache_key $xpanel_cache_epoch$scheme$host$request_uri;',
      'proxy_cache_methods GET HEAD;',
      'proxy_cache_bypass $xpanel_nocache_method $xpanel_nocache_cookie $http_authorization;',
      'proxy_no_cache $xpanel_nocache_method $xpanel_nocache_cookie $http_authorization $upstream_http_set_cookie;',
      'proxy_cache_use_stale error timeout updating http_502 http_503 http_504;',
      'proxy_cache_lock on;',
      'add_header X-Cache-Status $upstream_cache_status always;',
    )
  }
  return block(at === '/' ? 'location /' : `location ^~ ${at}/`, body)
}

/** App locations of one site; a '/' app replaces the backend. Responses of apps are never cached. */
const appLocations = (routes: readonly AppRoute[]): { paths: string[]; root: string[] | null } => {
  const seen = new Set<string>()
  let root: string[] | null = null
  const paths: string[] = []
  for (const r of routes) {
    if (!APP_ROUTE_PATH_RE.test(r.path) || seen.has(r.path)) invalid('app route path', r.path, 'must be / or a unique lowercase path without trailing slash')
    if (!APP_SOCKET_RE.test(r.socket)) invalid('app route socket', r.socket, 'must be an xPanel app front socket')
    seen.add(r.path)
    const target = { url: `http://unix:${r.socket}:`, tls: false }
    if (r.path === '/') root = proxyLocation(target, false)
    else paths.push(...block(`location = ${r.path}`, [`return 308 ${r.path}/$is_args$args;`]), ...proxyLocation(target, false, r.path))
  }
  return { paths, root }
}

/**
 * IP upstreams are static. Hostname upstreams are resolved per request through the
 * configured resolvers, so one customer's dead DNS name can never fail `nginx -t` for all.
 */
const upstreamTarget = (d: Domain, ctx: SiteCtx): ProxyTarget => {
  const u = siteUpstream(d, ctx.settings, ctx.opts)
  const tls = u.scheme === 'https'
  const options = d.siteType === 'proxy' && d.proxy ? { options: assertProxyOptions(d.proxy) } : {}
  if (u.hostKind === 'ip') {
    const url = u.path && !u.path.endsWith('/') ? `${u.url}/` : u.url
    return { url, tls, ...options }
  }
  const resolvers = (ctx.e.resolvers ?? []).map((r) => formatCidr(parseCidr(r, 'resolver')))
  if (resolvers.length === 0 || resolvers.some((r) => r.includes('/'))) {
    return invalid('upstream', d.upstream, 'hostname upstreams need edge.resolvers (plain IP addresses)')
  }
  const base = `${u.scheme}://${u.hostLiteral}:${u.port}${u.path.replace(/\/+$/, '')}`
  return {
    url: `${base}$request_uri`,
    tls,
    ...options,
    pre: [`resolver ${resolvers.map((r) => (r.includes(':') ? `[${r}]` : r)).join(' ')} valid=300s;`, 'resolver_timeout 5s;'],
  }
}

interface SiteCtx {
  account: Account
  settings: ServerSettings
  e: EdgeExtras
  opts: NginxSiteOptions
  backend: string
  /** listen addresses of one server block of a site */
  bind: (g: SiteGroup, port: 80 | 443) => Bind
}

/** Nginx always compresses text/html when gzip is on, and warns when it is listed. */
export const siteCompressionLines = (choice: NginxSiteOptions['compression']): string[] => {
  if (!choice) return []
  if (choice.mode === 'disabled') return ['gzip off;']
  const types = choice.mode === 'all' ? ['*'] : choice.types.filter(type => type !== 'text/html')
  return ['gzip on;', ...(types.length ? [`gzip_types ${types.join(' ')};`] : [])]
}

const siteBody = (g: SiteGroup, ctx: SiteCtx, toHttps: boolean): string[] => {
  const mode = siteMode(ctx.account, g.main, ctx.opts.now)
  const body = [...siteCompressionLines(ctx.opts.compression), ...acmeLocation(), ...mailAutoconfigLocations(ctx.opts.mailAutoconfig, g), ...davWellKnownLocations(ctx.opts.calDavNames, [g.main.name, ...g.aliases.map(alias => alias.name)])]
  // A live transfer moved this account: the suspended source answers through the destination until it is unsuspended.
  if (mode === 'suspended' && ctx.opts.accountEdge?.movedTo) return [...body, ...proxyLocation(movedTarget(ctx.opts.accountEdge.movedTo), false)]
  if (mode === 'suspended') return [...body, ...(siteStoppedLocations(ctx.account, g.main) ?? suspendedLocations(ctx.opts.pageScope))]
  // Only the websites stop: mail, FTP and the panels are separate services. ACME renewals keep working.
  if (ctx.account.bandwidthLimitedMonth !== undefined) return [...body, ...bandwidthLimitLocations()]
  if (g.main.kind === 'primary' && g.main.siteType === 'php' && g.main.php.handler === 'fpm' && !g.main.redirect) {
    body.push(...accountProbeNginxLocation(ctx.account))
  }
  if (mode === 'redirect' && g.main.redirect) {
    return [...body, ...block('location /', [`return ${g.main.redirect.code} ${nginxQuote(g.main.redirect.to)};`])]
  }
  body.push(...panelRedirectLocations(ctx.opts.panelRedirects))
  if (toHttps) return [...body, ...block('location /', ['return 301 https://$host$request_uri;'])]
  const cache = ctx.opts.cache !== false
  const apps = withProxyRules(appLocations(ctx.opts.appRoutes?.[g.main.name] ?? []), body, ctx.opts.proxyRules?.[g.main.name], ctx.settings, (target, at) => proxyLocation(target, cache, at))
  if (apps.root) return [...body, ...apps.paths, ...apps.root]
  if (mode === 'upstream') return [...body, ...apps.paths, ...proxyLocation(upstreamTarget(g.main, ctx), cache)]
  return [...body, ...apps.paths, ...proxyLocation({ url: ctx.backend, tls: false }, cache)]
}

interface NamePart {
  cert: Certificate | null
  names: string[]
}

/** Served names split by the certificate that covers each one (null: no certificate). */
const partitionByCert = (g: SiteGroup, certs: Certificate[]): NamePart[] => {
  const parts: NamePart[] = []
  for (const name of [...g.names, ...g.wildcards]) {
    const cert = certForName(name, g.owners.get(name) ?? g.main, g.main, certs)
    const part = parts.find((p) => (p.cert?.id ?? null) === (cert?.id ?? null))
    if (part) part.names.push(name)
    else parts.push({ cert, names: [name] })
  }
  return parts
}

const renderGroup = (g: SiteGroup, ctx: SiteCtx, certs: Certificate[]): string[] => {
  const name = g.main.name
  const waf = renderWafSite(name, ctx.opts.waf?.[name], {
    defaultBodyMb: ctx.e.clientMaxBodyMb ?? 128,
    modsecurityPresent: Boolean(ctx.e.modsecurity),
    ...(ctx.e.waf?.denyStatus ? { denyStatus: ctx.e.waf.denyStatus } : {}),
  })
  const site = renderSiteEdge(g.main, siteMode(ctx.account, g.main, ctx.opts.now) !== 'suspended')
  const head = (names: string[]): string[] => [
    `server_name ${names.join(' ')};`,
    `access_log ${nginxAccessLog(name)} ${site.logFormat};`,
    `error_log ${nginxErrorLog(name)} warn;`,
    ...waf.server,
    ...site.server,
    ...renderAccountEdgeServer(ctx.opts.accountEdge, ctx.opts.cache !== false),
  ]
  const parts = partitionByCert(g, certs)
  const secure = parts.filter((p): p is NamePart & { cert: Certificate } => p.cert !== null)
  const out = [`# site ${name}${g.aliases.length ? ` (+ ${g.aliases.map((a) => a.name).join(', ')})` : ''}`]
  out.push(...waf.http, ...site.http)
  if (g.main.forceHttps) {
    const tlsNames = secure.flatMap((p) => p.names)
    const plainNames = parts.filter((p) => p.cert === null).flatMap((p) => p.names)
    if (tlsNames.length) out.push(...block('server', [...listen(80, ctx.e, '', ctx.bind(g, 80)), ...head(tlsNames), ...siteBody(g, ctx, true)]))
    if (plainNames.length) out.push(...block('server', [...listen(80, ctx.e, '', ctx.bind(g, 80)), ...head(plainNames), ...siteBody(g, ctx, false)]))
  } else {
    out.push(...block('server', [...listen(80, ctx.e, '', ctx.bind(g, 80)), ...head([...g.names, ...g.wildcards]), ...siteBody(g, ctx, false)]))
  }
  for (const p of secure) {
    const files = certPaths(p.cert.id)
    out.push(
      ...block('server', [
        ...listen(443, ctx.e, '', ctx.bind(g, 443)),
        ...head(p.names),
        `ssl_certificate ${files.cert};`,
        `ssl_certificate_key ${files.key};`,
        ...siteBody(g, ctx, false),
      ]),
    )
  }
  for (const d of [g.main, ...g.aliases]) {
    if (d.certificateId && !certs.some((c) => c.id === d.certificateId)) {
      out.push(`# tls: certificate ${d.certificateId} of ${d.name} was not supplied; names without a covering certificate fall to the default site on 443`)
    }
  }
  return out
}

/**
 * Server blocks for every site of one account: port 80 always, 443 per certificate covering
 * some of the site's names. Explicit subdomains are their own blocks, so nginx prefers them
 * over `*.name`.
 */
export const renderNginxSite = (
  account: Account,
  domains: Domain[],
  settings: ServerSettings,
  cert?: Certificate | Certificate[] | null,
  opts: NginxSiteOptions = {},
): string => {
  const groups = groupSites(account, domains)
  const dedicated = opts.dedicatedAddresses
  const bindOf = (g: SiteGroup): { v4: string | null; v6: string | null } => {
    const ips = resolveDomainEffectiveIps(g.main, account)
    return { v4: dedicated?.has(ips.ipv4) ? ips.ipv4 : null, v6: ips.ipv6 !== null && dedicated?.has(ips.ipv6) ? ips.ipv6 : null }
  }
  // cPanel serves the account's primary site for a request to its dedicated address that names no other site.
  const owner = new Map<string, SiteGroup>()
  for (const g of [...groups].sort((a, b) => Number(b.main.kind === 'primary') - Number(a.main.kind === 'primary'))) {
    for (const address of Object.values(bindOf(g))) if (address !== null && !owner.has(address)) owner.set(address, g)
  }
  const claimed = new Set<string>()
  const take = (g: SiteGroup, address: string | null, port: number): boolean => {
    if (address === null || owner.get(address) !== g || claimed.has(`${address} ${port}`)) return false
    claimed.add(`${address} ${port}`)
    return true
  }
  const ctx: SiteCtx = {
    account,
    settings,
    e: extras(settings),
    opts,
    backend: `http://127.0.0.1:${assertBackendPort(settings)}`,
    bind: (g, port) => { const b = bindOf(g); return { ...b, default4: take(g, b.v4, port), default6: take(g, b.v6, port) } },
  }
  // a certificate owned by another account is never installed here, whatever the caller passed
  const certs = asCertList(cert).filter((c) => c.accountId === null || c.accountId === account.id)
  const parts = groups.map((g) => renderGroup(g, ctx, certs).join('\n'))
  const autoconfig = renderMailAutoconfigServers(opts.mailAutoconfig, groups, certs, port => listen(port, ctx.e))
  if (autoconfig.length) parts.push(autoconfig.join('\n'))
  return `# Managed by xPanel: account ${account.username}\n\n${parts.join('\n\n')}\n`
}

export const nginxSiteFile = (
  account: Account,
  domains: Domain[],
  settings: ServerSettings,
  os: OsProfile,
  cert?: Certificate | Certificate[] | null,
  opts: NginxSiteOptions = {},
): RenderedFile => {
  const content = renderNginxSite(account, domains, settings, cert, opts)
  return {
    path: `${assertSafeAbsPath(os.paths.nginxVhostDir, 'nginx vhost dir')}/xpanel-${account.username}.conf`,
    content,
    mode: 0o644,
    owner: 'root',
    group: 'root',
  }
}

// ---- default site -------------------------------------------------------------------------

export interface DefaultSiteOptions {
  settings?: ServerSettings
  /** serve this certificate (e.g. the hostname's) instead of the self-signed fallback */
  cert?: Certificate | null
  /** names another managed server answers on the shared 80/443 sockets (the management TLS ingress); never claimed here */
  excludedNames?: readonly string[]
}

/** Never cached: the cache key carries the visitor's unbound name, not the site that answered. */
const defaultSiteProxy = (site: string, settings: ServerSettings): string[] =>
  proxyLocation({ url: `http://127.0.0.1:${assertBackendPort(settings)}`, tls: false, host: assertDomainName(site, 'default site') }, false)

/** Catch-all for names no account has bound: a static notice, 404, a fixed redirect or one hosted site, and ACME for the hostname. */
export const renderDefaultSite = (opts: DefaultSiteOptions = {}): string => {
  const e = opts.settings ? extras(opts.settings) : {}
  const policy = opts.settings?.defaultSite === undefined ? undefined : validateDefaultSitePolicy(opts.settings.defaultSite)
  const named = opts.settings ? assertDomainName(opts.settings.hostname, 'hostname') : null
  // A name served twice on one socket is a conflict nginx resolves by ignoring the later server.
  const hostname = named && !opts.excludedNames?.some(name => name.toLowerCase() === named.toLowerCase()) ? named : null
  const tls = (policy?.refuseHttps ?? e.sslRejectHandshake) && !opts.cert
    ? ['ssl_reject_handshake on;']
    : (() => {
        const p = opts.cert ? certPaths(opts.cert.id) : DEFAULT_TLS
        return [`ssl_certificate ${p.cert};`, `ssl_certificate_key ${p.key};`]
      })()
  const body = [
    ...listen(80, e, ' default_server'),
    ...listen(443, e, ' default_server'),
    `server_name _${hostname ? ` ${hostname}` : ''};`,
    ...tls,
    `access_log ${XP_PATHS.nginxLogDir}/default.access.log xpanel_metrics;`,
    'if ($xpanel_waf_deny_ip) { return 403; }',
    ...acmeLocation(),
    `root ${XP_PATHS.defaultSiteDir};`,
    'error_page 404 /index.html;',
    ...block('location = /index.html', ['internal;']),
    ...(policy?.response === 'site' ? defaultSiteProxy(policy.site!, opts.settings!) : block('location /', [policy?.response === 'redirect' ? `return 302 ${nginxQuote(policy.redirectTo!, 'default site redirect')};` : 'return 404;'])),
  ]
  return ['# Managed by xPanel: default site for unbound names', ...block('server', body)].join('\n') + '\n'
}

export const defaultSiteFile = (os: OsProfile, opts: DefaultSiteOptions = {}): RenderedFile => ({
  path: `${assertSafeAbsPath(os.paths.nginxVhostDir, 'nginx vhost dir')}/000-xpanel-default.conf`,
  content: renderDefaultSite(opts),
  mode: 0o644,
  owner: 'root',
  group: 'root',
})

// ---- H05 edge isolation & header sanitization validators ----------------------------------

const SCOPED_PAGE_ROOT = new RegExp(`^(?:${XP_PATHS.suspendedDir}|${XP_PATHS.defaultSiteDir})/[a-z0-9][a-z0-9-]{0,99}$`)
const ALLOWED_NGINX_ROOTS = new Set<string>([
  `${XP_PATHS.acmeDir}/`,
  XP_PATHS.acmeDir,
  XP_PATHS.suspendedDir,
  XP_PATHS.defaultSiteDir,
])

/**
 * Verifies that a rendered Nginx config contains zero `root` or `alias` directives pointing
 * into `/home` or any tenant home directory, ensuring the shared Nginx worker (`www-data`/`nginx`)
 * never opens tenant files directly (H05 — A31).
 */
export const assertNginxZeroHomeAccess = (
  nginxConfigContent: string,
  homeBases: readonly string[] = ['/home'],
): void => {
  if (typeof nginxConfigContent !== 'string') return invalid('nginx config', nginxConfigContent, 'must be a string')
  for (const base of homeBases) {
    const cleanBase = base.replace(/\/+$/, '')
    if (nginxConfigContent.includes(`${cleanBase}/`) || new RegExp(`\\b(?:root|alias)\\s+${cleanBase}\\b`).test(nginxConfigContent)) {
      invalid('nginx home access', cleanBase, `Nginx configuration must never reference tenant home base ${cleanBase}`)
    }
  }
  for (const match of nginxConfigContent.matchAll(/\b(root|alias)\s+([^;\s]+)\s*;/g)) {
    const directive = match[1] ?? 'root'
    const target = match[2] ?? ''
    if (!ALLOWED_NGINX_ROOTS.has(target) && !SCOPED_PAGE_ROOT.test(target)) {
      invalid(`nginx ${directive}`, target, `only xPanel system directories (${[...ALLOWED_NGINX_ROOTS].join(', ')}) are permitted in Nginx`)
    }
  }
}

const REQUIRED_PROXY_HEADERS = [
  'proxy_set_header Host $host;',
  'proxy_set_header X-Real-IP $remote_addr;',
  'proxy_set_header X-Forwarded-For $remote_addr;',
    'proxy_set_header Forwarded "";',
  'proxy_set_header X-Forwarded-Proto $scheme;',
  'proxy_set_header X-Forwarded-Host $host;',
  'proxy_set_header X-Forwarded-Port $server_port;',
  'proxy_set_header Proxy "";',
] as const

/**
 * Verifies that every `proxy_pass` block in a rendered Nginx site config strips/overwrites
 * untrusted client forwarded headers and clears `Proxy` (CVE-2016-5385 httpoxy).
 */
export const assertNginxEdgeHeaderSanitization = (nginxSiteContent: string): void => {
  if (typeof nginxSiteContent !== 'string') return invalid('nginx site config', nginxSiteContent, 'must be a string')
  if (!nginxSiteContent.includes('proxy_pass ')) return
  if (nginxSiteContent.includes('$proxy_add_x_forwarded_for')) invalid('nginx proxy header sanitization', 'appended forwarding chain', 'client forwarding chains must be overwritten')
  for (const match of nginxSiteContent.matchAll(/proxy_set_header\s+(X-Forwarded-For|Forwarded)\s+([^;]+);/gi)) {
    const expected = match[1]!.toLowerCase() === 'forwarded' ? '""' : '$remote_addr'
    if (match[2]!.trim() !== expected) invalid('nginx proxy header sanitization', match[1], 'forwarding identity headers must be overwritten or cleared')
  }
  for (const required of REQUIRED_PROXY_HEADERS) {
    if (!nginxSiteContent.includes(required)) {
      invalid('nginx proxy header sanitization', required, `missing mandatory edge header sanitization directive: ${required}`)
    }
  }
}

export interface NginxEdgeIsolationProof {
  nginxUser: string
  trustedProxiesConfigured: boolean
  zeroHomeAccess: boolean
  headersSanitized: boolean
  cacheKeyIncludesHost: boolean
  defaultCatchall: {
    file: string
    defaultServer80: boolean
    defaultServer443: boolean
    returns404: boolean
    noProxyPass: boolean
    fixedRedirect?: string
    fixedSite?: string
  }
}

/**
 * Verifies the complete Nginx public edge isolation contract (H05 — A31, A35):
 * 1. Nginx never opens `/home` or any account home (`assertNginxZeroHomeAccess`).
 * 2. Untrusted client `X-Real-IP`, `X-Forwarded-*`, and `Proxy` headers are overwritten/stripped at the edge.
 * 3. `set_real_ip_from` is absent unless explicit `trustedProxies` are configured.
 * 4. The default catch-all answers with the original 404 or an explicitly validated fixed redirect; it never proxies to Apache.
 */
export const verifyNginxEdgeIsolation = (
  account: Account,
  domains: Domain[],
  settings: ServerSettings,
  os: OsProfile,
  cert?: Certificate | Certificate[] | null,
  opts: NginxSiteOptions = {},
): NginxEdgeIsolationProof => {
  const main = renderNginxMain(settings, os)
  const def = defaultSiteFile(os, { settings })
  const site = renderNginxSite(account, domains, settings, cert, opts)

  const homeBase = account.home.slice(0, account.home.lastIndexOf('/')) || '/home'
  assertNginxZeroHomeAccess(main.content, ['/home', homeBase])
  assertNginxZeroHomeAccess(def.content, ['/home', homeBase])
  assertNginxZeroHomeAccess(site, ['/home', homeBase])
  assertNginxEdgeHeaderSanitization(site)

  const defaultServer80 = def.content.includes('listen 80 default_server;')
  const defaultServer443 = /listen 443 ssl(?: http2)? default_server;/.test(def.content)
  const returns404 = def.content.includes('return 404;')
  const noProxyPass = !def.content.includes('proxy_pass')
  const policy = settings.defaultSite === undefined ? undefined : validateDefaultSitePolicy(settings.defaultSite)
  const fixedRedirect = policy?.response === 'redirect' ? policy.redirectTo! : undefined
  const fixedSite = policy?.response === 'site' ? policy.site! : undefined
  // Only Host is fixed here; every other forwarded header follows the rule of a site.
  if (fixedSite !== undefined) assertNginxEdgeHeaderSanitization(def.content.replace(`proxy_set_header Host ${fixedSite};`, 'proxy_set_header Host $host;'))
  const responseMatches = fixedSite !== undefined ? !returns404 && def.content.includes(`proxy_set_header Host ${fixedSite};`)
    : fixedRedirect === undefined ? returns404 : !returns404 && def.content.includes(`return 302 ${nginxQuote(fixedRedirect, 'default site redirect')};`)
  if (!defaultServer80 || !defaultServer443 || !responseMatches || noProxyPass === (fixedSite !== undefined)) {
    return invalid('nginx default catch-all site', def.path, 'must be default_server on 80/443 with the explicit response policy, and only a chosen site may use proxy_pass')
  }

  return {
    nginxUser: os.paths.nginxUser,
    trustedProxiesConfigured: main.content.includes('set_real_ip_from '),
    zeroHomeAccess: true,
    headersSanitized: true,
    cacheKeyIncludesHost: site.includes('proxy_cache_key $xpanel_cache_epoch$scheme$host$request_uri;') || opts.cache === false,
    defaultCatchall: {
      file: def.path,
      defaultServer80,
      defaultServer443,
      returns404,
      noProxyPass,
      ...(fixedRedirect !== undefined ? { fixedRedirect } : {}),
      ...(fixedSite !== undefined ? { fixedSite } : {}),
    },
  }
}
