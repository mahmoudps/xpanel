/** Reviewed read-only server observation grammar: four fixed argv, no caller operand, flag or path. */
export const SERVER_TIMERS_ARGV = ['/usr/bin/systemctl', 'list-timers', '--all', '--output=json', '--no-pager'] as const
export const SERVER_ADDRESSES_ARGV = ['/usr/sbin/ip', '-j', 'addr', 'show'] as const
export const SERVER_ROUTES4_ARGV = ['/usr/sbin/ip', '-j', 'route', 'show'] as const
export const SERVER_ROUTES6_ARGV = ['/usr/sbin/ip', '-j', '-6', 'route', 'show'] as const
/** Fixed host reads; only names are listed from the cron directory, never contents. */
export const SERVER_HOSTNAME_PATH = '/etc/hostname'
export const SERVER_RESOLV_CONF_PATH = '/etc/resolv.conf'
export const SERVER_CRON_DIRECTORY = '/etc/cron.d'

/** Shared by the agent parser and the API projection. */
export const SERVER_UNIT_NAME = /^[A-Za-z0-9:_.\\@-]{1,240}\.[a-z]{1,10}$/
export const SERVER_IFNAME = /^[A-Za-z0-9_.:@-]{1,15}$/
export const SERVER_CRON_ENTRY_NAME = /^[A-Za-z0-9._+-]{1,128}$/
export const SERVER_HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
export const SERVER_WORD = /^[A-Za-z0-9_.-]{1,32}$/
// Account cron units are rendered as xpanel-cron-<username>-<jobId>.timer (packages/render/src/system/units.ts).
const ACCOUNT_CRON_TIMER = /^xpanel-cron-([a-z][a-z0-9]{0,15})-([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)\.timer$/
export type ServerTimerOwner = { kind: 'account-cron'; username: string; jobId: string } | { kind: 'panel' } | { kind: 'system' }
export function serverTimerOwner(unit: string): ServerTimerOwner {
  const match = ACCOUNT_CRON_TIMER.exec(unit)
  return match ? { kind: 'account-cron', username: match[1]!, jobId: match[2]! } : unit.startsWith('xpanel-') ? { kind: 'panel' } : { kind: 'system' }
}

const REVIEWED = new Set([SERVER_TIMERS_ARGV, SERVER_ADDRESSES_ARGV, SERVER_ROUTES4_ARGV, SERVER_ROUTES6_ARGV].map(argv => argv.join('\u0000')))

export function isServerObservationCommand(argv: readonly unknown[]): boolean {
  return Array.isArray(argv) && argv.every(value => typeof value === 'string') && REVIEWED.has(argv.join('\u0000'))
}
