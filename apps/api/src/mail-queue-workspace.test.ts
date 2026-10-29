import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleMailQueueWorkspaceRoute, projectMailQueueAction, projectMailQueueRead } from './mail-queue-workspace.ts'
import type { MailQueueWorkspaceHelpers } from './mail-queue-workspace.ts'

const root = { principal: { kind: 'root', id: 'root-1', username: 'root' } } as AuthenticatedCaller
const message = { queueId: '4F2A1B3C9D', queue: 'deferred', arrivalTime: '2026-10-27T10:00:00.000Z', sizeBytes: 2048, sender: 's@example.test', recipients: [{ address: 'r@example.net', delayReason: 'timeout' }], recipientCount: 1, forcedExpire: false }
const read = (messages: unknown[] = [message]) => ({ state: 'read', observedAt: '2026-10-27T10:00:01.000Z', revision: 'c'.repeat(64), truncated: false, counts: { maildrop: 0, incoming: 0, active: 0, hold: 0, deferred: messages.length }, messages })
const input = { action: 'delete', queueId: '4F2A1B3C9D', queue: 'deferred', expectedRevision: 'c'.repeat(64) } as const
const result = (overrides: Record<string, unknown> = {}) => ({ ...input, expectedRevision: undefined, observedRevision: input.expectedRevision, outcome: 'confirmed', verificationRequired: false, after: { present: false, queue: null }, revision: 'd'.repeat(64), observedAt: '2026-10-27T10:00:02.000Z', ...overrides })
const post = (body: unknown, path = '/api/server/mail-queue/action') => new Request('http://localhost' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const call = (req: Request, helpers: MailQueueWorkspaceHelpers) => handleMailQueueWorkspaceRoute(req, new URL(req.url), req.method, helpers)
const helpers = (overrides: Partial<MailQueueWorkspaceHelpers> = {}) => {
  const events: string[] = []
  const value: MailQueueWorkspaceHelpers = {
    requireCaller: vi.fn(async () => { events.push('auth'); return root }), assertRoot: vi.fn(async (_caller, action: string) => { events.push('root:' + action) }),
    emitAudit: vi.fn(async (entry: { action: string; outcome: string }) => { events.push('audit:' + entry.action + ':' + entry.outcome) }),
    readQueue: vi.fn(async () => { events.push('agent:read'); return read() }), applyAction: vi.fn(async () => { events.push('agent:action'); return result() }), ...overrides,
  }
  return { value, events }
}

describe('API mail queue workspace', () => {
  it('leaves unrelated routes untouched', async () => {
    const { value } = helpers()
    expect(await call(new Request('http://localhost/api/server/php/inventory'), value)).toBeNull()
    expect(value.requireCaller).not.toHaveBeenCalled()
  })
  it('forwards a root read and projects only envelope metadata', async () => {
    const { value, events } = helpers({ readQueue: async () => ({ ...read([{ ...message, body: 'secret', headers: 'Subject: x' }]), extra: 'internal' }) })
    const response = (await call(new Request('http://localhost/api/server/mail-queue'), value))!
    const body = await response.json()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body.messages[0]).toEqual(message)
    expect(JSON.stringify(body)).not.toMatch(/secret|Subject|internal/)
    expect(events).toEqual(['auth', 'root:server.mail-queue.read'])
  })
  it('returns 403 for non-root callers before contacting the agent', async () => {
    const { value } = helpers({ assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN', status: 403 }) } })
    await expect(call(new Request('http://localhost/api/server/mail-queue'), value)).rejects.toMatchObject({ status: 403 })
    await expect(call(post(input), value)).rejects.toMatchObject({ status: 403 })
    expect(value.readQueue).not.toHaveBeenCalled(); expect(value.applyAction).not.toHaveBeenCalled()
  })
  it('states unavailability truthfully without a host agent', async () => {
    const { value } = helpers({ readQueue: undefined, applyAction: undefined })
    await expect(call(new Request('http://localhost/api/server/mail-queue'), value)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    await expect(call(post(input), value)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    const unavailable = { state: 'unavailable', observedAt: '2026-10-27T10:00:01.000Z', revision: null, truncated: false, counts: read([]).counts, messages: [], reason: 'command_failed' }
    expect(projectMailQueueRead(unavailable)).toEqual(unavailable)
  })
  it('refuses inconsistent or oversized host observations', () => {
    for (const bad of [{ ...read(), revision: null }, { ...read(), counts: { ...read().counts, deferred: 2 } }, read([message, message]), read([{ ...message, queueId: 'ALL' }]), read([{ ...message, sender: 'x'.repeat(513) }]),
      read([{ ...message, recipientCount: 0 }]), { ...read([]), state: 'unavailable' }, read(Array.from({ length: 5001 }, () => message))]) expect(() => projectMailQueueRead(bad)).toThrow()
  })
  it('validates grammar before dispatch', async () => {
    for (const body of [{ ...input, queueId: 'ALL' }, { ...input, queueId: '-' }, { ...input, queue: 'maildrop' }, { ...input, action: 'purge' }, { ...input, expectedRevision: 'x' }, { ...input, accountId: 'a' }, { action: 'delete' }]) {
      const { value } = helpers()
      await expect(call(post(body), value)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
      expect(value.applyAction).not.toHaveBeenCalled()
    }
    const { value } = helpers()
    await expect(call(post(input, '/api/server/mail-queue/action?queueId=ALL'), value)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(new Request('http://localhost/api/server/mail-queue/action', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), value)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call(new Request('http://localhost/api/server/mail-queue', { method: 'POST' }), value))!.status).toBe(405)
  })
  it('re-checks root before and after the agent call and audits the observed outcome', async () => {
    const { value, events } = helpers()
    const body = await (await call(post(input), value))!.json()
    expect(body).toMatchObject({ outcome: 'confirmed', after: { present: false } })
    expect(events).toEqual(['auth', 'root:server.mail-queue.manage', 'auth', 'root:server.mail-queue.manage', 'agent:action', 'auth', 'root:server.mail-queue.manage', 'audit:server.mail_queue.delete:ok'])
    expect(value.applyAction).toHaveBeenCalledWith(root, input)
    expect(value.emitAudit).toHaveBeenCalledWith({ actor: 'root', principalId: 'root-1', action: 'server.mail_queue.delete', target: 'mail-queue:4F2A1B3C9D', outcome: 'ok', detail: { queue: 'deferred', outcome: 'confirmed', afterQueue: null } })
  })
  it('flags review when authority is lost after the agent call', async () => {
    let calls = 0
    const { value } = helpers({ assertRoot: async () => { if (++calls === 3) throw new Error('revoked') } })
    await expect(call(post(input), value)).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { verificationRequired: true, unknownOutcome: true } })
    expect(value.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: { queue: 'deferred', outcome: 'confirmed', authorityChanged: true } }))
  })
  it('audits refused and unknown agent failures and rethrows them', async () => {
    const conflict = Object.assign(new Error('moved'), { code: 'CONFLICT', detail: { stateChanged: false } })
    const refused = helpers({ applyAction: async () => { throw conflict } })
    await expect(call(post(input), refused.value)).rejects.toBe(conflict)
    expect(refused.value.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', detail: { queue: 'deferred', outcome: 'refused' } }))
    const lost = helpers({ applyAction: async () => { throw Object.assign(new Error('transport'), { detail: { stateChanged: true, unknownOutcome: true } }) } })
    await expect(call(post(input), lost.value)).rejects.toThrow('transport')
    expect(lost.value.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: { queue: 'deferred', outcome: 'unknown' } }))
  })
  it('never accepts a claimed outcome the re-read does not support', () => {
    expect(projectMailQueueAction(result({ action: 'deliver', outcome: 'attempted', after: { present: true, queue: 'deferred' } }), { ...input, action: 'deliver' })).toMatchObject({ outcome: 'attempted' })
    for (const [value, action] of [[result({ after: { present: true, queue: 'deferred' } }), 'delete'], [result({ action: 'deliver' }), 'deliver'], [result({ outcome: 'attempted' }), 'delete'],
      [result({ outcome: 'unknown' }), 'delete'], [result({ action: 'hold', after: { present: true, queue: 'deferred' } }), 'hold'], [result({ queueId: 'B0C1D2E3F4' }), 'delete'], [result({ observedRevision: 'e'.repeat(64) }), 'delete'],
      [result({ after: { present: true, queue: null } }), 'delete']] as const) expect(() => projectMailQueueAction(value, { ...input, action })).toThrow()
    expect(projectMailQueueAction(result({ outcome: 'unknown', verificationRequired: true, after: { present: null, queue: null }, revision: null }), input)).toMatchObject({ outcome: 'unknown', verificationRequired: true })
  })
  it('flags review when the outcome audit fails', async () => {
    const { value } = helpers({ emitAudit: async () => { throw new Error('db down') } })
    await expect(call(post(input), value)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: true, verificationRequired: true } })
  })
})
