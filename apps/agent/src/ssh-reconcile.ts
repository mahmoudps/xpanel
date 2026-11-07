import { effectiveServerSshSettings } from '@xpanel/core'
import type { HostAction, OsProfile, RenderedFile, ServerSettings } from '@xpanel/core'
import { system } from '@xpanel/render'
import { sshUnit } from './ssh-host.ts'

export const sshdPolicyOf = (settings: ServerSettings): system.SshdSettings => {
  const { passwordAuth, pubkeyAuth, rootLogin, previousPort } = effectiveServerSshSettings(settings)
  return { port: settings.sshPort, ...(previousPort === undefined ? {} : { previousPort }), passwordAuth, pubkeyAuth, rootLogin }
}

/** The drop-in reaches the daemon only when it changed, and a daemon the operator stopped stays stopped. */
export function sshdReloadActions(os: OsProfile, files: readonly RenderedFile[], previous: readonly { path: string; sha256: string }[] | undefined, sha256: (text: string) => string, running: boolean): HostAction[] {
  const path = system.sshdDropinPath(os), file = files.find(item => item.path === path)
  if (!running || !previous || !file || previous.find(entry => entry.path === path)?.sha256 === sha256(file.content)) return []
  return system.sshdApplyActions(os)
}

/** The observed state only: a host that cannot say keeps reloading, so a policy never waits silently. */
export const sshdObservedRunning = (stdout: string): boolean => !/^ActiveState=(?:inactive|failed)$/m.test(stdout)
export const sshdStateArgv = (os: Pick<OsProfile, 'services'>): string[] => ['/usr/bin/systemctl', 'show', sshUnit(os), '--property=ActiveState,SubState,UnitFileState,LoadState']
