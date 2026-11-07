// Web Disk (lighttpd mod_webdav) and calendars and contacts (Radicale) of one account, behind the nginx edge on
// cPanel's TLS ports. Every process runs as the account and nginx reaches it only through a root-owned socket of
// its group. Choice and measurements: docs/decisions/2026-11-07-dav-servers.md.
import { createHash } from 'node:crypto'
import type { Account, Certificate, Domain, HostAction, OsProfile, RenderedFile } from '@xpanel/core'
import { certPaths, DEFAULT_TLS } from '../edge/paths.ts'
import { certCovers } from '../edge/sites.ts'
import { assertFtpDir } from '../services/ftp.ts'
import { context, header, isolation, NO_TCP_LISTEN, quoteExecArg, RUNTIME_BINARIES, RUNTIME_CONFIG_ROOT, runtimeConfigDir, SOCKET_PROXYD_BINARY, unitFile, type UnitOptions } from './units.ts'
import { assertUsername, invalid } from './validate.ts'

export const WEBDISK_PORT = 2078
export const CALDAV_PORT = 2080
export const LIGHTTPD_BINARY = '/usr/sbin/lighttpd'
/** Root-owned front sockets nginx connects to; no account can create or replace an entry here. */
export const WEBDISK_SOCKET_DIR = '/run/xpanel-webdisk'
export const WEBDISK_BACKEND_DIR = '/run/xpanel-webdiskd'
export const CALDAV_SOCKET_DIR = '/run/xpanel-caldav'
/** Loads Radicale on its systemd socket; world-readable so every account's unit can run it. */
export const DAV_LAUNCHER_PATH = `${RUNTIME_CONFIG_ROOT}/dav-radicale.py`
/** Radicale's store inside the home, as cPanel keeps its calendars: it counts toward the account's quota. */
export const CALDAV_STORE = '.caldav'
/** The account login's principal; a mailbox's is its service user id, so a recreated address starts empty. */
export const CALDAV_MAIN_PRINCIPAL = 'main'
export const CALDAV_PRINCIPAL_RE = /^(?:main|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
/** xMail's read of one principal's store, served from the files without loading Radicale. */
export const CALDAV_STORE_PATH = '/.xpanel/store'
/** The principals a collection is shared with, a comma list on the collection; see CALDAV_STORE_PATH. */
export const CALDAV_GRANTEES_PROP = '{urn:xpanel:dav}grantees'
/** The idle time after which a calendar process exits; systemd starts it again on the next request. */
export const CALDAV_IDLE_SECONDS = 60
export const DAV_AUTH_LOCATION = '/.xpanel-dav-auth'
/** The management ingress credential the panel API requires (scripts/management-tls.mjs PATHS.include). */
export const DAV_INGRESS_INCLUDE = '/etc/nginx/xpanel-management/ingress-secret.conf'
export const DAV_AUTHORIZE_URL = 'http://127.0.0.1:12083/api/dav/authorize'
export const DAV_ACCESS_LOG = '/var/log/nginx/xpanel-dav.access.log'

type AccountRef = Pick<Account, 'username' | 'uid' | 'gid' | 'home'>

/** One Web Disk login: the account itself ('main') or a User Manager user with Web Disk, by its id. */
export interface WebDiskLogin {
  subject: 'main' | string
  /** relative to the home; '' is the home itself */
  dir: string
  readOnly: boolean
}

const SUBJECT_RE = /^(?:main|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
export const WEBDISK_INSTANCE_RE = /^[0-9a-f]{12}$/

/** An FTP-style relative directory without blanks: systemd's BindPaths= separates paths at whitespace. */
export const assertWebDiskDir = (dir: unknown): string => {
  const d = assertFtpDir(dir)
  return /\s/.test(d) ? invalid('Web Disk directory may not contain blanks', { dir: d }) : d
}

/**
 * The instance of a login names its units and socket. It changes with the directory and the access right, so a
 * changed login gets new units and the generation diff stops the old ones, open sessions included.
 */
export const webDiskInstance = (login: WebDiskLogin): string => {
  if (typeof login.subject !== 'string' || !SUBJECT_RE.test(login.subject)) return invalid('Web Disk login must be main or a service user id', { subject: login.subject })
  if (typeof login.readOnly !== 'boolean') return invalid('Web Disk readOnly must be a boolean')
  return createHash('sha256').update(`${login.subject}\0${assertWebDiskDir(login.dir)}\0${login.readOnly ? 'ro' : 'rw'}`).digest('hex').slice(0, 12)
}

export interface WebDiskPaths {
  frontSocketUnit: string
  proxyService: string
  backendSocketUnit: string
  service: string
  frontSocket: string
  backendSocket: string
  /** relative to /run, as RuntimeDirectory= wants it: lock and property database of the session */
  runtimeDirectory: string
  config: string
}

export const webDiskPaths = (username: string, instance: string): WebDiskPaths => {
  const user = assertUsername(username)
  if (!WEBDISK_INSTANCE_RE.test(instance)) return invalid('Web Disk instance must be 12 hex digits', { instance })
  const name = `${user}-${instance}`
  return {
    frontSocketUnit: `xpanel-webdisk-${name}.socket`,
    proxyService: `xpanel-webdisk-${name}.service`,
    backendSocketUnit: `xpanel-webdiskd-${name}.socket`,
    service: `xpanel-webdiskd-${name}.service`,
    frontSocket: `${WEBDISK_SOCKET_DIR}/${name}.sock`,
    backendSocket: `${WEBDISK_BACKEND_DIR}/${name}/dav.sock`,
    runtimeDirectory: `xpanel-webdisk-state/${name}`,
    config: `${runtimeConfigDir(user)}/webdisk-${instance}.conf`,
  }
}

export interface DavUnitOptions extends UnitOptions {
  /** group of the nginx workers that may connect to the front socket; os.paths.nginxUser when omitted */
  nginxGroup?: string
}

const nginxGroupOf = (os: OsProfile, opts: DavUnitOptions): string => {
  const group = opts.nginxGroup ?? os.paths.nginxUser
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(group) ? group : invalid('nginx group must be a system group name', { group })
}

const frontSocket = (path: string, what: string, listen: string, group: string, service: string): RenderedFile => unitFile(path, [
  header(what),
  '[Unit]',
  `Description=xPanel ${what}`,
  '',
  '[Socket]',
  `ListenStream=${listen}`,
  'SocketUser=root',
  `SocketGroup=${group}`,
  'SocketMode=0660',
  'DirectoryMode=0755',
  `Service=${service}`,
  '',
  '[Install]',
  'WantedBy=sockets.target',
])

export interface RenderedWebDisk {
  instance: string
  paths: WebDiskPaths
  files: RenderedFile[]
  /** units the reconciler enables and starts; the rest start on demand */
  sockets: string[]
  units: string[]
}

/**
 * Four units per login. nginx connects to the root-owned front socket; its systemd-socket-proxyd runs as the
 * account and exits after 10 idle minutes, and lighttpd behind the account-only backend socket stops with it
 * (StopWhenUnneeded). lighttpd's mount namespace holds only the login's directory, read-only for a read-only login.
 */
export const renderWebDiskUnits = (account: AccountRef, login: WebDiskLogin, os: OsProfile, opts: DavUnitOptions = {}): RenderedWebDisk => {
  const ctx = context(account, os, opts)
  const instance = webDiskInstance(login)
  const p = webDiskPaths(ctx.username, instance)
  const dir = assertWebDiskDir(login.dir)
  const root = dir ? `${ctx.home}/${dir}` : ctx.home
  const state = `/run/${p.runtimeDirectory}`
  const what = `Web Disk ${login.subject === 'main' ? 'main account' : 'user'} ${instance} for ${ctx.username}`
  const config: RenderedFile = {
    path: p.config,
    content: [
      header(what),
      'server.modules = ("mod_webdav")',
      'server.systemd-socket-activation = "enable"',
      `server.document-root = "${root}"`,
      // PUT bodies stream into the destination; the upload directory only takes small spills
      `server.upload-dirs = ("${state}")`,
      'server.max-connections = 32',
      'webdav.activate = "enable"',
      `webdav.sqlite-db-name = "${state}/webdav.sqlite"`,
      ...(login.readOnly ? ['webdav.is-readonly = "enable"'] : []),
      '',
    ].join('\n'),
    mode: 0o600,
    owner: 'root',
    group: 'root',
  }
  const service = unitFile(`${ctx.systemdDir}/${p.service}`, [
    header(what),
    '[Unit]',
    `Description=xPanel ${what}`,
    'StopWhenUnneeded=yes',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${LIGHTTPD_BINARY} -D -f %d/webdisk.conf`,
    `LoadCredential=webdisk.conf:${p.config}`,
    `RuntimeDirectory=${p.runtimeDirectory}`,
    'RuntimeDirectoryMode=0700',
    ...NO_TCP_LISTEN,
    ...isolation({ ...ctx, home: root }, { writable: [state], readOnlyHome: login.readOnly }),
  ])
  const backendSocket = unitFile(`${ctx.systemdDir}/${p.backendSocketUnit}`, [
    header(`backend socket of ${what}`),
    '[Unit]',
    `Description=xPanel backend socket of ${what}`,
    '',
    '[Socket]',
    `ListenStream=${p.backendSocket}`,
    `SocketUser=${ctx.username}`,
    `SocketGroup=${ctx.username}`,
    'SocketMode=0600',
    'DirectoryMode=0755',
    `Service=${p.service}`,
    '',
    '[Install]',
    'WantedBy=sockets.target',
  ])
  const proxyService = unitFile(`${ctx.systemdDir}/${p.proxyService}`, [
    header(`front proxy of ${what}`),
    '[Unit]',
    `Description=xPanel front proxy of ${what}`,
    `Requires=${p.frontSocketUnit} ${p.service}`,
    `After=${p.frontSocketUnit} ${p.backendSocketUnit} ${p.service}`,
    '',
    '[Service]',
    `ExecStart=${SOCKET_PROXYD_BINARY} --exit-idle-time=10min ${p.backendSocket}`,
    ...NO_TCP_LISTEN,
    ...isolation(ctx),
  ])
  const front = frontSocket(`${ctx.systemdDir}/${p.frontSocketUnit}`, `front socket of ${what}`, p.frontSocket, nginxGroupOf(os, opts), p.proxyService)
  return {
    instance,
    paths: p,
    files: [config, service, backendSocket, proxyService, front],
    sockets: [p.backendSocketUnit, p.frontSocketUnit],
    units: [p.frontSocketUnit, p.proxyService, p.backendSocketUnit, p.service],
  }
}

export interface CalDavPaths {
  socketUnit: string
  service: string
  socket: string
  config: string
  store: string
}

export const calDavPaths = (account: Pick<Account, 'username' | 'home'>): CalDavPaths => {
  const user = assertUsername(account.username)
  return {
    socketUnit: `xpanel-caldav-${user}.socket`,
    service: `xpanel-caldav-${user}.service`,
    socket: `${CALDAV_SOCKET_DIR}/${user}.sock`,
    config: `${runtimeConfigDir(user)}/caldav.conf`,
    store: `${account.home}/${CALDAV_STORE}`,
  }
}

export interface RenderedCalDav {
  paths: CalDavPaths
  files: RenderedFile[]
  sockets: string[]
  units: string[]
}

/** One Radicale per account for the account login and all its mailboxes; owner_only keeps each principal to itself. */
export const renderCalDavUnits = (account: AccountRef, os: OsProfile, opts: DavUnitOptions = {}): RenderedCalDav => {
  const ctx = context(account, os, opts)
  const p = calDavPaths({ username: ctx.username, home: ctx.home })
  const what = `calendars and contacts for ${ctx.username}`
  const config: RenderedFile = {
    path: p.config,
    content: [
      header(what),
      '[auth]',
      // nginx sets the header from the panel's verification and replaces any client value
      'type = http_x_remote_user',
      '[rights]',
      'type = owner_only',
      '[storage]',
      `filesystem_folder = ${p.store}`,
      '[web]',
      'type = none',
      '[logging]',
      'level = warning',
      '',
    ].join('\n'),
    mode: 0o600,
    owner: 'root',
    group: 'root',
  }
  const service = unitFile(`${ctx.systemdDir}/${p.service}`, [
    header(what),
    '[Unit]',
    `Description=xPanel ${what}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${RUNTIME_BINARIES.python} ${DAV_LAUNCHER_PATH} %d/caldav.conf ${quoteExecArg(p.store)} ${CALDAV_IDLE_SECONDS}`,
    `LoadCredential=caldav.conf:${p.config}`,
    'Environment=PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1',
    ...NO_TCP_LISTEN,
    ...isolation(ctx),
  ])
  const socket = frontSocket(`${ctx.systemdDir}/${p.socketUnit}`, `socket of ${what}`, p.socket, nginxGroupOf(os, opts), p.service)
  return { paths: p, files: [config, service, socket], sockets: [p.socketUnit], units: [p.socketUnit, p.service] }
}

/** Radicale on the socket systemd passes, with default collections, protected defaults and an idle exit. */
export const DAV_LAUNCHER = [
  '# Generated by xPanel. Manual edits are overwritten.',
  '# Radicale on its systemd socket: one process per account that exits when idle; systemd starts it again on demand.',
  'import os, sys',
  '',
  '',
  'def prune(folder, keep):',
  '    # Runs as the account, so a planted link reaches nothing the account could not delete itself.',
  '    import shutil',
  "    root = os.path.join(folder, 'collection-root')",
  '    try:',
  '        names = os.listdir(root)',
  '    except (FileNotFoundError, NotADirectoryError):',
  '        return',
  '    for name in names:',
  '        path = os.path.join(root, name)',
  "        if name in keep or name.startswith('.'):",
  '            continue',
  '        if os.path.isdir(path) and not os.path.islink(path):',
  '            shutil.rmtree(path)',
  '        else:',
  '            os.unlink(path)',
  '',
  '',
  "if sys.argv[1] == '--prune':",
  '    prune(sys.argv[2], set(sys.argv[3:]))',
  '    sys.exit(0)',
  "if sys.argv[1] == '--webdisk-dirs':",
  '    # A path that cannot be made (a file there, a full quota) leaves that one login unavailable, not the reconcile.',
  '    for path in sys.argv[3:]:',
  '        try:',
  '            os.makedirs(os.path.join(sys.argv[2], path), exist_ok=True)',
  '        except OSError as error:',
  "            print('web disk directory not created:', path, error, file=sys.stderr)",
  '    sys.exit(0)',
  '',
  'import json, re, socket, socketserver, threading, time',
  'from wsgiref.simple_server import WSGIRequestHandler, WSGIServer',
  '',
  'config, folder, idle = sys.argv[1], sys.argv[2], int(sys.argv[3])',
  "os.environ['RADICALE_CONFIG'] = config",
  '',
  "PRINCIPAL = re.compile(r'^(?:main|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')",
  "DEFAULTS = (('calendar', {'tag': 'VCALENDAR', 'D:displayname': 'Calendar', 'C:supported-calendar-component-set': 'VEVENT,VTODO,VJOURNAL'}),",
  "            ('addressbook', {'tag': 'VADDRESSBOOK', 'D:displayname': 'Contacts'}))",
  "GRANTEES = '{urn:xpanel:dav}grantees'",
  'MAX_ITEM = 16 * 1024 * 1024',
  // the agent carries one reply at a time, so a store is read page by page
  'MAX_PAGE = 6 * 1024 * 1024',
  "AFTER = re.compile(r'^after=([0-9a-f]+)$')",
  // a card's photo stays on disk: xMail shows none, and a write starts from the item itself
  "PHOTO = re.compile(r'^(?:[^:\\r\\n]*\\.)?PHOTO[;:].*(?:\\r?\\n[ \\t].*)*\\r?\\n?', re.I | re.M)",
  'radicale_application = None',
  'loading = threading.Lock()',
  '',
  '',
  'def ensure_defaults(principal):',
  '    # The default calendar and address book exist from the first sign-in, as on cPanel.',
  '    for name, props in DEFAULTS:',
  "        path = os.path.join(folder, 'collection-root', principal, name)",
  "        target = os.path.join(path, '.Radicale.props')",
  '        if os.path.exists(target):',
  '            continue',
  '        os.makedirs(path, mode=0o700, exist_ok=True)',
  "        temporary = '%s.%d.tmp' % (target, threading.get_ident())",
  "        with open(temporary, 'w') as handle:",
  '            json.dump(props, handle)',
  '        os.replace(temporary, target)',
  '',
  '',
  'def forward(environ, start_response):',
  '    # Loaded on the first device or write request: opening xMail reads files and stays small.',
  '    global radicale_application',
  '    with loading:',
  '        if radicale_application is None:',
  '            import radicale',
  '            radicale_application = radicale.application',
  '    return radicale_application(environ, start_response)',
  '',
  '',
  'def read_item(entry):',
  '    if entry.stat().st_size > MAX_ITEM:',
  '        return None, 0',
  "    with open(entry.path, encoding='utf-8', errors='replace', newline='') as handle:",
  '        text = handle.read()',
  "    if entry.name.endswith('.vcf'):",
  "        text = PHOTO.sub('', text)",
  // measured as sent, so non-ASCII text and escapes cannot pass the agent's transport bound
  "    size = len(json.dumps(text, ensure_ascii=False).encode('utf-8', 'replace'))",
  '    return (text, size) if size <= MAX_PAGE else (None, 0)',
  '',
  '',
  'def cursor(*parts):',
  "    return '/'.join(parts).encode('utf-8', 'surrogateescape').hex()",
  '',
  '',
  'def store_page(principal, after):',
  '    # A page ends before the item that does not fit. An item no page can hold is counted, never dropped silently.',
  "    root = os.path.join(folder, 'collection-root')",
  '    collections, omitted, room = [], 0, MAX_PAGE',
  "    page = lambda following: {'collections': collections, 'omitted': omitted, 'next': following}",
  '    for owner in sorted(os.listdir(root)):',
  '        if not PRINCIPAL.match(owner) or owner < after[0]:',
  '            continue',
  '        try:',
  '            names = sorted(os.listdir(os.path.join(root, owner)))',
  '        except OSError:',
  '            continue',
  '        for name in names:',
  '            path = os.path.join(root, owner, name)',
  "            if name.startswith('.') or not os.path.isdir(path) or os.path.islink(path) or (owner, name) < (after[0], after[1]):",
  '                continue',
  '            try:',
  "                with open(os.path.join(path, '.Radicale.props'), encoding='utf-8') as handle:",
  '                    props = json.load(handle)',
  '            except (OSError, ValueError):',
  '                continue',
  "            if not isinstance(props, dict) or owner != principal and principal not in str(props.get(GRANTEES, '')).split(','):",
  '                continue',
  '            if room <= 0:',
  "                return page(cursor(owner, name, ''))",
  '            room -= len(json.dumps(props, ensure_ascii=False).encode(\'utf-8\', \'replace\'))',
  '            done, items = after[2] if (owner, name) == (after[0], after[1]) else \'\', []',
  "            collections.append({'owner': owner, 'name': name, 'props': props, 'items': items})",
  '            with os.scandir(path) as entries:',
  '                for entry in sorted(entries, key=lambda item: item.name):',
  "                    if entry.name.startswith('.') or not entry.is_file(follow_symlinks=False) or entry.name <= done:",
  '                        continue',
  '                    text, size = read_item(entry)',
  '                    if text is None:',
  '                        omitted += 1',
  '                    elif size > room:',
  '                        return page(cursor(owner, name, done))',
  '                    else:',
  '                        room -= size',
  '                        done = entry.name',
  "                        items.append({'href': entry.name, 'text': text})",
  '    return page(None)',
  '',
  '',
  'def refuse(start_response, status, text):',
  "    start_response(status, [('Content-Type', 'text/plain; charset=utf-8')])",
  '    return [text.encode()]',
  '',
  '',
  'def application(environ, start_response):',
  "    principal = environ.get('HTTP_X_REMOTE_USER', '')",
  '    if not PRINCIPAL.match(principal):',
  "        return refuse(start_response, '403 Forbidden', 'Forbidden\\n')",
  "    path = environ.get('PATH_INFO', '/').rstrip('/')",
  "    if environ.get('REQUEST_METHOD') in ('DELETE', 'MOVE') and path in ('/%s/calendar' % principal, '/%s/addressbook' % principal):",
  "        return refuse(start_response, '403 Forbidden', 'The default calendar and address book cannot be deleted.\\n')",
  '    ensure_defaults(principal)',
  "    if environ.get('REQUEST_METHOD') == 'GET' and environ.get('PATH_INFO') == '/.xpanel/store':",
  "        query = environ.get('QUERY_STRING', '')",
  '        match = AFTER.match(query)',
  "        after = bytes.fromhex(match.group(1)).decode('utf-8', 'surrogateescape').split('/', 2) if match else ['', '', '']",
  '        if query and not match or len(after) != 3:',
  "            return refuse(start_response, '400 Bad Request', 'Bad page\\n')",
  "        body = json.dumps(store_page(principal, after), ensure_ascii=False).encode('utf-8', 'replace')",
  "        start_response('200 OK', [('Content-Type', 'application/json'), ('Content-Length', str(len(body)))])",
  '        return [body]',
  '    return forward(environ, start_response)',
  '',
  '',
  'class Handler(WSGIRequestHandler):',
  '    # A unix-socket peer has no address; nginx passes the client in X-Real-IP.',
  '    def setup(self):',
  "        self.client_address = ('127.0.0.1', 0)",
  '        super().setup()',
  '',
  '    def log_message(self, *args):',
  '        pass',
  '',
  '',
  'class Server(socketserver.ThreadingMixIn, WSGIServer):',
  '    daemon_threads = True',
  '',
  '    def __init__(self, sock):',
  '        socketserver.BaseServer.__init__(self, None, Handler)',
  '        self.socket = sock',
  "        self.server_name, self.server_port = 'localhost', 80",
  '        self.setup_environ()',
  '        self.last = time.monotonic()',
  '',
  '    def process_request(self, request, client_address):',
  '        self.last = time.monotonic()',
  '        super().process_request(request, client_address)',
  '',
  '',
  "if os.environ.get('LISTEN_PID') != str(os.getpid()) or os.environ.get('LISTEN_FDS') != '1':",
  "    sys.exit('expected exactly one socket from systemd')",
  'server = Server(socket.socket(fileno=3))',
  'server.set_app(application)',
  'server.timeout = min(30, idle)',
  'while time.monotonic() - server.last < idle or threading.active_count() > 1:',
  '    server.handle_request()',
  '',
].join('\n')

/** Deletes the collections of every principal that is gone, whichever route removed its mailbox. */
export const calDavPruneAction = (account: Pick<Account, 'username' | 'home'>, keep: readonly string[]): HostAction => {
  const unknown = keep.find(principal => !CALDAV_PRINCIPAL_RE.test(principal))
  if (unknown !== undefined) return invalid('a calendar principal must be main or a service user id', { principal: unknown })
  return { kind: 'exec', runAsUser: assertUsername(account.username), argv: [RUNTIME_BINARIES.python, '-I', '-S', DAV_LAUNCHER_PATH, '--prune', calDavPaths(account).store, ...keep] }
}

/** Web Disk directories a login names, made as the account as cPanel does, so a planted link reaches nothing the account could not write. */
export const webDiskDirsAction = (account: Pick<Account, 'username' | 'home'>, dirs: readonly string[]): HostAction =>
  ({ kind: 'exec', runAsUser: assertUsername(account.username), argv: [RUNTIME_BINARIES.python, '-I', '-S', DAV_LAUNCHER_PATH, '--webdisk-dirs', account.home, ...dirs.map(assertWebDiskDir)] })

export const renderDavLauncher = (): RenderedFile => ({ path: DAV_LAUNCHER_PATH, content: DAV_LAUNCHER, mode: 0o644, owner: 'root', group: 'root' })

// ---------------------------------------------------------------- nginx edge

/** nginx takes the protocol list of a listener from its default server, so both renders carry the same values. */
export interface DavTlsSettings { protocols: readonly string[]; ciphers: string }
export const DAV_TLS_DEFAULT: DavTlsSettings = { protocols: ['TLSv1.2', 'TLSv1.3'], ciphers: 'ECDHE+AESGCM:ECDHE+CHACHA20' }
const davTlsLines = (tls: DavTlsSettings = DAV_TLS_DEFAULT): string[] => [`    ssl_protocols ${tls.protocols.join(' ')};`, `    ssl_ciphers ${tls.ciphers};`]

export interface DavEdgeOptions {
  /** `host:port` of XPANEL_PANEL_PUBLIC_ORIGIN; the API refuses another Host */
  panelHost: string
  webDisk: boolean
  calDav: boolean
  ipv6?: boolean
  tls?: DavTlsSettings
}

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::[0-9]{1,5})?$/
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

const listenLines = (port: number, ipv6: boolean, extra = ''): string[] =>
  [`    listen ${port} ssl${extra};`, ...(ipv6 ? [`    listen [::]:${port} ssl${extra};`] : [])]

/** Names of the account's served domains, grouped by the certificate that covers each; names without one are not served. */
export const davNamesByCertificate = (account: Pick<Account, 'id'>, domains: readonly Domain[], certs: readonly Certificate[]): { cert: Certificate; names: string[] }[] => {
  const own = certs.filter(c => c.accountId === null || c.accountId === account.id)
  const groups: { cert: Certificate; names: string[] }[] = []
  for (const d of domains) {
    if (d.accountId !== account.id || d.suspended || !NAME_RE.test(d.name)) continue
    const assigned = d.certificateId ? own.find(c => c.id === d.certificateId) : undefined
    const cert = assigned && certCovers(assigned, d.name) ? assigned : own.find(c => certCovers(c, d.name))
    if (!cert) continue
    const group = groups.find(g => g.cert.id === cert.id)
    if (group) group.names.push(d.name)
    else groups.push({ cert, names: [d.name] })
  }
  return groups
}

const authLocation = (service: 'webdisk' | 'caldav', username: string, panelHost: string): string[] => [
  `    location = ${DAV_AUTH_LOCATION} {`,
  '        internal;',
  `        proxy_pass ${DAV_AUTHORIZE_URL};`,
  `        include ${DAV_INGRESS_INCLUDE};`,
  '        proxy_pass_request_body off;',
  '        proxy_set_header Content-Length "";',
  '        proxy_set_header Content-Type "";',
  `        proxy_set_header Host ${panelHost};`,
  '        proxy_set_header X-Forwarded-Proto https;',
  '        proxy_set_header X-Real-IP $remote_addr;',
  '        proxy_set_header X-Forwarded-For "";',
  '        proxy_set_header Forwarded "";',
  '        proxy_set_header Cookie "";',
  '        proxy_set_header Authorization $http_authorization;',
  `        proxy_set_header X-Xpanel-Dav-Service ${service};`,
  `        proxy_set_header X-Xpanel-Dav-Account ${username};`,
  '    }',
]

const backendLines = (): string[] => [
  '        proxy_http_version 1.1;',
  '        proxy_set_header Connection "";',
  // MOVE and COPY carry an absolute Destination that the server compares with Host
  '        proxy_set_header Host $http_host;',
  '        proxy_set_header X-Real-IP $remote_addr;',
  '        proxy_set_header X-Forwarded-For "";',
  '        proxy_set_header Authorization "";',
  '        proxy_set_header Proxy "";',
  '        proxy_read_timeout 300s;',
  '        proxy_send_timeout 300s;',
]

/**
 * Server blocks of one account on 2078 (Web Disk) and 2080 (calendars and contacts), one per certificate. Every
 * request is verified by the panel API first; nginx forwards only the identity it returns.
 */
export const renderDavNginx = (account: Pick<Account, 'id' | 'username'>, groups: readonly { cert: Certificate; names: readonly string[] }[], os: Pick<OsProfile, 'paths'>, opts: DavEdgeOptions): RenderedFile => {
  const user = assertUsername(account.username)
  if (!HOST_RE.test(opts.panelHost)) return invalid('panel host must be a host name with an optional port', { panelHost: opts.panelHost })
  const ipv6 = opts.ipv6 !== false
  const blocks: string[] = []
  for (const g of groups) {
    if (!g.names.length || g.names.some(n => !NAME_RE.test(n))) return invalid('DAV server names must be domain names', { names: g.names })
    const files = certPaths(g.cert.id)
    const head = (port: number): string[] => [
      ...listenLines(port, ipv6),
      `    server_name ${g.names.join(' ')};`,
      `    ssl_certificate ${files.cert};`,
      `    ssl_certificate_key ${files.key};`,
      ...davTlsLines(opts.tls),
      `    access_log ${DAV_ACCESS_LOG};`,
    ]
    if (opts.webDisk) {
      blocks.push(['server {', ...head(WEBDISK_PORT),
        // the account's disk quota bounds the stored size
        '    client_max_body_size 0;',
        ...authLocation('webdisk', user, opts.panelHost),
        '    location / {',
        `        auth_request ${DAV_AUTH_LOCATION};`,
        '        auth_request_set $xpanel_webdisk_instance $upstream_http_x_xpanel_dav_instance;',
        `        proxy_pass http://unix:${WEBDISK_SOCKET_DIR}/${user}-$xpanel_webdisk_target.sock:;`,
        '        proxy_request_buffering off;',
        '        proxy_buffering off;',
        '        proxy_set_header X-Remote-User "";',
        ...backendLines(),
        '    }',
        '}'].join('\n'))
    }
    if (opts.calDav) {
      blocks.push(['server {', ...head(CALDAV_PORT),
        '    client_max_body_size 64m;',
        ...authLocation('caldav', user, opts.panelHost),
        // RFC 6764 discovery; the root answers with the signed-in principal
        '    location = /.well-known/caldav { return 301 /; }',
        '    location = /.well-known/carddav { return 301 /; }',
        // xMail's store read holds whole shared collections and is the agent's alone
        '    location ^~ /.xpanel/ { return 404; }',
        '    location / {',
        `        auth_request ${DAV_AUTH_LOCATION};`,
        '        auth_request_set $xpanel_dav_user $upstream_http_x_xpanel_dav_user;',
        `        proxy_pass http://unix:${CALDAV_SOCKET_DIR}/${user}.sock:;`,
        '        proxy_set_header X-Remote-User $xpanel_dav_user;',
        ...backendLines(),
        '    }',
        '}'].join('\n'))
    }
  }
  return {
    path: `${os.paths.nginxVhostDir}/xpanel-dav-${user}.conf`,
    content: `# Managed by xPanel: Web Disk and calendars and contacts of account ${user}\n\n${blocks.join('\n\n')}\n`,
    mode: 0o644,
    owner: 'root',
    group: 'root',
  }
}

/** RFC 6764 on the website: a device that asks the site itself goes to the group's first name served on the calendar port. */
export const davWellKnownLocations = (served: readonly string[] | undefined, names: readonly string[]): string[] => {
  const name = names.find(item => served?.includes(item))
  return name ? ['caldav', 'carddav'].map(kind => `location = /.well-known/${kind} { return 301 https://${name}:${CALDAV_PORT}/; }`) : []
}

/** The default servers of 2078 and 2080 refuse unknown names, and the instance map admits only a 12-hex instance. */
export const renderDavNginxDefault = (os: Pick<OsProfile, 'paths'>, ipv6 = true, tls?: DavTlsSettings): RenderedFile => ({
  path: `${os.paths.nginxVhostDir}/xpanel-dav.conf`,
  content: [
    '# Managed by xPanel: default servers of Web Disk and calendars and contacts',
    'map $xpanel_webdisk_instance $xpanel_webdisk_target {',
    '    "~^[0-9a-f]{12}$" $xpanel_webdisk_instance;',
    '    default unavailable;',
    '}',
    '',
    'server {',
    ...listenLines(WEBDISK_PORT, ipv6, ' default_server'),
    ...listenLines(CALDAV_PORT, ipv6, ' default_server'),
    '    server_name _;',
    `    ssl_certificate ${DEFAULT_TLS.cert};`,
    `    ssl_certificate_key ${DEFAULT_TLS.key};`,
    ...davTlsLines(tls),
    '    access_log off;',
    '    set $xpanel_webdisk_instance "";',
    '    set $xpanel_dav_user "";',
    '    return 421;',
    '}',
    '',
  ].join('\n'),
  mode: 0o644,
  owner: 'root',
  group: 'root',
})
