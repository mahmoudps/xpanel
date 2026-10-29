import { describe, expect, it, vi } from 'vitest'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { handleMailboxMaintenanceRoute } from './mailbox-maintenance-routes.ts'
import type { MailboxMaintenanceRouteContext } from './mailbox-maintenance-routes.ts'

const jobId = '22222222-2222-4222-8222-222222222222'
const quota = JSON.stringify([{ root: 'User quota', type: 'STORAGE', value: '2048', limit: '10240', percent: '20' }])
const folders = JSON.stringify([{ mailbox: 'INBOX', messages: '10', vsize: '4096' }])
const many = Array.from({ length: 40 }, (_, index) => 'm' + index + '@alice.example')
const post = (body: unknown, type = 'application/json') => new Request('http://agent.local/host/mail/maintenance/jobs', { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const get = (query = '') => new Request('http://agent.local/host/mail/maintenance' + query)
const call = (req: Request, ctx: MailboxMaintenanceRouteContext) => handleMailboxMaintenanceRoute(req, new URL(req.url), req.method, ctx)
const job = (plan: HostJobPlan): HostJobView => ({ id: jobId, referenceCode: null, kind: plan.kind, status: 'queued', progress: 0, summary: plan.summary, accountId: null, actor: 'root', createdAt: '2026-10-27T10:00:00.000Z', startedAt: null, finishedAt: null, steps: [], error: null, failureClass: null, cancelRequested: false, verification: null, logBytes: 0 })
const context = (plugins = ' quota\n', overrides: Partial<MailboxMaintenanceRouteContext> = {}) => {
  const events: string[] = []
  const run = vi.fn(async (argv: string[]) => { events.push(argv.slice(1).join(' ')); return { ok: true, code: 0, stdout: argv[0] === '/usr/bin/doveconf' ? plugins : argv[3] === 'quota' ? quota : folders } })
  const plans: HostJobPlan[] = []
  const submitJob = vi.fn(async (plan: HostJobPlan) => { plans.push(plan); events.push('submit:' + plan.kind); return job(plan) })
  const ctx: MailboxMaintenanceRouteContext = {
    assertRoot: vi.fn(async (action: string) => { events.push('root:' + action); return { actor: 'root' } }), run,
    readSnapshot: async () => ({ accounts: [{ id: 'a1', username: 'alice', status: 'active' }, { id: 'a2', username: 'bob', status: 'terminating' }],
      serviceUsers: [{ accountId: 'a1', login: 'info@alice.example', services: { email: true }, mailboxQuotaMb: 1024 }, { accountId: 'a1', login: 'ftp@alice.example', services: { email: false }, mailboxQuotaMb: 10 },
        { accountId: 'a2', login: 'gone@bob.example', services: { email: true }, mailboxQuotaMb: 10 }, ...many.map(login => ({ accountId: 'a1', login, services: { email: true }, mailboxQuotaMb: 'unlimited' as const }))] }),
    submitJob, audit: vi.fn(async (entry: { action: string }) => { events.push('audit:' + entry.action) }), now: () => new Date('2026-10-27T10:00:00Z'), ...overrides,
  }
  return { ctx, events, run, submitJob, plans }
}

describe('agent mailbox maintenance routes', () => {
  it('ignores unrelated paths and refuses non-root callers before any host read', async () => {
    const { ctx } = context()
    expect(await call(new Request('http://agent.local/host/mail/server'), ctx)).toBeNull()
    expect(ctx.assertRoot).not.toHaveBeenCalled()
    const denied = context(' quota\n', { assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' }) } })
    for (const req of [get(), get('?mailbox=info@alice.example'), post({ operation: 'resync', mailboxes: ['info@alice.example'] })]) await expect(call(req, denied.ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(denied.run).not.toHaveBeenCalled(); expect(denied.submitJob).not.toHaveBeenCalled()
  })
  it('validates methods, selectors and strict bodies before any host read', async () => {
    const { ctx, run } = context()
    expect((await call(new Request('http://agent.local/host/mail/maintenance', { method: 'DELETE' }), ctx))!.status).toBe(405)
    expect((await call(new Request('http://agent.local/host/mail/maintenance/jobs'), ctx))!.status).toBe(405)
    for (const req of [get('?mailbox=*@alice.example'), get('?mailbox=-A'), get('?mailbox=info@alice.example&mailbox=x@alice.example'), get('?user=info@alice.example'), get('?mailbox=Info@alice.example'),
      new Request('http://agent.local/host/mail/maintenance/jobs?mailbox=info@alice.example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      post({ operation: 'resync', mailboxes: ['info@alice.example'], all: true }), post({ operation: 'purge', mailboxes: ['info@alice.example'] }), post({ operation: 'resync', mailboxes: [] }), post({ operation: 'resync', mailboxes: '*' }),
      post({ operation: 'resync', mailboxes: ['*'] }), post({ operation: 'resync', mailboxes: ['info@alice.example', 'info@alice.example'] }), post({ operation: 'resync', mailboxes: many.slice(0, 33) }),
      post({ operation: 'resync', mailboxes: ['info@alice.example'] }, 'text/plain'), post('{'), post('x'.repeat(17_000))]) await expect(call(req, ctx)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(run).not.toHaveBeenCalled()
  })
  it('stays unavailable without the native executor and returns 404 for mailboxes that are not saved with email', async () => {
    await expect(call(get(), context(' quota\n', { run: null }).ctx)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    const { ctx, run, submitJob } = context()
    for (const req of [get('?mailbox=nobody@alice.example'), get('?mailbox=ftp@alice.example'), get('?mailbox=gone@bob.example'), post({ operation: 'resync', mailboxes: ['info@alice.example', 'ftp@alice.example'] })])
      await expect(call(req, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND', detail: { stateChanged: false } })
    expect(run).not.toHaveBeenCalled(); expect(submitJob).not.toHaveBeenCalled()
  })
  it('reads the mailbox list and one mailbox report with fresh root and no-store', async () => {
    const { ctx, events } = context()
    const list = (await call(get(), ctx))!
    expect(list.headers.get('cache-control')).toBe('no-store')
    const body = await list.json() as { mailboxes: unknown[] }
    expect(body).toMatchObject({ fts: 'not_configured', jobsAvailable: true, mailboxesTruncated: false, report: null })
    expect(body.mailboxes).toHaveLength(41)
    expect(JSON.stringify(body)).not.toContain('gone@bob.example')
    const report = await (await call(get('?mailbox=info@alice.example'), ctx))!.json() as { report: unknown; mailboxes: unknown[] }
    expect(report.report).toMatchObject({ mailbox: 'info@alice.example', account: 'alice', savedQuotaMb: 1024, quota: { state: 'read' }, folders: { state: 'read', totalMessages: 10 } })
    expect(events.slice(-5)).toEqual(['root:mail.maintenance.read', '-h mail_plugins', '-f json quota get -u info@alice.example', '-f json mailbox status -u info@alice.example messages vsize *', 'root:mail.maintenance.read'])
    expect(report.mailboxes).toEqual([{ login: 'info@alice.example', account: 'alice', savedQuotaMb: 1024 }])
    expect(JSON.stringify(report)).not.toContain('passwordHash')
  })
  it('submits one bulk job of saved mailboxes with fresh root, audits it and answers 202', async () => {
    const { ctx, events, plans } = context()
    const response = (await call(post({ operation: 'quota-recalc', mailboxes: ['info@alice.example', ...many.slice(0, 31)] }), ctx))!
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ job: { id: jobId, kind: 'mail.maintenance.quota-recalc', status: 'queued' } })
    expect(plans[0]!.steps).toHaveLength(32)
    expect(events).toEqual(['root:mail.maintenance.submit', 'root:mail.maintenance.submit', 'submit:mail.maintenance.quota-recalc', 'audit:mail.maintenance.quota-recalc_submitted'])
  })
  it('refuses a search index job truthfully unless FTS is configured', async () => {
    const off = context()
    await expect(call(post({ operation: 'index', mailboxes: ['info@alice.example'] }), off.ctx)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, reason: 'fts_not_configured' } })
    const unknown = context(' quota\n', { run: async () => ({ ok: false, code: 1, stdout: '' }) })
    await expect(call(post({ operation: 'index', mailboxes: ['info@alice.example'] }), unknown.ctx)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'fts_unavailable' } })
    expect(off.submitJob).not.toHaveBeenCalled()
    const on = context(' quota fts fts_solr\n')
    expect((await call(post({ operation: 'index', mailboxes: ['info@alice.example'] }), on.ctx))!.status).toBe(202)
    expect(on.plans[0]!.steps[0]!.argv).toEqual(['/usr/bin/doveadm', 'index', '-u', 'info@alice.example', 'INBOX'])
  })
  it('reports a missing runner, a changed actor and an unknown submission truthfully', async () => {
    await expect(call(post({ operation: 'resync', mailboxes: ['info@alice.example'] }), context(' quota\n', { submitJob: null }).ctx)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    let calls = 0
    const changed = context(' quota\n', { assertRoot: async () => ({ actor: calls++ === 0 ? 'root' : 'other' }) })
    await expect(call(post({ operation: 'resync', mailboxes: ['info@alice.example'] }), changed.ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(changed.submitJob).not.toHaveBeenCalled()
    const lost = context(' quota\n', { submitJob: async () => { throw new Error('socket') } })
    await expect(call(post({ operation: 'resync', mailboxes: ['info@alice.example'] }), lost.ctx)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
  })
})
