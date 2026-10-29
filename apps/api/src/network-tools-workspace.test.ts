import { describe, expect, it, vi } from 'vitest'
import type { Account, Plan } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { createNetworkToolsGate, handleNetworkToolsRoute } from './network-tools-workspace.ts'
import type { ReadAgent } from './account-ssh-workspace.ts'
import { handleNetworkToolsRoute as handleAgentNetworkTools } from '../../agent/src/network-tools.ts'
import type { DnsRecordType, NetworkToolsHost } from '../../agent/src/network-tools.ts'

// The agent route is the actual handler; only the host resolver/runner/connector and the transport are doubles.
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const account = { id: ACCOUNT, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: 'plan', primaryDomain: 'example.test' } as Account
const owner = { principal: { kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT }, apiTokenId: null, scopes: [], principalRecord: { forcePasswordChange: false } } as unknown as AuthenticatedCaller
const PING = '4 packets transmitted, 3 received, 25% packet loss, time 3004ms\nrtt min/avg/max/mdev = 10.000/11.000/12.000/0.816 ms\n'
const TRACE = 'traceroute to 93.184.215.14 (93.184.215.14), 20 hops max, 60 byte packets\n 1  192.168.0.1  0.300 ms\n 2  93.184.215.14  9.000 ms\n'
const answers: Partial<Record<string, Partial<Record<DnsRecordType, string[]>>>> = { 'example.com': { A: ['93.184.215.14'], TXT: ['v=spf1 -all'] }, 'intranet.example.com': { A: ['10.20.30.40'] } }

function setup(options: { disabled?: string[]; caller?: AuthenticatedCaller; reply?: (value: Record<string, unknown>) => unknown; gate?: ReturnType<typeof createNetworkToolsGate> } = {}) {
  const host: NetworkToolsHost = {
    resolve: vi.fn(async (name: string, type: DnsRecordType) => { const value = answers[name]?.[type]; if (!value) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' }); return value }),
    run: vi.fn(async (argv: string[]) => ({ ok: true, code: 0, stdout: argv[2] === '/usr/bin/ping' ? PING : TRACE, stderr: '' })),
    connect: vi.fn(async () => 'closed' as const),
  }
  const readAgent = vi.fn(async (_caller: AuthenticatedCaller, path: string, input?: unknown) => {
    const url = new URL('http://agent.local' + path)
    const response = await handleAgentNetworkTools(new Request(url, { method: 'POST', body: JSON.stringify(input) }), url, 'POST', { caller: { principalId: 'p-alice', actor: 'alice', role: 'user', accountId: ACCOUNT, resellerId: null }, host,
      store: { getAccountByUsername: async () => account, getPlan: async () => ({ featureListId: 'list' }) as Plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: [] }) },
      currentPrincipal: async () => ({ kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT, disabled: false }), now: () => new Date('2026-10-27T02:00:00.000Z') })
    const value = await response!.json() as Record<string, unknown>
    return options.reply ? options.reply(value) : value
  })
  const store = { getAccount: async (id: string) => id === ACCOUNT ? account : null, getPlan: async () => ({ featureListId: 'list' }), getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: options.disabled ?? [] }) } as unknown as StateStore
  const ports = { store, requireCaller: async () => options.caller ?? owner, readAgent: readAgent as unknown as ReadAgent, networkToolsGate: options.gate ?? createNetworkToolsGate() }
  const route = (tool: string, body: unknown, method = 'POST', search = '') => { const url = new URL('http://panel.test/api/account/network-tools/' + tool + search); return handleNetworkToolsRoute(new Request(url, { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), url, method, ports) }
  return { route, readAgent, host }
}
const json = async (response: Response | null) => await response!.json() as Record<string, any>

describe('account network tools workspace', () => {
  it('runs each tool through the agent and returns the pinned view', async () => {
    const t = setup()
    const ping = await json(await t.route('ping', { host: 'example.com' }))
    expect(t.readAgent.mock.calls[0]!.slice(1)).toEqual(['/accounts/alice/network-tools/ping', { host: 'example.com' }])
    expect(ping).toMatchObject({ context: { accountId: ACCOUNT, tool: 'ping' }, outcome: 'completed', target: { address: '93.184.215.14', family: 4 }, result: { transmitted: 4, received: 3, lossPercent: 25, rtt: { minMs: 10, avgMs: 11, maxMs: 12 } } })
    expect(await json(await t.route('dns', { name: 'example.com', type: 'TXT' }))).toMatchObject({ result: { status: 'answer', records: ['v=spf1 -all'] } })
    expect(await json(await t.route('traceroute', { host: '93.184.215.14' }))).toMatchObject({ result: { reached: true, hops: [{ hop: 1, address: null, nonPublic: true }, { hop: 2, address: '93.184.215.14' }] } })
    expect(await json(await t.route('port', { host: 'example.com', port: 25 }))).toMatchObject({ result: { state: 'closed' } })
    expect(await json(await t.route('ping', { host: 'intranet.example.com' }))).toMatchObject({ outcome: 'refused', target: null, result: null })
    expect(t.host.run).toHaveBeenCalledTimes(2)
  })
  it('is owner-only and plan-gated before any agent call', async () => {
    const t = setup()
    for (const kind of ['root', 'reseller'] as const) await expect(setup({ caller: { ...owner, principal: { kind, id: kind, username: kind } } as unknown as AuthenticatedCaller }).route('ping', { host: 'example.com' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setup({ disabled: ['track-dns'] }).route('ping', { host: 'example.com' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setup({ disabled: ['nettools'] }).route('dns', { name: 'example.com', type: 'A' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(t.route('ping', { host: '--help' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(t.route('ping', { host: 'example.com', interval: 0 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(t.route('ping', { host: 'example.com' }, 'POST', '?host=10.0.0.1')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await t.route('ping', null, 'GET'))!.status).toBe(405)
    expect(await t.route('whois', { host: 'example.com' })).toBeNull()
    expect(t.readAgent).not.toHaveBeenCalled()
  })
  it('limits each account to one run at a time and ten runs per minute', async () => {
    let clock = 0, release!: () => void
    const gate = createNetworkToolsGate(10, 60_000, () => clock)
    const slow = gate(ACCOUNT, () => new Promise<string>(resolve => { release = () => resolve('done') }))
    await expect(gate(ACCOUNT, async () => 'second')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await gate('other-account', async () => 'parallel')).toBe('parallel')
    release(); expect(await slow).toBe('done')
    for (let index = 1; index < 10; index++) await gate(ACCOUNT, async () => index)
    await expect(gate(ACCOUNT, async () => 'eleventh')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', detail: { retryAfterSeconds: 60 } })
    clock = 60_000; expect(await gate(ACCOUNT, async () => 'later')).toBe('later')
    await expect(gate(ACCOUNT, async () => { throw new Error('boom') })).rejects.toThrow('boom'); expect(await gate(ACCOUNT, async () => 'released')).toBe('released')
    const t = setup({ gate: createNetworkToolsGate(1) }); await t.route('dns', { name: 'example.com', type: 'A' })
    await expect(t.route('dns', { name: 'example.com', type: 'A' })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' }); expect(t.readAgent).toHaveBeenCalledTimes(1)
  })
  it('refuses agent replies that are foreign, private or inconsistent', async () => {
    const replies: [string, unknown, (v: Record<string, any>) => unknown][] = [
      ['ping', { host: 'example.com' }, v => ({ ...v, context: { ...v.context, accountId: '99999999-9999-4999-8999-999999999999' } })],
      ['ping', { host: 'example.com' }, v => ({ ...v, query: { host: 'other.example.com' } })],
      ['ping', { host: 'example.com' }, v => ({ ...v, target: { address: '10.0.0.1', family: 4 } })],
      ['ping', { host: 'example.com' }, v => ({ ...v, result: { ...v.result, received: 9 } })],
      ['ping', { host: 'example.com' }, v => ({ ...v, extra: true })],
      ['traceroute', { host: '93.184.215.14' }, v => ({ ...v, result: { ...v.result, hops: [{ hop: 1, address: '192.168.0.1', nonPublic: false, rttMs: 1, note: null }, v.result.hops[1]] } })],
      ['traceroute', { host: '93.184.215.14' }, v => ({ ...v, result: { ...v.result, reached: false } })],
      ['traceroute', { host: '93.184.215.14' }, v => ({ ...v, target: { address: '1.1.1.1', family: 4 } })],
      ['dns', { name: 'example.com', type: 'TXT' }, v => ({ ...v, result: { ...v.result, records: ['a\nb'] } })],
      ['dns', { name: 'example.com', type: 'TXT' }, v => ({ ...v, result: { status: 'answer', records: [], truncated: false } })],
      ['port', { host: 'example.com', port: 25 }, v => ({ ...v, result: { state: 'maybe', elapsedMs: 1 } })],
    ]
    for (const [tool, body, reply] of replies) await expect(setup({ reply }).route(tool, body)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
  })
})
