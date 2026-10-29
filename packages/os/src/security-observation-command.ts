import { fail } from '@xpanel/core'

export type SecurityObservationWindow = '24h' | '7d'
export interface SecurityObservationProfile {
  family: 'debian' | 'rhel'
  services: { sshd: string }
  paths: { sshdConfig: string }
}
export interface SecurityObservationCommandSet {
  unit: string
  window: SecurityObservationWindow
  effective: string[]
  service: string[]
  failures: string[]
}
const SSH_CONFIG = '/etc/ssh/sshd_config'
const UNITS = { debian: 'ssh.service', rhel: 'sshd.service' } as const
const WINDOWS = { '24h': '-24h', '7d': '-7d' } as const
const commands = (unit: string, window: SecurityObservationWindow): SecurityObservationCommandSet => ({
  unit, window,
  effective: ['/usr/sbin/sshd', '-T', '-f', SSH_CONFIG],
  service: ['/usr/bin/systemctl', 'show', unit, '--property=ActiveState,SubState,UnitFileState,LoadState'],
  failures: ['/usr/bin/journalctl', '--unit', unit, '--since', WINDOWS[window], '--no-pager', '--output=json', '--lines=500'],
})

/** Supported OS profiles alone select the unit and fixed system config path. */
export function securityObservationCommands(profile: SecurityObservationProfile, window: SecurityObservationWindow = '24h'): SecurityObservationCommandSet {
  const unit = profile.services.sshd.endsWith('.service') ? profile.services.sshd : profile.services.sshd + '.service'
  if (!Object.hasOwn(UNITS, profile.family) || unit !== UNITS[profile.family] || profile.paths.sshdConfig !== SSH_CONFIG || !Object.hasOwn(WINDOWS, window)) return fail('VALIDATION', 'unsupported SSH observation profile or range')
  return commands(unit, window)
}

/** Exact observer argv only: no general journal filters, units, paths or punctuation widening. */
export function isSecurityObservationCommand(argv: readonly string[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  for (const unit of Object.values(UNITS)) for (const window of Object.keys(WINDOWS) as SecurityObservationWindow[]) {
    const set = commands(unit, window)
    if ([set.effective, set.service, set.failures].some(expected => expected.length === argv.length && expected.every((value, index) => value === argv[index]))) return true
  }
  return false
}
