import { describe, expect, it, vi } from 'vitest'
import { banListArgv, parseBanSet, readBans, unbanAddresses } from './firewall-bans.ts'

const setJson = (elem: unknown[]) => JSON.stringify({ nftables: [{ metainfo: { version: '1.0.9' } }, { set: { family: 'inet', name: 'xpanel_banned', table: 'xpanel', type: 'ipv4_addr', flags: ['timeout'], elem } }] })

describe('live ban sets', () => {
  it('parses bare and timed elements and refuses anything that is not an address', () => {
    expect(parseBanSet(setJson(['192.0.2.1', { elem: { val: '192.0.2.2', timeout: 3600, expires: 1200 } }]))).toEqual([
      { address: '192.0.2.1', timeoutSec: null, expiresSec: null }, { address: '192.0.2.2', timeoutSec: 3600, expiresSec: 1200 },
    ])
    expect(() => parseBanSet(setJson(['not-an-ip']))).toThrow()
    expect(banListArgv('xpanel_banned')).toEqual(['/usr/sbin/nft', '-j', 'list', 'set', 'inet', 'xpanel', 'xpanel_banned'])
  })

  it('unbans only addresses a fresh read shows banned and proves the result with a re-read', async () => {
    let v4 = ['192.0.2.1', '192.0.2.2']
    const run = vi.fn(async (argv: string[]) => {
      if (argv[1] === '-j') return { ok: true, stdout: argv.at(-1) === 'xpanel_banned' ? setJson(v4) : setJson([]), stderr: '' }
      if (argv[1] === 'delete') { v4 = v4.filter(ip => ip !== argv[7]); return { ok: true, stdout: '', stderr: '' } }
      return { ok: false, stdout: '', stderr: '' }
    })
    await expect(unbanAddresses(run, ['192.0.2.9'])).rejects.toMatchObject({ code: 'CONFLICT' })
    const result = await unbanAddresses(run, ['192.0.2.1', '192.0.2.2'])
    expect(result).toMatchObject({ unbanned: ['192.0.2.1', '192.0.2.2'], stillBanned: [] })
    expect(run.mock.calls.filter(call => call[0][1] === 'delete').map(call => call[0])).toEqual([
      ['/usr/sbin/nft', 'delete', 'element', 'inet', 'xpanel', 'xpanel_banned', '{', '192.0.2.1', '}'],
      ['/usr/sbin/nft', 'delete', 'element', 'inet', 'xpanel', 'xpanel_banned', '{', '192.0.2.2', '}'],
    ])
    await expect(unbanAddresses(run, ['127.0.0.1; rm'])).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('is unavailable when the sets do not exist yet', async () => {
    expect(await readBans(async () => ({ ok: false, stdout: '', stderr: 'No such file or directory' }))).toMatchObject({ state: 'unavailable', bans: [] })
  })
})
