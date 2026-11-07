import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOOKS_DIRECTORY, HOOKS_STATE_PATH, handleLifecycleHooksRoute, hookArgv, inspectHookExecutable, parseHookEvent, parseHookRegistry, runLifecycleHooks } from './lifecycle-hooks.ts'
import type { HookEntry, HookRunner, LifecycleHooksRouteContext } from './lifecycle-hooks.ts'
import type { FileFacts, UpgradeHostFs } from './upgrade-observation.ts'

const script = Buffer.from('#!/bin/sh\nexit 0\n')
const digest = createHash('sha256').update(script).digest('hex')
const file = (mode: number, uid = 0): FileFacts => ({ kind: 'file', uid, mode, size: script.length, nlink: 1, dev: 1, ino: 7, mtimeMs: 1, ctimeMs: 1 })
const directory: FileFacts = { kind: 'directory', uid: 0, mode: 0o755, size: 0, nlink: 2, dev: 1, ino: 2, mtimeMs: 1, ctimeMs: 1 }
/** Root-owned reviewed directory tree with one file per name; anything else is absent. */
function fakeFs(files: Record<string, FileFacts>): UpgradeHostFs {
  return {
    lstat: async path => files[path] ?? (Object.keys(files).some(name => name.startsWith(path === '/' ? '/' : path + '/')) ? directory : null),
    read: async path => ({ facts: files[path]!, bytes: script }),
    sha256: async () => { throw new Error('unused') }, list: async () => null, readlink: async () => null, freeBytes: async () => 0,
  }
}
const hook = (patch: Partial<HookEntry>): HookEntry => ({ id: '11111111-1111-4111-8111-111111111111', point: 'account.suspend', stage: 'pre', executable: HOOKS_DIRECTORY + '/notify',
  sha256: digest, args: ['--tag', 'x'], timeoutSeconds: 5, enabled: true, blocking: false, description: 'Notify', ...patch })
const event = { point: 'account.suspend' as const, stage: 'pre' as const, account: { id: '22222222-2222-4222-8222-222222222222', username: 'alice', primaryDomain: 'alice.example.test' }, enhancements: { 'priority-support': true as const, 'extra-sites': 3 } }
let root = ''
const save = async (hooks: HookEntry[]) => { const path = join(root, HOOKS_STATE_PATH); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ version: 1, hooks, updatedAt: '2026-11-07T08:00:00.000Z' })) }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-hooks-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('lifecycle hooks', { tags: ['unit'] }, () => {
  it('admits only strict registry entries from the reviewed directory', () => {
    const record = (hooks: unknown[]) => ({ version: 1, hooks, updatedAt: '2026-11-07T08:00:00.000Z' })
    expect(parseHookRegistry(record([hook({})]))).toEqual([hook({})])
    for (const bad of [{ executable: '/tmp/notify' }, { executable: HOOKS_DIRECTORY + '/../notify' }, { stage: 'pre', point: 'account.create' }, { blocking: true, stage: 'post' },
      { timeoutSeconds: 61 }, { args: ['a\nb'] }, { args: Array.from({ length: 17 }, () => 'a') }, { sha256: 'A'.repeat(64) }])
      expect(parseHookRegistry(record([hook(bad as Partial<HookEntry>)])), JSON.stringify(bad)).toBeNull()
    expect(parseHookRegistry(record([hook({}), hook({})]))).toBeNull()
    expect(hookArgv(hook({}))).toEqual(['/usr/bin/setpriv', '--reuid', '65534', '--regid', '65534', '--clear-groups', '--no-new-privs', '--', HOOKS_DIRECTORY + '/notify', '--tag', 'x'])
  })

  it('pins only root-owned files that nobody can read and execute and nobody else can change', async () => {
    const path = HOOKS_DIRECTORY + '/notify'
    expect(await inspectHookExecutable(path, fakeFs({ [path]: file(0o755) }))).toEqual({ sha256: digest, bytes: script.length })
    expect(await inspectHookExecutable(path, fakeFs({ [path]: file(0o775) }))).toEqual({ reason: 'hook_executable_untrusted' })
    expect(await inspectHookExecutable(path, fakeFs({ [path]: file(0o755, 1000) }))).toEqual({ reason: 'hook_executable_untrusted' })
    expect(await inspectHookExecutable(path, fakeFs({ [path]: file(0o750) }))).toEqual({ reason: 'hook_executable_mode' })
    expect(await inspectHookExecutable(path, fakeFs({ [path]: file(0o4755) }))).toEqual({ reason: 'hook_executable_mode' })
    expect(await inspectHookExecutable(path, fakeFs({}))).toEqual({ reason: 'hook_executable_missing' })
    expect(await inspectHookExecutable('/usr/bin/id', fakeFs({}))).toEqual({ reason: 'hook_path_not_reviewed' })
  })

  it('runs enabled hooks of the event in order, skips disabled ones, refuses a changed file and stops at a failing blocking hook', async () => {
    const first = hook({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', executable: HOOKS_DIRECTORY + '/first' })
    const disabled = hook({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', executable: HOOKS_DIRECTORY + '/off', enabled: false })
    const changed = hook({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', executable: HOOKS_DIRECTORY + '/changed', sha256: '0'.repeat(64) })
    const gate = hook({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', executable: HOOKS_DIRECTORY + '/gate', blocking: true })
    const last = hook({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', executable: HOOKS_DIRECTORY + '/last' })
    const post = hook({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', stage: 'post', executable: HOOKS_DIRECTORY + '/post' })
    await save([first, disabled, changed, gate, last, post])
    const fs = fakeFs(Object.fromEntries(['first', 'off', 'changed', 'gate', 'last', 'post'].map(name => [HOOKS_DIRECTORY + '/' + name, file(0o755)])))
    const calls: { argv: readonly string[]; stdin: string; timeoutMs: number }[] = []
    const runner: HookRunner = { run: async (argv, stdin, timeoutMs) => { calls.push({ argv, stdin, timeoutMs }); return { exitCode: argv[8]!.endsWith('/gate') ? 3 : 0, timedOut: false } } }
    const audit = vi.fn(async () => undefined)
    const outcome = await runLifecycleHooks({ rootDir: root, event, actor: 'root', runner, fs, audit, now: () => new Date('2026-11-07T09:00:00.000Z') })
    expect(calls.map(call => call.argv[8])).toEqual([HOOKS_DIRECTORY + '/first', HOOKS_DIRECTORY + '/gate'])
    expect(JSON.parse(calls[0]!.stdin)).toEqual({ event: 'account.suspend', stage: 'pre', actor: 'root', occurredAt: '2026-11-07T09:00:00.000Z', account: { username: 'alice', domain: 'alice.example.test' }, enhancements: { 'priority-support': true, 'extra-sites': 3 } })
    expect(calls[0]!.timeoutMs).toBe(5000)
    expect(outcome.blocked).toBe(gate.id)
    expect(outcome.results.map(result => [result.id, result.outcome, result.reason])).toEqual([[first.id, 'ok', null], [changed.id, 'refused', 'hook_executable_changed'], [gate.id, 'failed', null]])
    expect(audit).toHaveBeenCalledTimes(3)
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'server.hook.ran', target: 'hook:' + gate.id, outcome: 'failed', detail: expect.objectContaining({ exitCode: 3, account: 'alice' }) }))
    const timeout: HookRunner = { run: async () => ({ exitCode: null, timedOut: true }) }
    expect((await runLifecycleHooks({ rootDir: root, event: { ...event, stage: 'post' }, actor: 'root', runner: timeout, fs, audit })).results).toEqual([expect.objectContaining({ id: post.id, outcome: 'timeout', exitCode: null })])
  })

  it('accepts only bounded enhancement values in an event, and null when they cannot be verified', () => {
    expect(parseHookEvent(event).enhancements).toEqual(event.enhancements)
    expect(parseHookEvent({ ...event, enhancements: null }).enhancements).toBeNull()
    for (const enhancements of [undefined, [], { 'Bad Id': true }, { ok: false }, { ok: -1 }, { ok: 1.5 }, { ok: 'x' }, Object.fromEntries(Array.from({ length: 51 }, (_, index) => ['e' + index, true]))])
      expect(() => parseHookEvent({ ...event, enhancements }), JSON.stringify(enhancements)).toThrow()
  })

  it('serves observation, inspection and runs to root, runs to resellers, and nothing without the native runner', async () => {
    const path = HOOKS_DIRECTORY + '/notify'
    await save([hook({})])
    const ctx = (role: string, runner: HookRunner | null = { run: async () => ({ exitCode: 0, timedOut: false }) }): LifecycleHooksRouteContext => ({
      authenticate: async () => ({ principalId: '33333333-3333-4333-8333-333333333333', actor: role, role }), rootDir: root, runner, fs: fakeFs({ [path]: file(0o755) }), audit: async () => undefined })
    const call = (pathname: string, method: string, body: unknown, context: LifecycleHooksRouteContext) => handleLifecycleHooksRoute(new Request('http://agent' + pathname, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL('http://agent' + pathname), method, context)
    expect(await (await call('/host/hooks', 'GET', undefined, ctx('root')))!.json()).toEqual({ directory: HOOKS_DIRECTORY, hooks: [{ id: hook({}).id, state: 'reviewed' }] })
    expect(await (await call('/host/hooks/inspect', 'POST', { executable: path }, ctx('root')))!.json()).toEqual({ executable: path, state: 'reviewed', sha256: digest, bytes: script.length })
    expect(await (await call('/host/hooks/inspect', 'POST', { executable: HOOKS_DIRECTORY + '/absent' }, ctx('root')))!.json()).toEqual({ executable: HOOKS_DIRECTORY + '/absent', state: 'refused', reason: 'hook_executable_missing' })
    await expect(call('/host/hooks/inspect', 'POST', { executable: '/bin/sh' }, ctx('root'))).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'hook_path_not_reviewed' } })
    await expect(call('/host/hooks/inspect', 'POST', { executable: path }, ctx('reseller'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await (await call('/host/hooks/run', 'POST', event, ctx('reseller')))!.json()).toMatchObject({ blocked: null, results: [{ outcome: 'ok' }] })
    await expect(call('/host/hooks/run', 'POST', event, ctx('user'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('/host/hooks/run', 'POST', { ...event, stage: 'pre', point: 'account.create' }, ctx('root'))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/host/hooks', 'GET', undefined, ctx('root', null))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'hooks_unavailable' } })
    expect(await call('/host/other', 'GET', undefined, ctx('root'))).toBeNull()
  })
})
