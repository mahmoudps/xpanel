import { fail, parseIp } from '@xpanel/core'
import { DB_MARIADB_UNITS } from '../../../packages/os/src/db-engines-command.ts'
import { DB_SERVICE_ACTIONS, DB_SERVICE_SYSTEMCTL, MYSQL_CLI, MYSQL_PING_SQL, MYSQL_SERVICE_SETTINGS_SQL, MYSQL_SETTINGS_NAMES, MYSQL_VERSION_SQL, mariadbdCheckArgv, mysqlQueryArgv } from '../../../packages/os/src/db-services-command.ts'
import type { DbServiceAction } from '../../../packages/os/src/db-services-command.ts'
import type { DbFamily } from './db-engines.ts'
import { assertServicePort, engineFacts, exactBody, LOG_TAIL_BYTES, logLines, requireUnit, revisionOf } from './db-service-files.ts'
import type { DbServiceContext } from './db-service-files.ts'
import { parseMariadbBatch, parseMariadbVersion } from './mariadb-admin.ts'

/** Server MariaDB / MySQL service lifecycle, port/listen verification, drop-in preview/apply with rollback, and log tail. */
const unchanged = { stateChanged: false }
const MAX_TEXT = 256 * 1024
export const MYSQL_DROPIN_DEBIAN = '/etc/mysql/mariadb.conf.d/90-xpanel-mysql.cnf'
export const MYSQL_DROPIN_RHEL = '/etc/my.cnf.d/90-xpanel-mysql.cnf'
export const mysqlDropInPath = (family: DbFamily | null = 'debian'): string => family === 'rhel' ? MYSQL_DROPIN_RHEL : MYSQL_DROPIN_DEBIAN

export { MYSQL_CLI, MYSQL_PING_SQL, MYSQL_SERVICE_SETTINGS_SQL, MYSQL_SETTINGS_NAMES, MYSQL_VERSION_SQL, mariadbdCheckArgv, mysqlQueryArgv }
const isMysqlUnit = (unit: unknown): unit is string => typeof unit === 'string' && (DB_MARIADB_UNITS as readonly string[]).includes(unit)

export const isMysqlConfigPath = (path: unknown): path is string =>
  typeof path === 'string' && [MYSQL_DROPIN_DEBIAN, MYSQL_DROPIN_RHEL, '/etc/mysql/mariadb.conf.d/50-server.cnf', '/etc/my.cnf.d/mariadb-server.cnf', '/etc/my.cnf'].includes(path)

export const isMysqlLogPath = (path: unknown): path is string =>
  typeof path === 'string' && /^\/var\/log\/(?:mysql|mariadb)\/[A-Za-z0-9._-]{1,64}\.log$/.test(path) || path === '/var/log/mysqld.log'

const DISALLOWED_SECTIONS = new Set(['client', 'mysql', 'mariadb-client', 'mysqldump', 'mysqladmin'])
const DISALLOWED_DIRECTIVES = new Set(['init_file', 'init-file', 'plugin_load', 'plugin-load', 'plugin_load_add', 'plugin-load-add', 'local_infile', 'local-infile', 'secure_file_priv', 'secure-file-priv', 'chroot'])

export function assertMysqlBindAddress(value: unknown): string {
  if (typeof value !== 'string') return fail('VALIDATION', 'bindAddress must be a string', { ...unchanged, reason: 'mysql_bind_rejected' })
  const trimmed = value.trim()
  if (trimmed === '*' || trimmed === 'localhost' || trimmed === '0.0.0.0' || trimmed === '::') return trimmed
  if (parseIp(trimmed)) return trimmed
  return fail('VALIDATION', 'bindAddress must be a valid IPv4/IPv6 address, localhost or *', { ...unchanged, reason: 'mysql_bind_rejected' })
}

export function validateMysqlDropInText(text: unknown): string {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT || text.includes('\0') || /[\u0001-\u0008\u000b-\u001f\u007f]/.test(text.replace(/\r/g, ''))) {
    return fail('VALIDATION', 'the MySQL configuration text is not accepted', unchanged)
  }
  let section = 'mysqld'
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sec = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line)
    if (sec) {
      section = sec[1]!.toLowerCase()
      if (DISALLOWED_SECTIONS.has(section)) return fail('VALIDATION', `section [${sec[1]}] is not editable here`, { ...unchanged, reason: 'mysql_section_rejected' })
      continue
    }
    const kv = /^([A-Za-z][A-Za-z0-9_-]{0,63})(?:\s*=\s*(.*))?$/.exec(line)
    if (!kv) return fail('VALIDATION', 'invalid MySQL configuration directive syntax', { ...unchanged, reason: 'mysql_syntax_rejected' })
    const key = kv[1]!.toLowerCase(), val = (kv[2] ?? '').trim()
    if (DISALLOWED_DIRECTIVES.has(key)) return fail('VALIDATION', `directive ${kv[1]} is not permitted in this drop-in`, { ...unchanged, reason: 'mysql_directive_rejected' })
    if (key === 'port') assertServicePort(Number(val), 'port')
    if (key === 'bind_address' || key === 'bind-address') assertMysqlBindAddress(val)
    if (key === 'max_connections') {
      const n = Number(val)
      if (!Number.isInteger(n) || n < 10 || n > 10_000) return fail('VALIDATION', 'max_connections must be between 10 and 10000', { ...unchanged, reason: 'mysql_bounds_rejected' })
    }
  }
  return text.endsWith('\n') ? text : text + '\n'
}

export interface MysqlSettingsInput {
  port: number
  bindAddress: string
  maxConnections: number
  skipNetworking: boolean
}

export function assertMysqlSettings(body: unknown): MysqlSettingsInput {
  const input = exactBody(body, ['port', 'bindAddress', 'maxConnections', 'skipNetworking'])
  const port = assertServicePort(input.port, 'port')
  const bindAddress = assertMysqlBindAddress(input.bindAddress)
  const maxConnections = input.maxConnections
  if (!Number.isInteger(maxConnections) || (maxConnections as number) < 10 || (maxConnections as number) > 10_000) {
    return fail('VALIDATION', 'maxConnections must be between 10 and 10000', { ...unchanged, reason: 'mysql_bounds_rejected' })
  }
  if (typeof input.skipNetworking !== 'boolean') {
    return fail('VALIDATION', 'skipNetworking must be a boolean', unchanged)
  }
  return { port, bindAddress, maxConnections: maxConnections as number, skipNetworking: input.skipNetworking }
}

export function renderMysqlDropIn(settings: MysqlSettingsInput): string {
  return [
    '# Managed by xPanel MySQL service (90-xpanel-mysql.cnf).',
    '[mysqld]',
    `port = ${settings.port}`,
    `bind_address = ${settings.bindAddress}`,
    `max_connections = ${settings.maxConnections}`,
    `skip_networking = ${settings.skipNetworking ? 1 : 0}`,
    '',
  ].join('\n')
}

export function diffMysqlDropIn(current: string | null, proposed: string): { diff: string; changed: boolean } {
  if ((current ?? '') === proposed) return { diff: '', changed: false }
  const before = current === null ? [] : current.replace(/\n$/, '').split('\n')
  const after = proposed.replace(/\n$/, '').split('\n')
  const out = ['--- current/90-xpanel-mysql.cnf', '+++ proposed/90-xpanel-mysql.cnf']
  for (const line of before) if (!after.includes(line)) out.push(`- ${line}`)
  for (const line of after) if (!before.includes(line)) out.push(`+ ${line}`)
  return { diff: out.join('\n'), changed: true }
}

async function queryScalar(ctx: DbServiceContext, sql: string): Promise<string | null> {
  const result = await ctx.run(mysqlQueryArgv(sql))
  return result.ok ? result.stdout : null
}

async function readSettingsMap(ctx: DbServiceContext): Promise<Record<string, string> | null> {
  const stdout = await queryScalar(ctx, MYSQL_SERVICE_SETTINGS_SQL).catch(() => null)
  if (stdout === null) return null
  try {
    return Object.fromEntries(parseMariadbBatch(stdout, 2).map(([k, v]) => [k!, v!]))
  } catch { return null }
}

export async function requireMysqlService(ctx: DbServiceContext) {
  const view = await engineFacts(ctx), product = view.products.mariadb
  if (!product.installed) return fail('PRECONDITION_FAILED', 'MariaDB/MySQL is not installed on this server', { ...unchanged, reason: 'mysql_not_installed' })
  const unit = requireUnit(typeof product.service === 'object' ? product.service?.unit ?? null : null, 'mysql')
  if (!isMysqlUnit(unit)) return fail('PRECONDITION_FAILED', 'unsupported MySQL service unit', { ...unchanged, reason: 'mysql_unit_unsupported' })
  return { view, product, unit }
}

const pings = async (ctx: DbServiceContext, check?: () => Promise<boolean>): Promise<boolean> => {
  for (let attempt = 0; attempt < 24; attempt++) {
    const out = await queryScalar(ctx, MYSQL_PING_SQL).catch(() => null)
    if (out !== null) {
      try {
        if (parseMariadbBatch(out, 1)[0]?.[0] === '1' && (!check || await check())) return true
      } catch { /* retry while server warms up */ }
    }
    await ctx.sleep(250)
  }
  return false
}

async function withMysqlDropInRollback(ctx: DbServiceContext, path: string, unit: string, candidate: string, reason: string, verifySettings?: () => Promise<boolean>): Promise<void> {
  if (!isMysqlConfigPath(path)) return fail('PRECONDITION_FAILED', 'the MySQL configuration file is outside the reviewed paths', { ...unchanged, reason: 'mysql_paths_unsupported' })
  const previous = await ctx.host.readFile(path)
  const info = previous !== null ? await ctx.fs.stat(path) : null
  if (previous !== null && !info) return fail('PRECONDITION_FAILED', 'the configuration file could not be inspected; nothing was changed', { ...unchanged, reason: reason + '_config_unread' })
  const restore = async (): Promise<boolean> => {
    try {
      if (previous !== null && info) {
        await ctx.host.writeFile({ path, content: previous, mode: info.mode, owner: String(info.uid), group: String(info.gid) })
      } else {
        await ctx.fs.remove(path)
      }
      const res = await ctx.run([DB_SERVICE_SYSTEMCTL, 'restart', '--', unit])
      return res.ok && await pings(ctx)
    } catch { return false }
  }

  await ctx.host.writeFile({ path, content: candidate, mode: info?.mode ?? 0o644, owner: String(info?.uid ?? 0), group: String(info?.gid ?? 0) })
  let refusal: string | null = null, accepted = false
  try {
    const test = await ctx.run(mariadbdCheckArgv(ctx.family))
    if (!test.ok) {
      refusal = test.stderr.split('\n')[0]?.slice(0, 200) || 'MariaDB refused the configuration file'
    } else {
      const restarted = await ctx.run([DB_SERVICE_SYSTEMCTL, 'restart', '--', unit])
      if (!restarted.ok) refusal = 'the service manager refused to restart MariaDB/MySQL'
      else accepted = await pings(ctx, verifySettings)
    }
  } catch { accepted = false }
  if (accepted) return
  const restored = await restore()
  return fail('CONFIG_TEST_FAILED', refusal ?? 'MariaDB/MySQL did not answer after applying configuration', restored
    ? { stateChanged: false, reason: reason + '_rejected', restored: true }
    : { stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: reason + '_restore_failed' })
}

export async function readMysqlView(ctx: DbServiceContext) {
  const view = await engineFacts(ctx), product = view.products.mariadb
  const running = !!product.installed && typeof product.service === 'object' && product.service?.active === 'active'
  const versionRaw = running ? await queryScalar(ctx, MYSQL_VERSION_SQL).catch(() => null) : null
  let version: string | null = null
  if (versionRaw) { try { version = parseMariadbVersion(versionRaw) } catch { version = null } }
  const settings = running ? await readSettingsMap(ctx) : null
  const configPath = mysqlDropInPath(ctx.family)
  const dropInText = await ctx.host.readFile(configPath).catch(() => null)
  const defaultLog = ctx.family === 'rhel' ? '/var/log/mariadb/mariadb.log' : '/var/log/mysql/error.log'
  const logFile = settings?.log_error && isMysqlLogPath(settings.log_error) ? settings.log_error : defaultLog
  const port = settings?.port ? Number(settings.port) : null
  const bindAddress = settings?.bind_address ?? null
  const skipNetworking = settings?.skip_networking ? settings.skip_networking === 'ON' : null
  return {
    engine: 'mysql',
    observedAt: view.observedAt,
    installed: product.installed,
    package: product.package,
    service: product.service,
    version,
    files: { config: configPath, data: settings?.datadir ?? null, log: logFile },
    settings: settings ? Object.fromEntries(Object.entries(settings).map(([name, value]) => [name, { value }])) : null,
    listenCheck: settings ? { port, bindAddress, skipNetworking, listening: skipNetworking === false && port !== null && port > 0 } : null,
    configRevision: revisionOf(dropInText ?? ''),
    dropInPresent: dropInText !== null,
  }
}

export async function controlMysql(ctx: DbServiceContext, body: unknown) {
  const { action } = exactBody(body, ['action'])
  if (!(DB_SERVICE_ACTIONS as readonly unknown[]).includes(action)) return fail('VALIDATION', 'unsupported service action', unchanged)
  const { unit } = await requireMysqlService(ctx)
  await ctx.assertFresh()
  const res = await ctx.run([DB_SERVICE_SYSTEMCTL, action as DbServiceAction, '--', unit])
  if (!res.ok) return fail('CONFIG_TEST_FAILED', 'the service manager refused this action', { stateChanged: true, verificationRequired: true, reason: 'mysql_control_failed' })
  const product = (await engineFacts(ctx)).products.mariadb
  const service = typeof product.service === 'object' ? product.service : null
  const expected = action === 'stop' ? service?.active !== 'active'
    : action === 'enable' ? service?.enabled === 'enabled'
      : action === 'disable' ? service?.enabled === 'disabled'
        : service?.active === 'active'
  if (!expected) return fail('SERVICE_UNAVAILABLE', 'the service did not reach the requested state', { stateChanged: true, verificationRequired: true, reason: 'mysql_control_unverified' })
  if ((action === 'start' || action === 'restart' || action === 'reload') && !(await pings(ctx))) {
    return fail('SERVICE_UNAVAILABLE', 'the service unit started but MariaDB did not answer ping', { stateChanged: true, verificationRequired: true, reason: 'mysql_ping_unverified' })
  }
  return { action, unit, active: service?.active ?? null, enabled: service?.enabled ?? null }
}

export async function readMysqlConfig(ctx: DbServiceContext) {
  await requireMysqlService(ctx)
  const path = mysqlDropInPath(ctx.family)
  const raw = await ctx.host.readFile(path)
  const text = raw ?? '# Managed by xPanel MySQL service (90-xpanel-mysql.cnf).\n[mysqld]\n'
  return { path, text, revision: revisionOf(raw ?? ''), present: raw !== null }
}

export async function previewMysqlConfig(ctx: DbServiceContext, body: unknown) {
  await requireMysqlService(ctx)
  const path = mysqlDropInPath(ctx.family)
  const currentText = await ctx.host.readFile(path)
  let proposedText: string
  if (body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'text') && Object.keys(body).length === 1) {
    proposedText = validateMysqlDropInText((body as { text: unknown }).text)
  } else {
    proposedText = renderMysqlDropIn(assertMysqlSettings(body))
  }
  const { diff, changed } = diffMysqlDropIn(currentText, proposedText)
  return { path, currentRevision: revisionOf(currentText ?? ''), currentText, proposedText, diff, changed }
}

export async function saveMysqlConfig(ctx: DbServiceContext, body: unknown) {
  const input = exactBody(body, ['text', 'expectedRevision'])
  const candidate = validateMysqlDropInText(input.text)
  if (typeof input.expectedRevision !== 'string') return fail('VALIDATION', 'expectedRevision must be a string', unchanged)
  const { unit } = await requireMysqlService(ctx)
  const path = mysqlDropInPath(ctx.family)
  const current = await ctx.host.readFile(path)
  if (input.expectedRevision !== revisionOf(current ?? '')) {
    return fail('CONFLICT', 'the file changed since it was read', { ...unchanged, reason: 'config_changed' })
  }
  await ctx.assertFresh()
  await withMysqlDropInRollback(ctx, path, unit, candidate, 'mysql_config')
  return { saved: true, path, revision: revisionOf(candidate) }
}

export async function saveMysqlSettings(ctx: DbServiceContext, body: unknown) {
  const settings = assertMysqlSettings(body)
  const { unit } = await requireMysqlService(ctx)
  const path = mysqlDropInPath(ctx.family)
  const candidate = renderMysqlDropIn(settings)
  await ctx.assertFresh()
  await withMysqlDropInRollback(ctx, path, unit, candidate, 'mysql_settings', async () => {
    const observed = await readSettingsMap(ctx)
    if (!observed) return false
    const skip = settings.skipNetworking ? 'ON' : 'OFF'
    return Number(observed.port) === settings.port
      && observed.bind_address === settings.bindAddress
      && Number(observed.max_connections) === settings.maxConnections
      && observed.skip_networking === skip
  })
  return { saved: true, restarted: true, path, revision: revisionOf(candidate) }
}

export async function readMysqlLog(ctx: DbServiceContext) {
  await requireMysqlService(ctx)
  const settings = await readSettingsMap(ctx)
  const defaultLog = ctx.family === 'rhel' ? '/var/log/mariadb/mariadb.log' : '/var/log/mysql/error.log'
  const path = settings?.log_error && settings.log_error.startsWith('/') ? settings.log_error : defaultLog
  if (!isMysqlLogPath(path)) return fail('PRECONDITION_FAILED', 'the MySQL log path is outside the reviewed paths', { ...unchanged, reason: 'mysql_log_path_unsupported' })
  return { path, lines: logLines(await ctx.fs.tail(path, LOG_TAIL_BYTES).catch(() => null)) }
}
