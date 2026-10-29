import { createHash } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, Plan, FeatureList } from '@xpanel/core'
import { GIT_LIMITS, isGitPath, isGitBranch, isGitHttpsUrl } from '../../../packages/os/src/git-command.ts'
import type { GitOperation } from '../../../packages/os/src/git-command.ts'
import type { AccountGitRun } from './account-git-runner.ts'
import type { FileText, JailedFileManager } from './file-manager.ts'
import type { AgentCallerIdentity } from './server.ts'

export const GIT_REGISTRY = '.xpanel-git-repositories.json'
export const GIT_FEATURE = 'git-version-control'
const REVISION = /^[0-9a-f]{64}$/
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const unchanged = { stateChanged: false }
export type GitRequest = { op: 'list' } | { op: 'inspect'; path: string } | { op: 'init'; path: string; branch: string; expectedRevision: string } | { op: 'clone'; path: string; url: string; expectedRevision: string } | { op: 'remove'; path: string; expectedRevision: string } | { op: 'checkout'; path: string; branch: string; expectedHead: string; expectedRevision: string } | { op: 'pull'; path: string; expectedHead: string; expectedRevision: string }
export interface GitRepositoryView { path: string; branch: string; head: string | null; dirty: boolean; changedFiles: number; branches: { name: string; hash: string; current: boolean }[]; commits: { hash: string; at: string; subject: string }[]; remote: string | null }
export interface AccountGitView { context: { accountId: string; username: string }; revision: string; repositories: string[]; selected: GitRepositoryView | null; nativeAvailable: boolean; application: { op: GitRequest['op']; state: 'read' | 'verified'; verificationRequired: false } }
type GitFiles = Pick<JailedFileManager, 'list' | 'readText' | 'writeTextChecked' | 'mkdir'>
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function parseGitRequest(method: string, raw?: unknown): GitRequest {
  if (method === 'GET') return { op: 'list' }
  if (method !== 'POST') return fail('VALIDATION', 'unsupported Git method', unchanged)
  if (!object(raw) || typeof raw.op !== 'string') return fail('VALIDATION', 'a Git operation is required', unchanged)
  const keys: Record<string, string[]> = { inspect: ['op', 'path'], init: ['op', 'path', 'branch', 'expectedRevision'], clone: ['op', 'path', 'url', 'expectedRevision'], remove: ['op', 'path', 'expectedRevision'], checkout: ['op', 'path', 'branch', 'expectedHead', 'expectedRevision'], pull: ['op', 'path', 'expectedHead', 'expectedRevision'] }
  const expected = keys[raw.op]
  if (!expected || Object.keys(raw).length !== expected.length || expected.some(key => !Object.hasOwn(raw, key)) || !isGitPath(raw.path)) return fail('VALIDATION', 'invalid Git request fields or repository path', unchanged)
  if (raw.op !== 'inspect' && (typeof raw.expectedRevision !== 'string' || !REVISION.test(raw.expectedRevision))) return fail('VALIDATION', 'a current repository list revision is required', unchanged)
  if ((raw.op === 'init' || raw.op === 'checkout') && !isGitBranch(raw.branch)) return fail('VALIDATION', 'invalid branch name', unchanged)
  if (raw.op === 'clone' && !isGitHttpsUrl(raw.url)) return fail('VALIDATION', 'use a public HTTPS repository URL without credentials, port, query or fragment', unchanged)
  if ((raw.op === 'checkout' || raw.op === 'pull') && (typeof raw.expectedHead !== 'string' || !HASH.test(raw.expectedHead))) return fail('VALIDATION', 'a current commit is required', unchanged)
  return raw as unknown as GitRequest
}
/** Only Git's own basic repository/remote/branch settings; includes, filters and executable configuration are refused. */
export function parseSafeGitConfig(text: string): { remote: string | null } {
  if (text.length > 16384) return fail('PRECONDITION_FAILED', 'repository configuration is too large', unchanged)
  const seen = new Set<string>(); let remote: string | null = null
  for (const entry of text.split('\0').filter(Boolean)) {
    const boundary = entry.indexOf('\n'), key = entry.slice(0, boundary).toLowerCase(), value = entry.slice(boundary + 1)
    if (boundary < 1 || seen.has(key)) return fail('PRECONDITION_FAILED', 'repository configuration is not supported', unchanged)
    seen.add(key)
    const safeCore = key === 'core.repositoryformatversion' && value === '0' || key === 'core.bare' && value === 'false' || ['core.filemode', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode', 'core.symlinks'].includes(key) && ['true', 'false'].includes(value)
    const branch = /^branch\.(.+)\.(remote|merge)$/.exec(key)
    if (key === 'remote.origin.url' && isGitHttpsUrl(value)) { remote = value; continue }
    if (key === 'remote.origin.fetch' && value === '+refs/heads/*:refs/remotes/origin/*') continue
    if (branch && isGitBranch(branch[1]) && (branch[2] === 'remote' ? value === 'origin' : value.startsWith('refs/heads/') && isGitBranch(value.slice(11)))) continue
    if (!safeCore) return fail('PRECONDITION_FAILED', 'repository contains unsupported configuration; hooks, filters and custom commands are disabled', unchanged)
  }
  return { remote }
}
export function parseGitBranches(text: string): GitRepositoryView['branches'] {
  const body = text.replace(/\n$/, ''), lines = body ? body.split('\n') : []
  if (lines.length > GIT_LIMITS.branches) return fail('PRECONDITION_FAILED', 'repository exceeds the branch limit', unchanged)
  const seen = new Set<string>()
  return lines.map(line => { const fields = line.split('\t'), name = fields[0] ?? '', hash = fields[1] ?? ''
    if (fields.length !== 3 || !isGitBranch(name) || !HASH.test(hash) || !['*', ' '].includes(fields[2]!) || seen.has(name)) return fail('PRECONDITION_FAILED', 'Git returned malformed branches', unchanged)
    seen.add(name); return { name, hash, current: fields[2] === '*' }
  })
}
export function parseGitHistory(text: string): GitRepositoryView['commits'] {
  const lines = text.trimEnd() ? text.trimEnd().split('\n') : []
  if (lines.length > GIT_LIMITS.commits) return fail('PRECONDITION_FAILED', 'Git returned too much history', unchanged)
  return lines.map(line => { const first = line.indexOf('\t'), second = line.indexOf('\t', first + 1), hash = line.slice(0, first), at = line.slice(first + 1, second), subject = line.slice(second + 1)
    if (first < 0 || second < 0 || !HASH.test(hash) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(at) || !Number.isFinite(Date.parse(at)) || subject.length > 500 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(subject)) return fail('PRECONDITION_FAILED', 'Git returned malformed history', unchanged)
    return { hash, at, subject }
  })
}
async function registry(files: GitFiles): Promise<{ document: FileText | null; paths: string[]; revision: string }> {
  const entry = (await files.list('', { showHidden: true })).find(item => item.name === GIT_REGISTRY)
  if (entry && (entry.kind !== 'file' || entry.sizeBytes > 8192)) return fail('PRECONDITION_FAILED', 'repository list is not a regular bounded file', unchanged)
  const document = entry ? await files.readText(GIT_REGISTRY) : null
  let value: unknown = []
  try { value = document ? JSON.parse(document.content) : [] } catch { return fail('PRECONDITION_FAILED', 'repository list is malformed', unchanged) }
  if (document && Buffer.byteLength(document.content) > 8192 || !Array.isArray(value) || value.length > GIT_LIMITS.repositories || value.some(path => !isGitPath(path)) || new Set(value).size !== value.length) return fail('PRECONDITION_FAILED', 'repository list is malformed', unchanged)
  return { document, paths: value as string[], revision: createHash('sha256').update(document?.content ?? '').digest('hex') }
}
async function pathEntry(files: GitFiles, path: string): Promise<{ exists: boolean }> {
  const parts = path.split('/'); let parent = ''
  for (let index = 0; index < parts.length; index++) {
    const entry = (await files.list(parent, { showHidden: true })).find(item => item.name === parts[index])
    if (!entry) { if (index === parts.length - 1) return { exists: false }; return fail('NOT_FOUND', 'the parent directory does not exist', unchanged) }
    if (entry.kind !== 'directory') return fail('PRECONDITION_FAILED', 'repository paths must contain directories without symlinks', unchanged)
    parent = parent ? parent + '/' + parts[index] : parts[index]!
  }
  return { exists: true }
}
async function repositoryShape(files: GitFiles, path: string): Promise<void> {
  if (!(await pathEntry(files, path)).exists) return fail('NOT_FOUND', 'repository directory is missing', unchanged)
  const entry = (await files.list(path, { showHidden: true })).find(item => item.name === '.git')
  if (entry?.kind !== 'directory') return fail('PRECONDITION_FAILED', 'linked worktrees, bare repositories and symlink metadata are unsupported', unchanged)
  const metadata = await files.list(path + '/.git', { showHidden: true })
  if (metadata.some(item => item.kind === 'symlink' || ['commondir', 'config.worktree', 'shallow.lock'].includes(item.name)) || !metadata.some(item => item.name === 'config' && item.kind === 'file')) return fail('PRECONDITION_FAILED', 'repository metadata is unsupported', unchanged)
  for (const parent of ['objects', 'objects/info', 'info', 'refs']) {
    const parts = parent.split('/'); let base = path + '/.git'
    for (const part of parts) {
      const entries = await files.list(base, { showHidden: true }), entry = entries.find(item => item.name === part)
      if (!entry) break
      if (entry.kind !== 'directory') return fail('PRECONDITION_FAILED', 'repository metadata is unsupported', unchanged)
      base += '/' + part
      if (parts.at(-1) !== part) continue
      const children = await files.list(base, { showHidden: true })
      if (children.some(item => item.kind === 'symlink' || ['alternates', 'http-alternates', 'grafts', 'replace'].includes(item.name))) return fail('PRECONDITION_FAILED', 'alternate object stores and replacement metadata are unsupported', unchanged)
    }
  }
}
async function inspect(account: Account, path: string, files: GitFiles, run: AccountGitRun): Promise<GitRepositoryView> {
  await repositoryShape(files, path)
  const command = async (operation: GitOperation): Promise<string> => { const result = await run(account, path, operation); if (!result.ok || result.code !== 0) return fail('PRECONDITION_FAILED', 'Git could not read this repository', unchanged); return result.stdout }
  const config = parseSafeGitConfig(await command({ op: 'config' }))
  const branches = parseGitBranches(await command({ op: 'branches' }))
  const branch = (await command({ op: 'head' })).trim()
  if (!isGitBranch(branch)) return fail('PRECONDITION_FAILED', 'detached HEAD repositories are unsupported', unchanged)
  const current = branches.find(item => item.current)
  if (branches.length && (!current || current.name !== branch)) return fail('PRECONDITION_FAILED', 'repository changed during observation; read it again', unchanged)
  const status = await command({ op: 'status' }), changes = status.trimEnd() ? status.trimEnd().split('\n') : []
  if (changes.some(line => !/^[ MADRCU?!]{2} .+$/.test(line)) || changes.length > 10000) return fail('PRECONDITION_FAILED', 'Git status is malformed or too large', unchanged)
  return { path, branch, head: current?.hash ?? null, dirty: changes.length > 0, changedFiles: changes.length, branches, commits: current ? parseGitHistory(await command({ op: 'history' })) : [], remote: config.remote }
}
export async function runGitRequest(input: { account: Account; files: GitFiles; run: AccountGitRun | null; request: GitRequest; authorize(): Promise<void> }): Promise<AccountGitView> {
  const { account, files, request, run } = input
  await input.authorize()
  const before = await registry(files)
  const view = (data: typeof before, selected: GitRepositoryView | null): AccountGitView => ({ context: { accountId: account.id, username: account.username }, revision: data.revision, repositories: data.paths, selected, nativeAvailable: !!run, application: { op: request.op, state: request.op === 'list' || request.op === 'inspect' ? 'read' : 'verified', verificationRequired: false } })
  if (request.op === 'list') { await input.authorize(); return view(before, null) }
  if (request.op === 'inspect') {
    if (!before.paths.includes(request.path)) return fail('NOT_FOUND', 'repository is not registered', unchanged)
    if (!run) return fail('PRECONDITION_FAILED', 'the isolated Git runner is unavailable', unchanged)
    const selected = await inspect(account, request.path, files, run); await input.authorize(); return view(before, selected)
  }
  if (request.expectedRevision !== before.revision) return fail('CONFLICT', 'repository list changed; read it again', unchanged)
  if (request.op === 'remove') {
    if (!before.paths.includes(request.path)) return fail('NOT_FOUND', 'repository is not registered', unchanged)
    await input.authorize()
    const paths = before.paths.filter(path => path !== request.path), content = JSON.stringify(paths) + '\n'
    let saved = false
    try {
      await files.writeTextChecked(GIT_REGISTRY, content, before.document, 0o600)
      saved = true
      const after = await registry(files)
      if (after.document?.content !== content) throw new Error('registry_readback_mismatch')
      await input.authorize(); return view(after, null)
    } catch (error) {
      if (!saved && isXpanelError(error) && error.detail?.stateChanged === false) throw error
      return fail('SERVICE_UNAVAILABLE', 'repository list removal needs review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    }
  }
  if (!run) return fail('PRECONDITION_FAILED', 'the isolated Git runner is unavailable', unchanged)
  if (request.op === 'init' || request.op === 'clone') {
    if (before.paths.length >= GIT_LIMITS.repositories) return fail('LIMIT_EXCEEDED', 'at most 20 repositories can be registered', unchanged)
    if (before.paths.includes(request.path) || (await pathEntry(files, request.path)).exists) return fail('CONFLICT', 'choose a directory that does not exist', unchanged)
  } else {
    if (!before.paths.includes(request.path)) return fail('NOT_FOUND', 'repository is not registered', unchanged)
    const selected = await inspect(account, request.path, files, run)
    if (selected.dirty || selected.head !== request.expectedHead) return fail('CONFLICT', 'repository changed or contains uncommitted changes; read it again', unchanged)
    if (request.op === 'checkout' && !selected.branches.some(branch => branch.name === request.branch)) return fail('VALIDATION', 'choose an existing local branch', unchanged)
    if (request.op === 'pull' && !selected.remote) return fail('PRECONDITION_FAILED', 'this repository has no supported HTTPS origin', unchanged)
  }
  await input.authorize()
  let attempted = false
  try {
    if (request.op === 'init') { attempted = true; await files.mkdir(request.path, 0o750) }
    await input.authorize()
    if (request.op === 'checkout' || request.op === 'pull') {
      const current = await inspect(account, request.path, files, run)
      if (current.dirty || current.head !== request.expectedHead) return fail('CONFLICT', 'repository changed before the operation', unchanged)
      await input.authorize()
    }
    attempted = true
    const result = await run(account, request.op === 'clone' ? '.' : request.path, request.op === 'clone' ? { op: 'clone', path: request.path, url: request.url } : request.op === 'init' ? { op: 'init', branch: request.branch } : request.op === 'checkout' ? { op: 'checkout', branch: request.branch } : { op: 'pull' })
    if (!result.ok || result.code !== 0) throw new Error('git_operation_not_verified')
    const selected = await inspect(account, request.path, files, run)
    if (request.op === 'checkout' && selected.branch !== request.branch || request.op === 'init' && selected.branch !== request.branch || selected.dirty) throw new Error('git_readback_mismatch')
    let after = before
    if (request.op === 'init' || request.op === 'clone') {
      const content = JSON.stringify([...before.paths, request.path]) + '\n'
      await input.authorize(); await files.writeTextChecked(GIT_REGISTRY, content, before.document, 0o600); after = await registry(files)
      if (after.document?.content !== content) throw new Error('registry_readback_mismatch')
    }
    await input.authorize(); return view(after, selected)
  } catch (error) {
    if (!attempted && isXpanelError(error)) throw error
    return fail('SERVICE_UNAVAILABLE', 'Git operation needs review before retrying; files may have changed', { stateChanged: true, unknownOutcome: true, verificationRequired: true, path: request.path })
  }
}
export interface AccountGitRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; withAccountLifecycleLease<T>(accountId: string, operation: (account: Account) => Promise<T>): Promise<T>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  files(account: Account, plan: Plan): GitFiles
  run: AccountGitRun | null
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; principalId: string }): Promise<unknown>
}
export async function handleAccountGitRoute(req: Request, url: URL, method: string, deps: AccountGitRouteDeps): Promise<Response | null> {
  const match = /^\/accounts\/([a-z][a-z0-9]{0,15})\/git$/.exec(url.pathname)
  if (!match) return null
  if (!['GET', 'POST'].includes(method)) return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return fail('VALIDATION', 'Git requests do not accept query selectors', unchanged)
  const caller = deps.caller
  if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'Git requires the signed-in account owner', unchanged)
  let raw: unknown
  if (method === 'POST') { const text = await req.text(); if (text.length > 2048) return fail('VALIDATION', 'Git request is too large', unchanged); try { raw = JSON.parse(text) } catch { return fail('VALIDATION', 'Git request must be JSON', unchanged) } }
  const request = parseGitRequest(method, raw), account = await deps.store.getAccountByUsername(match[1]!)
  if (!account || account.id !== caller.accountId) return fail('FORBIDDEN', 'Git account does not match the current owner', unchanged)
  return deps.store.withAccountLifecycleLease(account.id, async fresh => {
    const authorize = async (): Promise<Plan> => {
      const principal = await deps.currentPrincipal(), plan = await deps.store.getPlan(fresh.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
      if (!principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || fresh.id !== caller.accountId || principal.accountId !== fresh.id || principal.username !== fresh.username || fresh.username !== match[1] || fresh.status !== 'active' || !plan || !features || features.disabled.includes(GIT_FEATURE)) return fail('FORBIDDEN', 'current account owner is not authorized for Git', unchanged)
      return plan
    }
    const plan = await authorize(), mutation = !['list', 'inspect'].includes(request.op)
    let result: AccountGitView
    try { result = await runGitRequest({ account: fresh, files: deps.files(fresh, plan), run: deps.run, request, authorize: async () => { await authorize() } }) }
    catch (error) { if (mutation) await deps.audit({ actor: caller.actor, principalId: caller.principalId, action: 'account.git.' + request.op, target: 'account:' + fresh.username, outcome: 'failed', detail: { verificationRequired: isXpanelError(error) && error.detail?.verificationRequired === true } }).catch(() => {}); throw error }
    if (mutation) try { await deps.audit({ actor: caller.actor, principalId: caller.principalId, action: 'account.git.' + request.op, target: 'account:' + fresh.username, outcome: 'ok', detail: { path: 'path' in request ? request.path : '' } }) } catch { return fail('SERVICE_UNAVAILABLE', 'Git operation and audit need review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
  })
}
