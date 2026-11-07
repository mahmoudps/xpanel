import { describe, expect, it } from 'vitest'
import type { Domain, HostAction } from '@xpanel/core'
import { applySiteQuota, isSiteQuotaCommand, observeSiteQuota, siteProjectId, siteQuotaActions } from './site-quota.ts'

const host = (fields: Record<string, string>, failing?: string) => {
  const commands: string[][] = []
  const run = async (argv: string[]) => {
    commands.push(argv)
    const output = argv[0] === '/usr/bin/findmnt' ? fields[argv[4]!] ?? '' : ''
    const ok = argv[0] === '/usr/bin/findmnt' ? output !== '' : !argv[3]?.startsWith(failing ?? '\0')
    return { ok, code: ok ? 0 : 1, stdout: output + '\n', stderr: '' }
  }
  return { commands, run }
}
const XFS = { FSTYPE: 'xfs', OPTIONS: 'rw,relatime,prjquota', TARGET: '/home' }
const action: Extract<HostAction, { kind: 'site-quota' }> = { kind: 'site-quota', path: '/home/a/public_html', projectId: 42, limitMb: 100 }
const domain = (over: Partial<Domain>): Domain => ({ id: 'd1', docRoot: '/home/a/public_html', pathQuotaMb: 'unlimited', ...over }) as Domain

describe('site path quota', () => {
  it('reads what the filesystem supports', async () => {
    expect(await observeSiteQuota(host(XFS).run, '/home/a')).toEqual({ state: 'ready', mount: '/home' })
    expect(await observeSiteQuota(host({ ...XFS, FSTYPE: 'ext4' }).run, '/home/a')).toEqual({ state: 'unsupported', reason: 'filesystem' })
    expect(await observeSiteQuota(host({ ...XFS, OPTIONS: 'rw,noquota' }).run, '/home/a')).toEqual({ state: 'unsupported', reason: 'mount_option' })
    expect(await observeSiteQuota(host({}).run, '/home/a')).toEqual({ state: 'unsupported', reason: 'unread' })
  })
  it('sets the project before its limit and clears in reverse', async () => {
    const set = host(XFS)
    await applySiteQuota(set.run, action)
    expect(set.commands.filter(argv => argv[0] === '/usr/sbin/xfs_quota').map(argv => argv[3])).toEqual(['project -s -p /home/a/public_html 42', 'limit -p bhard=100m 42'])
    const clear = host(XFS)
    await applySiteQuota(clear.run, { ...action, limitMb: 0 })
    expect(clear.commands.filter(argv => argv[0] === '/usr/sbin/xfs_quota').map(argv => argv[3])).toEqual(['limit -p bhard=0m 42', 'project -C -p /home/a/public_html 42'])
  })
  it('leaves an unsupported host alone and reports a failed command', async () => {
    const ext4 = host({ ...XFS, FSTYPE: 'ext4' })
    await applySiteQuota(ext4.run, action)
    expect(ext4.commands.some(argv => argv[0] === '/usr/sbin/xfs_quota')).toBe(false)
    await expect(applySiteQuota(host(XFS, 'limit').run, action)).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
  })
  it('admits only the reviewed xfs_quota scripts', () => {
    expect(isSiteQuotaCommand(['/usr/sbin/xfs_quota', '-x', '-c', 'limit -p bhard=5m 7', '/home'])).toBe(true)
    expect(isSiteQuotaCommand(['/usr/sbin/xfs_quota', '-x', '-c', 'project -s -p /home/a b 7', '/home'])).toBe(false)
    expect(isSiteQuotaCommand(['/usr/sbin/xfs_quota', '-x', '-c', 'remove -p', '/home'])).toBe(false)
    expect(isSiteQuotaCommand(['/usr/sbin/xfs_quota', '-x', '-c', 'limit -p bhard=5m 7', 'home'])).toBe(false)
  })
  it('acts only on changes since the applied generation', () => {
    const id = siteProjectId('d1')
    expect(siteQuotaActions([domain({})], [domain({})])).toEqual([])
    expect(siteQuotaActions([domain({})], [])).toEqual([])
    expect(siteQuotaActions([domain({ pathQuotaMb: 10 })], [])).toEqual([{ kind: 'site-quota', path: '/home/a/public_html', projectId: id, limitMb: 10 }])
    expect(siteQuotaActions([domain({})], [domain({ pathQuotaMb: 10 })])).toEqual([{ kind: 'site-quota', path: '/home/a/public_html', projectId: id, limitMb: 0 }])
    expect(siteQuotaActions([], [domain({ pathQuotaMb: 10 })])).toEqual([{ kind: 'site-quota', path: '/home/a/public_html', projectId: id, limitMb: 0 }])
    expect(siteQuotaActions([domain({ pathQuotaMb: 10 })], [domain({ pathQuotaMb: 10 })])).toEqual([])
  })
})
