import { describe, expect, it } from 'vitest'
import { isSoftwareCenterCommand, isSoftwareCenterPackageName, softwareCenterArgv, SOFTWARE_CENTER_DPKG_LIST_ARGV } from './software-center-command.ts'

describe('software center command grammar', () => {
  it('builds and admits only the exact reviewed argv forms', () => {
    const forms = [
      softwareCenterArgv('dpkg-query', ['memcached']),
      softwareCenterArgv('apt-cache-policy', ['memcached', 'git']),
      softwareCenterArgv('apt-simulate-install', ['memcached']),
      softwareCenterArgv('apt-simulate-remove', ['memcached']),
      softwareCenterArgv('apt-install', ['memcached']),
      softwareCenterArgv('apt-remove', ['memcached']),
      softwareCenterArgv('rpm-query', ['perl-DBI', 'java-21-openjdk-headless']),
      softwareCenterArgv('dnf-simulate-install', ['ImageMagick']),
      softwareCenterArgv('dnf-simulate-remove', ['memcached']),
      softwareCenterArgv('dnf-install', ['memcached']),
      softwareCenterArgv('dnf-remove', ['php83-php-pecl-apcu']),
      [...SOFTWARE_CENTER_DPKG_LIST_ARGV],
    ]
    for (const argv of forms) expect(isSoftwareCenterCommand(argv)).toBe(true)
    expect(softwareCenterArgv('apt-install', ['memcached'])).toEqual(['/usr/bin/apt-get', 'install', '-y', '-q', '--no-install-recommends', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', '--', 'memcached'])
    expect(softwareCenterArgv('dnf-simulate-install', ['git'])).toEqual(['/usr/bin/dnf', '--assumeno', 'install', '--', 'git'])
    expect(softwareCenterArgv('rpm-query', ['git'])).toEqual(['/usr/bin/rpm', '-q', '--qf', '%{NAME}\t%{VERSION}-%{RELEASE}\n', '--', 'git'])
  })

  it.each([
    ['/usr/bin/apt-get', 'purge', '-y', '-q', '--', 'memcached'],
    ['/usr/bin/apt-get', 'autoremove', '-y'],
    ['/usr/bin/apt-get', 'remove', '-y', '-q', '--purge', '--', 'memcached'],
    ['/usr/bin/apt-get', 'remove', '-y', '-q', 'memcached'],
    ['/usr/bin/apt-get', 'install', '-y', '-q', '--', 'memcached'],
    ['/usr/bin/apt-get', 'remove', '-y', '-q', '--'],
    ['/usr/bin/apt-get', 'remove', '-y', '-q', '--', '-o'],
    ['/usr/bin/apt-get', 'remove', '-y', '-q', '--', 'https://example.test/x.deb'],
    ['/usr/bin/apt-get', 'remove', '-y', '-q', '--', './local.deb'],
    ['/usr/bin/apt-get', 'remove', '-y', '-q', '--', 'Memcached'],
    ['/usr/bin/apt-get', 'remove', '-y', '-q', '--', 'mem*'],
    ['/usr/bin/apt-get', 'remove', '-y', '-q', '--', 'memcached', 'memcached'],
    ['apt-get', 'remove', '-y', '-q', '--', 'memcached'],
    ['/usr/bin/dnf', '-y', '-q', 'install', '--', 'memcached', '--setopt=x'],
    ['/usr/bin/dnf', '-y', 'install', '--', 'memcached'],
    ['/usr/bin/dnf', '-q', '--assumeno', 'install', '--', 'memcached'],
    ['/usr/bin/dnf', '-y', '-q', 'install', '--', 'php_8*'],
    ['/usr/bin/rpm', '-e', '--', 'memcached'],
    ['/usr/bin/rpm', '-q', '--qf', '%{NAME}\n', '--', 'memcached'],
    ['/usr/bin/dpkg-query', '-W', '--', 'memcached'],
    ['/bin/sh', '-c', 'apt-get install memcached'],
  ])('rejects %j', (...argv) => {
    expect(isSoftwareCenterCommand(argv)).toBe(false)
  })

  it('bounds name syntax and count per family', () => {
    expect(isSoftwareCenterPackageName('debian', 'php8.3-redis')).toBe(true)
    expect(isSoftwareCenterPackageName('debian', 'libdbi-perl')).toBe(true)
    expect(isSoftwareCenterPackageName('debian', 'perl-DBI')).toBe(false)
    expect(isSoftwareCenterPackageName('rhel', 'perl-DBI')).toBe(true)
    expect(isSoftwareCenterPackageName('rhel', '-perl')).toBe(false)
    expect(isSoftwareCenterPackageName('rhel', 'a')).toBe(false)
    expect(isSoftwareCenterPackageName('rhel', 'x'.repeat(65))).toBe(false)
    expect(isSoftwareCenterPackageName('rhel', 'pkg\n')).toBe(false)
    const names = Array.from({ length: 64 }, (_, index) => 'pkg' + index)
    expect(isSoftwareCenterCommand(softwareCenterArgv('apt-remove', names))).toBe(true)
    expect(() => softwareCenterArgv('apt-remove', [...names, 'pkg64'])).toThrow()
    expect(() => softwareCenterArgv('apt-remove', [])).toThrow()
    expect(() => softwareCenterArgv('dnf-remove', ['Bad Name'])).toThrow()
    expect(isSoftwareCenterCommand(['/usr/bin/apt-get', 'remove', '-y', '-q', '--', 'perl-DBI'])).toBe(false)
    expect(isSoftwareCenterCommand(['/usr/bin/dnf', '-y', '-q', 'remove', '--', 'perl-DBI'])).toBe(true)
    expect(isSoftwareCenterCommand(['/usr/bin/apt-get', 'remove', '-y', '-q', '--', 1] as unknown[])).toBe(false)
  })
})
