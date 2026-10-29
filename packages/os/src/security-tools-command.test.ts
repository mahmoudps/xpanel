import { describe, expect, it } from 'vitest'
import {
  CLAMSCAN_VERSION_ARGV, FAIL2BAN_STATUS_ARGV, FRESHCLAM_UPDATE_ARGV, accountSliceShowArgv, clamscanHomeArgv, fail2banJailStatusArgv, fail2banUnbanArgv,
  fpmUnitShowArgv, getentPasswdArgv, isAntivirusJobCommand, isFail2banAddress, isFail2banJail, isScanTarget, isSecurityToolsCommand,
} from './security-tools-command.ts'

describe('reviewed security tools grammar', () => {
  it('admits exactly the observation commands and the single-address unban', () => {
    for (const argv of [[...FAIL2BAN_STATUS_ARGV], fail2banJailStatusArgv('sshd'), fail2banJailStatusArgv('postfix-sasl'), fail2banUnbanArgv('sshd', '192.0.2.7'), fail2banUnbanArgv('nginx_auth', '2001:db8::1'),
      [...CLAMSCAN_VERSION_ARGV], accountSliceShowArgv(1001), fpmUnitShowArgv('alice', '8.3'), getentPasswdArgv('alice')]) expect(isSecurityToolsCommand(argv)).toBe(true)
    expect(fail2banUnbanArgv('sshd', '192.0.2.7')).toEqual(['/usr/bin/fail2ban-client', 'set', 'sshd', 'unbanip', '192.0.2.7'])
    expect(accountSliceShowArgv(1001)).toEqual(['/usr/bin/systemctl', 'show', 'xpanel-1001.slice', '--property=LoadState,ActiveState'])
    expect(fpmUnitShowArgv('alice', '8.3')).toEqual(['/usr/bin/systemctl', 'show', 'xpanel-php-fpm-alice-8.3.service', '--property=LoadState,ActiveState,User,Group,Slice'])
    expect(getentPasswdArgv('alice')).toEqual(['/usr/bin/getent', '--', 'passwd', 'alice'])
  })
  it('refuses jail, address and unit injection', () => {
    for (const jail of ['', '-h', '--async', 'SSHD', 'ssh d', 'sshd;id', '../x', 'a'.repeat(65), 'sshd\n', 7]) expect(isFail2banJail(jail)).toBe(false)
    for (const address of ['', '192.0.2.0/24', '192.0.2.1 198.51.100.1', 'fe80::1%eth0', 'example.test', '-1', '999.1.1.1', '192.0.2.1\n', '::ffff:192.0.2.1;id']) expect(isFail2banAddress(address)).toBe(false)
    for (const argv of [
      ['/usr/bin/fail2ban-client', 'status', '-h'], ['/usr/bin/fail2ban-client', 'status', 'sshd', 'extra'], ['/usr/bin/fail2ban-client', 'set', 'sshd', 'banip', '192.0.2.7'],
      ['/usr/bin/fail2ban-client', 'set', 'sshd', 'unbanip', '--all'], ['/usr/bin/fail2ban-client', 'unban', '--all'], ['/usr/bin/fail2ban-client', 'unban', '192.0.2.7'],
      ['/usr/bin/fail2ban-client', 'set', 'sshd', 'unbanip', '192.0.2.7', '198.51.100.1'], ['/usr/bin/fail2ban-client', 'stop'], ['/usr/bin/fail2ban-client', '-c', '/tmp', 'status'],
      ['fail2ban-client', 'status'], ['/bin/sh', '-c', 'fail2ban-client status'], ['/usr/bin/clamscan', '--version', '--debug'], ['/usr/bin/clamscan', '/home/alice'],
      ['/usr/bin/systemctl', 'show', 'xpanel-0.slice', '--property=LoadState,ActiveState'], ['/usr/bin/systemctl', 'show', 'xpanel-1001.slice', '--property=ExecStart'],
      ['/usr/bin/systemctl', 'show', 'sshd.service', '--property=LoadState,ActiveState,User,Group,Slice'], ['/usr/bin/systemctl', 'stop', 'xpanel-1001.slice', '--property=LoadState,ActiveState'],
      ['/usr/bin/systemctl', 'show', 'xpanel-php-fpm-alice-8.3.service', '--property=Environment'], ['/usr/bin/getent', 'passwd', 'alice'], ['/usr/bin/getent', '--', 'shadow', 'alice'],
      ['/usr/bin/getent', '--', 'passwd', 'root;id'], [], ['/usr/bin/fail2ban-client', 7],
    ]) expect(isSecurityToolsCommand(argv)).toBe(false)
    expect(() => fail2banJailStatusArgv('-h')).toThrow()
    expect(() => fail2banUnbanArgv('sshd', '192.0.2.0/24')).toThrow()
    expect(() => accountSliceShowArgv(0)).toThrow()
    expect(() => fpmUnitShowArgv('alice', '8.3;id')).toThrow()
  })
  it('scans only a canonical account home with fixed bounded flags', () => {
    expect(clamscanHomeArgv('/home/alice')).toEqual(['/usr/bin/nice', '-n', '19', '/usr/bin/clamscan', '--recursive', '--infected', '--follow-dir-symlinks=0', '--follow-file-symlinks=0', '--max-filesize=100M', '--max-scansize=400M', '/home/alice'])
    for (const target of ['/home/alice', '/data/home2/bob']) expect(isAntivirusJobCommand(clamscanHomeArgv(target))).toBe(true)
    expect(isAntivirusJobCommand([...FRESHCLAM_UPDATE_ARGV])).toBe(true)
    for (const target of ['/', '/home', '/home/', '/home/alice/', '/home/../root', '/home/./alice', 'home/alice', '/home/-x/alice', '/home/Alice', '/home/alice/public_html', '/etc', '/home/a b', '/home/al\nice']) expect(isScanTarget(target)).toBe(false)
    for (const argv of [
      ['/usr/bin/clamscan', '--recursive', '--infected', '/home/alice'], [...clamscanHomeArgv('/home/alice').slice(0, -1), '/etc'], [...clamscanHomeArgv('/home/alice'), '/home/bob'],
      clamscanHomeArgv('/home/alice').map(value => value === '--follow-dir-symlinks=0' ? '--follow-dir-symlinks=2' : value), clamscanHomeArgv('/home/alice').map(value => value === '--infected' ? '--remove=yes' : value),
      ['/usr/bin/freshclam'], ['/usr/bin/freshclam', '--quiet', '--datadir=/tmp'], ['/usr/bin/freshclam', '--quiet', '--daemon'],
    ]) expect(isAntivirusJobCommand(argv)).toBe(false)
    expect(() => clamscanHomeArgv('/home/alice/../bob')).toThrow()
    expect(isSecurityToolsCommand(clamscanHomeArgv('/home/alice'))).toBe(false)
  })
})
