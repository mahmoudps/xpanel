import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { effectiveEnhancements, readSavedEnhancements } from './acct-enhancements-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertExpectedRevision, exactKeys, panelConfigFile, panelConfigRevision, panelJson, readPanelConfigBody } from './panel-config-file.ts'
import type { PanelConfigFile } from './panel-config-file.ts'
import { HOOK_LIMITS, HOOK_POINTS, HOOKS_DIRECTORY, hookStageAllowed, isHookArgs, isHookExecutable, isHookPoint, parseHookRegistry } from '../../agent/src/lifecycle-hooks.ts'
import type { HookEnhancements, HookEntry, HookPoint, HookStage } from '../../agent/src/lifecycle-hooks.ts'

/** Host transport: a body sends a POST mutation. Absent when no agent is connected. */
export type HookHost = (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>
export interface HooksWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  callHost?: HookHost
  now?: () => Date
}
export interface HooksView {
  state: 'default' | 'saved' | 'invalid'; hooks: HookEntry[] | null; updatedAt: string | null; revision: string
  points: { point: HookPoint; stages: readonly HookStage[] }[]; directory: string
  observation: { state: 'read' | 'unavailable'; hooks: { id: string; state: string }[] }
}

const NAMESPACE = 'hooks:v1'
const ROUTE = /^\/api\/server\/hooks(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(move))?)?$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const parseRecord = (raw: unknown): HookEntry[] | null => object(raw) && typeof raw.updatedAt === 'string' && STAMP.test(raw.updatedAt) ? parseHookRegistry(raw) : null
export const hooksFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>): PanelConfigFile<HookEntry[]> => panelConfigFile(store, 'hooks.json', NAMESPACE, parseRecord, () => [])
const points = Object.entries(HOOK_POINTS).map(([point, stages]) => ({ point: point as HookPoint, stages }))
const plain = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)

async function observe(helpers: HooksWorkspaceHelpers, caller: AuthenticatedCaller): Promise<HooksView['observation']> {
  if (!helpers.callHost) return { state: 'unavailable', hooks: [] }
  try {
    const reply = await helpers.callHost(caller, '/host/hooks')
    if (!object(reply) || !Array.isArray(reply.hooks) || reply.hooks.length > HOOK_LIMITS.hooks) return { state: 'unavailable', hooks: [] }
    const hooks = reply.hooks.map(item => object(item) && typeof item.id === 'string' && typeof item.state === 'string' && /^[a-z_]{1,48}$/.test(item.state) ? { id: item.id, state: item.state } : null)
    return hooks.every(item => item !== null) ? { state: 'read', hooks: hooks as { id: string; state: string }[] } : { state: 'unavailable', hooks: [] }
  } catch { return { state: 'unavailable', hooks: [] } }
}
const viewOf = (raw: unknown, value: HookEntry[] | null, observation: HooksView['observation']): HooksView => ({
  state: raw === null ? 'default' : value ? 'saved' : 'invalid', hooks: value, updatedAt: value && raw !== null ? (raw as { updatedAt: string }).updatedAt : null,
  revision: panelConfigRevision(NAMESPACE, raw), points, directory: HOOKS_DIRECTORY, observation,
})

function parseRegistration(body: Record<string, unknown>): Omit<HookEntry, 'id' | 'sha256'> {
  const keys = ['point', 'stage', 'executable', 'args', 'timeoutSeconds', 'blocking', 'enabled', 'description', 'expectedRevision']
  if (Object.keys(body).some(key => !keys.includes(key))) return fail('VALIDATION', 'only ' + keys.join(', ') + ' are accepted', unchanged)
  if (!isHookPoint(body.point) || !hookStageAllowed(body.point, body.stage)) return fail('VALIDATION', 'a supported hook point and stage are required', unchanged)
  if (!isHookExecutable(body.executable)) return fail('VALIDATION', `the executable must be a file name inside ${HOOKS_DIRECTORY}`, { ...unchanged, reason: 'hook_path_not_reviewed' })
  const args = body.args ?? []
  if (!isHookArgs(args)) return fail('VALIDATION', `at most ${HOOK_LIMITS.args} plain arguments of up to ${HOOK_LIMITS.argBytes} bytes`, unchanged)
  const timeoutSeconds = body.timeoutSeconds ?? 10
  if (!Number.isSafeInteger(timeoutSeconds) || (timeoutSeconds as number) < 1 || (timeoutSeconds as number) > HOOK_LIMITS.timeoutSeconds) return fail('VALIDATION', `timeoutSeconds must be 1 to ${HOOK_LIMITS.timeoutSeconds}`, unchanged)
  const blocking = body.blocking ?? false, enabled = body.enabled ?? true, description = body.description ?? ''
  if (typeof blocking !== 'boolean' || (blocking && body.stage !== 'pre')) return fail('VALIDATION', 'only a pre-stage hook can block its action', unchanged)
  if (typeof enabled !== 'boolean' || !plain(description, HOOK_LIMITS.description)) return fail('VALIDATION', `enabled is true or false and the description is plain text of up to ${HOOK_LIMITS.description} characters`, unchanged)
  return { point: body.point, stage: body.stage, executable: body.executable, args, timeoutSeconds: timeoutSeconds as number, blocking, enabled, description }
}

/** Root lists hooks, registers a reviewed executable (its digest pinned by the agent), enables, disables, reorders and deletes them. */
export async function handleHooksRoute(request: Request, url: URL, method: string, helpers: HooksWorkspaceHelpers): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const id = match[1], move = match[2] === 'move'
  const action = method === 'GET' ? 'server.hooks.read' : 'server.hooks.update'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const allow = move ? 'POST' : id ? 'PATCH, DELETE' : 'GET, POST'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (url.search) return fail('VALIDATION', 'hook routes accept no query selectors', unchanged)
  const file = hooksFile(helpers.store)
  const authority = async (): Promise<void> => { const fresh = await helpers.requireCaller(request); await helpers.assertRoot(fresh, action); if (fresh.principal.id !== caller.principal.id) fail('FORBIDDEN', 'root authority changed', unchanged) }
  if (method === 'GET') { const { raw, value } = await file.read(); return panelJson(viewOf(raw, value, await observe(helpers, caller))) }
  const body = await readPanelConfigBody(request, 8192)
  const expected = assertExpectedRevision(body.expectedRevision)
  const { value } = await file.read()
  if (value === null) return fail('PRECONDITION_FAILED', 'the saved hook registry requires review before it can be changed', unchanged)
  let next: HookEntry[], audit: { action: string; target: string; detail: Record<string, unknown> }
  if (!id) {
    const registration = parseRegistration(body)
    if (value.length >= HOOK_LIMITS.hooks) return fail('CONFLICT', `at most ${HOOK_LIMITS.hooks} hooks can be registered`, unchanged)
    if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'registering a hook needs the host agent to review the executable', { ...unchanged, reason: 'hooks_unavailable' })
    const reply = await helpers.callHost(caller, '/host/hooks/inspect', { executable: registration.executable })
    if (!object(reply) || reply.executable !== registration.executable || (reply.state === 'refused' ? typeof reply.reason !== 'string' : reply.state !== 'reviewed' || typeof reply.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(reply.sha256)))
      return fail('SERVICE_UNAVAILABLE', 'the executable review could not be verified', unchanged)
    if (reply.state === 'refused') return fail('PRECONDITION_FAILED', 'the executable is not a root-owned file in the reviewed directory that nobody can read and execute but not change', { ...unchanged, reason: reply.reason })
    const entry: HookEntry = { id: randomUUID(), ...registration, sha256: reply.sha256 as string }
    next = [...value, entry]
    audit = { action: 'server.hook.registered', target: 'hook:' + entry.id, detail: { point: entry.point, stage: entry.stage, executable: entry.executable, sha256: entry.sha256, blocking: entry.blocking, enabled: entry.enabled } }
  } else {
    const index = value.findIndex(hook => hook.id === id), hook = value[index]
    if (!hook) return fail('NOT_FOUND', 'hook not found', unchanged)
    if (method === 'DELETE') {
      if (!exactKeys(body, ['expectedRevision'])) return fail('VALIDATION', 'only expectedRevision is accepted', unchanged)
      next = value.filter(item => item.id !== id)
      audit = { action: 'server.hook.deleted', target: 'hook:' + id, detail: { point: hook.point, stage: hook.stage, executable: hook.executable } }
    } else if (move) {
      if (!exactKeys(body, ['direction', 'expectedRevision']) || (body.direction !== 'up' && body.direction !== 'down')) return fail('VALIDATION', 'direction is up or down', unchanged)
      // Order matters only among hooks of the same event and stage, so a move swaps with the nearest such neighbour.
      const peers = value.map((item, at) => ({ item, at })).filter(({ item }) => item.point === hook.point && item.stage === hook.stage)
      const position = peers.findIndex(peer => peer.item.id === id), other = peers[position + (body.direction === 'up' ? -1 : 1)]
      if (!other) return fail('CONFLICT', 'the hook is already at that end of its event', unchanged)
      next = [...value]; next[index] = other.item; next[other.at] = hook
      audit = { action: 'server.hook.reordered', target: 'hook:' + id, detail: { point: hook.point, stage: hook.stage, direction: body.direction } }
    } else {
      if (!exactKeys(body, ['enabled', 'expectedRevision']) || typeof body.enabled !== 'boolean') return fail('VALIDATION', 'exactly enabled and expectedRevision are required', unchanged)
      next = value.map(item => item.id === id ? { ...item, enabled: body.enabled as boolean } : item)
      audit = { action: 'server.hook.updated', target: 'hook:' + id, detail: { point: hook.point, stage: hook.stage, enabled: body.enabled } }
    }
  }
  // The file holds the whole record; its parsed value is the ordered hook list.
  const saved = await file.write({ version: 1, hooks: next, updatedAt: (helpers.now ?? (() => new Date()))().toISOString() } as unknown as HookEntry[], expected, authority)
  try { await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, outcome: 'ok', ...audit }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the hook registry was saved but its audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true }) }
  return panelJson(viewOf(saved.raw, saved.value, await observe(helpers, caller)))
}

type HookAccount = Pick<Account, 'id' | 'username' | 'primaryDomain' | 'planId'>
export interface LifecycleHooks {
  /** Pre stage: resolves when no blocking hook refused; otherwise refuses the action before any change. */
  before(point: HookPoint, account: HookAccount, caller: AuthenticatedCaller): Promise<void>
  /** Post stage: never changes the outcome of the finished action; the agent audits each run. */
  after(point: HookPoint, account: HookAccount, caller: AuthenticatedCaller): void
}
export function createLifecycleHooks(ports: { store: Pick<StateStore, 'rootDir' | 'getWriterLock'>; callHost?: HookHost; emitAudit: ExtendedRouteHelpers['emitAudit'] }): LifecycleHooks {
  const pending = async (point: HookPoint, stage: HookStage): Promise<HookEntry[] | null> => {
    try { return (await hooksFile(ports.store).read()).value?.filter(hook => hook.enabled && hook.point === point && hook.stage === stage) ?? null } catch { return null }
  }
  // Hooks are the consumer of account enhancements; unverifiable saved values reach them as null, never as an empty set.
  const enhancements = async (account: HookAccount): Promise<HookEnhancements> => {
    try {
      const document = readSavedEnhancements(await readJsonIfExists<unknown>(join(ports.store.rootDir, 'extended/plans/enhancements.json')))
      return document && effectiveEnhancements(document, { id: account.planId }, account)
    } catch { return null }
  }
  const event = async (point: HookPoint, stage: HookStage, account: HookAccount) => ({ point, stage, account: { id: account.id, username: account.username, primaryDomain: account.primaryDomain }, enhancements: await enhancements(account) })
  const unreachable = (caller: AuthenticatedCaller, point: HookPoint, stage: HookStage, account: Pick<Account, 'username'>): Promise<unknown> => ports.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id,
    action: 'server.hook.ran', target: 'hooks:' + point, outcome: 'failed', detail: { point, stage, account: account.username, outcome: 'refused', reason: 'hooks_unavailable' } }).catch(() => undefined)
  return {
    async before(point, account, caller) {
      if (!hookStageAllowed(point, 'pre')) return
      const hooks = await pending(point, 'pre')
      // A registry that cannot be read could hide a blocking hook, so the action is refused rather than run unchecked.
      if (hooks === null) return fail('PRECONDITION_FAILED', 'the hook registry cannot be verified', { ...unchanged, reason: 'hook_registry_invalid' })
      if (!hooks.length) return
      let reply: unknown = null
      try { if (ports.callHost) reply = await ports.callHost(caller, '/host/hooks/run', await event(point, 'pre', account)) } catch { reply = null }
      if (!object(reply) || !Array.isArray(reply.results) || !(reply.blocked === null || typeof reply.blocked === 'string')) {
        await unreachable(caller, point, 'pre', account)
        if (hooks.some(hook => hook.blocking)) return fail('PRECONDITION_FAILED', 'a blocking hook is registered for this action but could not run', { ...unchanged, reason: 'hooks_unavailable' })
        return
      }
      if (reply.blocked !== null) return fail('PRECONDITION_FAILED', 'a pre-stage hook refused this action', { ...unchanged, reason: 'hook_blocked', hookId: reply.blocked })
    },
    after(point, account, caller) {
      void (async () => {
        const hooks = await pending(point, 'post')
        if (!hooks?.length) return
        try { if (!ports.callHost) throw new Error('hooks_unavailable'); await ports.callHost(caller, '/host/hooks/run', await event(point, 'post', account)) }
        catch { await unreachable(caller, point, 'post', account) }
      })().catch(() => undefined)
    },
  }
}
