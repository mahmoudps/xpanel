import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { sha256Hex } from './auth.ts'
import { accountAnnouncements, announcementPhase, audienceIncludes, handleAnnouncementsRoute, parseAnnouncementInput, readSavedAnnouncements } from './announcements-workspace.ts'
import type { Announcement, AnnouncementsHelpers } from './announcements-workspace.ts'
import { ACCOUNT_ANNOUNCEMENT_SEVERITY_LABELS } from '../../web/src/board-port/account-announcements-banner.ts'
import { ANNOUNCEMENT_SEVERITIES } from './announcements-workspace.ts'

const PLAN = '33333333-3333-4333-8333-333333333333', OTHER_PLAN = '44444444-4444-4444-8444-444444444444', RESELLER = '22222222-2222-4222-8222-222222222222'
const ALICE = { id: '55555555-5555-4555-8555-555555555555', username: 'alice', planId: PLAN, ownerId: RESELLER, status: 'active' }
const BOB = { id: '66666666-6666-4666-8666-666666666666', username: 'bob', planId: OTHER_PLAN, ownerId: null, status: 'active' }
const root = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 's1', apiTokenId: null } as unknown as AuthenticatedCaller
const reseller = { principal: { kind: 'reseller', id: RESELLER, username: 'res1' }, sessionId: 's2', apiTokenId: null } as unknown as AuthenticatedCaller
const owner = (account: typeof ALICE | typeof BOB) => ({ principal: { kind: 'user', id: 'p-' + account.username, username: account.username, accountId: account.id }, sessionId: 'u-' + account.username, apiTokenId: null, scopes: [] }) as unknown as AuthenticatedCaller
const NOW = new Date('2026-10-27T12:00:00.000Z')
const EMPTY = sha256Hex('null')
const ROUTE = '/api/server/announcements', MINE = '/api/account/announcements'
const input = (overrides: Record<string, unknown> = {}) => ({
  title: { en: 'Planned maintenance', ar: 'صيانة مجدولة' }, body: { en: 'Mail restarts at 22:00 UTC.\nExpect 5 minutes.', ar: 'يُعاد تشغيل البريد الساعة 22:00 UTC.' },
  severity: 'maintenance', audience: { kind: 'all' }, startsAt: null, endsAt: null, expectedRevision: EMPTY, ...overrides,
})
const record = (overrides: Partial<Announcement> = {}): Announcement => ({
  id: '77777777-7777-4777-8777-777777777777', status: 'active', severity: 'info', title: { en: 'Hello', ar: 'مرحبًا' }, body: { en: 'Body', ar: 'نص' }, audience: { kind: 'all' },
  startsAt: null, endsAt: null, createdAt: '2026-10-26T10:00:00.000Z', createdBy: 'root', updatedAt: '2026-10-26T10:00:00.000Z', updatedBy: 'root', ...overrides,
})

const helpers = (initial: unknown = null, overrides: Partial<AnnouncementsHelpers> = {}, caller: AuthenticatedCaller = root) => {
  let saved: unknown = initial
  const dismissals = new Map<string, unknown>()
  const audits: Record<string, unknown>[] = []
  const accounts = [ALICE, BOB]
  const store = {
    getAccount: vi.fn(async (id: string) => accounts.find(account => account.id === id) ?? null),
    readSnapshot: vi.fn(async () => ({ plans: [{ id: PLAN, name: 'Starter' }, { id: OTHER_PLAN, name: 'Pro' }], resellers: [{ id: RESELLER, username: 'res1' }], accounts })),
  }
  const base = {
    store, requireCaller: vi.fn(async () => caller),
    assertRoot: vi.fn(async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required for this operation') }),
    emitAudit: vi.fn(async (entry: Record<string, unknown>) => { audits.push(entry) }),
    readSaved: vi.fn(async () => saved === null ? null : JSON.parse(JSON.stringify(saved))),
    writeSaved: vi.fn(async (value: unknown) => { saved = JSON.parse(JSON.stringify(value)); return value }),
    readDismissed: vi.fn(async (id: string) => dismissals.get(id) ?? null),
    writeDismissed: vi.fn(async (id: string, value: unknown) => { dismissals.set(id, value); return value }),
    now: () => NOW,
    ...overrides,
  } as unknown as AnnouncementsHelpers
  return { helpers: base, audits, saved: () => saved, dismissals }
}
const call = (method: string, h: AnnouncementsHelpers, path = ROUTE, body?: unknown, type = 'application/json') => {
  const url = new URL('http://localhost' + path)
  return handleAnnouncementsRoute(new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': type } }) }), url, method, h)
}
const read = async (response: Response | null) => { expect(response?.status).toBe(200); return await response!.json() as Record<string, unknown> & { revision: string; announcements: Record<string, unknown>[] } }

describe('announcement grammar', () => {
  it('accepts exactly the severities the web labels', () => {
    expect(Object.keys(ACCOUNT_ANNOUNCEMENT_SEVERITY_LABELS)).toEqual([...ANNOUNCEMENT_SEVERITIES])
  })

  it('normalizes bilingual plain text and validates every field strictly', () => {
    const parsed = parseAnnouncementInput(input({ title: { en: '  Planned maintenance ', ar: 'صيانة مجدولة' }, body: { en: 'Line one\r\nLine two', ar: 'نص' } }))
    expect(parsed.title.en).toBe('Planned maintenance')
    expect(parsed.body.en).toBe('Line one\nLine two')
    for (const bad of [
      input({ title: { en: 'Only English' } }),
      input({ title: { en: '<b>bold</b>', ar: 'نص' } }),
      input({ title: { en: 'Two\nlines', ar: 'نص' } }),
      input({ title: { en: 'x'.repeat(141), ar: 'نص' } }),
      input({ body: { en: 'x'.repeat(2001), ar: 'نص' } }),
      input({ body: { en: 'tab\there', ar: 'نص' } }),
      input({ body: { en: 'override \u202E text', ar: 'نص' } }),
      input({ body: { en: '   ', ar: 'نص' } }),
      input({ severity: 'critical' }),
      input({ audience: { kind: 'plan', planId: 'not-a-uuid' } }),
      input({ audience: { kind: 'accounts', usernames: [] } }),
      input({ audience: { kind: 'accounts', usernames: ['alice', 'alice'] } }),
      input({ audience: { kind: 'accounts', usernames: ['Alice'] } }),
      input({ audience: { kind: 'accounts', usernames: Array.from({ length: 101 }, (_, i) => 'user' + i) } }),
      input({ audience: { kind: 'all', planId: PLAN } }),
      input({ startsAt: '2026-11-01 09:00' }),
      input({ startsAt: '2026-02-30T09:00:00.000Z' }),
      input({ startsAt: '2026-11-02T09:00:00.000Z', endsAt: '2026-11-01T09:00:00.000Z' }),
      input({ expectedRevision: 'abc' }),
      input({ html: true }),
      { ...input(), endsAt: undefined },
    ]) expect(() => parseAnnouncementInput(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(parseAnnouncementInput(input({ title: { en: 'x'.repeat(140), ar: 'ع'.repeat(140) } })).title.ar).toHaveLength(140)
  })

  it('reads a saved file strictly and reports anything else as unreadable', () => {
    expect(readSavedAnnouncements(null)).toEqual([])
    expect(readSavedAnnouncements([record()])).toEqual([record()])
    expect(readSavedAnnouncements([record(), record()])).toBeNull()
    expect(readSavedAnnouncements([{ ...record(), extra: 1 }])).toBeNull()
    expect(readSavedAnnouncements([record({ title: { en: ' padded', ar: 'نص' } })])).toBeNull()
    expect(readSavedAnnouncements([record({ createdAt: 'yesterday' })])).toBeNull()
    expect(readSavedAnnouncements({ announcements: [] })).toBeNull()
    expect(readSavedAnnouncements(Array.from({ length: 51 }, (_, i) => record({ id: `77777777-7777-4777-8777-${String(i).padStart(12, '0')}` })))).toBeNull()
  })

  it('matches audiences and windows exactly', () => {
    expect(audienceIncludes({ kind: 'all' }, ALICE)).toBe(true)
    expect(audienceIncludes({ kind: 'plan', planId: PLAN }, ALICE)).toBe(true)
    expect(audienceIncludes({ kind: 'plan', planId: PLAN }, BOB)).toBe(false)
    expect(audienceIncludes({ kind: 'reseller', resellerId: RESELLER }, ALICE)).toBe(true)
    expect(audienceIncludes({ kind: 'reseller', resellerId: RESELLER }, BOB)).toBe(false)
    expect(audienceIncludes({ kind: 'accounts', usernames: ['bob'] }, BOB)).toBe(true)
    expect(audienceIncludes({ kind: 'accounts', usernames: ['bob'] }, ALICE)).toBe(false)
    const now = NOW.getTime()
    expect(announcementPhase(record({ startsAt: '2026-10-28T00:00:00.000Z' }), now)).toBe('scheduled')
    expect(announcementPhase(record({ startsAt: '2026-10-27T12:00:00.000Z', endsAt: '2026-10-27T12:00:00.001Z' }), now)).toBe('live')
    expect(announcementPhase(record({ endsAt: '2026-10-27T12:00:00.000Z' }), now)).toBe('ended')
    expect(announcementPhase(record({ status: 'archived' }), now)).toBe('archived')
    const visible = accountAnnouncements([record(), record({ id: '88888888-8888-4888-8888-888888888888', status: 'archived' })], ALICE, [], now)
    expect(visible).toEqual([{ id: record().id, severity: 'info', title: record().title, body: record().body, startsAt: null, endsAt: null }])
    expect(accountAnnouncements([record()], ALICE, [record().id], now)).toEqual([])
  })
})

describe('root announcement management', () => {
  it('leaves unrelated routes untouched', async () => {
    const { helpers: h } = helpers()
    expect(await call('GET', h, '/api/server/announcementsx')).toBeNull()
    expect(await call('GET', h, '/api/server/panel/notifications')).toBeNull()
    expect(h.requireCaller).not.toHaveBeenCalled()
  })

  it('reads defaults with plan and reseller choices and no-store', async () => {
    const { helpers: h } = helpers()
    const response = (await call('GET', h))!
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await read(response)).toEqual({ state: 'default', revision: EMPTY, announcements: [], choices: { plans: [{ id: PLAN, name: 'Starter' }, { id: OTHER_PLAN, name: 'Pro' }], resellers: [{ id: RESELLER, username: 'res1' }] } })
  })

  it('creates, edits and archives under the observed revision with re-read and audit', async () => {
    const { helpers: h, audits, saved } = helpers()
    const created = await read(await call('POST', h, ROUTE, input({ audience: { kind: 'plan', planId: PLAN }, endsAt: '2026-10-30T18:00:00.000Z' })))
    expect(created.state).toBe('saved')
    expect(created.revision).toBe(sha256Hex(JSON.stringify(saved())))
    const id = created.changed as string
    expect(created.announcements).toEqual([expect.objectContaining({ id, status: 'active', phase: 'live', severity: 'maintenance', audience: { kind: 'plan', planId: PLAN }, createdBy: 'root', updatedAt: NOW.toISOString() })])
    await expect(call('POST', h, ROUTE, input())).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    const edited = await read(await call('PUT', h, ROUTE + '/' + id, input({ severity: 'warning', startsAt: '2026-11-01T09:00:00.000Z', expectedRevision: created.revision })))
    expect(edited.announcements[0]).toMatchObject({ id, severity: 'warning', phase: 'scheduled', audience: { kind: 'all' } })
    const archived = await read(await call('POST', h, ROUTE + '/' + id + '/archive', { expectedRevision: edited.revision }))
    expect(archived.announcements[0]).toMatchObject({ id, status: 'archived', phase: 'archived', severity: 'warning' })
    await expect(call('PUT', h, ROUTE + '/' + id, input({ expectedRevision: archived.revision }))).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(audits.map(entry => entry.action)).toEqual(['server.announcement.created', 'server.announcement.updated', 'server.announcement.archived'])
    expect(audits[0]).toMatchObject({ target: 'announcement:' + id, detail: { severity: 'maintenance', audience: 'plan', startsAt: null, endsAt: '2026-10-30T18:00:00.000Z' } })
  })

  it('validates audiences against saved state and refuses past windows before writing', async () => {
    const { helpers: h } = helpers()
    await expect(call('POST', h, ROUTE, input({ audience: { kind: 'plan', planId: '99999999-9999-4999-8999-999999999999' } }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('POST', h, ROUTE, input({ audience: { kind: 'reseller', resellerId: '99999999-9999-4999-8999-999999999999' } }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('POST', h, ROUTE, input({ audience: { kind: 'accounts', usernames: ['alice', 'ghost'] } }))).rejects.toMatchObject({ code: 'VALIDATION', detail: { missing: ['ghost'] } })
    await expect(call('POST', h, ROUTE, input({ endsAt: '2026-10-27T11:59:00.000Z' }))).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await read(await call('POST', h, ROUTE, input({ audience: { kind: 'accounts', usernames: ['bob', 'alice'] } })))).announcements).toHaveLength(1)
    expect(h.writeSaved).toHaveBeenCalledTimes(1)
  })

  it('caps active announcements and drops the oldest archived record past the history bound', async () => {
    const id = (i: number) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`
    const full = Array.from({ length: 50 }, (_, i) => record({ id: id(i) }))
    const capped = helpers(full)
    await expect(call('POST', capped.helpers, ROUTE, input({ expectedRevision: sha256Hex(JSON.stringify(full)) }))).rejects.toMatchObject({ code: 'VALIDATION' })
    const history = [...Array.from({ length: 49 }, (_, i) => record({ id: id(i) })), ...Array.from({ length: 51 }, (_, i) => record({ id: id(100 + i), status: 'archived' }))]
    const trimmed = helpers(history)
    const view = await read(await call('POST', trimmed.helpers, ROUTE, input({ expectedRevision: sha256Hex(JSON.stringify(history)) })))
    expect(view.announcements).toHaveLength(100)
    expect(view.announcements.some(item => item.id === id(150))).toBe(false)
    expect(view.announcements.some(item => item.id === id(149))).toBe(true)
  })

  it('reports an unreadable file as invalid and lets root replace it with its revision', async () => {
    const { helpers: h } = helpers({ broken: true })
    const view = await read(await call('GET', h))
    expect(view).toMatchObject({ state: 'invalid', announcements: [] })
    await expect(call('PUT', h, ROUTE + '/' + record().id, input({ expectedRevision: view.revision }))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await read(await call('POST', h, ROUTE, input({ expectedRevision: view.revision })))).state).toBe('saved')
  })

  it('refuses resellers and owners, malformed requests and unknown methods before any write', async () => {
    for (const who of [reseller, owner(ALICE)]) {
      const denied = helpers(null, {}, who)
      await expect(call('GET', denied.helpers)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(call('POST', denied.helpers, ROUTE, input())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    const { helpers: h } = helpers()
    await expect(call('GET', h, ROUTE + '?all=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('POST', h, ROUTE, '{')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('POST', h, ROUTE, input(), 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('POST', h, ROUTE + '/' + record().id + '/archive', { expectedRevision: EMPTY, reason: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('PUT', h, ROUTE + '/not-an-id', input())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const put = (await call('PUT', h, ROUTE, input()))!
    expect(put.status).toBe(405); expect(put.headers.get('allow')).toBe('GET, POST')
    expect((await call('DELETE', h, ROUTE + '/' + record().id))!.status).toBe(405)
    expect(h.writeSaved).not.toHaveBeenCalled()
  })

  it('re-checks fresh root authority before writing', async () => {
    const changed = { ...root, sessionId: 'other' } as unknown as AuthenticatedCaller
    const { helpers: h } = helpers(null, { requireCaller: vi.fn<AnnouncementsHelpers['requireCaller']>().mockResolvedValueOnce(root).mockResolvedValue(changed) })
    await expect(call('POST', h, ROUTE, input())).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(h.writeSaved).not.toHaveBeenCalled()
  })

  it('reports a write that does not read back, or a failed audit, as requiring verification', async () => {
    const lost = helpers(null, { writeSaved: vi.fn(async () => undefined) })
    await expect(call('POST', lost.helpers, ROUTE, input())).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } })
    const unaudited = helpers(null, { emitAudit: vi.fn(async () => { throw new Error('down') }) })
    await expect(call('POST', unaudited.helpers, ROUTE, input())).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } })
  })
})

describe('account owner announcements', () => {
  const saved = [
    record({ id: '77777777-7777-4777-8777-000000000001', audience: { kind: 'plan', planId: PLAN }, severity: 'warning', endsAt: '2026-10-30T18:00:00.000Z' }),
    record({ id: '77777777-7777-4777-8777-000000000002', audience: { kind: 'accounts', usernames: ['bob'] } }),
    record({ id: '77777777-7777-4777-8777-000000000003', startsAt: '2026-11-01T00:00:00.000Z' }),
    record({ id: '77777777-7777-4777-8777-000000000004', status: 'archived' }),
    record({ id: '77777777-7777-4777-8777-000000000005', audience: { kind: 'reseller', resellerId: '99999999-9999-4999-8999-999999999999' } }),
  ]

  it('returns only live announcements targeted at the session account, never the audience', async () => {
    const alice = helpers(saved, {}, owner(ALICE))
    const mine = await read(await call('GET', alice.helpers, MINE))
    expect(mine.announcements.map(item => item.id)).toEqual(['77777777-7777-4777-8777-000000000001'])
    expect(Object.keys(mine.announcements[0]!).sort()).toEqual(['body', 'endsAt', 'id', 'severity', 'startsAt', 'title'])
    expect(JSON.stringify(mine)).not.toContain('audience')
    expect(JSON.stringify(mine)).not.toContain('bob')
    const bob = helpers(saved, {}, owner(BOB))
    expect((await read(await call('GET', bob.helpers, MINE))).announcements.map(item => item.id)).toEqual(['77777777-7777-4777-8777-000000000002'])
  })

  it('stores a dismissal per account, verifies it and audits it once', async () => {
    const alice = helpers(saved, {}, owner(ALICE))
    const id = '77777777-7777-4777-8777-000000000001'
    const dismissed = await read(await call('POST', alice.helpers, `${MINE}/${id}/dismiss`))
    expect(dismissed).toEqual({ dismissed: id, announcements: [] })
    expect(alice.dismissals.get(ALICE.id)).toEqual([id])
    expect(alice.audits).toEqual([expect.objectContaining({ actor: 'alice', action: 'account.announcement.dismissed', target: 'announcement:' + id })])
    expect((await read(await call('POST', alice.helpers, `${MINE}/${id}/dismiss`))).dismissed).toBe(id)
    expect(alice.helpers.writeDismissed).toHaveBeenCalledTimes(1)
    expect((await read(await call('GET', alice.helpers, MINE))).announcements).toEqual([])
    const bob = helpers(saved, {}, owner(BOB))
    expect((await read(await call('GET', bob.helpers, MINE))).announcements).toHaveLength(1)
  })

  it('refuses to dismiss what the account cannot see, and malformed requests', async () => {
    const alice = helpers(saved, {}, owner(ALICE))
    for (const id of ['77777777-7777-4777-8777-000000000002', '77777777-7777-4777-8777-000000000003', '77777777-7777-4777-8777-000000000004', 'nope'])
      await expect(call('POST', alice.helpers, `${MINE}/${id}/dismiss`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call('POST', alice.helpers, `${MINE}/77777777-7777-4777-8777-000000000001/dismiss`, {})).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('GET', alice.helpers, MINE + '?account=bob')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call('POST', alice.helpers, MINE))!.status).toBe(405)
    expect(alice.helpers.writeDismissed).not.toHaveBeenCalled()
  })

  it('refuses root, resellers and mailbox principals, and reports an unreadable file as unavailable', async () => {
    for (const who of [root, reseller, { ...owner(ALICE), principalKind: 'mailbox' } as unknown as AuthenticatedCaller])
      await expect(call('GET', helpers(saved, {}, who).helpers, MINE)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('GET', helpers({ broken: true }, {}, owner(ALICE)).helpers, MINE)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
})
