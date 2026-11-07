import { fail, isXpanelError } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { GIT_VIEW_LIMITS, GIT_VIEW_SEARCH_KINDS, isGitViewFile, isGitViewHash, isGitViewRev, isGitViewText } from '../../../packages/os/src/git-view-command.ts'
import type { GitViewOperation, GitViewSearchKind } from '../../../packages/os/src/git-view-command.ts'
import { isGitPath } from '../../../packages/os/src/git-command.ts'
import { parseSafeGitConfig } from './account-git.ts'
import type { AccountGitRun } from './account-git-runner.ts'

export type GitViewRequest = { path: string } & (
  | { view: 'log'; rev: string; skip: number; file?: string; search?: { kind: GitViewSearchKind; text: string } }
  | { view: 'refs' } | { view: 'commit'; hash: string } | { view: 'tree'; rev: string; dir: string } | { view: 'blob'; rev: string; file: string } | { view: 'grep'; rev: string; text: string })
export interface GitViewCommit { hash: string; parents: string[]; author: string; at: string; refs: string[]; subject: string }
export interface GitViewRef { name: string; kind: 'branch' | 'remote' | 'tag'; hash: string; at: string | null }
export interface GitViewTreeEntry { name: string; kind: 'blob' | 'tree' | 'commit'; mode: string; sizeBytes: number | null }
export interface GitViewChange { file: string; added: number | null; removed: number | null }
export type GitViewResult =
  | { view: 'log'; commits: GitViewCommit[]; hasMore: boolean }
  | { view: 'refs'; refs: GitViewRef[] }
  | { view: 'commit'; hash: string; parents: string[]; author: string; email: string; at: string; committer: string; committedAt: string; subject: string; body: string; changes: GitViewChange[]; patch: string | null }
  | { view: 'tree'; rev: string; dir: string; entries: GitViewTreeEntry[] }
  | { view: 'blob'; rev: string; file: string; sizeBytes: number; state: 'text' | 'binary' | 'too-large'; text: string | null }
  | { view: 'grep'; rev: string; matches: { file: string; line: number; text: string }[] }

const unchanged = { stateChanged: false }
const TEXT_MAX = 500
const clean = (text: string, max = TEXT_MAX): string => { const value = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '?'); return value.length > max ? value.slice(0, max - 3) + '...' : value }
const malformed = (): never => fail('PRECONDITION_FAILED', 'Git returned output this viewer cannot read', unchanged)

export function parseGitViewRequest(params: URLSearchParams): GitViewRequest {
  const allowed: Readonly<Record<string, readonly string[]>> = { log: ['rev', 'skip', 'file', 'search', 'text'], refs: [], commit: ['hash'], tree: ['rev', 'dir'], blob: ['rev', 'file'], grep: ['rev', 'text'] }
  const view = params.get('view') ?? '', path = params.get('path'), keys = [...params.keys()], rev = params.get('rev') ?? 'HEAD'
  const invalid = (): never => fail('VALIDATION', 'unsupported Git viewer selector', unchanged)
  if (!Object.hasOwn(allowed, view) || !isGitPath(path) || new Set(keys).size !== keys.length || keys.some(key => !['view', 'path', ...allowed[view]!].includes(key))) return invalid()
  if (['log', 'tree', 'blob', 'grep'].includes(view) && !isGitViewRev(rev)) return invalid()
  if (view === 'refs') return { view, path }
  if (view === 'commit') { const hash = params.get('hash'); return isGitViewHash(hash) ? { view, path, hash } : invalid() }
  if (view === 'tree') { const dir = params.get('dir') ?? ''; return dir === '' || isGitViewFile(dir) ? { view, path, rev, dir } : invalid() }
  if (view === 'blob') { const file = params.get('file'); return isGitViewFile(file) ? { view, path, rev, file } : invalid() }
  if (view === 'grep') { const text = params.get('text'); return isGitViewText(text) ? { view, path, rev, text } : invalid() }
  const skip = params.get('skip') ?? '0', file = params.get('file'), kind = params.get('search'), text = params.get('text')
  if (!/^(?:0|[1-9][0-9]{0,6})$/.test(skip) || file !== null && !isGitViewFile(file) || (kind === null) !== (text === null) || kind !== null && (!(GIT_VIEW_SEARCH_KINDS as readonly string[]).includes(kind) || !isGitViewText(text))) return invalid()
  return { view: 'log', path, rev, skip: Number(skip), ...(file === null ? {} : { file }), ...(kind === null ? {} : { search: { kind: kind as GitViewSearchKind, text: text! } }) }
}

export function parseViewLog(stdout: string): GitViewCommit[] {
  return stdout.split('\n').filter(Boolean).map(line => {
    const [hash, parents, author, at, decorations, ...subject] = line.split('\x1f')
    if (!isGitViewHash(hash) || subject.length !== 1 || !Number.isFinite(Date.parse(at ?? ''))) return malformed()
    return { hash, parents: parents ? parents.split(' ') : [], author: clean(author ?? ''), at: at!, refs: decorations ? decorations.split(', ').map(ref => clean(ref.replace(/^HEAD -> /, ''), 200)) : [], subject: clean(subject[0]!) }
  })
}
export function parseViewRefs(stdout: string): GitViewRef[] {
  return stdout.split('\n').filter(Boolean).map(line => {
    const [ref, hash, type, at] = line.split('\t'), match = /^refs\/(heads|remotes|tags)\/(.{1,200})$/.exec(ref ?? '')
    if (!match || !isGitViewHash(hash) || !type) return malformed()
    return { name: clean(match[2]!, 200), kind: match[1] === 'heads' ? 'branch' as const : match[1] === 'remotes' ? 'remote' as const : 'tag' as const, hash, at: at && Number.isFinite(Date.parse(at)) ? at : null }
  })
}
export function parseViewTree(stdout: string): GitViewTreeEntry[] {
  return stdout.split('\0').filter(Boolean).map(entry => {
    const match = /^([0-7]{6}) (blob|tree|commit) [0-9a-f]{40,64} +(\d+|-)\t(.+)$/s.exec(entry)
    if (!match) return malformed()
    return { mode: match[1]!, kind: match[2] as GitViewTreeEntry['kind'], sizeBytes: match[3] === '-' ? null : Number(match[3]), name: clean(match[4]!) }
  }).sort((left, right) => left.kind === right.kind ? (left.name < right.name ? -1 : 1) : left.kind === 'tree' ? -1 : right.kind === 'tree' ? 1 : 0)
}
export function parseViewCommit(stdout: string): Omit<Extract<GitViewResult, { view: 'commit' }>, 'view' | 'patch'> {
  const end = stdout.indexOf('\x1e'), fields = (end < 0 ? '' : stdout.slice(0, end)).split('\x1f')
  if (end < 0 || fields.length !== 9 || !isGitViewHash(fields[0])) return malformed()
  const [hash, parents, author, email, at, committer, committedAt, subject, body] = fields as [string, string, string, string, string, string, string, string, string]
  const changes = stdout.slice(end + 1).split('\n').filter(Boolean).map(line => { const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line); if (!match) return malformed(); return { file: clean(match[3]!), added: match[1] === '-' ? null : Number(match[1]), removed: match[2] === '-' ? null : Number(match[2]) } })
  return { hash, parents: parents ? parents.split(' ') : [], author: clean(author), email: clean(email), at, committer: clean(committer), committedAt, subject: clean(subject), body: clean(body.trim(), 8000), changes }
}
export function parseViewGrep(stdout: string): Extract<GitViewResult, { view: 'grep' }>['matches'] {
  return stdout.split('\n').filter(Boolean).map(line => {
    const zero = line.indexOf('\0'), colon = line.indexOf(':'), rest = line.slice(zero + 1), split = rest.indexOf(':'), number = Number(rest.slice(0, split))
    if (zero < 0 || colon < 0 || colon > zero || split < 1 || !Number.isSafeInteger(number)) return malformed()
    return { file: clean(line.slice(colon + 1, zero)), line: number, text: clean(rest.slice(split + 1)) }
  })
}

/** Every view runs through the jailed Git runner, after the repository's shape and configuration pass the same checks as an inspect. */
export async function runGitView(account: Account, request: GitViewRequest, run: AccountGitRun): Promise<GitViewResult> {
  const read = async (operation: GitViewOperation): Promise<string> => { const result = await run(account, request.path, operation); if (!result.ok || result.code !== 0) return fail('PRECONDITION_FAILED', 'Git could not read this repository', unchanged); return result.stdout }
  const config = await run(account, request.path, { op: 'config' })
  if (!config.ok || config.code !== 0) return fail('PRECONDITION_FAILED', 'Git could not read this repository', unchanged)
  parseSafeGitConfig(config.stdout)
  switch (request.view) {
    case 'log': {
      const { rev, skip, file, search } = request, commits = parseViewLog(await read({ op: 'view-log', rev, skip, ...(file === undefined ? {} : { file }), ...(search === undefined ? {} : { search }) }))
      return { view: 'log', commits, hasMore: commits.length === GIT_VIEW_LIMITS.logPage }
    }
    case 'refs': return { view: 'refs', refs: parseViewRefs(await read({ op: 'view-refs' })) }
    case 'commit': {
      const commit = parseViewCommit(await read({ op: 'view-commit', hash: request.hash }))
      // A diff over the output bound is omitted, never cut: a partial patch would misstate the commit.
      const patch = await read({ op: 'view-diff', hash: request.hash }).catch((error: unknown) => { if (isXpanelError(error)) return null; throw error })
      return { view: 'commit', ...commit, patch }
    }
    case 'tree': return { view: 'tree', rev: request.rev, dir: request.dir, entries: parseViewTree(await read({ op: 'view-tree', rev: request.rev, dir: request.dir })) }
    case 'blob': {
      const slash = request.file.lastIndexOf('/'), name = request.file.slice(slash + 1), parent = slash < 0 ? '' : request.file.slice(0, slash)
      const entry = parseViewTree(await read({ op: 'view-tree', rev: request.rev, dir: parent })).find(item => item.name === name)
      if (entry?.kind !== 'blob' || entry.sizeBytes === null) return fail('NOT_FOUND', 'file not found in this revision', unchanged)
      const base = { view: 'blob' as const, rev: request.rev, file: request.file, sizeBytes: entry.sizeBytes }
      if (entry.sizeBytes > GIT_VIEW_LIMITS.blobBytes) return { ...base, state: 'too-large', text: null }
      const text = await read({ op: 'view-blob', rev: request.rev, file: request.file })
      return text.includes('\0') ? { ...base, state: 'binary', text: null } : { ...base, state: 'text', text }
    }
    case 'grep': {
      const result = await run(account, request.path, { op: 'view-grep', rev: request.rev, text: request.text })
      // git-grep(1) exits 1 for no match, which is an answer and not a failure.
      if (!result.ok && result.code !== 1 || result.code !== 0 && result.code !== 1) return fail('PRECONDITION_FAILED', 'Git could not search this repository', unchanged)
      return { view: 'grep', rev: request.rev, matches: result.code === 1 ? [] : parseViewGrep(result.stdout) }
    }
  }
}
