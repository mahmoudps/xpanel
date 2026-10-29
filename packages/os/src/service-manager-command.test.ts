import { describe, expect, it } from 'vitest'
import { isServiceManagerCommand, serviceManagerCat, serviceManagerRestartTest, serviceManagerShow, SERVICE_MANAGER_FILES, SERVICE_MANAGER_LIST } from './service-manager-command.ts'

describe('service manager command boundary', () => {
  it('admits only exact observations and finite mutation argv', () => {
    for (const argv of [SERVICE_MANAGER_LIST, SERVICE_MANAGER_FILES, serviceManagerShow('ssh.service'), serviceManagerCat('memcached.service'), ['/usr/bin/systemctl', 'enable', '--', 'memcached.service'], ['/usr/bin/systemctl', 'disable', '--', 'chrony.service'], ['/usr/bin/systemctl', 'restart', '--', 'ssh.service'], ['/usr/bin/systemctl', 'reboot'], ['/usr/sbin/sshd', '-t'], ['/usr/sbin/php-fpm8.4', '-t']]) expect(isServiceManagerCommand(argv)).toBe(true)
    expect(serviceManagerRestartTest('php8.4-fpm.service')).toEqual(['/usr/sbin/php-fpm8.4', '-t'])
  })
  it.each([
    ['/bin/sh', '-c', 'systemctl restart ssh'], ['/usr/bin/systemctl', 'restart', '--', 'nginx.service'], ['/usr/bin/systemctl', 'restart', '--', 'postgresql.service'], ['/usr/bin/systemctl', 'enable', '--', 'xpanel-agent.service'], ['/usr/bin/systemctl', 'disable', '--', 'sshd.service'], ['/usr/bin/systemctl', 'enable', '--now', 'memcached.service'], ['/usr/bin/systemctl', 'cat', '--no-pager', '--', '../ssh.service'], ['/usr/bin/systemctl', 'reboot', '--force'], ['/usr/sbin/php-fpm9.1', '-t'], ['/usr/sbin/sshd', '-f', '/tmp/config'],
  ])('refuses unreviewed command %j', (...argv) => expect(isServiceManagerCommand(argv)).toBe(false))
})
