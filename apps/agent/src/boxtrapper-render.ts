import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { services } from '@xpanel/render'
import { readJsonIfExists } from '@xpanel/state'
import { BOXTRAPPER_PLUGIN } from '../../../packages/os/src/boxtrapper-command.ts'
import { boxTrapperRules, parseBoxTrapperConfig } from './boxtrapper-policy.ts'
import type { BoxTrapperConfig } from './boxtrapper-policy.ts'
import { admitMailxMailboxRows } from './mailfx-render.ts'
import type { MailxSnapshot } from './mailfx-render.ts'

export interface BoxTrapperRow { mailbox: string; accountId: string; serviceUserId: string; config: BoxTrapperConfig }
export const boxTrapperStateDir = (stateRoot: string): string => join(stateRoot, 'extended', 'webmail', 'boxtrapper')
/** The Maildir root ignores directories without a leading dot, so this travels with the mailbox: backups, moves and deletion. */
export const boxTrapperStore = (home: string, mailbox: string): string => {
  const at = mailbox.lastIndexOf('@')
  return `${home}/mail/${mailbox.slice(at + 1)}/${mailbox.slice(0, at)}/boxtrapper`
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Saved files; a malformed or foreign-bound file is skipped here and reported by the API view, never rendered. */
export async function readBoxTrapperRows(stateRoot: string): Promise<BoxTrapperRow[]> {
  const dir = boxTrapperStateDir(stateRoot)
  const names = (await readdir(dir).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))).filter(name => name.endsWith('.json')).sort()
  const rows: BoxTrapperRow[] = []
  for (const name of names) {
    try {
      const raw = await readJsonIfExists<unknown>(join(dir, name)), mailbox = decodeURIComponent(name.slice(0, -5))
      if (!object(raw) || raw.mailbox !== mailbox || !object(raw.ownerAuthority) || raw.ownerAuthority.mailbox !== mailbox || typeof raw.ownerAuthority.accountId !== 'string' || typeof raw.ownerAuthority.serviceUserId !== 'string') continue
      rows.push({ mailbox, accountId: raw.ownerAuthority.accountId, serviceUserId: raw.ownerAuthority.serviceUserId, config: parseBoxTrapperConfig(raw) })
    } catch { /* reported by the API view */ }
  }
  return rows
}
export const boxTrapperHostReady = (family: string): Promise<boolean> => {
  const plugin = BOXTRAPPER_PLUGIN[family as keyof typeof BOXTRAPPER_PLUGIN]
  return plugin ? access(plugin).then(() => true, () => false) : Promise.resolve(false)
}

/** Node without JIT needs no executable memory, which the LMTP domain has no reason to hold under SELinux. */
export const boxTrapperProgram = async (node = process.execPath): Promise<string> => `#!${node} --jitless\n${await readFile(new URL('./boxtrapper-program.cjs', import.meta.url), 'utf8')}`

/** Null without Pigeonhole's external programs module: delivery stays as it is and the page reports the missing module. */
export async function readBoxTrapperRender(stateRoot: string, snapshot: MailxSnapshot, family: string, spamFilterWired: boolean): Promise<services.BoxTrapperRenderInput | null> {
  if (!await boxTrapperHostReady(family)) return null
  const mailboxes = admitMailxMailboxRows(await readBoxTrapperRows(stateRoot), snapshot).filter(row => row.config.enabled).map(row => {
    const account = snapshot.accounts.find(item => item.id === row.accountId)!
    return { address: row.mailbox, account: { username: account.username, uid: account.uid ?? -1, gid: account.gid ?? -1, home: account.home }, rules: boxTrapperRules(row.config, row.mailbox, boxTrapperStore(account.home, row.mailbox), spamFilterWired), forward: row.config.forward }
  })
  return { program: await boxTrapperProgram(), mailboxes }
}
