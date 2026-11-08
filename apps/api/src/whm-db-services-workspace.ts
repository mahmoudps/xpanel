import { fail, isXpanelError } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import { sha512Crypt } from '../../agent/src/directory-privacy.ts'
import { parseDbQuotas } from '../../agent/src/db-quota.ts'
import { PMA_ACCESS_DEFAULTS, parsePhpMyAdminAccess } from '../../agent/src/phpmyadmin-access.ts'
import type { PhpMyAdminAccess } from '../../agent/src/phpmyadmin-access.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { panelConfigFile, panelConfigRevision, readPanelConfigBody } from './panel-config-file.ts'
import { assertPasswordAllowed } from './password-policy.ts'
import { startMongodbUpload, storeMongodbChunk } from './whm-mongodb-import.ts'

/** WHM routes of the optional database daemons, database size limits and phpMyAdmin access. The agent owns every host effect. */
export interface WhmDbServicesHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: StateStore
  callHost(caller: AuthenticatedCaller, path: string, body: unknown): Promise<unknown>
  readHost(caller: AuthenticatedCaller, path: string): Promise<unknown>
  triggerReconcile(caller: AuthenticatedCaller): Promise<{ ok: boolean; status: number; body: Record<string, unknown> } | null>
}
const unchanged = { stateChanged: false }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const ROUTE = /^\/api\/server\/databases\/services\/(redis|mongodb|postgresql)(?:\/([a-z-]{1,24}))?$/
/** Read routes, and the audit action of each change. A key page is a read that needs a body; its values never reach the audit log. */
const READS: Readonly<Record<string, readonly string[]>> = { redis: ['', 'config', 'versions'], mongodb: ['', 'config', 'log'], postgresql: ['', 'config', 'hba', 'log', 'versions'] }
const SHARED: Readonly<Record<string, string>> = { control: 'server.databases.service_control', settings: 'server.databases.service_settings', config: 'server.databases.service_config' }
const WRITES: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  redis: { ...SHARED, password: 'server.databases.service_password', keys: null, key: 'server.databases.redis_key_saved', 'key-delete': 'server.databases.redis_key_deleted', flush: 'server.databases.redis_flushed', backup: 'server.databases.service_backup', restore: 'server.databases.service_restore', 'backup-delete': 'server.databases.service_backup_deleted', version: 'server.databases.service_version' },
  mongodb: { ...SHARED, auth: 'server.databases.mongodb_auth', database: 'server.databases.mongodb_created', 'database-delete': 'server.databases.mongodb_deleted', 'user-password': 'server.databases.service_password', backup: 'server.databases.service_backup', restore: 'server.databases.service_restore', 'backup-delete': 'server.databases.service_backup_deleted' },
  postgresql: { ...SHARED, hba: 'server.databases.postgresql_client_auth', version: 'server.databases.service_version', 'data-directory': 'server.databases.postgresql_data_directory' },
}
const SAFE_DETAIL = ['action', 'db', 'name', 'names', 'database', 'enabled', 'version', 'major', 'target'] as const
const auditDetail = (engine: string, op: string, body: Record<string, unknown>): Record<string, unknown> => ({ engine, op, ...Object.fromEntries(SAFE_DETAIL.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]])) })

async function engineRoute(request: Request, method: string, match: RegExpExecArray, caller: AuthenticatedCaller, helpers: WhmDbServicesHelpers): Promise<Response> {
  const engine = match[1]!, op = match[2] ?? '', path = `/host/databases/services/${engine}${op ? '/' + op : ''}`, read = READS[engine]!.includes(op), audited = WRITES[engine]![op], write = audited !== undefined
  if (!read && !write) return new Response(null, { status: 404 })
  if (method === 'GET' ? !read : method === 'POST' ? !write : true) return new Response(null, { status: 405, headers: { allow: [read ? 'GET' : '', write ? 'POST' : ''].filter(Boolean).join(', ') } })
  if (method === 'GET') return json(await helpers.readHost(caller, path))
  const body = await readPanelConfigBody(request, 512 * 1024)
  if (typeof body.password === 'string') assertPasswordAllowed(body.password, 'database')
  const fresh = await helpers.requireCaller(request)
  await helpers.assertRoot(fresh, `server.databases.services.${engine}`)
  if (fresh.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'database administration authority changed', unchanged)
  const entry = { actor: caller.principal.username, target: `database-service:${engine}`, detail: auditDetail(engine, op, body), principalId: caller.principal.id }
  try {
    const reply = await helpers.callHost(fresh, path, body)
    if (audited) await Promise.resolve(helpers.emitAudit({ ...entry, action: audited, outcome: 'ok' })).catch(() => undefined)
    return json(reply)
  } catch (error) {
    if (audited && !(isXpanelError(error) && error.code === 'VALIDATION')) await Promise.resolve(helpers.emitAudit({ ...entry, action: audited, outcome: 'failed' })).catch(() => undefined)
    throw error
  }
}

const QUOTA_NAMESPACE = 'db-quotas:v1'
const quotaFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>) => panelConfigFile<{ limits: Record<string, number> }>(store, 'db-quotas.json', QUOTA_NAMESPACE, raw => { const limits = parseDbQuotas(raw); return limits ? { limits } : null }, () => ({ limits: {} }))
async function quota(request: Request, method: string, caller: AuthenticatedCaller, helpers: WhmDbServicesHelpers): Promise<Response> {
  const file = quotaFile(helpers.store)
  if (method === 'GET') { const { raw } = await file.read(); return json({ revision: panelConfigRevision(QUOTA_NAMESPACE, raw), ...(await helpers.readHost(caller, '/host/databases/quota') as object) }) }
  const body = await readPanelConfigBody(request)
  if (!exact(body, ['database', 'limitMb', 'expectedRevision']) || typeof body.database !== 'string' || typeof body.expectedRevision !== 'string' || body.limitMb !== null && (!Number.isInteger(body.limitMb) || (body.limitMb as number) < 1 || (body.limitMb as number) > 16_777_216)) return fail('VALIDATION', 'exactly database, limitMb and expectedRevision are required', unchanged)
  const known = (await helpers.store.readSnapshot()).databases.some(row => row.name === body.database && row.engine === 'mariadb' && row.trashedAt === null)
  if (!known) return fail('NOT_FOUND', 'this database is not saved for an account', { ...unchanged, reason: 'database_not_saved' })
  const { limits } = await file.current(), next = { ...limits }
  if (body.limitMb === null) delete next[body.database as string]; else next[body.database as string] = body.limitMb as number
  const saved = await file.write({ limits: next }, body.expectedRevision, async () => { await helpers.assertRoot(await helpers.requireCaller(request), 'server.databases.quota') })
  await Promise.resolve(helpers.emitAudit({ actor: caller.principal.username, action: 'server.databases.quota_updated', target: 'database:' + body.database, detail: { limitMb: body.limitMb }, outcome: 'ok', principalId: caller.principal.id })).catch(() => undefined)
  return json({ revision: panelConfigRevision(QUOTA_NAMESPACE, saved.raw), ...(await helpers.callHost(caller, '/host/databases/quota/enforce', {}) as object) })
}

const ACCESS_NAMESPACE = 'phpmyadmin-access:v1'
const accessFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>) => panelConfigFile<PhpMyAdminAccess>(store, 'phpmyadmin-access.json', ACCESS_NAMESPACE, parsePhpMyAdminAccess, () => PMA_ACCESS_DEFAULTS)
const accessView = (raw: unknown, value: PhpMyAdminAccess | null, host: unknown) => ({ revision: panelConfigRevision(ACCESS_NAMESPACE, raw), state: value ? 'read' : 'invalid', publicAccess: value?.publicAccess ?? false, httpPort: value?.httpPort ?? null, httpsPort: value?.httpsPort ?? null, phpVersion: value?.phpVersion ?? null, basicAuthUser: value?.basicAuth?.user ?? null, host })
const RESERVED_PORTS = [21, 22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995, 2078, 2079, 2080, 2082, 2083, 2086, 2087, 2095, 2096, 3306, 5432, 6379, 27017]
async function assertPort(value: unknown, allowed: readonly number[] | null, helpers: WhmDbServicesHelpers): Promise<number> {
  const settings = (await helpers.store.readSnapshot()).server?.settings
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535 || RESERVED_PORTS.includes(value as number) || settings && [settings.panelPort, settings.sshPort, settings.backendPort, settings.backendTlsPort].includes(value as number)) return fail('VALIDATION', 'choose a free port that no panel or mail service uses', { ...unchanged, reason: 'phpmyadmin_port_reserved' })
  if (allowed && !allowed.includes(value as number)) return fail('VALIDATION', 'on this system nginx may bind only the listed ports', { ...unchanged, reason: 'phpmyadmin_port_selinux', allowed })
  return value as number
}
async function phpMyAdminAccess(request: Request, method: string, caller: AuthenticatedCaller, helpers: WhmDbServicesHelpers): Promise<Response> {
  const file = accessFile(helpers.store), host = await helpers.readHost(caller, '/host/databases/phpmyadmin-access') as { installed?: unknown; phpVersions?: unknown; allowedPorts?: unknown }
  if (method === 'GET') { const { raw, value } = await file.read(); return json(accessView(raw, value, host)) }
  const body = await readPanelConfigBody(request)
  if (!exact(body, ['publicAccess', 'httpPort', 'httpsPort', 'phpVersion', 'basicAuthUser', 'basicAuthPassword', 'expectedRevision']) || typeof body.publicAccess !== 'boolean' || typeof body.expectedRevision !== 'string') return fail('VALIDATION', 'the phpMyAdmin access fields are required', unchanged)
  if (host.installed !== true) return fail('PRECONDITION_FAILED', 'phpMyAdmin is not installed on this server', { ...unchanged, reason: 'phpmyadmin_not_installed' })
  const allowed = Array.isArray(host.allowedPorts) ? host.allowedPorts as number[] : null
  const httpsPort = await assertPort(body.httpsPort, allowed, helpers), httpPort = body.httpPort === null ? null : await assertPort(body.httpPort, allowed, helpers)
  if (body.phpVersion !== null && !(Array.isArray(host.phpVersions) && host.phpVersions.includes(body.phpVersion))) return fail('VALIDATION', 'this PHP version has no PHP-FPM on the server', { ...unchanged, reason: 'phpmyadmin_php_missing' })
  const current = await file.current()
  let basicAuth = current.basicAuth
  if (body.basicAuthUser === null) basicAuth = null
  else {
    if (typeof body.basicAuthUser !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(body.basicAuthUser)) return fail('VALIDATION', 'the access user name is not accepted', { ...unchanged, reason: 'phpmyadmin_user_rejected' })
    if (typeof body.basicAuthPassword === 'string') { assertPasswordAllowed(body.basicAuthPassword, 'database'); basicAuth = { user: body.basicAuthUser, hash: sha512Crypt(body.basicAuthPassword) } }
    else if (body.basicAuthPassword !== null || !basicAuth) return fail('VALIDATION', 'a password is required for the access user', { ...unchanged, reason: 'phpmyadmin_password_required' })
    else basicAuth = { ...basicAuth, user: body.basicAuthUser }
  }
  const next = parsePhpMyAdminAccess({ publicAccess: body.publicAccess, httpPort, httpsPort, phpVersion: body.phpVersion, basicAuth }) ?? fail('VALIDATION', 'the phpMyAdmin access fields are not accepted', unchanged)
  const saved = await file.write(next, body.expectedRevision, async () => { await helpers.assertRoot(await helpers.requireCaller(request), 'server.databases.phpmyadmin_access') })
  const reconcile = await helpers.triggerReconcile(caller)
  await Promise.resolve(helpers.emitAudit({ actor: caller.principal.username, action: 'server.databases.phpmyadmin_access', target: 'phpmyadmin:access', detail: { publicAccess: next.publicAccess, httpPort, httpsPort, phpVersion: next.phpVersion, basicAuth: !!next.basicAuth }, outcome: reconcile && !reconcile.ok ? 'failed' : 'ok', principalId: caller.principal.id })).catch(() => undefined)
  return json({ ...accessView(saved.raw, saved.value, host), application: { status: reconcile === null ? 'not_requested' : reconcile.ok ? 'applied' : 'failed' } })
}

const IMPORT = '/api/server/databases/services/mongodb/import'
const IMPORT_CHUNK = /^\/api\/server\/databases\/services\/mongodb\/import\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
async function mongodbImport(request: Request, method: string, id: string | undefined, caller: AuthenticatedCaller, helpers: WhmDbServicesHelpers): Promise<Response> {
  const expected = id ? 'PUT' : 'POST'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (!id) return json(await startMongodbUpload(request, helpers.store))
  return json(await storeMongodbChunk(request, id, helpers.store, async upload => {
    const backup = await helpers.callHost(caller, '/host/databases/services/mongodb/import', { id: upload.id, filename: upload.filename })
    await Promise.resolve(helpers.emitAudit({ actor: caller.principal.username, action: 'server.databases.mongodb_imported', target: 'database-service:mongodb', detail: { bytes: upload.bytes }, outcome: 'ok', principalId: caller.principal.id })).catch(() => undefined)
    return backup
  }))
}

const SINGLE: Readonly<Record<string, string>> = { '/api/server/databases/quota': 'server.databases.quota', '/api/server/databases/phpmyadmin-access': 'server.databases.phpmyadmin_access' }
export async function handleWhmDbServicesRoute(request: Request, url: URL, method: string, helpers: WhmDbServicesHelpers): Promise<Response | null> {
  const chunk = IMPORT_CHUNK.exec(url.pathname)
  if (url.pathname === IMPORT || chunk) {
    const caller = await helpers.requireCaller(request)
    await helpers.assertRoot(caller, 'server.databases.services.mongodb')
    if (url.search) return fail('VALIDATION', 'database administration does not accept selectors', unchanged)
    return mongodbImport(request, method, chunk?.[1], caller, helpers)
  }
  const match = ROUTE.exec(url.pathname), target = match ? `server.databases.services.${match[1]}` : SINGLE[url.pathname]
  if (!target) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, target)
  if (url.search) return fail('VALIDATION', 'database administration does not accept selectors', unchanged)
  if (match) return engineRoute(request, method, match, caller, helpers)
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  return url.pathname === '/api/server/databases/quota' ? quota(request, method, caller, helpers) : phpMyAdminAccess(request, method, caller, helpers)
}
