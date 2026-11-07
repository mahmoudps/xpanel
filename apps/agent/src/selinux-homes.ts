import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { system } from '@xpanel/render'
import type { AgentExecutor } from './executor.ts'

export const SELINUX_ENFORCE_PATH = '/sys/fs/selinux/enforce'
export const ACCOUNT_HOME_POLICY_STAMP = '/etc/xpanel/selinux-account-homes.sha256'
export const ACCOUNT_HOME_POLICY_SCRIPT = fileURLToPath(new URL('../../../scripts/selinux-account-homes.sh', import.meta.url))
/** One large home on a 1 vCPU host; the relabel runs in the background of an already serving agent. */
export const ACCOUNT_RELABEL_TIMEOUT_MS = 3_600_000

type Host = Pick<AgentExecutor, 'readFile' | 'runCommand'>

const managesContexts = async (executor: Host, family: string): Promise<boolean> =>
  family === 'rhel' && await executor.readFile(SELINUX_ENFORCE_PATH) !== null

const relabel = (executor: Host, username: string, paths: readonly string[]) => {
  const action = system.accountContextAction(username, paths, true)
  return executor.runCommand(['/usr/sbin/runuser', '-u', action.runAsUser, '--', ...action.argv])
}

/** A tree written outside the labelled directories (restore, transfer) keeps the wrong type until this runs. */
export const relabelAccountPaths = async (executor: Host, family: string | undefined, username: string, paths: readonly string[]): Promise<void> => {
  if (family === undefined || !await managesContexts(executor, family)) return
  const result = await relabel(executor, username, paths)
  if (!result.ok) fail('CONFIG_TEST_FAILED', `the SELinux contexts of ${username} could not be restored`, { stateChanged: true, verificationRequired: true })
}

/**
 * An upgrade restarts this agent but never reruns the installer, so the policy and the existing homes are brought
 * here. The stamp is written last: an interrupted relabel repeats, and a changed policy script applies once.
 */
export const ensureAccountHomeContexts = async (executor: Pick<AgentExecutor, 'readFile' | 'runCommand' | 'writeFile'>, family: string, accounts: readonly Pick<Account, 'username' | 'home'>[], script = ACCOUNT_HOME_POLICY_SCRIPT): Promise<void> => {
  if (!await managesContexts(executor, family)) return
  const stamp = createHash('sha256').update(await readFile(script)).digest('hex')
  if ((await executor.readFile(ACCOUNT_HOME_POLICY_STAMP))?.trim() === stamp) return
  const policy = await executor.runCommand(['/bin/bash', script])
  if (!policy.ok) fail('CONFIG_TEST_FAILED', 'SELinux refused the account home policy', { stateChanged: false })
  const failed: string[] = []
  for (const account of accounts) if (!(await relabel(executor, account.username, [account.home])).ok) failed.push(account.username)
  if (failed.length) fail('CONFIG_TEST_FAILED', `the SELinux contexts of ${failed.length} account homes could not be restored`, { stateChanged: true, verificationRequired: true, accounts: failed.slice(0, 20) })
  await executor.writeFile({ path: ACCOUNT_HOME_POLICY_STAMP, content: `${stamp}\n`, mode: 0o644, owner: 'root', group: 'root' })
}
