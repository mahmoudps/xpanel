import { describe, expect, it } from 'vitest'
import { profileFor } from './detect.ts'
import { ALMA_9, UBUNTU_2404 } from './fixtures.ts'
import { isAccountFpmMaster, isServiceManagerCommand, serviceConfigTest, serviceManagerCat, serviceManagerRestartTest, serviceManagerShow, SERVICE_MANAGER_FILES, SERVICE_MANAGER_LIST } from './service-manager-command.ts'

describe('service manager command boundary', () => {
  it('admits only exact observations and finite mutation argv', () => {
    for (const argv of [SERVICE_MANAGER_LIST, SERVICE_MANAGER_FILES, serviceManagerShow('ssh.service'), serviceManagerCat('memcached.service'), ['/usr/bin/systemctl', 'enable', '--', 'memcached.service'], ['/usr/bin/systemctl', 'disable', '--', 'chrony.service'], ['/usr/bin/systemctl', 'restart', '--', 'ssh.service'], ['/usr/bin/systemctl', 'reboot'], ['/usr/sbin/sshd', '-t'], ['/usr/sbin/php-fpm8.4', '-t']]) expect(isServiceManagerCommand(argv)).toBe(true)
    expect(serviceManagerRestartTest('php8.4-fpm.service')).toEqual(['/usr/sbin/php-fpm8.4', '-t'])
  })
  it.each([
    ['/bin/sh', '-c', 'systemctl restart ssh'], ['/usr/bin/systemctl', 'restart', '--', 'nginx.service'], ['/usr/bin/systemctl', 'restart', '--', 'postgresql.service'], ['/usr/bin/systemctl', 'enable', '--', 'xpanel-agent.service'], ['/usr/bin/systemctl', 'disable', '--', 'sshd.service'], ['/usr/bin/systemctl', 'enable', '--now', 'memcached.service'], ['/usr/bin/systemctl', 'cat', '--no-pager', '--', '../ssh.service'], ['/usr/bin/systemctl', 'reboot', '--force'], ['/usr/sbin/php-fpm9.1', '-t'], ['/usr/sbin/sshd', '-f', '/tmp/config'],
  ])('refuses unreviewed command %j', (...argv) => expect(isServiceManagerCommand(argv)).toBe(false))
  it('builds each managed unit its own configuration test from the Debian and EL profiles', () => {
    const debian = profileFor(UBUNTU_2404), el = profileFor(ALMA_9)
    expect(serviceConfigTest('nginx.service', debian)).toEqual(['/usr/sbin/nginx', '-t', '-q', '-c', '/etc/nginx/nginx.conf'])
    expect(serviceConfigTest('apache2.service', debian)).toEqual(['/usr/sbin/apachectl', 'configtest'])
    expect(serviceConfigTest('httpd.service', el)).toEqual(['/usr/sbin/apachectl', 'configtest'])
    expect(serviceConfigTest('ssh.service', debian)).toEqual(['/usr/sbin/sshd', '-t', '-f', '/etc/ssh/sshd_config'])
    expect(serviceConfigTest('sshd.service', el)).toEqual(['/usr/sbin/sshd', '-t', '-f', '/etc/ssh/sshd_config'])
    expect(serviceConfigTest('postfix.service', el)).toEqual(['postfix', '-c', '/etc/postfix', 'check'])
    expect(serviceConfigTest('dovecot.service', debian)).toEqual(['doveconf', '-n', '-c', '/etc/dovecot/dovecot.conf'])
    expect(serviceConfigTest('mariadb.service', debian)).toEqual(['/usr/sbin/mariadbd', '--help', '--verbose'])
    expect(serviceConfigTest('mariadb.service', el)).toEqual(['/usr/libexec/mariadbd', '--help', '--verbose'])
    expect(serviceConfigTest('pdns.service', el)).toEqual(['/usr/sbin/pdns_server', '--config=check'])
    expect(serviceConfigTest('opendkim.service', debian)).toEqual(['/usr/sbin/opendkim', '-n', '-x', '/etc/opendkim.conf'])
    expect(serviceConfigTest('php8.3-fpm.service', debian)).toEqual(['/usr/sbin/php-fpm8.3', '-t'])
    expect(serviceConfigTest('php83-php-fpm.service', el)).toEqual(['/opt/remi/php83/root/usr/sbin/php-fpm', '-t'])
    expect(serviceConfigTest('xpanel-php-fpm-alice-8.3.service', debian)).toEqual(['runuser', '-u', 'alice', '--', '/usr/sbin/php-fpm8.3', '--test', '--fpm-config', '/etc/xpanel/php-fpm/8.3/alice.conf'])
    expect(serviceConfigTest('xpanel-php-fpm-alice-8.3.service', el)).toEqual(['runuser', '-u', 'alice', '--', '/opt/remi/php83/root/usr/sbin/php-fpm', '--test', '--fpm-config', '/etc/xpanel/php-fpm/8.3/alice.conf'])
    for (const unit of ['postgresql.service', 'redis-server.service', 'valkey.service', 'pure-ftpd.service', 'cron.service', 'xpanel-agent.service', 'xpanel-php-fpm-alice-9.9.service']) expect(serviceConfigTest(unit, debian)).toBeNull()
    expect(['xpanel-php-fpm-alice-8.3.service', 'xpanel-php-fpm-bob2-7.4.service'].every(isAccountFpmMaster)).toBe(true)
    expect(['xpanel-php-fpm-Alice-8.3.service', 'xpanel-php-fpm-alice-8.3.timer', 'xpanel-php-fpm-alice_x-8.3.service', 'php8.3-fpm.service'].some(isAccountFpmMaster)).toBe(false)
  })
})
