import { describe, expect, it } from 'vitest'
import {
  APT_SHOW_HOLDS_ARGV, APT_SIMULATE_UPGRADE_ARGV, APT_UPDATE_ARGV, APT_UPGRADE_PREFIX, DNF_CHECK_UPDATE_ARGV, DNF_MAKECACHE_ARGV, DNF_SECURITY_ARGV, DNF_UPGRADE_PREFIX,
  isKernelPackageName, isPackageManagerCommand, isPackageName, isPackageSelection, packageKernelExcludedUpgradeArgv, packageSelectionSimulationArgv, packageUpgradeArgv,
} from './package-manager-command.ts'

describe('reviewed package-manager argv grammar', () => {
  it('admits exactly the reviewed read and refresh commands', () => {
    for (const argv of [APT_SIMULATE_UPGRADE_ARGV, APT_SHOW_HOLDS_ARGV, APT_UPDATE_ARGV, DNF_CHECK_UPDATE_ARGV, DNF_SECURITY_ARGV, DNF_MAKECACHE_ARGV]) expect(isPackageManagerCommand([...argv])).toBe(true)
    expect(APT_SIMULATE_UPGRADE_ARGV).toEqual(['/usr/bin/apt-get', '-s', '-q', '-o', 'Debug::NoLocking=1', 'dist-upgrade'])
    expect(DNF_CHECK_UPDATE_ARGV).toEqual(['/usr/bin/dnf', '-q', '--cacheonly', 'check-update'])
  })
  it('builds upgrade argv with names only after the end-of-options marker', () => {
    expect(packageUpgradeArgv('debian', ['openssl', 'libc6:i386', 'g++'])).toEqual([...APT_UPGRADE_PREFIX, 'openssl', 'libc6:i386', 'g++'])
    expect(packageUpgradeArgv('rhel', ['kernel-core.x86_64', 'python3.11.noarch'])).toEqual([...DNF_UPGRADE_PREFIX, 'kernel-core.x86_64', 'python3.11.noarch'])
    expect(isPackageManagerCommand(packageUpgradeArgv('debian', ['openssl']))).toBe(true)
    expect(isPackageManagerCommand(packageUpgradeArgv('rhel', ['openssl.x86_64']))).toBe(true)
  })
  const apt = (...names: string[]) => [...APT_UPGRADE_PREFIX, ...names]
  const dnf = (...names: string[]) => [...DNF_UPGRADE_PREFIX, ...names]
  it.each([
    ['option injection after --', apt('-o', 'APT::Get::AllowUnauthenticated=1')],
    ['option disguised as package', apt('--allow-downgrades')],
    ['dpkg removal suffix', apt('openssl-')],
    ['version pin', apt('openssl=3.0.0')],
    ['release pin', apt('openssl/noble')],
    ['uppercase debian name', apt('OpenSSL')],
    ['duplicate names', apt('openssl', 'openssl')],
    ['empty selection', apt()],
    ['missing end-of-options marker', [...APT_UPGRADE_PREFIX.slice(0, -1), 'openssl']],
    ['option inserted before --', [...APT_UPGRADE_PREFIX.slice(0, -1), '--allow-remove-essential', '--', 'openssl']],
    ['removed --no-remove', [...APT_UPGRADE_PREFIX.filter(value => value !== '--no-remove'), 'openssl']],
    ['relative binary', ['apt-get', ...APT_UPGRADE_PREFIX.slice(1), 'openssl']],
    ['other binary', ['/usr/local/bin/apt-get', ...APT_UPGRADE_PREFIX.slice(1), 'openssl']],
    ['debian name on rpm', dnf('openssl')],
    ['rpm glob', dnf('kernel*.x86_64')],
    ['rpm group', dnf('@core.x86_64')],
    ['rpm path', dnf('/tmp/x.rpm')],
    ['rpm option', dnf('--nogpgcheck')],
    ['rpm unknown arch', dnf('openssl.sparc')],
    ['extra read flag', [...APT_SIMULATE_UPGRADE_ARGV, '-y']],
    ['read without simulation', APT_SIMULATE_UPGRADE_ARGV.filter(value => value !== '-s')],
    ['dnf without cacheonly', DNF_CHECK_UPDATE_ARGV.filter(value => value !== '--cacheonly')],
    ['shell wrapper', ['/bin/sh', '-c', APT_UPDATE_ARGV.join(' ')]],
    ['non-string', [...APT_UPGRADE_PREFIX, 1]],
  ])('refuses %s', (_label, argv) => expect(isPackageManagerCommand(argv as unknown[])).toBe(false))
  it('bounds a selection to 500 unique names', () => {
    const names = Array.from({ length: 500 }, (_, index) => 'pkg' + index)
    expect(isPackageSelection('debian', names)).toBe(true)
    expect(isPackageManagerCommand(apt(...names))).toBe(true)
    expect(isPackageSelection('debian', [...names, 'pkg500'])).toBe(false)
    expect(isPackageManagerCommand(apt(...names, 'pkg500'))).toBe(false)
    expect(() => packageUpgradeArgv('debian', [...names, 'pkg500'])).toThrow('invalid_package_selection')
    expect(isPackageName('debian', 'a'.repeat(129))).toBe(false)
  })
})

describe('per-invocation kernel exclusion grammar', () => {
  it('classifies observed kernel families without accepting globs or lookalikes', () => {
    for (const name of ['linux-image-generic', 'linux-headers-6.8.0:amd64', 'linux-azure']) expect(isKernelPackageName('debian', name)).toBe(true)
    for (const name of ['linux-libc-dev', 'linux-imagex', 'openssl', 'linux-image-*']) expect(isKernelPackageName('debian', name)).toBe(false)
    for (const name of ['kernel.x86_64', 'kernel-core.x86_64', 'kernel-devel.x86_64']) expect(isKernelPackageName('rhel', name)).toBe(true)
    expect(isKernelPackageName('rhel', 'kernelish.x86_64')).toBe(false)
  })
  it('admits only canonical kernel preservation specs under the existing apt no-remove guard', () => {
    const excluded = ['linux-image-generic=6.8.0-50.51', 'linux-image-6.8.0-51-generic-']
    const upgrade = packageKernelExcludedUpgradeArgv('debian', ['openssl'], excluded)
    expect(upgrade).toEqual([...APT_UPGRADE_PREFIX, 'openssl', ...excluded])
    expect(isPackageManagerCommand(upgrade)).toBe(true)
    expect(isPackageManagerCommand(packageSelectionSimulationArgv('debian', ['openssl'], excluded))).toBe(true)
    expect(isPackageManagerCommand(upgrade.filter(arg => arg !== '--no-remove'))).toBe(false)
    expect(() => packageKernelExcludedUpgradeArgv('debian', ['openssl'], ['openssl-'])).toThrow()
    expect(() => packageKernelExcludedUpgradeArgv('debian', ['linux-image-generic'], excluded)).toThrow()
  })
  it('uses cache-only DNF and exact observed exclusions without persistent settings or glob options', () => {
    const excluded = ['kernel-core.x86_64', 'kernel.x86_64'], effect = packageKernelExcludedUpgradeArgv('rhel', ['openssl.x86_64'], excluded)
    expect(effect).toEqual(['/usr/bin/dnf', '-y', '-q', '--cacheonly', '--exclude=kernel-core.x86_64,kernel.x86_64', 'upgrade', '--', 'openssl.x86_64'])
    expect(isPackageManagerCommand(effect)).toBe(true)
    expect(isPackageManagerCommand(packageSelectionSimulationArgv('rhel', ['openssl.x86_64'], excluded))).toBe(true)
    for (const arg of ['--exclude=kernel*', '--exclude=openssl.x86_64', '--exclude=kernel.x86_64;true']) expect(isPackageManagerCommand(effect.map(value => value.startsWith('--exclude=') ? arg : value))).toBe(false)
    expect(() => packageKernelExcludedUpgradeArgv('rhel', ['openssl.x86_64'], Array.from({ length: 41 }, (_, n) => 'kernel-' + n + '.x86_64'))).toThrow()
  })
})

