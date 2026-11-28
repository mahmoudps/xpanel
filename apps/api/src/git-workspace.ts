import { join } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { parseGitRequest, GIT_FEATURE } from '../../agent/src/account-git.ts'
import { parseGitViewRequest } from '../../agent/src/account-git-view.ts'
import type { AccountGitView, GitDeployment, GitRepositoryView, GitRequest, GitWebhookView } from '../../agent/src/account-git.ts'
import { isGitPath, isGitBranch, isGitHttpsUrl, GIT_LIMITS } from '../../../packages/os/src/git-command.ts'

export const GIT_WORKSPACE_PATH = '/api/account/git'
export const GIT_VIEW_PATH = '/api/account/git/view'
export const GIT_WEBHOOK_PREFIX = '/api/account/git/webhook/'
export const GIT_WEBHOOK_INDEX_STATE = 'extended/git-webhooks.json'
const GIT_WEBHOOK_WINDOW_MS = 60_000
const GIT_WEBHOOK_WINDOW_CALLS = 30
const webhookWindows = new Map<string, number[]>()
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)
const iso = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
const webhookUrl = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && /^\/api\/account\/git\/webhook\/[0-9a-f]{16,64}(?:\?token=[A-Za-z0-9_-]{32,128})?$/.test(value)
const cleanText = (value: unknown): value is string => typeof value === 'string' && value.length <= 500 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
/** Bounded, account-pinned reply projected field by field; paths never come from another session. */
export function projectGitView(raw: unknown, account: Pick<Account, 'id' | 'username'>, request: GitRequest): AccountGitView {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'the Git reply could not be verified')
  if (object(raw) && [raw, object(raw.detail) ? raw.detail : {}, object(raw.details) ? raw.details : {}].some(part => part.unknownOutcome === true || part.verificationRequired === true)) return bad()
  if (!object(raw) || !object(raw.context) || raw.context.accountId !== account.id || raw.context.username !== account.username || typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision) || !Array.isArray(raw.repositories) || raw.repositories.length > GIT_LIMITS.repositories || raw.repositories.some(path => !isGitPath(path)) || new Set(raw.repositories).size !== raw.repositories.length || typeof raw.nativeAvailable !== 'boolean' || !object(raw.application) || raw.application.op !== request.op || raw.application.verificationRequired !== false || raw.application.state !== (['list', 'inspect'].includes(request.op) ? 'read' : 'verified')) return bad()
  let selected: GitRepositoryView | null = null
  if (raw.selected !== null) {
    const s = raw.selected
    if (!object(s) || !isGitPath(s.path) || !raw.repositories.includes(s.path) || !isGitBranch(s.branch) || !(s.head === null || hash(s.head)) || typeof s.dirty !== 'boolean' || typeof s.changedFiles !== 'number' || !Number.isSafeInteger(s.changedFiles) || s.changedFiles < 0 || s.changedFiles > 10000 || s.dirty !== (s.changedFiles > 0) || !(s.remote === null || isGitHttpsUrl(s.remote)) || !Array.isArray(s.branches) || s.branches.length > GIT_LIMITS.branches || !Array.isArray(s.commits) || s.commits.length > GIT_LIMITS.commits) return bad()
    const branches = s.branches.map(b => { if (!object(b) || !isGitBranch(b.name) || !hash(b.hash) || typeof b.current !== 'boolean') return bad(); return { name: b.name, hash: b.hash, current: b.current } })
    const commits = s.commits.map(c => { if (!object(c) || !hash(c.hash) || !iso(c.at) || !cleanText(c.subject)) return bad(); return { hash: c.hash, at: c.at, subject: c.subject } })
    const current = branches.filter(b => b.current)
    if (new Set(branches.map(b => b.name)).size !== branches.length || (s.head === null ? branches.length !== 0 || commits.length !== 0 : current.length !== 1 || current[0]!.name !== s.branch || current[0]!.hash !== s.head || commits[0]?.hash !== s.head)) return bad()
    selected = { path: s.path, branch: s.branch, head: s.head, dirty: s.dirty, changedFiles: s.changedFiles, remote: s.remote, branches, commits }
  }
  if (request.op === 'list' || request.op === 'remove' ? selected !== null : !selected || selected.path !== request.path) return bad()
  if (request.op === 'remove' && raw.repositories.includes(request.path) || (request.op === 'init' || request.op === 'clone') && !raw.repositories.includes(request.path) || (request.op === 'init' || request.op === 'checkout') && selected?.branch !== request.branch || !['list', 'inspect', 'remove', 'webhook-rotate'].includes(request.op) && selected?.dirty) return bad()
  const deployment = (raw.deployed ?? null) as Record<string, unknown> | null
  if (deployment !== null && (!object(deployment) || !hash(deployment.commit) || !iso(deployment.at) || (deployment.op !== undefined && deployment.op !== 'deploy' && deployment.op !== 'rollback') || request.op === 'list')
    || (request.op === 'deploy' || request.op === 'rollback') && deployment === null
    || request.op === 'rollback' && deployment?.commit !== request.targetCommit) return bad()
  let releases: GitDeployment[] | undefined
  if (raw.releases !== undefined) {
    if (!Array.isArray(raw.releases) || raw.releases.length > 20 || request.op === 'list') return bad()
    releases = raw.releases.map(item => {
      if (!object(item) || !hash(item.commit) || !iso(item.at) || (item.op !== undefined && item.op !== 'deploy' && item.op !== 'rollback')) return bad()
      return item.op ? { commit: item.commit, at: item.at, op: item.op } : { commit: item.commit, at: item.at }
    })
  }
  let webhook: GitWebhookView | null | undefined
  if (raw.webhook !== undefined) {
    if (raw.webhook === null) webhook = null
    else {
      const w = raw.webhook
      if (!object(w) || typeof w.configured !== 'boolean' || !(w.url === null || webhookUrl(w.url)) || !(w.updatedAt === null || iso(w.updatedAt))) return bad()
      webhook = { configured: w.configured, url: w.url as string | null, updatedAt: w.updatedAt as string | null }
    }
  }
  if (request.op === 'webhook-rotate' && (!webhook || !webhook.configured || typeof webhook.url !== 'string')) return bad()
  if (selected && !raw.nativeAvailable || ['remove', 'init', 'clone'].includes(request.op) && 'expectedRevision' in request && raw.revision === request.expectedRevision) return bad()
  return {
    context: { accountId: account.id, username: account.username },
    revision: raw.revision,
    repositories: [...raw.repositories] as string[],
    selected,
    deployed: deployment === null ? null : { commit: deployment.commit as string, at: deployment.at as string, ...(deployment.op === 'deploy' || deployment.op === 'rollback' ? { op: deployment.op } : {}) },
    ...(releases !== undefined ? { releases } : {}),
    ...(webhook !== undefined ? { webhook } : {}),
    nativeAvailable: raw.nativeAvailable,
    application: { op: request.op, state: ['list', 'inspect'].includes(request.op) ? 'read' : 'verified', verificationRequired: false },
  }
}
interface GitWebhookIndexEntry { accountId: string; path: string; updatedAt: string }
interface GitWebhookIndex { version: 1; hooks: Record<string, GitWebhookIndexEntry> }

async function updateGitWebhookIndex(
  store: Partial<Pick<StateStore, 'rootDir' | 'getWriterLock'>>,
  mutate: (hooks: Record<string, GitWebhookIndexEntry>) => void,
): Promise<void> {
  if (!store.rootDir || !store.getWriterLock) return
  const indexPath = join(store.rootDir, GIT_WEBHOOK_INDEX_STATE)
  const lease = await store.getWriterLock().acquire()
  try {
    await lease.assertFencingToken()
    const raw = await readJsonIfExists<unknown>(indexPath).catch(() => null)
    const hooks: Record<string, GitWebhookIndexEntry> = {}
    if (object(raw) && raw.version === 1 && object(raw.hooks)) {
      for (const [id, entry] of Object.entries(raw.hooks)) {
        if (/^[0-9a-f]{16,64}$/.test(id) && object(entry) && typeof entry.accountId === 'string' && isGitPath(entry.path) && iso(entry.updatedAt)) {
          hooks[id] = { accountId: entry.accountId, path: entry.path, updatedAt: entry.updatedAt }
        }
      }
    }
    mutate(hooks)
    await lease.assertFencingToken()
    await atomicWriteJson(indexPath, { version: 1, hooks } satisfies GitWebhookIndex, 0o640, async () => { await lease.assertFencingToken() })
  } finally {
    await lease.release()
  }
}

export async function handleGitWorkspaceRoute(req: Request, url: URL, method: string, ports: AccountSshPorts): Promise<Response | null> {
  if (url.pathname === GIT_VIEW_PATH) {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    parseGitViewRequest(url.searchParams)
    const { caller, account } = await authorizeAccountOwner(ports, req, ['gitweb'], 'Git')
    return workspaceJson(await ports.readAgent(caller, '/accounts/' + account.username + '/git/view' + url.search, undefined, false, 'GET'))
  }
  if (url.pathname !== GIT_WORKSPACE_PATH) return null
  if (!['GET', 'POST'].includes(method)) return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return fail('VALIDATION', 'Git requests do not accept selectors', { stateChanged: false })
  const first = await authorizeAccountOwner(ports, req, [GIT_FEATURE], 'Git')
  let raw: unknown
  if (method === 'POST') { const body = await req.text(); if (body.length > 2048) return fail('VALIDATION', 'Git request is too large', { stateChanged: false }); try { raw = JSON.parse(body) } catch { return fail('VALIDATION', 'Git request must be JSON', { stateChanged: false }) } }
  const request = parseGitRequest(method, raw), mutation = !['list', 'inspect'].includes(request.op)
  const fresh = await authorizeAccountOwner(ports, req, [GIT_FEATURE], 'Git')
  if (fresh.account.id !== first.account.id || fresh.account.username !== first.account.username || fresh.caller.principal.id !== first.caller.principal.id) return fail('CONFLICT', 'account binding changed', { stateChanged: false })
  const reply = await ports.readAgent(fresh.caller, '/accounts/' + fresh.account.username + '/git', method === 'POST' ? request : undefined, mutation, method)
  let projected: AccountGitView
  try {
    const after = await authorizeAccountOwner(ports, req, [GIT_FEATURE], 'Git')
    if (after.account.id !== fresh.account.id || after.account.username !== fresh.account.username || after.caller.principal.id !== fresh.caller.principal.id) throw new Error('git_owner_changed')
    projected = projectGitView(reply, fresh.account, request)
  } catch { return fail('SERVICE_UNAVAILABLE', mutation ? 'Git outcome needs review before retrying' : 'Git reply could not be verified', { stateChanged: mutation, unknownOutcome: mutation, verificationRequired: mutation }) }
  if (request.op === 'webhook-rotate' && projected.webhook?.url) {
    const hookId = /^\/api\/account\/git\/webhook\/([0-9a-f]{16,64})(?:\?|$)/.exec(projected.webhook.url)?.[1]
    if (hookId) {
      await updateGitWebhookIndex(ports.store, hooks => {
        for (const [existingId, item] of Object.entries(hooks)) {
          if (item.accountId === fresh.account.id && item.path === request.path) delete hooks[existingId]
        }
        hooks[hookId] = { accountId: fresh.account.id, path: request.path, updatedAt: projected.webhook?.updatedAt ?? new Date().toISOString() }
      })
    }
  } else if (request.op === 'remove') {
    await updateGitWebhookIndex(ports.store, hooks => {
      for (const [existingId, item] of Object.entries(hooks)) {
        if (item.accountId === fresh.account.id && item.path === request.path) delete hooks[existingId]
      }
    })
  }
  return workspaceJson(projected)
}

export interface GitWebhookPorts {
  store: Pick<StateStore, 'rootDir' | 'getAccount' | 'getPlan' | 'getFeatureList'>
  readAgent: AccountSshPorts['readAgent']
  findAccountPrincipal(account: Account): Promise<{ id: string; username: string; kind: string; disabled: boolean; accountId: string | null } | null>
  emitAudit(entry: { actor: string; action: string; target: string; detail?: Record<string, unknown>; outcome: 'ok' | 'denied' | 'failed'; principalId?: null }): Promise<unknown>
  now?: () => Date
}

/** Token-verified deployment webhook receiver for POST /api/account/git/webhook/<webhookId>. */
export async function handleGitWebhookRoute(req: Request, url: URL, method: string, ports: GitWebhookPorts): Promise<Response> {
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
  const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } })
  if (method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } })
  const webhookId = url.pathname.slice(GIT_WEBHOOK_PREFIX.length)
  if (!/^[0-9a-f]{16,64}$/.test(webhookId)) return reply(403, { error: 'forbidden' })
  for (const key of url.searchParams.keys()) {
    if (key !== 'token') return reply(400, { error: 'unsupported_query' })
  }
  const index = await readJsonIfExists<unknown>(join(ports.store.rootDir, GIT_WEBHOOK_INDEX_STATE)).catch(() => null)
  const rawEntry = object(index) && index.version === 1 && object(index.hooks) ? index.hooks[webhookId] : null
  if (!object(rawEntry) || typeof rawEntry.accountId !== 'string' || !isGitPath(rawEntry.path)) return reply(403, { error: 'forbidden' })
  const at = (ports.now ?? (() => new Date()))().getTime()
  const recent = (webhookWindows.get(webhookId) ?? []).filter(time => at - time < GIT_WEBHOOK_WINDOW_MS)
  if (recent.length >= GIT_WEBHOOK_WINDOW_CALLS) {
    webhookWindows.set(webhookId, recent)
    return reply(429, { error: 'rate_limited' })
  }
  if (!webhookWindows.has(webhookId) && webhookWindows.size >= 1000) {
    for (const [id, times] of webhookWindows) {
      const active = times.filter(time => at - time < GIT_WEBHOOK_WINDOW_MS)
      if (active.length) webhookWindows.set(id, active)
      else webhookWindows.delete(id)
    }
  }
  webhookWindows.set(webhookId, [...recent, at])

  const token = url.searchParams.get('token') ?? req.headers.get('x-git-webhook-token') ?? /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? ''
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    await ports.emitAudit({ actor: 'anonymous', action: 'account.git.webhook', target: 'git-webhook:' + webhookId, detail: { reason: 'missing_token' }, outcome: 'denied', principalId: null }).catch(() => undefined)
    return reply(403, { error: 'forbidden' })
  }
  const account = await ports.store.getAccount(rawEntry.accountId)
  const plan = account ? await ports.store.getPlan(account.planId) : null
  const features = plan ? await ports.store.getFeatureList(plan.featureListId) : null
  const principal = account ? await ports.findAccountPrincipal(account) : null
  if (!account || account.status !== 'active' || account.shell === 'none' || !plan || !features || features.disabled.includes(GIT_FEATURE)
    || !principal || principal.disabled || principal.kind !== 'user' || principal.accountId !== account.id || principal.username !== account.username) {
    await ports.emitAudit({ actor: 'anonymous', action: 'account.git.webhook', target: 'git-webhook:' + webhookId, detail: { reason: 'unauthorized_account' }, outcome: 'denied', principalId: null }).catch(() => undefined)
    return reply(403, { error: 'forbidden' })
  }
  const ownerCaller = {
    principal: { kind: 'user', id: principal.id, username: account.username, accountId: account.id },
    sessionId: null,
    apiTokenId: null,
    scopes: [],
    principalRecord: {},
  } as unknown as AuthenticatedCaller
  try {
    const result = await ports.readAgent(ownerCaller, '/accounts/' + account.username + '/git/webhook', { path: rawEntry.path, webhookId, token }, true, 'POST')
    await ports.emitAudit({ actor: account.username, action: 'account.git.webhook', target: 'account:' + account.username, detail: { path: rawEntry.path, webhookId }, outcome: 'ok', principalId: null }).catch(() => undefined)
    return reply(200, result)
  } catch (error) {
    if (isXpanelError(error)) {
      const status = error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : error.code === 'PRECONDITION_FAILED' ? 412 : 503
      return reply(status, { error: error.code.toLowerCase(), message: error.message })
    }
    return reply(503, { error: 'service_unavailable' })
  }
}
