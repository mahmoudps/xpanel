import { describe, expect, it } from 'vitest'
import {
  MONITORING_DF_INODE_ARGV, MONITORING_DF_SPACE_ARGV, MONITORING_LOG_UNITS, MONITORING_PS_ARGV,
  isMonitoringCommand, monitoringJournalArgv, monitoringKillArgv, monitoringLogSearch, parseMonitoringLogQuery, parseMonitoringSignalRequest,
} from './monitoring-command.ts'

const query = (value: string) => parseMonitoringLogQuery(new URLSearchParams(value))
const signal = { pid: 4242, uid: 20001, comm: 'php-fpm8.3', startedAt: '2026-10-27T10:00:00.000Z', signal: 'TERM' }

describe('monitoring command grammar', () => {
  it('admits only the exact observers, the bounded journal grammar and one signal to one pid', () => {
    for (const argv of [MONITORING_PS_ARGV, MONITORING_DF_SPACE_ARGV, MONITORING_DF_INODE_ARGV]) expect(isMonitoringCommand([...argv])).toBe(true)
    expect(MONITORING_PS_ARGV.join(' ')).not.toMatch(/args|cmd|command/)
    expect(isMonitoringCommand(monitoringKillArgv(4242, 'TERM'))).toBe(true)
    expect(isMonitoringCommand(monitoringKillArgv(4242, 'KILL'))).toBe(true)
    const full = monitoringJournalArgv(query('unit=nginx.service&lines=500&since=2026-10-27T10:00Z&priority=3'))
    expect(full).toEqual(['/usr/bin/journalctl', '--no-pager', '-o', 'json', '--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,_PID', '-n', '500', '-u', 'nginx.service', '--since', '@' + String(Date.UTC(2026, 9, 27, 10) / 1000), '-p', '3'])
    expect(isMonitoringCommand(full)).toBe(true)
    expect(isMonitoringCommand(monitoringJournalArgv(query('unit=postfix@-.service')))).toBe(true)
    for (const argv of [
      [...MONITORING_PS_ARGV, 'args'], ['/usr/bin/ps', '-eo', 'pid=,args='], ['/usr/bin/df', '-B1', '-P', '-T', '/tmp'], ['/bin/df', '-i', '-P'],
      ['/usr/bin/kill', '-s', 'TERM', '1'], ['/usr/bin/kill', '-s', 'TERM', '-1'], ['/usr/bin/kill', '-s', 'HUP', '4242'], ['/usr/bin/kill', '-s', 'TERM', '4242', '4243'],
      ['/usr/bin/kill', '-s', 'TERM', '04242'], ['/usr/bin/kill', '-9', '4242'], ['/usr/bin/kill', '-s', 'TERM', '99999999'],
      [...full, '--vacuum-time=1s'], full.map(value => value.startsWith('--output-fields=') ? '--output-fields=MESSAGE,_CMDLINE' : value), full.filter(value => !value.startsWith('--output-fields=')), full.map(value => value === 'nginx.service' ? 'ssh.service;id' : value), full.map(value => value === '500' ? '501' : value),
      full.map(value => value === '3' ? '8' : value), full.map(value => value.startsWith('@') ? '-1h' : value), ['/usr/bin/journalctl', '--no-pager', '-o', 'json', '--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,_PID', '-n', '10', '-u', 'nginx.service', '-p', '3', '--since', '@1'],
      ['/usr/bin/journalctl', '--no-pager', '-o', 'json', '--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,_PID', '-n', '10', '-u', 'cron.service'], ['sh', '-c', full.join(' ')], [1, 2] as unknown as string[],
    ]) expect(isMonitoringCommand(argv)).toBe(false)
  })
  it('parses the strict log selector and refuses unit, priority and since injection', () => {
    expect(query('unit=xpanel-agent.service')).toEqual({ unit: 'xpanel-agent.service', lines: 100, since: null, priority: null })
    expect(query('unit=mariadb.service&since=2026-10-27T10:00:30.900Z&priority=0')).toEqual({ unit: 'mariadb.service', lines: 100, since: '2026-10-27T10:00:30.000Z', priority: 0 })
    expect(monitoringLogSearch(query('unit=php8.3-fpm.service&lines=7'))).toBe('unit=php8.3-fpm.service&lines=7')
    expect(MONITORING_LOG_UNITS).toContain('php83-php-fpm.service')
    for (const value of [
      '', 'unit=cron.service', 'unit=nginx', 'unit=nginx.service%20-n%201', 'unit=nginx.service&unit=ssh.service', 'unit=nginx.service&path=/etc', 'unit=../nginx.service',
      'unit=nginx.service&lines=0', 'unit=nginx.service&lines=501', 'unit=nginx.service&lines=1e2', 'unit=nginx.service&lines=-5',
      'unit=nginx.service&priority=8', 'unit=nginx.service&priority=-1', 'unit=nginx.service&priority=err', 'unit=nginx.service&priority=3;id',
      'unit=nginx.service&since=-1h', 'unit=nginx.service&since=@1700000000', 'unit=nginx.service&since=2026-10-27 10:00', 'unit=nginx.service&since=2026-10-27T10:00+02:00',
      'unit=nginx.service&since=2026-02-30T10:00Z', 'unit=nginx.service&since=yesterday',
    ]) expect(() => query(value)).toThrow()
  })
  it('parses one reviewed signal identity and requires a separate KILL confirmation', () => {
    expect(parseMonitoringSignalRequest(signal)).toEqual(signal)
    expect(parseMonitoringSignalRequest({ ...signal, signal: 'KILL', killConfirmed: true }).signal).toBe('KILL')
    for (const value of [
      { ...signal, signal: 'KILL' }, { ...signal, signal: 'KILL', killConfirmed: 'yes' }, { ...signal, killConfirmed: true }, { ...signal, signal: 'HUP' },
      { ...signal, pid: 1 }, { ...signal, pid: '4242' }, { ...signal, pid: 4242.5 }, { ...signal, uid: -1 }, { ...signal, comm: '' }, { ...signal, comm: 'a\nb' },
      { ...signal, startedAt: '2026-10-27T10:00:00Z' }, { ...signal, extra: 1 }, { pid: 4242 }, null, [],
    ]) expect(() => parseMonitoringSignalRequest(value)).toThrow()
    expect(() => monitoringKillArgv(1, 'TERM')).toThrow()
  })
})
