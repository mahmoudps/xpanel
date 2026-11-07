import { describe, expect, it, vi } from 'vitest'
import { accountOwnerCheckArgv, accountOwnerRepairArgv, isAccountRepairCommand } from '../../../packages/os/src/account-repair-command.ts'
import { buildAccountRepairPlan, handleAccountRepairRoute } from './account-repair.ts'
import type { AccountRepairRouteContext } from './account-repair.ts'

const alice = { username: 'alice', uid: 1001, gid: 1001, home: '/home/alice' }
const moved = { username: 'bob', uid: 1002, gid: 1002, home: '/home2/bob' }
const ctx = (over: Partial<AccountRepairRouteContext> = {}): AccountRepairRouteContext => ({
  assertRoot: async () => ({ actor: 'root' }), readSnapshot: async () => ({ accounts: [{ ...alice, status: 'active' }, { ...moved, status: 'active' }, { username: 'gone', uid: 1003, gid: 1003, home: '/home/gone', status: 'terminating' }] }),
  run: vi.fn(async () => ({ ok: true, stdout: '/home/alice/public_html/index.php\n' })), submitJob: vi.fn(async plan => ({ id: 'job', kind: plan.kind, status: 'queued' }) as never), ...over,
})
const call = (path: string, body: unknown, context = ctx()) => { const url = new URL('http://agent/host/accounts/repair/' + path); return handleAccountRepairRoute(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url, 'POST', context) }

describe('account repair grammar', () => {
  it('admits exactly the two built commands, for moved homes too', () => {
    for (const identity of [alice, moved]) { expect(isAccountRepairCommand(accountOwnerRepairArgv(identity))).toBe(true); expect(isAccountRepairCommand(accountOwnerCheckArgv(identity))).toBe(true) }
    expect(accountOwnerRepairArgv(alice)).toEqual(['/usr/bin/find', '/home/alice', '-xdev', '!', '-type', 'l', '(', '-type', 'd', '-o', '-links', '1', ')', '(', '!', '-uid', '1001', '-o', '!', '-gid', '1001', ')', '-print', '-execdir', '/usr/bin/chown', '-h', '1001:1001', '{}', '+'])
  })
  it('refuses a system uid, a home outside the roots and a changed command', () => {
    expect(() => accountOwnerRepairArgv({ ...alice, uid: 0 })).toThrow(); expect(() => accountOwnerRepairArgv({ ...alice, home: '/etc' })).toThrow(); expect(() => accountOwnerRepairArgv({ ...alice, home: '/home/bob' })).toThrow()
    const built = accountOwnerRepairArgv(alice)
    expect(isAccountRepairCommand(built.map(item => item === '-xdev' ? '-follow' : item))).toBe(false)
    expect(isAccountRepairCommand([...built.slice(0, 1), '/home/alice/../..', ...built.slice(2)])).toBe(false)
    expect(isAccountRepairCommand(['/usr/bin/chown', '-R', 'root', '/home/alice'])).toBe(false)
  })
  it('verifies each account after the job and fails when a path remains', async () => {
    const plan = buildAccountRepairPlan([alice]), run = vi.fn(async () => ({ ok: true, timedOut: false, stdout: '/home/alice/x\n' }))
    expect(plan.steps).toHaveLength(1); expect(plan.policy!(plan.steps[0]!.argv)).toBe(true)
    expect((await plan.verify!(run as never)).ok).toBe(false)
    expect((await plan.verify!(vi.fn(async () => ({ ok: true, timedOut: false, stdout: '' })) as never)).ok).toBe(true)
  })
})

describe('account repair route', () => {
  it('previews wrong ownership with the first path as evidence', async () => {
    expect(await (await call('preview', { accounts: ['alice'] }))!.json()).toEqual({ accounts: [{ username: 'alice', ownership: 'problem', sample: '/home/alice/public_html/index.php' }] })
    const clean = ctx({ run: async () => ({ ok: true, stdout: '' }) })
    expect(await (await call('preview', { accounts: ['bob'] }, clean))!.json()).toMatchObject({ accounts: [{ ownership: 'ok', sample: null }] })
    const failed = ctx({ run: async () => { throw new Error('timeout') } })
    expect(await (await call('preview', { accounts: ['alice'] }, failed))!.json()).toMatchObject({ accounts: [{ ownership: 'unavailable' }] })
  })
  it('starts one job for saved accounts only', async () => {
    const context = ctx(), response = await call('run', { accounts: ['alice', 'bob'] }, context)
    expect(response!.status).toBe(202); expect(await response!.json()).toMatchObject({ accounts: 2, job: { id: 'job' } })
    const plan = vi.mocked(context.submitJob!).mock.calls[0]![0]
    expect(plan.kind).toBe('accounts.repair.ownership'); expect(plan.steps).toHaveLength(2)
    await expect(call('run', { accounts: ['gone'] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('refuses bad input and a host without jobs', async () => {
    for (const body of [{}, { accounts: [] }, { accounts: ['../x'] }, { accounts: ['alice', 'alice'] }, { accounts: ['alice'], extra: 1 }]) await expect(call('run', body), JSON.stringify(body)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('run', { accounts: ['alice'] }, ctx({ submitJob: null }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call('preview', { accounts: ['alice'] }, ctx({ run: null }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
