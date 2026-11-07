import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { HostAction, OsProfile, RenderedFile } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { readJsonIfExists } from '@xpanel/state'
import { PMA_HTPASSWD, PMA_TICKET_DIR } from '../../../packages/os/src/db-services-command.ts'
import { SUPPORTED_PHP_VERSIONS } from '../../../packages/os/src/php.ts'
import { DB_SIGNON_CONFIG_PATH, renderPhpMyAdminSignonBridge, renderPhpMyAdminSignonConfig } from './db-signon.ts'
import type { DbSignonConfig } from './db-signon.ts'
import type { AgentExecutor } from './executor.ts'

/**
 * phpMyAdmin Access: one nginx server on its own ports in front of one on-demand PHP-FPM pool, rendered into every
 * generation of a host with the package. Nothing runs until an operator installs phpMyAdmin; idle, only the FPM master stays.
 */
export const PMA_ACCESS_STATE = 'extended/panel/phpmyadmin-access.json'
export const PMA_UNIT = 'xpanel-phpmyadmin-fpm.service'
const FPM_CONF = '/etc/xpanel/phpmyadmin-fpm.conf'
const RUN_DIR = '/run/xpanel-phpmyadmin'
export interface PhpMyAdminAccess { publicAccess: boolean; httpPort: number | null; httpsPort: number; phpVersion: string | null; basicAuth: { user: string; hash: string } | null }
// 8008 and 8009 already carry http_port_t on EL, so SELinux lets nginx bind them; other ports stay refused there.
export const PMA_ACCESS_DEFAULTS: PhpMyAdminAccess = { publicAccess: false, httpPort: 8008, httpsPort: 8009, phpVersion: null, basicAuth: null }
export const PMA_EL_PORTS: readonly number[] = [81, 488, 8008, 8009, 9000]
export interface PhpMyAdminHostObservation { access: PhpMyAdminAccess; root: string; binary: string; hostname: string | null; panelPort: number | null }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const port = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535
export function parsePhpMyAdminAccess(raw: unknown): PhpMyAdminAccess | null {
  if (!object(raw) || typeof raw.publicAccess !== 'boolean' || raw.httpPort !== null && !port(raw.httpPort) || !port(raw.httpsPort) || raw.httpPort === raw.httpsPort) return null
  if (raw.phpVersion !== null && !(SUPPORTED_PHP_VERSIONS as readonly unknown[]).includes(raw.phpVersion)) return null
  const auth = raw.basicAuth
  if (auth !== null && (!object(auth) || typeof auth.user !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(auth.user) || typeof auth.hash !== 'string' || !/^\$6\$[./0-9A-Za-z$=]{20,120}$/.test(auth.hash))) return null
  return { publicAccess: raw.publicAccess, httpPort: raw.httpPort as number | null, httpsPort: raw.httpsPort as number, phpVersion: raw.phpVersion as string | null, basicAuth: auth as PhpMyAdminAccess['basicAuth'] }
}
export const phpMyAdminRoot = (os: Pick<OsProfile, 'family'>): string => os.family === 'rhel' ? '/usr/share/phpMyAdmin' : '/usr/share/phpmyadmin'
const configPathOf = (os: Pick<OsProfile, 'family'>): string => os.family === 'rhel' ? '/etc/phpMyAdmin/config.inc.php' : '/etc/phpmyadmin/conf.d/90-xpanel-signon.php'

/** Undefined without the package or the chosen PHP-FPM binary; a saved file that fails validation keeps the private defaults. */
export async function observePhpMyAdminHost(executor: Pick<AgentExecutor, 'runCommand'>, os: OsProfile, stateRoot: string, server: { hostname: string; panelPort: number } | null): Promise<PhpMyAdminHostObservation | undefined> {
  const root = phpMyAdminRoot(os)
  if (!(await executor.runCommand(['/usr/bin/test', '-f', `${root}/index.php`])).ok) return undefined
  let access: PhpMyAdminAccess
  try { access = parsePhpMyAdminAccess(await readJsonIfExists<unknown>(join(stateRoot, PMA_ACCESS_STATE))) ?? PMA_ACCESS_DEFAULTS } catch { access = PMA_ACCESS_DEFAULTS }
  for (const version of access.phpVersion ? [access.phpVersion] : [...SUPPORTED_PHP_VERSIONS].reverse()) {
    const binary = edge.phpFpmBinary(os, version)
    if ((await executor.runCommand(['/usr/bin/test', '-x', binary])).ok) return { access: { ...access, phpVersion: version }, root, binary, hostname: server?.hostname ?? null, panelPort: server?.panelPort ?? null }
  }
  return undefined
}

export function renderPhpMyAdminNginx(input: PhpMyAdminHostObservation): string {
  const { access, root } = input, listens = [...(access.httpPort ? [`listen ${access.httpPort};`, `listen [::]:${access.httpPort};`] : []), `listen ${access.httpsPort} ssl;`, `listen [::]:${access.httpsPort} ssl;`]
  const lines = ['# Managed by xPanel: phpMyAdmin access', 'server {', ...listens.map(line => '    ' + line), '    server_name _;', `    ssl_certificate ${edge.DEFAULT_TLS.cert};`, `    ssl_certificate_key ${edge.DEFAULT_TLS.key};`, `    root ${root};`, '    index index.php;', '    client_max_body_size 64m;',
    ...(access.publicAccess ? [] : ['    allow 127.0.0.1;', '    allow ::1;', '    deny all;']),
    ...(access.basicAuth ? ['    auth_basic "phpMyAdmin";', `    auth_basic_user_file ${PMA_HTPASSWD};`] : []),
    '    location ~ ^/(?:setup|libraries|templates|sql|vendor|config)(?:/|$) { return 404; }',
    '    location ~ \\.php$ {', '        try_files $uri =404;', '        include fastcgi_params;', '        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;', '        fastcgi_param HTTPS $https if_not_empty;', `        fastcgi_pass unix:${RUN_DIR}/fpm.sock;`, '    }', '}', '']
  return lines.join('\n')
}
export const renderPhpMyAdminFpm = (os: OsProfile): string => ['; Managed by xPanel: phpMyAdmin PHP-FPM', '[global]', `pid = ${RUN_DIR}/fpm.pid`, 'error_log = syslog', 'syslog.ident = xpanel-phpmyadmin', 'daemonize = no', '[phpmyadmin]',
  `user = ${os.paths.apacheUser}`, `group = ${os.paths.apacheUser}`, `listen = ${RUN_DIR}/fpm.sock`, `listen.owner = ${os.paths.nginxUser}`, `listen.group = ${os.paths.nginxUser}`, 'listen.mode = 0600',
  // ondemand: no worker while nobody uses the client, which keeps the 1 GB budget.
  'pm = ondemand', 'pm.max_children = 3', 'pm.process_idle_timeout = 30s', 'pm.max_requests = 200', 'security.limit_extensions = .php', 'php_admin_value[memory_limit] = 128M', 'php_admin_flag[expose_php] = off', ''].join('\n')
export const renderPhpMyAdminUnit = (binary: string): string => ['[Unit]', 'Description=xPanel phpMyAdmin PHP-FPM', 'After=network.target', '', '[Service]', `ExecStart=${binary} --nodaemonize --fpm-config ${FPM_CONF}`, 'ExecReload=/bin/kill -USR2 $MAINPID', 'RuntimeDirectory=xpanel-phpmyadmin', 'RuntimeDirectoryMode=0755', 'Restart=on-failure', '', '[Install]', 'WantedBy=multi-user.target', ''].join('\n')

/** Sign-on is rendered only while a browser can reach the client: with public access off the panel button reports not configured. */
export const phpMyAdminSignonConfig = (os: OsProfile, input: PhpMyAdminHostObservation): DbSignonConfig | null => !input.access.publicAccess || !input.hostname || !input.panelPort ? null : {
  signonUrl: `https://${input.hostname}:${input.access.httpsPort}/xpanel-signon.php`, returnUrl: `https://${input.hostname}:${input.panelPort}/`, ticketDirectory: PMA_TICKET_DIR, ticketGroup: os.paths.apacheUser,
  bridgePath: `${input.root}/xpanel-signon.php`, configPath: configPathOf(os) }
const root = (path: string, content: string, mode = 0o644, group = 'root'): RenderedFile => ({ path, content, mode, owner: 'root', group })

export function compilePhpMyAdminAccess(os: OsProfile, input: PhpMyAdminHostObservation): { files: RenderedFile[]; preActions: HostAction[]; postActions: HostAction[] } {
  const files = [root(`${os.paths.nginxVhostDir}/xpanel-phpmyadmin.conf`, renderPhpMyAdminNginx(input)), root(FPM_CONF, renderPhpMyAdminFpm(os)), root(`${os.paths.systemdDir}/${PMA_UNIT}`, renderPhpMyAdminUnit(input.binary))]
  if (input.access.basicAuth) files.push(root(PMA_HTPASSWD, `${input.access.basicAuth.user}:${input.access.basicAuth.hash}\n`, 0o640, os.paths.nginxUser))
  const signon = phpMyAdminSignonConfig(os, input)
  if (signon) files.push(root(DB_SIGNON_CONFIG_PATH, JSON.stringify({ phpmyadmin: signon }, null, 2) + '\n'), root(signon.bridgePath, renderPhpMyAdminSignonBridge(signon)), root(signon.configPath, renderPhpMyAdminSignonConfig(signon)))
  const preActions: HostAction[] = [{ kind: 'ensure-dir', path: PMA_TICKET_DIR, mode: 0o730, owner: 'root', group: os.paths.apacheUser }]
  const postActions: HostAction[] = [{ kind: 'exec', argv: [input.binary, '--test', '--fpm-config', FPM_CONF] }, { kind: 'systemd-daemon-reload' }, { kind: 'systemd', verb: 'enable', unit: PMA_UNIT }, { kind: 'systemd', verb: 'start', unit: PMA_UNIT }]
  return { files, preActions, postActions }
}
/** The ports the firewall must pass: a closed port could never answer the 403 that public access off promises. */
export const phpMyAdminPorts = (input: PhpMyAdminHostObservation | undefined): number[] => input ? [...(input.access.httpPort ? [input.access.httpPort] : []), input.access.httpsPort] : []
export function phpMyAdminRestartActions(files: readonly RenderedFile[], previous: readonly { path: string; sha256: string }[] | undefined, sha256: (text: string) => string): HostAction[] {
  const known = new Map(previous?.map(entry => [entry.path, entry.sha256]))
  return files.some(file => (file.path === FPM_CONF || file.path.endsWith('/' + PMA_UNIT)) && known.get(file.path) !== sha256(file.content)) ? [{ kind: 'systemd', verb: 'restart', unit: PMA_UNIT }] : []
}

export interface PhpMyAdminAccessRouteDeps { assertRoot(action: string): Promise<{ actor: string }>; run: ((argv: readonly string[]) => Promise<{ ok: boolean }>) | null; os: OsProfile | null }
/** What the page may offer: the package and the PHP versions with an FPM binary. */
export async function handlePhpMyAdminAccessRoute(url: URL, method: string, deps: PhpMyAdminAccessRouteDeps): Promise<Response | null> {
  if (url.pathname !== '/host/databases/phpmyadmin-access') return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'phpMyAdmin access does not accept selectors', { stateChanged: false })
  await deps.assertRoot('host.databases.phpmyadmin-access')
  const present = async (flag: '-f' | '-x', path: string): Promise<boolean> => !!deps.run && (await deps.run(['/usr/bin/test', flag, path]).catch(() => ({ ok: false }))).ok
  const os = deps.os, installed = !!os && await present('-f', `${phpMyAdminRoot(os)}/index.php`), phpVersions: string[] = []
  if (os) for (const version of SUPPORTED_PHP_VERSIONS) if (await present('-x', edge.phpFpmBinary(os, version))) phpVersions.push(version)
  return new Response(JSON.stringify({ installed, phpVersions, allowedPorts: os?.family === 'rhel' ? PMA_EL_PORTS : null }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
