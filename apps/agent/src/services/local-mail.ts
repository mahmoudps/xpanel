import type { OsProfile, RenderedFile } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { AgentExecutor } from '../executor.ts'

const managedPaths = (os: OsProfile): { main: string; master: string } => ({
  main: `${os.paths.postfixDir}/main.cf`,
  master: `${os.paths.postfixDir}/master.cf`,
})

const stripManagedBlock = (existing: string): string =>
  existing.replace(new RegExp(`${services.MANAGED_BLOCK_BEGIN}[\\s\\S]*?${services.MANAGED_BLOCK_END}\\n?`), '')

const writeText = async (executor: AgentExecutor, path: string, content: string): Promise<void> => {
  const file: RenderedFile = { path, content, mode: 0o644, owner: 'root', group: 'root' }
  await executor.writeFile(file)
}

/**
 * Merges virtual-mailbox delivery and the loopback submission service into the
 * live Postfix files. Those files stay outside the generation manifest: the
 * journal deletes paths that disappear from the next generation.
 */
export const applyPostfixLocalDelivery = async (executor: AgentExecutor, os: OsProfile): Promise<void> => {
  await executor.writeFile(services.renderDovecotAuthConf(os))
  const paths = managedPaths(os)
  const main = services.replaceManagedBlock((await executor.readFile(paths.main)) ?? '', services.localDeliveryMainBlock(os))
  const master = services.replaceManagedBlock((await executor.readFile(paths.master)) ?? '', services.localSubmissionMasterBlock(os))
  await writeText(executor, paths.main, main)
  await writeText(executor, paths.master, master)
}

/** Removes the managed region after the last mailbox leaves the generation. */
export const retirePostfixLocalDelivery = async (executor: AgentExecutor, os: OsProfile): Promise<boolean> => {
  let changed = false
  for (const path of Object.values(managedPaths(os))) {
    const existing = await executor.readFile(path)
    if (!existing || !existing.includes(services.MANAGED_BLOCK_BEGIN)) continue
    const next = stripManagedBlock(existing)
    if (next === existing) continue
    await writeText(executor, path, next)
    changed = true
  }
  return changed
}

/**
 * Fresh-install and agent-start mail stack. Lookup tables that already exist are
 * left alone so a later reconcile can fill them without this pass wiping mailboxes.
 */
export const ensureInstalledMail = async (executor: AgentExecutor, os: OsProfile): Promise<void> => {
  const maps = services.renderPostfixMaps(os, [])
  for (const action of maps.actions) {
    if (action.kind === 'ensure-dir') await executor.runAction(action)
  }
  for (const file of maps.files) {
    if ((await executor.readFile(file.path)) === null) await executor.writeFile(file)
  }
  await executor.writeFile(services.renderDovecotMailboxConf(os))
  await applyPostfixLocalDelivery(executor, os)
  await executor.runAction({ kind: 'systemd', verb: 'reload', unit: os.services.dovecot })
  await executor.runAction({ kind: 'systemd', verb: 'reload', unit: os.services.postfix })
}
