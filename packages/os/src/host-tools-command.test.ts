import { describe, expect, it } from 'vitest'
import { frpExtractArgv, hostsLookupArgv, hostTaskStartArgv, hostUnitLogArgv, hostUnitShowArgv, hostUnitVerbArgv, isHostToolsCommand, ramDiskArgv, ramDiskPath, swapAllocateArgv, SWAP_ARGV, timezoneSetArgv, TIMEZONE_READ_ARGV } from './host-tools-command.ts'

describe('host tools command grammar', { tags: ['unit'] }, () => {
  it('admits the commands the routes build', () => {
    const path = ramDiskPath('cache')
    for (const argv of [hostTaskStartArgv('xpanel-task-aaaaaaaaaaa1.service'), hostUnitVerbArgv('restart', 'xpanel-daemon-worker.service'), hostUnitVerbArgv('start', 'xpanel-frps.service'), hostUnitVerbArgv('restart', 'xpanel-php-fpm-alice-8.3.service'),
      hostUnitShowArgv('xpanel-daemon-worker.service'), hostUnitLogArgv('xpanel-frpc.service'), [...TIMEZONE_READ_ARGV], timezoneSetArgv('Europe/Paris'), swapAllocateArgv(1024), ...Object.values(SWAP_ARGV), ramDiskArgv.dir(path), ramDiskArgv.mount(path, 64), ramDiskArgv.unmount(path), hostsLookupArgv('build.example.test'), frpExtractArgv('frp_0.71.1_linux_amd64')]) {
      expect(isHostToolsCommand(argv), argv.join(' ')).toBe(true)
    }
  })
  it('refuses other units, verbs and paths', () => {
    for (const argv of [['/usr/bin/systemctl', 'start', '--no-block', 'nginx.service'], ['/usr/bin/systemctl', 'stop', 'xpanel-php-fpm-alice-8.3.service'], hostUnitVerbArgv('restart', 'sshd.service'), ['/usr/bin/journalctl', '--no-pager', '--output=short-iso', '--lines=200', '--unit=sshd.service'],
      ['/usr/bin/fallocate', '--length', '10MiB', '/etc/passwd'], ['/usr/bin/mount', '-t', 'tmpfs', '-o', 'size=10m,mode=0755,nosuid,nodev', 'tmpfs', '/etc'], ['/usr/bin/umount', '/home'], ['/usr/bin/rm', '--force', '--', '/etc/passwd'], ['/usr/bin/timedatectl', 'set-timezone', 'a b'], ['/usr/bin/tar', '--extract', '--file=/etc/shadow']]) {
      expect(isHostToolsCommand(argv), argv.join(' ')).toBe(false)
    }
  })
})
