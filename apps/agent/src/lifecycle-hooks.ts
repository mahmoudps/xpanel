import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { nodeUpgradeFs, readTrustedFile } from './upgrade-observation.ts'
import type { UpgradeHostFs } from './upgrade-observation.ts'

/**
 * WHM Manage Hooks: reviewed executables registered for lifecycle events. Root registers a file from the reviewed
 * directory and its SHA-256 is pinned; every run re-checks ownership, mode and digest, passes the event and the
 * account's enhancements as JSON on stdin (argv-only, no shell), runs it as nobody without new privileges under a
 * timeout, and is audited. No shipped hook point needs root. State: extended/panel/hooks.json; its order is the
 * execution order.
 */
export const HOOK_POINTS = Object.freeze({
  'account.create': ['post'],
  'account.suspend': ['pre', 'post'],
  'account.unsuspend': ['pre', 'post'],
  'account.terminate': ['pre', 'post'],
} as const)
export type HookPoint = keyof typeof HOOK_POINTS
export type HookStage = 'pre' | 'post'
export interface HookEntry {
  id: string; point: HookPoint; stage: HookStage; executable: string; sha256: string; args: string[]
  timeoutSeconds: number; enabled: boolean; blocking: boolean; description: string
}
/** Effective account enhancements; null when the saved enhancements cannot be verified. */
export type HookEnhancements = Record<string, true | number> | null
export interface HookEvent { point: HookPoint; stage: HookStage; account: { id: string; username: string; primaryDomain: string }; enhancements: HookEnhancements }
export type HookOutcome = 'ok' | 'failed' | 'timeout' | 'refused'
export interface HookRunResult { id: string; outcome: HookOutcome; exitCode: number | null; durationMs: number; reason: string | null }
export interface HookRunner { run(argv: readonly string[], stdin: string, timeoutMs: number): Promise<{ exitCode: number | null; timedOut: boolean }> }

export const HOOKS_DIRECTORY = '/usr/local/libexec/xpanel/hooks'
export const HOOKS_STATE_PATH = 'extended/panel/hooks.json'
export const HOOK_LIMITS = Object.freeze({ hooks: 64, args: 16, argBytes: 256, timeoutSeconds: 60, executableBytes: 1024 * 1024, description: 120, queue: 16, enhancements: 50 })
const NOBODY = 65534
const unchanged = { stateChanged: false }
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).sort().join() === [...keys].sort().join()
const plain = (value: unknown, max: number): value is string => typeof value === 'string' && Buffer.byteLength(value) <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)

export const isHookPoint = (value: unknown): value is HookPoint => typeof value === 'string' && Object.hasOwn(HOOK_POINTS, value)
export const hookStageAllowed = (point: HookPoint, stage: unknown): stage is HookStage => (HOOK_POINTS[point] as readonly string[]).includes(stage as string)
export const isHookExecutable = (value: unknown): value is string => typeof value === 'string' && value.startsWith(HOOKS_DIRECTORY + '/') && NAME.test(value.slice(HOOKS_DIRECTORY.length + 1))
export const isHookArgs = (value: unknown): value is string[] => Array.isArray(value) && value.length <= HOOK_LIMITS.args && value.every(arg => plain(arg, HOOK_LIMITS.argBytes))

export function parseHookEntry(value: unknown): HookEntry | null {
  if (!object(value) || !exact(value, ['id', 'point', 'stage', 'executable', 'sha256', 'args', 'timeoutSeconds', 'enabled', 'blocking', 'description'])
    || typeof value.id !== 'string' || !ID.test(value.id) || !isHookPoint(value.point) || !hookStageAllowed(value.point, value.stage) || !isHookExecutable(value.executable)
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256) || !isHookArgs(value.args)
    || !Number.isSafeInteger(value.timeoutSeconds) || (value.timeoutSeconds as number) < 1 || (value.timeoutSeconds as number) > HOOK_LIMITS.timeoutSeconds
    || typeof value.enabled !== 'boolean' || typeof value.blocking !== 'boolean' || (value.blocking && value.stage !== 'pre') || !plain(value.description, HOOK_LIMITS.description)) return null
  return { id: value.id, point: value.point, stage: value.stage, executable: value.executable, sha256: value.sha256, args: [...value.args], timeoutSeconds: value.timeoutSeconds as number,
    enabled: value.enabled, blocking: value.blocking, description: value.description }
}

/** The whole saved record ({version,hooks,updatedAt}); null when any part fails its grammar. */
export function parseHookRegistry(raw: unknown): HookEntry[] | null {
  if (!object(raw) || !exact(raw, ['version', 'hooks', 'updatedAt']) || raw.version !== 1 || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))
    || !Array.isArray(raw.hooks) || raw.hooks.length > HOOK_LIMITS.hooks) return null
  const hooks = raw.hooks.map(parseHookEntry)
  return hooks.every(hook => hook !== null) && new Set(hooks.map(hook => hook!.id)).size === hooks.length ? hooks as HookEntry[] : null
}

export async function readHookRegistry(rootDir: string): Promise<HookEntry[]> {
  let text: string
  try { text = await readFile(join(rootDir, HOOKS_STATE_PATH), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; return fail('PRECONDITION_FAILED', 'the hook registry cannot be read', { ...unchanged, reason: 'hook_registry_unreadable' }) }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { raw = null }
  return parseHookRegistry(raw) ?? fail('PRECONDITION_FAILED', 'the hook registry is invalid', { ...unchanged, reason: 'hook_registry_invalid' })
}

/** Root-owned regular file in the reviewed directory, not group/other writable, readable and executable by nobody. */
export async function inspectHookExecutable(path: string, fs: UpgradeHostFs = nodeUpgradeFs): Promise<{ sha256: string; bytes: number } | { reason: string }> {
  if (!isHookExecutable(path)) return { reason: 'hook_path_not_reviewed' }
  let bytes: Buffer | null
  try { bytes = await readTrustedFile(fs, path, HOOK_LIMITS.executableBytes) } catch { return { reason: 'hook_executable_untrusted' } }
  if (bytes === null) return { reason: 'hook_executable_missing' }
  const facts = await fs.lstat(path)
  if (!facts || (facts.mode & 0o005) !== 0o005 || (facts.mode & 0o6000) !== 0) return { reason: 'hook_executable_mode' }
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
}

/** setpriv drops to nobody with no supplementary groups and no new privileges before the hook starts. */
export const hookArgv = (hook: Pick<HookEntry, 'executable' | 'args'>): string[] =>
  ['/usr/bin/setpriv', '--reuid', String(NOBODY), '--regid', String(NOBODY), '--clear-groups', '--no-new-privs', '--', hook.executable, ...hook.args]

export function createSystemHookRunner(): HookRunner {
  return { run: (argv, stdin, timeoutMs) => new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: '/', shell: false, detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8', HOME: '/', XPANEL_HOOK: '1' } })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ } }, timeoutMs)
    child.stdin.on('error', () => { /* A hook may exit without reading its event. */ })
    child.once('error', () => { clearTimeout(timer); reject(new Error('hook_spawn_failed')) })
    child.once('close', code => { clearTimeout(timer); resolve({ exitCode: code, timedOut }) })
    child.stdin.end(stdin)
  }) }
}

// One hook run at a time keeps the 1 vCPU budget; a full queue refuses instead of piling up children.
let queue: Promise<unknown> = Promise.resolve(), waiting = 0
const serialized = <T>(work: () => Promise<T>): Promise<T> => {
  if (waiting >= HOOK_LIMITS.queue) return Promise.reject(new Error('hook_queue_full'))
  waiting++
  const next = queue.then(work, work).finally(() => { waiting-- })
  queue = next.catch(() => undefined)
  return next
}

/** Runs the enabled hooks of one event in order. A pre-stage blocking hook that does not succeed stops the rest and blocks the action. */
export async function runLifecycleHooks(input: { rootDir: string; event: HookEvent; actor: string; runner: HookRunner; fs?: UpgradeHostFs; now?: () => Date;
  audit(entry: { action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }): Promise<unknown> }): Promise<{ results: HookRunResult[]; blocked: string | null }> {
  const hooks = (await readHookRegistry(input.rootDir)).filter(hook => hook.enabled && hook.point === input.event.point && hook.stage === input.event.stage)
  const results: HookRunResult[] = []
  let blocked: string | null = null
  const now = input.now ?? (() => new Date())
  const stdin = JSON.stringify({ event: input.event.point, stage: input.event.stage, actor: input.actor, occurredAt: now().toISOString(),
    account: { username: input.event.account.username, domain: input.event.account.primaryDomain }, enhancements: input.event.enhancements }) + '\n'
  for (const hook of hooks) {
    const started = Date.now()
    let result: HookRunResult
    const inspected = await inspectHookExecutable(hook.executable, input.fs)
    if ('reason' in inspected || inspected.sha256 !== hook.sha256) result = { id: hook.id, outcome: 'refused', exitCode: null, durationMs: 0, reason: 'reason' in inspected ? inspected.reason : 'hook_executable_changed' }
    else {
      try {
        const ran = await serialized(() => input.runner.run(hookArgv(hook), stdin, hook.timeoutSeconds * 1000))
        result = { id: hook.id, outcome: ran.timedOut ? 'timeout' : ran.exitCode === 0 ? 'ok' : 'failed', exitCode: ran.timedOut ? null : ran.exitCode, durationMs: Date.now() - started, reason: null }
      } catch (error) { result = { id: hook.id, outcome: 'refused', exitCode: null, durationMs: Date.now() - started, reason: error instanceof Error && error.message === 'hook_queue_full' ? 'hook_queue_full' : 'hook_spawn_failed' } }
    }
    results.push(result)
    await input.audit({ action: 'server.hook.ran', target: 'hook:' + hook.id, outcome: result.outcome === 'ok' ? 'ok' : 'failed',
      detail: { point: hook.point, stage: hook.stage, executable: hook.executable, account: input.event.account.username, outcome: result.outcome, exitCode: result.exitCode, durationMs: result.durationMs, reason: result.reason } }).catch(() => undefined)
    if (hook.blocking && result.outcome !== 'ok') { blocked = hook.id; break }
  }
  return { results, blocked }
}

const isHookEnhancements = (value: unknown): value is HookEnhancements => value === null || object(value) && Object.keys(value).length <= HOOK_LIMITS.enhancements
  && Object.entries(value).every(([id, amount]) => /^[a-z][a-z0-9-]{0,47}$/.test(id) && (amount === true || Number.isSafeInteger(amount) && (amount as number) >= 0))

export function parseHookEvent(value: unknown): HookEvent {
  const account = object(value) ? value.account : null
  if (!object(value) || !exact(value, ['point', 'stage', 'account', 'enhancements']) || !isHookPoint(value.point) || !hookStageAllowed(value.point, value.stage) || !isHookEnhancements(value.enhancements)
    || !object(account) || !exact(account, ['id', 'username', 'primaryDomain']) || typeof account.id !== 'string' || !ID.test(account.id)
    || typeof account.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(account.username)
    || typeof account.primaryDomain !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(account.primaryDomain)) return fail('VALIDATION', 'a reviewed hook point, stage and account are required', unchanged)
  return { point: value.point, stage: value.stage, account: { id: account.id, username: account.username, primaryDomain: account.primaryDomain }, enhancements: value.enhancements }
}

export interface LifecycleHooksRouteContext {
  /** Fresh caller identity on every call; runs need the root or reseller that performed the action. */
  authenticate(): Promise<{ principalId: string; actor: string; role: string }>
  rootDir: string
  /** Native Linux only; null keeps inspection and runs unavailable instead of simulating them. */
  runner: HookRunner | null
  fs?: UpgradeHostFs
  audit(entry: { action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }): Promise<unknown>
}
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const readBody = async (req: Request): Promise<unknown> => {
  const text = await req.text()
  if (Buffer.byteLength(text) > 8192) return fail('VALIDATION', 'the request is too large', unchanged)
  try { return JSON.parse(text) } catch { return fail('VALIDATION', 'valid JSON is required', unchanged) }
}

/** /host/hooks (observe), /host/hooks/inspect (pin a reviewed file) and /host/hooks/run (one event). */
export async function handleLifecycleHooksRoute(req: Request, url: URL, method: string, ctx: LifecycleHooksRouteContext): Promise<Response | null> {
  if (!['/host/hooks', '/host/hooks/inspect', '/host/hooks/run'].includes(url.pathname)) return null
  const expected = url.pathname === '/host/hooks' ? 'GET' : 'POST'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return fail('VALIDATION', 'hook routes accept no query selectors', unchanged)
  const caller = await ctx.authenticate()
  const run = url.pathname === '/host/hooks/run'
  if (caller.role !== 'root' && !(run && caller.role === 'reseller')) return fail('FORBIDDEN', run ? 'hooks run only for root or reseller lifecycle actions' : 'root role is required for hooks', unchanged)
  if (!ctx.runner) return fail('PRECONDITION_FAILED', 'hooks require the native Linux host executor', { ...unchanged, reason: 'hooks_unavailable' })
  if (url.pathname === '/host/hooks') {
    const hooks = await readHookRegistry(ctx.rootDir)
    const observed = []
    for (const hook of hooks) { const inspected = await inspectHookExecutable(hook.executable, ctx.fs); observed.push({ id: hook.id, state: 'reason' in inspected ? inspected.reason : inspected.sha256 === hook.sha256 ? 'reviewed' : 'hook_executable_changed' }) }
    return json({ directory: HOOKS_DIRECTORY, hooks: observed })
  }
  const body = await readBody(req)
  if (url.pathname === '/host/hooks/inspect') {
    if (!object(body) || !exact(body, ['executable']) || !isHookExecutable(body.executable)) return fail('VALIDATION', `the executable must be a file name inside ${HOOKS_DIRECTORY}`, { ...unchanged, reason: 'hook_path_not_reviewed' })
    // A refusal is an observation the API reports with its reason, so it is a 200 reply, not a transport error.
    const inspected = await inspectHookExecutable(body.executable, ctx.fs)
    return json('reason' in inspected ? { executable: body.executable, state: 'refused', reason: inspected.reason } : { executable: body.executable, state: 'reviewed', ...inspected })
  }
  const event = parseHookEvent(body)
  const outcome = await runLifecycleHooks({ rootDir: ctx.rootDir, event, actor: caller.actor, runner: ctx.runner, ...(ctx.fs ? { fs: ctx.fs } : {}), audit: entry => ctx.audit(entry) })
  return json(outcome)
}
