import { X509Certificate } from 'node:crypto'
import { canonicalIp, fail, validateDomainName } from '@xpanel/core'
import type { HostAction, RenderedFile } from '@xpanel/core'
import { assertNoPasswordInArgv, DEFAULT_MARIADB_ADMIN_CNF, DEFAULT_MARIADB_BINARY, defaultCommandRunner } from './services/mariadb.ts'
import type { MariaDbCommandRunner } from './services/mariadb.ts'

/**
 * Manage MySQL Profiles. Metadata lives in one file and every credential in its own 0600 option file, so a password is
 * only ever read by the MariaDB client through --defaults-extra-file. It never reaches argv, a view, a log or an audit row.
 */
export const DB_PROFILE_INDEX = '/etc/xpanel/db-profiles.json'
export const DB_LOCAL_PROFILE = 'localhost'
export const DB_PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const dbProfileOptionFile = (name: string): string => `/etc/xpanel/db-profile-${name}.cnf`
export const dbProfileCaFile = (name: string): string => `/etc/xpanel/db-profile-${name}.pem`
const MARKER = '# Managed by xPanel: database server profile'
const CONNECT_TIMEOUT_SECONDS = 8
const VALIDATE_TIMEOUT_MS = 15_000
const PASSWORD = /^[\x21-\x7e]{1,128}$/
const USER = /^[A-Za-z0-9_.@-]{1,80}$/
const MAX_PROFILES = 16
const MAX_CA_CHARS = 8192

export type DbProfileFailure = 'unreachable' | 'access_denied' | 'tls_failed' | 'tls_not_negotiated' | 'not_mariadb' | 'insufficient_privileges' | 'failed'
export interface DbProfileValidation { state: 'passed' | 'failed'; reason: DbProfileFailure | null; version: string | null; clientHost: string | null; at: string }
export interface DbProfile { name: string; host: string; port: number; user: string; description: string; validation: DbProfileValidation | null; createdAt: string; updatedAt: string }
export interface DbProfileIndex { version: 1; active: string; profiles: DbProfile[] }
export interface DbProfileInput { name: string; host: string; port: number; user: string; password: string | null; description: string; ca: string | null }

const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const emptyIndex = (): DbProfileIndex => ({ version: 1, active: DB_LOCAL_PROFILE, profiles: [] })

export function dbProfileHost(value: unknown): string {
  if (typeof value !== 'string' || value === DB_LOCAL_PROFILE) return invalid('the host must be an IP address or a host name of the remote server')
  try { return canonicalIp(value, 'profile host').address } catch { return validateDomainName(value) }
}
/** One PEM certificate: the CA of the server, or its own self-signed certificate. Null keeps the saved one. */
function dbProfileCa(value: unknown): string | null {
  if (value === null) return null
  const refused = (): never => invalid('the CA certificate must be one PEM certificate')
  if (typeof value !== 'string' || value.length > MAX_CA_CHARS) return refused()
  const text = value.trim()
  if (!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/.test(text)) return refused()
  try { new X509Certificate(text) } catch { return refused() }
  return text.replaceAll('\r', '') + '\n'
}
/** Refuses anything that could break out of one option line. */
export function parseDbProfileInput(value: unknown): DbProfileInput {
  if (!object(value) || Object.keys(value).sort().join() !== 'ca,description,host,name,password,port,user') return invalid('name, host, port, user, password, description and ca are required')
  if (typeof value.name !== 'string' || !DB_PROFILE_NAME.test(value.name) || value.name === DB_LOCAL_PROFILE) return invalid('the profile name must be 1 to 32 lowercase letters, digits, dashes or underscores')
  if (typeof value.port !== 'number' || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) return invalid('the port must be 1 to 65535')
  if (typeof value.user !== 'string' || !USER.test(value.user)) return invalid('the user may hold letters, digits and . _ @ -')
  if (value.password !== null && (typeof value.password !== 'string' || !PASSWORD.test(value.password))) return invalid('the password must be 1 to 128 printable ASCII characters without spaces')
  if (typeof value.description !== 'string' || value.description.length > 200 || /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(value.description)) return invalid('the description must be plain text of at most 200 characters')
  return { name: value.name, host: dbProfileHost(value.host), port: value.port, user: value.user, password: value.password as string | null, description: value.description, ca: dbProfileCa(value.ca) }
}
const validationOf = (value: unknown): DbProfileValidation | null => {
  if (value === null) return null
  if (!object(value) || !['passed', 'failed'].includes(String(value.state)) || typeof value.at !== 'string') throw new Error('validation')
  return value as unknown as DbProfileValidation
}
export function parseDbProfileIndex(text: string | null): DbProfileIndex | null {
  if (text === null) return emptyIndex()
  try {
    const raw: unknown = JSON.parse(text)
    if (!object(raw) || raw.version !== 1 || typeof raw.active !== 'string' || !Array.isArray(raw.profiles) || raw.profiles.length > MAX_PROFILES) return null
    const profiles = raw.profiles.map((item: unknown): DbProfile => {
      if (!object(item) || typeof item.name !== 'string' || !DB_PROFILE_NAME.test(item.name) || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' || typeof item.description !== 'string' || typeof item.port !== 'number' || typeof item.user !== 'string' || !USER.test(item.user)) throw new Error('profile')
      return { name: item.name, host: dbProfileHost(item.host), port: item.port, user: item.user, description: item.description, validation: validationOf(item.validation), createdAt: item.createdAt, updatedAt: item.updatedAt }
    })
    if (raw.active !== DB_LOCAL_PROFILE && !profiles.some(profile => profile.name === raw.active)) return null
    return { version: 1, active: raw.active, profiles }
  } catch { return null }
}
// The same quoting as the root client file: backslash and double quote are the only escapes an option value needs.
const optionValue = (value: string): string => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
/** The client proves the server against its CA and host name during the TLS handshake, before any credential is sent. */
export const renderDbProfileOptions = (input: Pick<DbProfileInput, 'name' | 'host' | 'port' | 'user'>, passwordLine: string): string =>
  `${MARKER}\n[client]\nhost=${input.host}\nport=${input.port}\nuser=${input.user}\n${passwordLine}\nssl\nssl-ca=${dbProfileCaFile(input.name)}\nssl-verify-server-cert\n`
export const dbProfilePasswordLine = (password: string): string => 'password=' + optionValue(password)
const savedPasswordLine = (content: string | null): string | null => content?.split('\n').find(line => line.startsWith('password=')) ?? null

/** One connection through the option file: the server's own answers decide, and stdout, which may hold a password hash, is dropped here. */
export async function validateDbProfile(profile: Pick<DbProfile, 'name'>, run: MariaDbCommandRunner, now: () => Date): Promise<DbProfileValidation> {
  const at = now().toISOString(), failed = (reason: DbProfileFailure, version: string | null = null): DbProfileValidation => ({ state: 'failed', reason, version, clientHost: null, at })
  const argv = [DEFAULT_MARIADB_BINARY, '--defaults-extra-file=' + dbProfileOptionFile(profile.name), '--protocol=TCP', '--connect-timeout=' + CONNECT_TIMEOUT_SECONDS, '--batch', '--skip-column-names']
  assertNoPasswordInArgv(argv)
  let result
  try { result = await run({ argv, stdinSql: "SELECT VERSION();\nSELECT USER();\nSHOW STATUS LIKE 'Ssl_cipher';\nSHOW GRANTS;\n", timeoutMs: VALIDATE_TIMEOUT_MS, maxStdoutBytes: 64 * 1024, maxStderrBytes: 16 * 1024 }) }
  catch { return failed('unreachable') }
  if (!result.ok) {
    const stderr = result.stderr
    return failed(/Access denied/i.test(stderr) ? 'access_denied' : /\b(?:SSL|TLS)\b/.test(stderr) ? 'tls_failed' : /Unknown (?:MySQL|MariaDB) server host|Can't connect|Connection refused|timed out|Lost connection|server has gone away/i.test(stderr) ? 'unreachable' : 'failed')
  }
  const [version = '', user = '', cipher = '', ...grants] = result.stdout.split('\n')
  if (!/MariaDB/i.test(version)) return failed('not_mariadb')
  const shown = version.slice(0, 64)
  if (!/^Ssl_cipher\t\S+/.test(cipher)) return failed('tls_not_negotiated', shown)
  if (!grants.some(line => /^GRANT ALL PRIVILEGES ON \*\.\* TO .*WITH GRANT OPTION/.test(line))) return failed('insufficient_privileges', shown)
  const clientHost = /@([A-Za-z0-9.:_-]{1,255})$/.exec(user)?.[1] ?? null
  return clientHost ? { state: 'passed', reason: null, version: shown, clientHost, at } : failed('failed', shown)
}

export interface DbProfileHost {
  readFile(path: string): Promise<string | null>
  writeFile(file: RenderedFile): Promise<void>
  removePath(path: string): Promise<void>
  runAction?: (action: HostAction) => Promise<void>
}
export interface DbProfilesDeps {
  host: DbProfileHost
  /** Saved MariaDB databases and users: while any exist, the single-target adapter must keep its server. */
  savedDatabases: () => Promise<number>
  /** The live admin client, read through the option file activation just wrote. */
  probeActive: () => Promise<void>
  run?: MariaDbCommandRunner
  now?: () => Date
}
const secret = (path: string, content: string): RenderedFile => ({ path, content, mode: 0o600, owner: 'root', group: 'root' })
export const publicProfiles = (index: DbProfileIndex) => ({ active: index.active, profiles: index.profiles })

export interface DbProfilesService {
  read(): Promise<ReturnType<typeof publicProfiles>>
  save(input: DbProfileInput): Promise<ReturnType<typeof publicProfiles>>
  validate(name: string): Promise<ReturnType<typeof publicProfiles>>
  activate(name: string): Promise<ReturnType<typeof publicProfiles>>
  remove(name: string): Promise<ReturnType<typeof publicProfiles>>
}
export function createDbProfiles(deps: DbProfilesDeps): DbProfilesService {
  const now = deps.now ?? (() => new Date()), run = deps.run ?? defaultCommandRunner
  let queue: Promise<unknown> = Promise.resolve()
  // One writer: a second change waits for the first, including its rollback.
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => undefined); return next }
  const load = async (): Promise<DbProfileIndex> => parseDbProfileIndex(await deps.host.readFile(DB_PROFILE_INDEX)) ?? fail('PRECONDITION_FAILED', 'the saved database profiles are invalid', { ...unchanged, reason: 'profiles_invalid' })
  const store = (index: DbProfileIndex): Promise<void> => deps.host.writeFile(secret(DB_PROFILE_INDEX, JSON.stringify(index, null, 2) + '\n'))
  const profileOf = (index: DbProfileIndex, name: string): DbProfile => index.profiles.find(item => item.name === name) ?? fail('NOT_FOUND', 'the profile is not saved', unchanged)
  const checked = async (index: DbProfileIndex, name: string): Promise<DbProfileValidation> => {
    const profile = profileOf(index, name), validation = await validateDbProfile(profile, run, now)
    await store({ ...index, profiles: index.profiles.map(item => item.name === name ? { ...item, validation } : item) })
    return validation
  }
  return {
    read: async () => publicProfiles(await load()),
    save: input => serial(async () => {
      const index = await load(), held = index.profiles.find(item => item.name === input.name), path = dbProfileOptionFile(input.name)
      if (!held && index.profiles.length >= MAX_PROFILES) return invalid(`at most ${MAX_PROFILES} profiles can be saved`)
      if (index.active === input.name) return fail('CONFLICT', 'the active profile cannot change; activate another first', { ...unchanged, reason: 'IN_USE' })
      const passwordLine = input.password !== null ? dbProfilePasswordLine(input.password) : savedPasswordLine(await deps.host.readFile(path))
      if (!passwordLine) return invalid('a new profile needs a password')
      if (input.ca === null && await deps.host.readFile(dbProfileCaFile(input.name)) === null) return invalid('a new profile needs the CA certificate of the server')
      if (input.ca !== null) await deps.host.writeFile(secret(dbProfileCaFile(input.name), input.ca))
      await deps.host.writeFile(secret(path, renderDbProfileOptions(input, passwordLine)))
      const at = now().toISOString(), { password: _password, ca: _ca, ...fields } = input
      const next = { ...index, profiles: [...index.profiles.filter(item => item.name !== input.name), { ...fields, validation: null, createdAt: held?.createdAt ?? at, updatedAt: at }].sort((left, right) => left.name.localeCompare(right.name)) }
      await store(next)
      return publicProfiles(next)
    }),
    validate: name => serial(async () => { const index = await load(); await checked(index, name); return publicProfiles(await load()) }),
    activate: name => serial(async () => {
      const index = await load()
      if (name === index.active) return publicProfiles(index)
      if (name !== DB_LOCAL_PROFILE) profileOf(index, name)
      const saved = await deps.savedDatabases()
      if (saved > 0) return fail('CONFLICT', 'databases are saved on the active server; switching never migrates them, so it is refused while they exist', { ...unchanged, reason: 'PROFILE_HAS_DATABASES', saved })
      if (name !== DB_LOCAL_PROFILE) {
        const validation = await checked(index, name)
        if (validation.state !== 'passed') return fail('PRECONDITION_FAILED', 'the profile did not pass validation; the previous profile stays active', { ...unchanged, reason: 'PROFILE_INVALID', failure: validation.reason })
      }
      const previous = await deps.host.readFile(DEFAULT_MARIADB_ADMIN_CNF)
      if (index.active === DB_LOCAL_PROFILE && previous !== null) await deps.host.writeFile(secret(dbProfileOptionFile(DB_LOCAL_PROFILE), previous))
      const content = await deps.host.readFile(dbProfileOptionFile(name))
      if (content === null) return fail('PRECONDITION_FAILED', 'the credentials of that profile are missing', { ...unchanged, reason: 'PROFILE_INVALID', failure: 'failed' })
      const restore = async (): Promise<boolean> => { if (previous === null) return false; try { await deps.host.writeFile(secret(DEFAULT_MARIADB_ADMIN_CNF, previous)); return true } catch { return false } }
      try {
        await deps.host.writeFile(secret(DEFAULT_MARIADB_ADMIN_CNF, content))
        await deps.probeActive()
        const fresh = await load(), next = { ...fresh, active: name }
        await store(next)
        return publicProfiles(next)
      } catch {
        const restored = await restore()
        return fail('SERVICE_UNAVAILABLE', restored ? 'the new server could not be confirmed and the previous profile was restored' : 'the active database server is unknown and requires review', { stateChanged: !restored, rolledBack: restored, verificationRequired: !restored, unknownOutcome: !restored })
      }
    }),
    remove: name => serial(async () => {
      const index = await load()
      if (name === DB_LOCAL_PROFILE) return fail('CONFLICT', 'the local profile cannot be deleted', { ...unchanged, reason: 'IN_USE' })
      profileOf(index, name)
      if (index.active === name) return fail('CONFLICT', 'the active profile cannot be deleted', { ...unchanged, reason: 'IN_USE' })
      await deps.host.removePath(dbProfileOptionFile(name))
      await deps.host.removePath(dbProfileCaFile(name))
      const next = { ...index, profiles: index.profiles.filter(item => item.name !== name) }
      await store(next)
      return publicProfiles(next)
    }),
  }
}

/** Where a database user connects from under the active remote profile, as that server saw this panel. Null for the local server. */
export async function readDbClientHost(read: (path: string) => Promise<string | null>): Promise<string | null> {
  const index = parseDbProfileIndex(await read(DB_PROFILE_INDEX).catch(() => null))
  return index?.profiles.find(item => item.name === index.active)?.validation?.clientHost ?? null
}
/** These tools act on the MariaDB of this host; under a remote profile they would change the wrong server. */
export async function assertLocalDatabaseServer(client: { isRemote?: () => Promise<boolean> } | null | undefined): Promise<void> {
  if (await client?.isRemote?.()) fail('PRECONDITION_FAILED', 'this tool works on the local MariaDB server, and a remote profile is active', { ...unchanged, reason: 'remote_profile_active' })
}

export interface DbProfilesRouteContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  service: DbProfilesService | null
  audit: (entry: { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }) => Promise<unknown>
}
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const ACTIONS = ['save', 'validate', 'activate', 'delete'] as const
/** Root-only. The body of `save` is the one place a password crosses the socket; it goes straight into the option file. */
export async function handleDbProfilesRoute(req: Request, url: URL, method: string, ctx: DbProfilesRouteContext): Promise<Response | null> {
  if (url.pathname !== '/host/db-profiles' && !url.pathname.startsWith('/host/db-profiles/')) return null
  const verb = url.pathname.slice('/host/db-profiles/'.length) as typeof ACTIONS[number]
  const read = url.pathname === '/host/db-profiles'
  if (!read && !ACTIONS.includes(verb)) return null
  const { actor } = await ctx.assertRoot(read ? 'host.db_profiles.read' : 'host.db_profiles.' + verb)
  if (method !== (read ? 'GET' : 'POST')) return new Response(null, { status: 405, headers: { allow: read ? 'GET' : 'POST' } })
  if (url.search) return invalid('database profiles accept no selectors')
  if (!ctx.service) return fail('PRECONDITION_FAILED', 'database profiles need the native Linux host agent', { ...unchanged, reason: 'host_agent_unavailable' })
  if (read) return json(await ctx.service.read())
  const text = await req.text()
  let body: unknown
  try { body = text.length <= 16 * 1024 ? JSON.parse(text) : null } catch { body = null }
  if (verb === 'save') {
    const input = parseDbProfileInput(body), result = await ctx.service.save(input)
    await ctx.audit({ actor, action: 'host.db_profiles.saved', target: 'db-profile:' + input.name, outcome: 'ok', detail: { host: input.host, port: input.port, passwordChanged: input.password !== null, certificateChanged: input.ca !== null } }).catch(() => undefined)
    return json(result)
  }
  if (!object(body) || Object.keys(body).join() !== 'name' || typeof body.name !== 'string' || !DB_PROFILE_NAME.test(body.name)) return invalid('only the profile name is accepted')
  const name = body.name, target = 'db-profile:' + name
  if (verb === 'validate') return json(await ctx.service.validate(name))
  if (verb === 'delete') { const result = await ctx.service.remove(name); await ctx.audit({ actor, action: 'host.db_profiles.deleted', target, outcome: 'ok', detail: {} }).catch(() => undefined); return json(result) }
  try {
    const result = await ctx.service.activate(name)
    await ctx.audit({ actor, action: 'host.db_profiles.activated', target, outcome: 'ok', detail: {} }).catch(() => undefined)
    return json(result)
  } catch (error) {
    await ctx.audit({ actor, action: 'host.db_profiles.activated', target, outcome: 'failed', detail: { reason: (error as { detail?: { reason?: unknown } }).detail?.reason ?? null } }).catch(() => undefined)
    throw error
  }
}
