import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleWhmLogToolsRoute } from './whm-log-tools-workspace.ts'
import type { WhmLogToolsHelpers } from './whm-log-tools-workspace.ts'

const caller = { principal: { id: 'p', kind: 'root', username: 'root' } } as unknown as AuthenticatedCaller
const helpers = (over: Partial<WhmLogToolsHelpers> = {}): WhmLogToolsHelpers => ({
  requireCaller: async () => caller, assertRoot: vi.fn(async () => undefined), readHost: vi.fn(async () => ({ state: 'read' })),
  callAgent: vi.fn(async () => new Response(new Uint8Array([31, 139]), { headers: { 'content-disposition': 'attachment; filename="example.com.ftp.log.gz"' } })),
  emitAudit: vi.fn(async () => undefined), now: () => new Date('2026-11-07T12:00:00.500Z'), ...over,
})
const call = (path: string, ports: WhmLogToolsHelpers, method = 'GET') => { const url = new URL('https://panel' + path); return handleWhmLogToolsRoute(new Request(url, { method }), url, method, ports) }
const id = '11111111-1111-4111-8111-111111111111'

describe('WHM log tools', () => {
  it('leaves other paths alone and requires root before anything else', async () => {
    expect(await call('/api/server/logs/retention', helpers())).toBeNull()
    const refused = helpers({ assertRoot: async () => { throw new Error('denied') } })
    await expect(call('/api/server/logs/database?log=slow', refused)).rejects.toThrow('denied')
    expect(refused.readHost).not.toHaveBeenCalled()
  })
  it('forwards only validated selectors', async () => {
    const ports = helpers()
    await call('/api/server/logs/security-analysis?domainId=' + id, ports)
    await call('/api/server/logs/database?log=error', ports)
    expect(vi.mocked(ports.readHost).mock.calls.map(row => row[1])).toEqual(['/host/logs/security-analysis?domainId=' + id, '/host/logs/database?log=error'])
    for (const path of ['/api/server/logs/security-analysis?domainId=x', '/api/server/logs/security-analysis?domainId=' + id + '&x=1', '/api/server/logs/database?log=general', '/api/server/ftp-log/raw?domain=a.test&hours=5', '/api/server/ftp-log/raw?domain=A%20B&hours=24'])
      await expect(call(path, ports), path).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call('/api/server/logs/database?log=slow', ports, 'POST'))!.status).toBe(405)
  })
  it('streams the gzip for a whole-second window and audits the download', async () => {
    const ports = helpers(), response = await call('/api/server/ftp-log/raw?domain=example.com&hours=24', ports)
    expect(response!.headers.get('content-type')).toBe('application/gzip')
    expect(vi.mocked(ports.callAgent).mock.calls[0]![1]).toBe('/host/ftp/log/raw?domain=example.com&since=2026-11-06T12%3A00%3A00Z&until=2026-11-07T12%3A00%3A00Z')
    expect(vi.mocked(ports.emitAudit).mock.calls[0]![0]).toMatchObject({ action: 'server.ftp-log.raw_downloaded', target: 'domain:example.com' })
  })
  it('relays SERVICE_DISABLED and audits nothing on a refusal', async () => {
    const ports = helpers({ callAgent: async () => Response.json({ code: 'SERVICE_DISABLED' }, { status: 409 }) })
    await expect(call('/api/server/ftp-log/raw?domain=example.com&hours=1', ports)).rejects.toMatchObject({ code: 'SERVICE_DISABLED' })
    expect(ports.emitAudit).not.toHaveBeenCalled()
  })
})
