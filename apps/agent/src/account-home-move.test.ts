import { describe, expect, it, vi } from 'vitest'
import { createHomeMovePlan, homeMoveSteps, planHomeMove, readHomeRoots, recoverHomeMove } from './account-home-move.ts'
import type { HomeMoveEffects, HomeMoveHost, HomeMoveTarget } from './account-home-move.ts'

const account = { id: 'a', username: 'alice', home: '/home/alice' }
const host = (over: Partial<HomeMoveHost> = {}): HomeMoveHost => ({
  listRoots: async () => ['/home', '/home2'], usedKb: async () => 1000, freeKb: async () => 100000,
  device: async path => path === '/home/alice' || path === '/home' ? 1n : path === '/home2' ? 2n : null, ...over })
const target = (sameFilesystem = false): HomeMoveTarget => ({ from: '/home/alice', to: '/home2/alice', staging: '/home2/.xpanel-move-alice', sameFilesystem })
const effects = (over: Partial<HomeMoveEffects> = {}): HomeMoveEffects & Record<'finish' | 'cancel' | 'remove' | 'rewritePaths', ReturnType<typeof vi.fn>> => ({ finish: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), rewritePaths: vi.fn(async () => undefined), ...over }) as never
const ran = (steps: readonly { id: string }[], ok = true) => steps.map(item => ({ id: item.id, result: { ok, code: ok ? 0 : 1, timedOut: false, stdout: '', stderr: '' } }))

describe('Rearrange an Account', () => {
  it('lists only the home roots of the host', async () => {
    expect((await readHomeRoots(host({ listRoots: async () => ['/home2', '/home', '/homes', '/home100'] }))).map(root => root.path)).toEqual(['/home', '/home2'])
  })
  it('copies across filesystems and renames on the same one', async () => {
    expect(await planHomeMove(account, '/home2', host())).toEqual(target())
    expect((await planHomeMove(account, '/home2', host({ device: async path => path.includes('alice') && path.startsWith('/home2') ? null : 1n }))).sameFilesystem).toBe(true)
    expect(homeMoveSteps(target()).map(step => step.argv[0])).toEqual(['/usr/bin/cp', '/usr/bin/diff', '/usr/bin/mv'])
    expect(homeMoveSteps(target(true)).map(step => step.argv)).toEqual([['/usr/bin/mv', '-T', '--', '/home/alice', '/home2/alice']])
  })
  it('refuses before anything stops', async () => {
    await expect(planHomeMove(account, '/etc', host())).rejects.toMatchObject({ detail: { reason: 'invalid_home_root' } })
    await expect(planHomeMove(account, '/home3', host())).rejects.toMatchObject({ detail: { reason: 'invalid_home_root' } })
    await expect(planHomeMove(account, '/home', host())).rejects.toMatchObject({ detail: { reason: 'home_unchanged' } })
    await expect(planHomeMove(account, '/home2', host({ device: async () => 1n }))).rejects.toMatchObject({ detail: { reason: 'home_exists' } })
    await expect(planHomeMove(account, '/home2', host({ freeKb: async () => 1050 }))).rejects.toMatchObject({ detail: { reason: 'home_space' } })
    await expect(planHomeMove(account, '/home2', host({ usedKb: async () => null }))).rejects.toMatchObject({ detail: { reason: 'home_space' } })
  })
  it('removes the old home only after the new one was applied', async () => {
    const calls: string[] = [], fx = effects({ finish: vi.fn(async () => { calls.push('finish') }), remove: vi.fn(async (path: string) => { calls.push('remove ' + path) }) })
    const plan = createHomeMovePlan(account, target(), fx, async () => undefined)
    expect(await plan.finalize!(vi.fn() as never, ran(plan.steps) as never)).toEqual({ ok: true, detail: { home: '/home2/alice' } })
    expect(calls).toEqual(['finish', 'remove /home/alice'])
    expect(fx.rewritePaths).toHaveBeenCalledWith('/home/alice', '/home2/alice')
  })
  it('keeps the old home and returns the account when a step failed', async () => {
    const fx = effects(), plan = createHomeMovePlan(account, target(), fx, async () => undefined)
    const verdict = await plan.finalize!(vi.fn() as never, ran(plan.steps.slice(0, 2), false) as never)
    expect(verdict.ok).toBe(false)
    expect(fx.cancel).toHaveBeenCalledOnce()
    expect(fx.finish).not.toHaveBeenCalled()
    expect(fx.remove).toHaveBeenCalledExactlyOnceWith('/home2/.xpanel-move-alice')
  })
  it('never deletes the old home when the new one did not apply', async () => {
    const fx = effects({ finish: vi.fn(async () => { throw new Error('reconcile') }) }), plan = createHomeMovePlan(account, target(), fx, async () => undefined)
    expect(await plan.finalize!(vi.fn() as never, ran(plan.steps) as never)).toMatchObject({ ok: false, detail: { stage: 'finish', previous: '/home/alice' } })
    expect(fx.remove).not.toHaveBeenCalled()
  })
  it('labels the new tree on an SELinux host before the account returns', async () => {
    const fx = effects(), plan = createHomeMovePlan(account, target(), fx, async () => undefined, true), run = vi.fn(async (_item: { argv: string[] }) => ({ ok: true, code: 0, timedOut: false, stdout: '', stderr: '' }))
    await plan.finalize!(run as never, ran(plan.steps) as never)
    expect(run.mock.calls.map(([item]) => item.argv)).toEqual([['/usr/sbin/semanage', 'fcontext', '-a', '-e', '/home', '/home2'], ['/usr/sbin/restorecon', '-R', '--', '/home2/alice']])
    expect(plan.policy(['/usr/sbin/restorecon', '-R', '--', '/home2/alice'])).toBe(true)
  })
  it('recovers a dead move from what is on disk', async () => {
    const moving = { ...account, homeMove: { to: '/home2/alice' } }
    const finished = effects()
    expect(await recoverHomeMove(moving, { device: async () => 1n }, finished)).toBe('finished')
    expect(finished.finish).toHaveBeenCalledOnce()
    expect(finished.remove).toHaveBeenCalledExactlyOnceWith('/home/alice')
    const cancelled = effects()
    expect(await recoverHomeMove(moving, { device: async path => path === '/home/alice' ? 1n : null }, cancelled)).toBe('cancelled')
    expect(cancelled.cancel).toHaveBeenCalledOnce()
    expect(cancelled.finish).not.toHaveBeenCalled()
    expect(cancelled.remove).toHaveBeenCalledExactlyOnceWith('/home2/.xpanel-move-alice')
    await expect(recoverHomeMove(account, { device: async () => 1n }, effects())).rejects.toMatchObject({ detail: { reason: 'not_moving' } })
  })
  it('finishes the move and reports a password path it could not rewrite', async () => {
    const fx = effects({ rewritePaths: vi.fn(async () => { throw new Error('helper') }) }), plan = createHomeMovePlan(account, target(), fx, async () => undefined)
    expect(await plan.finalize!(vi.fn() as never, ran(plan.steps) as never)).toMatchObject({ ok: false, detail: { stage: 'directory-privacy', home: '/home2/alice' } })
    expect(fx.finish).toHaveBeenCalledOnce()
    expect(fx.remove).toHaveBeenCalledExactlyOnceWith('/home/alice')
  })
  it('admits only the exact commands of this move', () => {
    const plan = createHomeMovePlan(account, target(), effects(), async () => undefined)
    expect(plan.policy(plan.steps[0]!.argv)).toBe(true)
    expect(plan.policy(['/usr/bin/cp', '-a', '--', '/etc', '/home2/x'])).toBe(false)
  })
})
