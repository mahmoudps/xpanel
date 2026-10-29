import { describe, expect, it } from 'vitest'
import { isSecurityObservationCommand, securityObservationCommands } from './security-observation-command.ts'

const apt = { family: 'debian' as const, services: { sshd: 'ssh' }, paths: { sshdConfig: '/etc/ssh/sshd_config' } }
const dnf = { family: 'rhel' as const, services: { sshd: 'sshd' }, paths: { sshdConfig: '/etc/ssh/sshd_config' } }

describe('fixed SSH observation argv policy', () => {
  it.each([apt, dnf])('admits only the supported $family profile commands and both bounded windows', profile => {
    for (const window of ['24h', '7d'] as const) {
      const commands = securityObservationCommands(profile, window)
      expect(commands.window).toBe(window)
      for (const argv of [commands.effective, commands.service, commands.failures]) expect(isSecurityObservationCommand(argv)).toBe(true)
      expect(commands.failures).toEqual(['/usr/bin/journalctl', '--unit', profile.family === 'debian' ? 'ssh.service' : 'sshd.service', '--since', window === '24h' ? '-24h' : '-7d', '--no-pager', '--output=json', '--lines=500'])
    }
  })
  it('refuses arbitrary configs, units, ranges, write operations and expanded flags', () => {
    const set = securityObservationCommands(apt)
    for (const argv of [
      ['/usr/sbin/sshd', '-T', '-f', '/tmp/custom'], ['/usr/bin/systemctl', 'restart', 'ssh.service'],
      ['/usr/bin/journalctl', '--unit', 'nginx.service', '--since', '-24h', '--no-pager', '--output=json', '--lines=500'],
      [...set.failures, '--vacuum-time=1s'], [...set.failures.slice(0, -1), '--lines=5000'],
      set.failures.map(value => value === '-24h' ? '-1h' : value), ['sh', '-c', set.failures.join(' ')],
      set.service.map(value => value === 'ssh.service' ? 'ssh.service;id' : value),
    ]) expect(isSecurityObservationCommand(argv)).toBe(false)
    expect(() => securityObservationCommands({ ...apt, paths: { sshdConfig: '/tmp/custom' } })).toThrow()
    expect(() => securityObservationCommands({ ...apt, services: { sshd: 'sshd' } })).toThrow()
    expect(() => securityObservationCommands(apt, '1h' as never)).toThrow()
  })
  it('returns fresh argv arrays without changing the accepted policy', () => {
    const first = securityObservationCommands(apt); first.failures[2] = 'nginx.service'
    expect(isSecurityObservationCommand(first.failures)).toBe(false)
    expect(isSecurityObservationCommand(securityObservationCommands(apt).failures)).toBe(true)
  })
})
