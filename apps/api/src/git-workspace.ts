import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { parseGitRequest, GIT_FEATURE } from '../../agent/src/account-git.ts'
import type { AccountGitView, GitRepositoryView, GitRequest } from '../../agent/src/account-git.ts'
import { isGitPath, isGitBranch, isGitHttpsUrl, GIT_LIMITS } from '../../../packages/os/src/git-command.ts'

export const GIT_WORKSPACE_PATH = '/api/account/git'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)
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
    const commits = s.commits.map(c => { if (!object(c) || !hash(c.hash) || typeof c.at !== 'string' || c.at.length > 40 || !Number.isFinite(Date.parse(c.at)) || !cleanText(c.subject)) return bad(); return { hash: c.hash, at: c.at, subject: c.subject } })
    const current = branches.filter(b => b.current)
    if (new Set(branches.map(b => b.name)).size !== branches.length || (s.head === null ? branches.length !== 0 || commits.length !== 0 : current.length !== 1 || current[0]!.name !== s.branch || current[0]!.hash !== s.head || commits[0]?.hash !== s.head)) return bad()
    selected = { path: s.path, branch: s.branch, head: s.head, dirty: s.dirty, changedFiles: s.changedFiles, remote: s.remote, branches, commits }
  }
  if (request.op === 'list' || request.op === 'remove' ? selected !== null : !selected || selected.path !== request.path) return bad()
  if (request.op === 'remove' && raw.repositories.includes(request.path) || (request.op === 'init' || request.op === 'clone') && !raw.repositories.includes(request.path) || (request.op === 'init' || request.op === 'checkout') && selected?.branch !== request.branch || !['list', 'inspect', 'remove'].includes(request.op) && selected?.dirty) return bad()
  if (selected && !raw.nativeAvailable || ['remove', 'init', 'clone'].includes(request.op) && 'expectedRevision' in request && raw.revision === request.expectedRevision) return bad()
  return { context: { accountId: account.id, username: account.username }, revision: raw.revision, repositories: [...raw.repositories] as string[], selected, nativeAvailable: raw.nativeAvailable, application: { op: request.op, state: ['list', 'inspect'].includes(request.op) ? 'read' : 'verified', verificationRequired: false } }
}
export async function handleGitWorkspaceRoute(req: Request, url: URL, method: string, ports: AccountSshPorts): Promise<Response | null> {
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
  try {
    const after = await authorizeAccountOwner(ports, req, [GIT_FEATURE], 'Git')
    if (after.account.id !== fresh.account.id || after.account.username !== fresh.account.username || after.caller.principal.id !== fresh.caller.principal.id) throw new Error('git_owner_changed')
    return workspaceJson(projectGitView(reply, fresh.account, request))
  } catch { return fail('SERVICE_UNAVAILABLE', mutation ? 'Git outcome needs review before retrying' : 'Git reply could not be verified', { stateChanged: mutation, unknownOutcome: mutation, verificationRequired: mutation }) }
}
