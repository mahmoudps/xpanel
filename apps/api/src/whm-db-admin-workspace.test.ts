import { describe, expect, it, vi } from 'vitest'
import { handleWhmDbAdminRoute } from './whm-db-admin-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { WhmDbAdminHelpers } from './whm-db-admin-workspace.ts'

const caller = { principal: { id: 'root-principal', username: 'root', kind: 'root' }, sessionId: 'session', apiTokenId: null } as AuthenticatedCaller
const report = { database: 'alice_shop', action: 'repair', observedAt: '2026-11-07T10:00:00.000Z', tables: [{ name: 'posts', engine: 'MyISAM', result: 'repaired', message: 'OK' }] }
const outcome = { observedAt: '2026-11-07T10:00:00.000Z', serverPassword: 'verified', clientFile: { path: '/root/.my.cnf', state: 'written' }, socketAccess: 'verified', verificationRequired: false }
const setup = (reply: unknown = report) => {
  const helpers: WhmDbAdminHelpers = { requireCaller: vi.fn(async () => caller), assertRoot: vi.fn(async who => { if (who.principal.kind !== 'root') throw new Error('forbidden') }), callHost: vi.fn(async () => reply), readHost: vi.fn(async () => ({ clientFile: { path: '/root/.my.cnf', state: 'absent' }, mariadb: 'connected' })) }
  const call = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const url = new URL('http://api.local' + path)
    return handleWhmDbAdminRoute(new Request(url, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, method, helpers)
  }
  return { helpers, call }
}

describe('WHM database administration API', () => {
  it('sends only the validated maintenance request and returns the checked report', async () => {
    const t = setup()
    expect(await (await t.call('/api/server/databases/maintenance', { database: 'alice_shop', action: 'repair' }))!.json()).toEqual(report)
    expect(t.helpers.callHost).toHaveBeenCalledWith(caller, '/host/databases/maintenance', { database: 'alice_shop', action: 'repair' })
    expect(await t.call('/api/server/databases/other', {})).toBeNull()
    expect((await t.call('/api/server/databases/maintenance'))!.status).toBe(405)
  })
  it('refuses system schemas, non-root callers and a reply for another database', async () => {
    const t = setup()
    await expect(t.call('/api/server/databases/maintenance', { database: 'mysql', action: 'repair' })).rejects.toMatchObject({ code: 'VALIDATION' })
    t.helpers.requireCaller = vi.fn(async () => ({ ...caller, principal: { ...caller.principal, kind: 'reseller' } }) as AuthenticatedCaller)
    await expect(t.call('/api/server/databases/maintenance', { database: 'alice_shop', action: 'repair' })).rejects.toThrow('forbidden')
    expect(t.helpers.callHost).not.toHaveBeenCalled()
    for (const reply of [{ ...report, database: 'bob_shop' }, { ...report, tables: [{ ...report.tables[0], result: 'fixed' }] }, { ...report, tables: [report.tables[0], report.tables[0]] }]) {
      await expect(setup(reply).call('/api/server/databases/maintenance', { database: 'alice_shop', action: 'repair' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { verificationRequired: true } })
    }
  })
  it('applies the password policy before dispatch and never echoes the password', async () => {
    const t = setup(outcome)
    await expect(t.call('/api/server/databases/root-password', { password: 'short' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(t.helpers.callHost).not.toHaveBeenCalled()
    const body = await (await t.call('/api/server/databases/root-password', { password: 'Correct-Horse-9' }))!.text()
    expect(JSON.parse(body)).toEqual(outcome); expect(body).not.toContain('Correct-Horse-9')
    await expect(setup({ ...outcome, verificationRequired: true }).call('/api/server/databases/root-password', { password: 'Correct-Horse-9' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
  })
  it('reports the root client file state and an unread host as unreadable', async () => {
    const t = setup()
    expect(await (await t.call('/api/server/databases/root-password'))!.json()).toEqual({ clientFile: { path: '/root/.my.cnf', state: 'absent' }, mariadb: 'connected' })
    t.helpers.readHost = vi.fn(async () => ({ clientFile: { path: '/root/.my.cnf', state: 'absent', content: 'x' }, mariadb: 'connected' }))
    expect(await (await t.call('/api/server/databases/root-password'))!.json()).toEqual({ clientFile: { path: '/root/.my.cnf', state: 'unreadable' }, mariadb: 'unavailable' })
  })
})
