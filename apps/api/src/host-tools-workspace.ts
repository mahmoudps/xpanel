import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import {
  defaultDdns, defaultFrp, defaultHostDaemons, defaultHostScheduler, defaultHostWatchdog, defaultLinuxTools, defaultPhpGuardian, fail, HOST_SCHEDULER_LIMITS, HOST_TOOLS_STATE, HOST_DAEMONS_LIMIT, isHostToolId, isTimezoneName, isXpanelError, publicDdnsRecord, publicFrp, publicHostHook,
  SAVED_COMMANDS_LIMIT, validateDdns, validateDdnsRecord, validateFrp, validateFrpProxy, validateHostDaemon, validateHostDaemonProfile, validateHostDaemons, validateHostScheduler, validateHostScript, validateHostsEntry, validateHostTask, validateHostTrigger, validateHostWatchdog,
  validateLinuxTools, validatePhpGuardian, validateRamDisk, validateSavedCommand, validateSavedCommands, WATCHED_SERVICES,
} from '@xpanel/core'
import type { DdnsState, FrpState, HostDaemons, HostScheduler, HostWatchdog, LinuxTools, PhpGuardian, SavedCommand } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { DDNS_STATUS_STATE, emptyDdnsStatus } from './host-ddns.ts'
import type { DdnsStatus } from './host-ddns.ts'
import { assertOwnSession, reauthenticate } from './identity-http.ts'
import type { ReauthenticationPorts } from './identity-http.ts'
import { assertExpectedRevision, panelConfigRevision, panelJson, readPanelConfigBody, stateConfigFile } from './panel-config-file.ts'
import type { PanelConfigFile } from './panel-config-file.ts'
import { assertPasswordAllowed } from './password-policy.ts'
import { saveAndReconcile } from './server-operations-workspace.ts'
import type { ServerOperationsHelpers } from './server-operations-workspace.ts'

export interface HostToolsHelpers extends ServerOperationsHelpers, Omit<ReauthenticationPorts, 'requireCaller' | 'emitAudit'> {
  /** Runs the saved records now; absent when the API has no background resources. */
  checkDdns?: () => Promise<unknown>
  /** Public origin of the panel entry point, which is the one that answers hooks. */
  hookOrigin?: string
}
const unchanged = { stateChanged: false }
const parsed = <T>(validate: (raw: unknown) => T) => (raw: unknown): T | null => { try { return validate(raw) } catch { return null } }
const secret = 0o600
type Store = HostToolsHelpers['store']
const files = (store: Store) => ({
  scheduler: stateConfigFile<HostScheduler>(store, HOST_TOOLS_STATE.scheduler, 'host-scheduler:v1', parsed(validateHostScheduler), defaultHostScheduler),
  commands: stateConfigFile<SavedCommand[]>(store, HOST_TOOLS_STATE.savedCommands, 'saved-commands:v1', parsed(validateSavedCommands), () => []),
  daemons: stateConfigFile<HostDaemons>(store, HOST_TOOLS_STATE.daemons, 'daemons:v1', parsed(validateHostDaemons), defaultHostDaemons),
  watchdog: stateConfigFile<HostWatchdog>(store, HOST_TOOLS_STATE.watchdog, 'service-watchdog:v1', parsed(validateHostWatchdog), defaultHostWatchdog),
  guardian: stateConfigFile<PhpGuardian>(store, HOST_TOOLS_STATE.guardian, 'php-guardian:v1', parsed(validatePhpGuardian), defaultPhpGuardian),
  linux: stateConfigFile<LinuxTools>(store, HOST_TOOLS_STATE.linux, 'linux-tools:v1', parsed(validateLinuxTools), defaultLinuxTools),
  frp: stateConfigFile<FrpState>(store, HOST_TOOLS_STATE.frp, 'frp:v1', parsed(validateFrp), defaultFrp, secret),
  ddns: stateConfigFile<DdnsState>(store, HOST_TOOLS_STATE.ddns, 'ddns:v1', parsed(validateDdns), defaultDdns, secret),
})
const NAMESPACE = { scheduler: 'host-scheduler:v1', commands: 'saved-commands:v1', daemons: 'daemons:v1', watchdog: 'service-watchdog:v1', guardian: 'php-guardian:v1', linux: 'linux-tools:v1', frp: 'frp:v1', ddns: 'ddns:v1' } as const
type FileKey = keyof typeof NAMESPACE

async function current<T>(file: PanelConfigFile<T>, namespace: string): Promise<{ value: T; revision: string }> {
  const { raw, value } = await file.read()
  if (value === null && raw !== null) return fail('PRECONDITION_FAILED', 'the saved setting is invalid; restore it before changing it', { ...unchanged, reason: 'server_setting_invalid' })
  return { value: value as T, revision: panelConfigRevision(namespace, raw) }
}
interface Context { request: Request; caller: AuthenticatedCaller; helpers: HostToolsHelpers; action: string }
const authority = (ctx: Context) => async (): Promise<void> => {
  const fresh = await ctx.helpers.requireCaller(ctx.request)
  if (fresh.principal.id !== ctx.caller.principal.id) fail('FORBIDDEN', 'server authority changed', unchanged)
  await ctx.helpers.assertRoot(fresh, ctx.action)
}
const audit = (ctx: Context, action: string, target: string, detail: Record<string, unknown> = {}): Promise<unknown> =>
  ctx.helpers.emitAudit({ actor: ctx.caller.principal.username, action, target, detail, outcome: 'ok', principalId: ctx.caller.principal.id })
const hostCall = (ctx: Context, path: string, body?: Record<string, unknown>): Promise<unknown> =>
  ctx.helpers.callHost ? ctx.helpers.callHost(ctx.caller, path, body) : fail('PRECONDITION_FAILED', 'no host agent is connected', { ...unchanged, reason: 'host_agent_unavailable' })
const hostRead = async <T>(ctx: Context, path: string): Promise<T | null> => {
  if (!ctx.helpers.callHost) return null
  try { return await ctx.helpers.callHost(ctx.caller, path) as T } catch (error) { if (isXpanelError(error)) return null; throw error }
}
const newId = (): string => randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12)
const revisionOf = (body: Record<string, unknown>): string => assertExpectedRevision(body.expectedRevision)
const withoutMeta = (body: Record<string, unknown>): Record<string, unknown> => { const { expectedRevision: _, ...rest } = body; return rest }

/** Saves one file; files the generation renders reconcile, and a refused generation restores the previous value. */
async function save<T>(ctx: Context, key: FileKey, next: T, expected: string, previous: T, reconcile: boolean): Promise<{ revision: string; reconcile: Record<string, unknown> | null }> {
  const file = (files(ctx.helpers.store) as unknown as Record<FileKey, PanelConfigFile<T>>)[key]
  if (reconcile) return saveAndReconcile(ctx, file, NAMESPACE[key], next, expected, previous)
  const saved = await file.write(next, expected, authority(ctx))
  return { revision: panelConfigRevision(NAMESPACE[key], saved.raw), reconcile: null }
}

// ---- Collections ------------------------------------------------------------------------------

interface Collection<State, Row extends { id: string }> {
  file: FileKey; label: string; limit: number; reconcile: boolean
  /** Rows that run as root on a schedule are written only from a signed-in panel session, like the root terminal. */
  executable?: boolean
  rows(state: State): Row[]
  put(state: State, rows: Row[]): State
  parse(raw: unknown, ctx: { previous: Row | null; state: State }): Row
  view?(row: Row): unknown
  check?(next: State): void
}
const scheduler = <K extends 'tasks' | 'scripts' | 'triggers'>(key: K, label: string, parse: (raw: unknown) => HostScheduler[K][number], executable: boolean): Collection<HostScheduler, HostScheduler[K][number]> => ({
  file: 'scheduler', label, limit: HOST_SCHEDULER_LIMITS[key], reconcile: true, executable, rows: state => state[key] as HostScheduler[K][number][], put: (state, rows) => ({ ...state, [key]: rows }), parse: raw => parse(raw), check: next => { validateHostScheduler(next) },
})
const COLLECTIONS: Readonly<Record<string, Collection<any, any>>> = { // eslint-disable-line @typescript-eslint/no-explicit-any
  tasks: scheduler('tasks', 'task', validateHostTask, true),
  scripts: scheduler('scripts', 'script', validateHostScript, true),
  triggers: scheduler('triggers', 'trigger', validateHostTrigger, true),
  'saved-commands': { file: 'commands', label: 'saved_command', limit: SAVED_COMMANDS_LIMIT, reconcile: false, executable: true, rows: (state: SavedCommand[]) => state, put: (_: SavedCommand[], rows: SavedCommand[]) => rows, parse: raw => validateSavedCommand(raw) },
  daemons: { file: 'daemons', label: 'daemon', limit: HOST_DAEMONS_LIMIT, reconcile: true, executable: true, rows: (state: HostDaemons) => state.daemons, put: (state: HostDaemons, daemons) => ({ ...state, daemons }), parse: raw => validateHostDaemon(raw), check: next => { validateHostDaemons(next) } },
  'hosts-file': { file: 'linux', label: 'hosts_entry', limit: 200, reconcile: true, rows: (state: LinuxTools) => state.hosts, put: (state: LinuxTools, hosts) => ({ ...state, hosts }), parse: raw => validateHostsEntry(raw) },
  'frp-tunnels': { file: 'frp', label: 'frp_tunnel', limit: 50, reconcile: true, rows: (state: FrpState) => state.client.proxies, put: (state: FrpState, proxies) => ({ ...state, client: { ...state.client, proxies } }), parse: raw => validateFrpProxy(raw), check: next => { validateFrp(next) } },
  ddns: { file: 'ddns', label: 'ddns_record', limit: 16, reconcile: false, rows: (state: DdnsState) => state.records, put: (state: DdnsState, records) => ({ ...state, records }), view: publicDdnsRecord, check: next => { validateDdns(next) },
    // An empty secret on an edit keeps the saved one; the value never leaves the API.
    parse: (raw, { previous }) => validateDdnsRecord({ secret: '', ...raw as object, ...((raw as { secret?: string }).secret ? {} : previous ? { secret: previous.secret } : {}) }) },
}

async function collectionRoute(ctx: Context, tool: string, collection: Collection<any, any>, method: string, id: string | undefined): Promise<Response> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { helpers } = ctx, file = (files(helpers.store) as unknown as Record<FileKey, PanelConfigFile<unknown>>)[collection.file]
  const read = await current(file, NAMESPACE[collection.file]), rows = collection.rows(read.value) as { id: string }[]
  if (method === 'GET') return panelJson({ revision: read.revision, rows: rows.map(row => collection.view?.(row) ?? row), ...await extras(ctx, tool, read.value) })
  if (collection.executable) assertOwnSession(ctx.caller)
  const body = await readPanelConfigBody(ctx.request, 131072), expected = revisionOf(body)
  if (method === 'DELETE') {
    if (!rows.some(row => row.id === id)) return fail('NOT_FOUND', 'no saved item has that id', { ...unchanged, reason: 'host_tool_unknown' })
    const next = collection.put(read.value, rows.filter(row => row.id !== id))
    collection.check?.(next)
    const result = await save(ctx, collection.file, next, expected, read.value, collection.reconcile)
    await audit(ctx, `server.${collection.label}.removed`, `${collection.label}:${id}`)
    return panelJson(result)
  }
  const previous = id === undefined ? null : rows.find(row => row.id === id) ?? null
  if (id !== undefined && !previous) return fail('NOT_FOUND', 'no saved item has that id', { ...unchanged, reason: 'host_tool_unknown' })
  if (id === undefined && rows.length >= collection.limit) return fail('LIMIT_EXCEEDED', 'the list is full', { ...unchanged, reason: 'host_tool_limit' })
  const row = collection.parse({ ...withoutMeta(body), id: id ?? newId() }, { previous, state: read.value }) as { id: string }
  if (tool === 'daemons') {
    const { user } = row as unknown as { user: string }
    if (user !== 'root' && !(await helpers.store.readSnapshot()).accounts.some(account => account.username === user)) return fail('VALIDATION', 'that hosting account does not exist', { ...unchanged, reason: 'daemon_user_unknown' })
  }
  const next = collection.put(read.value, id === undefined ? [...rows, row] : rows.map(item => item.id === id ? row : item))
  collection.check?.(next)
  const result = await save(ctx, collection.file, next, expected, read.value, collection.reconcile)
  await audit(ctx, id === undefined ? `server.${collection.label}.created` : `server.${collection.label}.updated`, `${collection.label}:${row.id}`)
  // A generation only starts units, so a saved change reaches a running process here, not on every reconcile.
  if (tool === 'daemons' && previous && (row as unknown as { enabled: boolean }).enabled) await hostCall(ctx, `/host/host-tools/daemon/${row.id}/restart`, {}).catch(() => undefined)
  if (tool === 'frp-tunnels') await restartFrp(ctx, read.value as FrpState, 'client')
  const lookup = tool === 'hosts-file' ? await hostRead<{ resolved?: boolean }>(ctx, `/host/host-tools/hosts-lookup?name=${encodeURIComponent((row as unknown as { names: string }).names.split(' ')[0]!)}`) : null
  return panelJson({ ...result, id: row.id, ...tool === 'hosts-file' ? { resolved: lookup?.resolved === true } : {} })
}

const lastRuns = async (ctx: Context): Promise<Record<string, unknown>> => (await hostRead<{ runs?: Record<string, unknown> }>(ctx, '/host/host-tools/runs'))?.runs ?? {}
async function extras(ctx: Context, tool: string, state: unknown): Promise<Record<string, unknown>> {
  if (tool === 'tasks' || tool === 'scripts' || tool === 'triggers') {
    const { tasks, scripts } = state as HostScheduler
    return { runs: await lastRuns(ctx), tasks: tasks.map(item => ({ id: item.id, name: item.name })), scripts: scripts.map(item => ({ id: item.id, name: item.name })) }
  }
  if (tool === 'daemons') return { units: (await hostRead<{ units?: unknown }>(ctx, '/host/host-tools/daemons'))?.units ?? {}, profile: (state as HostDaemons).profile }
  if (tool === 'ddns') return { status: await readJsonIfExists<DdnsStatus>(join(ctx.helpers.store.rootDir, DDNS_STATUS_STATE)).catch(() => null) ?? emptyDdnsStatus() }
  return {}
}

// ---- Runs and logs ----------------------------------------------------------------------------

async function assertRunnable(ctx: Context, id: string): Promise<void> {
  const state = (await current(files(ctx.helpers.store).scheduler, NAMESPACE.scheduler)).value
  if (![...state.tasks, ...state.scripts, ...state.triggers, ...state.hooks].some(item => item.id === id)) fail('NOT_FOUND', 'no saved item has that id', { ...unchanged, reason: 'host_tool_unknown' })
}
async function runVerb(ctx: Context, tool: string, id: string, verb: string, method: string): Promise<Response> {
  await assertRunnable(ctx, id)
  if (verb === 'log' && method === 'GET') return panelJson({ ...await hostCall(ctx, `/host/host-tools/log/${id}`) as object, ...tool === 'hooks' ? { runs: await readHookCalls(ctx.helpers.store, id) } : {} })
  if (verb === 'log' && method === 'DELETE') {
    const done = await hostCall(ctx, `/host/host-tools/log-clear/${id}`, {})
    await audit(ctx, 'server.task.log_cleared', `task:${id}`)
    return panelJson(done)
  }
  if (verb === 'run' && method === 'POST' && tool !== 'triggers') {
    const done = await hostCall(ctx, `/host/host-tools/run/${id}`, {})
    await audit(ctx, 'server.task.run_requested', `task:${id}`)
    return panelJson(done)
  }
  return new Response(null, { status: 405, headers: { allow: verb === 'log' ? 'GET, DELETE' : 'POST' } })
}

// ---- Inbound hooks ----------------------------------------------------------------------------

const HOOK_CALLS = 'extended/server/hook-calls.json'
const HOOK_CALLS_KEPT = 100, HOOK_WINDOW_MS = 60_000, HOOK_WINDOW_CALLS = 30
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
type HookCall = { at: string; ip: string | null; outcome: 'ran' | 'refused' | 'failed' | 'limited' }
const hookCallPath = (store: Pick<StateStore, 'rootDir'>): string => join(store.rootDir, HOOK_CALLS)
const readHookCalls = async (store: Pick<StateStore, 'rootDir'>, id: string): Promise<HookCall[]> => {
  const raw = await readJsonIfExists<Record<string, HookCall[]>>(hookCallPath(store)).catch(() => null)
  return (raw && Array.isArray(raw[id]) ? raw[id]! : []).slice().reverse()
}
const windows = new Map<string, number[]>()

export interface InboundHookPorts {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  /** Starts the unit as root through the protected agent channel; false when the host refused. */
  start: (id: string) => Promise<boolean>
  emitAudit: (entry: { actor: string; action: string; target: string; detail?: Record<string, unknown>; outcome: 'ok' | 'denied' | 'failed'; principalId?: null }) => Promise<unknown>
  now?: () => Date
}
/** POST /hook/<id> with the key in X-Hook-Key, so no access log holds it; compared by digest, and the body never reaches the script. */
export async function handleInboundHook(request: Request, url: URL, ip: string | null, ports: InboundHookPorts): Promise<Response> {
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
  const reply = (status: number, outcome?: string): Response => new Response(outcome ? JSON.stringify({ outcome }) : null, { status, headers: { ...headers, ...(outcome ? { 'content-type': 'application/json; charset=utf-8' } : {}) } })
  const id = url.pathname.slice('/hook/'.length), key = request.headers.get('x-hook-key') ?? ''
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } })
  const now = (ports.now ?? (() => new Date()))(), at = now.getTime()
  if (!isHostToolId(id)) return reply(403)
  const state = await readJsonIfExists<unknown>(join(ports.store.rootDir, HOST_TOOLS_STATE.scheduler)).then(raw => raw === null ? null : validateHostScheduler(raw)).catch(() => null)
  const hook = state?.hooks.find(item => item.id === id)
  // Only saved hooks reach the limiter, so a scan of made-up ids cannot grow it.
  if (!hook) return reply(403)
  const recent = (windows.get(id) ?? []).filter(time => at - time < HOOK_WINDOW_MS)
  windows.set(id, [...recent, at])
  const record = async (outcome: HookCall['outcome']): Promise<void> => {
    const lease = await ports.store.getWriterLock().acquire()
    try {
      const raw = await readJsonIfExists<Record<string, HookCall[]>>(hookCallPath(ports.store)).catch(() => null) ?? {}
      await atomicWriteJson(hookCallPath(ports.store), { ...raw, [id]: [...raw[id] ?? [], { at: now.toISOString(), ip, outcome }].slice(-HOOK_CALLS_KEPT) }, 0o640)
    } finally { await lease.release() }
  }
  if (recent.length >= HOOK_WINDOW_CALLS) return reply(429)
  const audit = (outcome: 'ok' | 'denied'): Promise<unknown> => ports.emitAudit({ actor: 'anonymous', action: 'server.hook.called', target: `hook:${id}`, detail: { ip }, outcome, principalId: null })
  if (!key || !timingSafeEqual(Buffer.from(hook.keyHash, 'hex'), Buffer.from(digest(key), 'hex'))) { await audit('denied').catch(() => undefined); await record('refused'); return reply(403) }
  // A call that cannot be recorded does not run.
  try { await audit('ok') } catch { return reply(503) }
  const started = await ports.start(id).catch(() => false)
  await record(started ? 'ran' : 'failed')
  return started ? reply(202, 'started') : reply(503)
}

async function hooksRoute(ctx: Context, method: string, id: string | undefined, verb: string | undefined): Promise<Response> {
  const file = files(ctx.helpers.store).scheduler, read = await current(file, NAMESPACE.scheduler), hooks = read.value.hooks
  if (method === 'GET' && !id) return panelJson({ revision: read.revision, rows: hooks.map(publicHostHook), scripts: read.value.scripts.map(item => ({ id: item.id, name: item.name })), runs: await lastRuns(ctx) })
  if (method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } })
  assertOwnSession(ctx.caller)
  const body = await readPanelConfigBody(ctx.request), expected = revisionOf(body)
  const call = (hook: string, key: string): string => `curl -X POST -H 'X-Hook-Key: ${key}' ${ctx.helpers.hookOrigin ?? ''}/hook/${hook}`
  const issue = (): { key: string; keyHash: string } => { const key = randomBytes(32).toString('base64url'); return { key, keyHash: digest(key) } }
  if (method === 'POST' && !id) {
    if (hooks.length >= HOST_SCHEDULER_LIMITS.hooks) return fail('LIMIT_EXCEEDED', 'the list is full', { ...unchanged, reason: 'host_tool_limit' })
    const { key, keyHash } = issue(), hook = { id: newId(), name: typeof body.name === 'string' ? body.name.trim() : '', scriptId: String(body.scriptId), keyHash, createdAt: new Date().toISOString() }
    const next = validateHostScheduler({ ...read.value, hooks: [...hooks, hook] })
    const result = await saveAndReconcile(ctx, file, NAMESPACE.scheduler, next, expected, read.value)
    await audit(ctx, 'server.hook.created', `hook:${hook.id}`)
    return panelJson({ ...result, id: hook.id, reveal: call(hook.id, key) })
  }
  const hook = hooks.find(item => item.id === id)
  if (!hook) return fail('NOT_FOUND', 'no saved item has that id', { ...unchanged, reason: 'host_tool_unknown' })
  if (method === 'POST' && verb === 'rotate') {
    const { key, keyHash } = issue()
    const result = await saveAndReconcile(ctx, file, NAMESPACE.scheduler, { ...read.value, hooks: hooks.map(item => item.id === id ? { ...item, keyHash } : item) }, expected, read.value)
    await audit(ctx, 'server.hook.rotated', `hook:${id}`)
    return panelJson({ ...result, id, reveal: call(hook.id, key) })
  }
  if (method !== 'DELETE' || verb) return new Response(null, { status: 405, headers: { allow: 'GET, POST, DELETE' } })
  const result = await saveAndReconcile(ctx, file, NAMESPACE.scheduler, { ...read.value, hooks: hooks.filter(item => item.id !== id) }, expected, read.value)
  await audit(ctx, 'server.hook.removed', `hook:${id}`)
  return panelJson(result)
}

// ---- Single settings --------------------------------------------------------------------------

async function watchdogRoute(ctx: Context, method: string, id: string | undefined): Promise<Response> {
  const read = await current(files(ctx.helpers.store).watchdog, NAMESPACE.watchdog)
  if (method === 'GET') {
    const events = (await hostRead<{ events?: { at: string; target: string; kind: string }[] }>(ctx, '/host/host-tools/watch'))?.events ?? []
    return panelJson({ revision: read.revision, budgetPerHour: read.value.budgetPerHour, log: events.filter(item => Object.hasOwn(WATCHED_SERVICES, item.target)).map(item => `${item.at} ${item.target} ${item.kind}`).join('\n'),
      rows: Object.entries(WATCHED_SERVICES).map(([key, spec]) => ({ id: key, name: key, probe: spec.probe, port: spec.port, enabled: false, autoRestart: false, intervalSec: 60, budgetPerHour: read.value.budgetPerHour, ...read.value.services[key] })) })
  }
  if (!id || !Object.hasOwn(WATCHED_SERVICES, id)) return fail('NOT_FOUND', 'that service is not watched', { ...unchanged, reason: 'host_tool_unknown' })
  const body = await readPanelConfigBody(ctx.request)
  const next = validateHostWatchdog({ budgetPerHour: body.budgetPerHour, services: { ...read.value.services, [id]: { enabled: body.enabled, autoRestart: body.autoRestart, intervalSec: body.intervalSec } } })
  const result = await save(ctx, 'watchdog', next, revisionOf(body), read.value, false)
  await audit(ctx, 'server.watchdog.updated', `service:${id}`, { enabled: next.services[id]!.enabled, autoRestart: next.services[id]!.autoRestart })
  return panelJson(result)
}

async function guardianRoute(ctx: Context, method: string): Promise<Response> {
  const read = await current(files(ctx.helpers.store).guardian, NAMESPACE.guardian)
  if (method === 'GET') {
    const events = (await hostRead<{ events?: { at: string; target: string; kind: string }[] }>(ctx, '/host/host-tools/watch'))?.events ?? []
    return panelJson({ revision: read.revision, ...read.value, log: events.filter(item => item.target.includes(':')).map(item => `${item.at} ${item.target} ${item.kind}`).join('\n') })
  }
  const body = await readPanelConfigBody(ctx.request), next = validatePhpGuardian(withoutMeta(body))
  const result = await save(ctx, 'guardian', next, revisionOf(body), read.value, false)
  await audit(ctx, 'server.php_guardian.updated', 'server:php-guardian', { enabled: next.enabled })
  return panelJson(result)
}

async function daemonProfileRoute(ctx: Context, method: string): Promise<Response> {
  const read = await current(files(ctx.helpers.store).daemons, NAMESPACE.daemons)
  if (method === 'GET') return panelJson({ revision: read.revision, ...read.value.profile })
  const body = await readPanelConfigBody(ctx.request)
  const result = await save(ctx, 'daemons', { ...read.value, profile: validateHostDaemonProfile(withoutMeta(body)) }, revisionOf(body), read.value, true)
  await audit(ctx, 'server.daemon_profile.updated', 'server:daemons')
  return panelJson(result)
}

async function linuxRoute(ctx: Context, tool: string, method: string, id: string | undefined): Promise<Response> {
  const read = await current(files(ctx.helpers.store).linux, NAMESPACE.linux)
  if (method === 'GET') {
    const observed = await hostRead<{ timezone: string | null; swapTotalMb: number; swapFileMb: number; ramDisks: string[] }>(ctx, '/host/host-tools/linux')
    return panelJson({ revision: read.revision, timezone: read.value.timezone ?? observed?.timezone ?? '', swapMb: read.value.swapMb, swapTotalMb: observed?.swapTotalMb ?? null, observedTimezone: observed?.timezone ?? null,
      rows: read.value.ramDisks.map(item => ({ ...item, mounted: observed?.ramDisks.includes(item.name) ?? false })) })
  }
  const body = await readPanelConfigBody(ctx.request), expected = revisionOf(body)
  if (tool === 'timezone') {
    if (!isTimezoneName(body.timezone)) return fail('VALIDATION', 'a time zone name is required', { ...unchanged, reason: 'timezone_invalid' })
    const done = await hostCall(ctx, '/host/host-tools/timezone', { zone: body.timezone }) as { applied?: boolean }
    const result = await save(ctx, 'linux', { ...read.value, timezone: body.timezone }, expected, read.value, false)
    await audit(ctx, 'server.timezone.changed', 'server:timezone', { timezone: body.timezone })
    return panelJson({ ...result, applied: done.applied === true })
  }
  if (tool === 'swap') {
    const next = validateLinuxTools({ ...read.value, swapMb: body.swapMb })
    const result = await save(ctx, 'linux', next, expected, read.value, false)
    const done = await hostCall(ctx, '/host/host-tools/swap', { sizeMb: next.swapMb }) as { job?: unknown }
    await audit(ctx, 'server.swap.changed', 'server:swap', { sizeMb: next.swapMb })
    return panelJson({ ...result, job: done.job ?? null })
  }
  const disks = read.value.ramDisks
  if (method === 'DELETE') {
    const disk = disks.find(item => item.id === id)
    if (!disk) return fail('NOT_FOUND', 'no saved item has that id', { ...unchanged, reason: 'host_tool_unknown' })
    await hostCall(ctx, '/host/host-tools/ram-disk', { name: disk.name, sizeMb: disk.sizeMb, mounted: false }).catch(() => undefined)
    const result = await save(ctx, 'linux', { ...read.value, ramDisks: disks.filter(item => item.id !== id) }, expected, read.value, false)
    await audit(ctx, 'server.ram_disk.removed', `ram-disk:${disk.name}`)
    return panelJson(result)
  }
  const saved = disks.find(item => item.id === id)
  const disk = saved ?? validateRamDisk({ ...withoutMeta(body), id: newId() })
  if (!saved && disks.some(item => item.name === disk.name)) return fail('CONFLICT', 'this name is already used', { ...unchanged, reason: 'ram_disk_invalid' })
  const done = await hostCall(ctx, '/host/host-tools/ram-disk', { name: disk.name, sizeMb: disk.sizeMb, mounted: true }) as { applied?: boolean }
  const result = saved ? { revision: read.revision, reconcile: null } : await save(ctx, 'linux', validateLinuxTools({ ...read.value, ramDisks: [...disks, disk] }), expected, read.value, false)
  await audit(ctx, 'server.ram_disk.created', `ram-disk:${disk.name}`, { sizeMb: disk.sizeMb })
  return panelJson({ ...result, applied: done.applied === true })
}

async function passwordRoute(ctx: Context): Promise<Response> {
  assertOwnSession(ctx.caller)
  if (!ctx.request.headers.get('origin')) return fail('FORBIDDEN', 'a system password must be changed from the panel page', unchanged)
  const body = await readPanelConfigBody(ctx.request, 4096)
  if (typeof body.password !== 'string') return fail('VALIDATION', 'a password is required', { ...unchanged, reason: 'system_user_invalid' })
  assertPasswordAllowed(body.password, 'panel')
  const fresh = await reauthenticate(ctx.request, ctx.caller, ctx.helpers, { password: body.currentPassword, totpCode: body.totpCode, action: 'system_user_password', secondFactor: true })
  const done = await hostCall({ ...ctx, caller: fresh }, '/host/host-tools/password', { user: body.user, password: body.password })
  await ctx.helpers.emitAudit({ actor: fresh.principal.username, principalId: fresh.principal.id, action: 'server.system_user.password_changed', target: `system-user:${String(body.user)}`, outcome: 'ok' })
  return panelJson(done)
}

async function frpRoute(ctx: Context, tool: string, method: string): Promise<Response> {
  const read = await current(files(ctx.helpers.store).frp, NAMESPACE.frp), view = publicFrp(read.value)
  type Observed = { version: string; installed: boolean; server: Record<string, string>; client: Record<string, string> }
  if (tool === 'frp-install') {
    assertOwnSession(ctx.caller)
    const done = await hostCall(ctx, '/host/host-tools/frp-install', {})
    await audit(ctx, 'server.frp.installed', 'server:frp')
    return panelJson(done)
  }
  const side = tool === 'frp-server' ? 'server' : 'client'
  if (method === 'GET') {
    const observed = await hostRead<Observed>(ctx, '/host/host-tools/frp')
    return panelJson({ revision: read.revision, ...view[side], version: observed?.version ?? null, installed: observed?.installed ?? null, unitState: observed?.[side].ActiveState ?? null })
  }
  const body = await readPanelConfigBody(ctx.request), input = withoutMeta(body)
  const token = typeof input.token === 'string' && input.token !== '' ? input.token : read.value[side].token
  const next = validateFrp({ ...read.value, [side]: { ...read.value[side], ...input, token } })
  if (next[side].enabled && !(await hostRead<Observed>(ctx, '/host/host-tools/frp'))?.installed) return fail('PRECONDITION_FAILED', 'install frp on this server first', { ...unchanged, reason: 'frp_not_installed' })
  const result = await save(ctx, 'frp', next, revisionOf(body), read.value, true)
  await restartFrp(ctx, next, side)
  await audit(ctx, `server.frp_${side}.updated`, 'server:frp', { enabled: next[side].enabled })
  return panelJson(result)
}

const restartFrp = async (ctx: Context, state: FrpState, side: 'server' | 'client'): Promise<void> => { if (state[side].enabled) await hostCall(ctx, `/host/host-tools/frp-unit/${side}/restart`, {}).catch(() => undefined) }

async function ddnsSettingsRoute(ctx: Context, method: string): Promise<Response> {
  const read = await current(files(ctx.helpers.store).ddns, NAMESPACE.ddns)
  if (method === 'GET') return panelJson({ revision: read.revision, intervalMinutes: read.value.intervalMinutes, ipSource: read.value.ipSource })
  const body = await readPanelConfigBody(ctx.request)
  const result = await save(ctx, 'ddns', validateDdns({ ...read.value, intervalMinutes: body.intervalMinutes, ipSource: body.ipSource }), revisionOf(body), read.value, false)
  await audit(ctx, 'server.ddns.updated', 'server:ddns')
  return panelJson(result)
}

async function logCleanupRoute(ctx: Context, method: string): Promise<Response> {
  if (method === 'GET') {
    const read = await hostRead<{ observedAt: string; rows: { id: string; files: number; bytes: number }[] }>(ctx, '/host/host-tools/log-cleanup')
    return panelJson({ observedAt: read?.observedAt ?? null, rows: read?.rows.map(row => ({ id: row.id, name: row.id, files: row.files, bytes: row.bytes })) ?? [] })
  }
  const body = await readPanelConfigBody(ctx.request)
  const categories = ['web', 'mail', 'system', 'site', 'journal'].filter(id => body[id] === true)
  const done = await hostCall(ctx, '/host/host-tools/log-cleanup', { categories }) as { freedBytes: number; removed: number; failed: number }
  await audit(ctx, 'server.log_cleanup.ran', 'server:logs', { categories, freedBytes: done.freedBytes, removed: done.removed, failed: done.failed })
  return panelJson({ freedBytes: done.freedBytes, removed: done.removed, failed: done.failed })
}

const SINGLE: Readonly<Record<string, string>> = { watchdog: 'GET, PUT', 'php-guardian': 'GET, PUT', 'daemon-profile': 'GET, PUT', timezone: 'GET, PUT', swap: 'GET, PUT', 'ram-disks': 'GET, POST, DELETE', password: 'POST', 'frp-server': 'GET, PUT', 'frp-client': 'GET, PUT', 'frp-install': 'POST', 'ddns-settings': 'GET, PUT', 'log-cleanup': 'GET, POST' }
const ROUTE = /^\/api\/server\/host-tools\/([a-z-]{2,20})(?:\/([a-z0-9-]{1,20}))?(?:\/([a-z]{3,8}))?$/

export async function handleHostToolsRoute(request: Request, url: URL, method: string, helpers: HostToolsHelpers): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const [, tool, id, verb] = match as unknown as [string, string, string | undefined, string | undefined]
  const collection = Object.hasOwn(COLLECTIONS, tool) ? COLLECTIONS[tool]! : null
  if (!collection && tool !== 'hooks' && !Object.hasOwn(SINGLE, tool)) return null
  const action = `server.host_tools.${tool.replaceAll('-', '_')}`, caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, method === 'GET' ? `${action}.read` : action)
  if (url.search) return fail('VALIDATION', 'host tools accept no query selectors', unchanged)
  const ctx: Context = { request, caller, helpers, action }
  if (tool === 'hooks' && verb !== 'run' && verb !== 'log') return hooksRoute(ctx, method, id, verb)
  if (tool === 'daemons' && verb) {
    if (!isHostToolId(id) || !['start', 'stop', 'restart', 'log'].includes(verb)) return null
    if (verb === 'log') return method === 'GET' ? panelJson(await hostCall(ctx, `/host/host-tools/daemon/${id}/log`)) : new Response(null, { status: 405, headers: { allow: 'GET' } })
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const done = await hostCall(ctx, `/host/host-tools/daemon/${id}/${verb}`, {})
    await audit(ctx, 'server.daemon.action', `daemon:${id}`, { verb })
    return panelJson(done)
  }
  if ((tool === 'frp-server' || tool === 'frp-client') && id === 'log') return method === 'GET' ? panelJson(await hostCall(ctx, `/host/host-tools/frp-unit/${tool === 'frp-server' ? 'server' : 'client'}`)) : new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (tool === 'ddns' && id === 'check') {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    return panelJson({ status: await helpers.checkDdns?.() ?? null })
  }
  if (verb === 'run' || verb === 'log') {
    if (!isHostToolId(id) || !['tasks', 'scripts', 'triggers', 'hooks'].includes(tool)) return null
    return runVerb(ctx, tool, id, verb, method)
  }
  if (collection) {
    const allow = id ? 'PUT, DELETE' : 'GET, POST'
    if (!allow.split(', ').includes(method) || verb) return new Response(null, { status: 405, headers: { allow } })
    return collectionRoute(ctx, tool, collection, method, id)
  }
  const allow = SINGLE[tool]!
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  switch (tool) {
    case 'watchdog': return watchdogRoute(ctx, method, id)
    case 'php-guardian': return guardianRoute(ctx, method)
    case 'daemon-profile': return daemonProfileRoute(ctx, method)
    case 'timezone': case 'swap': case 'ram-disks': return linuxRoute(ctx, tool, method, id)
    case 'password': return passwordRoute(ctx)
    case 'frp-server': case 'frp-client': case 'frp-install': return frpRoute(ctx, tool, method)
    case 'ddns-settings': return ddnsSettingsRoute(ctx, method)
    default: return logCleanupRoute(ctx, method)
  }
}
