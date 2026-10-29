import { createHash } from 'node:crypto'
import type { OsProfile, RenderedFile } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { AgentExecutor } from '../executor.ts'
import { ensureOpenDkimSigning, type OpenDkimSetup } from './opendkim-live.ts'

/** Path to the active generation's content hash. A restart must not replace those bytes. */
export type OwnedChecksums = ReadonlyMap<string, string>

const contentSha = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex')

/**
 * A generation-owned path is written only when the new bytes are the generation's
 * bytes. Anything else would show up as drift on the next check.
 */
const mayWrite = (path: string, next: string, existing: string | null, owned?: OwnedChecksums): boolean => {
  if (existing === next) return false
  if (!owned) return true
  const expected = owned.get(path)
  if (expected === undefined) return true
  return contentSha(next) === expected
}

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

const backupStamp = (): string => new Date().toISOString().replace(/[:.]/g, '')

/** Writes only when the bytes change, and keeps the previous file beside it. */
const writeTextIfChanged = async (executor: AgentExecutor, path: string, content: string): Promise<void> => {
  const existing = await executor.readFile(path)
  if (existing === content) return
  if (existing !== null) await writeText(executor, `${path}.bak.${backupStamp()}`, existing)
  await writeText(executor, path, content)
}

const writeFileIfChanged = async (executor: AgentExecutor, file: RenderedFile): Promise<void> => {
  await writeTextIfChanged(executor, file.path, file.content)
}

/**
 * Merges virtual-mailbox delivery, the OpenDKIM milter, special-use folders,
 * and the count quota plugin into the live Postfix and Dovecot files. Those
 * files stay outside the generation manifest: the journal deletes paths that
 * disappear from the next generation.
 */
const writeRendered = async (executor: AgentExecutor, file: RenderedFile, owned?: OwnedChecksums): Promise<void> => {
  const existing = await executor.readFile(file.path)
  if (!mayWrite(file.path, file.content, existing, owned)) return
  await writeFileIfChanged(executor, file)
}

export const applyPostfixLocalDelivery = async (
  executor: AgentExecutor,
  os: OsProfile,
  owned?: OwnedChecksums,
  options: services.PostfixMainOptions = {},
): Promise<void> => {
  await writeRendered(executor, services.renderDovecotAuthConf(os), owned)
  await writeRendered(executor, services.renderDovecotSpecialUseConf(os), owned)
  await writeRendered(executor, services.renderDovecotQuotaConf(os), owned)
  const paths = managedPaths(os)
  const mainExisting = (await executor.readFile(paths.main)) ?? ''
  const masterExisting = (await executor.readFile(paths.master)) ?? ''
  let mainBody = services.localDeliveryMainBlock(os, options)
  let masterBody = services.localSubmissionMasterBlock(os, options)
  const mainFragment = `${os.paths.postfixDir}/xpanel/main.cf.fragment`
  const masterFragment = `${os.paths.postfixDir}/xpanel/master.cf.fragment`
  if (owned?.has(mainFragment) || owned?.has(masterFragment)) {
    const savedMain = await executor.readFile(mainFragment)
    const savedMaster = await executor.readFile(masterFragment)
    // Startup has no desired mail options. Reuse only the active generation's exact
    // fragments; missing/drifted fragments must never reset TLS or dedicated IPs.
    if (savedMain === null || savedMaster === null || contentSha(savedMain) !== owned.get(mainFragment)
      || contentSha(savedMaster) !== owned.get(masterFragment)) return
    mainBody = savedMain
    masterBody = savedMaster
  }
  const main = services.replaceManagedBlock(mainExisting, mainBody)
  const master = services.replaceManagedBlock(masterExisting, masterBody)
  if (mayWrite(paths.main, main, mainExisting.length > 0 ? mainExisting : null, owned)) {
    await writeTextIfChanged(executor, paths.main, main)
  }
  if (mayWrite(paths.master, master, masterExisting.length > 0 ? masterExisting : null, owned)) {
    await writeTextIfChanged(executor, paths.master, master)
  }
}

/** Merged distribution files are deliberately outside the removable manifest. */
export const localMailNeedsUpdate = async (executor: AgentExecutor, os: OsProfile, options: services.PostfixMainOptions): Promise<boolean> => {
  const paths = managedPaths(os)
  for (const [path, body] of [[paths.main, services.localDeliveryMainBlock(os, options)], [paths.master, services.localSubmissionMasterBlock(os, options)]] as const) {
    const current = (await executor.readFile(path)) ?? ''
    if (services.replaceManagedBlock(current, body) !== current) return true
  }
  for (const file of [services.renderDovecotAuthConf(os), services.renderDovecotSpecialUseConf(os), services.renderDovecotQuotaConf(os)]) {
    if (await executor.readFile(file.path) !== file.content) return true
  }
  return false
}

/** Removes the managed region after the last mailbox leaves the generation. */
export const retirePostfixLocalDelivery = async (executor: AgentExecutor, os: OsProfile): Promise<boolean> => {
  let changed = false
  for (const path of Object.values(managedPaths(os))) {
    const existing = await executor.readFile(path)
    if (!existing || !existing.includes(services.MANAGED_BLOCK_BEGIN)) continue
    const next = stripManagedBlock(existing)
    if (next === existing) continue
    await writeTextIfChanged(executor, path, next)
    changed = true
  }
  return changed
}

/**
 * Fresh-install and agent-start mail stack. Lookup tables that already exist are
 * left alone so a later reconcile can fill them without this pass wiping mailboxes.
 * A dotted hostname sets the postmaster; otherwise the line already in
 * 11-xpanel-mailboxes.conf is kept.
 */
export const ensureInstalledMail = async (
  executor: AgentExecutor,
  os: OsProfile,
  hostname?: string | null,
  owned?: OwnedChecksums,
  domains: readonly string[] = [],
): Promise<OpenDkimSetup> => {
  const signing = await ensureOpenDkimSigning(executor, domains)
  const maps = services.renderPostfixMaps(os, [])
  for (const action of maps.actions) {
    if (action.kind === 'ensure-dir') await executor.runAction(action)
  }
  for (const file of maps.files) {
    const existing = await executor.readFile(file.path)
    if (existing !== null) continue
    if (!mayWrite(file.path, file.content, null, owned)) continue
    await executor.writeFile(file)
  }
  const mailboxPath = services.renderDovecotMailboxConf(os).path
  const existingMailbox = await executor.readFile(mailboxPath)
  const postmaster = services.resolveMailboxPostmaster(hostname, existingMailbox)
  const mailbox = services.renderDovecotMailboxConf(os, { postmaster })
  if (mayWrite(mailbox.path, mailbox.content, existingMailbox, owned)) await writeFileIfChanged(executor, mailbox)
  await applyPostfixLocalDelivery(executor, os, owned)
  await executor.runAction({ kind: 'systemd', verb: 'reload', unit: os.services.dovecot })
  await executor.runAction({ kind: 'systemd', verb: 'reload', unit: os.services.postfix })
  return signing
}
