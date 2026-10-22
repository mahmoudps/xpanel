// Nginx edge on 80/443. It proxies to the loopback backend (Apache or OpenLiteSpeed) or to an
// app upstream, caches responses (never files), and never opens anything inside a home.
import { validateNginxWorkers } from '@xpanel/core'
import type { Account, Certificate, ConfigTest, Domain, HostAction, Limit, OsProfile, RenderedFile, ServerSettings } from '@xpanel/core'
import { certPaths, DEFAULT_TLS, nginxAccessLog, nginxBinary, nginxErrorLog, nginxModuleIncludes, XP_PATHS } from './paths.ts'
import { nginxQuote } from './quote.ts'
import { asCertList, certForName, groupSites, siteMode, siteUpstream, type RenderTime, type SiteGroup, type UpstreamPolicy } from './sites.ts'
import {
  assertBackendPort,
  assertDomainName,
  assertIncludeGlob,
  assertInt,
  assertSafeAbsPath,
  assertSystemUser,
  formatCidr,
  invalid,
  parseCidr,
} from './validate.ts'
import { renderWafHttp, renderWafSite, type ModsecuritySettings, type WafGlobalPolicy, type WafSitePolicy } from './waf.ts'

/**
 * Edge settings not in the shared ServerSettings contract. Optional so a plain
 * ServerSettings is accepted.
 */
export interface EdgeExtras {
  /** present only when ModSecurity v3 + the nginx connector are installed */
  modsecurity?: ModsecuritySettings | null
  waf?: WafGlobalPolicy | null
  /** CDN / load balancer addresses whose client-IP header is trusted (empty: none) */
  trustedProxies?: string[]
  /** default X-Forwarded-For; 'proxy_protocol' when the balancer speaks it */
  realIpHeader?: string
  /** default request body cap per site, MB (default 128) */
  clientMaxBodyMb?: Limit
  /** proxy cache size cap, MB (default 1024) */
  proxyCacheMaxMb?: number
  /** listen on [::] too (default true) */
  ipv6?: boolean
  /** 'listen' = `listen 443 ssl http2` (nginx < 1.25.1), 'directive' = `http2 on;` */
  http2?: 'listen' | 'directive'
  /** nginx >= 1.19.4: refuse TLS for unbound names instead of using the fallback certificate */
  sslRejectHandshake?: boolean
  /** override the distribution's dynamic-module includes */
  nginxModuleIncludes?: string[]
  /** DNS resolvers for proxy sites whose upstream is a hostname (resolved per request) */
  resolvers?: string[]
}

export type EdgeSettings = ServerSettings & { edge?: EdgeExtras }

const extras = (s: ServerSettings): EdgeExtras => (s as EdgeSettings).edge ?? {}

const indent = (lines: string[], n = 1): string[] => lines.map((l) => (l === '' ? l : `${'    '.repeat(n)}${l}`))

const block = (head: string, body: string[]): string[] => [`${head} {`, ...indent(body), '}']

// ---- main ---------------------------------------------------------------------------------

const REAL_IP_HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/

const realIp = (e: EdgeExtras): string[] => {
  const proxies = (e.trustedProxies ?? []).map((p) => formatCidr(parseCidr(p, 'trusted proxy')))
  if (proxies.length === 0) return ['# real client IP: TCP peer (no trusted proxies configured)']
  const header = e.realIpHeader ?? 'X-Forwarded-For'
  if (header !== 'proxy_protocol' && !REAL_IP_HEADER.test(header)) invalid('real IP header', header, 'is not a header name')
  return [...proxies.map((p) => `set_real_ip_from ${p};`), `real_ip_header ${header};`, 'real_ip_recursive on;']
}

const METRICS_FORMAT = [
  `'{"time":"$time_iso8601","host":"$host","ip":"$remote_addr","method":"$request_method",'`,
  `'"uri":"$request_uri","status":$status,"body_bytes":$body_bytes_sent,"bytes":$bytes_sent,'`,
  `'"request_bytes":$request_length,"request_time":$request_time,'`,
  `'"upstream_time":"$upstream_response_time","cache":"$upstream_cache_status",'`,
  `'"referer":"$http_referer","agent":"$http_user_agent"}'`,
]

/** Worker tuning by the core rule (worker_rlimit_nofile covers a client and an upstream fd per connection). */
export const assertNginxTuning = (s: ServerSettings): ServerSettings['nginx'] => validateNginxWorkers(s.nginx)

/** /etc/nginx/nginx.conf (path from the OsProfile). */
export const renderNginxMain = (settings: ServerSettings, os: OsProfile): RenderedFile => {
  const n = assertNginxTuning(settings)
  const e = extras(settings)
  const user = assertSystemUser(os.paths.nginxUser, 'nginx user')
  const root = assertSafeAbsPath(os.paths.nginxRoot, 'nginx root')
  const vhostDir = assertSafeAbsPath(os.paths.nginxVhostDir, 'nginx vhost dir')
  const modules = (e.nginxModuleIncludes ?? nginxModuleIncludes(os)).map((m) => assertIncludeGlob(m, 'nginx module include'))
  const cacheMb = assertInt('proxy cache size (MB)', e.proxyCacheMaxMb ?? 1024, 16, 1048576)

  const http = [
    `include ${root}/mime.types;`,
    'default_type application/octet-stream;',
    'server_tokens off;',
    'sendfile on;',
    'tcp_nopush on;',
    'tcp_nodelay on;',
    `keepalive_timeout ${n.keepaliveTimeoutSec}s;`,
    'types_hash_max_size 4096;',
    // a bucket must hold the longest legal name (253 chars + pointer), or one customer's long
    // domain fails `nginx -t` for the whole server
    'server_names_hash_bucket_size 512;',
    'server_names_hash_max_size 16384;',
    'variables_hash_max_size 2048;',
    'map_hash_bucket_size 128;',
    'client_max_body_size 128m;',
    '',
    `log_format xpanel_metrics escape=json`,
    ...indent(METRICS_FORMAT),
    '    ;',
    `access_log ${XP_PATHS.nginxLogDir}/access.log xpanel_metrics;`,
    '',
    ...realIp(e),
    '',
    'ssl_protocols TLSv1.2 TLSv1.3;',
    'ssl_prefer_server_ciphers off;',
    'ssl_session_cache shared:xpanel_tls:32m;',
    'ssl_session_timeout 1d;',
    'ssl_session_tickets off;',
    '',
    'gzip on;',
    'gzip_vary on;',
    'gzip_proxied any;',
    'gzip_min_length 1024;',
    'gzip_types text/plain text/css text/xml application/json application/javascript application/xml application/rss+xml image/svg+xml;',
    '',
    '# responses only: Nginx never reads customer files',
    `proxy_cache_path ${XP_PATHS.nginxCacheDir} levels=1:2 keys_zone=xpanel_cache:64m max_size=${cacheMb}m inactive=60m use_temp_path=off;`,
    ...block('map $request_method $xpanel_nocache_method', ['GET 0;', 'HEAD 0;', 'default 1;']),
    ...block('map $http_cookie $xpanel_nocache_cookie', ['"" 0;', 'default 1;']),
    ...block('map $http_upgrade $xpanel_connection', ['"" close;', 'default upgrade;']),
    'proxy_http_version 1.1;',
    'proxy_connect_timeout 10s;',
    'proxy_send_timeout 300s;',
    'proxy_read_timeout 300s;',
    'proxy_buffers 16 16k;',
    'proxy_buffer_size 16k;',
    '',
    ...renderWafHttp(e.waf, e.modsecurity).trimEnd().split('\n'),
    '',
    `include ${assertIncludeGlob(`${vhostDir}/*.conf`)};`,
  ]

  const lines = [
    '# Managed by xPanel. Changes are overwritten on the next config generation.',
    `user ${user};`,
    `worker_processes ${n.workerProcesses};`,
    `worker_rlimit_nofile ${n.workerRlimitNofile};`,
    'pid /run/nginx.pid;',
    `error_log ${XP_PATHS.nginxLogDir}/error.log warn;`,
    ...modules.map((m) => `include ${m};`),
    '',
    ...block('events', [`worker_connections ${n.workerConnections};`, `multi_accept ${n.multiAccept ? 'on' : 'off'};`]),
    '',
    ...block('http', http),
  ]
  return { path: `${root}/nginx.conf`, content: `${lines.join('\n')}\n`, mode: 0o644, owner: 'root', group: 'root' }
}

/** Directories the edge needs; the cache belongs to the nginx worker user, nothing to an account. */
export const nginxEdgeDirs = (os: OsProfile): HostAction[] => {
  const user = assertSystemUser(os.paths.nginxUser, 'nginx user')
  return [
    { kind: 'ensure-dir', path: XP_PATHS.nginxCacheDir, mode: 0o700, owner: user, group: user },
    { kind: 'ensure-dir', path: XP_PATHS.nginxLogDir, mode: 0o750, owner: 'root', group: user },
    { kind: 'ensure-dir', path: XP_PATHS.acmeDir, mode: 0o755, owner: 'root', group: 'root' },
    { kind: 'ensure-dir', path: XP_PATHS.suspendedDir, mode: 0o755, owner: 'root', group: 'root' },
    { kind: 'ensure-dir', path: XP_PATHS.defaultSiteDir, mode: 0o755, owner: 'root', group: 'root' },
  ]
}

export const nginxConfigTest = (os: OsProfile): ConfigTest => ({
  name: 'nginx',
  argv: [nginxBinary(os), '-t', '-q', '-c', `${assertSafeAbsPath(os.paths.nginxRoot, 'nginx root')}/nginx.conf`],
})

// ---- sites --------------------------------------------------------------------------------

export interface NginxSiteOptions extends UpstreamPolicy {
  /** WAF policy per site, keyed by the site's main domain name */
  waf?: Record<string, WafSitePolicy>
  /** redirect plain HTTP to HTTPS for names that have a certificate (ACME stays on HTTP) */
  forceHttps?: boolean
  /** response cache for proxied sites (default true) */
  cache?: boolean
  /** time used to stop expired sites (default: the time of rendering) */
  now?: RenderTime
}

const listen = (port: 80 | 443, e: EdgeExtras, extra = ''): string[] => {
  const h2 = port === 443 && (e.http2 ?? 'listen') === 'listen' ? ' http2' : ''
  const ssl = port === 443 ? ' ssl' : ''
  const out = [`listen ${port}${ssl}${h2}${extra};`]
  if (e.ipv6 !== false) out.push(`listen [::]:${port}${ssl}${h2}${extra};`)
  if (port === 443 && e.http2 === 'directive') out.push('http2 on;')
  return out
}

// alias without try_files: try_files resolves $uri against the alias inconsistently (nginx #97)
const acmeLocation = (): string[] =>
  block('location ^~ /.well-known/acme-challenge/', [`alias ${XP_PATHS.acmeDir}/;`, 'default_type text/plain;'])

const suspendedLocations = (): string[] => [
  'error_page 404 503 /index.html;',
  ...block('location = /index.html', [`root ${XP_PATHS.suspendedDir};`, 'internal;', 'add_header Retry-After 3600 always;']),
  ...block('location /', ['return 503;']),
]

interface ProxyTarget {
  url: string
  tls: boolean
  pre?: string[]
}

const proxyLocation = (t: ProxyTarget, cache: boolean): string[] => {
  const body = [
    ...(t.pre ?? []),
    `proxy_pass ${t.url};`,
    'proxy_set_header Host $host;',
    'proxy_set_header X-Real-IP $remote_addr;',
    'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    'proxy_set_header X-Forwarded-Proto $scheme;',
    'proxy_set_header X-Forwarded-Host $host;',
    'proxy_set_header X-Forwarded-Port $server_port;',
    'proxy_set_header Upgrade $http_upgrade;',
    'proxy_set_header Connection $xpanel_connection;',
    // httpoxy (CVE-2016-5385): a client "Proxy:" header must never become HTTP_PROXY for PHP/CGI
    'proxy_set_header Proxy "";',
  ]
  if (t.tls) body.push('proxy_ssl_server_name on;')
  if (cache) {
    body.push(
      'proxy_cache xpanel_cache;',
      // $host keeps tenants apart: the default key would use the shared backend address
      'proxy_cache_key $scheme$host$request_uri;',
      'proxy_cache_methods GET HEAD;',
      'proxy_cache_bypass $xpanel_nocache_method $xpanel_nocache_cookie $http_authorization;',
      'proxy_no_cache $xpanel_nocache_method $xpanel_nocache_cookie $http_authorization $upstream_http_set_cookie;',
      'proxy_cache_use_stale error timeout updating http_502 http_503 http_504;',
      'proxy_cache_lock on;',
      'add_header X-Cache-Status $upstream_cache_status always;',
    )
  }
  return block('location /', body)
}

/**
 * IP upstreams are static. Hostname upstreams are resolved per request through the
 * configured resolvers, so one customer's dead DNS name can never fail `nginx -t` for all.
 */
const upstreamTarget = (d: Domain, ctx: SiteCtx): ProxyTarget => {
  const u = siteUpstream(d, ctx.settings, ctx.opts)
  const tls = u.scheme === 'https'
  if (u.hostKind === 'ip') {
    const url = u.path && !u.path.endsWith('/') ? `${u.url}/` : u.url
    return { url, tls }
  }
  const resolvers = (ctx.e.resolvers ?? []).map((r) => formatCidr(parseCidr(r, 'resolver')))
  if (resolvers.length === 0 || resolvers.some((r) => r.includes('/'))) {
    return invalid('upstream', d.upstream, 'hostname upstreams need edge.resolvers (plain IP addresses)')
  }
  const base = `${u.scheme}://${u.hostLiteral}:${u.port}${u.path.replace(/\/+$/, '')}`
  return {
    url: `${base}$request_uri`,
    tls,
    pre: [`resolver ${resolvers.map((r) => (r.includes(':') ? `[${r}]` : r)).join(' ')} valid=300s;`, 'resolver_timeout 5s;'],
  }
}

interface SiteCtx {
  account: Account
  settings: ServerSettings
  e: EdgeExtras
  opts: NginxSiteOptions
  backend: string
}

const siteBody = (g: SiteGroup, ctx: SiteCtx, toHttps: boolean): string[] => {
  const mode = siteMode(ctx.account, g.main, ctx.opts.now)
  const body = acmeLocation()
  if (mode === 'suspended') return [...body, ...suspendedLocations()]
  if (mode === 'redirect' && g.main.redirect) {
    return [...body, ...block('location /', [`return ${g.main.redirect.code} ${nginxQuote(g.main.redirect.to)};`])]
  }
  if (toHttps) return [...body, ...block('location /', ['return 301 https://$host$request_uri;'])]
  const cache = ctx.opts.cache !== false
  if (mode === 'upstream') return [...body, ...proxyLocation(upstreamTarget(g.main, ctx), cache)]
  return [...body, ...proxyLocation({ url: ctx.backend, tls: false }, cache)]
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
  })
  const head = (names: string[]): string[] => [
    `server_name ${names.join(' ')};`,
    `access_log ${nginxAccessLog(name)} xpanel_metrics;`,
    `error_log ${nginxErrorLog(name)} warn;`,
    ...waf.server,
  ]
  const parts = partitionByCert(g, certs)
  const secure = parts.filter((p): p is NamePart & { cert: Certificate } => p.cert !== null)
  const out = [`# site ${name}${g.aliases.length ? ` (+ ${g.aliases.map((a) => a.name).join(', ')})` : ''}`]
  out.push(...waf.http)
  if (ctx.opts.forceHttps) {
    const tlsNames = secure.flatMap((p) => p.names)
    const plainNames = parts.filter((p) => p.cert === null).flatMap((p) => p.names)
    if (tlsNames.length) out.push(...block('server', [...listen(80, ctx.e), ...head(tlsNames), ...siteBody(g, ctx, true)]))
    if (plainNames.length) out.push(...block('server', [...listen(80, ctx.e), ...head(plainNames), ...siteBody(g, ctx, false)]))
  } else {
    out.push(...block('server', [...listen(80, ctx.e), ...head([...g.names, ...g.wildcards]), ...siteBody(g, ctx, false)]))
  }
  for (const p of secure) {
    const files = certPaths(p.cert.id)
    out.push(
      ...block('server', [
        ...listen(443, ctx.e),
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
  const ctx: SiteCtx = {
    account,
    settings,
    e: extras(settings),
    opts,
    backend: `http://127.0.0.1:${assertBackendPort(settings)}`,
  }
  // a certificate owned by another account is never installed here, whatever the caller passed
  const certs = asCertList(cert).filter((c) => c.accountId === null || c.accountId === account.id)
  const parts = groups.map((g) => renderGroup(g, ctx, certs).join('\n'))
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
}

/** Catch-all for names no account has bound: a static notice, 404, and ACME for the hostname. */
export const renderDefaultSite = (opts: DefaultSiteOptions = {}): string => {
  const e = opts.settings ? extras(opts.settings) : {}
  const hostname = opts.settings ? assertDomainName(opts.settings.hostname, 'hostname') : null
  const tls = e.sslRejectHandshake && !opts.cert
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
    ...block('location /', ['return 404;']),
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
