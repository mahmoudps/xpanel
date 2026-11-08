import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { atomicWriteJson } from '@xpanel/state'
import { PG_HBA_ERRORS_SQL, PG_PING_SQL, PG_SERVICE_FILES_SQL, PG_SERVICE_SETTINGS_SQL, isPostgresqlConfigPath, isPostgresqlLogPath, pgConfigCheckArgv } from '../../../packages/os/src/db-services-command.ts'
import { postgresqlQueryArgv } from '../../../packages/os/src/db-engines-command.ts'
import { assertServicePort, hideSecrets, restoreSecrets, controlUnit, engineFacts, exactBody, LOG_TAIL_BYTES, logLines, requireOk, requireUnit, revisionOf, withFileRollback } from './db-service-files.ts'
import type { DbServiceContext } from './db-service-files.ts'

/** The server PostgreSQL cluster. Paths come from the running server, so Debian and EL share one code path. */
const unchanged = { stateChanged: false }
const SIZE = /^[1-9][0-9]{0,6}(?:kB|MB|GB)$/
const MAX_TEXT = 256 * 1024
const PORT_FILE = 'extended/panel/postgresql-port.json'

/**
 * Every psql of the product uses the libpq default port. PGPORT is the one seam shared by the query, script and tool
 * runners, so a moved port keeps the panel connected; shortcut: agent-wide, a second cluster would need per-call ports.
 */
export async function loadPostgresqlPort(stateRoot: string): Promise<void> {
  try { const raw = JSON.parse(await readFile(join(stateRoot, PORT_FILE), 'utf8')) as { port?: unknown }; if (Number.isInteger(raw.port)) process.env.PGPORT = String(raw.port) } catch { /* the default port */ }
}
const rows = (stdout: string, columns: number): string[][] => stdout.split('\n').filter(Boolean).map(line => { const row = line.split('\t'); return row.length === columns ? row : fail('SERVICE_UNAVAILABLE', 'the PostgreSQL reply could not be read', unchanged) })
async function query(ctx: DbServiceContext, sql: string, columns: number): Promise<string[][] | null> {
  const result = await ctx.run(postgresqlQueryArgv(sql))
  return result.ok ? rows(result.stdout, columns) : null
}
interface PgFiles { config: string; hba: string; data: string; versionNum: number; logFile: string }
async function readFiles(ctx: DbServiceContext): Promise<PgFiles | null> {
  const row = (await query(ctx, PG_SERVICE_FILES_SQL, 5).catch(() => null))?.[0]
  if (!row) return null
  const [config, hba, data, version, logFile] = row as [string, string, string, string, string]
  return { config, hba, data, versionNum: Number(version), logFile }
}
export async function requirePgFiles(ctx: DbServiceContext): Promise<PgFiles & { unit: string }> {
  const view = await engineFacts(ctx), product = view.products.postgresql
  if (!product.installed) return fail('PRECONDITION_FAILED', 'PostgreSQL is not installed on this server', { ...unchanged, reason: 'postgresql_not_installed' })
  const files = await readFiles(ctx)
  if (!files) return fail('PRECONDITION_FAILED', 'PostgreSQL must be running for this', { ...unchanged, reason: 'postgresql_not_running' })
  if (!isPostgresqlConfigPath(files.config) || !isPostgresqlConfigPath(files.hba)) return fail('PRECONDITION_FAILED', 'the PostgreSQL files are outside the reviewed paths', { ...unchanged, reason: 'postgresql_paths_unsupported' })
  return { ...files, unit: requireUnit(typeof product.service === 'object' ? product.service?.unit ?? null : null, 'postgresql') }
}
export async function readPostgresqlView(ctx: DbServiceContext) {
  const view = await engineFacts(ctx), product = view.products.postgresql
  const running = !!product.installed && typeof product.service === 'object' && product.service?.active === 'active'
  const files = running ? await readFiles(ctx) : null, settings = running ? await query(ctx, PG_SERVICE_SETTINGS_SQL, 4).catch(() => null) : null
  return { engine: 'postgresql', observedAt: view.observedAt, installed: product.installed, package: product.package, service: product.service, version: view.postgresqlVersion,
    files: files ? { config: files.config, hba: files.hba, data: files.data } : null,
    settings: settings ? Object.fromEntries(settings.map(([name, value, unit]) => [name!, { value: value!, unit: unit! }])) : null,
    pendingRestart: settings?.filter(row => row[3] === 't').map(row => row[0]!) ?? [] }
}
export async function readPostgresqlFile(ctx: DbServiceContext, kind: 'config' | 'hba') {
  const files = await requirePgFiles(ctx), path = kind === 'hba' ? files.hba : files.config, raw = await ctx.host.readFile(path)
  if (raw === null) return fail('PRECONDITION_FAILED', 'the file could not be read', { ...unchanged, reason: 'postgresql_config_unread' })
  const text = hideSecrets('postgresql', raw)
  return { path, text, revision: revisionOf(text) }
}
const pings = async (ctx: DbServiceContext): Promise<boolean> => {
  for (let attempt = 0; attempt < 40; attempt++) { if ((await ctx.run(postgresqlQueryArgv(PG_PING_SQL))).ok) return true; await ctx.sleep(500) }
  return false
}
// peer authentication over the socket is how the agent itself reaches the server, so the rule that allows it must stay.
const HBA_ADMIN = /^\s*local\s+(?:all|\S*\bpostgres\b\S*)\s+(?:all|\S*\bpostgres\b\S*)\s+(?:peer|trust)\b/m
export async function savePostgresqlFile(ctx: DbServiceContext, kind: 'config' | 'hba', body: unknown) {
  const input = exactBody(body, ['text', 'expectedRevision']), text = input.text
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT || text.includes('\0')) return fail('VALIDATION', 'the configuration text is not accepted', unchanged)
  if (kind === 'hba' && !HBA_ADMIN.test(text)) return fail('VALIDATION', 'keep a local peer rule for the postgres user: xPanel signs in with it', { ...unchanged, reason: 'postgresql_admin_rule_required' })
  const files = await requirePgFiles(ctx), path = kind === 'hba' ? files.hba : files.config, current = await ctx.host.readFile(path), info = await ctx.fs.stat(path)
  if (current === null || !info) return fail('PRECONDITION_FAILED', 'the file could not be read', { ...unchanged, reason: 'postgresql_config_unread' })
  if (input.expectedRevision !== revisionOf(hideSecrets('postgresql', current))) return fail('CONFLICT', 'the file changed since it was read', { ...unchanged, reason: 'config_changed' })
  const candidate = restoreSecrets('postgresql', text, current)
  await ctx.assertFresh()
  await withFileRollback({ host: ctx.host, fs: ctx.fs, path, reason: kind === 'hba' ? 'postgresql_hba' : 'postgresql_config',
    change: async () => { await ctx.host.writeFile({ path, content: candidate, mode: info.mode, owner: String(info.uid), group: String(info.gid) }) },
    check: async () => {
      if (kind === 'hba') { const errors = await query(ctx, PG_HBA_ERRORS_SQL, 2); return errors?.length ? `line ${errors[0]![0]}: ${errors[0]![1]!.slice(0, 200)}` : null }
      const binary = ctx.family === 'rhel' ? '/usr/bin/postgres' : `/usr/lib/postgresql/${Math.floor(files.versionNum / 10000)}/bin/postgres`, result = await ctx.run(pgConfigCheckArgv(binary, files.data, path))
      return result.ok ? null : result.stderr.split('\n')[0]!.slice(0, 200) || 'the configuration file was refused'
    },
    activate: async () => requireOk(ctx, 'reload', files.unit),
    verify: () => pings(ctx) })
  return { saved: true }
}

const SETTING_NAMES: Readonly<Record<string, string>> = { port: 'port', maxConnections: 'max_connections', sharedBuffers: 'shared_buffers', workMem: 'work_mem', maintenanceWorkMem: 'maintenance_work_mem', effectiveCacheSize: 'effective_cache_size', logMinDurationMs: 'log_min_duration_statement' }
export function assertPostgresqlSettings(body: unknown): string[] {
  const input = exactBody(body, Object.keys(SETTING_NAMES)), port = assertServicePort(input.port, 'port')
  const { maxConnections, logMinDurationMs } = input
  if (!Number.isInteger(maxConnections) || (maxConnections as number) < 5 || (maxConnections as number) > 10000 || !Number.isInteger(logMinDurationMs) || (logMinDurationMs as number) < -1 || (logMinDurationMs as number) > 3600000) return fail('VALIDATION', 'the PostgreSQL settings are not accepted', unchanged)
  for (const key of ['sharedBuffers', 'workMem', 'maintenanceWorkMem', 'effectiveCacheSize']) if (typeof input[key] !== 'string' || !SIZE.test(input[key] as string)) return fail('VALIDATION', 'use a size such as 128MB', { ...unchanged, reason: 'postgresql_size_rejected' })
  return Object.entries(SETTING_NAMES).map(([key, name]) => `ALTER SYSTEM SET ${name} = ${key === 'port' ? port : typeof input[key] === 'string' ? `'${input[key]}'` : input[key]};`)
}
export async function savePostgresqlSettings(ctx: DbServiceContext, body: unknown) {
  const statements = assertPostgresqlSettings(body), files = await requirePgFiles(ctx), auto = join(files.data, 'postgresql.auto.conf').replaceAll('\\', '/'), port = String((body as { port: number }).port), previousPort = process.env.PGPORT
  if (!isPostgresqlConfigPath(auto)) return fail('PRECONDITION_FAILED', 'the PostgreSQL files are outside the reviewed paths', { ...unchanged, reason: 'postgresql_paths_unsupported' })
  if (!ctx.runPostgresql) return fail('PRECONDITION_FAILED', 'PostgreSQL administration is not connected on this host', { ...unchanged, reason: 'postgresql_runner_missing' })
  await ctx.assertFresh()
  let restarted = false
  try {
    await withFileRollback({ host: ctx.host, fs: ctx.fs, path: auto, reason: 'postgresql_settings',
      change: async () => { await ctx.runPostgresql!(statements) },
      activate: async () => {
        await requireOk(ctx, 'reload', files.unit)
        const pending = await query(ctx, PG_SERVICE_SETTINGS_SQL, 4)
        if (pending?.some(row => row[3] === 't')) { await requireOk(ctx, 'restart', files.unit); restarted = true }
      },
      verify: async () => { process.env.PGPORT = port; return pings(ctx) },
      verifyRestored: async () => { if (previousPort === undefined) delete process.env.PGPORT; else process.env.PGPORT = previousPort; return pings(ctx) } })
  } catch (error) { if (previousPort === undefined) delete process.env.PGPORT; else process.env.PGPORT = previousPort; throw error }
  await atomicWriteJson(join(ctx.stateRoot, PORT_FILE), { port: Number(port) })
  return { saved: true, restarted }
}
export async function readPostgresqlLog(ctx: DbServiceContext) {
  const files = await requirePgFiles(ctx), major = String(Math.floor(files.versionNum / 10000))
  const path = files.logFile ? (files.logFile.startsWith('/') ? files.logFile : `${files.data}/${files.logFile}`) : `/var/log/postgresql/postgresql-${major}-main.log`
  if (!isPostgresqlLogPath(path)) return fail('PRECONDITION_FAILED', 'the PostgreSQL log path is outside the reviewed paths', { ...unchanged, reason: 'postgresql_log_path_unsupported' })
  return { path, lines: logLines(await ctx.fs.tail(path, LOG_TAIL_BYTES).catch(() => null)) }
}
export const controlPostgresql = async (ctx: DbServiceContext, body: unknown) => {
  const view = await engineFacts(ctx), product = view.products.postgresql
  if (!product.installed) return fail('PRECONDITION_FAILED', 'PostgreSQL is not installed on this server', { ...unchanged, reason: 'postgresql_not_installed' })
  return controlUnit(ctx, typeof product.service === 'object' ? product.service?.unit ?? null : null, 'postgresql', body)
}
