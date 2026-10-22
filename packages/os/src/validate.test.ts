import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import { assertAbsolutePath, assertPackageName, assertSafeArgv, assertTrustedPackageUrl, assertUnitName, isSafeArg } from './validate.ts'
import { assertPhpVersion, assertPhpVersionList, isPhpVersion, phpCompact } from './php.ts'

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return e instanceof XpanelError ? e.code : 'NOT_XPANEL'
  }
  return undefined
}

describe('PHP version validator', () => {
  it('accepts exactly the supported list', () => {
    for (const v of ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4']) expect(isPhpVersion(v)).toBe(true)
    expect(phpCompact('8.3')).toBe('83')
    expect(phpCompact('7.4')).toBe('74')
  })

  it("rejects '8.3; rm -rf' and other injection shapes", () => {
    for (const v of ['8.3; rm -rf', '8.3; rm -rf /', '8.3 && id', '$(id)', '`id`', '8.3\n', '8.3\0', '8.3/../../etc', ' 8.3', '8.3 ']) {
      expect(isPhpVersion(v)).toBe(false)
      expect(code(() => assertPhpVersion(v))).toBe('VALIDATION')
      expect(code(() => phpCompact(v))).toBe('VALIDATION')
    }
  })

  it('rejects unsupported or malformed versions', () => {
    for (const v of ['5.6', '7.3', '8.5', '9.0', '8', '83', '8.3.1', '', 'latest', 8.3, null, undefined, ['8.3'], { toString: () => '8.3' }]) {
      expect(code(() => assertPhpVersion(v))).toBe('VALIDATION')
    }
  })

  it('validates version lists strictly', () => {
    expect(assertPhpVersionList([])).toEqual([])
    expect(assertPhpVersionList(['8.3', '7.4'])).toEqual(['8.3', '7.4'])
    expect(code(() => assertPhpVersionList(['8.3', '8.3']))).toBe('VALIDATION')
    expect(code(() => assertPhpVersionList('8.3'))).toBe('VALIDATION')
    expect(code(() => assertPhpVersionList(['8.3', '8.3; rm -rf']))).toBe('VALIDATION')
    // eslint-disable-next-line no-sparse-arrays
    expect(code(() => assertPhpVersionList([, '8.3']))).toBe('VALIDATION')
    expect(code(() => assertPhpVersionList(['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.4']))).toBe('VALIDATION')
  })
})

describe('argv validator', () => {
  it('accepts the shapes the planner emits', () => {
    expect(assertSafeArgv(['/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', '/usr/bin/apt-get', '-o', 'Dpkg::Options::=--force-confold'])).toHaveLength(5)
    expect(assertSafeArgv(['/usr/bin/dnf', 'install', '-y', 'https://rpms.remirepo.net/enterprise/remi-release-9.rpm'])).toHaveLength(4)
  })

  it('rejects shell metacharacters, whitespace and control characters', () => {
    for (const bad of ['a;b', 'a|b', 'a&b', '$(id)', '`id`', 'a>b', 'a<b', 'a b', 'a\tb', 'a\nb', 'a\0b', "a'b", 'a"b', 'a*', 'a?', '[a]', '{a}', '(a)', '!a', '~a', 'a\\b', '#a', '']) {
      expect(isSafeArg(bad)).toBe(false)
      expect(code(() => assertSafeArgv(['/usr/bin/true', bad]))).toBe('VALIDATION')
    }
  })

  it('requires an absolute binary and string elements', () => {
    expect(code(() => assertSafeArgv([]))).toBe('VALIDATION')
    expect(code(() => assertSafeArgv(['apt-get', 'update']))).toBe('VALIDATION')
    expect(code(() => assertSafeArgv(['/usr/../bin/sh']))).toBe('VALIDATION')
    expect(code(() => assertSafeArgv(['/usr/bin/true', 42]))).toBe('VALIDATION')
    expect(code(() => assertSafeArgv('/usr/bin/true' as never))).toBe('VALIDATION')
    expect(code(() => assertSafeArgv(['/usr/bin/true', 'x'.repeat(2000)]))).toBe('VALIDATION')
  })
})

describe('name validators', () => {
  it('validates package names per family and blocks option injection', () => {
    for (const ok of ['nginx', 'libapache2-mpm-itk', 'php8.3-fpm', 'g++', 'pdns-backend-pgsql']) expect(assertPackageName('debian', ok)).toBe(ok)
    for (const ok of ['httpd', 'mod_ssl', 'php83-php-pecl-zip', 'mod_security_crs']) expect(assertPackageName('rhel', ok)).toBe(ok)
    for (const bad of ['-y', '--allow-unauthenticated', 'nginx;id', '../nginx', 'nginx nginx', 'NGINX', 'mod_ssl', 'a', '', 'nginx\n']) {
      expect(code(() => assertPackageName('debian', bad))).toBe('VALIDATION')
    }
    for (const bad of ['-y', '--nogpgcheck', 'httpd;id', '../httpd', 'httpd httpd', '', 42]) {
      expect(code(() => assertPackageName('rhel', bad))).toBe('VALIDATION')
    }
  })

  it('validates unit names', () => {
    for (const ok of ['nginx', 'php8.3-fpm', 'php83-php-fpm', 'ssh.socket', 'xpanel-1001.slice', 'getty@tty1.service']) expect(assertUnitName(ok)).toBe(ok)
    for (const bad of ['', '-nginx', 'nginx;id', 'nginx service', '../nginx', 'a/b', 'x'.repeat(300), null]) {
      expect(code(() => assertUnitName(bad))).toBe('VALIDATION')
    }
  })

  it('validates absolute paths', () => {
    for (const ok of ['/etc/nginx', '/etc/nginx/', '/run/xpanel/php-fpm', '/var/lib/pgsql/data/PG_VERSION']) expect(assertAbsolutePath(ok)).toBe(ok)
    for (const bad of ['/', 'etc/nginx', '/etc/../shadow', '/etc/./x', '//etc', '/etc//x', '/etc/x y', '/etc/x;y', '', null]) {
      expect(code(() => assertAbsolutePath(bad))).toBe('VALIDATION')
    }
  })

  it('allows bootstrap RPMs only from EPEL and Remi over https', () => {
    for (const ok of [
      'https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm',
      'https://rpms.remirepo.net/enterprise/remi-release-10.rpm',
    ]) expect(assertTrustedPackageUrl(ok)).toBe(ok)
    for (const bad of [
      'http://rpms.remirepo.net/enterprise/remi-release-9.rpm',
      'https://evil.example/remi-release-9.rpm',
      'https://rpms.remirepo.net.evil.example/remi-release-9.rpm',
      'https://user@rpms.remirepo.net/enterprise/remi-release-9.rpm',
      'https://rpms.remirepo.net:8443/enterprise/remi-release-9.rpm',
      'https://rpms.remirepo.net/enterprise/remi-release-9.rpm?x=1',
      'https://rpms.remirepo.net/enterprise/remi-release-9.rpm#x',
      'https://rpms.remirepo.net/enterprise/../remi-release-9.rpm',
      'https://rpms.remirepo.net/enterprise/remi-release-9.sh',
      'https://RPMS.remirepo.net/enterprise/remi-release-9.rpm',
      'not a url',
      42,
    ]) expect(code(() => assertTrustedPackageUrl(bad))).toBe('VALIDATION')
  })
})
