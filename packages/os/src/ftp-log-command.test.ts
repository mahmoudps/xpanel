import { describe, expect, it } from 'vitest'
import { FTP_LOG_IDENTIFIER, ftpLogArgv, isFtpLogCommand, parseFtpLogFilters } from './ftp-log-command.ts'
import { JOURNALCTL } from './mail-log-command.ts'

const SINCE = '2026-10-27T00:00:00Z', UNTIL = '2026-10-27T12:00:00Z'

describe('ftp log command grammar', () => {
  it('builds and admits only the exact reviewed journalctl argv', () => {
    const argv = ftpLogArgv(SINCE, UNTIL, 20000)
    expect(argv).toEqual([JOURNALCTL, '--no-pager', '-o', 'json', '--output-fields=MESSAGE,SYSLOG_IDENTIFIER,_EXE,_SYSTEMD_UNIT', '--since', '2026-10-27 00:00:00 UTC', '--until', '2026-10-27 12:00:00 UTC', '-n', '20000', '-t', 'pure-ftpd'])
    expect(isFtpLogCommand(argv)).toBe(true)
    expect(isFtpLogCommand(ftpLogArgv(SINCE, '2026-11-03T00:00:00Z', 1))).toBe(true)
    expect(FTP_LOG_IDENTIFIER).toBe('pure-ftpd')
  })
  it('refuses identifier, time, limit, field and flag injection', () => {
    const base = ftpLogArgv(SINCE, UNTIL, 100)
    const swap = (from: string, to: unknown) => base.map(v => v === from ? to : v)
    const variants: unknown[][] = [
      [], base.slice(0, -1), [...base, '-t', 'sshd'], [...base, '--file=/tmp/x'], swap('pure-ftpd', 'sshd'), swap('pure-ftpd', 'pure-ftpd '),
      swap('100', '0'), swap('100', '20001'), swap('100', '0100'), swap('100', '1e3'), swap('2026-10-27 00:00:00 UTC', '-1d'),
      swap('2026-10-27 00:00:00 UTC', '2026-10-27 00:00:00 UTC; id'), swap('2026-10-27 00:00:00 UTC', '2026-10-19 00:00:00 UTC'), swap('2026-10-27 12:00:00 UTC', '2026-10-26 12:00:00 UTC'),
      swap('2026-10-27 00:00:00 UTC', '2026-02-30 00:00:00 UTC'), swap('json', 'export'), swap(JOURNALCTL, 'journalctl'), swap('--output-fields=MESSAGE,SYSLOG_IDENTIFIER,_EXE,_SYSTEMD_UNIT', '--output-fields=MESSAGE'),
      swap('-t', '-u'), swap('--no-pager', 7),
    ]
    for (const argv of variants) expect(isFtpLogCommand(argv)).toBe(false)
    expect(() => ftpLogArgv('2026-10-27T00:00:00.000Z', UNTIL, 1)).toThrow()
    expect(() => ftpLogArgv(SINCE, '2026-11-03T00:00:01Z', 1)).toThrow()
    expect(() => ftpLogArgv(UNTIL, SINCE, 1)).toThrow()
    expect(() => ftpLogArgv(SINCE, UNTIL, 1.5)).toThrow()
    expect(() => ftpLogArgv(SINCE, UNTIL, 20001)).toThrow()
  })
  it('parses strict search filters and refuses unsafe values', () => {
    const map = (values: Record<string, string>) => (key: string) => values[key] ?? null
    expect(parseFtpLogFilters(map({ user: 'Bob@Example.com', client: '2001:DB8::1', kind: 'login-failed', text: '  Public_HTML ' }))).toEqual({ user: 'Bob@Example.com', client: '2001:db8::1', kind: 'login-failed', text: 'public_html' })
    expect(parseFtpLogFilters(map({ user: 'two words' }))).toEqual({ user: 'two words' })
    expect(parseFtpLogFilters(map({}))).toEqual({})
    for (const bad of [{ user: '' }, { user: 'a\u0000' }, { user: 'x'.repeat(255) }, { client: '203.0.113.5 ' }, { client: 'a/b' }, { client: '' }, { kind: 'shell' }, { text: '   ' }, { text: 'a\nb' }] as Record<string, string>[]) {
      expect(() => parseFtpLogFilters(map(bad))).toThrow()
    }
  })
})
