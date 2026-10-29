import { describe, expect, it } from 'vitest'
import {
  APT_CHECK_ARGV, APT_FIX_BROKEN_ARGV, APT_FIX_BROKEN_NO_REMOVE_ARGV, APT_FIX_PREVIEW_ARGV, DNF_CHECK_ARGV, DPKG_AUDIT_ARGV,
  DPKG_CONFIGURE_PENDING_ARGV, REPAIR_MUTATION_ENV, isRepairCommand, isRepairMutationCommand, isRepairReadCommand, RPMDB_VERIFY_ARGV, DNF_CACHE_CHECK_ARGV, DNF_CACHE_CLEAN_ARGV, DNF_CACHE_REFRESH_ARGV,
} from './repair-command.ts'

describe('reviewed repair command grammar', () => {
  it('admits exactly the reviewed read and repair vectors', () => {
    for (const argv of [DPKG_AUDIT_ARGV, APT_CHECK_ARGV, APT_FIX_PREVIEW_ARGV, DNF_CHECK_ARGV, RPMDB_VERIFY_ARGV, DNF_CACHE_CHECK_ARGV]) {
      expect(isRepairReadCommand(argv)).toBe(true); expect(isRepairMutationCommand(argv)).toBe(false); expect(isRepairCommand(argv)).toBe(true)
    }
    for (const argv of [DPKG_CONFIGURE_PENDING_ARGV, APT_FIX_BROKEN_ARGV, APT_FIX_BROKEN_NO_REMOVE_ARGV, DNF_CACHE_CLEAN_ARGV, DNF_CACHE_REFRESH_ARGV]) {
      expect(isRepairMutationCommand(argv)).toBe(true); expect(isRepairReadCommand(argv)).toBe(false); expect(isRepairCommand(argv)).toBe(true)
    }
    expect(APT_FIX_BROKEN_ARGV).toEqual(['/usr/bin/apt-get', '-f', 'install', '-y', '-q', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'])
    expect(APT_FIX_BROKEN_NO_REMOVE_ARGV.at(-1)).toBe('--no-remove')
    expect(REPAIR_MUTATION_ENV).toEqual({ DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l' })
    expect(Object.isFrozen(REPAIR_MUTATION_ENV)).toBe(true)
  })

  it.each([
    ['relative binary', ['dpkg', '--audit']],
    ['other absolute binary', ['/usr/local/bin/dpkg', '--audit']],
    ['sbin lookalike', ['/usr/sbin/apt-get', 'check', '-q']],
    ['extra package', ['/usr/bin/apt-get', '-f', 'install', '-y', '-q', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'nginx']],
    ['option injection', ['/usr/bin/apt-get', '-s', '-q', '-f', 'install', '-o', 'APT::Get::Simulate=false']],
    ['simulation dropped', ['/usr/bin/apt-get', '-q', '-f', 'install']],
    ['config override', ['/usr/bin/apt-get', '-f', 'install', '-y', '-q', '-o', 'Dpkg::Options::=--force-confnew', '-o', 'Dpkg::Options::=--force-confold']],
    ['reordered', ['/usr/bin/apt-get', '-q', 'check']],
    ['dpkg remove', ['/usr/bin/dpkg', '--remove', '-a']],
    ['dpkg configure without force options', ['/usr/bin/dpkg', '--configure', 'nginx']],
    ['dnf mutation', ['/usr/bin/dnf', '-y', 'distro-sync']],
    ['dnf extra', ['/usr/bin/dnf', '-q', 'check', '--duplicates']],
    ['rpm rebuild', ['/usr/bin/rpmdb', '--rebuilddb']],
    ['rpm alternate database', ['/usr/bin/rpmdb', '--verifydb', '--dbpath', '/tmp/db']],
    ['dnf all caches', ['/usr/bin/dnf', '--noplugins', '-q', 'clean', 'all']],
    ['dnf caller repository', [...DNF_CACHE_REFRESH_ARGV, '--repofrompath=caller,https://example.test/']],
    ['dnf plugins enabled', ['/usr/bin/dnf', '-q', '--refresh', 'makecache']],
    ['shell', ['/bin/sh', '-c', '/usr/bin/dpkg --audit']],
    ['trailing empty', ['/usr/bin/dpkg', '--audit', '']],
    ['separator suffix', ['/usr/bin/dpkg', '--audit;id']],
    ['empty', []],
  ])('refuses %s', (_name, argv) => {
    expect(isRepairCommand(argv)).toBe(false)
  })

  it('refuses non-string and non-array input', () => {
    expect(isRepairCommand(['/usr/bin/dpkg', 1] as unknown[])).toBe(false)
    expect(isRepairCommand('/usr/bin/dpkg --audit' as unknown as string[])).toBe(false)
    expect(isRepairCommand([new String('/usr/bin/dpkg'), '--audit'] as unknown[])).toBe(false)
  })
})
