import { join, posix } from 'node:path'
import { effectiveServerFtpSettings, fail } from '@xpanel/core'
import type { HostAction, OsProfile, RenderedFile, ServerFtpSettings } from '@xpanel/core'
import { services } from '@xpanel/render'
import { readJsonIfExists } from '@xpanel/state'
import type { StateSnapshot } from '@xpanel/state'
import type { AgentExecutor } from './executor.ts'
import { pureFtpdDirectives, renderPureFtpdDaemonConfigs } from './services/ftp.ts'

/** FTP Server Configuration and Anonymous FTP host effects, compiled into every generation of a host with pure-ftpd. */
export const FTP_CONF_FILE = '/etc/pure-ftpd/pure-ftpd.conf'
export const FTP_ANONYMOUS_STATE = 'extended/panel/ftp-anonymous.json'
export const FTP_ANONYMOUS_UNIT = 'xpanel-ftp-anonymous-auth.service'
export const FTP_ANONYMOUS_MAP = '/etc/pure-ftpd/xpanel-anonymous.map'
const AUTH_SCRIPT = '/etc/pure-ftpd/xpanel-anonymous-auth'
const AUTH_SOCKET = '/run/xpanel-ftp-auth/auth.sock'
const AUTH_LINKS = { pure: '/etc/pure-ftpd/auth/50pure', ext: '/etc/pure-ftpd/auth/60extauth' }
const ANONYMOUS_VIEW = '/run/xpanelftp'
/** The overflow uid: anonymous sessions never run as the account, so its own file modes bound them. */
const ANONYMOUS_ID = 65534
export const ftpCertFile = (os: Pick<OsProfile, 'family'>): string => os.family === 'rhel' ? '/etc/pki/pure-ftpd/pure-ftpd.pem' : '/etc/ssl/private/pure-ftpd.pem'

export interface AnonymousFtpAccount { enabled: boolean; uploads: boolean }
export type AnonymousFtpState = Readonly<Record<string, AnonymousFtpAccount>>
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** A missing file means no account has anonymous access; a malformed one is refused, so the caller keeps access closed. */
export function parseAnonymousFtpState(raw: unknown): AnonymousFtpState {
  if (raw === null) return {}
  if (!object(raw) || Object.keys(raw).length > 100000) return fail('VALIDATION', 'anonymous FTP state must map account ids to settings')
  for (const [id, row] of Object.entries(raw)) {
    if (!/^[0-9a-f-]{36}$/.test(id) || !object(row) || Object.keys(row).sort().join() !== 'enabled,uploads' || typeof row.enabled !== 'boolean' || typeof row.uploads !== 'boolean' || row.uploads && !row.enabled) return fail('VALIDATION', 'invalid anonymous FTP account settings')
  }
  return raw as AnonymousFtpState
}

type AnonymousSnapshot = Pick<StateSnapshot, 'accounts' | 'domains'>
interface AnonymousView { unit: string; where: string; what: string; dir: string; writable: boolean }
const viewOf = (home: string, writable: boolean): AnonymousView | null => {
  const what = posix.dirname(home), base = posix.basename(what)
  // shortcut: one view per /homeN base; a home elsewhere stays out of the map until another layout exists.
  if (!/^\/home[0-9]{0,3}$/.test(what)) return null
  const mode = writable ? 'rw' : 'ro', where = `${ANONYMOUS_VIEW}/${mode}/${base}`
  return { what, where, writable, unit: `run-xpanelftp-${mode}-${base}.mount`, dir: `${where}/${posix.basename(home)}/public_ftp/./` }
}

/** Active accounts with saved anonymous access, one login per domain, through the view that matches the upload setting. */
export function anonymousFtpLogins(snapshot: AnonymousSnapshot, settings: ServerFtpSettings, state: AnonymousFtpState): { login: string; view: AnonymousView; account: AnonymousSnapshot['accounts'][number] }[] {
  if (!settings.enabled || !settings.anonymous) return []
  return snapshot.accounts.flatMap(account => {
    const saved = state[account.id], view = saved?.enabled && account.status === 'active' ? viewOf(account.home, saved.uploads && settings.anonymousUploads) : null
    return view ? snapshot.domains.filter(domain => domain.accountId === account.id).map(domain => ({ login: 'anonymous@' + domain.name.toLowerCase(), view, account })) : []
  }).sort((left, right) => left.login.localeCompare(right.login))
}

const root = (path: string, content: string, mode = 0o644): RenderedFile => ({ path, content, mode, owner: 'root', group: 'root' })
const renderAuthScript = (): string => [
  '#!/bin/sh',
  '# Managed by xPanel. pure-authd calls this after PureDB refused a login; the map holds only anonymous@domain lines.',
  `dir=$(LC_ALL=C /usr/bin/awk -F '\\t' 'ENVIRON["AUTHD_ACCOUNT"] == $1 { print $2; exit }' ${FTP_ANONYMOUS_MAP})`,
  `if [ -n "$dir" ]; then printf 'auth_ok:1\\nuid:${ANONYMOUS_ID}\\ngid:${ANONYMOUS_ID}\\ndir:%s\\nend\\n' "$dir"; else printf 'auth_ok:0\\nend\\n'; fi`,
  '',
].join('\n')
const renderAuthUnit = (): string => [
  '[Unit]', 'Description=xPanel anonymous FTP sign-in', 'Before=pure-ftpd.service', '',
  '[Service]', 'RuntimeDirectory=xpanel-ftp-auth', 'RuntimeDirectoryMode=0755',
  `ExecStart=/usr/sbin/pure-authd -s ${AUTH_SOCKET} -r ${AUTH_SCRIPT} -u ${ANONYMOUS_ID} -g ${ANONYMOUS_ID}`,
  // The Debian wrapper refuses an ExtAuth socket that does not exist yet, at the generation check and at boot.
  `ExecStartPost=/usr/bin/timeout 5 /bin/sh -c 'until [ -S ${AUTH_SOCKET} ]; do sleep 0.1; done'`, 'Restart=on-failure', '',
  '[Install]', 'WantedBy=multi-user.target', '',
].join('\n')
/** nosymfollow is the account boundary: a public_ftp replaced by a symlink fails chroot(2) with ELOOP instead of leaving the jail. */
const renderViewUnit = (view: AnonymousView): string => [
  '[Unit]', `Description=xPanel anonymous FTP view of ${view.what}`, '',
  '[Mount]', `What=${view.what}`, `Where=${view.where}`, 'Type=none', `Options=bind,${view.writable ? 'rw' : 'ro'},nosymfollow,nosuid,nodev,noexec`, '',
  '[Install]', 'WantedBy=multi-user.target', '',
].join('\n')
const unitOn = (unit: string): HostAction[] => [{ kind: 'systemd', verb: 'enable', unit }, { kind: 'systemd', verb: 'start', unit }]
const unitOff = (unit: string): HostAction[] => [{ kind: 'systemd', verb: 'stop', unit }, { kind: 'systemd', verb: 'disable', unit }]

/** The EL package has no wrapper: its unit runs `pure-ftpd <file>`, forking, with this pid file. PureDB stays before ExtAuth. */
export const renderPureFtpdConfFile = (settings: ServerFtpSettings, extAuthSocket: string | null, certFile: string): string =>
  ['# Managed by xPanel. Changes here are replaced on the next generation.', 'Daemonize yes', 'PIDFile /var/run/pure-ftpd.pid', `CertFile ${certFile}`,
    ...pureFtpdDirectives(settings, services.FTP_PDB_FILE, extAuthSocket).map(([name, value]) => `${name} ${value}`)].join('\n') + '\n'
export const parsePureFtpdConfFile = (content: string): Map<string, string> =>
  new Map(content.split('\n').flatMap(line => { const match = /^([A-Za-z]+)\s+(\S.*?)\s*$/.exec(line); return match ? [[match[1]!, match[2]!] as const] : [] }))

export interface FtpServerGeneration { files: RenderedFile[]; preActions: HostAction[]; postActions: HostAction[] }
/** `roleEnabled` false: FTP Server Selection or the server profile turned the daemon off, whatever the FTP settings say. */
export interface FtpHostObservation { certPresent: boolean; anonymous: AnonymousFtpState; roleEnabled?: boolean }
export interface FtpServerInput extends FtpHostObservation { os: OsProfile }

/** Undefined without pure-ftpd: a host installed without the FTP role gets no daemon files. */
export async function observeFtpHost(executor: Pick<AgentExecutor, 'runCommand'>, os: Pick<OsProfile, 'family'>, stateRoot: string): Promise<FtpHostObservation | undefined> {
  if (!(await executor.runCommand(['/usr/bin/test', '-x', '/usr/sbin/pure-ftpd'])).ok) return undefined
  let anonymous: AnonymousFtpState = {}
  try { anonymous = parseAnonymousFtpState(await readJsonIfExists<unknown>(join(stateRoot, FTP_ANONYMOUS_STATE))) } catch { anonymous = {} }
  return { certPresent: (await executor.runCommand(['/usr/bin/test', '-s', ftpCertFile(os)])).ok, anonymous }
}

export function compileFtpServer(snapshot: AnonymousSnapshot & Pick<StateSnapshot, 'server'>, input: FtpServerInput): FtpServerGeneration {
  const { os } = input, settings = effectiveServerFtpSettings(snapshot.server?.settings), certFile = ftpCertFile(os)
  const logins = anonymousFtpLogins(snapshot, settings, input.anonymous), extAuth = logins.length > 0 ? AUTH_SOCKET : null
  const preActions: HostAction[] = [], postActions: HostAction[] = [], views = new Map(logins.map(row => [row.view.unit, row.view]))
  const files = os.family === 'rhel' ? [root(FTP_CONF_FILE, renderPureFtpdConfFile(settings, extAuth, certFile))] : renderPureFtpdDaemonConfigs({ settings, extAuthSocket: extAuth })
  // The wrapper check needs the ExtAuth socket, so sign-in is up before it. A view or sign-in unit an earlier
  // generation started and this one drops is stopped through the manifest's removed units, never by name here:
  // a host that never had the unit has nothing to stop.
  if (extAuth) {
    files.push(root(FTP_ANONYMOUS_MAP, logins.map(row => `${row.login}\t${row.view.dir}\n`).join('')), root(AUTH_SCRIPT, renderAuthScript(), 0o755), root(`${os.paths.systemdDir}/${FTP_ANONYMOUS_UNIT}`, renderAuthUnit()),
      ...[...views.values()].map(view => root(`${os.paths.systemdDir}/${view.unit}`, renderViewUnit(view))))
    postActions.push({ kind: 'systemd-daemon-reload' }, ...[...views.keys()].flatMap(unitOn), ...unitOn(FTP_ANONYMOUS_UNIT))
  }
  if (os.family === 'rhel') preActions.push({ kind: 'ensure-dir', path: posix.dirname(certFile), mode: 0o755, owner: 'root', group: 'root' })
  else {
    // The Debian wrapper reads authentication methods only through numbered links in auth/, in name order.
    postActions.push({ kind: 'exec', argv: ['/usr/bin/ln', '-sfn', '../conf/PureDB', AUTH_LINKS.pure] },
      extAuth ? { kind: 'exec', argv: ['/usr/bin/ln', '-sfn', '../conf/ExtAuth', AUTH_LINKS.ext] } : { kind: 'remove-path', path: AUTH_LINKS.ext },
      { kind: 'exec', argv: ['/usr/sbin/pure-ftpd-wrapper', '--show-options'] })
  }
  // pure-ftpd refuses to start with TLS on and no certificate; cPanel also starts from a self-signed service certificate.
  if (!input.certPresent) postActions.push({ kind: 'exec', argv: ['/usr/bin/openssl', 'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-subj', '/CN=' + snapshot.server!.settings.hostname, '-keyout', certFile, '-out', certFile] })
  postActions.push(...settings.enabled && input.roleEnabled !== false ? unitOn(os.services.ftp) : unitOff(os.services.ftp))
  return { files, preActions, postActions }
}

/** pure-ftpd has no reload and a restart drops sessions on EL, so it runs only when a rendered daemon file changed. */
export function ftpRestartActions(os: OsProfile, files: readonly RenderedFile[], previous: readonly { path: string; sha256: string }[] | undefined, sha256: (text: string) => string, enabled: boolean): HostAction[] {
  const known = new Map(previous?.map(entry => [entry.path, entry.sha256]))
  // pure-authd reads the map per sign-in and pure-pw rebuilds the PureDB file, so neither needs the daemon restarted.
  const changed = files.some(file => file.path.startsWith('/etc/pure-ftpd/') && file.path !== services.FTP_PASSWD_FILE && file.path !== FTP_ANONYMOUS_MAP && known.get(file.path) !== sha256(file.content))
  return enabled && changed ? [{ kind: 'systemd', verb: 'restart', unit: os.services.ftp }] : []
}
