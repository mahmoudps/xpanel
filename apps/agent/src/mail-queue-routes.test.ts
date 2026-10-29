import { describe, expect, it, vi } from 'vitest'
import { handleMailQueueRoute } from './mail-queue-routes.ts'
import type { MailQueueRouteContext } from './mail-queue-routes.ts'

const now = () => new Date('2026-10-27T10:00:00Z')
const deferred = JSON.stringify({ queue_name: 'deferred', queue_id: '4F2A1B3C9D', arrival_time: 1793095200, message_size: 2048, sender: 's@example.test', recipients: [{ address: 'r@example.net', delay_reason: 'timeout' }] }) + '\n'
const body = { action: 'delete', queueId: '4F2A1B3C9D', queue: 'deferred', expectedRevision: 'b'.repeat(64) }
const post = (value: unknown, path = '/host/mail/queue/action', type = 'application/json') => new Request('http://agent.local' + path, { method: 'POST', headers: { 'content-type': type }, body: typeof value === 'string' ? value : JSON.stringify(value) })
const call = (req: Request, ctx: MailQueueRouteContext) => handleMailQueueRoute(req, new URL(req.url), req.method, ctx)
const context = (outputs: string[], overrides: Partial<MailQueueRouteContext> = {}) => {
  const events: string[] = []
  const run = vi.fn(async (argv: string[]) => { events.push(argv.join(' ')); return { ok: true, code: 0, stdout: argv[1] === '-j' ? outputs.shift() ?? '' : '', stderr: '' } })
  const ctx: MailQueueRouteContext = { run, now, assertRoot: vi.fn(async (action: string) => { events.push('root:' + action); return { actor: 'root' } }), audit: vi.fn(async (entry: { action: string }) => { events.push('audit:' + entry.action) }), ...overrides }
  return { ctx, events, run }
}

describe('agent mail queue routes', () => {
  it('ignores unrelated paths without authorizing', async () => {
    const { ctx } = context([])
    expect(await call(new Request('http://agent.local/host/mail/quarantine/list'), ctx)).toBeNull()
    expect(ctx.assertRoot).not.toHaveBeenCalled()
  })
  it('lists the queue for root with no-store and truthful unavailable states', async () => {
    const { ctx } = context([deferred])
    const response = (await call(new Request('http://agent.local/host/mail/queue'), ctx))!
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ state: 'read', counts: { deferred: 1 }, messages: [{ queueId: '4F2A1B3C9D' }] })
    expect(ctx.assertRoot).toHaveBeenCalledWith('mail.queue.read')
    await expect(call(new Request('http://agent.local/host/mail/queue'), { ...ctx, run: null })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    await expect(call(new Request('http://agent.local/host/mail/queue?queue=hold'), ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call(new Request('http://agent.local/host/mail/queue', { method: 'DELETE' }), ctx))!.status).toBe(405)
  })
  it('refuses non-root callers before reading or running anything', async () => {
    const { ctx, run } = context([deferred], { assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' }) } })
    await expect(call(new Request('http://agent.local/host/mail/queue'), ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(post(body), ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(run).not.toHaveBeenCalled()
  })
  it('re-checks root after the pre-read and right before the mutating command, then audits the observed outcome', async () => {
    const { ctx, events } = context([deferred, ''])
    const response = (await call(post(body), ctx))!
    expect(await response.json()).toMatchObject({ action: 'delete', outcome: 'confirmed', after: { present: false } })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(events).toEqual(['root:mail.queue.manage', 'audit:mail.queue.change_requested', '/usr/sbin/postqueue -j', 'root:mail.queue.manage', '/usr/sbin/postsuper -d 4F2A1B3C9D deferred', '/usr/sbin/postqueue -j', 'audit:mail.queue.delete'])
    expect(ctx.audit).toHaveBeenLastCalledWith({ actor: 'root', action: 'mail.queue.delete', target: 'mail-queue:4F2A1B3C9D', outcome: 'ok', detail: { queue: 'deferred', outcome: 'confirmed', afterQueue: null } })
  })
  it('never runs postsuper when authority is lost after the pre-read', async () => {
    let calls = 0
    const { ctx, events } = context([deferred], { assertRoot: async () => { if (++calls > 1) throw new Error('authority changed'); return { actor: 'root' } } })
    await expect(call(post(body), ctx)).rejects.toThrow('authority changed')
    expect(events.filter(event => event.includes('postsuper'))).toEqual([])
    expect(ctx.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'mail.queue.delete', outcome: 'failed', detail: { queue: 'deferred', outcome: 'refused' } }))
  })
  it('returns a 409 conflict without mutation when the message moved', async () => {
    const { ctx, events } = context([''])
    await expect(call(post(body), ctx)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(events.some(event => event.includes('postsuper'))).toBe(false)
    expect(ctx.audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'failed', detail: { queue: 'deferred', outcome: 'refused' } }))
  })
  it.each([
    [{ ...body, queueId: 'ALL' }], [{ ...body, queueId: '-' }], [{ ...body, queueId: '-d' }], [{ ...body, queue: 'maildrop' }], [{ ...body, queue: '/var/spool/postfix/hold' }],
    [{ ...body, action: 'flush' }], [{ ...body, expectedRevision: 'x' }], [{ ...body, extra: true }], [{ action: 'delete', queueId: '4F2A1B3C9D', queue: 'deferred' }], [[body]], ['{"action":'],
  ])('rejects body grammar violation %j before dispatch', async value => {
    const { ctx, run } = context([deferred])
    await expect(call(post(value), ctx)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(run).not.toHaveBeenCalled()
  })
  it('rejects non-JSON, oversized bodies, selectors and missing host executor', async () => {
    const { ctx, run } = context([deferred])
    await expect(call(post(body, undefined, 'text/plain'), ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(post({ ...body, pad: 'x'.repeat(5000) }), ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(post(body, '/host/mail/queue/action?queueId=ALL'), ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(post(body), { ...ctx, run: null })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(run).not.toHaveBeenCalled()
    expect((await call(new Request('http://agent.local/host/mail/queue/action'), ctx))!.headers.get('allow')).toBe('POST')
  })
  it('refuses dispatch when the pre-dispatch audit fails and flags review when the outcome audit fails', async () => {
    const first = context([deferred], { audit: async () => { throw new Error('db down') } })
    await expect(call(post(body), first.ctx)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(first.run).not.toHaveBeenCalled()
    let audits = 0
    const second = context([deferred, ''], { audit: async () => { if (++audits > 1) throw new Error('db down') } })
    await expect(call(post(body), second.ctx)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { verificationRequired: true, unknownOutcome: true } })
  })
})
