import { describe, expect, it, vi } from 'vitest'
import { handleServerObservationRoute } from './server-observation-routes.ts'
import type { ServerObservationRouteContext } from './server-observation-routes.ts'

const call = (req: Request, ctx: ServerObservationRouteContext) => handleServerObservationRoute(req, new URL(req.url), req.method, ctx)
const get = (path: string) => new Request('http://agent.local' + path)
const context = (overrides: Partial<ServerObservationRouteContext> = {}) => {
  const events: string[] = []
  const ctx: ServerObservationRouteContext = {
    assertRoot: vi.fn(async (action: string) => { events.push('root:' + action); return { actor: 'root' } }),
    run: vi.fn(async (argv: string[]) => { events.push(argv.join(' ')); return { ok: true, code: 0, stdout: argv[1] === 'show' ? 'loaded\nactive\n' : '[]', stderr: '' } }),
    readFile: vi.fn(async (path: string) => { events.push('read:' + path); return path === '/etc/hostname' ? 'web1\n' : 'nameserver 192.0.2.53\n' }),
    readCronDirectory: vi.fn(async () => { events.push('readdir'); return [] }),
    now: () => new Date('2026-10-27T10:00:00Z'), ...overrides,
  }
  return { ctx, events }
}

describe('agent server observation routes', () => {
  it('ignores unrelated paths without authorizing', async () => {
    const { ctx } = context()
    expect(await call(get('/host/server/ips'), ctx)).toBeNull()
    expect(ctx.assertRoot).not.toHaveBeenCalled()
  })
  it('authorizes before and after each read and returns no-store observations', async () => {
    const { ctx, events } = context()
    const response = (await call(get('/host/server/timers'), ctx))!
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ timers: { state: 'read', items: [] }, cronDirectory: { state: 'read', items: [] } })
    expect(events[0]).toBe('root:server.timers.read')
    expect(events.at(-1)).toBe('root:server.timers.read')
    const network = await (await call(get('/host/server/network'), ctx))!.json()
    expect(network).toMatchObject({ hostname: { value: 'web1' }, resolvers: { value: ['192.0.2.53'] }, interfaces: { state: 'read' } })
    const role = await (await call(get('/host/server/role'), ctx))!.json() as { services: { items: { id: string }[] } }
    expect(role.services.items.find(item => item.id === 'nginx')).toMatchObject({ state: 'active' })
    expect(ctx.assertRoot).toHaveBeenCalledWith('server.role.read')
  })
  it('refuses non-root callers before any host read', async () => {
    const { ctx, events } = context({ assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' }) } })
    for (const path of ['/host/server/timers', '/host/server/network', '/host/server/role']) await expect(call(get(path), ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(events).toEqual([])
  })
  it('withholds host facts when authority ends during the read', async () => {
    let calls = 0
    const { ctx } = context({ assertRoot: async () => { if (++calls > 1) throw new Error('authority changed'); return { actor: 'root' } } })
    await expect(call(get('/host/server/network'), ctx)).rejects.toThrow('authority changed')
  })
  it('rejects selectors, bodies and other methods before reading', async () => {
    const { ctx, events } = context()
    await expect(call(get('/host/server/timers?unit=x.timer'), ctx)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    await expect(call(new Request('http://agent.local/host/server/role', { method: 'POST', body: '{}' }), ctx).then(response => response!.status)).resolves.toBe(405)
    expect((await call(new Request('http://agent.local/host/server/role', { method: 'DELETE' }), ctx))!.headers.get('allow')).toBe('GET')
    expect(events.filter(event => !event.startsWith('root:'))).toEqual([])
  })
  it('reports every section unavailable without the native host executor', async () => {
    const { ctx } = context({ run: null, readFile: null, readCronDirectory: null })
    expect(await (await call(get('/host/server/timers'), ctx))!.json()).toMatchObject({ timers: { state: 'unavailable', reason: 'host_unavailable' }, cronDirectory: { state: 'unavailable', reason: 'host_unavailable' } })
    expect(await (await call(get('/host/server/network'), ctx))!.json()).toMatchObject({ hostname: { state: 'unavailable' }, resolvers: { state: 'unavailable' }, interfaces: { state: 'unavailable' }, routes4: { state: 'unavailable' }, routes6: { state: 'unavailable' } })
    expect(await (await call(get('/host/server/role'), ctx))!.json()).toMatchObject({ services: { state: 'unavailable', reason: 'host_unavailable' } })
  })
})
