import { describe, expect, it } from 'vitest'
import { SERVER_ADDRESSES_ARGV, SERVER_ROUTES4_ARGV, SERVER_ROUTES6_ARGV, SERVER_TIMERS_ARGV, isServerObservationCommand, serverTimerOwner } from './server-observation-command.ts'
import { assertSafeArgv } from './validate.ts'

describe('reviewed server observation grammar', () => {
  it('admits exactly the four fixed read-only commands, which also satisfy the generic argv policy', () => {
    for (const argv of [SERVER_TIMERS_ARGV, SERVER_ADDRESSES_ARGV, SERVER_ROUTES4_ARGV, SERVER_ROUTES6_ARGV]) {
      expect(isServerObservationCommand([...argv])).toBe(true)
      expect(assertSafeArgv([...argv])).toEqual([...argv])
    }
  })
  it('refuses mutation verbs, extra operands, relative binaries and non-strings', () => {
    for (const argv of [
      ['/usr/bin/systemctl', 'list-timers', '--all', '--output=json'], ['/usr/bin/systemctl', 'list-timers', '--all', '--output=json', '--no-pager', 'x.timer'],
      ['/usr/bin/systemctl', 'start', 'logrotate.timer'], ['/usr/bin/systemctl', 'list-timers', '--all', '--output=json', '--no-pager', '--host=example.test'],
      ['/usr/sbin/ip', '-j', 'addr', 'add', '192.0.2.1/24', 'dev', 'eth0'], ['/usr/sbin/ip', '-j', 'route', 'flush'], ['/usr/sbin/ip', '-j', 'addr', 'show', 'dev', 'eth0'],
      ['/usr/sbin/ip', '-j', '-6', 'route', 'show', 'table', 'all'], ['/usr/sbin/ip', '-batch', '/tmp/x'], ['ip', '-j', 'addr', 'show'], ['/bin/sh', '-c', 'ip -j addr show'],
      ['/usr/bin/crontab', '-l', '-u', 'root'], [], ['/usr/sbin/ip', 7, 'addr', 'show'],
    ]) expect(isServerObservationCommand(argv)).toBe(false)
  })
  it('classifies account cron, panel and system timers by the rendered unit name only', () => {
    expect(serverTimerOwner('xpanel-cron-alice-backup-db.timer')).toEqual({ kind: 'account-cron', username: 'alice', jobId: 'backup-db' })
    expect(serverTimerOwner('xpanel-cron-Alice-x.timer')).toEqual({ kind: 'panel' })
    expect(serverTimerOwner('xpanel-cron-alice-.timer')).toEqual({ kind: 'panel' })
    expect(serverTimerOwner('xpanel-metrics.timer')).toEqual({ kind: 'panel' })
    expect(serverTimerOwner('logrotate.timer')).toEqual({ kind: 'system' })
  })
})
