import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleMailLogWorkspaceRoute, handleMailTrackDeliveryRoute } from './mail-log-workspace.ts'

const root = { principal: { kind: 'root', id: 'fixture-root', username: 'root' } } as AuthenticatedCaller
const mailboxCaller = { principal: { kind: 'user', id: 'fixture-mailbox', username: 'mbx0123' } } as AuthenticatedCaller
const now = () => new Date('2026-10-27T12:00:30.700Z')
const serverBody = () => ({ scope: 'server', state: 'read', observedAt: '2026-10-27T12:00:31.000Z', window: { since: '2026-10-26T12:00:30Z', until: '2026-10-27T12:00:30Z' }, limit: 20000, lineLimitReached: false, counts: { records: 1, events: 1, skipped: 0, unparsed: 0, untrusted: 0 }, summary: { messages: 1 }, filters: {}, matched: 1, messages: [{ queueId: 'ABCDEF1234' }], omittedMessages: 0 })
const mailboxBody = (mailbox = 'alice@example.com') => ({ scope: 'mailbox', mailbox, state: 'read', observedAt: '2026-10-27T12:00:31.000Z', window: {}, complete: true, messages: [], omittedMessages: 0 })
const get = (path: string, method = 'GET') => { const url = new URL('http://localhost' + path); return [new Request(url, { method }), url, method] as const }

describe('root mail log workspace', () => {
  const helpers = (overrides: Record<string, unknown> = {}) => ({ requireCaller: vi.fn(async () => root), assertRoot: vi.fn(async () => {}), readServerLog: vi.fn(async (_caller: AuthenticatedCaller, _query: string) => serverBody()), now, ...overrides })
  it('authorizes root, defaults to the latest 24 hours and returns the delivery report without monitor aggregates', async () => {
    const h = helpers()
    const response = await handleMailLogWorkspaceRoute(...get('/api/server/mail-log/delivery'), h)
    expect(h.assertRoot).toHaveBeenCalledWith(root, 'server.mail-log.read')
    expect(h.readServerLog).toHaveBeenCalledWith(root, 'since=2026-10-26T12%3A00%3A30Z&until=2026-10-27T12%3A00%3A30Z')
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    const body = await response!.json() as Record<string, unknown>
    expect(body).toMatchObject({ scope: 'server', state: 'read', matched: 1, messages: [{ queueId: 'ABCDEF1234' }] })
    expect(body).not.toHaveProperty('summary')
  })
  it('forwards normalized filters and the requested window', async () => {
    const h = helpers()
    await handleMailLogWorkspaceRoute(...get('/api/server/mail-log/delivery?since=2026-10-27T00:00:00Z&until=2026-10-27T06:00:00Z&sender=Alice%40Example.com&status=bounced&dsn=5.1&domain=Example.org'), h)
    expect(new URLSearchParams(h.readServerLog.mock.calls[0]![1] as string).toString()).toBe('since=2026-10-27T00%3A00%3A00Z&until=2026-10-27T06%3A00%3A00Z&sender=alice%40example.com&domain=example.org&status=bounced&dsn=5.1')
  })
  it('returns monitor aggregates without message rows', async () => {
    const body = await (await handleMailLogWorkspaceRoute(...get('/api/server/mail-log/monitor'), helpers()))!.json() as Record<string, unknown>
    expect(body).toMatchObject({ scope: 'server', summary: { messages: 1 }, counts: { records: 1 } })
    expect(body).not.toHaveProperty('messages')
  })
  it('refuses a non-root caller with 403 before any host read', async () => {
    const h = helpers({ assertRoot: vi.fn(async () => fail('FORBIDDEN', 'root role is required')) })
    await expect(handleMailLogWorkspaceRoute(...get('/api/server/mail-log/delivery'), h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.readServerLog).not.toHaveBeenCalled()
  })
  it.each([
    '/api/server/mail-log/delivery?unit=sshd', '/api/server/mail-log/delivery?since=2026-10-27T00:00:00Z', '/api/server/mail-log/delivery?since=2026-10-01T00:00:00Z&until=2026-10-27T00:00:00Z',
    '/api/server/mail-log/delivery?since=2026-10-27T00:00:00.000Z&until=2026-10-27T01:00:00Z', '/api/server/mail-log/delivery?status=ok', '/api/server/mail-log/delivery?sender=a&sender=b',
    '/api/server/mail-log/delivery?limit=5', '/api/server/mail-log/monitor?sender=a', '/api/server/mail-log/delivery?sender=%3Cscript%3E',
  ])('refuses %s with 422 before any host read', async path => {
    const h = helpers()
    await expect(handleMailLogWorkspaceRoute(...get(path), h)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(h.readServerLog).not.toHaveBeenCalled()
  })
  it('serves only GET, ignores unrelated paths and refuses an unverifiable host body', async () => {
    const h = helpers({ readServerLog: vi.fn(async () => ({ scope: 'mailbox', state: 'read', messages: [] })) })
    expect(await handleMailLogWorkspaceRoute(...get('/api/server/mail-queue'), h)).toBeNull()
    expect((await handleMailLogWorkspaceRoute(...get('/api/server/mail-log/delivery', 'POST'), h))!.status).toBe(405)
    await expect(handleMailLogWorkspaceRoute(...get('/api/server/mail-log/delivery'), h)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
})

describe('xMail track delivery route', () => {
  const helpers = (overrides: Record<string, unknown> = {}) => ({ openMailbox: vi.fn(async () => ({ caller: mailboxCaller, mailbox: 'Alice@Example.com' })), readMailboxLog: vi.fn(async () => mailboxBody()), now, ...overrides })
  it('derives the address only from the sealed mailbox session and re-checks it after the read', async () => {
    const h = helpers()
    const response = await handleMailTrackDeliveryRoute(...get('/api/webmail/track-delivery?since=2026-10-27T00:00:00Z&until=2026-10-27T06:00:00Z'), h)
    expect(h.readMailboxLog).toHaveBeenCalledWith(mailboxCaller, 'address=alice%40example.com&since=2026-10-27T00%3A00%3A00Z&until=2026-10-27T06%3A00%3A00Z')
    expect(h.openMailbox).toHaveBeenCalledTimes(2)
    expect(await response!.json()).toMatchObject({ scope: 'mailbox', mailbox: 'alice@example.com' })
  })
  it('refuses a caller without a sealed mailbox with 403 and no host read', async () => {
    const h = helpers({ openMailbox: vi.fn(async () => fail('FORBIDDEN', 'a signed-in sealed mailbox is required')) })
    await expect(handleMailTrackDeliveryRoute(...get('/api/webmail/track-delivery'), h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.readMailboxLog).not.toHaveBeenCalled()
  })
  it.each(['?address=bob@example.com', '?mailbox=bob@example.com', '?sender=bob', '?since=2026-10-27T00:00:00Z', '?since=2026-10-01T00:00:00Z&until=2026-10-27T00:00:00Z'])('refuses %s with 422', async query => {
    const h = helpers()
    await expect(handleMailTrackDeliveryRoute(...get('/api/webmail/track-delivery' + query), h)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(h.readMailboxLog).not.toHaveBeenCalled()
  })
  it('refuses a host body for another mailbox or a session that changed during the read', async () => {
    await expect(handleMailTrackDeliveryRoute(...get('/api/webmail/track-delivery'), helpers({ readMailboxLog: vi.fn(async () => mailboxBody('bob@example.com')) }))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    let n = 0
    const changed = helpers({ openMailbox: vi.fn(async () => ({ caller: mailboxCaller, mailbox: n++ ? 'bob@example.com' : 'alice@example.com' })) })
    await expect(handleMailTrackDeliveryRoute(...get('/api/webmail/track-delivery'), changed)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await handleMailTrackDeliveryRoute(...get('/api/webmail/track-delivery', 'POST'), helpers()))!.status).toBe(405)
    expect(await handleMailTrackDeliveryRoute(...get('/api/webmail/search'), helpers())).toBeNull()
  })
})
