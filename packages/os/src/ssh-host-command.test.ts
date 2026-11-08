import { describe, expect, it } from 'vitest'
import { isSshHostCommand, isSshJournalCursor, sshCountArgv, sshLoginsArgv, sshPortLabelArgv, sshServiceArgv, SHELL_JAIL_LIST_HOMES, SHELL_JAIL_SUDOERS_TEST, shellJailProbeArgv, SSH_PORT_LIST } from './ssh-host-command.ts'

const cursor = 's=' + 'a'.repeat(32) + ';i=1f;b=' + 'b'.repeat(32) + ';m=2a;t=61b;x=9c'

describe('SSH host commands', { tags: ['unit'] }, () => {
  it('admits exactly the argv it builds', () => {
    for (const argv of [sshLoginsArgv('ssh.service', null), sshLoginsArgv('sshd.service', cursor), sshCountArgv('ssh.service', 'today'), sshCountArgv('sshd.service', 'all'), sshServiceArgv('stop', 'ssh.socket'), sshServiceArgv('start', 'sshd.service'),
      sshPortLabelArgv('-a', 22022), sshPortLabelArgv('-m', 8080), [...SSH_PORT_LIST], [...SHELL_JAIL_SUDOERS_TEST], shellJailProbeArgv('alice', SHELL_JAIL_LIST_HOMES), shellJailProbeArgv('alice', 'ls -A /home2/bob')]) expect(isSshHostCommand(argv), argv.join(' ')).toBe(true)
  })

  it('refuses other units, cursors, shell text and verbs', () => {
    for (const argv of [['/usr/bin/journalctl', '--unit', 'nginx.service', '--no-pager', '--output=cat', '--lines=30000'], ['/usr/bin/systemctl', 'stop', '--', 'nginx.service'], ['/usr/bin/systemctl', 'mask', '--', 'ssh.service'],
      ['/usr/sbin/semanage', 'port', '-a', '-t', 'http_port_t', '-p', 'tcp', '80'], ['/usr/sbin/runuser', '-u', 'alice', '--', '/opt/xpanel/bin/jailshell', '-c', 'cat /etc/shadow'], ['/usr/sbin/runuser', '-u', 'root', '--', '/bin/sh', '-c', 'ls -A /home']]) expect(isSshHostCommand(argv), argv.join(' ')).toBe(false)
    expect(isSshHostCommand([...sshLoginsArgv('ssh.service', cursor).slice(0, 7), 'x; rm', '--lines=2000'])).toBe(false)
    expect(isSshJournalCursor('s=1;i=2')).toBe(false)
    expect(() => sshLoginsArgv('ssh.service', '--since')).toThrow()
    expect(() => sshPortLabelArgv('-a', 70000)).toThrow()
    expect(() => shellJailProbeArgv('Alice', SHELL_JAIL_LIST_HOMES)).toThrow()
  })
})
