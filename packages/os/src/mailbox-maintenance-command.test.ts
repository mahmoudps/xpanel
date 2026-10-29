import { describe, expect, it } from 'vitest'
import {
  DOVECONF_MAIL_PLUGINS_ARGV, isMailboxMaintenanceCommand, isMailboxMaintenanceJobCommand, isMaintenanceMailbox, mailboxFoldersArgv, mailboxMaintenanceArgv, mailboxQuotaArgv,
} from './mailbox-maintenance-command.ts'

describe('reviewed mailbox maintenance grammar', () => {
  it('builds the exact documented argv for one mailbox', () => {
    expect(mailboxQuotaArgv('alice@example.com')).toEqual(['/usr/bin/doveadm', '-f', 'json', 'quota', 'get', '-u', 'alice@example.com'])
    expect(mailboxFoldersArgv('alice@example.com')).toEqual(['/usr/bin/doveadm', '-f', 'json', 'mailbox', 'status', '-u', 'alice@example.com', 'messages vsize', '*'])
    expect(mailboxMaintenanceArgv('quota-recalc', 'alice@example.com')).toEqual(['/usr/bin/doveadm', 'quota', 'recalc', '-u', 'alice@example.com'])
    expect(mailboxMaintenanceArgv('resync', 'alice@example.com')).toEqual(['/usr/bin/doveadm', 'force-resync', '-u', 'alice@example.com', '*'])
    expect(mailboxMaintenanceArgv('index', 'alice@example.com')).toEqual(['/usr/bin/doveadm', 'index', '-u', 'alice@example.com', 'INBOX'])
    for (const argv of [mailboxQuotaArgv('a.b_c-d@mail.example.co'), mailboxFoldersArgv('x1@xn--p1ai.example'), [...DOVECONF_MAIL_PLUGINS_ARGV]]) expect(isMailboxMaintenanceCommand(argv)).toBe(true)
    for (const operation of ['quota-recalc', 'resync', 'index'] as const) {
      expect(isMailboxMaintenanceJobCommand(mailboxMaintenanceArgv(operation, 'alice@example.com'))).toBe(true)
      expect(isMailboxMaintenanceJobCommand(mailboxMaintenanceArgv(operation, 'alice@example.com'), operation)).toBe(true)
    }
    expect(isMailboxMaintenanceJobCommand(mailboxMaintenanceArgv('resync', 'alice@example.com'), 'index')).toBe(false)
  })
  it('refuses wildcard users, all-user flags and option or shell injection', () => {
    for (const mailbox of ['', '*', '*@example.com', 'a?c@example.com', '-A', '-Aalice@example.com', '.alice@example.com', 'alice.@example.com', 'al..ice@example.com', 'Alice@example.com', 'alice@example', 'alice@-example.com',
      'alice@example..com', 'a b@example.com', 'alice@example.com\n', 'alice;id@example.com', 'a+b@example.com', 'alice@exa_mple.com', 'a@b@example.com', 'x'.repeat(65) + '@example.com', 'a@' + 'b'.repeat(250) + '.com', 7, null]) expect(isMaintenanceMailbox(mailbox)).toBe(false)
    expect(() => mailboxQuotaArgv('*@example.com')).toThrow()
    expect(() => mailboxMaintenanceArgv('resync', '-A')).toThrow()
    expect(() => mailboxMaintenanceArgv('purge' as 'resync', 'alice@example.com')).toThrow()
    for (const argv of [
      ['/usr/bin/doveadm', '-f', 'json', 'quota', 'get', '-A'], ['/usr/bin/doveadm', '-f', 'json', 'quota', 'get', '-u', '*'], ['/usr/bin/doveadm', '-f', 'json', 'quota', 'get', '-u', 'alice@example.com', '-A'],
      ['/usr/bin/doveadm', '-f', 'json', 'quota', 'get', '-F', '/tmp/users'], ['doveadm', '-f', 'json', 'quota', 'get', '-u', 'alice@example.com'], ['/usr/bin/doveadm', '-f', 'flow', 'quota', 'get', '-u', 'alice@example.com'],
      ['/usr/bin/doveadm', '-f', 'json', 'mailbox', 'status', '-u', 'alice@example.com', 'messages', 'vsize', '*'], ['/usr/bin/doveadm', '-f', 'json', 'mailbox', 'status', '-u', 'alice@example.com', 'all', '*'],
      ['/usr/bin/doveadm', '-f', 'json', 'mailbox', 'status', '-u', 'alice@example.com', 'messages vsize', 'INBOX'], ['/usr/bin/doveadm', '-f', 'json', 'fetch', '-u', 'alice@example.com', 'text', 'all'],
      ['/usr/bin/doveconf', '-h', 'passdb'], ['/usr/bin/doveconf', '-n'], ['/usr/bin/doveconf', '-h', 'mail_plugins', '-c', '/tmp/x'], mailboxMaintenanceArgv('resync', 'alice@example.com'), [], ['/usr/bin/doveadm', 7],
    ]) expect(isMailboxMaintenanceCommand(argv as string[])).toBe(false)
    for (const argv of [
      ['/usr/bin/doveadm', 'quota', 'recalc', '-A'], ['/usr/bin/doveadm', 'quota', 'recalc', '-u', '*@example.com'], ['/usr/bin/doveadm', 'force-resync', '-A', '*'], ['/usr/bin/doveadm', 'force-resync', '-u', 'alice@example.com', '-f', '*'],
      ['/usr/bin/doveadm', 'force-resync', '-u', 'alice@example.com', 'INBOX'], ['/usr/bin/doveadm', 'index', '-u', 'alice@example.com', '*'], ['/usr/bin/doveadm', 'index', '-u', 'alice@example.com', '-q', 'INBOX'],
      ['/usr/bin/doveadm', 'expunge', '-u', 'alice@example.com', 'mailbox', '*', 'all'], ['/usr/bin/doveadm', 'quota', 'recalc', '-u', 'alice@example.com', 'bob@example.com'], ['/bin/sh', '-c', 'doveadm quota recalc -A'],
      mailboxQuotaArgv('alice@example.com'), [...DOVECONF_MAIL_PLUGINS_ARGV],
    ]) expect(isMailboxMaintenanceJobCommand(argv)).toBe(false)
  })
})
