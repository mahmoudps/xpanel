import { describe, expect, it } from 'vitest'
import { MAILBOX_REPAIR_ACCOUNTS_PER_JOB, buildMailboxRepairPlans, handleMailboxRepairRoute } from './mailbox-repair.ts'
import type { HostJobPlan } from './host-job-contract.ts'

const account = (index: number) => ({ id: 'a' + index, username: 'user' + index, uid: 1000 + index, gid: 1000 + index, home: '/home/user' + index, status: 'active' })
const post = (body: unknown, path = '/host/mail/maintenance/repair', method = 'POST') => new Request('http://agent' + path, { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
const ctx = (accounts = [account(1), account(2)], submitted: HostJobPlan[] = [], overrides = {}) => ({
  assertRoot: async () => ({ actor: 'root' }), readSnapshot: async () => ({ accounts, serviceUsers: accounts.filter(item => item.id !== 'a9').map(item => ({ accountId: item.id, services: { email: true } })) }),
  submitJob: async (plan: HostJobPlan) => { submitted.push(plan); return { id: 'job-' + submitted.length, kind: plan.kind, status: 'queued' } as never }, ...overrides })
const call = (body: unknown, context: ReturnType<typeof ctx>, method = 'POST') => { const req = post(body, undefined, method); return handleMailboxRepairRoute(req, new URL(req.url), method, context) }

describe('mailbox repair plans', () => {
  it('pages accounts so a job stays within the 32 step limit', () => {
    const plans = buildMailboxRepairPlans(Array.from({ length: MAILBOX_REPAIR_ACCOUNTS_PER_JOB + 1 }, (_, index) => account(index + 1)))
    expect(plans).toHaveLength(2)
    expect(plans[0]!.steps).toHaveLength(30)
    expect(plans[1]!.steps.map(step => step.id)).toEqual(['owner-1', 'directories-1', 'files-1'])
    for (const plan of plans) for (const step of plan.steps) expect(plan.policy(step.argv)).toBe(true)
  })
  it('passes verification only when no repaired path is left', async () => {
    const [plan] = buildMailboxRepairPlans([account(1)])
    const run = (stdout: string) => async () => ({ ok: true, code: 0, stdout, stderr: '', timedOut: false })
    expect((await plan!.verify!(run('')))).toMatchObject({ ok: true })
    expect((await plan!.verify!(run('/home/user1/mail/x\n')))).toMatchObject({ ok: false })
  })
  it('refuses an empty or repeated selection', () => {
    expect(() => buildMailboxRepairPlans([])).toThrow()
    expect(() => buildMailboxRepairPlans([account(1), account(1)])).toThrow()
  })
})

describe('mailbox repair route', () => {
  it('queues all saved accounts and leaves out one being removed', async () => {
    const submitted: HostJobPlan[] = []
    const response = await call({ accounts: 'all' }, ctx([account(1), { ...account(2), status: 'terminating' }], submitted))
    expect(response!.status).toBe(202)
    expect(await response!.json()).toMatchObject({ accounts: 1, jobs: [{ id: 'job-1' }] })
    expect(submitted[0]!.fingerprint).toEqual({ accounts: ['user1'] })
  })
  it('leaves out an account without a mailbox, which has no mail directory', async () => {
    const submitted: HostJobPlan[] = []
    await call({ accounts: 'all' }, ctx([account(1), account(9)], submitted))
    expect(submitted[0]!.fingerprint).toEqual({ accounts: ['user1'] })
    await expect(call({ accounts: ['user9'] }, ctx([account(1), account(9)]))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('takes identities from saved state and refuses an unknown account', async () => {
    await expect(call({ accounts: ['ghost'] }, ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call({ accounts: ['user1'], uid: 0 }, ctx())).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call({ accounts: ['../etc'] }, ctx())).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('reports a missing job runner without starting anything', async () => {
    await expect(call({ accounts: 'all' }, ctx(undefined, undefined, { submitJob: null }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('allows POST only', async () => {
    expect((await call({}, ctx(), 'GET'))!.status).toBe(405)
  })
})
