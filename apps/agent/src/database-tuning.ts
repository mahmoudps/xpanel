import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { atomicWriteJson } from '@xpanel/state'
import { MARIADB_ADMIN_VERSION_SQL } from '../../../packages/os/src/mariadb-admin-command.ts'
import type { DbFamily, DbRun } from './db-engines.ts'
import type { DbServiceFs, DbServiceHost } from './db-service-files.ts'
import { parseMariadbBatch, parseMariadbVersion } from './mariadb-admin.ts'
import type { MariadbAdminClient, MariadbAdminSql } from './mariadb-admin.ts'
import type { AgentCallerIdentity } from './server.ts'

export const DATABASE_TUNING_VARIABLES = ['innodb_buffer_pool_size', 'max_connections', 'tmp_table_size', 'max_heap_table_size', 'table_open_cache', 'thread_cache_size', 'slow_query_log', 'long_query_time'] as const
export const DATABASE_TUNING_STATUS = ['Uptime', 'Uptime_since_flush_status', 'Threads_connected', 'Threads_running', 'Max_used_connections', 'Connections', 'Aborted_connects', 'Connection_errors_max_connections', 'Slow_queries', 'Questions', 'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests', 'Created_tmp_disk_tables', 'Created_tmp_tables', 'Open_tables', 'Opened_tables', 'Threads_created'] as const
export const DATABASE_TUNING_VARIABLES_SQL = `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${DATABASE_TUNING_VARIABLES.map(name => `'${name}'`).join(', ')})`
export const DATABASE_TUNING_STATUS_SQL = `SHOW GLOBAL STATUS WHERE Variable_name IN (${DATABASE_TUNING_STATUS.map(name => `'${name}'`).join(', ')})`
export type DatabaseTuningVariables = Record<Exclude<typeof DATABASE_TUNING_VARIABLES[number], 'slow_query_log'>, number> & { slow_query_log: 'ON' | 'OFF' }
export type DatabaseTuningStatus = Record<typeof DATABASE_TUNING_STATUS[number], number>
export type DatabaseTuningCheckId = 'connections' | 'buffer-pool' | 'temporary-tables' | 'slow-log' | 'table-cache' | 'thread-cache'
export type DatabaseTuningNext = 'review-connections' | 'sample-buffer-pool' | 'sample-temporary-tables' | 'review-slow-log' | 'sample-table-cache' | 'sample-thread-cache' | 'read-again'
export interface DatabaseTuningCheck { id: DatabaseTuningCheckId; state: 'review' | 'observe' | 'unavailable'; evidence: { name: string; value: number | string }[]; next: DatabaseTuningNext }
export interface DatabaseTuningObservation {
  engine: 'mariadb'; state: 'read' | 'partial' | 'unavailable'; observedAt: string | null; version: string | null
  variables: DatabaseTuningVariables | null; status: DatabaseTuningStatus | null
}

export const MARIADB_TUNING_DROPIN_DEBIAN = '/etc/mysql/mariadb.conf.d/90-xpanel-tuning.cnf'
export const MARIADB_TUNING_DROPIN_RHEL = '/etc/my.cnf.d/90-xpanel-tuning.cnf'
export const mariadbTuningDropInPath = (family: DbFamily | null = 'debian'): string => family === 'rhel' ? MARIADB_TUNING_DROPIN_RHEL : MARIADB_TUNING_DROPIN_DEBIAN
const TUNING_BACKUP_REL = 'extended/panel/database-tuning-rollback.json'
const TUNING_PING_SQL = 'SELECT 1'
const MAX_DROPIN_BYTES = 64 * 1024
const MAX_BODY_BYTES = 16 * 1024
const unchanged = { stateChanged: false }

export interface TuningBoundSpec {
  readonly kind: 'integer' | 'number'
  readonly min: number
  readonly max: number
  readonly unit: 'bytes' | 'count' | 'mode' | 'flag' | 'seconds'
}

export const DATABASE_TUNING_BOUNDS = {
  innodb_buffer_pool_size: { kind: 'integer', min: 67_108_864, max: 549_755_813_888, unit: 'bytes' },
  max_connections: { kind: 'integer', min: 10, max: 10_000, unit: 'count' },
  tmp_table_size: { kind: 'integer', min: 1_048_576, max: 4_294_967_296, unit: 'bytes' },
  max_heap_table_size: { kind: 'integer', min: 1_048_576, max: 4_294_967_296, unit: 'bytes' },
  table_open_cache: { kind: 'integer', min: 64, max: 524_288, unit: 'count' },
  thread_cache_size: { kind: 'integer', min: 0, max: 16_384, unit: 'count' },
  innodb_log_file_size: { kind: 'integer', min: 16_777_216, max: 17_179_869_184, unit: 'bytes' },
  query_cache_type: { kind: 'integer', min: 0, max: 2, unit: 'mode' },
  slow_query_log: { kind: 'integer', min: 0, max: 1, unit: 'flag' },
  long_query_time: { kind: 'number', min: 0.1, max: 3600, unit: 'seconds' },
} as const satisfies Record<string, TuningBoundSpec>

export type TuningSettingKey = keyof typeof DATABASE_TUNING_BOUNDS
export const TUNING_SETTING_KEYS = Object.keys(DATABASE_TUNING_BOUNDS) as readonly TuningSettingKey[]
export type ValidatedDatabaseTuningSettings = Partial<Record<TuningSettingKey, number>>

export interface DatabaseTuningDropInState {
  path: string
  present: boolean
  revision: string
  content: string | null
  rollbackAvailable: boolean
}

export interface DatabaseTuningView extends DatabaseTuningObservation {
  plan: { kind: 'advisory'; state: 'ready' | 'unavailable'; checks: DatabaseTuningCheck[] }
  capabilities: { apply: boolean }
  dropIn: DatabaseTuningDropInState
}

export interface DatabaseTuningPreview {
  path: string
  currentRevision: string
  currentContent: string | null
  proposedContent: string
  diff: string
  changed: boolean
  settings: ValidatedDatabaseTuningSettings
  rollbackAvailable: boolean
}

export interface DatabaseTuningApplyResult {
  applied: true
  path: string
  revision: string
  content: string
  rollbackAvailable: true
  observedAt: string
  settings: ValidatedDatabaseTuningSettings
}

export interface DatabaseTuningRollbackResult {
  rolledBack: true
  path: string
  revision: string
  restoredExisted: boolean
  observedAt: string
}

export interface DatabaseTuningRollbackRecord {
  path: string
  existed: boolean
  content: string | null
  mode: number
  uid: number
  gid: number
  savedAt: string
}

export interface DatabaseTuningRollbackStore {
  read(): Promise<DatabaseTuningRollbackRecord | null>
  write(record: DatabaseTuningRollbackRecord): Promise<void>
  clear(): Promise<void>
}

export const dropInRevisionOf = (content: string | null): string => createHash('sha256').update(content ?? '').digest('hex')

const invalid = (): never => { throw new Error('invalid_database_tuning_observation') }
const integer = (raw: string): number => /^(?:0|[1-9][0-9]{0,15})$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : invalid()
const number = (raw: string): number => /^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,6})?$/.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : invalid()
const names = <N extends string>(stdout: string, expected: readonly N[]): Map<N, string> => {
  const result = new Map<N, string>()
  // MariaDB SHOW GLOBAL returns one tab-separated name/value row per variable (mariadb(1) --batch).
  for (const [name, value] of parseMariadbBatch(stdout, 2)) {
    if (!(expected as readonly string[]).includes(name!) || result.has(name as N)) return invalid()
    result.set(name as N, value!)
  }
  return result.size === expected.length ? result : invalid()
}
export function parseDatabaseTuningVariables(stdout: string): DatabaseTuningVariables {
  const rows = names(stdout, DATABASE_TUNING_VARIABLES)
  const result = Object.fromEntries([...rows].map(([name, raw]) => [name, name === 'slow_query_log' ? (raw === 'ON' || raw === 'OFF' ? raw : invalid()) : name === 'long_query_time' ? number(raw) : integer(raw)])) as DatabaseTuningVariables
  return result.max_connections > 0 ? result : invalid()
}
export function parseDatabaseTuningStatus(stdout: string): DatabaseTuningStatus {
  return Object.fromEntries([...names(stdout, DATABASE_TUNING_STATUS)].map(([name, raw]) => [name, integer(raw)])) as DatabaseTuningStatus
}
export function isDatabaseTuningStatement(statement: unknown): boolean {
  return statement === MARIADB_ADMIN_VERSION_SQL || statement === DATABASE_TUNING_VARIABLES_SQL || statement === DATABASE_TUNING_STATUS_SQL || statement === TUNING_PING_SQL
}
export const admitDatabaseTuning = (client: MariadbAdminClient): MariadbAdminSql => async statement => {
  if (!isDatabaseTuningStatement(statement)) return fail('VALIDATION', 'unreviewed database tuning statement', unchanged)
  return client.query([statement])
}
const stateOf = (parts: readonly unknown[]): DatabaseTuningObservation['state'] => parts.every(part => part !== null) ? 'read' : parts.every(part => part === null) ? 'unavailable' : 'partial'

const defaultDropIn = (): DatabaseTuningDropInState => ({
  path: MARIADB_TUNING_DROPIN_DEBIAN,
  present: false,
  revision: dropInRevisionOf(null),
  content: null,
  rollbackAvailable: false,
})

/** Counters describe the current status interval, not rates or a workload-specific optimal configuration. */
export function buildDatabaseTuningView(observation: DatabaseTuningObservation, dropIn: DatabaseTuningDropInState = defaultDropIn()): DatabaseTuningView {
  const v = observation.variables, s = observation.status
  const check = (id: DatabaseTuningCheckId, next: DatabaseTuningNext, keys: readonly string[], review = false): DatabaseTuningCheck => {
    const values = { ...v, ...s }
    const available = keys.every(key => Object.hasOwn(values, key))
    return { id, state: !available ? 'unavailable' : review ? 'review' : 'observe', evidence: available ? keys.map(name => ({ name, value: values[name as keyof typeof values]! })) : [], next: available ? next : 'read-again' }
  }
  const checks: DatabaseTuningCheck[] = [
    check('connections', 'review-connections', ['max_connections', 'Threads_connected', 'Max_used_connections', 'Connection_errors_max_connections', 'Aborted_connects'], !!s && s.Connection_errors_max_connections > 0),
    check('buffer-pool', 'sample-buffer-pool', ['innodb_buffer_pool_size', 'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests']),
    check('temporary-tables', 'sample-temporary-tables', ['tmp_table_size', 'max_heap_table_size', 'Created_tmp_disk_tables', 'Created_tmp_tables'], !!s && s.Created_tmp_disk_tables > 0),
    check('slow-log', 'review-slow-log', ['slow_query_log', 'long_query_time', 'Slow_queries'], v?.slow_query_log === 'OFF'),
    check('table-cache', 'sample-table-cache', ['table_open_cache', 'Open_tables', 'Opened_tables']),
    check('thread-cache', 'sample-thread-cache', ['thread_cache_size', 'Threads_created', 'Connections']),
  ]
  return { ...observation, plan: { kind: 'advisory', state: checks.some(row => row.state !== 'unavailable') ? 'ready' : 'unavailable', checks }, capabilities: { apply: observation.state !== 'unavailable' }, dropIn }
}

const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const exact = (raw: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key))
const safeCount = (raw: unknown): raw is number => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0

export function validateDatabaseTuningSettings(raw: unknown): ValidatedDatabaseTuningSettings {
  if (!object(raw)) return fail('VALIDATION', 'tuning settings must be an object', { ...unchanged, reason: 'tuning_settings_invalid' })
  const keys = Object.keys(raw)
  if (keys.length === 0) return fail('VALIDATION', 'at least one tuning setting is required', { ...unchanged, reason: 'tuning_settings_empty' })
  const validated: ValidatedDatabaseTuningSettings = {}
  for (const key of keys) {
    if (!Object.hasOwn(DATABASE_TUNING_BOUNDS, key)) return fail('VALIDATION', `unsupported tuning setting: ${key}`, { ...unchanged, reason: 'tuning_setting_unknown', key })
    const spec = DATABASE_TUNING_BOUNDS[key as TuningSettingKey]
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return fail('VALIDATION', `${key} must be a finite number`, { ...unchanged, reason: 'tuning_bound_rejected', key })
    if (spec.kind === 'integer' && !Number.isSafeInteger(value)) return fail('VALIDATION', `${key} must be a whole integer`, { ...unchanged, reason: 'tuning_bound_rejected', key })
    if (value < spec.min || value > spec.max) return fail('VALIDATION', `${key} must be between ${spec.min} and ${spec.max}`, { ...unchanged, reason: 'tuning_bound_rejected', key })
    validated[key as TuningSettingKey] = spec.kind === 'number' ? Number(value.toFixed(3)) : value
  }
  return validated
}

export function renderDatabaseTuningDropIn(settings: ValidatedDatabaseTuningSettings): string {
  const lines = ['# Managed by xPanel Database Tuning (90-xpanel-tuning.cnf).', '[mysqld]']
  for (const key of TUNING_SETTING_KEYS) {
    if (Object.hasOwn(settings, key)) lines.push(`${key} = ${settings[key]}`)
  }
  return lines.join('\n') + '\n'
}

export function diffDatabaseTuningDropIn(current: string | null, proposed: string): { diff: string; changed: boolean } {
  const beforeText = current ?? ''
  if (beforeText === proposed) return { diff: '', changed: false }
  const before = current === null ? [] : current.replace(/\n$/, '').split('\n')
  const after = proposed.replace(/\n$/, '').split('\n')
  const out = ['--- current/90-xpanel-tuning.cnf', '+++ proposed/90-xpanel-tuning.cnf']
  for (const line of before) if (!after.includes(line)) out.push(`- ${line}`)
  for (const line of after) if (!before.includes(line)) out.push(`+ ${line}`)
  return { diff: out.join('\n'), changed: true }
}

const fallbackBackups = new WeakMap<DbServiceHost, DatabaseTuningRollbackRecord | null>()

const createRollbackStore = (stateRoot: string | undefined, host: DbServiceHost | undefined, explicit?: DatabaseTuningRollbackStore): DatabaseTuningRollbackStore => {
  if (explicit) return explicit
  if (!stateRoot) {
    return {
      async read() { return host ? (fallbackBackups.get(host) ?? null) : null },
      async write(record) { if (host) fallbackBackups.set(host, record) },
      async clear() { if (host) fallbackBackups.delete(host) },
    }
  }
  const file = join(stateRoot, TUNING_BACKUP_REL)
  return {
    async read() {
      try {
        const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
        if (!object(raw) || typeof raw.path !== 'string' || typeof raw.existed !== 'boolean' || (raw.content !== null && typeof raw.content !== 'string')) return null
        return raw as unknown as DatabaseTuningRollbackRecord
      } catch { return null }
    },
    async write(record) { await atomicWriteJson(file, record, 0o600) },
    async clear() { await atomicWriteJson(file, null, 0o600) },
  }
}

async function readDropInState(ctx: Pick<DatabaseTuningRouteContext, 'family' | 'host' | 'stateRoot' | 'rollbackStore'>): Promise<DatabaseTuningDropInState> {
  const path = mariadbTuningDropInPath(ctx.family ?? 'debian')
  const content = ctx.host ? await ctx.host.readFile(path).catch(() => null) : null
  const store = createRollbackStore(ctx.stateRoot, ctx.host, ctx.rollbackStore)
  const backup = await store.read()
  return {
    path,
    present: content !== null,
    revision: dropInRevisionOf(content),
    content,
    rollbackAvailable: backup !== null && backup.path === path,
  }
}

export async function readDatabaseTuning(run: MariadbAdminSql | null, authorize: () => Promise<void> = async () => undefined, now: () => Date = () => new Date(), dropIn?: DatabaseTuningDropInState): Promise<DatabaseTuningView> {
  const attempt = async <T>(sql: string, parse: (stdout: string) => T): Promise<T | null> => {
    if (!run) return null
    let result: T | null = null
    try { result = parse(await run(sql)) } catch { /* Credentials, stderr and partial output are never exposed. */ }
    // Keep revocation failures outside the observation-error catch.
    await authorize()
    return result
  }
  // Each statement starts one protected client process; keep reads sequential.
  const version = await attempt(MARIADB_ADMIN_VERSION_SQL, parseMariadbVersion)
  const variables = await attempt(DATABASE_TUNING_VARIABLES_SQL, parseDatabaseTuningVariables)
  const status = await attempt(DATABASE_TUNING_STATUS_SQL, parseDatabaseTuningStatus)
  await authorize()
  return buildDatabaseTuningView({ engine: 'mariadb', state: stateOf([version, variables, status]), observedAt: now().toISOString(), version, variables, status }, dropIn)
}

/** Project only the known observation; a provider cannot inject a plan or fake a revision. */
export function projectDatabaseTuningView(raw: unknown): DatabaseTuningView {
  if (!object(raw) || !exact(raw, ['engine', 'state', 'observedAt', 'version', 'variables', 'status', 'plan', 'capabilities', 'dropIn']) || raw.engine !== 'mariadb'
    || typeof raw.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.observedAt) || !Number.isFinite(Date.parse(raw.observedAt))
    || raw.version !== null && (typeof raw.version !== 'string' || !/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}[0-9A-Za-z.+_~-]{0,96}$/.test(raw.version))
    || raw.variables !== null && (!object(raw.variables) || !exact(raw.variables, DATABASE_TUNING_VARIABLES) || DATABASE_TUNING_VARIABLES.some(key => key === 'slow_query_log' ? !['ON', 'OFF'].includes(String((raw.variables as Record<string, unknown>)[key])) : key === 'long_query_time' ? typeof (raw.variables as Record<string, unknown>)[key] !== 'number' || !Number.isFinite((raw.variables as Record<string, number>)[key]) || (raw.variables as Record<string, number>)[key]! < 0 : !safeCount((raw.variables as Record<string, unknown>)[key])) || (raw.variables as Record<string, number>).max_connections! <= 0)
    || raw.status !== null && (!object(raw.status) || !exact(raw.status, DATABASE_TUNING_STATUS) || DATABASE_TUNING_STATUS.some(key => !safeCount((raw.status as Record<string, unknown>)[key])))
    || raw.state !== stateOf([raw.version, raw.variables, raw.status]) || !object(raw.capabilities) || !exact(raw.capabilities, ['apply']) || raw.capabilities.apply !== (raw.state !== 'unavailable')
    || !object(raw.dropIn) || !exact(raw.dropIn, ['path', 'present', 'revision', 'content', 'rollbackAvailable'])
    || (raw.dropIn.path !== MARIADB_TUNING_DROPIN_DEBIAN && raw.dropIn.path !== MARIADB_TUNING_DROPIN_RHEL)
    || typeof raw.dropIn.present !== 'boolean' || typeof raw.dropIn.rollbackAvailable !== 'boolean'
    || (raw.dropIn.content !== null && (typeof raw.dropIn.content !== 'string' || raw.dropIn.content.length > MAX_DROPIN_BYTES || raw.dropIn.content.includes('\0')))
    || raw.dropIn.present !== (raw.dropIn.content !== null)
    || raw.dropIn.revision !== dropInRevisionOf(raw.dropIn.content as string | null)) return invalid()
  const view = buildDatabaseTuningView(
    { engine: 'mariadb', state: raw.state as DatabaseTuningObservation['state'], observedAt: raw.observedAt, version: raw.version as string | null, variables: raw.variables as DatabaseTuningVariables | null, status: raw.status as DatabaseTuningStatus | null },
    raw.dropIn as unknown as DatabaseTuningDropInState,
  )
  if (JSON.stringify(raw.plan) !== JSON.stringify(view.plan)) return invalid()
  return view
}

const configTestBinary = (family: DbFamily | null = 'debian'): string => family === 'rhel' ? '/usr/libexec/mariadbd' : '/usr/sbin/mariadbd'
const targetUnit = (unit: string | undefined): string => unit === 'mysql.service' ? 'mysql.service' : 'mariadb.service'

async function restartAndVerifyMariadb(ctx: Pick<DatabaseTuningRouteContext, 'family' | 'run' | 'mariadb' | 'sleep' | 'unit'>): Promise<{ ok: boolean; reason?: string }> {
  if (!ctx.run || !ctx.mariadb) return { ok: false, reason: 'native_host_required' }
  const test = await ctx.run([configTestBinary(ctx.family), '--verbose', '--help'])
  if (!test.ok) return { ok: false, reason: test.stderr.split('\n')[0]?.slice(0, 200) || 'MariaDB rejected the tuning configuration' }
  const unit = targetUnit(ctx.unit)
  const res = await ctx.run(['/usr/bin/systemctl', 'restart', '--', unit])
  if (!res.ok) return { ok: false, reason: 'MariaDB service failed to restart' }
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const out = await ctx.mariadb.query([TUNING_PING_SQL])
      if (parseMariadbBatch(out, 1)[0]?.[0] === '1') return { ok: true }
    } catch { /* wait for socket */ }
    await sleep(250)
  }
  return { ok: false, reason: 'MariaDB did not answer health check after restart' }
}

async function restoreDropIn(ctx: Pick<DatabaseTuningRouteContext, 'host' | 'fs' | 'removeFile'>, backup: DatabaseTuningRollbackRecord): Promise<void> {
  if (!ctx.host) throw new Error('missing_host')
  if (backup.existed && backup.content !== null) {
    await ctx.host.writeFile({ path: backup.path, content: backup.content, mode: backup.mode, owner: String(backup.uid), group: String(backup.gid) })
    return
  }
  if (ctx.removeFile) { await ctx.removeFile(backup.path); return }
  if (ctx.fs) { await ctx.fs.remove(backup.path); return }
  const hostWithRemove = ctx.host as DbServiceHost & { removePath?: (path: string) => Promise<void> }
  if (typeof hostWithRemove.removePath === 'function') { await hostWithRemove.removePath(backup.path); return }
  await ctx.host.writeFile({ path: backup.path, content: '# Rolled back by xPanel Database Tuning.\n[mysqld]\n', mode: 0o644, owner: 'root', group: 'root' })
}

export interface DatabaseTuningRouteContext {
  caller: AgentCallerIdentity
  reauthenticate(): Promise<AgentCallerIdentity>
  assertRoot(caller: AgentCallerIdentity, action: string): Promise<void>
  mariadb?: MariadbAdminClient
  now?: () => Date
  family?: DbFamily | null
  host?: DbServiceHost
  fs?: DbServiceFs
  run?: DbRun
  stateRoot?: string
  unit?: string
  sleep?: (ms: number) => Promise<void>
  removeFile?: (path: string) => Promise<void>
  rollbackStore?: DatabaseTuningRollbackStore
  audit?: (entry: { actor: string; principalId: string; action: string; target: string; detail?: Record<string, unknown>; outcome: 'ok' | 'failed' }) => Promise<unknown>
}

export async function previewDatabaseTuning(body: unknown, ctx: DatabaseTuningRouteContext, authorize: () => Promise<void> = async () => undefined): Promise<DatabaseTuningPreview> {
  if (!object(body) || !Object.hasOwn(body, 'settings') || Object.keys(body).some(key => key !== 'settings' && key !== 'expectedRevision')) {
    return fail('VALIDATION', 'tuning preview requires settings', unchanged)
  }
  const settings = validateDatabaseTuningSettings(body.settings)
  await authorize()
  const current = await readDropInState(ctx)
  const proposedContent = renderDatabaseTuningDropIn(settings)
  const { diff, changed } = diffDatabaseTuningDropIn(current.content, proposedContent)
  return {
    path: current.path,
    currentRevision: current.revision,
    currentContent: current.content,
    proposedContent,
    diff,
    changed,
    settings,
    rollbackAvailable: current.rollbackAvailable,
  }
}

export async function applyDatabaseTuning(body: unknown, ctx: DatabaseTuningRouteContext, authorize: () => Promise<void> = async () => undefined): Promise<DatabaseTuningApplyResult> {
  if (!object(body) || !exact(body, ['settings', 'expectedRevision']) || typeof body.expectedRevision !== 'string') {
    return fail('VALIDATION', 'exactly settings and expectedRevision are required', unchanged)
  }
  const settings = validateDatabaseTuningSettings(body.settings)
  if (!ctx.host || !ctx.run || !ctx.mariadb) {
    return fail('PRECONDITION_FAILED', 'native host and MariaDB administration are required to apply tuning', { ...unchanged, reason: 'native_host_required' })
  }
  const path = mariadbTuningDropInPath(ctx.family ?? 'debian')
  const currentContent = await ctx.host.readFile(path)
  if (body.expectedRevision !== dropInRevisionOf(currentContent)) {
    return fail('CONFLICT', 'the tuning configuration changed since it was read', { ...unchanged, reason: 'tuning_revision_conflict' })
  }
  const info = ctx.fs ? await ctx.fs.stat(path) : null
  const now = ctx.now ?? (() => new Date())
  const backup: DatabaseTuningRollbackRecord = {
    path,
    existed: currentContent !== null,
    content: currentContent,
    mode: info?.mode ?? 0o644,
    uid: info?.uid ?? 0,
    gid: info?.gid ?? 0,
    savedAt: now().toISOString(),
  }
  const store = createRollbackStore(ctx.stateRoot, ctx.host, ctx.rollbackStore)
  const proposedContent = renderDatabaseTuningDropIn(settings)
  await authorize()
  await store.write(backup)
  await ctx.host.writeFile({ path, content: proposedContent, mode: 0o644, owner: 'root', group: 'root' })
  const verified = await restartAndVerifyMariadb(ctx)
  if (verified.ok) {
    return { applied: true, path, revision: dropInRevisionOf(proposedContent), content: proposedContent, rollbackAvailable: true, observedAt: now().toISOString(), settings }
  }
  let restored = false
  try {
    await restoreDropIn(ctx, backup)
    restored = (await restartAndVerifyMariadb(ctx)).ok
  } catch { restored = false }
  return fail(
    'CONFIG_TEST_FAILED',
    verified.reason ?? 'MariaDB did not accept the tuning drop-in',
    restored
      ? { stateChanged: false, restored: true, reason: 'tuning_apply_rejected' }
      : { stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: 'tuning_restore_failed' },
  )
}

export async function rollbackDatabaseTuning(body: unknown, ctx: DatabaseTuningRouteContext, authorize: () => Promise<void> = async () => undefined): Promise<DatabaseTuningRollbackResult> {
  if (!object(body) || !exact(body, ['expectedRevision']) || typeof body.expectedRevision !== 'string') {
    return fail('VALIDATION', 'expectedRevision is required for rollback', unchanged)
  }
  if (!ctx.host || !ctx.run || !ctx.mariadb) {
    return fail('PRECONDITION_FAILED', 'native host and MariaDB administration are required to roll back tuning', { ...unchanged, reason: 'native_host_required' })
  }
  const store = createRollbackStore(ctx.stateRoot, ctx.host, ctx.rollbackStore)
  const backup = await store.read()
  const path = mariadbTuningDropInPath(ctx.family ?? 'debian')
  if (!backup || backup.path !== path) {
    return fail('PRECONDITION_FAILED', 'no previous tuning configuration is available to roll back', { ...unchanged, reason: 'tuning_rollback_unavailable' })
  }
  const currentContent = await ctx.host.readFile(path)
  if (body.expectedRevision !== dropInRevisionOf(currentContent)) {
    return fail('CONFLICT', 'the tuning configuration changed since it was read', { ...unchanged, reason: 'tuning_revision_conflict' })
  }
  const info = ctx.fs ? await ctx.fs.stat(path) : null
  const previousState: DatabaseTuningRollbackRecord = {
    path,
    existed: currentContent !== null,
    content: currentContent,
    mode: info?.mode ?? 0o644,
    uid: info?.uid ?? 0,
    gid: info?.gid ?? 0,
    savedAt: (ctx.now ?? (() => new Date()))().toISOString(),
  }
  await authorize()
  await restoreDropIn(ctx, backup)
  const verified = await restartAndVerifyMariadb(ctx)
  if (verified.ok) {
    await store.clear()
    return { rolledBack: true, path, revision: dropInRevisionOf(backup.content), restoredExisted: backup.existed, observedAt: (ctx.now ?? (() => new Date()))().toISOString() }
  }
  let restored = false
  try {
    await restoreDropIn(ctx, previousState)
    restored = (await restartAndVerifyMariadb(ctx)).ok
  } catch { restored = false }
  return fail(
    'CONFIG_TEST_FAILED',
    verified.reason ?? 'MariaDB failed to restart after rollback',
    restored
      ? { stateChanged: false, restored: true, reason: 'tuning_rollback_rejected' }
      : { stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: 'tuning_restore_failed' },
  )
}

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const authorizeContext = (ctx: DatabaseTuningRouteContext, action: string) => async (): Promise<void> => {
  const fresh = await ctx.reauthenticate()
  await ctx.assertRoot(fresh, action)
  if (fresh.principalId !== ctx.caller.principalId || fresh.actor !== ctx.caller.actor) return fail('FORBIDDEN', 'database tuning authority changed', unchanged)
}

const readBoundedJson = async (req: Request): Promise<unknown> => {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const raw = await req.text()
  try {
    if (raw.length > MAX_BODY_BYTES) throw new Error('too_large')
    return JSON.parse(raw)
  } catch { return fail('VALIDATION', 'the request is not bounded JSON', unchanged) }
}

const MUTATION_ACTIONS: Readonly<Record<string, string>> = {
  '/host/databases/tuning/preview': 'host.databases.tuning.preview',
  '/host/databases/tuning/apply': 'host.databases.tuning.apply',
  '/host/databases/tuning/rollback': 'host.databases.tuning.rollback',
}

/** Handles `/host/databases/tuning/{preview,apply,rollback}` for mounting from `agent/src/server.ts`. */
export async function handleDatabaseTuningMutationRoute(req: Request, url: URL, method: string, ctx: DatabaseTuningRouteContext): Promise<Response | null> {
  const action = MUTATION_ACTIONS[url.pathname]
  if (!action) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'database tuning does not accept selectors or statements', unchanged)
  const authorize = authorizeContext(ctx, action)
  await ctx.assertRoot(ctx.caller, action)
  await authorize()
  const body = await readBoundedJson(req)
  if (url.pathname === '/host/databases/tuning/preview') return jsonResponse(await previewDatabaseTuning(body, ctx, authorize))
  if (url.pathname === '/host/databases/tuning/apply') return jsonResponse(await applyDatabaseTuning(body, ctx, authorize))
  return jsonResponse(await rollbackDatabaseTuning(body, ctx, authorize))
}

export async function handleDatabaseTuningRoute(req: Request, url: URL, method: string, ctx: DatabaseTuningRouteContext): Promise<Response | null> {
  const mutation = await handleDatabaseTuningMutationRoute(req, url, method, ctx)
  if (mutation) return mutation
  if (url.pathname !== '/host/databases/tuning') return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'database tuning does not accept selectors or statements', unchanged)
  const authorize = authorizeContext(ctx, 'host.databases.tuning.read')
  await ctx.assertRoot(ctx.caller, 'host.databases.tuning.read')
  await authorize()
  const dropIn = await readDropInState(ctx)
  const view = await readDatabaseTuning(ctx.mariadb ? admitDatabaseTuning(ctx.mariadb) : null, authorize, ctx.now, dropIn)
  return jsonResponse(view)
}
