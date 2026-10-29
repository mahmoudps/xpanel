import { fail, isXpanelError } from '@xpanel/core'
import type { Account, FeatureList, Plan } from '@xpanel/core'
import { isGitPath } from '../../../packages/os/src/git-command.ts'
import { GIT_FEATURE, runGitRequest } from './account-git.ts'
import type { AccountGitView, GitRequest } from './account-git.ts'
import type { AccountGitRun } from './account-git-runner.ts'
import type { JailedFileManager } from './file-manager.ts'

/**
 * Root view of account Git deployments: the account's registered repositories (the same registry the
 * account Git page maintains) and a fast-forward pull of one of them through the isolated account Git
 * runner. The account's plan must allow Git; nothing runs as root inside the account home.
 */
type GitFiles = Pick<JailedFileManager, 'list' | 'readText' | 'writeTextChecked' | 'mkdir'>
export interface SwDeploymentsContext {
  assertRoot(action: string): Promise<{ actor: string }>
  store: { listAccounts(): Promise<Account[]>; getAccountByUsername(username: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; withAccountLifecycleLease<T>(accountId: string, operation: (account: Account) => Promise<T>): Promise<T> }
  /** null without the qualified confined account file runner. */
  files: ((account: Account, plan: Plan) => GitFiles) | null
  run: AccountGitRun | null
  audit(entry: { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }): Promise<void>
}
export interface SwDeploymentsView {
  scope: 'account-git-deployments'; filesAvailable: boolean; nativeAvailable: boolean
  accounts: { username: string; gitAllowed: boolean }[]
  selected: AccountGitView | null
}
const unchanged = { stateChanged: false }
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

async function gitAllowed(store: SwDeploymentsContext['store'], account: Account): Promise<Plan | null> {
  if (account.status !== 'active') return null
  const plan = await store.getPlan(account.planId), features = plan ? await store.getFeatureList(plan.featureListId) : null
  return plan && features && !features.disabled.includes(GIT_FEATURE) ? plan : null
}
function parse(method: string, url: URL, raw: unknown): { username: string | null; request: GitRequest } {
  if (method === 'GET') {
    const keys = [...url.searchParams.keys()], username = url.searchParams.get('account')
    if (keys.length > 1 || keys.length === 1 && (keys[0] !== 'account' || !USERNAME.test(username ?? ''))) return fail('VALIDATION', 'select one account by username; paths and commands are not accepted', unchanged)
    return { username, request: { op: 'list' } }
  }
  if (url.search) return fail('VALIDATION', 'deployment changes do not accept query selectors', unchanged)
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  const op = url.pathname.endsWith('/pull') ? 'pull' : 'inspect', fields = op === 'pull' ? 'account,expectedHead,expectedRevision,path' : 'account,path'
  if (!value || Object.keys(value).sort().join() !== fields || typeof value.account !== 'string' || !USERNAME.test(value.account) || !isGitPath(value.path)) return fail('VALIDATION', 'an account, one registered repository path and, to deploy, the reviewed commit and list revision are required', unchanged)
  const { account: _account, ...git } = value
  return { username: value.account, request: { op, ...git } as GitRequest }
}

export async function handleSwDeploymentsRoute(req: Request, url: URL, method: string, ctx: SwDeploymentsContext): Promise<Response | null> {
  const operation = url.pathname === '/host/software/deployments' ? 'read' : url.pathname === '/host/software/deployments/inspect' ? 'inspect' : url.pathname === '/host/software/deployments/pull' ? 'pull' : null
  if (!operation) return null
  const label = 'software.deployments.' + operation, first = await ctx.assertRoot(label), expected = operation === 'read' ? 'GET' : 'POST'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  let raw: unknown
  if (method === 'POST') { const text = await req.text(); if (text.length > 2048) return fail('VALIDATION', 'deployment request is too large', unchanged); try { raw = JSON.parse(text) } catch { return fail('VALIDATION', 'deployment request must be JSON', unchanged) } }
  const { username, request } = parse(method, url, raw)
  const fresh = async (): Promise<string> => { const now = await ctx.assertRoot(label); if (now.actor !== first.actor) return fail('FORBIDDEN', 'deployment authority changed', unchanged); return now.actor }
  const accounts = await ctx.store.listAccounts()
  if (accounts.length > 10000) return fail('PRECONDITION_FAILED', 'the account inventory exceeds its bound', unchanged)
  const listed = await Promise.all(accounts.filter(item => item.status === 'active' && USERNAME.test(item.username)).sort((a, b) => a.username.localeCompare(b.username, 'en')).slice(0, 500)
    .map(async item => ({ username: item.username, gitAllowed: (await gitAllowed(ctx.store, item)) !== null })))
  let selected: AccountGitView | null = null
  if (username !== null) {
    const target = await ctx.store.getAccountByUsername(username)
    if (!target || !listed.some(item => item.username === username)) return fail('NOT_FOUND', 'the account is not active', unchanged)
    if (!ctx.files) return fail('PRECONDITION_FAILED', 'the confined account file runner is unavailable; repositories cannot be read', unchanged)
    const files = ctx.files
    try {
      selected = await ctx.store.withAccountLifecycleLease(target.id, async account => {
        const authorize = async (): Promise<Plan> => {
          await fresh()
          const plan = account.id === target.id && account.username === username ? await gitAllowed(ctx.store, account) : null
          if (!plan) return fail('FORBIDDEN', 'this account is not active or its plan does not allow Git', unchanged)
          return plan
        }
        const plan = await authorize()
        return runGitRequest({ account, files: files(account, plan), run: ctx.run, request, authorize: async () => { await authorize() } })
      })
    } catch (error) {
      if (request.op === 'pull') await ctx.audit({ actor: first.actor, action: 'software.deployment.pull', target: 'account:' + username, outcome: 'failed', detail: { path: 'path' in request ? request.path : '', verificationRequired: isXpanelError(error) && error.detail?.verificationRequired === true } }).catch(() => {})
      throw error
    }
    if (request.op === 'pull') {
      try { await ctx.audit({ actor: await fresh(), action: 'software.deployment.pull', target: 'account:' + username, outcome: 'ok', detail: { path: request.path, head: selected.selected?.head ?? null } }) }
      catch { return fail('SERVICE_UNAVAILABLE', 'deployment and audit need review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
    }
  }
  await fresh()
  const view: SwDeploymentsView = { scope: 'account-git-deployments', filesAvailable: ctx.files !== null, nativeAvailable: ctx.run !== null, accounts: listed, selected }
  return json(200, view)
}
