import { lstat, realpath } from 'node:fs/promises'
import { fail, isAccountHome } from '@xpanel/core'
import type { Account, OsFamily } from '@xpanel/core'
import { system } from '@xpanel/render'
import { buildGitCommand, isGitCommand, isGitPath, GIT_CORE_DIR, GIT_DEPLOY_LIMITS, GIT_DEPLOY_SHELL, GIT_LIMITS } from '../../../packages/os/src/git-command.ts'
import type { GitOperation } from '../../../packages/os/src/git-command.ts'
import { buildGitViewCommand, isGitViewCommand } from '../../../packages/os/src/git-view-command.ts'
import type { GitViewOperation } from '../../../packages/os/src/git-view-command.ts'
import type { ConfigTestResult } from './executor.ts'

export type AccountGitOperation = GitOperation | GitViewOperation | { op: 'deploy'; script: string }
export type AccountGitRun = (account: Account, path: string, operation: AccountGitOperation) => Promise<ConfigTestResult>
const environment = {
  HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent', CURL_HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
  GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_PAGER: 'cat', LC_ALL: 'C',
} as const
const unset = 'GIT_CONFIG_PARAMETERS GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_TEMPLATE_DIR GIT_SSH GIT_SSH_COMMAND GIT_ASKPASS SSH_ASKPASS SSH_AUTH_SOCK NETRC LD_PRELOAD LD_LIBRARY_PATH http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY no_proxy'
/** Same account namespace as the file/cron runner, with executable paths restricted to Git and its HTTPS transport. */
export function buildAccountGitCommand(account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>, path: string, operation: GitOperation | GitViewOperation, family: OsFamily): string[] {
  if (path !== '.' && !isGitPath(path)) return fail('VALIDATION', 'invalid Git repository path', { stateChanged: false })
  const core = Object.hasOwn(GIT_CORE_DIR, family) ? GIT_CORE_DIR[family] : fail('UNSUPPORTED_OS', 'Git is not reviewed for this host profile', { stateChanged: false })
  const skeleton = system.buildJailedFileOpArgv(account, ['/usr/bin/git', '--version'], { cwdRel: path, env: { ...environment, GIT_EXEC_PATH: core } })
  const delimiter = skeleton.lastIndexOf('--')
  const prefix = skeleton.slice(0, delimiter).map(value => value === 'User=' + account.username ? 'User=' + account.uid : value === 'Group=' + account.username ? 'Group=' + account.gid : value)
  return [...prefix, '--property', 'RuntimeMaxSec=' + GIT_LIMITS.timeoutSeconds + 's', '--property', 'TimeoutStopSec=5s',
    '--property', 'MemoryMax=512M', '--property', 'TasksMax=32', '--property', 'NoExecPaths=/',
    '--property', 'ExecPaths=/usr/bin/git -' + core + '/git-remote-http -' + core + '/git-remote-https',
    '--property', 'InaccessiblePaths=-' + account.home + '/.ssh -' + account.home + '/.netrc -' + account.home + '/.git-credentials',
    '--property', 'UnsetEnvironment=' + unset, '--', ...(operation.op.startsWith('view-') ? buildGitViewCommand(operation as GitViewOperation) : buildGitCommand(operation as GitOperation))]
}
/** The account jail of a Git command, without its executable restriction: deployment tasks are the account's own commands. */
export function buildAccountDeployCommand(account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>, path: string, script: string, family: OsFamily): string[] {
  if (!isGitDeployScript(script)) return fail('VALIDATION', 'invalid deployment tasks', { stateChanged: false })
  const git = buildAccountGitCommand(account, path, { op: 'status' }, family), prefix = git.slice(0, git.indexOf('--'))
  return [...prefix.filter((value, index) => !/^(?:No)?ExecPaths=/.test(value) && !/^(?:No)?ExecPaths=/.test(prefix[index + 1] ?? '')), '--', ...GIT_DEPLOY_SHELL, script]
}
const isGitDeployScript = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= GIT_DEPLOY_LIMITS.scriptBytes && !value.includes('\0')
/** Exact outer admission. It cannot approve a general systemd-run, arbitrary executable, environment or Git argument. */
export function isAccountGitCommand(argv: readonly string[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  const delimiter = argv.indexOf('--'), command = argv.slice(delimiter + 1)
  if (delimiter < 1 || !isGitCommand(command) && !isGitViewCommand(command)) return false
  const prefix = accountGitPrefix(argv, delimiter)
  return !!prefix && JSON.stringify(argv.slice(0, delimiter + 1)) === JSON.stringify(prefix.git.slice(0, prefix.git.indexOf('--') + 1))
}
/** Exact admission of one deployment: the jail is rebuilt from its own identity and only the task text varies. */
export function isAccountDeployCommand(argv: readonly string[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  const delimiter = argv.indexOf('--'), command = argv.slice(delimiter + 1)
  if (delimiter < 1 || command.length !== 3 || command[0] !== GIT_DEPLOY_SHELL[0] || command[1] !== GIT_DEPLOY_SHELL[1] || !isGitDeployScript(command[2])) return false
  const prefix = accountGitPrefix(argv, delimiter)
  try { return !!prefix && JSON.stringify(argv) === JSON.stringify(buildAccountDeployCommand(prefix.account, prefix.path, command[2]!, prefix.family)) } catch { return false }
}
function accountGitPrefix(argv: readonly string[], delimiter: number): { account: { username: string; uid: number; gid: number; home: string }; path: string; family: OsFamily; git: string[] } | null {
  const uid = argv.find(value => /^User=[0-9]+$/.test(value))?.slice(5)
  const gid = argv.find(value => /^Group=[0-9]+$/.test(value))?.slice(6)
  const uidText = argv.find(value => /^Slice=xpanel-[0-9]+\.slice$/.test(value))?.slice(13, -6)
  const home = argv.find(value => value.startsWith('--setenv=HOME='))
  const bind = argv.find(value => value.startsWith('BindPaths='))?.slice(10)
  const cwd = argv.find(value => value.startsWith('--working-directory='))?.slice(20)
  const user = bind?.match(/^\/home[1-9]?[0-9]?\/([a-z][a-z0-9]{0,15})$/)?.[1]
  const family = (Object.keys(GIT_CORE_DIR) as OsFamily[]).find(key => argv.includes('--setenv=GIT_EXEC_PATH=' + GIT_CORE_DIR[key]))
  if (delimiter < 1 || !user || !uid || !gid || !family || uid !== uidText || home !== '--setenv=HOME=' + bind || !cwd?.startsWith(bind + '/')) return null
  const account = { username: user, uid: Number(uid), gid: Number(gid), home: bind! }, path = cwd.slice(bind!.length + 1)
  try { return { account, path, family, git: buildAccountGitCommand(account, path, { op: 'status' }, family) } } catch { return null }
}

/** Only construct this adapter for a native Linux executor after host qualification. */
export function createAccountGitRun(run: (argv: string[]) => Promise<ConfigTestResult>, family: OsFamily): AccountGitRun {
  return async (account, path, operation) => {
    const home = account.home
    const info = await lstat(home).catch(() => null)
    if (!isAccountHome(home, account.username) || !info?.isDirectory() || info.isSymbolicLink() || info.uid !== account.uid || info.gid !== account.gid || await realpath(home) !== home) return fail('PRECONDITION_FAILED', 'the account home identity could not be verified', { stateChanged: false })
    const argv = operation.op === 'deploy' ? buildAccountDeployCommand(account, path, operation.script, family) : buildAccountGitCommand(account, path, operation, family)
    if (!(operation.op === 'deploy' ? isAccountDeployCommand(argv) : isAccountGitCommand(argv))) return fail('PRECONDITION_FAILED', 'the isolated Git command was not admitted', { stateChanged: false })
    const result = await run(argv)
    if (Buffer.byteLength(result.stdout) > GIT_LIMITS.outputBytes || Buffer.byteLength(result.stderr) > 16384) return fail('PRECONDITION_FAILED', 'Git output exceeded its safe limit', { verificationRequired: true, unknownOutcome: true })
    return result
  }
}
