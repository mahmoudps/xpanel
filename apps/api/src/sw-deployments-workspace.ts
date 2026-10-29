import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { projectGitView } from './git-workspace.ts'
import { isGitPath } from '../../../packages/os/src/git-command.ts'
import type { GitRequest } from '../../agent/src/account-git.ts'

export interface SwDeploymentsWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  getAccountByUsername(username: string): Promise<Account | null>
  callHost: (caller: AuthenticatedCaller, path: string, input?: unknown, mutation?: boolean) => Promise<unknown>
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Root-only Git deployments across accounts; the agent runs every Git operation through the account's isolated runner. */
export async function handleSwDeploymentsWorkspaceRoute(request: Request, url: URL, method: string, helpers: SwDeploymentsWorkspaceHelpers): Promise<Response | null> {
  const operation = url.pathname === '/api/server/software/deployments' ? 'read' : url.pathname === '/api/server/software/deployments/inspect' ? 'inspect' : url.pathname === '/api/server/software/deployments/pull' ? 'pull' : null
  if (!operation) return null
  const label = 'server.deployments.' + operation, caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, label)
  const expected = operation === 'read' ? 'GET' : 'POST', mutation = operation === 'pull'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  let username: string | null = null, git: GitRequest = { op: 'list' }, body: Record<string, unknown> | null = null
  if (operation === 'read') {
    const keys = [...url.searchParams.keys()]
    username = url.searchParams.get('account')
    if (keys.length > 1 || keys.length === 1 && (keys[0] !== 'account' || !USERNAME.test(username ?? ''))) return fail('VALIDATION', 'select one account by username; paths and commands are not accepted', { stateChanged: false })
  } else {
    if (url.search) return fail('VALIDATION', 'deployment changes do not accept query selectors', { stateChanged: false })
    const text = await request.text()
    let raw: unknown
    try { raw = text.length <= 2048 ? JSON.parse(text) : null } catch { raw = null }
    const fields = mutation ? 'account,expectedHead,expectedRevision,path' : 'account,path'
    if (!object(raw) || Object.keys(raw).sort().join() !== fields || typeof raw.account !== 'string' || !USERNAME.test(raw.account) || !isGitPath(raw.path)
      || mutation && (typeof raw.expectedHead !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(raw.expectedHead) || typeof raw.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.expectedRevision))) return fail('VALIDATION', 'an account, one registered repository path and, to deploy, the reviewed commit and list revision are required', { stateChanged: false })
    body = raw; username = raw.account as string
    git = mutation ? { op: 'pull', path: raw.path as string, expectedHead: raw.expectedHead as string, expectedRevision: raw.expectedRevision as string } : { op: 'inspect', path: raw.path as string }
  }
  const account = username === null ? null : await helpers.getAccountByUsername(username)
  if (username !== null && (!account || account.username !== username)) return fail('NOT_FOUND', 'the account is not active', { stateChanged: false })
  const fresh = async (): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, label)
    if (current.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'deployment authority changed', mutation ? { stateChanged: true, verificationRequired: true } : { stateChanged: false })
    return current
  }
  if (mutation) await helpers.emitAudit({ actor: caller.principal.username, action: 'server.deployment.pull_requested', target: 'account:' + username, detail: { path: body!.path }, outcome: 'ok', principalId: caller.principal.id })
  const submitter = mutation ? await fresh() : caller
  const raw = await helpers.callHost(submitter, operation === 'read' ? '/host/software/deployments' + (username ? '?account=' + username : '') : '/host/software/deployments/' + operation, body ?? undefined, mutation)
  try {
    if (!object(raw) || Object.keys(raw).sort().join() !== 'accounts,filesAvailable,nativeAvailable,scope,selected' || raw.scope !== 'account-git-deployments' || typeof raw.filesAvailable !== 'boolean' || typeof raw.nativeAvailable !== 'boolean' || !Array.isArray(raw.accounts) || raw.accounts.length > 500) throw new Error('bad')
    const names = new Set<string>()
    const accounts = raw.accounts.map(item => { if (!object(item) || Object.keys(item).sort().join() !== 'gitAllowed,username' || typeof item.username !== 'string' || !USERNAME.test(item.username) || names.has(item.username) || typeof item.gitAllowed !== 'boolean') throw new Error('bad'); names.add(item.username); return { username: item.username, gitAllowed: item.gitAllowed } })
    if ((raw.selected === null) !== (account === null)) throw new Error('bad')
    const selected = account === null ? null : projectGitView(raw.selected, account, git)
    await fresh()
    return json(200, { scope: 'account-git-deployments', filesAvailable: raw.filesAvailable, nativeAvailable: raw.nativeAvailable, accounts, selected })
  } catch { return fail(mutation ? 'SERVICE_UNAVAILABLE' : 'PRECONDITION_FAILED', mutation ? 'deployment outcome needs review before retrying' : 'the deployment reply could not be verified', mutation ? { stateChanged: true, unknownOutcome: true, verificationRequired: true } : { stateChanged: false }) }
}
