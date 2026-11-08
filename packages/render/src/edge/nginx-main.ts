import { validateNginxWorkers } from '@xpanel/core'
import type { ConfigTest, HostAction, OsProfile, RenderedFile, ServerSettings } from '@xpanel/core'
import { posix } from 'node:path'
import { readAdmittedTrustedProxyPolicy, renderTrustedProxyRealIp } from '../../../core/src/trusted-proxies.ts'
import type { TrustedProxyRenderAuthority } from '../../../core/src/trusted-proxies.ts'
import type { EdgeExtras } from './nginx.ts'
import { block, extras, indent } from './nginx-syntax.ts'
import { nginxBinary, nginxModuleIncludes, XP_PATHS } from './paths.ts'
import { assertIncludeGlob, assertInt, assertSafeAbsPath, assertSystemUser, invalid } from './validate.ts'
import { renderWafHttp } from './waf.ts'
import { assertWebDirectives, includeLines } from './web-directives.ts'

// ---- main ---------------------------------------------------------------------------------

const realIp = (e: EdgeExtras, authority?: TrustedProxyRenderAuthority): string[] => {
  if (e.trustedProxies !== undefined || e.realIpHeader !== undefined) invalid('real IP authority', 'legacy edge extras', 'use the guarded canonical trusted proxy policy')
  const policy = authority ? readAdmittedTrustedProxyPolicy(authority) : { cidrs: [], header: 'X-Forwarded-For' as const }
  return renderTrustedProxyRealIp(policy).trimEnd().split('\n')
}
const METRICS_FORMAT = [
  `'{"time":"$time_iso8601","host":"$host","ip":"$remote_addr","method":"$request_method",'`,
  `'"uri":"$request_uri","status":$status,"body_bytes":$body_bytes_sent,"bytes":$bytes_sent,'`,
  `'"request_bytes":$request_length,"request_time":$request_time,'`,
  `'"scheme":"$scheme","protocol":"$server_protocol",'`,
  `'"upstream_time":"$upstream_response_time","cache":"$upstream_cache_status",'`,
  `'"referer":"$http_referer","agent":"$http_user_agent"}'`,
]

// A site with visitor logging off: same fields, so usage still counts and every reader parses it, without the visitor.
const USAGE_FORMAT = [
  `'{"time":"$time_iso8601","host":"$host","ip":"-","method":"-",'`,
  `'"uri":"-","status":$status,"body_bytes":$body_bytes_sent,"bytes":$bytes_sent,'`,
  `'"request_bytes":$request_length,"request_time":$request_time,'`,
  `'"scheme":"$scheme","protocol":"$server_protocol",'`,
  `'"upstream_time":"$upstream_response_time","cache":"$upstream_cache_status",'`,
  `'"referer":"","agent":""}'`,
]

/** Worker tuning by the core rule (worker_rlimit_nofile covers a client and an upstream fd per connection). */
export const assertNginxTuning = (s: ServerSettings): ServerSettings['nginx'] => validateNginxWorkers(s.nginx)

/** /etc/nginx/nginx.conf (path from the OsProfile). */
export const renderNginxMain = (settings: ServerSettings, os: OsProfile, trustedProxyAuthority?: TrustedProxyRenderAuthority): RenderedFile => {
  const n = assertNginxTuning(settings)
  const w = assertWebDirectives(settings)
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
    `client_max_body_size ${w.clientMaxBodyMb}m;`,
    '',
    `log_format xpanel_metrics escape=json`,
    ...indent(METRICS_FORMAT),
    '    ;',
    `log_format xpanel_usage escape=json`,
    ...indent(USAGE_FORMAT),
    '    ;',
    `access_log ${XP_PATHS.nginxLogDir}/access.log xpanel_metrics;`,
    '',
    ...realIp(e, trustedProxyAuthority),
    '',
    `ssl_protocols ${w.tlsProtocols.join(' ')};`,
    `ssl_ciphers ${w.tlsCiphers};`,
    'ssl_prefer_server_ciphers off;',
    'ssl_session_cache shared:xpanel_tls:32m;',
    'ssl_session_timeout 1d;',
    'ssl_session_tickets off;',
    '',
    ...(w.gzip.enabled ? [
      'gzip on;',
      `gzip_comp_level ${w.gzip.level};`,
      'gzip_vary on;',
      'gzip_proxied any;',
      'gzip_min_length 1024;',
      'gzip_types text/plain text/css text/xml application/json application/javascript application/xml application/rss+xml image/svg+xml;',
    ] : ['gzip off;']),
    '',
    '# responses only: Nginx never reads customer files',
    `proxy_cache_path ${XP_PATHS.nginxCacheDir} levels=1:2 keys_zone=xpanel_cache:64m max_size=${cacheMb}m inactive=60m use_temp_path=off;`,
    ...block('map $request_method $xpanel_nocache_method', ['GET 0;', 'HEAD 0;', 'default 1;']),
    ...block('map $http_cookie $xpanel_nocache_cookie', ['"" 0;', 'default 1;']),
    ...block('map $http_upgrade $xpanel_connection', ['"" close;', 'default upgrade;']),
    'proxy_http_version 1.1;',
    'proxy_connect_timeout 10s;',
    `proxy_send_timeout ${w.timeoutSec}s;`,
    `proxy_read_timeout ${w.timeoutSec}s;`,
    'proxy_buffers 16 16k;',
    'proxy_buffer_size 16k;',
    '',
    ...renderWafHttp(e.waf, e.modsecurity).trimEnd().split('\n'),
    '',
    ...includeLines('http', w.includes.nginxHttp),
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
  // Parents first: ensure-dir creates one level. The cache parent is traverse-only so the nginx workers reach
  // their cache while the agent's root-only native cache beside it stays unlisted.
  return [
    { kind: 'ensure-dir', path: posix.dirname(XP_PATHS.nginxCacheDir), mode: 0o711, owner: 'root', group: 'root' },
    { kind: 'ensure-dir', path: XP_PATHS.nginxCacheDir, mode: 0o700, owner: user, group: user },
    { kind: 'ensure-dir', path: XP_PATHS.nginxLogDir, mode: 0o750, owner: 'root', group: user },
    { kind: 'ensure-dir', path: XP_PATHS.acmeDir, mode: 0o755, owner: 'root', group: 'root' },
    { kind: 'ensure-dir', path: posix.dirname(XP_PATHS.suspendedDir), mode: 0o755, owner: 'root', group: 'root' },
    { kind: 'ensure-dir', path: XP_PATHS.suspendedDir, mode: 0o755, owner: 'root', group: 'root' },
    { kind: 'ensure-dir', path: XP_PATHS.defaultSiteDir, mode: 0o755, owner: 'root', group: 'root' },
  ]
}

export const nginxConfigTest = (os: OsProfile): ConfigTest => ({
  name: 'nginx',
  argv: [nginxBinary(os), '-t', '-q', '-c', `${assertSafeAbsPath(os.paths.nginxRoot, 'nginx root')}/nginx.conf`],
})
