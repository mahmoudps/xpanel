import { fail } from '@xpanel/core'
import { REDIS_BACKUP_DIR, dbBackupDirArgv, dbBackupRemoveArgv, isRedisBackupName, isRedisDataFile, redisBackupCopyArgv, redisRestoreCopyArgv } from '../../../packages/os/src/db-services-command.ts'
import { redisConfigPaths } from './db-engines.ts'
import type { RedisConfigFacts } from './db-engines.ts'
import { assertServicePort, controlUnit, engineFacts, exactBody, hideSecrets, redisPassword, requireOk, requireUnit, restoreSecrets, revisionOf, setRedisDirectives, withFileRollback } from './db-service-files.ts'
import type { DbServiceContext } from './db-service-files.ts'
import { RedisReplyError } from './redis-client.ts'
import type { RedisClient, RedisTarget, RespValue } from './redis-client.ts'

/** The server-wide Redis or Valkey daemon: service, settings, keys and RDB backups. The per-account cache units stay on their own page. */
const unchanged = { stateChanged: false }
const POLICIES = ['noeviction', 'allkeys-lru', 'allkeys-lfu', 'allkeys-random', 'volatile-lru', 'volatile-lfu', 'volatile-random', 'volatile-ttl']
const PASSWORD = /^[A-Za-z0-9!#$%&()*+,./:;<=>?@[\]^_{}~-]{12,128}$/
const KEY_PAGE = 100, MAX_VALUE = 512 * 1024, PREVIEW = 256

const targetOf = (facts: RedisConfigFacts | null): RedisTarget => facts?.port === 0 && facts.unixSocket ? { path: facts.unixSocket } : { host: '127.0.0.1', port: facts?.port ?? 6379 }
export interface RedisFile { path: string; text: string; packageName: string; packageVersion: string; facts: RedisConfigFacts | null; unit: string | null }
export async function redisFile(ctx: DbServiceContext): Promise<RedisFile> {
  const view = await engineFacts(ctx), product = view.products.redis
  if (!product.installed || !product.package || !ctx.family) return fail('PRECONDITION_FAILED', 'Redis is not installed on this server', { ...unchanged, reason: 'redis_not_installed' })
  const paths = redisConfigPaths(ctx.family, product.package.name)
  for (const path of paths) {
    const text = await ctx.host.readFile(path).catch(() => null)
    if (text !== null) return { path, text, packageName: product.package.name, packageVersion: product.package.version, facts: view.redisConfig?.facts ?? null, unit: typeof product.service === 'object' ? product.service?.unit ?? null : null }
  }
  return fail('PRECONDITION_FAILED', 'the Redis configuration file could not be read', { ...unchanged, reason: 'redis_config_unread' })
}
const client = (ctx: DbServiceContext, file: Pick<RedisFile, 'facts' | 'text'>): Promise<RedisClient> => ctx.connectRedis(targetOf(file.facts), redisPassword(file.text))
export async function withRedis<T>(ctx: DbServiceContext, file: RedisFile, work: (redis: RedisClient) => Promise<T>): Promise<T> {
  let redis: RedisClient
  try { redis = await client(ctx, file) } catch (error) {
    if (error instanceof RedisReplyError) return fail('PRECONDITION_FAILED', 'Redis refused the saved password', { ...unchanged, reason: 'redis_auth_refused' })
    return fail('PRECONDITION_FAILED', 'Redis must be running for this', { ...unchanged, reason: 'redis_not_running' })
  }
  try { return await work(redis) }
  catch (error) {
    if (error instanceof RedisReplyError) return fail('PRECONDITION_FAILED', 'Redis refused the command', { ...unchanged, reason: 'redis_command_refused' })
    throw error
  } finally { redis.close() }
}
export const pingAfterRestart = async (ctx: DbServiceContext, candidate: string, facts: RedisConfigFacts | null): Promise<boolean> => {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { const redis = await client(ctx, { text: candidate, facts }); try { return await redis.command('PING') === 'PONG' } finally { redis.close() } }
    catch (error) { if (error instanceof RedisReplyError) return false; await ctx.sleep(250) }
  }
  return false
}
const infoField = (info: string, key: string): string | null => new RegExp(`^${key}:(.*)$`, 'm').exec(info)?.[1]?.trim() ?? null

export async function readRedisView(ctx: DbServiceContext) {
  const view = await engineFacts(ctx), product = view.products.redis, facts = view.redisConfig?.facts ?? null
  let runtime: Record<string, unknown> = { state: 'not-read' }
  let configured = false
  if (product.installed && typeof product.service === 'object' && product.service?.active === 'active' && view.redisConfig?.path) {
    try {
      const text = (await ctx.host.readFile(view.redisConfig.path)) ?? ''
      configured = redisPassword(text) !== null
      const redis = await client(ctx, { text, facts })
      try {
        const info = String(await redis.command('INFO')), setting = async (name: string): Promise<RespValue> => (await redis.command('CONFIG', 'GET', name) as RespValue[])[1] ?? null, databases = await setting('databases')
        runtime = { state: 'read', version: infoField(info, 'redis_version') ?? infoField(info, 'valkey_version'), usedMemory: Number(infoField(info, 'used_memory') ?? 0), connectedClients: Number(infoField(info, 'connected_clients') ?? 0), databases: Number(databases ?? 16), maxclients: Number(await setting('maxclients')) || null, snapshots: String(await setting('save') ?? '') !== '',
          keyspace: [...info.matchAll(/^db([0-9]{1,4}):keys=([0-9]+),expires=([0-9]+)/gm)].map(match => ({ db: Number(match[1]), keys: Number(match[2]), expires: Number(match[3]) })) }
      } finally { redis.close() }
    } catch (error) { runtime = { state: error instanceof RedisReplyError ? 'auth-refused' : 'unreachable' } }
  }
  const backups = (await ctx.fs.list(REDIS_BACKUP_DIR)).filter(row => isRedisBackupName(row.name))
  return { engine: 'redis', observedAt: view.observedAt, installed: product.installed, package: product.package, service: product.service, config: view.redisConfig, runtime, passwordConfigured: configured, backups }
}

export async function readRedisConfig(ctx: DbServiceContext) {
  const file = await redisFile(ctx), text = hideSecrets('redis', file.text)
  return { path: file.path, text, revision: revisionOf(text) }
}
async function saveRedisFile(ctx: DbServiceContext, file: RedisFile, candidate: string, reason: string, facts: RedisConfigFacts | null = file.facts): Promise<void> {
  const info = await ctx.fs.stat(file.path)
  if (!info || !file.unit) return fail('PRECONDITION_FAILED', 'the Redis service could not be observed', { ...unchanged, reason: 'redis_service_unread' })
  await ctx.assertFresh()
  await withFileRollback({ host: ctx.host, fs: ctx.fs, path: file.path, reason,
    change: async () => { await ctx.host.writeFile({ path: file.path, content: candidate, mode: info.mode, owner: String(info.uid), group: String(info.gid) }) },
    activate: async () => requireOk(ctx, 'restart', file.unit!),
    verify: () => pingAfterRestart(ctx, candidate, facts),
    verifyRestored: () => pingAfterRestart(ctx, file.text, file.facts) })
}
export async function saveRedisConfig(ctx: DbServiceContext, body: unknown) {
  const input = exactBody(body, ['text', 'expectedRevision']), text = input.text
  if (typeof text !== 'string' || text.length === 0 || text.length > 256 * 1024 || text.includes('\0')) return fail('VALIDATION', 'the configuration text is not accepted', unchanged)
  const file = await redisFile(ctx)
  if (input.expectedRevision !== revisionOf(hideSecrets('redis', file.text))) return fail('CONFLICT', 'the configuration changed since it was read', { ...unchanged, reason: 'config_changed' })
  const candidate = restoreSecrets('redis', text, file.text)
  await saveRedisFile(ctx, file, candidate, 'redis_config')
  return { saved: true }
}

export async function saveRedisSettings(ctx: DbServiceContext, body: unknown) {
  const input = exactBody(body, ['port', 'maxmemoryMb', 'maxclients', 'maxmemoryPolicy', 'persistence', 'remoteAccess'])
  const port = assertServicePort(input.port, 'port'), { maxmemoryMb, maxclients, maxmemoryPolicy, persistence, remoteAccess } = input
  if (!Number.isInteger(maxmemoryMb) || (maxmemoryMb as number) < 0 || (maxmemoryMb as number) > 1048576 || !Number.isInteger(maxclients) || (maxclients as number) < 1 || (maxclients as number) > 100000 || !POLICIES.includes(String(maxmemoryPolicy)) || !['none', 'rdb', 'aof'].includes(String(persistence)) || typeof remoteAccess !== 'boolean') return fail('VALIDATION', 'the Redis settings are not accepted', unchanged)
  const file = await redisFile(ctx)
  if (remoteAccess && redisPassword(file.text) === null) return fail('PRECONDITION_FAILED', 'set a password before opening Redis to remote clients', { ...unchanged, reason: 'redis_remote_requires_password' })
  const candidate = setRedisDirectives(file.text, { port: [String(port)], bind: [remoteAccess ? '0.0.0.0' : '127.0.0.1 ::1'], 'protected-mode': ['yes'], maxmemory: [`${maxmemoryMb}mb`], maxclients: [String(maxclients)], 'maxmemory-policy': [String(maxmemoryPolicy)],
    appendonly: [persistence === 'aof' ? 'yes' : 'no'], save: persistence === 'none' ? ['""'] : ['3600 1', '300 100', '60 10000'] })
  await saveRedisFile(ctx, file, candidate, 'redis_settings', { ...file.facts!, port, unixSocket: file.facts?.unixSocket ?? null })
  return { saved: true }
}
export async function setRedisPassword(ctx: DbServiceContext, body: unknown) {
  const { password } = exactBody(body, ['password'])
  if (password !== null && (typeof password !== 'string' || !PASSWORD.test(password))) return fail('VALIDATION', 'use 12 to 128 letters, digits or symbols, without spaces, quotes or backslashes', { ...unchanged, reason: 'redis_password_rejected' })
  const file = await redisFile(ctx)
  if (password === null && file.facts?.bind?.some(address => !/^-?(?:127\.0\.0\.1|::1)$/.test(address))) return fail('PRECONDITION_FAILED', 'close remote access before removing the password', { ...unchanged, reason: 'redis_remote_requires_password' })
  await saveRedisFile(ctx, file, setRedisDirectives(file.text, { requirepass: password === null ? [] : [password] }), 'redis_password')
  // The acceptance of the tool: a fresh connection without the password is refused.
  if (password !== null && file.facts) {
    const refused = await ctx.connectRedis(targetOf(file.facts), null).then(async redis => { try { await redis.command('GET', 'xpanel:probe'); return false } catch (error) { return error instanceof RedisReplyError } finally { redis.close() } }, () => false)
    if (!refused) return fail('SERVICE_UNAVAILABLE', 'the server still answers without the password', { stateChanged: true, verificationRequired: true, reason: 'redis_password_not_enforced' })
  }
  return { saved: true, passwordConfigured: password !== null }
}

const database = (value: unknown): number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255 ? value as number : fail('VALIDATION', 'the database number is not accepted', unchanged)
const keyName = (value: unknown): string => typeof value === 'string' && value.length >= 1 && value.length <= 1024 && value.isWellFormed() && !value.includes('\0') ? value : fail('VALIDATION', 'the key name is not accepted', unchanged)
const LENGTH: Readonly<Record<string, string>> = { string: 'STRLEN', list: 'LLEN', set: 'SCARD', zset: 'ZCARD', hash: 'HLEN', stream: 'XLEN' }
export interface RedisKeyRow { key: string | null; type: string; length: number | null; ttlSeconds: number | null; value: string | null; truncated: boolean }
export async function listRedisKeys(ctx: DbServiceContext, body: unknown) {
  const input = exactBody(body, ['db', 'cursor', 'match']), db = database(input.db), cursor = input.cursor, match = input.match
  if (typeof cursor !== 'string' || !/^[0-9]{1,20}$/.test(cursor) || typeof match !== 'string' || match.length > 256 || !match.isWellFormed() || match.includes('\0')) return fail('VALIDATION', 'the key filter is not accepted', unchanged)
  return withRedis(ctx, await redisFile(ctx), async redis => {
    await redis.command('SELECT', String(db))
    const [next, names] = await redis.command('SCAN', cursor, 'COUNT', String(KEY_PAGE), ...(match ? ['MATCH', match] : [])) as [string, RespValue[]]
    const keys: RedisKeyRow[] = []
    for (const name of names.slice(0, KEY_PAGE)) {
      // A key that is not UTF-8 text is listed as binary and reached only by clearing its database.
      if (typeof name !== 'string') { keys.push({ key: null, type: 'binary', length: null, ttlSeconds: null, value: null, truncated: false }); continue }
      const type = String(await redis.command('TYPE', name)), ttl = Number(await redis.command('TTL', name)), length = LENGTH[type] ? Number(await redis.command(LENGTH[type]!, name)) : null
      const raw = type === 'string' && (length ?? 0) <= MAX_VALUE ? await redis.command('GET', name) : null, text = typeof raw === 'string' ? raw : null
      keys.push({ key: name, type, length, ttlSeconds: ttl >= 0 ? ttl : null, value: text?.slice(0, PREVIEW) ?? null, truncated: (text?.length ?? 0) > PREVIEW })
    }
    return { db, cursor: next, keys }
  })
}
export async function setRedisKey(ctx: DbServiceContext, body: unknown) {
  const input = exactBody(body, ['db', 'key', 'value', 'ttlSeconds']), db = database(input.db), key = keyName(input.key), { value, ttlSeconds } = input
  if (typeof value !== 'string' || value.length > MAX_VALUE || value.includes('\0') || ttlSeconds !== null && (!Number.isInteger(ttlSeconds) || (ttlSeconds as number) < 1 || (ttlSeconds as number) > 315360000)) return fail('VALIDATION', 'the key value or time to live is not accepted', unchanged)
  return withRedis(ctx, await redisFile(ctx), async redis => {
    await ctx.assertFresh()
    await redis.command('SELECT', String(db))
    await redis.command('SET', key, value, ...(ttlSeconds === null ? [] : ['EX', String(ttlSeconds)]))
    return { db, key, saved: true }
  })
}
export async function deleteRedisKey(ctx: DbServiceContext, body: unknown) {
  const input = exactBody(body, ['db', 'key']), db = database(input.db), key = keyName(input.key)
  return withRedis(ctx, await redisFile(ctx), async redis => {
    await ctx.assertFresh()
    await redis.command('SELECT', String(db))
    return { db, key, removed: Number(await redis.command('DEL', key)) }
  })
}
export async function flushRedis(ctx: DbServiceContext, body: unknown) {
  const input = exactBody(body, ['db', 'confirmation'])
  if (input.db !== null) database(input.db)
  if (input.confirmation !== (input.db === null ? 'all' : String(input.db))) return fail('VALIDATION', 'the confirmation does not match', { ...unchanged, reason: 'confirmation_required' })
  return withRedis(ctx, await redisFile(ctx), async redis => {
    await ctx.assertFresh()
    if (input.db === null) await redis.command('FLUSHALL')
    else { await redis.command('SELECT', String(input.db)); await redis.command('FLUSHDB') }
    return { flushed: input.db }
  })
}

export async function redisDataFile(redis: RedisClient): Promise<string> {
  const dir = (await redis.command('CONFIG', 'GET', 'dir') as RespValue[])[1], name = (await redis.command('CONFIG', 'GET', 'dbfilename') as RespValue[])[1], path = `${dir}/${name}`
  return isRedisDataFile(path) ? path : fail('PRECONDITION_FAILED', 'the Redis data file is outside the reviewed paths', { ...unchanged, reason: 'redis_data_path_unsupported' })
}
const stampOf = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace(/\.[0-9]{3}Z$/, 'Z')
export async function backupRedis(ctx: DbServiceContext) {
  return withRedis(ctx, await redisFile(ctx), async redis => {
    const source = await redisDataFile(redis), before = await redis.command('LASTSAVE')
    await ctx.assertFresh()
    await redis.command('BGSAVE')
    for (let attempt = 0; attempt < 120 && await redis.command('LASTSAVE') === before; attempt++) await ctx.sleep(500)
    if (await redis.command('LASTSAVE') === before) return fail('SERVICE_UNAVAILABLE', 'the background save did not finish in time', { stateChanged: true, verificationRequired: true, reason: 'redis_backup_timeout' })
    const name = `redis-${stampOf(ctx.now())}.rdb`
    await requireCommand(ctx, dbBackupDirArgv(REDIS_BACKUP_DIR))
    await requireCommand(ctx, redisBackupCopyArgv(source, name))
    const row = (await ctx.fs.list(REDIS_BACKUP_DIR)).find(entry => entry.name === name)
    return row ?? fail('SERVICE_UNAVAILABLE', 'the backup file could not be confirmed', { stateChanged: true, verificationRequired: true, reason: 'redis_backup_unverified' })
  })
}
const requireCommand = async (ctx: DbServiceContext, argv: string[]): Promise<void> => {
  const result = await ctx.run(argv)
  if (!result.ok) return fail('CONFIG_TEST_FAILED', 'the host refused the backup step', { stateChanged: false, reason: 'database_backup_step_failed' })
}
export async function restoreRedis(ctx: DbServiceContext, body: unknown) {
  const { name } = exactBody(body, ['name'])
  if (!isRedisBackupName(name)) return fail('VALIDATION', 'the backup name is not accepted', unchanged)
  const file = await redisFile(ctx)
  if (!(await ctx.fs.list(REDIS_BACKUP_DIR)).some(row => row.name === name)) return fail('NOT_FOUND', 'this backup is not on the server', { ...unchanged, reason: 'database_backup_missing' })
  if (file.facts?.appendOnly === 'yes') return fail('PRECONDITION_FAILED', 'Redis loads the append-only file first; switch persistence to snapshots before restoring', { ...unchanged, reason: 'redis_restore_requires_rdb' })
  const target = await withRedis(ctx, file, redisDataFile), unit = requireUnit(file.unit, 'redis')
  await ctx.assertFresh()
  await requireOk(ctx, 'stop', unit)
  const copied = await ctx.run(redisRestoreCopyArgv(name, target, file.packageName.startsWith('valkey') ? 'valkey' : 'redis'))
  await requireOk(ctx, 'start', unit)
  if (!copied.ok) return fail('CONFIG_TEST_FAILED', 'the backup could not be copied; Redis started with its previous data', { stateChanged: false, reason: 'redis_restore_copy_failed' })
  if (!await pingAfterRestart(ctx, file.text, file.facts)) return fail('SERVICE_UNAVAILABLE', 'Redis did not answer after the restore', { stateChanged: true, verificationRequired: true, reason: 'redis_restore_unverified' })
  return { restored: name }
}
export async function deleteRedisBackup(ctx: DbServiceContext, body: unknown) {
  const { name } = exactBody(body, ['name'])
  if (!isRedisBackupName(name)) return fail('VALIDATION', 'the backup name is not accepted', unchanged)
  await ctx.assertFresh()
  await requireCommand(ctx, dbBackupRemoveArgv('redis', name))
  return { removed: name }
}
export const controlRedis = async (ctx: DbServiceContext, body: unknown) => controlUnit(ctx, (await redisFile(ctx)).unit, 'redis', body)
