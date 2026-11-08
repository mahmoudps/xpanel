import { describe, expect, it, vi } from 'vitest'
import { handleWhmHomeRoute, inboxItems, parseFavorites } from './whm-home-workspace.ts'
import type { WhmHomePorts } from './whm-home-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'

const root = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111' } } as AuthenticatedCaller
const ports = (files: Record<string, unknown> = {}, over: Partial<WhmHomePorts> = {}, body: unknown = {}): WhmHomePorts => ({
  requireCaller: async () => root, readJsonBody: async () => body as Record<string, unknown>, read: async path => files[path] ?? null, write: async (path, value) => { files[path] = value; return value },
  failedJobs: async () => [], failedAudit: async () => [], backupRuns: async () => [], actionLabel: action => action, ...over })
const call = async (path: string, method: string, value: WhmHomePorts) => {
  const request = new Request('http://x' + path, { method })
  return await (await handleWhmHomeRoute(request, new URL(request.url), method, value))!.json() as Record<string, unknown>
}

describe('WHM favorites', () => {
  it('holds distinct WHM pages only', () => {
    expect(parseFavorites(null)).toEqual({ routes: [], descriptions: true })
    expect(parseFavorites({ routes: ['/whm/accounts', '/whm'], descriptions: false })).toEqual({ routes: ['/whm/accounts', '/whm'], descriptions: false })
    for (const raw of [{ routes: ['/home'], descriptions: true }, { routes: ['/whm', '/whm'], descriptions: true }, { routes: ['/whm/../x'], descriptions: true }, { routes: ['https://x'], descriptions: true }, { routes: [], descriptions: 'no' }, { routes: [], descriptions: true, extra: 1 }, { routes: Array.from({ length: 25 }, (_, n) => `/whm/p${n}`), descriptions: true }]) expect(() => parseFavorites(raw)).toThrow()
  })
  it('keeps one file per administrator and survives a damaged one', async () => {
    const files: Record<string, unknown> = {}, id = root.principal.id
    await call('/api/admin/favorites', 'PUT', ports(files, {}, { routes: ['/whm/plans'], descriptions: true }))
    expect(files[`preferences/${id}.favorites.json`]).toEqual({ routes: ['/whm/plans'], descriptions: true })
    files[`preferences/${id}.favorites.json`] = { routes: 'x' }
    expect(await call('/api/admin/favorites', 'GET', ports(files))).toEqual({ routes: [], descriptions: true })
  })
})

describe('WHM notifications', () => {
  const run = { id: 'r1', startedAt: '2026-11-07T01:00:00.000Z', finishedAt: '2026-11-07T02:00:00.000Z', state: 'failed' }
  it('turns a failed backup run into one unread item, read once marked', async () => {
    const files: Record<string, unknown> = {}, value = ports(files, { backupRuns: async () => [run, { ...run, id: 'r2', state: 'succeeded' }] })
    expect(await call('/api/admin/notifications', 'GET', value)).toMatchObject({ unread: 1, items: [{ id: 'backup:r1', kind: 'backup', read: false }] })
    await call('/api/admin/notifications/read', 'POST', ports(files, {}, { ids: ['backup:r1'] }))
    expect(await call('/api/admin/notifications', 'GET', value)).toMatchObject({ unread: 0, items: [{ id: 'backup:r1', read: true }] })
  })
  it('sorts newest first and keeps the list when the backup read fails', async () => {
    expect(inboxItems([{ id: 'j', summary: 'S', finishedAt: '2026-11-02T00:00:00.000Z', updatedAt: 'x' }], [{ id: 7, at: '2026-11-03T00:00:00.000Z', action: 'a.b', target: 't' }] as never, [], new Set(), action => action.toUpperCase()).map(item => [item.id, item.title])).toEqual([['audit:7', 'A.B'], ['job:j', 'S']])
    expect(await call('/api/admin/notifications', 'GET', ports({}, { failedJobs: async () => [{ id: 'j', summary: 'S', finishedAt: null, updatedAt: '2026-11-02T00:00:00.000Z' }], backupRuns: vi.fn(async () => { throw new Error('no agent') }) }))).toMatchObject({ unread: 1 })
  })
  it('gives a reseller an empty list, never the server facts, and refuses unknown ids', async () => {
    const reseller = { requireCaller: async () => ({ principal: { kind: 'reseller', id: root.principal.id } }) as AuthenticatedCaller, failedJobs: vi.fn(async () => []) }
    expect(await call('/api/admin/notifications', 'GET', ports({}, reseller))).toEqual({ items: [], unread: 0 })
    expect(reseller.failedJobs).not.toHaveBeenCalled()
    await expect(call('/api/admin/notifications/read', 'POST', ports({}, reseller, { ids: ['job:a'] }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('/api/admin/notifications/read', 'POST', ports({}, {}, { ids: ['../x'] }))).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
