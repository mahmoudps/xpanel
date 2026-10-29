import { describe, expect, it } from 'vitest'
import { SUPPORTED_PHP_VERSIONS, profileFor } from '@xpanel/os'
import { isSoftwareCenterPackageName } from '../../../packages/os/src/software-center-command.ts'
import { translator } from '../../web/src/i18n.ts'
import { isProtectedPackage, phpModuleComponents, protectedPackageNames, SOFTWARE_CENTER_CATALOG, softwareCenterComponents } from './software-center-catalog.ts'

const everything = softwareCenterComponents(SUPPORTED_PHP_VERSIONS)
describe('shipped software center catalog', () => {
  it('has a modest set of uniquely identified components with resolvable relations', () => {
    expect(SOFTWARE_CENTER_CATALOG.length).toBeGreaterThanOrEqual(15)
    expect(SOFTWARE_CENTER_CATALOG.length).toBeLessThanOrEqual(30)
    const ids = everything.map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const item of everything) {
      expect(item.id).toMatch(/^[a-z][a-z0-9-]{1,48}$/)
      expect(['catalog', 'module', 'runtime']).toContain(item.page)
      for (const other of [...(item.requires ?? []), ...(item.conflicts ?? [])]) { expect(ids).toContain(other); expect(other).not.toBe(item.id) }
      expect(Number.isSafeInteger(item.estimate.memoryMb) && item.estimate.memoryMb >= 0 && Number.isSafeInteger(item.estimate.diskMb) && item.estimate.diskMb >= 0).toBe(true)
      // The description is a catalog message; its Arabic translation exists and uses ASCII digits.
      const arabic = translator('ar')(item.description)
      expect(item.description.length).toBeGreaterThan(8)
      expect(arabic).toMatch(/[؀-ۿ]/)
      expect(`${item.name}${item.description}${arabic}`).not.toMatch(/[٠-٩۰-۹]/)
    }
    for (const page of ['catalog', 'module', 'runtime']) expect(SOFTWARE_CENTER_CATALOG.some(item => item.page === page)).toBe(true)
  })

  it('uses strict distro package names and never shares a package between components', () => {
    for (const family of ['debian', 'rhel'] as const) {
      const seen = new Map<string, string>()
      for (const item of everything) {
        const names = family === 'debian' ? item.packages.debian : item.packages.rhel
        if (names === null) continue
        expect(names.length).toBeGreaterThan(0)
        for (const name of names) {
          expect(isSoftwareCenterPackageName(family, name)).toBe(true)
          expect(seen.get(name)).toBeUndefined()
          seen.set(name, item.id)
        }
      }
    }
  })

  it('contains no package of the panel stack or base system', () => {
    for (const item of everything) {
      for (const name of item.packages.debian) expect(isProtectedPackage('debian', name), name).toBe(false)
      for (const name of item.packages.rhel ?? []) expect(isProtectedPackage('rhel', name), name).toBe(false)
    }
  })

  it('protects every package the installer profiles name, including PHP-FPM for each supported version', () => {
    const releases = { debian: ['ID=ubuntu\nVERSION_ID=22.04\n', 'ID=ubuntu\nVERSION_ID=24.04\n'], rhel: ['ID=rocky\nVERSION_ID=9.4\n', 'ID=centos\nVERSION_ID=10\n'] } as const
    for (const family of ['debian', 'rhel'] as const) for (const release of releases[family]) {
      const profile = profileFor(release)
      for (const name of Object.values(profile.packages).flat()) expect(isProtectedPackage(family, name), name).toBe(true)
      for (const version of SUPPORTED_PHP_VERSIONS) for (const name of profile.phpPackages(version)) expect(isProtectedPackage(family, name), name).toBe(true)
    }
    for (const name of ['nginx', 'apache2', 'php8.3-fpm', 'php7.4-fpm', 'mariadb-server', 'postfix', 'dovecot-core', 'pdns-server', 'nftables', 'redis-server', 'openssh-server', 'libc6:amd64', 'apt', 'systemd']) expect(isProtectedPackage('debian', name), name).toBe(true)
    for (const name of ['nginx', 'httpd', 'php83-php-fpm', 'php84-php-fpm', 'mariadb-server', 'postfix', 'dovecot', 'pdns', 'nftables', 'redis', 'valkey', 'dnf', 'glibc']) expect(isProtectedPackage('rhel', name), name).toBe(true)
    expect(isProtectedPackage('debian', 'memcached')).toBe(false)
    expect(protectedPackageNames('debian')).toBe(protectedPackageNames('debian'))
  })

  it('generates PHP module rows only for supported observed versions with per-family naming', () => {
    const rows = phpModuleComponents(['8.3', '8.3', '5.6', '7.4'])
    expect([...new Set(rows.map(row => row.phpVersion))]).toEqual(['7.4', '8.3'])
    const redis = rows.find(row => row.id === 'php83-redis')!
    expect(redis.packages).toEqual({ debian: ['php8.3-redis'], rhel: null })
    expect(rows.find(row => row.id === 'php74-apcu')!.packages).toEqual({ debian: ['php7.4-apcu'], rhel: ['php74-php-pecl-apcu'] })
    expect(rows.find(row => row.id === 'php83-ldap')!.packages.rhel).toEqual(['php83-php-ldap'])
    expect(rows.every(row => row.page === 'module' && row.category === 'php')).toBe(true)
    expect(phpModuleComponents([])).toEqual([])
  })
})
