import { lstat, realpath } from 'node:fs/promises'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { system } from '@xpanel/render'
import { buildGitCommand, isGitCommand, isGitPath, GIT_LIMITS } from '../../../packages/os/src/git-command.ts'
import type { GitOperation } from '../../../packages/os/src/git-command.ts'
import type { ConfigTestResult } from './executor.ts'

export type AccountGitRun = (account: Account, path: string, operation: GitOperation) => Promise<ConfigTestResult>
const environment = {
  HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent', CURL_HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
  GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_PAGER: 'cat', LC_ALL: 'C',
  GIT_EXEC_PATH: '/usr/lib/git-core',
} as const
const unset = 'GIT_CONFIG_PARAMETERS GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_TEMPLATE_DIR GIT_SSH GIT_SSH_COMMAND GIT_ASKPASS SSH_ASKPASS SSH_AUTH_SOCK NETRC LD_PRELOAD LD_LIBRARY_PATH http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY no_proxy'
/** Same account namespace as the file/cron runner, with executable paths restricted to Git and its HTTPS transport. */
export function buildAccountGitCommand(account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>, path: string, operation: GitOperation): string[] {
  if (path !== '.' && !isGitPath(path)) return fail('VALIDATION', 'invalid Git repository path', { stateChanged: false })
  const skeleton = system.buildJailedFileOpArgv(account, ['/usr/bin/git', '--version'], { cwdRel: path, env: environment })
  const delimiter = skeleton.lastIndexOf('--')
  const prefix = skeleton.slice(0, delimiter).map(value => value === 'User=' + account.username ? 'User=' + account.uid : value === 'Group=' + account.username ? 'Group=' + account.gid : value)
  return [...prefix, '--property', 'RuntimeMaxSec=' + GIT_LIMITS.timeoutSeconds + 's', '--property', 'TimeoutStopSec=5s',
    '--property', 'MemoryMax=512M', '--property', 'TasksMax=32', '--property', 'NoExecPaths=/',
    '--property', 'ExecPaths=/usr/bin/git -/usr/lib/git-core/git-remote-http -/usr/lib/git-core/git-remote-https',
    '--property', 'InaccessiblePaths=-' + account.home + '/.ssh -' + account.home + '/.netrc -' + account.home + '/.git-credentials',
    '--property', 'UnsetEnvironment=' + unset, '--', ...buildGitCommand(operation)]
}
/** Exact outer admission. It cannot approve a general systemd-run, arbitrary executable, environment or Git argument. */
export function isAccountGitCommand(argv: readonly string[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  const delimiter = argv.indexOf('--'), command = argv.slice(delimiter + 1)
  if (delimiter < 1 || !isGitCommand(command)) return false
  const uid = argv.find(value => /^User=[0-9]+$/.test(value))?.slice(5)
  const gid = argv.find(value => /^Group=[0-9]+$/.test(value))?.slice(6)
  const uidText = argv.find(value => /^Slice=xpanel-[0-9]+\.slice$/.test(value))?.slice(13, -6)
  const home = argv.find(value => value.startsWith('--setenv=HOME='))
  const bind = argv.find(value => value.startsWith('BindPaths='))?.slice(10)
  const cwd = argv.find(value => value.startsWith('--working-directory='))?.slice(20)
  const user = bind?.match(/^\/home\/([a-z][a-z0-9]{0,15})$/)?.[1]
  if (!user || !uid || !gid || uid !== uidText || home !== '--setenv=HOME=/home/' + user || !cwd?.startsWith(bind + '/')) return false
  try {
    const stub = buildAccountGitCommand({ username: user, uid: Number(uid), gid: Number(gid), home: bind! }, cwd.slice(bind!.length + 1), { op: 'status' })
    return JSON.stringify(argv.slice(0, delimiter + 1)) === JSON.stringify(stub.slice(0, stub.indexOf('--') + 1))
  } catch { return false }
}

/** Only construct this adapter for a native Linux executor after host qualification. */
export function createAccountGitRun(run: (argv: string[]) => Promise<ConfigTestResult>): AccountGitRun {
  return async (account, path, operation) => {
    const home = '/home/' + account.username
    const info = await lstat(home).catch(() => null)
    if (account.home !== home || !info?.isDirectory() || info.isSymbolicLink() || info.uid !== account.uid || info.gid !== account.gid || await realpath(home) !== home) return fail('PRECONDITION_FAILED', 'the account home identity could not be verified', { stateChanged: false })
    const argv = buildAccountGitCommand(account, path, operation)
    if (!isAccountGitCommand(argv)) return fail('PRECONDITION_FAILED', 'the isolated Git command was not admitted', { stateChanged: false })
    const result = await run(argv)
    if (Buffer.byteLength(result.stdout) > GIT_LIMITS.outputBytes || Buffer.byteLength(result.stderr) > 16384) return fail('PRECONDITION_FAILED', 'Git output exceeded its safe limit', { verificationRequired: true, unknownOutcome: true })
    return result
  }
}
