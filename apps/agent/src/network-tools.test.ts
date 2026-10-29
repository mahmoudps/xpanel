import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { Account, Plan } from '@xpanel/core'
import { DNS_MAX_RECORDS, handleNetworkToolsRoute, lookupDns, parseNetworkToolRequest, parsePingSummary, parseTraceroute, queryDns, resolveNetworkTarget, systemNetworkToolsHost } from './network-tools.ts'
import type { DnsRecordType, NetworkToolsHost, NetworkToolsRouteDeps } from './network-tools.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const account = { id: ACCOUNT, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: 'plan', primaryDomain: 'example.test' } as Account
const PING_OK = `PING 93.184.215.14 (93.184.215.14) 56(84) bytes of data.
64 bytes from 93.184.215.14: icmp_seq=1 ttl=56 time=11.6 ms
64 bytes from 93.184.215.14: icmp_seq=4 ttl=56 time=11.7 ms

--- 93.184.215.14 ping statistics ---
4 packets transmitted, 4 received, 0% packet loss, time 3005ms
rtt min/avg/max/mdev = 11.555/11.632/11.704/0.055 ms
`
const TRACE_OK = `traceroute to 93.184.215.14 (93.184.215.14), 20 hops max, 60 byte packets
 1  10.0.0.1  0.412 ms
 2  *
 3  1.1.1.1  4.210 ms
 4  93.184.215.14  11.204 ms
`
type Answers = Partial<Record<string, Partial<Record<DnsRecordType, string[] | Error>>>>
const errno = (code: string): Error => Object.assign(new Error(code), { code })
const fakeHost = (answers: Answers = {}, output: Partial<Record<'ping' | 'traceroute', { ok: boolean; code: number; stdout: string; stderr: string }>> = {}) => {
  const host = {
    resolve: vi.fn(async (name: string, type: DnsRecordType) => { const value = answers[name]?.[type]; if (value instanceof Error) throw value; if (!value) throw errno('ENODATA'); return value }),
    run: vi.fn(async (argv: string[]) => output[argv[2]!.endsWith('ping') ? 'ping' : 'traceroute'] ?? { ok: true, code: 0, stdout: argv[2]!.endsWith('ping') ? PING_OK : TRACE_OK, stderr: '' }),
    connect: vi.fn(async (): Promise<'open' | 'closed' | 'filtered'> => 'open'),
  }
  return host satisfies NetworkToolsHost
}

describe('network diagnostic request grammar', () => {
  it('accepts exact fields and canonical targets', () => {
    expect(parseNetworkToolRequest('dns', { name: '_DMARC.Example.COM.', type: 'TXT' })).toEqual({ tool: 'dns', name: '_dmarc.example.com', type: 'TXT' })
    expect(parseNetworkToolRequest('ping', { host: '2606:4700:4700:0:0:0:0:1111' })).toEqual({ tool: 'ping', host: '2606:4700:4700::1111' })
    expect(parseNetworkToolRequest('port', { host: 'mail.example.com', port: 587 })).toEqual({ tool: 'port', host: 'mail.example.com', port: 587 })
  })
  it('refuses option injection, zone ids, IP names for DNS, unknown fields and bad ports', () => {
    for (const host of ['-f', '--', '-fexample.com', '8.8.8.8 -f', 'a;b.com', 'fe80::1%eth0', '[::1]', 'localhost', 'exa mple.com', 'example.123', '', 'x'.repeat(260), 8]) expect(() => parseNetworkToolRequest('ping', { host })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    for (const body of [{ name: '8.8.8.8', type: 'A' }, { name: '2001:db8::1', type: 'NS' }, { name: 'example.com', type: 'ANY' }, { name: 'example.com', type: 'a' }, { name: 'example.com' }, { name: 'example.com', type: 'A', server: '10.0.0.1' }])
      expect(() => parseNetworkToolRequest('dns', body)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    for (const port of [0, 65536, '80', 1.5, -1]) expect(() => parseNetworkToolRequest('port', { host: 'example.com', port })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => parseNetworkToolRequest('ping', { host: 'example.com', count: 100 })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => parseNetworkToolRequest('whois', { host: 'example.com' })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => parseNetworkToolRequest('ping', [])).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })
})

describe('target resolution and SSRF refusal', () => {
  it('refuses literals and names that resolve to any non-public address', async () => {
    for (const literal of ['127.0.0.1', '169.254.169.254', '10.0.0.8', '::1', 'fe80::1', '100.64.1.1']) expect(await resolveNetworkTarget(fakeHost(), literal)).toBe('refused')
    expect(await resolveNetworkTarget(fakeHost({ 'internal.example.com': { A: ['10.0.0.5'] } }), 'internal.example.com')).toBe('refused')
    expect(await resolveNetworkTarget(fakeHost({ 'mixed.example.com': { A: ['8.8.8.8'], AAAA: ['::1'] } }), 'mixed.example.com')).toBe('refused')
    expect(await resolveNetworkTarget(fakeHost({ 'rebind.example.com': { A: ['93.184.215.14', '169.254.169.254'] } }), 'rebind.example.com')).toBe('refused')
    expect(await resolveNetworkTarget(fakeHost({ 'gone.example.com': { A: errno('ENOTFOUND'), AAAA: errno('ETIMEOUT') } }), 'gone.example.com')).toBe('unresolved')
  })
  it('uses one checked literal and prefers IPv4', async () => {
    expect(await resolveNetworkTarget(fakeHost({ 'example.com': { A: ['93.184.215.14'], AAAA: ['2606:2800:21f:cb07:6820:80da:af6b:8b2c'] } }), 'example.com')).toEqual({ address: '93.184.215.14', family: 4 })
    expect(await resolveNetworkTarget(fakeHost({ 'v6.example.com': { AAAA: ['2606:2800:021f:cb07:6820:80da:af6b:8b2c'] } }), 'v6.example.com')).toEqual({ address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 })
  })
})

describe('output parsers', () => {
  it('parses the iputils ping summary strictly', () => {
    expect(parsePingSummary(PING_OK)).toEqual({ transmitted: 4, received: 4, errors: 0, lossPercent: 0, rtt: { minMs: 11.555, avgMs: 11.632, maxMs: 11.704 } })
    expect(parsePingSummary('--- x ping statistics ---\n10 packets transmitted, 0 received, +4 errors, 100% packet loss, time 9214ms\n')).toEqual({ transmitted: 10, received: 0, errors: 4, lossPercent: 100, rtt: null })
    expect(parsePingSummary('6 packets transmitted, 4 received, +1 duplicates, 33.3333% packet loss, time 5006ms\nrtt min/avg/max/mdev = 10.000/12.000/14.000/1.633 ms, pipe 2\n')).toMatchObject({ transmitted: 6, received: 4, lossPercent: 33.3333 })
    for (const bad of ['', '4 packets transmitted, 4 received, 0% packet loss, time 3005ms\n', '4 packets transmitted, 0 received, 0% packet loss\n', '4 packets transmitted, 5 received, 0% packet loss\nrtt min/avg/max/mdev = 1.000/1.000/1.000/0.000 ms\n',
      '4 Pakete übertragen, 4 empfangen, 0% Paketverlust, Zeit 3005ms\n', '4 packets transmitted, 4 received, 0% packet loss\nrtt min/avg/max/mdev = 9.000/1.000/2.000/0.000 ms\n', '99 packets transmitted, 0 received, 100% packet loss\n'])
      expect(parsePingSummary(bad)).toBeNull()
  })
  it('parses traceroute hops, hides non-public hops and detects arrival', () => {
    expect(parseTraceroute(TRACE_OK, '93.184.215.14')).toEqual({ reached: true, hops: [{ hop: 1, address: null, nonPublic: true, rttMs: 0.412, note: null }, { hop: 2, address: null, nonPublic: false, rttMs: null, note: null },
      { hop: 3, address: '1.1.1.1', nonPublic: false, rttMs: 4.21, note: null }, { hop: 4, address: '93.184.215.14', nonPublic: false, rttMs: 11.204, note: null }] })
    const long = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2) + '  1.1.1.' + (index + 1) + '  1.000 ms' + (index === 11 ? ' !H' : '')).join('\n')
    expect(parseTraceroute(long, '93.184.215.14')).toMatchObject({ reached: false, hops: { length: 12, 11: { hop: 12, note: '!H' } } })
    for (const bad of ['', TRACE_OK.replace(' 2  *', ' 5  *'), TRACE_OK.replace('(93.184.215.14)', '(1.1.1.1)'), TRACE_OK + ' 5  bogus  1.000 ms\n', TRACE_OK.replace('4.210 ms', '4.210ms'), Array.from({ length: 21 }, (_, i) => String(i + 1).padStart(2) + '  *').join('\n')])
      expect(parseTraceroute(bad, '93.184.215.14')).toBeNull()
  })
  it('formats DNS answers in presentation order and bounds them', async () => {
    const resolver = { resolve4: async () => ['192.0.2.1'], resolve6: async () => ['2001:db8::1'], resolveMx: async () => [{ priority: 20, exchange: 'b.example.com' }, { priority: 10, exchange: 'a.example.com' }], resolveTxt: async () => [['v=spf1 ', '-all']],
      resolveCname: async () => ['target.example.com'], resolveNs: async () => ['ns1.example.com'], resolveSoa: async () => ({ nsname: 'ns1.example.com', hostmaster: 'hostmaster.example.com', serial: 2026102701, refresh: 7200, retry: 3600, expire: 1209600, minttl: 300 }),
      resolveCaa: async () => [{ critical: 0, issue: 'letsencrypt.org' }] } as unknown as Parameters<typeof queryDns>[0]
    expect(await queryDns(resolver, 'example.com', 'MX')).toEqual(['10 a.example.com', '20 b.example.com']); expect(await queryDns(resolver, 'example.com', 'TXT')).toEqual(['v=spf1 -all'])
    expect(await queryDns(resolver, 'example.com', 'SOA')).toEqual(['ns1.example.com hostmaster.example.com 2026102701 7200 3600 1209600 300']); expect(await queryDns(resolver, 'example.com', 'CAA')).toEqual(['0 issue "letsencrypt.org"'])
    const many = fakeHost({ 'example.com': { TXT: [...Array.from({ length: 60 }, (_, index) => 'r' + index), 'bad\u0007'] } })
    expect(await lookupDns(many, 'example.com', 'TXT')).toMatchObject({ status: 'answer', truncated: true, records: { length: DNS_MAX_RECORDS } })
    expect((await lookupDns(fakeHost({ 'example.com': { TXT: ['bell\u0007', 'x'.repeat(3000)] } }), 'example.com', 'TXT'))).toMatchObject({ truncated: true, records: ['bell�', 'x'.repeat(2048) + '…'] })
    for (const [code, status] of [['ENOTFOUND', 'nxdomain'], ['ENODATA', 'nodata'], ['ESERVFAIL', 'servfail'], ['EREFUSED', 'refused'], ['ECANCELLED', 'timeout'], ['constructor', 'failed']] as const)
      expect(await lookupDns(fakeHost({ 'example.com': { A: errno(code) } }), 'example.com', 'A')).toEqual({ status, records: [], truncated: false })
  })
  it('classifies real TCP connects as open or closed', async () => {
    const server = createServer(socket => socket.destroy()); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port, host = systemNetworkToolsHost(async () => ({ ok: false, code: 1, stdout: '', stderr: '' }))
    expect(await host.connect('127.0.0.1', 4, port)).toBe('open')
    await new Promise(resolve => server.close(resolve))
    expect(await host.connect('127.0.0.1', 4, port)).toBe('closed')
  })
})

describe('agent network tools route', () => {
  const principal = { kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT, disabled: false }
  const setup = (over: { role?: 'user' | 'reseller' | 'root'; disabled?: string[]; host?: NetworkToolsHost | null; principals?: (typeof principal | null)[] } = {}) => {
    const host = over.host === undefined ? fakeHost({ 'example.com': { A: ['93.184.215.14'], MX: ['10 mail.example.com'] }, 'internal.example.com': { A: ['192.168.1.9'] } }) : over.host, principals = [...(over.principals ?? [])]
    const deps: NetworkToolsRouteDeps = { caller: { principalId: 'p-alice', actor: 'alice', role: over.role ?? 'user', accountId: over.role && over.role !== 'user' ? null : ACCOUNT, resellerId: null },
      store: { getAccountByUsername: async name => name === 'alice' ? account : null, getPlan: async () => ({ featureListId: 'list' }) as Plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: over.disabled ?? [] }) },
      currentPrincipal: async () => principals.length ? principals.shift()! : principal, host, now: () => new Date('2026-10-27T02:00:00.000Z') }
    const call = (path: string, body: unknown, method = 'POST') => { const url = new URL('http://agent.local' + path); return handleNetworkToolsRoute(new Request(url, { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), url, method, deps) }
    return { call, host }
  }
  it('runs ping by the checked address and returns the parsed summary', async () => {
    const t = setup(), response = await t.call('/accounts/alice/network-tools/ping', { host: 'Example.com' })
    expect((t.host as ReturnType<typeof fakeHost>).run).toHaveBeenCalledWith(['/usr/bin/env', 'LC_ALL=C', '/usr/bin/ping', '-n', '-c', '4', '-W', '2', '-w', '10', '93.184.215.14'])
    expect(await response!.json()).toEqual({ context: { accountId: ACCOUNT, tool: 'ping' }, query: { host: 'example.com' }, outcome: 'completed', target: { address: '93.184.215.14', family: 4 },
      result: { transmitted: 4, received: 4, errors: 0, lossPercent: 0, rtt: { minMs: 11.555, avgMs: 11.632, maxMs: 11.704 } }, observedAt: '2026-10-27T02:00:00.000Z' })
    expect(await (await t.call('/accounts/alice/network-tools/dns', { name: 'example.com', type: 'MX' }))!.json()).toMatchObject({ outcome: 'completed', target: null, result: { status: 'answer', records: ['10 mail.example.com'], truncated: false } })
    expect(await (await t.call('/accounts/alice/network-tools/port', { host: '93.184.215.14', port: 443 }))!.json()).toMatchObject({ outcome: 'completed', result: { state: 'open' } })
    expect(await t.call('/accounts/alice/files', {})).toBeNull()
  })
  it('refuses private targets without sending anything', async () => {
    const t = setup(), host = t.host as ReturnType<typeof fakeHost>
    for (const [tool, body] of [['ping', { host: 'internal.example.com' }], ['traceroute', { host: '169.254.169.254' }], ['port', { host: '127.0.0.1', port: 22 }], ['port', { host: '::1', port: 25 }]] as const)
      expect(await (await t.call('/accounts/alice/network-tools/' + tool, body))!.json()).toMatchObject({ outcome: 'refused', target: null, result: null })
    expect(host.run).not.toHaveBeenCalled(); expect(host.connect).not.toHaveBeenCalled()
  })
  it('is owner-only, plan-gated, fresh after the run and truthful when the host cannot run', async () => {
    for (const role of ['reseller', 'root'] as const) await expect(setup({ role }).call('/accounts/alice/network-tools/ping', { host: 'example.com' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setup().call('/accounts/bob/network-tools/ping', { host: 'example.com' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    for (const key of ['track-dns', 'nettools']) { const disabled = setup({ disabled: [key] }); await expect(disabled.call('/accounts/alice/network-tools/ping', { host: 'example.com' })).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect((disabled.host as ReturnType<typeof fakeHost>).resolve).not.toHaveBeenCalled() }
    const revoked = setup({ principals: [principal, { ...principal, disabled: true }] })
    await expect(revoked.call('/accounts/alice/network-tools/ping', { host: 'example.com' })).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect((revoked.host as ReturnType<typeof fakeHost>).run).toHaveBeenCalledTimes(1)
    await expect(setup({ host: null }).call('/accounts/alice/network-tools/ping', { host: 'example.com' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(setup({ host: fakeHost({}, { traceroute: { ok: false, code: 127, stdout: '', stderr: "env: '/usr/bin/traceroute': No such file or directory" } }) }).call('/accounts/alice/network-tools/traceroute', { host: '93.184.215.14' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'traceroute is not installed on this server' })
    await expect(setup({ host: fakeHost({}, { ping: { ok: false, code: 2, stdout: '', stderr: 'connect: Network is unreachable' } }) }).call('/accounts/alice/network-tools/ping', { host: '93.184.215.14' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(setup({ host: { ...fakeHost(), connect: async () => { throw new Error('EMFILE') } } }).call('/accounts/alice/network-tools/port', { host: '93.184.215.14', port: 80 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(setup().call('/accounts/alice/network-tools/ping?host=127.0.0.1', { host: 'example.com' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(setup().call('/accounts/alice/network-tools/ping', { host: '-f' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await setup().call('/accounts/alice/network-tools/ping', null, 'GET'))!.status).toBe(405)
  })
})
