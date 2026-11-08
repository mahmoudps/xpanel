import { fail } from '@xpanel/core'
import type { DbFamily, DbReadFile, DbRun } from './db-engines.ts'
import { importMongodbArchive, backupMongodb, controlMongodb, createMongodbDatabase, deleteMongodbBackup, deleteMongodbDatabases, readMongodbConfig, readMongodbLog, readMongodbView, restoreMongodb, saveMongodbConfig, saveMongodbSettings, setMongodbAuth, setMongodbUserPassword } from './db-mongodb-service.ts'
import { controlPostgresql, readPostgresqlFile, readPostgresqlLog, readPostgresqlView, savePostgresqlFile, savePostgresqlSettings } from './db-postgresql-service.ts'
import { backupRedis, controlRedis, deleteRedisBackup, deleteRedisKey, flushRedis, listRedisKeys, readRedisConfig, readRedisView, restoreRedis, saveRedisConfig, saveRedisSettings, setRedisKey, setRedisPassword } from './db-redis-service.ts'
import { nodeDbServiceFs } from './db-service-files.ts'
import { movePostgresqlData, readPostgresqlVersions, readRedisVersions, switchPostgresqlVersion, switchRedisVersion } from './db-service-jobs.ts'
import type { DbServiceContext, DbServiceFs, DbServiceHost } from './db-service-files.ts'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { connectMongo } from './mongo-client.ts'
import { connectRedis } from './redis-client.ts'

/** Root routes of the optional database daemons. Every change re-checks root authority right before its first effect. */
export interface DbServiceRouteDeps {
  assertRoot(action: string): Promise<{ actor: string }>
  family: DbFamily | null
  run: DbRun | null
  readFile: DbReadFile | null
  host: DbServiceHost | null
  runPostgresql: ((statements: string[]) => Promise<void>) | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  stateRoot: string
  fs?: DbServiceFs
  connectRedis?: DbServiceContext['connectRedis']
  connectMongo?: DbServiceContext['connectMongo']
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}
const unchanged = { stateChanged: false }
type Op = (ctx: DbServiceContext, body: unknown) => Promise<unknown>
const READS: Readonly<Record<string, Readonly<Record<string, (ctx: DbServiceContext) => Promise<unknown>>>>> = {
  redis: { '': readRedisView, config: readRedisConfig, versions: readRedisVersions },
  mongodb: { '': readMongodbView, config: readMongodbConfig, log: readMongodbLog },
  postgresql: { '': readPostgresqlView, config: ctx => readPostgresqlFile(ctx, 'config'), hba: ctx => readPostgresqlFile(ctx, 'hba'), log: readPostgresqlLog, versions: readPostgresqlVersions },
}
const WRITES: Readonly<Record<string, Readonly<Record<string, Op>>>> = {
  redis: { control: controlRedis, settings: saveRedisSettings, config: saveRedisConfig, password: setRedisPassword, keys: listRedisKeys, key: setRedisKey, 'key-delete': deleteRedisKey, flush: flushRedis, backup: ctx => backupRedis(ctx), restore: restoreRedis, 'backup-delete': deleteRedisBackup, version: switchRedisVersion },
  mongodb: { control: controlMongodb, settings: saveMongodbSettings, config: saveMongodbConfig, auth: setMongodbAuth, database: createMongodbDatabase, 'database-delete': deleteMongodbDatabases, 'user-password': setMongodbUserPassword, backup: backupMongodb, restore: restoreMongodb, 'backup-delete': deleteMongodbBackup, import: importMongodbArchive },
  postgresql: { control: controlPostgresql, settings: savePostgresqlSettings, config: (ctx, body) => savePostgresqlFile(ctx, 'config', body), hba: (ctx, body) => savePostgresqlFile(ctx, 'hba', body), version: switchPostgresqlVersion, 'data-directory': movePostgresqlData },
}
const ROUTE = /^\/host\/databases\/services\/(redis|mongodb|postgresql)(?:\/([a-z-]{1,24}))?$/
const MAX_BODY = 512 * 1024
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export async function handleDbServicesRoute(req: Request, url: URL, method: string, deps: DbServiceRouteDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const engine = match[1]!, op = match[2] ?? '', read = READS[engine]![op], write = WRITES[engine]![op]
  if (!read && !write) return new Response(null, { status: 404 })
  if (method === 'GET' ? !read : method === 'POST' ? !write : true) return new Response(null, { status: 405, headers: { allow: [read ? 'GET' : '', write ? 'POST' : ''].filter(Boolean).join(', ') } })
  if (url.search) return fail('VALIDATION', 'database services do not accept selectors', unchanged)
  const action = `host.databases.services.${engine}`, first = await deps.assertRoot(action)
  const assertFresh = async (): Promise<string> => { const current = await deps.assertRoot(action); return current.actor === first.actor ? current.actor : fail('FORBIDDEN', 'database service authority changed', unchanged) }
  if (!deps.run || !deps.host) return fail('PRECONDITION_FAILED', 'database services need a native host', { ...unchanged, reason: 'native_host_required' })
  const ctx: DbServiceContext = { family: deps.family, run: deps.run, readFile: deps.readFile, host: deps.host, fs: deps.fs ?? nodeDbServiceFs, runPostgresql: deps.runPostgresql, submitJob: deps.submitJob, stateRoot: deps.stateRoot,
    connectRedis: deps.connectRedis ?? connectRedis, connectMongo: deps.connectMongo ?? connectMongo, sleep: deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))), now: deps.now ?? (() => new Date()), assertFresh }
  if (method === 'GET') return json(await read!(ctx))
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const raw = await req.text()
  let body: unknown
  try { if (raw.length > MAX_BODY) throw new Error('too_large'); body = JSON.parse(raw) } catch { return fail('VALIDATION', 'the request is not bounded JSON', unchanged) }
  const reply = await write!(ctx, body)
  return json(reply, reply && typeof reply === 'object' && 'job' in reply ? 202 : 200)
}
