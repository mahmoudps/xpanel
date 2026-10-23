import { spawnSync } from 'node:child_process'

/** Commands that open the control database or the state tree. */
export const STATE_CLI_COMMANDS = new Set([
  'status',
  'reconcile',
  'rollback',
  'reindex',
  'init-root',
  'reset-password',
  'disable-2fa',
])

export type CliInvocation = 'help' | 'drop-to-xpanel' | 'repair-as-root' | 'run' | 'refuse'

/**
 * Root must not create state files. State-touching commands re-exec as the
 * `xpanel` user. Ownership repair stays root and only changes owners.
 */
export const classifyCliInvocation = (input: {
  platform: NodeJS.Platform
  uid: number | undefined
  command: string
  serviceUid: number | null
}): CliInvocation => {
  if (!input.command || input.command === 'help' || input.command === '--help' || input.command === '-h') return 'help'
  if (input.command === 'repair-state-ownership') return input.uid === 0 ? 'repair-as-root' : 'refuse'
  if (input.platform !== 'linux' || !STATE_CLI_COMMANDS.has(input.command)) return 'run'
  if (input.uid === 0) return 'drop-to-xpanel'
  if (input.serviceUid !== null && input.uid !== input.serviceUid) return 'refuse'
  return 'run'
}

/** uid of the `xpanel` account, or null when that account is not installed. */
export const xpanelServiceUid = (): number | null => {
  if (process.platform !== 'linux') return null
  const result = spawnSync('id', ['-u', 'xpanel'], { encoding: 'utf8' })
  if (result.status !== 0) return null
  const uid = Number(result.stdout.trim())
  return Number.isSafeInteger(uid) && uid > 0 ? uid : null
}
