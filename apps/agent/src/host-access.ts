import { acmeDirAction, acmeTraverseAclArgv } from '@xpanel/os'
import type { AgentExecutor } from './executor.ts'

/** Creates the HTTP-01 directory and lets nginx traverse its setgid parent. */
export const ensureAcmeWebRoot = async (executor: AgentExecutor, nginxUser: string): Promise<void> => {
  await executor.runAction(acmeDirAction())
  await executor.runAction({ kind: 'exec', argv: acmeTraverseAclArgv(nginxUser) })
}
