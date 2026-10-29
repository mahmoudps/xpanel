import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleFtpLogWorkspaceRoute } from './ftp-log-workspace.ts'

const root = { principal: { kind: 'root', id: 'fixture-root', username: 'root' } } as AuthenticatedCaller
const now = () => new Date('2026-10-27T12:00:30.700Z')
const body = () => ({ scope: 'server', state: 'read', observedAt: '2026-10-27T12:00:31.000Z', window: { since: '2026-10-26T12:00:30Z', until: '2026-10-27T12:00:30Z' }, limit: 20000, lineLimitReached: false, accountMapping: 'read', counts: { records: 1, events: 1, skipped: 0, unparsed: 0, untrusted: 0 }, summary: { events: 1 }, filters: {}, matched: 1, matchedSummary: null, events: [{ kind: 'connect' }], omittedEvents: 0 })
const get = (path: string, method = 'GET') => { const url = new URL('http://localhost' + path); return [new Request(url, { method }), url, method] as const }
const helpers = (overrides: Record<string, unknown> = {}) => ({ requireCaller: vi.fn(async () => root), assertRoot: vi.fn(async () => {}), readActivity: vi.fn(async (_caller: AuthenticatedCaller, _query: string) => body()), now, ...overrides })

describe('root FTP log workspace', () => {
  it('authorizes root, defaults to the latest 24 hours and returns the verified observation', async () => {
    const h = helpers()
    const response = await handleFtpLogWorkspaceRoute(...get('/api/server/ftp-log/activity'), h)
    expect(h.assertRoot).toHaveBeenCalledWith(root, 'server.ftp-log.read')
    expect(h.readActivity).toHaveBeenCalledWith(root, 'since=2026-10-26T12%3A00%3A30Z&until=2026-10-27T12%3A00%3A30Z')
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    expect(await response!.json()).toMatchObject({ scope: 'server', state: 'read', matched: 1, events: [{ kind: 'connect' }] })
  })
  it('forwards normalized filters and the requested window', async () => {
    const h = helpers()
    await handleFtpLogWorkspaceRoute(...get('/api/server/ftp-log/activity?since=2026-10-27T00:00:00Z&until=2026-10-27T06:00:00Z&user=bob%40example.com&client=2001:DB8::1&kind=upload&text=%20Public_html'), h)
    expect(h.readActivity.mock.calls[0]![1]).toBe('since=2026-10-27T00%3A00%3A00Z&until=2026-10-27T06%3A00%3A00Z&user=bob%40example.com&client=2001%3Adb8%3A%3A1&kind=upload&text=public_html')
  })
  it('refuses a non-root caller with 403 before any host read', async () => {
    const h = helpers({ assertRoot: vi.fn(async () => fail('FORBIDDEN', 'root role is required')) })
    await expect(handleFtpLogWorkspaceRoute(...get('/api/server/ftp-log/activity'), h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.readActivity).not.toHaveBeenCalled()
  })
  it.each([
    '?unit=sshd', '?limit=5', '?since=2026-10-27T00:00:00Z', '?since=2026-10-01T00:00:00Z&until=2026-10-27T00:00:00Z', '?since=2026-10-27T00:00:00.000Z&until=2026-10-27T01:00:00Z',
    '?kind=all', '?user=a&user=b', '?client=a%2Fb', '?text=%20%20', '?user=a%00b',
  ])('refuses %s with 422 before any host read', async query => {
    const h = helpers()
    await expect(handleFtpLogWorkspaceRoute(...get('/api/server/ftp-log/activity' + query), h)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(h.readActivity).not.toHaveBeenCalled()
  })
  it('serves only GET, ignores unrelated paths and refuses an unverifiable host body', async () => {
    expect(await handleFtpLogWorkspaceRoute(...get('/api/server/mail-log/delivery'), helpers())).toBeNull()
    expect((await handleFtpLogWorkspaceRoute(...get('/api/server/ftp-log/activity', 'POST'), helpers()))!.status).toBe(405)
    for (const bad of [{ ...body(), scope: 'mailbox' }, { ...body(), state: 'ok' }, { ...body(), events: null }, { ...body(), summary: [] }, null]) {
      await expect(handleFtpLogWorkspaceRoute(...get('/api/server/ftp-log/activity'), helpers({ readActivity: vi.fn(async () => bad) }))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    }
  })
})
