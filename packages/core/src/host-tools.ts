import { fail } from './errors.ts'
import { canonicalIp } from './rules/ip-pool.ts'
import { validateDomainName } from './rules/naming.ts'

/** Desired-state files of the scheduler and host tools, below the state root. Flat rows: the API, the forms and the renderers share one shape. */
export const HOST_TOOLS_STATE = {
  scheduler: 'extended/server/host-scheduler.json',
  savedCommands: 'extended/server/saved-commands.json',
  daemons: 'extended/server/daemons.json',
  watchdog: 'extended/server/service-watchdog.json',
  guardian: 'extended/server/php-guardian.json',
  linux: 'extended/server/linux-tools.json',
  frp: 'extended/server/frp.json',
  ddns: 'extended/server/ddns.json',
} as const

const unchanged = { stateChanged: false }
const refuse = (reason: string, message: string): never => fail('VALIDATION', message, { ...unchanged, reason })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
const ID = /^[a-z0-9]{12}$/
export const isHostToolId = (value: unknown): value is string => typeof value === 'string' && ID.test(value)

const text = (value: unknown, max: number, reason: string, what: string): string => {
  const out = typeof value === 'string' ? value.trim() : ''
  return out.length <= max && !CONTROL.test(out) ? out : refuse(reason, `${what} must be plain text of at most ${max} characters`)
}
const required = (value: unknown, max: number, reason: string, what: string): string => text(value, max, reason, what) || refuse(reason, `${what} is required`)
const whole = (value: unknown, min: number, max: number, reason: string, what: string): number => {
  const out = typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]{1,9}$/.test(value.trim()) ? Number(value) : NaN
  return Number.isSafeInteger(out) && out >= min && out <= max ? out : refuse(reason, `${what} must be a whole number from ${min} to ${max}`)
}
const flag = (value: unknown): boolean => value === true
const script = (value: unknown, max: number, reason: string, what: string): string => {
  const out = typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : ''
  return out.trim() && out.length <= max && !out.includes('\0') ? out : refuse(reason, `${what} must be non-empty text of at most ${max} characters`)
}
const lines = (value: unknown, maxLines: number, maxLength: number, reason: string, what: string): string[] => {
  const out = (typeof value === 'string' ? value : '').split('\n').map(line => line.replace(/\r$/, '').trim()).filter(Boolean)
  return out.length <= maxLines && out.every(line => line.length <= maxLength && !CONTROL.test(line)) ? out : refuse(reason, `${what} allows ${maxLines} lines of ${maxLength} characters`)
}
/** Absolute binary first, then one argument per line: the host receives an argv, so nothing here passes through a shell. */
export const hostCommandArgv = (value: unknown): string[] => {
  const argv = lines(value, 64, 1024, 'task_command_invalid', 'a command')
  return argv.length > 0 && /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/.test(argv[0]!) && !argv[0]!.split('/').includes('..')
    ? argv : refuse('task_command_invalid', 'a command is an absolute binary path followed by one argument per line')
}
const hostPath = (value: unknown, reason: string): string => {
  const path = required(value, 1024, reason, 'a directory')
  const parts = path.split('/')
  return path.startsWith('/') && path !== '/' && !parts.includes('..') && !['proc', 'sys', 'dev', 'run'].includes(parts[1]!) ? path : refuse(reason, 'an absolute directory outside /proc, /sys, /dev and /run is required')
}
const httpUrl = (value: unknown, reason: string): string => {
  const raw = required(value, 2000, reason, 'a URL')
  let url: URL
  try { url = new URL(raw) } catch { return refuse(reason, 'an http or https URL is required') }
  return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? raw : refuse(reason, 'an http or https URL without credentials is required')
}
const oneOf = <T extends string>(value: unknown, list: readonly T[], reason: string, what: string): T => list.includes(value as T) ? value as T : refuse(reason, `${what} is not recognised`)

// ---- Tasks, scripts, triggers, hooks ---------------------------------------------------------

export const HOST_TASK_TYPES = ['command', 'script', 'site-backup', 'database-backup', 'directory-backup', 'log-rotation', 'time-sync', 'memory-release', 'url'] as const
export type HostTaskType = (typeof HOST_TASK_TYPES)[number]
export const HOST_TASK_CYCLES = ['manual', 'seconds', 'minutes', 'hourly', 'hours', 'daily', 'days', 'weekly', 'monthly'] as const
export type HostTaskCycle = (typeof HOST_TASK_CYCLES)[number]
export const isBackupTask = (type: string): boolean => type.endsWith('-backup')
export interface HostTask {
  id: string; name: string; type: HostTaskType; cycle: HostTaskCycle; every: number; minute: number; hour: number; weekday: number; day: number
  enabled: boolean; chained: boolean; alert: boolean; remark: string; command: string; scriptId: string; target: string; keep: number; exclude: string
}
export const HOST_SCRIPT_LANGUAGES = { bash: '/bin/bash', python: '/usr/bin/python3' } as const
export const HOST_SCRIPT_RETURNS = ['string', 'integer', 'float'] as const
export interface HostScript { id: string; name: string; language: keyof typeof HOST_SCRIPT_LANGUAGES; returns: (typeof HOST_SCRIPT_RETURNS)[number]; args: string; remark: string; content: string }
export const HOST_TRIGGER_MATCHES = ['include', 'exclude', 'equal', 'not-equal'] as const
export interface HostTrigger { id: string; name: string; taskId: string; match: (typeof HOST_TRIGGER_MATCHES)[number]; value: string; targetId: string; remark: string }
export interface HostHook { id: string; name: string; scriptId: string; keyHash: string; createdAt: string }
export interface HostScheduler { tasks: HostTask[]; scripts: HostScript[]; triggers: HostTrigger[]; hooks: HostHook[] }
export const defaultHostScheduler = (): HostScheduler => ({ tasks: [], scripts: [], triggers: [], hooks: [] })
export const HOST_SCHEDULER_LIMITS = { tasks: 100, scripts: 100, triggers: 200, hooks: 50 } as const

/** Rows arrive as form fields or as saved values; both normalize to one shape, and unused fields keep neutral values so a revision stays stable. */
export function validateHostTask(raw: unknown): HostTask {
  if (!object(raw)) return refuse('task_invalid', 'a task object is required')
  const type = oneOf(raw.type, HOST_TASK_TYPES, 'task_type_invalid', 'the task type'), cycle = oneOf(raw.cycle, HOST_TASK_CYCLES, 'task_cycle_invalid', 'the cycle')
  const backup = isBackupTask(type)
  if (cycle === 'seconds' && backup) return refuse('task_cycle_invalid', 'a backup task cannot run on a cycle of seconds')
  const bounds: Partial<Record<HostTaskCycle, readonly [number, number]>> = { seconds: [10, 3600], minutes: [1, 59], hours: [1, 23], days: [2, 30] }
  const span = bounds[cycle], usesMinute = ['hourly', 'hours', 'daily', 'days', 'weekly', 'monthly'].includes(cycle), usesHour = ['daily', 'days', 'weekly', 'monthly'].includes(cycle)
  const domain = (): string => { try { return validateDomainName(raw.target) } catch { return refuse('task_target_invalid', 'a hosted domain is required') } }
  const target = type === 'url' ? httpUrl(raw.target, 'task_target_invalid')
    : type === 'directory-backup' ? hostPath(raw.target, 'task_target_invalid')
      : type === 'site-backup' ? domain()
        : type === 'database-backup' ? (typeof raw.target === 'string' && /^[A-Za-z0-9_$-]{1,64}$/.test(raw.target) ? raw.target : refuse('task_target_invalid', 'a database name is required'))
          : ''
  const task: HostTask = {
    id: isHostToolId(raw.id) ? raw.id : refuse('task_invalid', 'a task id is required'), name: required(raw.name, 80, 'task_name_invalid', 'a name'), type, cycle,
    every: span ? whole(raw.every, span[0], span[1], 'task_cycle_invalid', 'the interval') : 0,
    minute: usesMinute ? whole(raw.minute, 0, 59, 'task_cycle_invalid', 'the minute') : 0, hour: usesHour ? whole(raw.hour, 0, 23, 'task_cycle_invalid', 'the hour') : 0,
    weekday: cycle === 'weekly' ? whole(raw.weekday, 0, 6, 'task_cycle_invalid', 'the weekday') : 0, day: cycle === 'monthly' ? whole(raw.day, 1, 31, 'task_cycle_invalid', 'the day') : 0,
    enabled: flag(raw.enabled), chained: flag(raw.chained), alert: flag(raw.alert), remark: text(raw.remark, 200, 'task_remark_invalid', 'a remark'),
    command: type === 'command' ? hostCommandArgv(raw.command).join('\n') : '', scriptId: type === 'script' ? (isHostToolId(raw.scriptId) ? raw.scriptId : refuse('task_script_unknown', 'choose a library script')) : '',
    target, keep: backup ? whole(raw.keep, 1, 365, 'task_keep_invalid', 'the copies to keep') : 0,
    exclude: type === 'site-backup' || type === 'directory-backup' ? lines(raw.exclude, 32, 256, 'task_exclude_invalid', 'exclusions').join('\n') : '',
  }
  if (task.chained && type !== 'command' && type !== 'script') return refuse('task_type_invalid', 'a chained task runs a command or a library script')
  return task
}

export function validateHostScript(raw: unknown): HostScript {
  if (!object(raw)) return refuse('script_invalid', 'a script object is required')
  return {
    id: isHostToolId(raw.id) ? raw.id : refuse('script_invalid', 'a script id is required'), name: required(raw.name, 80, 'script_name_invalid', 'a name'),
    language: oneOf(raw.language, Object.keys(HOST_SCRIPT_LANGUAGES) as (keyof typeof HOST_SCRIPT_LANGUAGES)[], 'script_language_invalid', 'the script type'),
    returns: oneOf(raw.returns, HOST_SCRIPT_RETURNS, 'script_return_invalid', 'the return type'), args: lines(raw.args, 32, 1024, 'script_args_invalid', 'arguments').join('\n'),
    remark: text(raw.remark, 200, 'task_remark_invalid', 'a remark'), content: script(raw.content, 65536, 'script_content_invalid', 'the script'),
  }
}

export function validateHostTrigger(raw: unknown): HostTrigger {
  if (!object(raw)) return refuse('trigger_invalid', 'a trigger object is required')
  return {
    id: isHostToolId(raw.id) ? raw.id : refuse('trigger_invalid', 'a trigger id is required'), name: required(raw.name, 80, 'trigger_name_invalid', 'a name'),
    taskId: isHostToolId(raw.taskId) ? raw.taskId : refuse('trigger_task_unknown', 'choose the task to watch'), match: oneOf(raw.match, HOST_TRIGGER_MATCHES, 'trigger_match_invalid', 'the match type'),
    value: required(raw.value, 1024, 'trigger_value_invalid', 'the match text'), targetId: isHostToolId(raw.targetId) ? raw.targetId : refuse('trigger_task_unknown', 'choose the task to run'),
    remark: text(raw.remark, 200, 'task_remark_invalid', 'a remark'),
  }
}

const hookRow = (raw: unknown): HostHook => object(raw) && isHostToolId(raw.id) && isHostToolId(raw.scriptId) && typeof raw.keyHash === 'string' && /^[0-9a-f]{64}$/.test(raw.keyHash) && typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt))
  ? { id: raw.id, name: required(raw.name, 80, 'hook_name_invalid', 'a name'), scriptId: raw.scriptId, keyHash: raw.keyHash, createdAt: raw.createdAt } : refuse('hook_invalid', 'a saved hook is invalid')

/** Whole-file check: references resolve and triggers form no loop, because a trigger starts its target with no human in the way. */
export function validateHostScheduler(raw: unknown): HostScheduler {
  if (!object(raw) || !['tasks', 'scripts', 'triggers', 'hooks'].every(key => Array.isArray(raw[key]))) return refuse('scheduler_invalid', 'the saved scheduler is invalid')
  const state: HostScheduler = { tasks: (raw.tasks as unknown[]).map(validateHostTask), scripts: (raw.scripts as unknown[]).map(validateHostScript), triggers: (raw.triggers as unknown[]).map(validateHostTrigger), hooks: (raw.hooks as unknown[]).map(hookRow) }
  for (const key of ['tasks', 'scripts', 'triggers', 'hooks'] as const) if (state[key].length > HOST_SCHEDULER_LIMITS[key]) return refuse('scheduler_limit', `at most ${HOST_SCHEDULER_LIMITS[key]} ${key} are allowed`)
  const ids = [...state.tasks, ...state.scripts, ...state.triggers, ...state.hooks].map(item => item.id)
  if (new Set(ids).size !== ids.length) return refuse('scheduler_invalid', 'saved ids must be unique')
  const scripts = new Set(state.scripts.map(item => item.id)), tasks = new Set(state.tasks.map(item => item.id))
  if ([...state.tasks.filter(task => task.type === 'script'), ...state.hooks].some(item => !scripts.has(item.scriptId))) return refuse('task_script_unknown', 'a library script no longer exists')
  if (state.triggers.some(trigger => !tasks.has(trigger.taskId) || !tasks.has(trigger.targetId))) return refuse('trigger_task_unknown', 'a trigger names a task that does not exist')
  const next = new Map<string, string[]>()
  for (const trigger of state.triggers) next.set(trigger.taskId, [...next.get(trigger.taskId) ?? [], trigger.targetId])
  const done = new Set<string>()
  const visit = (id: string, path: ReadonlySet<string>): void => {
    if (path.has(id)) refuse('trigger_loop', 'triggers cannot form a loop')
    if (done.has(id)) return
    for (const target of next.get(id) ?? []) visit(target, new Set([...path, id]))
    done.add(id)
  }
  for (const id of next.keys()) visit(id, new Set())
  return state
}

/** Hooks never leave the API with their key digest. */
export const publicHostHook = (hook: HostHook): Omit<HostHook, 'keyHash'> => ({ id: hook.id, name: hook.name, scriptId: hook.scriptId, createdAt: hook.createdAt })

// ---- Saved terminal commands -----------------------------------------------------------------

export interface SavedCommand { id: string; name: string; content: string }
export const SAVED_COMMANDS_LIMIT = 200
export function validateSavedCommand(raw: unknown): SavedCommand {
  if (!object(raw) || !isHostToolId(raw.id)) return refuse('command_invalid', 'a saved command object is required')
  return { id: raw.id, name: required(raw.name, 80, 'task_name_invalid', 'a name'), content: script(raw.content, 4000, 'command_content_invalid', 'the command') }
}
export const validateSavedCommands = (raw: unknown): SavedCommand[] => {
  const list = Array.isArray(raw) ? raw.map(validateSavedCommand) : refuse('command_invalid', 'a list is required')
  return list.length <= SAVED_COMMANDS_LIMIT && new Set(list.map(item => item.id)).size === list.length ? list : refuse('command_invalid', `at most ${SAVED_COMMANDS_LIMIT} distinct commands are allowed`)
}

// ---- Daemons under systemd -------------------------------------------------------------------

export interface HostDaemonProfile { restartSec: number; burst: number; windowSec: number }
export interface HostDaemon { id: string; name: string; command: string; user: string; directory: string; restart: 'always' | 'on-failure'; enabled: boolean; remark: string }
export interface HostDaemons { profile: HostDaemonProfile; daemons: HostDaemon[] }
export const defaultHostDaemons = (): HostDaemons => ({ profile: { restartSec: 3, burst: 5, windowSec: 60 }, daemons: [] })
export const HOST_DAEMONS_LIMIT = 50
export const validateHostDaemonProfile = (raw: unknown): HostDaemonProfile => object(raw)
  ? { restartSec: whole(raw.restartSec, 1, 600, 'daemon_profile_invalid', 'the restart delay'), burst: whole(raw.burst, 1, 100, 'daemon_profile_invalid', 'the restart limit'), windowSec: whole(raw.windowSec, 10, 86400, 'daemon_profile_invalid', 'the restart window') }
  : refuse('daemon_profile_invalid', 'a profile object is required')
export function validateHostDaemon(raw: unknown): HostDaemon {
  if (!object(raw)) return refuse('daemon_invalid', 'a daemon object is required')
  const name = typeof raw.name === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(raw.name.trim()) ? raw.name.trim() : refuse('daemon_name_invalid', 'a name is 1 to 31 lowercase letters, digits or hyphens')
  const directory = text(raw.directory, 1024, 'daemon_directory_invalid', 'a directory')
  return {
    id: isHostToolId(raw.id) ? raw.id : refuse('daemon_invalid', 'a daemon id is required'), name, command: hostCommandArgv(raw.command).join('\n'),
    user: typeof raw.user === 'string' && /^(?:root|[a-z][a-z0-9]{0,15})$/.test(raw.user.trim()) ? raw.user.trim() : refuse('daemon_user_invalid', 'run as root or a hosting account'),
    directory: directory ? hostPath(directory, 'daemon_directory_invalid') : '', restart: oneOf(raw.restart, ['always', 'on-failure'] as const, 'daemon_restart_invalid', 'the restart policy'),
    enabled: flag(raw.enabled), remark: text(raw.remark, 200, 'task_remark_invalid', 'a remark'),
  }
}
export function validateHostDaemons(raw: unknown): HostDaemons {
  if (!object(raw) || !Array.isArray(raw.daemons)) return refuse('daemon_invalid', 'the saved daemons are invalid')
  const daemons = raw.daemons.map(validateHostDaemon)
  if (daemons.length > HOST_DAEMONS_LIMIT || new Set(daemons.map(item => item.name)).size !== daemons.length) return refuse('daemon_name_taken', `daemon names are unique, at most ${HOST_DAEMONS_LIMIT}`)
  return { profile: validateHostDaemonProfile(raw.profile), daemons }
}

// ---- Service watchdog and PHP guardian -------------------------------------------------------

/** Keyed by the host service id the restart path knows; each row says how its protocol answers on loopback. */
export const WATCHED_SERVICES = {
  nginx: { probe: 'http', port: 80 },
  postfix: { probe: 'smtp', port: 25 },
  dovecot: { probe: 'imap', port: 143 },
  mariadb: { probe: 'tcp', port: 3306 },
  pdns: { probe: 'dns', port: 53 },
  'pure-ftpd': { probe: 'tcp', port: 21 },
} as const
export type WatchedService = keyof typeof WATCHED_SERVICES
export interface WatchdogService { enabled: boolean; autoRestart: boolean; intervalSec: number }
export interface HostWatchdog { budgetPerHour: number; services: Record<string, WatchdogService> }
export const defaultHostWatchdog = (): HostWatchdog => ({ budgetPerHour: 2, services: {} })
export function validateHostWatchdog(raw: unknown): HostWatchdog {
  if (!object(raw) || !object(raw.services)) return refuse('watchdog_invalid', 'the watchdog settings are invalid')
  const services: Record<string, WatchdogService> = {}
  for (const [key, row] of Object.entries(raw.services)) {
    if (!Object.hasOwn(WATCHED_SERVICES, key) || !object(row)) return refuse('watchdog_invalid', 'an unknown service was named')
    services[key] = { enabled: flag(row.enabled), autoRestart: flag(row.autoRestart), intervalSec: whole(row.intervalSec, 60, 3600, 'watchdog_interval_invalid', 'the probe interval') }
  }
  return { budgetPerHour: whole(raw.budgetPerHour, 1, 12, 'watchdog_budget_invalid', 'the restart budget'), services }
}
export interface PhpGuardian { enabled: boolean; intervalSec: number; timeoutSec: number }
export const defaultPhpGuardian = (): PhpGuardian => ({ enabled: false, intervalSec: 300, timeoutSec: 5 })
export const validatePhpGuardian = (raw: unknown): PhpGuardian => object(raw)
  ? { enabled: flag(raw.enabled), intervalSec: whole(raw.intervalSec, 60, 3600, 'guardian_interval_invalid', 'the check interval'), timeoutSec: whole(raw.timeoutSec, 1, 30, 'guardian_timeout_invalid', 'the timeout') }
  : refuse('guardian_interval_invalid', 'the guardian settings are invalid')

// ---- Linux tools -----------------------------------------------------------------------------

export interface HostsEntry { id: string; ip: string; names: string }
export interface RamDisk { id: string; name: string; sizeMb: number }
export interface LinuxTools { timezone: string | null; swapMb: number; hosts: HostsEntry[]; ramDisks: RamDisk[] }
export const defaultLinuxTools = (): LinuxTools => ({ timezone: null, swapMb: 0, hosts: [], ramDisks: [] })
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/
export function validateHostsEntry(raw: unknown): HostsEntry {
  if (!object(raw) || !isHostToolId(raw.id)) return refuse('hosts_entry_invalid', 'a hosts entry object is required')
  let ip: string
  try { ip = canonicalIp(raw.ip).address } catch { return refuse('hosts_entry_invalid', 'an IP address is required') }
  const names = (typeof raw.names === 'string' ? raw.names : '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (names.length < 1 || names.length > 16 || names.some(name => name.length > 253 || !name.split('.').every(label => HOST_LABEL.test(label)))) return refuse('hosts_entry_invalid', 'one to sixteen host names are required')
  return { id: raw.id, ip, names: names.join(' ') }
}
export const isTimezoneName = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && /^(?:UTC|[A-Z][A-Za-z_+-]{1,32}(?:\/[A-Za-z0-9_+-]{1,32}){1,2})$/.test(value)
export function validateRamDisk(raw: unknown): RamDisk {
  if (!object(raw) || !isHostToolId(raw.id)) return refuse('ram_disk_invalid', 'a RAM disk object is required')
  return { id: raw.id, name: typeof raw.name === 'string' && /^[a-z][a-z0-9]{0,30}$/.test(raw.name.trim()) ? raw.name.trim() : refuse('ram_disk_invalid', 'a name is lowercase letters and digits'), sizeMb: whole(raw.sizeMb, 1, 65536, 'ram_disk_invalid', 'the size') }
}
export function validateLinuxTools(raw: unknown): LinuxTools {
  if (!object(raw) || !Array.isArray(raw.hosts) || !Array.isArray(raw.ramDisks) || !(raw.timezone === null || isTimezoneName(raw.timezone))) return refuse('linux_tools_invalid', 'the saved Linux tools are invalid')
  const ramDisks = raw.ramDisks.map(validateRamDisk), hosts = raw.hosts.map(validateHostsEntry)
  if (hosts.length > 200 || ramDisks.length > 8 || new Set(ramDisks.map(item => item.name)).size !== ramDisks.length) return refuse('linux_tools_invalid', 'too many entries, or a repeated RAM disk name')
  return { timezone: raw.timezone as string | null, swapMb: whole(raw.swapMb, 0, 65536, 'swap_size_invalid', 'the swap size'), hosts, ramDisks }
}

// ---- frp tunnels -----------------------------------------------------------------------------

export interface FrpProxy { id: string; name: string; localPort: number; remotePort: number }
export interface FrpState {
  server: { enabled: boolean; bindPort: number; token: string; portMin: number; portMax: number }
  client: { enabled: boolean; serverAddr: string; serverPort: number; token: string; proxies: FrpProxy[] }
}
export const defaultFrp = (): FrpState => ({ server: { enabled: false, bindPort: 7000, token: '', portMin: 7100, portMax: 7199 }, client: { enabled: false, serverAddr: '', serverPort: 7000, token: '', proxies: [] } })
const port = (value: unknown, reason: string): number => whole(value, 1024, 65535, reason, 'a port')
const frpToken = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]{0,128}$/.test(value) ? value : refuse('frp_token_invalid', 'a token is letters, digits, hyphen or underscore, at most 128 characters')
export function validateFrpProxy(raw: unknown): FrpProxy {
  if (!object(raw) || !isHostToolId(raw.id)) return refuse('frp_proxy_invalid', 'a tunnel object is required')
  return { id: raw.id, name: typeof raw.name === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(raw.name.trim()) ? raw.name.trim() : refuse('frp_proxy_invalid', 'a tunnel name is lowercase letters, digits or hyphens'), localPort: whole(raw.localPort, 1, 65535, 'frp_proxy_invalid', 'the local port'), remotePort: port(raw.remotePort, 'frp_proxy_invalid') }
}
export function validateFrp(raw: unknown): FrpState {
  if (!object(raw) || !object(raw.server) || !object(raw.client) || !Array.isArray(raw.client.proxies)) return refuse('frp_invalid', 'the saved frp settings are invalid')
  const { server, client } = raw, serverAddr = text(client.serverAddr, 253, 'frp_address_invalid', 'a server address')
  const state: FrpState = {
    server: { enabled: flag(server.enabled), bindPort: port(server.bindPort, 'frp_port_invalid'), token: frpToken(server.token), portMin: port(server.portMin, 'frp_port_invalid'), portMax: port(server.portMax, 'frp_port_invalid') },
    client: { enabled: flag(client.enabled), serverAddr, serverPort: port(client.serverPort, 'frp_port_invalid'), token: frpToken(client.token), proxies: (client.proxies as unknown[]).map(validateFrpProxy) },
  }
  if (state.server.portMax < state.server.portMin || state.server.portMax - state.server.portMin >= 1000 || state.server.bindPort >= state.server.portMin && state.server.bindPort <= state.server.portMax) return refuse('frp_port_invalid', 'the tunnel port range is at most 1000 ports and leaves out the service port')
  if (state.server.enabled && state.server.token.length < 16) return refuse('frp_token_invalid', 'the server needs a token of at least 16 characters')
  if (state.client.enabled && (!/^[a-z0-9.:-]{1,253}$/i.test(serverAddr) || !state.client.token)) return refuse('frp_address_invalid', 'the client needs a server address and a token')
  if (new Set(state.client.proxies.map(item => item.name)).size !== state.client.proxies.length || state.client.proxies.length > 50) return refuse('frp_proxy_invalid', 'tunnel names are unique, at most 50')
  return state
}
export const publicFrp = (state: FrpState) => ({ server: { ...state.server, token: '', tokenSet: state.server.token !== '' }, client: { ...state.client, token: '', tokenSet: state.client.token !== '' } })

// ---- Server dynamic DNS ----------------------------------------------------------------------

export const DDNS_PROVIDERS = ['local', 'cloudflare', 'dyndns2'] as const
export interface DdnsRecord { id: string; hostname: string; provider: (typeof DDNS_PROVIDERS)[number]; server: string; username: string; secret: string }
export interface DdnsState { intervalMinutes: number; ipSource: string; records: DdnsRecord[] }
export const defaultDdns = (): DdnsState => ({ intervalMinutes: 10, ipSource: 'https://api.ipify.org', records: [] })
export function validateDdnsRecord(raw: unknown): DdnsRecord {
  if (!object(raw) || !isHostToolId(raw.id)) return refuse('ddns_record_invalid', 'a record object is required')
  const provider = oneOf(raw.provider, DDNS_PROVIDERS, 'ddns_provider_invalid', 'the provider')
  let hostname: string
  try { hostname = validateDomainName(raw.hostname) } catch { return refuse('ddns_hostname_invalid', 'a host name is required') }
  const secret = typeof raw.secret === 'string' && raw.secret.length <= 256 && !CONTROL.test(raw.secret) ? raw.secret : refuse('ddns_secret_invalid', 'credentials are one line of at most 256 characters')
  if (provider !== 'local' && !secret) return refuse('ddns_secret_invalid', 'this provider needs credentials')
  return { id: raw.id, hostname, provider, server: provider === 'dyndns2' ? httpUrl(raw.server, 'ddns_server_invalid') : '', username: provider === 'dyndns2' ? required(raw.username, 128, 'ddns_secret_invalid', 'a user name') : '', secret: provider === 'local' ? '' : secret }
}
export function validateDdns(raw: unknown): DdnsState {
  if (!object(raw) || !Array.isArray(raw.records) || raw.records.length > 16) return refuse('ddns_invalid', 'the saved dynamic DNS settings are invalid')
  const records = raw.records.map(validateDdnsRecord)
  if (new Set(records.map(item => item.hostname)).size !== records.length) return refuse('ddns_hostname_invalid', 'each host name may be listed once')
  return { intervalMinutes: whole(raw.intervalMinutes, 5, 1440, 'ddns_interval_invalid', 'the check interval'), ipSource: httpUrl(raw.ipSource, 'ddns_source_invalid'), records }
}
export const publicDdnsRecord = (record: DdnsRecord) => ({ ...record, secret: '', secretSet: record.secret !== '' })
