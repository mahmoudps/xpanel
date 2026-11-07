import { readFile } from 'node:fs/promises'
import {
  defaultFrp, defaultHostDaemons, defaultHostScheduler, defaultLinuxTools, HOST_TOOLS_STATE, validateFrp, validateHostDaemons, validateHostScheduler, validateLinuxTools,
} from '@xpanel/core'
import type { FrpState, HostAction, HostDaemons, HostScheduler, HostsEntry, LinuxTools, OsProfile, RenderedFile } from '@xpanel/core'
import { system } from '@xpanel/render'
import { readSaved } from './server-operations.ts'

export interface HostToolsInput { scheduler: HostScheduler; daemons: HostDaemons; frp: FrpState; linux: LinuxTools; program: string }
interface CompileSnapshot { accounts: readonly { username: string; uid: number; status: string }[]; domains: readonly { name: string; docRoot: string }[] }

export const hostTaskProgram = async (node = process.execPath): Promise<string> => `#!${node} --max-old-space-size=48\n${await readFile(new URL('./host-task-program.cjs', import.meta.url), 'utf8')}`

export async function readHostTools(rootDir: string): Promise<HostToolsInput> {
  const scheduler = await readSaved(rootDir, HOST_TOOLS_STATE.scheduler, validateHostScheduler) ?? defaultHostScheduler()
  return {
    scheduler, daemons: await readSaved(rootDir, HOST_TOOLS_STATE.daemons, validateHostDaemons) ?? defaultHostDaemons(), frp: await readSaved(rootDir, HOST_TOOLS_STATE.frp, validateFrp) ?? defaultFrp(),
    linux: await readSaved(rootDir, HOST_TOOLS_STATE.linux, validateLinuxTools) ?? defaultLinuxTools(), program: scheduler.tasks.length + scheduler.scripts.length + scheduler.hooks.length ? await hostTaskProgram() : '',
  }
}

const HOSTS_BEGIN = '# BEGIN xPanel hosts', HOSTS_END = '# END xPanel hosts'
/** One managed block: the rendered /etc/hosts keeps every unrelated line, so the block is replaced whole on each generation. */
export function withHostsBlock(content: string, entries: readonly HostsEntry[]): string {
  const start = content.indexOf(HOSTS_BEGIN), end = content.indexOf(HOSTS_END)
  const base = start >= 0 && end > start ? content.slice(0, start) + content.slice(end + HOSTS_END.length).replace(/^\n/, '') : content
  return entries.length ? `${base.replace(/\n*$/, '\n')}${HOSTS_BEGIN}\n${entries.map(item => `${item.ip} ${item.names}`).join('\n')}\n${HOSTS_END}\n` : base
}

/** One compiler step: tasks, daemons, tunnels and the hosts block join the generation like any other rendered file. */
export function applyHostTools(files: RenderedFile[], preActions: HostAction[], postActions: HostAction[], input: HostToolsInput, os: OsProfile, snapshot: CompileSnapshot): void {
  const tasks = system.renderHostTasks(input.scheduler, { program: input.program, family: os.family, domains: new Map(snapshot.domains.map(domain => [domain.name, domain.docRoot])) })
  const daemons = system.renderHostDaemons(input.daemons, new Map(snapshot.accounts.filter(account => account.status !== 'terminating').map(account => [account.username, account.uid])))
  const frp = system.renderFrp(input.frp)
  files.push(...tasks.files, ...daemons.files, ...frp.files)
  preActions.push(...tasks.preActions, ...frp.preActions)
  postActions.push(...tasks.postActions, ...daemons.postActions, ...frp.postActions)
  const hosts = files.find(file => file.path === '/etc/hosts')
  if (hosts) hosts.content = withHostsBlock(hosts.content, input.linux.hosts)
}
