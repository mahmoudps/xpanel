import { describe, expect, it } from 'vitest'
import { applyObservedUserQuota, enableExistingUserQuota, fstabWithUserQuota, initializeUserQuota, lacksQuotaFormat, observeUserQuota, parseUserQuotaState, resolveHomeQuotaFilesystem, validateQuotaFilesystem } from './quota.ts'
import type { QuotaCommandRunner } from './quota.ts'
import { installQuotaSetup } from '../quota-setup.ts'

const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' })
const fixture = (initial: 'on' | 'off' = 'on') => {
  const commands: string[][] = []
  let state = initial
  const run: QuotaCommandRunner = async argv => {
    commands.push(argv)
    if (argv[0] === '/usr/bin/findmnt') return ok(({ TARGET: '/home', SOURCE: '/dev/loop7', FSTYPE: 'ext4' } as Record<string, string>)[argv[4]!]!)
    if (argv.includes('--print-state')) return { ok: state === 'off', code: state === 'on' ? 1 : 0, stdout: `user quota on /home (/dev/loop7) is ${state}\n`, stderr: '' }
    if (argv[0] === '/usr/sbin/quotaon') state = 'on'
    return ok()
  }
  return { run, commands }
}
const action = { kind: 'set-quota' as const, user: 'alice', filesystem: '/home', blockSoftKb: 1024, blockHardKb: 2048 }
const MODULES = 'kernel/fs/quota/quota_v2.ko.zst: kernel/fs/quota/quota_tree.ko.zst\nkernel/fs/quota/quota_tree.ko.zst:\n'

describe('observed user quota enforcement', () => {
  it.each(['/home/../etc', 'home', '/home/', '/home;id', '/home\n'])('rejects unsafe filesystem %j before commands', value => {
    expect(() => validateQuotaFilesystem(value)).toThrow()
  })
  it('never treats empty, fake, duplicate or wrong-mount output as enabled', () => {
    for (const output of ['', '[jailshell] quotaon', 'user quota on /other (/dev/loop7) is on', 'user quota on /home (/dev/other) is on', 'user quota on /home (/dev/loop7) is on\nuser quota on /home (/dev/loop7) is on']) {
      expect(parseUserQuotaState(output, '/home', '/dev/loop7')).toBe('unavailable')
    }
  })
  it('observes the exact mount and applies limits only while enforcement remains enabled', async () => {
    const host = fixture()
    await applyObservedUserQuota(host.run, action)
    expect(host.commands.filter(argv => argv[0] === '/usr/sbin/setquota')).toEqual([
      ['/usr/sbin/setquota', '-u', 'alice', '1024', '2048', '0', '0', '/home'],
    ])
    expect(host.commands.filter(argv => argv.includes('--print-state'))).toHaveLength(2)
  })
  it.each([0, 2, 124])('rejects enabled text with incoherent exit status %s', async code => {
    const host = fixture()
    const result = await observeUserQuota(async argv => argv.includes('--print-state')
      ? { ok: code === 0, code, stdout: 'user quota on /home (/dev/loop7) is on\n', stderr: '' } : host.run(argv), '/home')
    expect(result.status).toBe('unavailable')
  })
  it('requires XFS enforcement and does not mistake accounting-only or nonverbose on for enforcement', async () => {
    const host = fixture()
    for (const [state, expected] of [['on (accounting)', 'disabled'], ['on', 'unavailable'], ['on (enforced)', 'enabled']] as const) {
      const result = await observeUserQuota(async argv => {
        if (argv[4] === 'FSTYPE') return ok('xfs')
        if (argv.includes('--print-state')) return { ok: false, code: 1, stdout: `user quota on /home (/dev/loop7) is ${state}\n`, stderr: '' }
        return host.run(argv)
      }, '/home')
      expect(result.status).toBe(expected)
    }
  })
  it('rejects disabled enforcement before any limit mutation', async () => {
    const host = fixture('off')
    await expect(applyObservedUserQuota(host.run, action)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(host.commands.some(argv => argv[0] === '/usr/sbin/setquota')).toBe(false)
  })
  it('treats failed post-mutation observation as unknown rather than success', async () => {
    const host = fixture()
    let changed = false
    await expect(applyObservedUserQuota(async argv => {
      if (argv[0] === '/usr/sbin/setquota') changed = true
      if (changed && argv[0] === '/usr/bin/findmnt') return { ...ok(), ok: false, code: 124 }
      return host.run(argv)
    }, action)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
  })
  it('does not modify an ancestor mount or unsupported filesystem', async () => {
    const host = fixture()
    const result = await observeUserQuota(async argv => argv[4] === 'TARGET' ? ok('/') : host.run(argv), '/home')
    expect(result).toMatchObject({ status: 'unavailable', reason: 'exact_mount_required' })
    const unsupported = await observeUserQuota(async argv => argv[4] === 'FSTYPE' ? ok('overlay') : host.run(argv), '/home')
    expect(unsupported).toMatchObject({ status: 'unavailable', reason: 'filesystem_not_supported' })
  })
  it('enables existing accounting once and performs no quota rebuild or remount', async () => {
    const host = fixture('off')
    expect((await enableExistingUserQuota(host.run, '/home')).status).toBe('enabled')
    await enableExistingUserQuota(host.run, '/home')
    expect(host.commands.filter(argv => argv[0] === '/usr/sbin/quotaon' && !argv.includes('--print-state'))).toEqual([
      ['/usr/sbin/quotaon', '--user', '/home'],
    ])
    expect(host.commands.some(argv => argv.some(arg => /quotacheck|remount/.test(arg)))).toBe(false)
  })
  it('rejects an unconfirmed enablement even when its command exits successfully', async () => {
    const host = fixture('off')
    await expect(enableExistingUserQuota(async argv => argv[0] === '/usr/sbin/quotaon' && !argv.includes('--print-state') ? ok() : host.run(argv), '/home'))
      .rejects.toMatchObject({ detail: { unknownOutcome: true, verificationRequired: true } })
  })
})

describe('user quota setup', () => {
  const FSTAB = '# /etc/fstab\n/dev/disk/by-uuid/5e6f / ext4 defaults 0 1\n/dev/disk/by-uuid/3ED7 /boot/efi vfat defaults 0 1\n'
  const STAMP = '20261102T140000Z'
  const host = (options: { fstype?: string; enforced?: boolean; remount?: boolean; scan?: boolean; kernels?: { release: string; moduleIndex: string }[] } = {}) => {
    const commands: string[][] = [], files = new Map([['/etc/fstab', FSTAB]])
    let state: 'none' | 'off' | 'on' = options.enforced ? 'on' : 'none'
    const run: QuotaCommandRunner = async argv => {
      commands.push(argv)
      if (argv[0] === '/usr/bin/findmnt') return ok(({ TARGET: '/', SOURCE: '/dev/sda1', FSTYPE: options.fstype ?? 'ext4' } as Record<string, string>)[argv[4]!]!)
      if (argv.includes('--print-state')) return state === 'none'
        ? { ok: true, code: 0, stdout: '', stderr: 'quotaon: Mountpoint (or device) / not found or has no quota enabled.\n' }
        : { ok: state === 'off', code: state === 'on' ? 1 : 0, stdout: `user quota on / (/dev/sda1) is ${state}\n`, stderr: '' }
      if (argv[0] === '/usr/bin/mount') {
        if (options.remount === false) return { ok: false, code: 32, stdout: '', stderr: 'mount: /: mount point not mounted or bad option.' }
        state = 'off'
      }
      if (argv[0] === '/usr/sbin/quotaon') state = 'on'
      return ok()
    }
    const scan: QuotaCommandRunner = async argv => { commands.push(argv); return options.scan === false ? { ok: false, code: 1, stdout: '', stderr: 'timed out' } : ok() }
    const ports = { run, scan, bootableKernels: async () => options.kernels ?? [{ release: '6.8.0-147-generic', moduleIndex: MODULES }],
      readFile: async (path: string) => files.get(path) ?? null,
      writeFile: async (file: { path: string; content: string }) => { files.set(file.path, file.content) } }
    return { ports, commands, files }
  }

  it('sets quota on the mount that holds /home, which is / when /home is not its own filesystem', async () => {
    expect(await resolveHomeQuotaFilesystem(host().ports.run)).toBe('/')
    await expect(resolveHomeQuotaFilesystem(async () => ({ ok: false, code: 1, stdout: '', stderr: '' }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('adds journaled user quota to the one matching fstab entry and keeps the rest of the table', () => {
    expect(fstabWithUserQuota(FSTAB, '/')).toBe(FSTAB.replace('/ ext4 defaults 0 1', '/ ext4 defaults,usrjquota=aquota.user,jqfmt=vfsv1 0 1'))
    expect(fstabWithUserQuota(FSTAB.replace('defaults 0 1\n/dev', 'defaults,usrquota 0 1\n/dev'), '/')).toBeNull()
    expect(() => fstabWithUserQuota('#/dev/sda1 / ext4 defaults 0 1\n', '/')).toThrow('exactly one /etc/fstab entry')
    expect(() => fstabWithUserQuota(FSTAB + '/dev/sdb1 / ext4 defaults 0 1\n', '/')).toThrow('exactly one /etc/fstab entry')
  })

  it('backs up fstab, remounts, builds accounting and verifies enforcement on the mount of the homes', async () => {
    const h = host()
    const result = await initializeUserQuota(h.ports, '/home', STAMP)
    expect(result).toMatchObject({ filesystem: '/', source: '/dev/sda1', status: 'enabled', changed: true, fstabBackup: '/etc/fstab.bak.' + STAMP })
    expect(h.files.get('/etc/fstab.bak.' + STAMP)).toBe(FSTAB)
    expect(h.files.get('/etc/fstab')).toContain('/ ext4 defaults,usrjquota=aquota.user,jqfmt=vfsv1 0 1')
    expect(h.commands.filter(argv => !argv.includes('--print-state') && argv[0] !== '/usr/bin/findmnt')).toEqual([
      ['/usr/bin/mount', '-o', 'remount', '/'],
      ['/usr/sbin/quotacheck', '--create-files', '--user', '--no-remount', '--format=vfsv1', '/'],
      ['/usr/sbin/quotaon', '--user', '/'],
    ])
  })

  it('finds the quota format modules built in or as compressed modules, and misses either one', () => {
    expect(lacksQuotaFormat(MODULES)).toBe(false)
    expect(lacksQuotaFormat('kernel/fs/quota/quota_v2.ko\nkernel/fs/quota/quota_tree.ko\n')).toBe(false)
    expect(lacksQuotaFormat('kernel/fs/quota/quota_v2.ko.zst:\n')).toBe(true)
    expect(lacksQuotaFormat('kernel/fs/ext4/ext4.ko.zst: kernel/fs/jbd2/jbd2.ko.zst\nkernel/fs/quota/quota_v20.ko:\nkernel/fs/quota/quota_tree.ko:\n')).toBe(true)
    expect(lacksQuotaFormat('kernel/fs/quota/quota_v2xko:\nkernel/fs/quota/quota_tree.ko:\n')).toBe(true)
  })

  it('refuses before any write while a bootable kernel lacks the quota format, so that boot can still mount it', async () => {
    const h = host({ kernels: [{ release: '5.15.0-198-generic', moduleIndex: MODULES }, { release: '5.15.0-202-generic', moduleIndex: 'kernel/fs/ext4/ext4.ko:\n' }] })
    await expect(initializeUserQuota(h.ports, '/home', STAMP)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, kernels: ['5.15.0-202-generic'] } })
    expect([...h.files.keys()]).toEqual(['/etc/fstab'])
    expect(h.commands.some(argv => argv[0] === '/usr/bin/mount')).toBe(false)
  })

  it('restores fstab when the kernel refuses the quota options and builds no accounting', async () => {
    const h = host({ remount: false })
    await expect(initializeUserQuota(h.ports, '/home', STAMP)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining('restored') })
    expect(h.files.get('/etc/fstab')).toBe(FSTAB)
    expect(h.commands.some(argv => argv[0] === '/usr/sbin/quotacheck')).toBe(false)
  })

  it('reports an interrupted accounting scan as unverified and does not switch enforcement on', async () => {
    const h = host({ scan: false })
    await expect(initializeUserQuota(h.ports, '/home', STAMP)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { verificationRequired: true, step: 'quotacheck' } })
    expect(h.commands.some(argv => argv[0] === '/usr/sbin/quotaon' && !argv.includes('--print-state'))).toBe(false)
  })

  it('changes nothing on an enforcing filesystem and refuses an unsupported one before any write', async () => {
    const enforced = host({ enforced: true })
    expect(await initializeUserQuota(enforced.ports, '/home', STAMP)).toMatchObject({ status: 'enabled', changed: false, fstabBackup: null })
    expect([...enforced.files.keys()]).toEqual(['/etc/fstab'])
    const xfs = host({ fstype: 'xfs' })
    await expect(initializeUserQuota(xfs.ports, '/home', STAMP)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect([...xfs.files.keys()]).toEqual(['/etc/fstab'])
    expect(xfs.commands.some(argv => argv[0] === '/usr/bin/mount')).toBe(false)
  })
})

describe('installer quota step', () => {
  const FSTAB = '/dev/disk/by-uuid/5e6f / ext4 defaults 0 1\n'
  const ports = (fstype: string, quotaOn = false) => {
    let state: 'none' | 'off' | 'on' = quotaOn ? 'on' : 'none'
    const files = new Map([['/etc/fstab', FSTAB]])
    const run: QuotaCommandRunner = async argv => {
      if (argv[0] === '/usr/bin/findmnt') return ok(({ TARGET: '/', SOURCE: '/dev/sda1', FSTYPE: fstype } as Record<string, string>)[argv[4]!]!)
      if (argv.includes('--print-state')) return state === 'none' ? { ok: true, code: 0, stdout: '', stderr: 'quotaon: no quota\n' }
        : { ok: state === 'off', code: state === 'on' ? 1 : 0, stdout: `user quota on / (/dev/sda1) is ${state === 'on' && fstype === 'xfs' ? 'on (enforced)' : state}\n`, stderr: '' }
      if (argv[0] === '/usr/bin/mount') state = 'off'
      if (argv[0] === '/usr/sbin/quotaon') state = 'on'
      return ok()
    }
    return { run, scan: async () => ok(), bootableKernels: async () => [{ release: '6.8.0-147-generic', moduleIndex: MODULES }], readFile: async (path: string) => files.get(path) ?? null, writeFile: async (file: { path: string; content: string }) => { files.set(file.path, file.content) } }
  }
  const now = new Date('2026-11-02T18:00:00.000Z')

  it('enforces ext4 quota and reports the backup it made', async () => {
    expect(await installQuotaSetup(ports('ext4'), '/home', now)).toEqual({ exitCode: 0,
      report: { status: 'enabled', filesystem: '/', filesystemType: 'ext4', fstabBackup: '/etc/fstab.bak.20261102T180000Z' } })
  })

  it('reports XFS without uquota as pending instead of claiming enforcement', async () => {
    expect(await installQuotaSetup(ports('xfs'), '/home', now)).toMatchObject({ exitCode: 2, report: { status: 'pending', filesystemType: 'xfs' } })
    expect(await installQuotaSetup(ports('xfs', true), '/home', now)).toMatchObject({ exitCode: 0, report: { status: 'already_enforced' } })
  })

  it('stops the installer when setup ends part-way', async () => {
    const broken = { ...ports('ext4'), scan: async () => ({ ok: false, code: 1, stdout: '', stderr: 'timed out' }) }
    expect(await installQuotaSetup(broken, '/home', now)).toMatchObject({ exitCode: 1, report: { status: 'unverified', step: 'quotacheck' } })
  })
})
