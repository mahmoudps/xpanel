import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNoSelfLockout, cidrContains, defaultFirewallRules, fail, firewallRuleErrors, firewallRuleSetErrors, hostingServiceFirewallRules, isXpanelError, MANAGEMENT_PUBLIC_PORTS, parseCidr, PREFIX_LIST_NAME_RE, validatePrefixList } from '@xpanel/core'
import { system } from '@xpanel/render'
import type { FirewallRule, ServerSettings } from '@xpanel/core'
import { atomicWriteJson, firewallRevision, readJsonIfExists } from '@xpanel/state'
import type { FirewallGuard, FirewallMutationOptions, FirewallPendingChange, FirewallState, PrefixList } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'

export const FIREWALL_STAGED_REL_PATH = 'extended/server/firewall-staged.json'

export interface FirewallStagedDraft {
  version: 1
  baseRevision: string
  updatedAt: string
  actor: string
  rules: FirewallRule[]
  prefixLists: PrefixList[]
}

export interface FirewallStagedReviewItem {
  change: 'added' | 'changed' | 'removed'
  id: string
  position: number | null
  kind: FirewallRule['kind']
  action: FirewallRule['action']
  match: string
  source: string | null
  comment: string
  beforeAction: FirewallRule['action'] | null
  beforeMatch: string | null
  beforeSource: string | null
  lockoutCheck: 'pass' | 'blocked' | 'unchecked'
}

export interface FirewallStagedReview {
  baseRevision: string
  updatedAt: string
  actor: string
  stale: boolean
  currentRuleCount: number
  proposedRuleCount: number
  counts: { added: number; changed: number; removed: number; moved: boolean }
  lockout: { checked: boolean; passed: boolean; blockingRuleId: string | null; message: string | null }
  valid: boolean
  errors: string[]
  items: FirewallStagedReviewItem[]
}

export interface FirewallApplyStep {
  id: 'lockout-check' | 'apply-generation' | 'session-readback' | 'confirm-or-revert'
  state: 'done' | 'current' | 'upcoming' | 'failed'
}

const memoryStaged = new WeakMap<FirewallWorkspaceStore, FirewallStagedDraft | null>()

const storeRootDir = (store: FirewallWorkspaceStore): string | null => {
  const candidate = (store as { rootDir?: unknown }).rootDir
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
}

export async function readFirewallStagedDraft(store: FirewallWorkspaceStore): Promise<FirewallStagedDraft | null> {
  const rootDir = storeRootDir(store)
  if (!rootDir) return memoryStaged.get(store) ?? null
  try {
    const raw = await readJsonIfExists<unknown>(join(rootDir, FIREWALL_STAGED_REL_PATH))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const rec = raw as Partial<FirewallStagedDraft>
    if (rec.version !== 1 || typeof rec.baseRevision !== 'string' || !/^[0-9a-f]{64}$/.test(rec.baseRevision) || typeof rec.updatedAt !== 'string' || typeof rec.actor !== 'string' || !Array.isArray(rec.rules) || !Array.isArray(rec.prefixLists)) return null
    return rec as FirewallStagedDraft
  } catch {
    return null
  }
}

async function writeFirewallStagedDraft(store: FirewallWorkspaceStore, draft: FirewallStagedDraft | null): Promise<void> {
  const rootDir = storeRootDir(store)
  if (!rootDir) {
    memoryStaged.set(store, draft ? structuredClone(draft) : null)
    return
  }
  const file = join(rootDir, FIREWALL_STAGED_REL_PATH)
  if (draft === null) {
    await unlink(file).catch(err => { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err })
    return
  }
  await atomicWriteJson(file, draft, 0o640)
}

const formatRuleMatch = (rule: FirewallRule): string => {
  switch (rule.kind) {
    case 'port': return `${(rule.protocol ?? 'tcp').toUpperCase()} ${rule.port ?? '*'}`
    case 'ip': return rule.port ? `IP ${rule.port}` : 'All ports'
    case 'forward': return `${(rule.protocol ?? 'tcp').toUpperCase()} ${rule.port ?? '*'} -> ${rule.forwardTo ?? ''}`
    case 'icmp': return 'ICMP'
    case 'prefix-list': return rule.port ? `@${rule.list ?? ''} (${rule.port})` : `@${rule.list ?? ''}`
  }
}

export function projectFirewallStagedReview(
  state: FirewallState,
  draft: FirewallStagedDraft,
  sessionIp: string | null,
  settings: ServerSettings | null,
): FirewallStagedReview {
  const currentRevision = firewallRevision(state)
  const stale = draft.baseRevision !== currentRevision
  const diff = diffRules(state.rules, draft.rules)
  const errors = [
    ...(state.rules.length ? systemRuleErrors(state.rules, draft.rules) : []),
    ...draft.rules.flatMap((item, index) => firewallRuleErrors(item).map(error => `rule #${index + 1}: ${error}`)),
  ]
  if (!errors.length && settings) {
    errors.push(...firewallRuleSetErrors(draft.rules, {
      ...settings,
      managementPorts: MANAGEMENT_PUBLIC_PORTS,
      prefixLists: Object.fromEntries(draft.prefixLists.map(item => [item.name, item.entries])),
    }))
  }
  let lockoutError: string | null = null
  let blockingRuleId: string | null = null
  const canCheckLockout = Boolean(sessionIp) && errors.length === 0
  if (canCheckLockout && sessionIp) {
    try {
      assertNoSelfLockout(draft.rules, {
        sessionIp,
        panelPort: settings?.panelPort ?? 2087,
        managementPorts: MANAGEMENT_PUBLIC_PORTS,
        sshPort: settings?.sshPort ?? 22,
        prefixLists: Object.fromEntries(draft.prefixLists.map(item => [item.name, item.entries])),
      })
    } catch (err) {
      lockoutError = err instanceof Error ? err.message : 'self-lockout check failed'
      if (isXpanelError(err) && typeof err.detail?.ruleId === 'string') blockingRuleId = err.detail.ruleId
    }
  }
  const lockoutState = (ruleId: string): 'pass' | 'blocked' | 'unchecked' => {
    if (!canCheckLockout) return 'unchecked'
    if (lockoutError === null) return 'pass'
    return blockingRuleId === null || blockingRuleId === ruleId ? 'blocked' : 'pass'
  }
  const beforeMap = new Map(state.rules.map(r => [r.id, r]))
  const addedSet = new Set(diff.added)
  const changedSet = new Set(diff.changed)
  const items: FirewallStagedReviewItem[] = []
  draft.rules.forEach((rule, index) => {
    if (!addedSet.has(rule.id) && !changedSet.has(rule.id)) return
    const prev = beforeMap.get(rule.id) ?? null
    items.push({
      change: addedSet.has(rule.id) ? 'added' : 'changed',
      id: rule.id,
      position: index + 1,
      kind: rule.kind,
      action: rule.action,
      match: formatRuleMatch(rule),
      source: rule.source,
      comment: rule.comment,
      beforeAction: prev ? prev.action : null,
      beforeMatch: prev ? formatRuleMatch(prev) : null,
      beforeSource: prev ? prev.source : null,
      lockoutCheck: lockoutState(rule.id),
    })
  })
  for (const id of diff.removed) {
    const prev = beforeMap.get(id)
    if (!prev) continue
    items.push({
      change: 'removed',
      id: prev.id,
      position: null,
      kind: prev.kind,
      action: prev.action,
      match: formatRuleMatch(prev),
      source: prev.source,
      comment: prev.comment,
      beforeAction: prev.action,
      beforeMatch: formatRuleMatch(prev),
      beforeSource: prev.source,
      lockoutCheck: !canCheckLockout ? 'unchecked' : lockoutError !== null && blockingRuleId === null ? 'blocked' : 'pass',
    })
  }
  return {
    baseRevision: draft.baseRevision,
    updatedAt: draft.updatedAt,
    actor: draft.actor,
    stale,
    currentRuleCount: state.rules.length,
    proposedRuleCount: draft.rules.length,
    counts: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, moved: diff.moved },
    lockout: { checked: canCheckLockout, passed: canCheckLockout && lockoutError === null, blockingRuleId, message: lockoutError },
    valid: errors.length === 0 && (!canCheckLockout || lockoutError === null),
    errors: errors.slice(0, 32),
    items: items.slice(0, 256),
  }
}

export function projectFirewallApplySteps(
  staged: FirewallStagedReview | null,
  pending: FirewallPendingChange | null,
  confirmedNow = false,
): FirewallApplyStep[] {
  if (confirmedNow) {
    return [
      { id: 'lockout-check', state: 'done' },
      { id: 'apply-generation', state: 'done' },
      { id: 'session-readback', state: 'done' },
      { id: 'confirm-or-revert', state: 'done' },
    ]
  }
  if (pending) {
    return [
      { id: 'lockout-check', state: 'done' },
      { id: 'apply-generation', state: 'done' },
      { id: 'session-readback', state: 'current' },
      { id: 'confirm-or-revert', state: 'upcoming' },
    ]
  }
  if (staged) {
    const lockoutStep: FirewallApplyStep['state'] = !staged.lockout.checked
      ? (staged.errors.length > 0 ? 'failed' : 'upcoming')
      : staged.lockout.passed
        ? 'done'
        : 'failed'
    return [
      { id: 'lockout-check', state: lockoutStep },
      { id: 'apply-generation', state: staged.valid && !staged.stale ? 'current' : 'upcoming' },
      { id: 'session-readback', state: 'upcoming' },
      { id: 'confirm-or-revert', state: 'upcoming' },
    ]
  }
  return [
    { id: 'lockout-check', state: 'upcoming' },
    { id: 'apply-generation', state: 'upcoming' },
    { id: 'session-readback', state: 'upcoming' },
    { id: 'confirm-or-revert', state: 'upcoming' },
  ]
}

/** How long an applied change waits for the saving session to confirm it is still connected. */
export const FIREWALL_CONFIRM_WINDOW_MS = 120_000
const IMPORT_MAX_BYTES = 1024 * 1024
const RULE_ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,63}'
const ruleRoute = new RegExp(`^/api/firewall/rules/(${RULE_ID})(/move)?$`)
const listRoute = /^\/api\/firewall\/prefix-lists\/([^/]+)$/
const REVISION = /^[0-9a-f]{64}$/

export interface FirewallWorkspaceStore {
  getFirewallState(): Promise<FirewallState>
  getFirewallPending(): Promise<FirewallPendingChange | null>
  replaceFirewall(next: { rules: unknown; prefixLists: unknown; enabled?: boolean; blockPing?: boolean }, guard: FirewallGuard, opts?: FirewallMutationOptions): Promise<FirewallState>
  confirmFirewallChange(id: string): Promise<boolean>
  revertFirewallChange(id: string): Promise<'reverted' | 'superseded' | 'missing'>
  getServerSettings(): Promise<ServerSettings | null>
}

export interface FirewallWorkspaceHelpers {
  requireCaller(req: Request): Promise<AuthenticatedCaller>
  assertRoot(caller: AuthenticatedCaller, action: string): Promise<void>
  store: FirewallWorkspaceStore
  /** Trusted transport peer of the request; never a browser-supplied header. */
  clientIp(req: Request): string | null
  reconcile(caller: AuthenticatedCaller): Promise<{ ok: boolean; status: number; body: Record<string, unknown> } | null>
  /** Agent /host/firewall/bans (read) and /host/firewall/bans/unban; the live ban sets are host state. */
  bans(caller: AuthenticatedCaller, unban?: { addresses: unknown }): Promise<Response>
  audit(caller: AuthenticatedCaller, action: string, target: string, detail: Record<string, unknown>, outcome?: 'ok' | 'failed'): Promise<void>
  /** Arms the auto-revert; the default is an unref'd process timer. */
  schedule?(at: Date, run: () => Promise<void>): void
  now?(): Date
}

type Change = { action: string; target: string; next: FirewallRule[]; prefixLists?: PrefixList[]; detail: Record<string, unknown>; ruleId?: string; policy?: { enabled: boolean; blockPing: boolean } }

/** default-* rules keep sites and the panel reachable: they may be moved or narrowed by source, never deleted. */
export const isSystemRule = (rule: Pick<FirewallRule, 'id'>): boolean => rule.id.startsWith('default-')
/** Backend listeners stay loopback only; their rules are not editable at all. */
const isLockedRule = (rule: Pick<FirewallRule, 'id'>): boolean => /^default-backend(?:-tls)?-/.test(rule.id)

/** A source is narrower when it stays inside the current range; any valid source narrows "any". */
const narrows = (next: string | null, current: string | null): boolean => {
  const inner = next === null ? null : parseCidr(next)
  if (current === null) return next === null || inner !== null
  const outer = parseCidr(current)
  return !!outer && !!inner && inner.prefix >= outer.prefix && cidrContains(outer, inner)
}

/** Every saved system rule must survive a change unchanged except for a narrower source. */
export function systemRuleErrors(current: readonly FirewallRule[], next: readonly FirewallRule[]): string[] {
  const errors: string[] = []
  const after = new Map(next.map(rule => [rule.id, rule]))
  for (const rule of current.filter(isSystemRule)) {
    const kept = after.get(rule.id)
    if (!kept) { errors.push(`system rule ${rule.id} cannot be deleted`); continue }
    const { source: keptSource, ...keptRest } = kept, { source, ...rest } = rule
    if (JSON.stringify(keptRest) !== JSON.stringify(rest)) errors.push(`system rule ${rule.id} can only be narrowed by source`)
    else if (keptSource !== source && (isLockedRule(rule) || !narrows(keptSource, source))) errors.push(isLockedRule(rule) ? `system rule ${rule.id} is locked to loopback` : `system rule ${rule.id} can only be narrowed to a range inside ${source ?? 'any source'}`)
  }
  for (const rule of next) if (isSystemRule(rule) && !current.some(item => item.id === rule.id)) errors.push(`rule id ${rule.id} is reserved for system rules`)
  return errors
}

/** The project's versioned bundle (render system.exportRules): rules plus prefix-list entries; bans are never exported. */
export const exportFirewall = (state: Pick<FirewallState, 'rules' | 'prefixLists'>, now: Date): string =>
  system.exportRules(state.rules, Object.fromEntries(state.prefixLists.map(list => [list.name, list.entries])), now.toISOString())

/** Fully validated by system.importRules: format, version, rules and every list a rule names. */
export function readFirewallImport(value: unknown): { rules: FirewallRule[]; prefixLists: PrefixList[] } {
  const bundle = system.importRules(typeof value === 'string' ? value : JSON.stringify(value ?? null))
  return { rules: bundle.rules, prefixLists: Object.entries(bundle.prefixLists).map(([name, entries]) => ({ name, entries })).sort((a, b) => a.name.localeCompare(b.name)) }
}

const sameRule = (left: FirewallRule, right: FirewallRule): boolean => JSON.stringify(left) === JSON.stringify(right)
/** Rule-level difference shown before an import or any change applies. */
export const diffRules = (before: readonly FirewallRule[], after: readonly FirewallRule[]) => {
  const old = new Map(before.map(rule => [rule.id, rule])), fresh = new Map(after.map(rule => [rule.id, rule]))
  return {
    added: after.filter(rule => !old.has(rule.id)).map(rule => rule.id),
    removed: before.filter(rule => !fresh.has(rule.id)).map(rule => rule.id),
    changed: after.filter(rule => old.has(rule.id) && !sameRule(old.get(rule.id)!, rule)).map(rule => rule.id),
    moved: after.some((rule, index) => before[index]?.id !== rule.id) && before.length === after.length,
  }
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

async function readBody(req: Request, fields: readonly string[]): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await req.text()
  if (text.length > IMPORT_MAX_BYTES) return fail('VALIDATION', 'the request is larger than 1 MiB', { stateChanged: false })
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VALIDATION', 'request body must be a JSON object', { stateChanged: false })
  const extra = Object.keys(value).filter(key => !fields.includes(key))
  if (extra.length) return fail('VALIDATION', `unsupported firewall fields: ${extra.slice(0, 8).join(', ')}`, { stateChanged: false })
  return value as Record<string, unknown>
}

const revisionOf = (body: Record<string, unknown>, required: boolean): string | undefined => {
  if (body.expectedRevision === undefined && !required) return undefined
  return typeof body.expectedRevision === 'string' && REVISION.test(body.expectedRevision) ? body.expectedRevision : fail('VALIDATION', 'the firewall revision you reviewed is required', { stateChanged: false })
}

const RULE_FIELDS = ['kind', 'action', 'protocol', 'port', 'source', 'forwardTo', 'list', 'comment', 'enabled'] as const

export async function handleFirewallWorkspaceRoute(req: Request, url: URL, method: string, h: FirewallWorkspaceHelpers): Promise<Response | null> {
  const path = url.pathname
  const rule = ruleRoute.exec(path)
  const list = listRoute.exec(path)
  const known = ['/api/firewall', '/api/firewall/rules', '/api/firewall/export', '/api/firewall/import', '/api/firewall/confirm', '/api/firewall/policy', '/api/firewall/bans', '/api/firewall/bans/unban', '/api/firewall/staged', '/api/firewall/staged/apply'].includes(path) || rule !== null || list !== null
  if (!known) return null
  const now = (): Date => h.now?.() ?? new Date()
  const caller = await h.requireCaller(req)
  const allow = (expected: string): Response | null => method === expected ? null : new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return fail('VALIDATION', 'firewall routes do not accept selectors', { stateChanged: false })

  const revert = async (pending: Pick<FirewallPendingChange, 'id'>, reason: string): Promise<string> => {
    const outcome = await h.store.revertFirewallChange(pending.id)
    if (outcome === 'reverted') await h.reconcile(caller)
    if (outcome !== 'missing') await h.audit(caller, 'firewall.change.' + (outcome === 'reverted' ? 'reverted' : 'superseded'), 'firewall:' + pending.id, { reason })
    return outcome
  }
  const expire = async (): Promise<void> => {
    const pending = await h.store.getFirewallPending()
    if (pending && Date.parse(pending.deadline) <= now().getTime()) await revert(pending, 'not-confirmed')
  }
  const schedule = h.schedule ?? ((at: Date, run: () => Promise<void>) => { setTimeout(() => { void run().catch(() => {}) }, Math.max(0, at.getTime() - Date.now())).unref() })

  const view = async (confirmedNow = false): Promise<Record<string, unknown>> => {
    const [state, pending, draft, settings] = await Promise.all([
      h.store.getFirewallState(),
      h.store.getFirewallPending(),
      readFirewallStagedDraft(h.store),
      h.store.getServerSettings(),
    ])
    const sessionIp = h.clientIp(req)
    const staged = draft ? projectFirewallStagedReview(state, draft, sessionIp, settings) : null
    return {
      rules: state.rules, prefixLists: state.prefixLists, revision: firewallRevision(state), enabled: state.enabled, blockPing: state.blockPing,
      session: { ip: sessionIp },
      pending: pending ? { id: pending.id, deadline: pending.deadline, actor: pending.actor } : null,
      confirmWindowSeconds: FIREWALL_CONFIRM_WINDOW_MS / 1000,
      staged,
      applySteps: projectFirewallApplySteps(staged, pending, confirmedNow),
    }
  }

  /** Lockout check, one generation, nft -c and atomic apply by the agent; reverted unless confirmed. */
  const apply = async (state: FirewallState, expectedRevision: string | undefined, change: Change): Promise<Response> => {
    const sessionIp = h.clientIp(req) ?? fail('PRECONDITION_FAILED', 'trusted transport peer is required for firewall changes', { stateChanged: false })
    const settings = await h.store.getServerSettings()
    const lists = change.prefixLists ?? state.prefixLists
    const errors = [...(state.rules.length ? systemRuleErrors(state.rules, change.next) : []), ...change.next.flatMap((item, index) => firewallRuleErrors(item).map(error => `rule #${index + 1}: ${error}`))]
    if (!errors.length && settings) errors.push(...firewallRuleSetErrors(change.next, { ...settings, managementPorts: MANAGEMENT_PUBLIC_PORTS, prefixLists: Object.fromEntries(lists.map(item => [item.name, item.entries])) }))
    if (errors.length) return fail('VALIDATION', errors[0]!, { stateChanged: false, errors: errors.slice(0, 32) })
    const guard: FirewallGuard = { lockout: { sessionIp, panelPort: settings?.panelPort ?? 2087, managementPorts: MANAGEMENT_PUBLIC_PORTS, sshPort: settings?.sshPort ?? 22 } }
    const id = randomUUID(), deadline = new Date(now().getTime() + FIREWALL_CONFIRM_WINDOW_MS)
    const saved = await h.store.replaceFirewall({ rules: change.next, prefixLists: lists, ...change.policy }, guard, {
      ...(expectedRevision === undefined ? {} : { expectedFirewallRevision: expectedRevision }),
      confirmation: { id, deadline: deadline.toISOString(), actor: caller.principal.username, sessionIp },
    })
    const reconcile = await h.reconcile(caller)
    if (reconcile && !reconcile.ok) {
      const outcome = await revert({ id }, 'apply-failed')
      await h.audit(caller, change.action, change.target, { ...change.detail, applied: false, reverted: outcome === 'reverted' }, 'failed')
      return fail('SERVICE_UNAVAILABLE', 'the host refused the new firewall generation; the previous rules were restored', { stateChanged: false, reverted: outcome === 'reverted', reconcile: reconcile.body })
    }
    schedule(deadline, async () => { const pending = await h.store.getFirewallPending(); if (pending?.id === id) await revert(pending, 'not-confirmed') })
    await h.audit(caller, change.action, change.target, { ...change.detail, revision: firewallRevision(saved), confirmBy: deadline.toISOString() })
    const savedRule = change.ruleId === undefined ? undefined : saved.rules.find(item => item.id === change.ruleId)
    return json({ ...(await view()), ...(savedRule ? { rule: savedRule } : {}), confirmation: { id, deadline: deadline.toISOString() }, diff: diffRules(state.rules, saved.rules), reconcile: reconcile?.body ?? null }, change.action === 'firewall.rule.created' ? 201 : 200)
  }

  if (path === '/api/firewall') {
    await h.assertRoot(caller, 'firewall.read')
    const denied = allow('GET'); if (denied) return denied
    await expire()
    return json(await view())
  }
  if (path === '/api/firewall/export') {
    await h.assertRoot(caller, 'firewall.read')
    const denied = allow('GET'); if (denied) return denied
    const state = await h.store.getFirewallState()
    const text = exportFirewall(state, now())
    await h.audit(caller, 'firewall.exported', 'firewall', { rules: state.rules.length, prefixLists: state.prefixLists.length })
    return new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="firewall-${now().toISOString().slice(0, 10)}.json"` } })
  }
  if (path === '/api/firewall/bans' || path === '/api/firewall/bans/unban') {
    const read = path === '/api/firewall/bans'
    await h.assertRoot(caller, read ? 'firewall.read' : 'firewall.modify')
    const denied = allow(read ? 'GET' : 'POST'); if (denied) return denied
    if (read) return h.bans(caller)
    const body = await readBody(req, ['addresses'])
    const response = await h.bans(caller, { addresses: body.addresses })
    const result = response.ok ? await response.clone().json() as { unbanned?: string[]; stillBanned?: string[] } : null
    await h.audit(caller, 'firewall.unbanned', 'firewall:bans', { addresses: body.addresses, unbanned: result?.unbanned ?? [], stillBanned: result?.stillBanned ?? [], status: response.status }, response.ok && !result?.stillBanned?.length ? 'ok' : 'failed')
    return response
  }
  if (path === '/api/firewall/confirm') {
    await h.assertRoot(caller, 'firewall.modify')
    const denied = allow('POST'); if (denied) return denied
    const body = await readBody(req, ['id'])
    if (typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.id)) return fail('VALIDATION', 'the pending change id is required', { stateChanged: false })
    await expire()
    if (!await h.store.confirmFirewallChange(body.id)) return fail('NOT_FOUND', 'no pending firewall change has this id; it was confirmed, reverted or replaced', { stateChanged: false })
    await h.audit(caller, 'firewall.change.confirmed', 'firewall:' + body.id, {})
    return json({ confirmed: true, ...(await view(true)) })
  }

  await h.assertRoot(caller, path === '/api/firewall/rules' ? 'firewall.create' : 'firewall.modify')
  await expire()
  const state = await h.store.getFirewallState()

  if (path === '/api/firewall/staged') {
    if (method === 'DELETE') {
      await writeFirewallStagedDraft(h.store, null)
      await h.audit(caller, 'firewall.staged.discarded', 'firewall:staged', {})
      return json(await view())
    }
    const denied = allow('PUT'); if (denied) return denied
    const body = await readBody(req, ['rules', 'prefixLists', 'document', 'rule', 'position', 'expectedRevision'])
    const expectedRevision = revisionOf(body, true)!
    if (expectedRevision !== firewallRevision(state)) {
      return fail('CONFLICT', 'the firewall rules changed since they were read; reload before staging', { stateChanged: false, currentRevision: firewallRevision(state) })
    }
    let nextRules: FirewallRule[]
    let nextPrefixLists: PrefixList[] = state.prefixLists
    if (body.document !== undefined) {
      const imported = readFirewallImport(body.document)
      nextRules = imported.rules
      nextPrefixLists = imported.prefixLists
    } else if (body.rule !== undefined) {
      if (!body.rule || typeof body.rule !== 'object' || Array.isArray(body.rule)) return fail('VALIDATION', 'rule must be an object', { stateChanged: false })
      const rawRule = body.rule as Record<string, unknown>
      const extraRuleKeys = Object.keys(rawRule).filter(key => key !== 'id' && !(RULE_FIELDS as readonly string[]).includes(key))
      if (extraRuleKeys.length) return fail('VALIDATION', `unsupported rule fields: ${extraRuleKeys.slice(0, 8).join(', ')}`, { stateChanged: false })
      const existingDraft = await readFirewallStagedDraft(h.store)
      const baseRules = existingDraft && existingDraft.baseRevision === expectedRevision ? existingDraft.rules : state.rules
      const baseLists = existingDraft && existingDraft.baseRevision === expectedRevision ? existingDraft.prefixLists : state.prefixLists
      const pos = body.position === undefined || body.position === 'end'
        ? baseRules.length
        : body.position === 'top'
          ? 0
          : body.position
      if (!Number.isSafeInteger(pos) || (pos as number) < 0 || (pos as number) > baseRules.length) {
        return fail('VALIDATION', `position must be 0..${baseRules.length}`, { stateChanged: false })
      }
      const id = rawRule.id === undefined ? randomUUID() : rawRule.id
      if (typeof id !== 'string' || baseRules.some(item => item.id === id)) return fail('CONFLICT', 'a rule with this id already exists', { stateChanged: false })
      const created = { id, ...Object.fromEntries(RULE_FIELDS.map(key => [key, rawRule[key]])) } as FirewallRule
      nextRules = [...baseRules.slice(0, pos as number), created, ...baseRules.slice(pos as number)]
      nextPrefixLists = baseLists
    } else if (Array.isArray(body.rules)) {
      if (body.rules.length > 4096) return fail('VALIDATION', 'too many rules in staged draft', { stateChanged: false })
      nextRules = body.rules.map(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as { id?: unknown }).id !== 'string') return fail('VALIDATION', 'each staged rule must be an object with id', { stateChanged: false })
        const rec = raw as Record<string, unknown>
        return { id: String(rec.id), ...Object.fromEntries(RULE_FIELDS.map(key => [key, rec[key]])) } as FirewallRule
      })
      if (body.prefixLists !== undefined) {
        if (!Array.isArray(body.prefixLists) || body.prefixLists.length > 256) return fail('VALIDATION', 'invalid prefixLists', { stateChanged: false })
        nextPrefixLists = body.prefixLists.map(raw => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as { name?: unknown }).name !== 'string') return fail('VALIDATION', 'invalid prefix list', { stateChanged: false })
          const rec = raw as { name: string; entries?: unknown }
          return validatePrefixList(rec.name, rec.entries)
        }).sort((a, b) => a.name.localeCompare(b.name))
      }
    } else {
      return fail('VALIDATION', 'staged firewall request requires rules, document, or rule', { stateChanged: false })
    }
    const schemaErrors = [
      ...(state.rules.length ? systemRuleErrors(state.rules, nextRules) : []),
      ...nextRules.flatMap((item, index) => firewallRuleErrors(item).map(error => `rule #${index + 1}: ${error}`)),
    ]
    const settings = await h.store.getServerSettings()
    if (!schemaErrors.length && settings) {
      schemaErrors.push(...firewallRuleSetErrors(nextRules, {
        ...settings,
        managementPorts: MANAGEMENT_PUBLIC_PORTS,
        prefixLists: Object.fromEntries(nextPrefixLists.map(item => [item.name, item.entries])),
      }))
    }
    if (schemaErrors.length) return fail('VALIDATION', schemaErrors[0]!, { stateChanged: false, errors: schemaErrors.slice(0, 32) })
    const draft: FirewallStagedDraft = {
      version: 1,
      baseRevision: expectedRevision,
      updatedAt: now().toISOString(),
      actor: caller.principal.username,
      rules: nextRules,
      prefixLists: nextPrefixLists,
    }
    await writeFirewallStagedDraft(h.store, draft)
    const diff = diffRules(state.rules, nextRules)
    await h.audit(caller, 'firewall.staged.updated', 'firewall:staged', { baseRevision: expectedRevision, ...diff })
    return json(await view())
  }

  if (path === '/api/firewall/staged/apply') {
    const denied = allow('POST'); if (denied) return denied
    const body = await readBody(req, ['expectedRevision'])
    const expectedRevision = revisionOf(body, true)!
    const draft = await readFirewallStagedDraft(h.store)
    if (!draft) return fail('NOT_FOUND', 'no staged firewall ruleset is waiting for review', { stateChanged: false })
    const currentRevision = firewallRevision(state)
    if (draft.baseRevision !== currentRevision || expectedRevision !== currentRevision) {
      return fail('CONFLICT', 'the firewall rules changed since the staged draft was reviewed; restage before applying', { stateChanged: false, currentRevision })
    }
    await writeFirewallStagedDraft(h.store, null)
    try {
      const response = await apply(state, expectedRevision, {
        action: 'firewall.staged.applied',
        target: 'firewall:staged',
        next: draft.rules,
        prefixLists: draft.prefixLists,
        detail: { rules: draft.rules.length, ...diffRules(state.rules, draft.rules) },
      })
      if (!response.ok) await writeFirewallStagedDraft(h.store, draft)
      return response
    } catch (error) {
      await writeFirewallStagedDraft(h.store, draft)
      throw error
    }
  }

  if (path === '/api/firewall/policy') {
    const denied = allow('PUT'); if (denied) return denied
    const body = await readBody(req, ['enabled', 'blockPing', 'expectedRevision'])
    if (typeof body.enabled !== 'boolean' || typeof body.blockPing !== 'boolean') return fail('VALIDATION', 'enabled and blockPing must be booleans', { stateChanged: false })
    const expectedRevision = revisionOf(body, true)
    // A first switch-on writes the rules that keep the panel, SSH, sites and hosted services reachable; the session check runs on them.
    const settings = body.enabled && !state.rules.length ? await h.store.getServerSettings() ?? fail('PRECONDITION_FAILED', 'save the server settings before turning the firewall on', { stateChanged: false }) : null
    const next = settings ? [...defaultFirewallRules({ ...settings, managementPorts: MANAGEMENT_PUBLIC_PORTS }), ...hostingServiceFirewallRules()] : state.rules
    return apply(state, expectedRevision, { action: 'firewall.policy.updated', target: 'firewall:policy', next, policy: { enabled: body.enabled, blockPing: body.blockPing }, detail: { enabled: body.enabled, blockPing: body.blockPing, seeded: next !== state.rules } })
  }

  if (path === '/api/firewall/import') {
    const denied = allow('POST'); if (denied) return denied
    const body = await readBody(req, ['document', 'expectedRevision', 'dryRun'])
    const expectedRevision = revisionOf(body, true)!
    const { rules: next, prefixLists } = readFirewallImport(body.document)
    if (body.dryRun === true) {
      if (expectedRevision !== firewallRevision(state)) return fail('CONFLICT', 'the firewall rules changed since they were read; reload before importing', { stateChanged: false, currentRevision: firewallRevision(state) })
      const errors = [...systemRuleErrors(state.rules, next), ...next.flatMap((item, index) => firewallRuleErrors(item).map(error => `rule #${index + 1}: ${error}`))]
      return json({ dryRun: true, valid: errors.length === 0, errors: errors.slice(0, 32), diff: diffRules(state.rules, next), rules: next.length })
    }
    return apply(state, expectedRevision, { action: 'firewall.imported', target: 'firewall', next, prefixLists, detail: { rules: next.length, prefixLists: prefixLists.map(item => item.name), ...diffRules(state.rules, next) } })
  }

  if (list) {
    // upload or replace a list (one IPv4 or IPv6 range per line); an upload with an action also adds its rule at the top
    let name = ''
    try { name = decodeURIComponent(list[1]!) } catch { return fail('VALIDATION', 'list name must match [a-z][a-z0-9_]{0,23}', { stateChanged: false }) }
    if (!PREFIX_LIST_NAME_RE.test(name)) return fail('VALIDATION', 'list name must match [a-z][a-z0-9_]{0,23}', { stateChanged: false })
    const others = state.prefixLists.filter(item => item.name !== name)
    if (method === 'DELETE') {
      const body = await readBody(req, ['expectedRevision'])
      if (others.length === state.prefixLists.length) return fail('NOT_FOUND', 'prefix list not found', { stateChanged: false })
      return apply(state, revisionOf(body, true), { action: 'firewall.prefix_list.deleted', target: 'prefix-list:' + name, next: state.rules.filter(item => item.list !== name), prefixLists: others, detail: { rulesRemoved: state.rules.filter(item => item.list === name).map(item => item.id) } })
    }
    const denied = allow('PUT'); if (denied) return denied
    const body = await readBody(req, ['entries', 'action', 'ports', 'expectedRevision'])
    const lines = typeof body.entries === 'string' ? body.entries.split(/\r?\n/).map(line => line.replace(/#.*$/, '').trim()).filter(Boolean) : body.entries
    const saved = validatePrefixList(name, lines)
    const exists = state.rules.some(item => item.kind === 'prefix-list' && item.list === name)
    let next = state.rules
    if (body.action !== undefined && !exists) {
      const ports = typeof body.ports === 'string' && body.ports.trim() ? body.ports.trim() : null
      next = [{ id: 'list-' + name, kind: 'prefix-list', action: body.action as FirewallRule['action'], protocol: ports === null ? null : 'both', port: ports, source: null, forwardTo: null, list: name, comment: 'prefix list ' + name, enabled: true }, ...state.rules]
    }
    return apply(state, revisionOf(body, true), { action: others.length === state.prefixLists.length ? 'firewall.prefix_list.uploaded' : 'firewall.prefix_list.replaced', target: 'prefix-list:' + name, next, prefixLists: [...others, saved].sort((a, b) => a.name.localeCompare(b.name)), detail: { entries: saved.entries.length, ruleAdded: next !== state.rules } })
  }

  if (path === '/api/firewall/rules') {
    const denied = allow('POST'); if (denied) return denied
    const body = await readBody(req, [...RULE_FIELDS, 'id', 'position', 'expectedRevision'])
    const expectedRevision = revisionOf(body, false)
    const position = body.position === undefined ? state.rules.length : body.position
    if (!Number.isSafeInteger(position) || (position as number) < 0 || (position as number) > state.rules.length) return fail('VALIDATION', `position must be 0..${state.rules.length}`, { stateChanged: false })
    const id = body.id === undefined ? randomUUID() : body.id
    if (typeof id !== 'string' || state.rules.some(item => item.id === id)) return fail('CONFLICT', 'a rule with this id already exists', { stateChanged: false })
    const created = { id, ...Object.fromEntries(RULE_FIELDS.map(key => [key, body[key]])) } as FirewallRule
    const next = [...state.rules.slice(0, position as number), created, ...state.rules.slice(position as number)]
    return apply(state, expectedRevision, { action: 'firewall.rule.created', target: 'firewall:' + id, next, detail: { position }, ruleId: id })
  }

  const ruleId = rule![1]!
  const current = state.rules.find(item => item.id === ruleId) ?? fail('NOT_FOUND', 'firewall rule not found', { stateChanged: false })
  if (rule![2]) {
    const denied = allow('POST'); if (denied) return denied
    const body = await readBody(req, ['position', 'expectedRevision'])
    const expectedRevision = revisionOf(body, true)
    const position = body.position
    if (!Number.isSafeInteger(position) || (position as number) < 0 || (position as number) >= state.rules.length) return fail('VALIDATION', `position must be 0..${state.rules.length - 1}`, { stateChanged: false })
    const rest = state.rules.filter(item => item.id !== ruleId)
    const next = [...rest.slice(0, position as number), current, ...rest.slice(position as number)]
    return apply(state, expectedRevision, { action: 'firewall.rule.moved', target: 'firewall:' + ruleId, next, detail: { from: state.rules.indexOf(current), to: position }, ruleId })
  }
  if (method === 'PATCH') {
    const body = await readBody(req, [...RULE_FIELDS, 'expectedRevision'])
    const expectedRevision = revisionOf(body, true)
    const patch = Object.fromEntries(RULE_FIELDS.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]))
    if (!Object.keys(patch).length) return fail('VALIDATION', 'nothing to change', { stateChanged: false })
    const next = state.rules.map(item => item.id === ruleId ? { ...item, ...patch } as FirewallRule : item)
    return apply(state, expectedRevision, { action: 'firewall.rule.updated', target: 'firewall:' + ruleId, next, detail: { fields: Object.keys(patch) }, ruleId })
  }
  if (method === 'DELETE') {
    const body = await readBody(req, ['expectedRevision'])
    const expectedRevision = revisionOf(body, true)
    return apply(state, expectedRevision, { action: 'firewall.rule.deleted', target: 'firewall:' + ruleId, next: state.rules.filter(item => item.id !== ruleId), detail: { position: state.rules.indexOf(current) } })
  }
  return new Response(null, { status: 405, headers: { allow: 'PATCH, DELETE' } })
}
