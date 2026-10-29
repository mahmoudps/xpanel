import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises'
import { dbGrantPattern, fail, isXpanelError } from '@xpanel/core'
import type { NewAuditEntry } from '@xpanel/db'
import { services } from '@xpanel/render'
import { parseMariadbBatch } from './mariadb-admin.ts'
import { parseShowGrantLine } from './services/mariadb.ts'
import { authorizeDbAccount, dbJson, readDbPackages } from './db-engines.ts'
import type { DbAccountDeps, DbFamily, DbRun } from './db-engines.ts'

/**
 * phpMyAdmin single sign-on (phpMyAdmin "signon" authentication, documented in its config chapter):
 * the agent creates a short-lived MariaDB user scoped to the caller, writes a single-use ticket into a
 * root-owned directory and the reviewed PHP bridge exchanges the ticket for the signon session once.
 * No password is ever sent to the browser; the browser receives only the 256-bit ticket.
 */
export const DB_SIGNON_CONFIG_PATH = '/etc/xpanel/database-web-clients.json'
export const DB_SIGNON_TICKET_SECONDS = 60
export const DB_SIGNON_SESSION_SECONDS = 1800
export const DB_SIGNON_SESSION_NAME = 'xPanelSignon'
const SSO_USER = /^xpsso-([0-9]{10})-([0-9a-f]{12})$/
const TICKET_FILE = /^[0-9a-f]{64}$/
const MAX_SSO_USERS = 1000

export interface DbSignonConfig { signonUrl: string; returnUrl: string; ticketDirectory: string; ticketGroup: string; bridgePath: string; configPath: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const httpsUrl = (value: unknown, query: boolean): string => {
  if (typeof value !== 'string' || value.length > 512) throw new Error('invalid_signon_url')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !query && url.search || url.href !== value) throw new Error('invalid_signon_url')
  return value
}
const phpPath = (value: unknown): string => typeof value === 'string' && /^\/[A-Za-z0-9._/-]{1,255}\.php$/.test(value) && !value.split('/').some(part => part === '..' || part === '.') ? value : (() => { throw new Error('invalid_signon_path') })()
/** Installer-written root configuration; anything unexpected keeps sign-on unavailable. */
export function parseDbSignonConfig(text: string): DbSignonConfig {
  const raw: unknown = JSON.parse(text)
  const pma = object(raw) && exact(raw, ['phpmyadmin']) ? raw.phpmyadmin : null
  if (!object(pma) || !exact(pma, ['signonUrl', 'returnUrl', 'ticketDirectory', 'ticketGroup', 'bridgePath', 'configPath'])) throw new Error('invalid_signon_config')
  if (typeof pma.ticketDirectory !== 'string' || !/^\/(?:var\/lib|run)\/xpanel\/[a-z0-9-]{1,64}$/.test(pma.ticketDirectory) || typeof pma.ticketGroup !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(pma.ticketGroup) || pma.ticketGroup === 'root') throw new Error('invalid_signon_config')
  return { signonUrl: httpsUrl(pma.signonUrl, false), returnUrl: httpsUrl(pma.returnUrl, true), ticketDirectory: pma.ticketDirectory, ticketGroup: pma.ticketGroup, bridgePath: phpPath(pma.bridgePath), configPath: phpPath(pma.configPath) }
}
const phpString = (value: string): string => "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
/** The reviewed bridge. rename(2) claims a ticket atomically, so only one request can ever use it. */
export const renderPhpMyAdminSignonBridge = (config: DbSignonConfig): string => `<?php
// xPanel phpMyAdmin single sign-on bridge. Installed verbatim; the xPanel agent verifies its SHA-256.
declare(strict_types=1);
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');
$deny = static function (): void { http_response_code(403); header('Content-Type: text/plain; charset=utf-8'); echo "This sign-on link is invalid, expired or already used.\\n"; exit; };
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { $deny(); }
$ticket = $_POST['ticket'] ?? '';
if (!is_string($ticket) || preg_match('/\\A[A-Za-z0-9_-]{43}\\z/', $ticket) !== 1) { $deny(); }
$path = ${phpString(config.ticketDirectory)} . '/' . hash('sha256', $ticket);
$claimed = $path . '.claimed.' . bin2hex(random_bytes(8));
if (!@rename($path, $claimed)) { $deny(); }
$raw = @file_get_contents($claimed, false, null, 0, 4096);
@unlink($claimed);
$data = is_string($raw) ? json_decode($raw, true, 4) : null;
if (!is_array($data) || !is_string($data['user'] ?? null) || !is_string($data['password'] ?? null) || !is_int($data['expiresAt'] ?? null)
  || preg_match('/\\Axpsso-[0-9]{10}-[0-9a-f]{12}\\z/', $data['user']) !== 1 || preg_match('/\\A[A-Za-z0-9_-]{32}\\z/', $data['password']) !== 1 || $data['expiresAt'] < time()) { $deny(); }
session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
session_name(${phpString(DB_SIGNON_SESSION_NAME)});
session_start();
session_regenerate_id(true);
$_SESSION['PMA_single_signon_user'] = $data['user'];
$_SESSION['PMA_single_signon_password'] = $data['password'];
session_write_close();
header('Location: ./index.php', true, 303);
`
/** phpMyAdmin server configuration for the signon method; SignonCookieParams must match the bridge. */
export const renderPhpMyAdminSignonConfig = (config: DbSignonConfig): string => `<?php
// xPanel single sign-on for phpMyAdmin. Installed verbatim; the xPanel agent verifies its SHA-256.
$cfg['Servers'][1]['auth_type'] = 'signon';
$cfg['Servers'][1]['host'] = 'localhost';
$cfg['Servers'][1]['SignonSession'] = ${phpString(DB_SIGNON_SESSION_NAME)};
$cfg['Servers'][1]['SignonCookieParams'] = ['lifetime' => 0, 'path' => '/', 'domain' => '', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax'];
$cfg['Servers'][1]['SignonURL'] = ${phpString(config.returnUrl)};
$cfg['Servers'][1]['LogoutURL'] = ${phpString(config.returnUrl)};
`

export interface DbSignonStat { isDirectory: boolean; isSymbolicLink: boolean; uid: number; gid: number; mode: number }
export interface DbSignonFs {
  /** null for a missing file; throws for other failures. Reads are bounded by the implementation. */
  readFile(path: string): Promise<string | null>
  lstat(path: string): Promise<DbSignonStat | null>
  /** Exclusive create of a temporary file, fsync, owner root:gid mode 0640, then rename into place. */
  writeTicket(directory: string, name: string, content: string, gid: number): Promise<void>
  listTickets(directory: string): Promise<{ name: string; mtimeMs: number }[]>
  removeTicket(directory: string, name: string): Promise<void>
}
const MAX_READ = 256 * 1024
/** Linux implementation: bounded no-follow reads, exclusive 0640 ticket creation and directory fsync before use. */
export const nodeDbSignonFs: DbSignonFs = {
  async readFile(path) {
    let handle
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try { const info = await handle.stat(); if (!info.isFile() || info.size > MAX_READ) throw new Error('unsafe_file'); return (await handle.readFile()).toString('utf8') } finally { await handle.close() }
  },
  async lstat(path) {
    try { const info = await lstat(path); return { isDirectory: info.isDirectory(), isSymbolicLink: info.isSymbolicLink(), uid: info.uid, gid: info.gid, mode: info.mode } } catch { return null }
  },
  async writeTicket(directory, name, content, gid) {
    const temporary = directory + '/.' + name + '.tmp', handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(content); await handle.chown(0, gid); await handle.chmod(0o640); await handle.sync() } catch (error) { await handle.close(); await unlink(temporary).catch(() => undefined); throw error }
    await handle.close()
    await rename(temporary, directory + '/' + name)
    const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY); try { await dir.sync() } finally { await dir.close() }
  },
  async listTickets(directory) {
    const names = (await readdir(directory)).slice(0, 5000)
    return Promise.all(names.map(async name => ({ name, mtimeMs: (await lstat(directory + '/' + name)).mtimeMs })))
  },
  async removeTicket(directory, name) { if (name.includes('/')) throw new Error('invalid_ticket_name'); await unlink(directory + '/' + name).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) },
}
export interface DbSignonSql { query(statements: readonly string[]): Promise<string> }
export type DbSignonReason = 'packages-unread' | 'package-missing' | 'config-missing' | 'config-invalid' | 'bridge-missing' | 'bridge-modified' | 'phpmyadmin-config-missing' | 'phpmyadmin-config-modified' | 'ticket-directory-unsafe' | 'database-admin-unavailable'
export type DbSignonStatus = { state: 'ready'; reason: null; config: DbSignonConfig; gid: number } | { state: 'not-installed' | 'not-configured' | 'unavailable'; reason: DbSignonReason; config: null; gid: null }
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** /etc/group(5): name:password:GID:members. */
export function groupGid(groupFile: string, name: string): number | null {
  for (const line of groupFile.split('\n')) {
    const [group, , gid] = line.split(':')
    if (group === name && /^(?:0|[1-9][0-9]{0,9})$/.test(gid ?? '')) return Number(gid)
  }
  return null
}

export async function readDbSignonStatus(input: { installed: boolean | null; fs: DbSignonFs; sql: DbSignonSql | null }): Promise<DbSignonStatus> {
  const off = (state: 'not-installed' | 'not-configured' | 'unavailable', reason: DbSignonReason): DbSignonStatus => ({ state, reason, config: null, gid: null })
  if (input.installed === null) return off('unavailable', 'packages-unread')
  if (!input.installed) return off('not-installed', 'package-missing')
  let config: DbSignonConfig
  try {
    const text = await input.fs.readFile(DB_SIGNON_CONFIG_PATH)
    if (text === null) return off('not-configured', 'config-missing')
    config = parseDbSignonConfig(text)
  } catch { return off('not-configured', 'config-invalid') }
  for (const [path, expected, missing, modified] of [[config.bridgePath, renderPhpMyAdminSignonBridge(config), 'bridge-missing', 'bridge-modified'], [config.configPath, renderPhpMyAdminSignonConfig(config), 'phpmyadmin-config-missing', 'phpmyadmin-config-modified']] as const) {
    let text: string | null
    try { text = await input.fs.readFile(path) } catch { return off('unavailable', missing) }
    if (text === null) return off('not-configured', missing)
    if (sha(text) !== sha(expected)) return off('not-configured', modified)
  }
  let gid: number | null = null
  try { gid = groupGid((await input.fs.readFile('/etc/group')) ?? '', config.ticketGroup) } catch { gid = null }
  const dir = await input.fs.lstat(config.ticketDirectory).catch(() => null)
  // 0730: the web group may create, rename and remove entries but cannot list tickets; no sticky bit, since the bridge renames root-owned files.
  if (gid === null || gid === 0 || !dir || dir.isSymbolicLink || !dir.isDirectory || dir.uid !== 0 || dir.gid !== gid || (dir.mode & 0o7777) !== 0o730) return off('not-configured', 'ticket-directory-unsafe')
  if (!input.sql) return off('unavailable', 'database-admin-unavailable')
  return { state: 'ready', reason: null, config, gid }
}

const q = services.quoteString
const sqlUser = (user: string): string => SSO_USER.test(user) ? `${q(user)}@'localhost'` : (() => { throw new Error('invalid_signon_user') })()

/** Drops expired session users (their expiry is in the name) and removes stale tickets. */
export async function reapDbSignon(input: { sql: DbSignonSql; fs: DbSignonFs; config: DbSignonConfig; now: () => Date }): Promise<{ users: number; tickets: number }> {
  const now = Math.floor(input.now().getTime() / 1000)
  const rows = parseMariadbBatch(await input.sql.query([`SELECT User FROM mysql.user WHERE User LIKE 'xpsso-%' AND Host = 'localhost' ORDER BY User LIMIT ${MAX_SSO_USERS + 1}`]), 1)
  if (rows.length > MAX_SSO_USERS) return fail('LIMIT_EXCEEDED', 'too many phpMyAdmin session users are pending removal', { stateChanged: false })
  const expired = rows.map(row => row[0]!).filter(user => { const match = SSO_USER.exec(user); return !!match && Number(match[1]) <= now })
  for (const user of expired) await input.sql.query([`DROP USER IF EXISTS ${sqlUser(user)}`])
  let tickets = 0
  for (const entry of await input.fs.listTickets(input.config.ticketDirectory)) {
    let expiresAt: number | null = null
    if (TICKET_FILE.test(entry.name)) {
      try { const data: unknown = JSON.parse((await input.fs.readFile(input.config.ticketDirectory + '/' + entry.name)) ?? ''); expiresAt = object(data) && Number.isSafeInteger(data.expiresAt) ? data.expiresAt as number : null } catch { expiresAt = null }
    }
    const stale = expiresAt !== null ? expiresAt < now : entry.mtimeMs / 1000 + DB_SIGNON_TICKET_SECONDS < now
    if (stale) { await input.fs.removeTicket(input.config.ticketDirectory, entry.name); tickets++ }
  }
  return { users: expired.length, tickets }
}

export type DbSignonScope = { kind: 'account'; username: string; databases: readonly string[] } | { kind: 'root' }
export interface DbSignonIssued { client: 'phpmyadmin'; action: string; ticket: string; expiresAt: string; sessionExpiresAt: string }
const grantsOf = async (sql: DbSignonSql, user: string): Promise<string[]> => parseMariadbBatch(await sql.query([`SHOW GRANTS FOR ${sqlUser(user)}`]), 1).map(row => row[0]!)
/** Creates the session user, proves its exact grants by re-reading them, then writes the single-use ticket. */
export async function issueDbSignon(input: { scope: DbSignonScope; status: Extract<DbSignonStatus, { state: 'ready' }>; sql: DbSignonSql; fs: DbSignonFs; now: () => Date; random?: (bytes: number) => Buffer; beforeEffect: () => Promise<void> }): Promise<DbSignonIssued> {
  const random = input.random ?? randomBytes, issuedAt = Math.floor(input.now().getTime() / 1000)
  const sessionExpiresAt = issuedAt + DB_SIGNON_SESSION_SECONDS, ticketExpiresAt = issuedAt + DB_SIGNON_TICKET_SECONDS
  const user = `xpsso-${String(sessionExpiresAt).padStart(10, '0')}-${random(6).toString('hex')}`, password = random(24).toString('base64url'), ticket = random(32).toString('base64url')
  if (!SSO_USER.test(user) || !/^[A-Za-z0-9_-]{32}$/.test(password) || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return fail('PRECONDITION_FAILED', 'secure random values are unavailable', { stateChanged: false })
  const databases = input.scope.kind === 'account' ? [...new Set(input.scope.databases)].sort() : []
  if (input.scope.kind === 'account') for (const name of databases) services.assertDatabaseName(name, input.scope.username)
  const privileges = services.MARIADB_PRIVILEGES.join(', ')
  const grants = input.scope.kind === 'root' ? [`GRANT ALL PRIVILEGES ON *.* TO ${sqlUser(user)}`] : databases.map(name => `GRANT ${privileges} ON ${services.quoteIdent(dbGrantPattern(name))}.* TO ${sqlUser(user)}`)
  await input.beforeEffect()
  await input.sql.query([`CREATE USER ${sqlUser(user)} IDENTIFIED BY PASSWORD ${q(services.mysqlNativePasswordHash(password))} WITH MAX_USER_CONNECTIONS 10`, ...grants])
  const drop = async (): Promise<void> => { try { await input.sql.query([`DROP USER IF EXISTS ${sqlUser(user)}`]) } catch { /* the reaper removes it by its expiry */ } }
  try {
    const live = (await grantsOf(input.sql, user)).map(parseShowGrantLine).filter(line => line !== null)
    const proven = input.scope.kind === 'root'
      ? live.length === 1 && live[0]!.kind === 'global' && /^GRANT ALL PRIVILEGES ON \*\.\* TO /.test(live[0]!.raw) && !/WITH GRANT OPTION/i.test(live[0]!.raw)
      : live.length === databases.length && live.every(line => line.kind === 'database' && line.privileges.length === services.MARIADB_PRIVILEGES.length && !/WITH GRANT OPTION/i.test(line.raw)) && JSON.stringify(live.map(line => line.databasePattern).sort()) === JSON.stringify(databases.map(dbGrantPattern).sort())
    if (!proven) throw new Error('signon_grants_unverified')
    await input.beforeEffect()
    await input.fs.writeTicket(input.status.config.ticketDirectory, createHash('sha256').update(ticket).digest('hex'), JSON.stringify({ user, password, expiresAt: ticketExpiresAt }), input.status.gid)
  } catch (error) {
    await drop()
    // Authority loss keeps its own denial; a session user without a ticket has a password nobody holds.
    if (isXpanelError(error)) throw error
    return fail('SERVICE_UNAVAILABLE', 'the phpMyAdmin session could not be prepared', { stateChanged: false })
  }
  return { client: 'phpmyadmin', action: input.status.config.signonUrl, ticket, expiresAt: new Date(ticketExpiresAt * 1000).toISOString(), sessionExpiresAt: new Date(sessionExpiresAt * 1000).toISOString() }
}

export interface DbSignonRouteDeps extends DbAccountDeps {
  assertRoot(action: string): Promise<{ actor: string }>
  family: DbFamily | null
  run: DbRun | null
  fs: DbSignonFs | null
  sql: DbSignonSql | null
  audit(entry: NewAuditEntry): Promise<unknown>
  now?: () => Date
  random?: (bytes: number) => Buffer
}
const ROOT_SIGNON = '/host/databases/web-clients/phpmyadmin/sign-on'
const ACCOUNT = /^\/accounts\/([a-z][a-z0-9]{0,15})\/database-engines\/(phpmyadmin|phppgadmin)(\/sign-on)?$/
const publicStatus = (status: DbSignonStatus) => ({ state: status.state, reason: status.reason })

export async function handleDbSignonRoute(req: Request, url: URL, method: string, deps: DbSignonRouteDeps): Promise<Response | null> {
  const account = ACCOUNT.exec(url.pathname), root = url.pathname === ROOT_SIGNON || url.pathname === '/host/databases/web-clients'
  if (!account && !root || account?.[2] === 'phppgadmin' && account[3]) return null
  const issue = url.pathname === ROOT_SIGNON || !!account?.[3]
  if (method !== (issue ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: issue ? 'POST' : 'GET' } })
  if (url.search) return fail('VALIDATION', 'database web clients do not accept selectors', { stateChanged: false })
  if (issue) {
    if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
    const text = await req.text()
    let body: unknown
    try { body = text.length <= 64 ? JSON.parse(text) : null } catch { body = null }
    if (!object(body) || Object.keys(body).length !== 0) return fail('VALIDATION', 'sign-on takes an empty JSON object', { stateChanged: false })
  }
  const toolId = account?.[2] ?? 'phpmyadmin', now = deps.now ?? (() => new Date())
  const owner = account ? await authorizeDbAccount(deps, account[1]!, toolId) : null
  const actor = owner ? null : (await deps.assertRoot(issue ? 'host.databases.signon' : 'host.databases.web-clients')).actor
  const packages = await readDbPackages(deps)
  const installed = (id: 'phpmyadmin' | 'phppgadmin'): boolean | null => packages.state === 'read' ? packages.products[id].installed : null
  const status = deps.fs ? await readDbSignonStatus({ installed: installed('phpmyadmin'), fs: deps.fs, sql: deps.sql }) : { state: 'unavailable' as const, reason: 'packages-unread' as const, config: null, gid: null }
  const fresh = async (): Promise<void> => {
    if (owner) { const current = await authorizeDbAccount(deps, owner.username, toolId); if (current.id !== owner.id || current.createdAt !== owner.createdAt) fail('CONFLICT', 'the account changed', { stateChanged: false }); return }
    if ((await deps.assertRoot(issue ? 'host.databases.signon' : 'host.databases.web-clients')).actor !== actor) fail('FORBIDDEN', 'database web client authority changed', { stateChanged: false })
  }
  if (!issue) {
    await fresh()
    const context = owner ? { context: { accountId: owner.id, username: owner.username } } : {}
    if (toolId === 'phppgadmin') return dbJson({ ...context, client: 'phppgadmin', installed: installed('phppgadmin'), signon: { state: 'unsupported', reason: 'no-documented-signon' }, postgresql: packages.state === 'read' ? packages.products.postgresql.installed : null })
    const databases = owner ? (await deps.store.readDatabaseRemoteAccess(owner.id)).databases.filter(row => row.trashedAt === null).length : null
    return dbJson({ ...context, client: 'phpmyadmin', installed: installed('phpmyadmin'), signon: publicStatus(status), databases, ticketSeconds: DB_SIGNON_TICKET_SECONDS, sessionSeconds: DB_SIGNON_SESSION_SECONDS, ...(owner ? {} : { phppgadmin: installed('phppgadmin') }) })
  }
  if (status.state !== 'ready' || !deps.fs || !deps.sql) return fail('PRECONDITION_FAILED', 'phpMyAdmin sign-on is not available on this server; nothing was created', { stateChanged: false, reason: status.reason })
  try { await reapDbSignon({ sql: deps.sql, fs: deps.fs, config: status.config, now }) } catch { /* expired users are retried on the next sign-on */ }
  const scope: Parameters<typeof issueDbSignon>[0]['scope'] = owner ? { kind: 'account', username: owner.username, databases: (await deps.store.readDatabaseRemoteAccess(owner.id)).databases.filter(row => row.trashedAt === null && row.accountId === owner.id).map(row => row.name) } : { kind: 'root' }
  const entry = { actor: owner ? deps.caller.actor : actor!, principalId: deps.caller.principalId, action: 'database.phpmyadmin.sign_on', target: owner ? 'account:' + owner.username : 'server' }
  // The intent is durable before any session user exists; an unaudited sign-on is never issued.
  try { await deps.audit({ ...entry, detail: { databases: scope.kind === 'account' ? scope.databases.length : null }, outcome: 'ok' }) }
  catch { return fail('PRECONDITION_FAILED', 'the phpMyAdmin sign-on could not be audited; nothing was created', { stateChanged: false }) }
  try { return dbJson(await issueDbSignon({ scope, status, sql: deps.sql, fs: deps.fs, now, ...(deps.random ? { random: deps.random } : {}), beforeEffect: fresh })) }
  catch (error) { await deps.audit({ ...entry, action: 'database.phpmyadmin.sign_on_failed', detail: {}, outcome: 'failed' }).catch(() => undefined); throw error }
}
