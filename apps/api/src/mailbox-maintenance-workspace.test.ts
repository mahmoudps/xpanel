import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleMailboxMaintenanceWorkspaceRoute, projectMailboxMaintenance } from './mailbox-maintenance-workspace.ts'
import type { MailboxMaintenanceWorkspaceHelpers } from './mailbox-maintenance-workspace.ts'

const root = { principal: { kind: 'root', id: 'root-1', username: 'root' } } as AuthenticatedCaller
const observedAt = '2026-10-27T10:00:00.000Z'
const jobId = '22222222-2222-4222-8222-222222222222'
const list = { observedAt, fts: 'not_configured', jobsAvailable: true, mailboxes: [{ login: 'info@alice.example', account: 'alice', savedQuotaMb: 1024 }, { login: 'boss@carol.example', account: 'carol', savedQuotaMb: null }], mailboxesTruncated: false, report: null }
const one = { ...list, mailboxes: [list.mailboxes[0]] }
const report = { mailbox: 'info@alice.example', account: 'alice', savedQuotaMb: 1024,
  quota: { state: 'read', reason: null, resources: [{ root: 'User quota', type: 'STORAGE', value: 2048, limit: 10240, percent: 20 }, { root: 'User quota', type: 'MESSAGE', value: 12, limit: null, percent: 0 }] },
  folders: { state: 'read', reason: null, folders: [{ name: 'INBOX', messages: 10, vsizeBytes: 4096 }, { name: 'Sent', messages: 2, vsizeBytes: 1024 }], truncated: false, totalMessages: 12, totalVsizeBytes: 5120 } }
const post = (body: unknown) => new Request('http://localhost/api/server/mail-maintenance/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const get = (query = '') => new Request('http://localhost/api/server/mail-maintenance' + query)
const call = (req: Request, helpers: MailboxMaintenanceWorkspaceHelpers) => handleMailboxMaintenanceWorkspaceRoute(req, new URL(req.url), req.method, helpers)
const helpers = (reply: (path: string, body?: unknown) => unknown, overrides: Partial<MailboxMaintenanceWorkspaceHelpers> = {}) => {
  const events: string[] = []
  const value: MailboxMaintenanceWorkspaceHelpers = {
    requireCaller: vi.fn(async () => { events.push('auth'); return root }), assertRoot: vi.fn(async (_caller, action: string) => { events.push('root:' + action) }),
    emitAudit: vi.fn(async (entry: { action: string; outcome: string }) => { events.push('audit:' + entry.action + ':' + entry.outcome) }),
    callHost: vi.fn(async (_caller, path: string, body?: unknown) => { events.push('host:' + path); return reply(path, body) }), ...overrides,
  }
  return { value, events }
}

describe('API mailbox maintenance workspace', () => {
  it('leaves unrelated routes untouched and refuses non-root callers with 403 before the agent', async () => {
    const { value } = helpers(() => list)
    expect(await call(new Request('http://localhost/api/server/mail-server/server'), value)).toBeNull()
    expect(value.requireCaller).not.toHaveBeenCalled()
    const denied = helpers(() => list, { assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN', status: 403 }) } })
    for (const req of [get(), get('?mailbox=info@alice.example'), post({ operation: 'resync', mailboxes: ['info@alice.example'] })]) await expect(call(req, denied.value)).rejects.toMatchObject({ status: 403 })
    expect(denied.value.callHost).not.toHaveBeenCalled()
  })
  it('rejects unknown keys, wildcard or injected mailboxes, bulk overflow and wrong methods with 400 before the agent', async () => {
    const { value } = helpers(() => list)
    expect((await call(new Request('http://localhost/api/server/mail-maintenance', { method: 'POST' }), value))!.status).toBe(405)
    expect((await call(new Request('http://localhost/api/server/mail-maintenance/jobs'), value))!.status).toBe(405)
    for (const req of [get('?mailbox=*@alice.example'), get('?mailbox=-A'), get('?mailbox=info@alice.example&x=1'), get('?account=alice'), post({ operation: 'resync', mailboxes: ['info@alice.example'], force: true }),
      post({ operation: 'expunge', mailboxes: ['info@alice.example'] }), post({ operation: 'resync', mailboxes: ['*'] }), post({ operation: 'resync', mailboxes: ['a@alice.example', 'a@alice.example'] }), post({ operation: 'resync', mailboxes: [] }),
      post({ operation: 'resync', mailboxes: Array.from({ length: 33 }, (_, index) => 'm' + index + '@alice.example') }), post({ operation: 'resync' })])
      await expect(call(req, value)).rejects.toMatchObject({ code: 'VALIDATION', status: 400, detail: { stateChanged: false } })
    expect(value.callHost).not.toHaveBeenCalled()
  })
  it('states unavailability truthfully without a host agent', async () => {
    const { value } = helpers(() => list, { callHost: undefined })
    await expect(call(get(), value)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    await expect(call(post({ operation: 'resync', mailboxes: ['info@alice.example'] }), value)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('projects the list and one report, dropping unknown fields and refusing inconsistent evidence', async () => {
    const { value, events } = helpers(path => path.includes('?mailbox=') ? { ...one, report: { ...report, passwordHash: 'x' }, secret: 1 } : { ...list, extra: true })
    expect(await (await call(get(), value))!.json()).toEqual(list)
    expect(await (await call(get('?mailbox=info@alice.example'), value))!.json()).toEqual({ ...one, report })
    expect(events).toContain('host:/host/mail/maintenance?mailbox=info%40alice.example')
    const unavailable = { ...report, quota: { state: 'unavailable', reason: 'user_unknown', resources: [] }, folders: { state: 'unavailable', reason: 'malformed_output', folders: [], truncated: false, totalMessages: null, totalVsizeBytes: null } }
    expect(projectMailboxMaintenance({ ...one, report: unavailable }, 'info@alice.example').report).toEqual(unavailable)
    for (const bad of [{ ...list, report }, { ...list, mailboxes: [{ login: '*@alice.example', account: 'alice', savedQuotaMb: 1 }] }, { ...list, mailboxes: [list.mailboxes[0], list.mailboxes[0]] }, { ...list, fts: 'yes' }])
      expect(() => projectMailboxMaintenance(bad, null)).toThrow()
    for (const bad of [{ ...one, report: null }, { ...list, report }, { ...one, report: { ...report, mailbox: 'boss@carol.example' } }, { ...one, report: { ...report, folders: { ...report.folders, totalMessages: 99 } } },
      { ...one, report: { ...report, quota: { state: 'unavailable', reason: 'user_unknown', resources: report.quota.resources } } }, { ...one, report: { ...report, quota: { ...report.quota, state: 'ok' } } },
      { ...one, report: { ...report, folders: { ...report.folders, folders: [{ name: 'a\u202eb', messages: 12, vsizeBytes: 5120 }] } } }, { ...one, report: { ...report, quota: { state: 'unavailable', reason: 'boom', resources: [] } } }])
      expect(() => projectMailboxMaintenance(bad, 'info@alice.example')).toThrow()
    expect(projectMailboxMaintenance({ ...one, report: { ...report, folders: { ...report.folders, truncated: true, totalMessages: 999 } } }, 'info@alice.example').report!.folders.totalMessages).toBe(999)
  })
  it('submits a job with fresh authority before and after the host call and audits it', async () => {
    const { value, events } = helpers((_path, body) => ({ job: { id: jobId, kind: 'mail.maintenance.quota-recalc', status: 'queued', extra: body } }))
    const response = (await call(post({ operation: 'quota-recalc', mailboxes: ['info@alice.example', 'boss@carol.example'] }), value))!
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ job: { id: jobId, kind: 'mail.maintenance.quota-recalc', status: 'queued' } })
    expect(value.callHost).toHaveBeenCalledWith(root, '/host/mail/maintenance/jobs', { operation: 'quota-recalc', mailboxes: ['info@alice.example', 'boss@carol.example'] })
    expect(events).toEqual(['auth', 'root:server.mail-maintenance.submit', 'auth', 'root:server.mail-maintenance.submit', 'host:/host/mail/maintenance/jobs', 'auth', 'root:server.mail-maintenance.submit', 'audit:server.mail_maintenance.quota_recalc:ok'])
    const wrong = helpers(() => ({ job: { id: jobId, kind: 'mail.maintenance.resync', status: 'queued' } }))
    await expect(call(post({ operation: 'index', mailboxes: ['info@alice.example'] }), wrong.value)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { unknownOutcome: true } })
  })
  it('passes host refusals through and audits them as refused or unknown', async () => {
    const refused = helpers(() => { throw Object.assign(new Error('the protected host request was refused'), { code: 'NOT_FOUND', status: 404, detail: { stateChanged: false } }) })
    await expect(call(post({ operation: 'resync', mailboxes: ['nobody@alice.example'] }), refused.value)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(refused.value.emitAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'failed', detail: expect.objectContaining({ outcome: 'refused' }) }))
    const lost = helpers(() => { throw Object.assign(new Error('host transport'), { code: 'SERVICE_UNAVAILABLE', status: 503, detail: { stateChanged: true, unknownOutcome: true } }) })
    await expect(call(post({ operation: 'resync', mailboxes: ['info@alice.example'] }), lost.value)).rejects.toMatchObject({ status: 503 })
    expect(lost.value.emitAudit).toHaveBeenLastCalledWith(expect.objectContaining({ detail: expect.objectContaining({ outcome: 'unknown' }) }))
    let count = 0
    const changed = helpers(() => ({ job: { id: jobId, kind: 'mail.maintenance.resync', status: 'queued' } }), { requireCaller: async () => (count++ < 2 ? root : { principal: { kind: 'root', id: 'root-2', username: 'other' } }) as AuthenticatedCaller })
    await expect(call(post({ operation: 'resync', mailboxes: ['info@alice.example'] }), changed.value)).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { unknownOutcome: true } })
  })
})
