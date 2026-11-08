import { randomBytes, createHash } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { NewAuditEntry } from '@xpanel/db'
import { PG_SSO_ROLES_SQL, pgSsoRoleProofSql, postgresqlQueryArgv } from '../../../packages/os/src/db-engines-command.ts'
import { postgresqlScramVerifier } from '../../../packages/state/src/pg-state.ts'
import { authorizeDbAccount, dbJson, readAccountPostgresql, readDbPackages } from './db-engines.ts'
import type { DbAccountDeps, DbFamily, DbRun, PgAccountDatabase } from './db-engines.ts'
import { DB_SIGNON_SESSION_SECONDS, DB_SIGNON_TICKET_SECONDS, groupGid, httpsUrl, phpPath, reapSignonTickets, readSignonBody, SIGNON_DIRECTORY, SIGNON_GROUP } from './db-signon.ts'
import type { DbSignonFs } from './db-signon.ts'

/**
 * phpPgAdmin single sign-on, the same way as phpMyAdmin: a short-lived scoped database login, a single-use ticket in a
 * root-owned directory, and a reviewed PHP bridge that exchanges it once. phpPgAdmin documents no sign-on method, so the
 * bridge fills the session fields of its own "shared credentials" login (libraries/lib.inc.php, classes/Misc.php).
 *
 * The session role only ever acts as the owner of the database it connects to: it joins the owner roles and each
 * connection starts with SET ROLE, so whatever it creates belongs to the owner and survives the role. PostgreSQL
 * enforces the expiry itself through VALID UNTIL. Other databases refuse it, since CONNECT is revoked from PUBLIC, and
 * phpPgAdmin's owned_only lists a database only when the login holds its owner role (pg_has_role in getDatabases).
 */
export const PG_SIGNON_CONFIG_PATH = '/etc/xpanel/database-web-client-phppgadmin.json'
const PG_SSO_ROLE = /^xpsso-([0-9]{10})-([0-9a-f]{12})$/
const MAX_SSO_ROLES = 1000

export interface PgSignonConfig { signonUrl: string; ticketDirectory: string; ticketGroup: string; bridgePath: string; clientConfigPath: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** Root configuration; anything unexpected keeps sign-on unavailable. */
export function parsePgSignonConfig(text: string): PgSignonConfig {
  const raw: unknown = JSON.parse(text)
  if (!object(raw) || Object.keys(raw).sort().join() !== 'bridgePath,clientConfigPath,signonUrl,ticketDirectory,ticketGroup') throw new Error('invalid_signon_config')
  if (typeof raw.ticketDirectory !== 'string' || !SIGNON_DIRECTORY.test(raw.ticketDirectory) || typeof raw.ticketGroup !== 'string' || !SIGNON_GROUP.test(raw.ticketGroup) || raw.ticketGroup === 'root') throw new Error('invalid_signon_config')
  return { signonUrl: httpsUrl(raw.signonUrl, false), ticketDirectory: raw.ticketDirectory, ticketGroup: raw.ticketGroup, bridgePath: phpPath(raw.bridgePath), clientConfigPath: phpPath(raw.clientConfigPath) }
}
const phpString = (value: string): string => "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
/** The reviewed bridge. rename(2) claims a ticket atomically, so only one request can ever use it. */
export const renderPhpPgAdminSignonBridge = (config: PgSignonConfig): string => `<?php
// xPanel phpPgAdmin single sign-on bridge. Installed verbatim; the xPanel agent verifies its SHA-256.
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
session_name('PPA_ID');
session_start();
session_regenerate_id(true);
$_SESSION = ['sharedUsername' => $data['user'], 'sharedPassword' => $data['password']];
session_write_close();
header('Location: ./index.php', true, 303);
`

export type PgSignonReason = 'packages-unread' | 'package-missing' | 'no-distribution-package' | 'config-missing' | 'config-invalid' | 'bridge-missing' | 'bridge-modified' | 'client-config-missing' | 'client-config-unscoped' | 'ticket-directory-unsafe' | 'postgresql-unavailable'
export type PgSignonStatus = { state: 'ready'; reason: null; config: PgSignonConfig; gid: number } | { state: 'not-installed' | 'no-package' | 'not-configured' | 'unavailable'; reason: PgSignonReason; config: null; gid: null }
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
/** The package's configuration differs between releases, so only the setting that scopes the database list is required; the last assignment wins. */
export const pgClientConfigScoped = (text: string): boolean => [...text.matchAll(/^[ \t]*\$conf\['owned_only'\][ \t]*=[ \t]*(true|false)[ \t]*;/gm)].at(-1)?.[1] === 'true'

export async function readPgSignonStatus(input: { installed: boolean | null; family: DbFamily | null; postgresql: boolean; fs: DbSignonFs }): Promise<PgSignonStatus> {
  const off = (state: 'not-installed' | 'no-package' | 'not-configured' | 'unavailable', reason: PgSignonReason): PgSignonStatus => ({ state, reason, config: null, gid: null })
  if (input.installed === null) return off('unavailable', 'packages-unread')
  // Measured 2026-11-07: AppStream, CRB, EPEL and Remi for EL 9 and 10 have no phpPgAdmin; Ubuntu universe has it on 22.04 and 24.04.
  if (!input.installed) return input.family === 'rhel' ? off('no-package', 'no-distribution-package') : off('not-installed', 'package-missing')
  let config: PgSignonConfig
  try {
    const text = await input.fs.readFile(PG_SIGNON_CONFIG_PATH)
    if (text === null) return off('not-configured', 'config-missing')
    config = parsePgSignonConfig(text)
  } catch { return off('not-configured', 'config-invalid') }
  let bridge: string | null
  try { bridge = await input.fs.readFile(config.bridgePath) } catch { return off('unavailable', 'bridge-missing') }
  if (bridge === null) return off('not-configured', 'bridge-missing')
  if (sha(bridge) !== sha(renderPhpPgAdminSignonBridge(config))) return off('not-configured', 'bridge-modified')
  let client: string | null
  try { client = await input.fs.readFile(config.clientConfigPath) } catch { return off('unavailable', 'client-config-missing') }
  if (client === null) return off('not-configured', 'client-config-missing')
  if (!pgClientConfigScoped(client)) return off('not-configured', 'client-config-unscoped')
  let gid: number | null = null
  try { gid = groupGid((await input.fs.readFile('/etc/group')) ?? '', config.ticketGroup) } catch { gid = null }
  const dir = await input.fs.lstat(config.ticketDirectory).catch(() => null)
  // 0730 as for phpMyAdmin: the web group creates, renames and removes entries but cannot list tickets.
  if (gid === null || gid === 0 || !dir || dir.isSymbolicLink || !dir.isDirectory || dir.uid !== 0 || dir.gid !== gid || (dir.mode & 0o7777) !== 0o730) return off('not-configured', 'ticket-directory-unsafe')
  if (!input.postgresql) return off('unavailable', 'postgresql-unavailable')
  return { state: 'ready', reason: null, config, gid }
}

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`
const assertRole = (role: string): string => PG_SSO_ROLE.test(role) ? role : (() => { throw new Error('invalid_signon_role') })()

/** Single-line statements for psql: ALTER ROLE ... SET role runs at each connection start, per database first. */
export function pgSignonStatements(role: string, verifier: string, validUntil: string, databases: readonly PgAccountDatabase[]): string[] {
  const name = ident(assertRole(role)), owners = [...new Set(databases.map(database => database.owner))].sort()
  if (!owners.length) throw new Error('no_signon_databases')
  return [`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 10 VALID UNTIL ${literal(validUntil)} PASSWORD ${literal(verifier)};`,
    ...owners.map(owner => `GRANT ${ident(owner)} TO ${name};`),
    `ALTER ROLE ${name} SET role = ${literal(owners[0]!)};`,
    ...databases.map(database => `ALTER ROLE ${name} IN DATABASE ${ident(database.name)} SET role = ${literal(database.owner)};`)]
}
const dropStatements = (role: string): string[] => [`SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename = ${literal(assertRole(role))};`, `DROP ROLE IF EXISTS ${ident(role)};`]

/** psql -A -t output of pgSsoRoleProofSql: no privilege flag set, connection limit 10, exactly these owner roles. */
export function pgSignonProven(stdout: string, owners: readonly string[]): boolean {
  const fields = stdout.replace(/\n$/, '').split('\t')
  return fields.length === 7 && fields.slice(0, 5).every(flag => flag === 'f') && fields[5] === '10' && fields[6] === [...new Set(owners)].sort().join(' ')
}
const pgRows = (stdout: string): string[] => stdout === '' ? [] : stdout.replace(/\n$/, '').split('\n')

/** Drops expired session roles (their expiry is in the name) and stale tickets. VALID UNTIL has already closed them. */
export async function reapPgSignon(input: { run: DbRun; script: (statements: string[]) => Promise<void>; fs: DbSignonFs; config: PgSignonConfig; now: () => Date }): Promise<{ roles: number; tickets: number }> {
  const now = Math.floor(input.now().getTime() / 1000), listed = await input.run(postgresqlQueryArgv(PG_SSO_ROLES_SQL))
  if (!listed.ok) return fail('SERVICE_UNAVAILABLE', 'phpPgAdmin session roles could not be read', { stateChanged: false })
  const rows = pgRows(listed.stdout)
  if (rows.length > MAX_SSO_ROLES) return fail('LIMIT_EXCEEDED', 'too many phpPgAdmin session roles are pending removal', { stateChanged: false })
  let roles = 0
  for (const role of rows) {
    const match = PG_SSO_ROLE.exec(role)
    if (!match || Number(match[1]) > now) continue
    // An account's dropped owner role can leave a setting behind; that role stays closed and the next reap retries it.
    try { await input.script(dropStatements(role)); roles++ } catch { /* retried on the next sign-on */ }
  }
  return { roles, tickets: await reapSignonTickets(input.fs, input.config.ticketDirectory, now) }
}

export interface PgSignonIssued { client: 'phppgadmin'; action: string; ticket: string; expiresAt: string; sessionExpiresAt: string }
/** Creates the session role, proves it by re-reading it, then writes the single-use ticket. */
export async function issuePgSignon(input: { databases: readonly PgAccountDatabase[]; status: Extract<PgSignonStatus, { state: 'ready' }>; run: DbRun; script: (statements: string[]) => Promise<void>; fs: DbSignonFs; now: () => Date; random?: (bytes: number) => Buffer; beforeEffect: () => Promise<void> }): Promise<PgSignonIssued> {
  const random = input.random ?? randomBytes, issuedAt = Math.floor(input.now().getTime() / 1000)
  const sessionExpiresAt = issuedAt + DB_SIGNON_SESSION_SECONDS, ticketExpiresAt = issuedAt + DB_SIGNON_TICKET_SECONDS, validUntil = new Date(sessionExpiresAt * 1000).toISOString()
  const role = `xpsso-${String(sessionExpiresAt).padStart(10, '0')}-${random(6).toString('hex')}`, password = random(24).toString('base64url'), ticket = random(32).toString('base64url')
  if (!PG_SSO_ROLE.test(role) || !/^[A-Za-z0-9_-]{32}$/.test(password) || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return fail('PRECONDITION_FAILED', 'secure random values are unavailable', { stateChanged: false })
  const drop = async (): Promise<void> => { try { await input.script(dropStatements(role)) } catch { /* the reaper removes it by its expiry */ } }
  await input.beforeEffect()
  try {
    await input.script(pgSignonStatements(role, postgresqlScramVerifier(password), validUntil, input.databases))
    const proof = await input.run(postgresqlQueryArgv(pgSsoRoleProofSql(role)))
    if (!proof.ok || !pgSignonProven(proof.stdout, input.databases.map(database => database.owner))) throw new Error('signon_role_unverified')
    await input.beforeEffect()
    await input.fs.writeTicket(input.status.config.ticketDirectory, createHash('sha256').update(ticket).digest('hex'), JSON.stringify({ user: role, password, expiresAt: ticketExpiresAt }), input.status.gid)
  } catch (error) {
    await drop()
    // Authority loss keeps its own denial; a session role without a ticket has a password nobody holds.
    if (isXpanelError(error)) throw error
    return fail('SERVICE_UNAVAILABLE', 'the phpPgAdmin session could not be prepared', { stateChanged: false })
  }
  return { client: 'phppgadmin', action: input.status.config.signonUrl, ticket, expiresAt: new Date(ticketExpiresAt * 1000).toISOString(), sessionExpiresAt: new Date(sessionExpiresAt * 1000).toISOString() }
}

export interface PgSignonRouteDeps extends DbAccountDeps {
  family: DbFamily | null
  run: DbRun | null
  fs: DbSignonFs | null
  /** The executor's 'postgresql' SQL action; null without a native host. */
  script: ((statements: string[]) => Promise<void>) | null
  audit(entry: NewAuditEntry): Promise<unknown>
  now?: () => Date
  random?: (bytes: number) => Buffer
}
const ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/database-engines\/phppgadmin(\/sign-on)?$/

export async function handlePgSignonRoute(req: Request, url: URL, method: string, deps: PgSignonRouteDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const issue = !!match[2]
  if (method !== (issue ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: issue ? 'POST' : 'GET' } })
  if (url.search) return fail('VALIDATION', 'database web clients do not accept selectors', { stateChanged: false })
  if (issue) await readSignonBody(req)
  const owner = await authorizeDbAccount(deps, match[1]!, 'phppgadmin'), now = deps.now ?? (() => new Date())
  const fresh = async (): Promise<void> => { const current = await authorizeDbAccount(deps, owner.username, 'phppgadmin'); if (current.id !== owner.id || current.createdAt !== owner.createdAt) fail('CONFLICT', 'the account changed', { stateChanged: false }) }
  const packages = await readDbPackages(deps), installed = packages.state === 'read' ? packages.products.phppgadmin.installed : null
  const server = await readAccountPostgresql({ family: deps.family, run: deps.run, username: owner.username, now })
  // An owner role outside the account would widen the session past its databases.
  const databases = server.databases.filter(database => database.owner === owner.username || database.owner.startsWith(owner.username + '_'))
  const postgresql = server.state === 'read' && deps.script !== null
  const status = deps.fs ? await readPgSignonStatus({ installed, family: deps.family, postgresql, fs: deps.fs }) : { state: 'unavailable' as const, reason: 'packages-unread' as const, config: null, gid: null }
  if (!issue) {
    await fresh()
    return dbJson({ context: { accountId: owner.id, username: owner.username }, client: 'phppgadmin', installed, postgresql: packages.state === 'read' ? packages.products.postgresql.installed : null, signon: { state: status.state, reason: status.reason }, databases: server.state === 'read' ? databases.length : null, ticketSeconds: DB_SIGNON_TICKET_SECONDS, sessionSeconds: DB_SIGNON_SESSION_SECONDS })
  }
  if (status.state !== 'ready' || !deps.fs || !deps.run || !deps.script) return fail('PRECONDITION_FAILED', 'phpPgAdmin sign-on is not available on this server; nothing was created', { stateChanged: false, reason: status.reason })
  if (!databases.length) return fail('PRECONDITION_FAILED', 'create a PostgreSQL database first; nothing was created', { stateChanged: false, reason: 'no-databases' })
  try { await reapPgSignon({ run: deps.run, script: deps.script, fs: deps.fs, config: status.config, now }) } catch { /* expired roles are retried on the next sign-on */ }
  const entry = { actor: deps.caller.actor, principalId: deps.caller.principalId, action: 'database.phppgadmin.sign_on', target: 'account:' + owner.username }
  // The intent is durable before any session role exists; an unaudited sign-on is never issued.
  try { await deps.audit({ ...entry, detail: { databases: databases.length }, outcome: 'ok' }) }
  catch { return fail('PRECONDITION_FAILED', 'the phpPgAdmin sign-on could not be audited; nothing was created', { stateChanged: false }) }
  try { return dbJson(await issuePgSignon({ databases, status, run: deps.run, script: deps.script, fs: deps.fs, now, ...(deps.random ? { random: deps.random } : {}), beforeEffect: fresh })) }
  catch (error) { await deps.audit({ ...entry, action: 'database.phppgadmin.sign_on_failed', detail: {}, outcome: 'failed' }).catch(() => undefined); throw error }
}
