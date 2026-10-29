import { describe, expect, it, vi } from 'vitest'
import { handleServiceDetailRoute } from './service-detail-routes.ts'
import type { ServiceDetailRouteContext } from './service-detail-routes.ts'
import type { ServiceDetailHost } from './service-detail.ts'

const now = () => new Date('2026-10-27T10:00:00Z')
const call = (path: string, ctx: ServiceDetailRouteContext, method = 'GET') => { const req = new Request('http://agent.local' + path, { method }); return handleServiceDetailRoute(req, new URL(req.url), req.method, ctx) }
const context = (overrides: Partial<ServiceDetailRouteContext> = {}) => {
  const commands: string[][] = []
  const host: ServiceDetailHost = {
    run: vi.fn(async (argv: string[]) => { commands.push(argv); return argv[0] === '/usr/bin/pdnsutil' ? { ok: true, code: 0, stdout: "Checked 4 records of 'example.com', 0 errors, 0 warnings.\n", stderr: '' } : { ok: true, code: 0, stdout: 'loaded\nactive\n', stderr: '' } }),
    readFile: vi.fn(async () => null), stat: vi.fn(async () => ({ kind: 'missing' as const, sizeBytes: 0 })), listDirectory: vi.fn(async () => ({ state: 'missing' as const, entries: [], truncated: false })),
  }
  const ctx: ServiceDetailRouteContext = { host, now, assertRoot: vi.fn(async () => ({ actor: 'root' })),
    readState: vi.fn(async () => ({ zones: [{ name: 'example.com', serial: 1 }], serviceUsers: [], server: { settings: { hostname: 'panel.example.test' } } })), ...overrides }
  return { ctx, host, commands }
}

describe('agent service detail routes', () => {
  it('ignores unrelated paths without authorizing', async () => {
    const { ctx } = context()
    for (const path of ['/host/services', '/host/services/pdns/restart', '/host/services/detail', '/host/services/detail/mail', '/host/services/detail/dns/extra']) expect(await call(path, ctx)).toBeNull()
    expect(ctx.assertRoot).not.toHaveBeenCalled()
  })
  it('serves each detail to root with no-store', async () => {
    const { ctx } = context()
    for (const kind of ['dns', 'ftp', 'certificates']) {
      const response = (await call('/host/services/detail/' + kind, ctx))!
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({ kind, observedAt: '2026-10-27T10:00:00.000Z' })
    }
    expect(ctx.assertRoot).toHaveBeenCalledWith('host.services.detail')
  })
  it('refuses non-root callers before touching the host', async () => {
    const { ctx, host } = context({ assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' }) } })
    await expect(call('/host/services/detail/dns', ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('/host/services/detail/dns/zone-check?zone=example.com', ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(host.run).not.toHaveBeenCalled(); expect(ctx.readState).not.toHaveBeenCalled()
  })
  it('rejects methods, selectors and a missing host executor', async () => {
    const { ctx, host } = context()
    expect((await call('/host/services/detail/ftp', ctx, 'POST'))!.headers.get('allow')).toBe('GET')
    await expect(call('/host/services/detail/dns?zone=example.com', ctx)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    await expect(call('/host/services/detail/certificates?', ctx)).resolves.toBeTruthy()
    await expect(call('/host/services/detail/certificates?path=/etc/shadow', ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/host/services/detail/dns', { ...ctx, host: null })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(host.readFile).not.toHaveBeenCalledWith('/etc/shadow')
  })
  it.each(['', '?zone=', '?zone=Example.com', '?zone=example.com.', '?zone=--help', '?zone=example.com&zone=other.net', '?zone=example.com&verbose=1', '?name=example.com'])('rejects zone-check grammar %s before running pdnsutil', async query => {
    const { ctx, commands } = context()
    await expect(call('/host/services/detail/dns/zone-check' + query, ctx)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(commands).toEqual([])
  })
  it('checks only zones rendered from saved state', async () => {
    const { ctx, commands } = context()
    const body = await (await call('/host/services/detail/dns/zone-check?zone=example.com', ctx))!.json()
    expect(body).toMatchObject({ zone: 'example.com', state: 'passed', records: 4, errors: 0 })
    expect(commands).toEqual([['/usr/bin/pdnsutil', 'check-zone', 'example.com']])
    expect(ctx.assertRoot).toHaveBeenCalledWith('host.services.dns.check')
    await expect(call('/host/services/detail/dns/zone-check?zone=other.net', ctx)).rejects.toMatchObject({ code: 'NOT_FOUND', detail: { stateChanged: false } })
    await expect(call('/host/services/detail/dns/zone-check?zone=example.com', { ...ctx, readState: async () => { throw new Error('locked') } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(commands).toHaveLength(1)
  })
})
