import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleTrafficWorkspaceRoute, projectTrafficReport } from './traffic-workspace.ts'
const value = () => ({ scope: 'server', observedAt: '2026-10-27T12:00:00Z', interfaces: { state: 'unavailable', intervalMs: 0, skipped: 0, items: [] }, http: { state: 'unavailable', rows: [], accounts: [], readSites: 0, omittedRows: 0, omittedSites: 0, unavailableSites: 0, skippedLines: 0, truncated: false, from: null, to: null }, history: { state: 'unavailable', reason: 'network_counters_not_recorded' } })
const root = { principal: { kind: 'root', id: 'r', username: 'root' } } as AuthenticatedCaller
const helpers = () => ({ requireCaller: vi.fn(async () => root), assertRoot: vi.fn(async () => {}), readHost: vi.fn(async () => value()) })
describe('traffic API boundary', () => {
  it('strips unrelated host data and preserves unavailable state', () => { expect(projectTrafficReport({ ...value(), secret: 'not returned' })).toEqual(value()) })
  it('refuses made-up zero or unsafe interface data', () => { const v = value() as any; v.interfaces.items = [{ name: '<script>', state: 'read', receivedBps: 0, sentBps: 0 }]; expect(() => projectTrafficReport(v)).toThrow() })
  it('rejects incoherent sample intervals and invented network history', () => { const v = value() as any; v.interfaces.state = 'read'; expect(() => projectTrafficReport(v)).toThrow(); const h = value() as any; h.history.state = 'read'; expect(() => projectTrafficReport(h)).toThrow(); const times = value() as any; times.http.from = '2026-10-27T12:00:00Z'; expect(() => projectTrafficReport(times)).toThrow() })
  it('authorizes before read and rechecks after await', async () => { const h = helpers(), url = new URL('http://h/api/server/monitoring/traffic'); expect((await handleTrafficWorkspaceRoute(new Request(url), url, 'GET', h))!.status).toBe(200); expect(h.assertRoot).toHaveBeenCalledTimes(2); expect(h.readHost).toHaveBeenCalledTimes(1) })
  it('rejects selectors and unauthorized roots', async () => { const h = helpers(), url = new URL('http://h/api/server/monitoring/traffic?path=x'); await expect(handleTrafficWorkspaceRoute(new Request(url), url, 'GET', h)).rejects.toMatchObject({ code: 'VALIDATION' }); expect(h.readHost).not.toHaveBeenCalled(); h.assertRoot = vi.fn(async () => { throw new Error('denied') }); await expect(handleTrafficWorkspaceRoute(new Request(url), url, 'GET', h)).rejects.toThrow('denied') })
})
