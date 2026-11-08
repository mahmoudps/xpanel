import { GIT_PREFIX, isGitBranch } from './git-command.ts'

/** Read-only Git viewer grammar (cPanel Gitweb): every value is validated here and the executor rebuilds the whole argv. */
export const GIT_VIEW_LIMITS = { logPage: 50, refs: 500, grepPerFile: 20, blobBytes: 200 * 1024 } as const
export const GIT_VIEW_LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s'
export const GIT_VIEW_COMMIT_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%s%x1f%b%x1e'
export const GIT_VIEW_REF_FORMAT = '%(refname)%09%(objectname)%09%(objecttype)%09%(creatordate:iso-strict)'
export const GIT_VIEW_SEARCH_KINDS = ['message', 'author', 'committer', 'pickaxe'] as const
export type GitViewSearchKind = typeof GIT_VIEW_SEARCH_KINDS[number]
export type GitViewOperation =
  | { op: 'view-log'; rev: string; skip: number; file?: string; search?: { kind: GitViewSearchKind; text: string } }
  | { op: 'view-refs' } | { op: 'view-commit'; hash: string } | { op: 'view-diff'; hash: string }
  | { op: 'view-tree'; rev: string; dir: string } | { op: 'view-blob'; rev: string; file: string } | { op: 'view-grep'; rev: string; text: string }

const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
/** A revision never starts with a dash and holds no rev-parse syntax, so it can only name an object or a ref. */
export const isGitViewRev = (value: unknown): value is string => value === 'HEAD' || isGitBranch(value) || typeof value === 'string' && HASH.test(value)
export const isGitViewHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value)
export const isGitViewFile = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) && !/^[:/-]/.test(value) && !value.endsWith('/') && !value.split('/').some(part => part === '' || part === '.' || part === '..')
export const isGitViewText = (value: unknown): value is string => typeof value === 'string' && value.trim().length >= 1 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const isSkip = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000

export function buildGitViewCommand(operation: GitViewOperation): string[] {
  const bad = (): never => { throw new Error('invalid_git_view') }
  let tail: string[]
  switch (operation.op) {
    case 'view-log': {
      if (!isGitViewRev(operation.rev) || !isSkip(operation.skip) || operation.file !== undefined && !isGitViewFile(operation.file)) return bad()
      const { search } = operation, filters: string[] = []
      if (search) {
        if (!isGitViewText(search.text) || !GIT_VIEW_SEARCH_KINDS.includes(search.kind)) return bad()
        if (search.kind === 'pickaxe') filters.push('-S' + search.text)
        else filters.push('--fixed-strings', '--regexp-ignore-case', (search.kind === 'message' ? '--grep=' : search.kind === 'author' ? '--author=' : '--committer=') + search.text)
      }
      tail = ['log', '--max-count=' + GIT_VIEW_LIMITS.logPage, '--skip=' + operation.skip, '--no-show-signature', '--format=' + GIT_VIEW_LOG_FORMAT, ...filters, operation.rev, ...(operation.file === undefined ? [] : ['--', operation.file])]
      break
    }
    case 'view-refs': tail = ['for-each-ref', '--count=' + GIT_VIEW_LIMITS.refs, '--sort=-creatordate', '--format=' + GIT_VIEW_REF_FORMAT, 'refs/heads/', 'refs/remotes/', 'refs/tags/']; break
    case 'view-commit': if (!isGitViewHash(operation.hash)) return bad(); tail = ['show', '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--format=' + GIT_VIEW_COMMIT_FORMAT, '--numstat', operation.hash]; break
    case 'view-diff': if (!isGitViewHash(operation.hash)) return bad(); tail = ['show', '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--format=', '--patch', operation.hash]; break
    case 'view-tree': if (!isGitViewRev(operation.rev) || operation.dir !== '' && !isGitViewFile(operation.dir)) return bad(); tail = ['ls-tree', '-z', '--long', operation.dir ? operation.rev + ':' + operation.dir : operation.rev]; break
    case 'view-blob': if (!isGitViewRev(operation.rev) || !isGitViewFile(operation.file)) return bad(); tail = ['cat-file', 'blob', operation.rev + ':' + operation.file]; break
    case 'view-grep': if (!isGitViewRev(operation.rev) || !isGitViewText(operation.text)) return bad(); tail = ['grep', '--line-number', '--null', '-I', '--fixed-strings', '--ignore-case', '--max-count=' + GIT_VIEW_LIMITS.grepPerFile, '-e', operation.text, operation.rev]; break
  }
  return [...GIT_PREFIX, ...tail]
}

const value = (argv: readonly string[], prefix: string): string | undefined => argv.find(item => item.startsWith(prefix))?.slice(prefix.length)
function parsedLog(tail: readonly string[]): GitViewOperation | null {
  const dashes = tail.indexOf('--'), body = dashes < 0 ? tail : tail.slice(0, dashes), file = dashes < 0 ? undefined : tail[dashes + 1], rev = body.at(-1) ?? '', skip = Number(value(tail, '--skip=') ?? 'x')
  const text = body.find(item => /^(?:-S|--grep=|--author=|--committer=)/.test(item))
  if (text === undefined) return { op: 'view-log', rev, skip, ...(file === undefined ? {} : { file }) }
  const kind: GitViewSearchKind = text.startsWith('-S') ? 'pickaxe' : text.startsWith('--grep=') ? 'message' : text.startsWith('--author=') ? 'author' : 'committer'
  return { op: 'view-log', rev, skip, ...(file === undefined ? {} : { file }), search: { kind, text: text.slice(text.startsWith('-S') ? 2 : text.indexOf('=') + 1) } }
}
function parsedSpec(spec: string): { rev: string; path: string } { const at = spec.indexOf(':'); return at < 0 ? { rev: spec, path: '' } : { rev: spec.slice(0, at), path: spec.slice(at + 1) } }
export function parseGitViewCommand(argv: readonly string[]): GitViewOperation | null {
  const tail = argv.slice(GIT_PREFIX.length)
  switch (tail[0]) {
    case 'log': return parsedLog(tail)
    case 'for-each-ref': return { op: 'view-refs' }
    case 'show': return tail.includes('--patch') ? { op: 'view-diff', hash: tail.at(-1) ?? '' } : { op: 'view-commit', hash: tail.at(-1) ?? '' }
    case 'ls-tree': { const { rev, path } = parsedSpec(tail.at(-1) ?? ''); return { op: 'view-tree', rev, dir: path } }
    case 'cat-file': { const { rev, path } = parsedSpec(tail.at(-1) ?? ''); return { op: 'view-blob', rev, file: path } }
    case 'grep': return { op: 'view-grep', rev: tail.at(-1) ?? '', text: tail.at(-2) ?? '' }
    default: return null
  }
}
export function isGitViewCommand(argv: readonly string[]): boolean {
  if (!Array.isArray(argv) || argv.some(item => typeof item !== 'string')) return false
  const operation = parseGitViewCommand(argv)
  if (!operation) return false
  try { return JSON.stringify(argv) === JSON.stringify(buildGitViewCommand(operation)) } catch { return false }
}
