import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { StateSnapshot } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { compareServerNetwork, handleServerObservationWorkspaceRoute, projectServerNetwork, projectServerRole, projectServerTimers, summarizeServerRole } from './server-observation-workspace.ts'
import type { ServerObservationSaved, ServerObservationWorkspaceHelpers } from './server-observation-workspace.ts'

const root = { principal: { kind: 'root', id: 'root-1', username: 'root' } } as AuthenticatedCaller
const at = '2026-10-27T10:00:00.000Z'
const read = <T>(items: T[]) => ({ state: 'read', reason: null, truncated: false, items })
const off = { state: 'unavailable', reason: 'host_unavailable', truncated: false, items: [] }
const TIMER = { unit: 'xpanel-cron-alice-backup.timer', activates: ['xpanel-cron-alice-backup.service'], next: at, last: null, owner: { kind: 'account-cron', username: 'alice', jobId: 'backup' } }
const timers = (items: unknown[] = [TIMER]) =>
  ({ observedAt: at, timers: read(items), cronDirectory: { state: 'read', reason: null, truncated: false, unlisted: 0, items: [{ name: 'e2scrub_all', kind: 'file' }] } })
const iface = (name: string, addresses: unknown[], loopback = false) => ({ name, operstate: 'UP', mtu: 1500, loopback, addresses })
const addr = (address: string, prefixLength = 24, scope = 'global') => ({ family: address.includes(':') ? 6 : 4, address, prefixLength, scope, dynamic: false })
const network = (interfaces: unknown = read([iface('lo', [addr('127.0.0.1', 8, 'host')], true), iface('eth0', [addr('192.0.2.10'), addr('192.0.2.99'), addr('2001:db8::10', 64), addr('fe80::1', 64, 'link')])])) => ({
  observedAt: at, hostname: { state: 'read', reason: null, value: 'web1' }, resolvers: { state: 'read', reason: null, value: ['192.0.2.53'], truncated: false }, interfaces,
  routes4: read([{ family: 4, destination: 'default', gateway: '192.0.2.1', device: 'eth0', protocol: 'dhcp', scope: null, source: null, metric: 100, type: null, nexthops: [] }]), routes6: off,
})
const role = () => ({ observedAt: at, services: read([{ id: 'nginx', label: 'nginx', unit: 'nginx.service', state: 'active' }, { id: 'apache', label: 'Apache', unit: null, state: 'not-installed' }]) })
const pool = (address: string, interfaceName = 'eth0', extra: Record<string, unknown> = {}) => ({ address, version: address.includes(':') ? 6 : 4, prefixLength: 24, interfaceName, role: 'shared', isPrimary: false, ...extra }) as NonNullable<ServerObservationSaved['ipPool']>[number]
const saved = (overrides: Partial<ServerObservationSaved> = {}): ServerObservationSaved => ({
  server: { settings: { hostname: 'web1.example.test', engine: 'apache', apacheMpm: 'itk' }, setupCompletedAt: '2026-10-01T00:00:00.000Z' },
  ipPool: [pool('192.0.2.10', 'eth0', { isPrimary: true }), pool('192.0.2.20'), pool('2001:0db8:0000::10', 'eth1')],
  accounts: [{}, {}], domains: [{ siteType: 'php', php: { version: '8.3' } }, { siteType: 'php', php: { version: '8.10' } }, { siteType: 'php', php: { version: '8.3' } }, { siteType: 'static', php: { version: '8.2' } }],
  serviceUsers: [{ services: { email: true } }, { services: { email: false } }], databases: [{ trashedAt: null }, { trashedAt: '2026-10-02T00:00:00.000Z' }], zones: [{}], ...overrides,
})
const get = (path: string) => new Request('http://localhost' + path)
const call = (req: Request, helpers: ServerObservationWorkspaceHelpers) => handleServerObservationWorkspaceRoute(req, new URL(req.url), req.method, helpers)
const helpers = (overrides: Partial<ServerObservationWorkspaceHelpers> = {}) => {
  const events: string[] = []
  const hosts: Record<string, unknown> = { '/host/server/timers': timers(), '/host/server/network': network(), '/host/server/role': role() }
  const value: ServerObservationWorkspaceHelpers = {
    requireCaller: vi.fn(async () => { events.push('auth'); return root }), assertRoot: vi.fn(async (_caller, action: string) => { events.push('root:' + action) }),
    readHost: vi.fn(async (_caller, path: string) => { events.push('agent:' + path); return hosts[path] }), readSaved: vi.fn(async () => { events.push('saved'); return saved() }),
    now: () => new Date(at), ...overrides,
  }
  return { value, events }
}

describe('API server observation workspace', () => {
  it('accepts the saved state snapshot as its saved input', () => {
    expectTypeOf<StateSnapshot>().toExtend<ServerObservationSaved>()
  })
  it('leaves unrelated routes untouched', async () => {
    const { value } = helpers()
    expect(await call(get('/api/server/mail-queue'), value)).toBeNull()
    expect(value.requireCaller).not.toHaveBeenCalled()
  })
  it('authorizes root before and after the host read and returns no-store projections', async () => {
    const { value, events } = helpers()
    const response = (await call(get('/api/server/server-observation/timers'), value))!
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.json()).timers.items[0].owner).toEqual({ kind: 'account-cron', username: 'alice', jobId: 'backup' })
    expect(events).toEqual(['auth', 'root:server.server-observation.read', 'agent:/host/server/timers', 'auth', 'root:server.server-observation.read'])
    expect(value.readSaved).not.toHaveBeenCalled()
  })
  it('returns 403 for non-root callers before contacting the agent', async () => {
    const { value } = helpers({ assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN', status: 403 }) } })
    for (const path of ['timers', 'network', 'role']) await expect(call(get('/api/server/server-observation/' + path), value)).rejects.toMatchObject({ status: 403 })
    expect(value.readHost).not.toHaveBeenCalled(); expect(value.readSaved).not.toHaveBeenCalled()
  })
  it('refuses a response when authority changes during the read', async () => {
    let calls = 0
    const { value } = helpers({ requireCaller: async () => (++calls === 1 ? root : { principal: { kind: 'root', id: 'root-2', username: 'other' } } as AuthenticatedCaller) })
    await expect(call(get('/api/server/server-observation/role'), value)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('rejects selectors and non-GET methods with validation errors before the agent', async () => {
    const { value } = helpers()
    await expect(call(get('/api/server/server-observation/network?interface=eth0'), value)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect((await call(new Request('http://localhost/api/server/server-observation/timers', { method: 'POST', body: '{}' }), value))!.status).toBe(405)
    expect(value.readHost).not.toHaveBeenCalled()
  })
  it('keeps saved facts and reports observed sections unavailable without a host agent', async () => {
    const { value } = helpers({ readHost: undefined })
    expect(await (await call(get('/api/server/server-observation/timers'), value))!.json()).toMatchObject({ timers: { state: 'unavailable', reason: 'host_unavailable' }, cronDirectory: { state: 'unavailable' } })
    const networkBody = await (await call(get('/api/server/server-observation/network'), value))!.json()
    expect(networkBody).toMatchObject({ interfaces: { state: 'unavailable' }, hostnameComparison: 'unverified', unpooled: null, saved: { hostname: 'web1.example.test' } })
    expect(networkBody.pool.map((item: { status: string }) => item.status)).toEqual(['unverified', 'unverified', 'unverified'])
    const roleBody = await (await call(get('/api/server/server-observation/role'), value))!.json()
    expect(roleBody).toMatchObject({ services: { state: 'unavailable', reason: 'host_unavailable' }, saved: { state: 'read', engine: 'apache' } })
  })
  it('refuses inconsistent or malformed host observations', () => {
    for (const bad of [{ ...timers(), observedAt: 'now' }, timers([{ ...TIMER, owner: { kind: 'system' } }]), timers([{ unit: 'a.service', activates: [], next: null, last: null, owner: { kind: 'system' } }]),
      timers([{ unit: 'a.timer', activates: [], next: null, last: null, owner: { kind: 'system' } }, { unit: 'a.timer', activates: [], next: null, last: null, owner: { kind: 'system' } }]),
      { ...timers(), timers: { ...off, items: [{}] } }, { ...timers(), timers: { ...read([]), reason: 'command_failed' } }, { ...timers(), cronDirectory: { state: 'absent', reason: null, truncated: false, unlisted: 1, items: [] } },
      { ...timers(), cronDirectory: { state: 'read', reason: null, truncated: false, unlisted: 0, items: [{ name: '../x', kind: 'file' }] } }]) expect(() => projectServerTimers(bad)).toThrow()
    for (const bad of [network(read([iface('eth0', [addr('192.0.2.10', 33)])])), network(read([iface('eth 0', [])])), network(read([iface('eth0', []), iface('eth0', [])])), network(read([iface('eth0', [{ ...addr('192.0.2.1'), family: 6 }])])),
      { ...network(), hostname: { state: 'read', reason: null, value: 'bad name' } }, { ...network(), hostname: { state: 'absent', reason: null, value: 'web1' } }, { ...network(), resolvers: { state: 'read', reason: null, value: ['dns.example'], truncated: false } },
      { ...network(), routes4: read([{ ...network().routes4.items[0], family: 6 }]) }, { ...network(), routes6: { ...off, reason: 'secret' } }]) expect(() => projectServerNetwork(bad)).toThrow()
    for (const bad of [{ ...role(), services: read([{ id: 'nginx', label: 'nginx', unit: 'nginx.service', state: 'running' }]) }, { ...role(), services: read([{ id: 'nginx', label: 'x', unit: null, state: 'active' }, { id: 'nginx', label: 'x', unit: null, state: 'active' }]) }])
      expect(() => projectServerRole(bad)).toThrow()
    expect(projectServerTimers({ ...timers(), extra: 'x', timers: { ...timers().timers, items: [{ ...TIMER, secret: 1 }] } })).toEqual(timers())
  })
  it('computes pool drift, unpooled addresses and hostname comparison', () => {
    const drift = compareServerNetwork(projectServerNetwork(network()), saved())
    expect(drift.hostnameComparison).toBe('short-name')
    expect(drift.pool.map(item => [item.address, item.status, item.observedInterface])).toEqual([['192.0.2.10', 'configured', 'eth0'], ['192.0.2.20', 'missing', null], ['2001:0db8:0000::10', 'other-interface', 'eth0']])
    expect(drift.unpooled).toEqual([{ address: '192.0.2.99', family: 4, prefixLength: 24, interface: 'eth0' }])
    expect(compareServerNetwork(projectServerNetwork({ ...network(), hostname: { state: 'read', reason: null, value: 'WEB1.example.test' } }), saved()).hostnameComparison).toBe('match')
    expect(compareServerNetwork(projectServerNetwork({ ...network(), hostname: { state: 'read', reason: null, value: 'mail2' } }), saved()).hostnameComparison).toBe('differs')
    expect(compareServerNetwork(projectServerNetwork(network()), saved({ server: null, ipPool: undefined }))).toEqual({ saved: { state: 'not-set-up', hostname: null }, hostnameComparison: 'unverified', pool: [], unpooled: [
      { address: '192.0.2.10', family: 4, prefixLength: 24, interface: 'eth0' }, { address: '192.0.2.99', family: 4, prefixLength: 24, interface: 'eth0' }, { address: '2001:db8::10', family: 6, prefixLength: 64, interface: 'eth0' }] })
  })
  it('summarizes the saved role apart from observed services', async () => {
    expect(summarizeServerRole(saved())).toEqual({
      saved: { state: 'read', hostname: 'web1.example.test', engine: 'apache', apacheMpm: 'itk', setupCompletedAt: '2026-10-01T00:00:00.000Z', phpVersions: ['8.3', '8.10'], counts: { accounts: 2, domains: 4, phpDomains: 3, mailboxes: 1, databases: 1, zones: 1 } },
      components: [
        { id: 'web-edge', value: 'nginx', count: null, services: ['nginx'] }, { id: 'web-backend', value: 'apache mpm-itk', count: null, services: ['apache'] },
        { id: 'php', value: '8.3, 8.10', count: 3, services: ['php-fpm'] }, { id: 'mail', value: null, count: 1, services: ['postfix', 'dovecot', 'opendkim'] },
        { id: 'dns', value: null, count: 1, services: ['pdns'] }, { id: 'database', value: 'mariadb', count: 1, services: ['mariadb'] },
      ],
    })
    const ols = summarizeServerRole(saved({ server: { settings: { hostname: 'h.example.test', engine: 'openlitespeed', apacheMpm: 'itk' }, setupCompletedAt: null } }))
    expect(ols.components[1]).toEqual({ id: 'web-backend', value: 'openlitespeed', count: null, services: [] })
    expect(ols.saved.apacheMpm).toBeNull()
    expect(summarizeServerRole(saved({ server: null })).saved).toMatchObject({ state: 'not-set-up', engine: null, hostname: null })
    const { value } = helpers()
    const body = await (await call(get('/api/server/server-observation/role'), value))!.json()
    expect(body.services.items[0]).toEqual({ id: 'nginx', label: 'nginx', unit: 'nginx.service', state: 'active' })
    expect(body.components[0].id).toBe('web-edge')
  })
  it('propagates agent refusals without inventing observations', async () => {
    const refused = Object.assign(new Error('refused'), { code: 'PRECONDITION_FAILED' })
    const { value } = helpers({ readHost: async () => { throw refused } })
    await expect(call(get('/api/server/server-observation/network'), value)).rejects.toBe(refused)
  })
})
