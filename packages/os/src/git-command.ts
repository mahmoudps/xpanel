/** git(1), git-status(1), git-for-each-ref(1), git-log(1): fixed machine-readable formats. */
export const GIT_BINARY = '/usr/bin/git'
export const GIT_LIMITS = { repositories: 20, branches: 100, commits: 20, outputBytes: 262144, timeoutSeconds: 60 } as const
export const GIT_CONFIG = [
  'credential.helper=', 'credential.interactive=false', 'core.hooksPath=/dev/null', 'core.fsmonitor=false',
  'core.pager=cat', 'core.attributesFile=/dev/null', 'core.quotePath=true', 'gc.auto=0', 'maintenance.auto=false',
  'protocol.allow=never', 'protocol.https.allow=always', 'protocol.file.allow=never', 'protocol.ext.allow=never',
  'http.followRedirects=false', 'http.sslVerify=true', 'http.proxy=', 'http.extraHeader=', 'submodule.recurse=false',
] as const
export const GIT_PREFIX = [GIT_BINARY, '--no-pager', ...GIT_CONFIG.flatMap(value => ['-c', value])] as const
export const GIT_BRANCH_FORMAT = '%(refname:short)%09%(objectname)%09%(HEAD)'
export const GIT_LOG_FORMAT = '%H%x09%aI%x09%s'
export type GitOperation = { op: 'status' | 'branches' | 'history' | 'config' | 'head' | 'pull' } | { op: 'init' | 'checkout'; branch: string } | { op: 'clone'; url: string; path: string }
export const isGitPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 240 && /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/.test(value) && !value.split('/').some(part => part === '.' || part === '..' || part.toLowerCase() === '.git')
export const isGitBranch = (value: unknown): value is string => typeof value === 'string' && value.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes('..') && !value.includes('//') && !value.includes('@{') && !value.endsWith('/') && !value.endsWith('.') && !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')) && value !== 'HEAD'
/** No credentials, custom ports, encoded path/query, local host names or non-HTTPS transports. */
export function isGitHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512 || !/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+$/.test(value) || value.split('/').slice(3).some(part => part === '..' || part === '.')) return false
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash && url.hostname.includes('.') && !/^(?:[0-9.]+|localhost|.*\.(?:localhost|local|internal))$/i.test(url.hostname) && !url.pathname.split('/').some(part => part === '..' || part === '.') } catch { return false }
}
export function buildGitCommand(operation: GitOperation): string[] {
  let tail: string[]
  switch (operation.op) {
    case 'status': tail = ['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all']; break
    case 'branches': tail = ['for-each-ref', '--count=101', '--format=' + GIT_BRANCH_FORMAT, 'refs/heads/']; break
    case 'history': tail = ['log', '--max-count=20', '--no-decorate', '--no-show-signature', '--format=' + GIT_LOG_FORMAT]; break
    case 'config': tail = ['config', '--local', '--no-includes', '--null', '--list']; break
    case 'head': tail = ['symbolic-ref', '--quiet', '--short', 'HEAD']; break
    case 'pull': tail = ['pull', '--ff-only', '--no-rebase', '--no-recurse-submodules', 'origin']; break
    case 'init': if (!isGitBranch(operation.branch)) throw new Error('invalid_git_branch'); tail = ['init', '--template=', '--initial-branch=' + operation.branch, '.']; break
    case 'checkout': if (!isGitBranch(operation.branch)) throw new Error('invalid_git_branch'); tail = ['checkout', '--no-recurse-submodules', operation.branch, '--']; break
    case 'clone': if (!isGitHttpsUrl(operation.url) || !isGitPath(operation.path)) throw new Error('invalid_git_clone'); tail = ['clone', '--no-local', '--no-hardlinks', '--no-recurse-submodules', '--template=', '--', operation.url, operation.path]; break
  }
  return [...GIT_PREFIX, ...tail]
}
/** Executor admission reconstructs the complete operation; no caller-provided switches are retained. */
export function isGitCommand(argv: readonly string[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  const tail = argv.slice(GIT_PREFIX.length)
  const same = (op: GitOperation): boolean => { try { return JSON.stringify(argv) === JSON.stringify(buildGitCommand(op)) } catch { return false } }
  for (const op of ['status', 'branches', 'history', 'config', 'head', 'pull'] as const) if (same({ op })) return true
  if (tail[0] === 'init') return same({ op: 'init', branch: tail[2]?.replace(/^--initial-branch=/, '') ?? '' })
  if (tail[0] === 'checkout') return same({ op: 'checkout', branch: tail[2] ?? '' })
  return tail[0] === 'clone' && same({ op: 'clone', url: tail[6] ?? '', path: tail[7] ?? '' })
}
