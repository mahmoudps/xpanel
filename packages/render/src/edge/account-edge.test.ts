import { describe, expect, it } from 'vitest'
import { ACCOUNT_EDGE_DENY_MAX, renderAccountEdgeServer } from './account-edge.ts'
import { renderNginxSite } from './nginx.ts'
import { account, domain, serverBlocks, settings } from './testkit.ts'

describe('per-account edge policy', () => {
  it('renders the IP Blocker list and the cache epoch into every server block of the account', () => {
    expect(renderAccountEdgeServer()).toEqual(['set $xpanel_cache_epoch "";'])
    expect(renderAccountEdgeServer({ deny: ['192.0.2.7', '198.51.100.0/24', '2001:db8::/32'], cacheEpoch: 'mh3k2a9z' }))
      .toEqual(['deny 192.0.2.7;', 'deny 198.51.100.0/24;', 'deny 2001:db8::/32;', 'set $xpanel_cache_epoch "mh3k2a9z:";'])
    const site = renderNginxSite(account(), [domain()], settings(), null, { accountEdge: { deny: ['203.0.113.9'], cacheEpoch: 'a1' } })
    const servers = serverBlocks(site)
    expect(servers.length).toBeGreaterThan(0)
    for (const server of servers) { expect(server).toContain('deny 203.0.113.9;'); expect(server).toContain('set $xpanel_cache_epoch "a1:";') }
    expect(site).toContain('proxy_cache_key $xpanel_cache_epoch$scheme$host$request_uri;')
    expect(site).not.toContain('BYPASS')
    const off = renderNginxSite(account(), [domain()], settings(), null, { accountEdge: { deny: [], cacheEpoch: null }, cache: false })
    for (const server of serverBlocks(off)) expect(server).toContain('add_header X-Cache-Status BYPASS always;')
    expect(off).not.toContain('proxy_cache ')
  })
  it('refuses values that are not canonical addresses or a bounded epoch', () => {
    for (const deny of [['192.0.2.1; allow all'], ['192.0.2.1\ndeny all'], ['999.1.1.1'], ['01.2.3.4']]) expect(() => renderAccountEdgeServer({ deny, cacheEpoch: null }), deny[0]).toThrow()
    for (const cacheEpoch of ['', 'A1', 'a"b', 'x'.repeat(17)]) expect(() => renderAccountEdgeServer({ deny: [], cacheEpoch }), cacheEpoch).toThrow()
    expect(() => renderAccountEdgeServer({ deny: Array.from({ length: ACCOUNT_EDGE_DENY_MAX + 1 }, (_value, index) => '10.0.' + Math.floor(index / 250) + '.' + (index % 250)), cacheEpoch: null })).toThrow()
  })
})
