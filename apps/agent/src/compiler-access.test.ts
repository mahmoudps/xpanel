import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { suggestServerSettings } from '@xpanel/core'
import type { Account, Plan } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { system } from '@xpanel/render'
import { createTestStateStore } from '@xpanel/state'
import { compilerAccessInput, compilerAccessMembers, observeCompilerAccess, readCompilerAccessPolicy } from './compiler-access.ts'
import { createProductionHostTargetMatcher } from './executor.ts'
import { compileDesiredGeneration } from './reconciler.ts'
import { SEC_COMPILER_ACCESS_STATE, parseSecCompilerAccessPolicy } from './sec-policy.ts'

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333', GONE = '44444444-4444-4444-8444-444444444444'
const plans = [{ id: 'none', shell: 'none' }, { id: 'jail', shell: 'jailed' }] as Plan[]
const accounts = [
  { id: A, username: 'alice', status: 'active', shell: 'jailed', planId: 'none' },
  { id: B, username: 'bob', status: 'active', shell: 'jailed', planId: 'jail' },
  { id: C, username: 'carol', status: 'terminating', shell: 'none', planId: 'none' },
] as Account[]
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const saved = async (policy: unknown): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'xpanel-compiler-access-')); roots.push(root)
  if (policy !== undefined) { await mkdir(join(root, 'extended/server'), { recursive: true }); await writeFile(join(root, SEC_COMPILER_ACCESS_STATE), JSON.stringify({ version: 1, policy, updatedAt: '2026-11-06T00:00:00.000Z' })) }
  return root
}

describe('compiler access policy and members', { tags: ['unit'] }, () => {
  it('grants existing accounts, keeps jailed shells restricted and drops deleted or terminating ones', () => {
    expect(compilerAccessMembers({ accounts, plans }, { restricted: true, accountIds: [A, B, C, GONE] })).toEqual({ members: ['alice'], excluded: [{ username: 'bob', reason: 'jailed_shell' }] })
    expect(compilerAccessMembers({ accounts: [{ ...accounts[0]!, planId: 'missing' }], plans }, { restricted: true, accountIds: [A] }).excluded).toEqual([{ username: 'alice', reason: 'jailed_shell' }])
  })
  it('parses only the canonical policy', () => {
    expect(parseSecCompilerAccessPolicy({ restricted: true, accountIds: [B, A] })).toEqual({ restricted: true, accountIds: [A, B] })
    for (const bad of [{ restricted: 'yes', accountIds: [] }, { restricted: true, accountIds: ['alice'] }, { restricted: true, accountIds: [A, A] }, { restricted: true }, { restricted: true, accountIds: [], extra: 1 }]) expect(() => parseSecCompilerAccessPolicy(bad), JSON.stringify(bad)).toThrow()
  })
  it('reads nothing when never saved and refuses an invalid saved file', async () => {
    expect(await readCompilerAccessPolicy(await saved(undefined))).toBeNull()
    expect(await compilerAccessInput(await saved(undefined), 'debian', { accounts, plans })).toBeNull()
    await expect(readCompilerAccessPolicy(await saved({ restricted: 'yes' }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const root = await saved({ restricted: true, accountIds: [A] })
    expect(await compilerAccessInput(root, 'rhel', { accounts, plans }, async () => false)).toEqual({ restricted: true, members: ['alice'], packageHook: false })
    expect(await compilerAccessInput(root, 'debian', { accounts, plans }, async (path, kind) => path === '/etc/dpkg/dpkg.cfg.d' && kind === 'directory')).toEqual({ restricted: true, members: ['alice'], packageHook: true })
    // A removed dnf plugin leaves its action directory behind while our action is in it; only its configuration proves it is installed.
    const plugin = { '/etc/dnf/plugins/post-transaction-actions.d': 'directory', '/etc/dnf/plugins/post-transaction-actions.conf': 'file' } as Record<string, string>
    expect(await compilerAccessInput(root, 'rhel', { accounts, plans }, async (path, kind) => plugin[path] === kind)).toMatchObject({ packageHook: true })
    expect(await compilerAccessInput(root, 'rhel', { accounts, plans }, async (path, kind) => kind === 'directory' && plugin[path] === kind)).toMatchObject({ packageHook: false })
    expect(await compilerAccessInput(await saved({ restricted: false, accountIds: [A] }), 'debian', { accounts, plans }, async () => true)).toMatchObject({ restricted: false, packageHook: false })
  })
  it('admits exactly the script and hook files', () => {
    const matcher = createProductionHostTargetMatcher()
    for (const path of [system.COMPILER_ACCESS_SCRIPT, system.COMPILER_ACCESS_HOOKS.debian, system.COMPILER_ACCESS_HOOKS.rhel]) for (const op of ['read', 'write', 'remove'] as const) expect(matcher(path, op), path + ' ' + op).toBe(true)
    for (const path of ['/usr/bin/gcc', '/etc/dpkg/dpkg.cfg.d/other', '/usr/local/sbin/other']) expect(matcher(path, 'write'), path).toBe(false)
  })
})

describe('compiler access observation', { tags: ['unit'] }, () => {
  const run = (row: string | null) => async () => row === null ? { ok: false, code: 2, stdout: '' } : { ok: true, code: 0, stdout: row + '\n' }
  const restrictedStat = async (path: string) => path.endsWith('/ld') ? null : { uid: 0, gid: 990, mode: 0o750 }
  it('reports applied only when every present command, the members and the hook match', async () => {
    const root = await saved({ restricted: true, accountIds: [A, B] })
    const view = await observeCompilerAccess({ root, family: 'debian', snapshot: { accounts, plans }, run: run('xpanel-compilers:x:990:alice'), statPath: restrictedStat, present: async () => true, now: () => new Date('2026-11-06T00:00:00.000Z') })
    expect(view).toMatchObject({ state: 'applied', group: { exists: true, gid: 990, members: ['alice'] }, expected: { members: ['alice'], excluded: [{ username: 'bob', reason: 'jailed_shell' }] }, hook: { mechanism: 'dpkg-post-invoke', available: true, installed: true } })
    expect(view.commands.find(command => command.name === 'ld')).toEqual({ name: 'ld', present: false, restricted: null, mode: null })
    const open = await observeCompilerAccess({ root, family: 'debian', snapshot: { accounts, plans }, run: run('xpanel-compilers:x:990:alice'), statPath: async () => ({ uid: 0, gid: 0, mode: 0o755 }), present: async () => true })
    expect(open.state).toBe('drift')
    const missingGroup = await observeCompilerAccess({ root, family: 'rhel', snapshot: { accounts, plans }, run: run(null), statPath: restrictedStat, present: async () => false })
    expect(missingGroup).toMatchObject({ state: 'drift', group: { exists: false }, hook: { mechanism: 'dnf-post-transaction-actions', available: false, installed: false } })
  })
  it('is unmanaged until saved, and enabled-for-all is applied when no command is restricted', async () => {
    expect((await observeCompilerAccess({ root: await saved(undefined), family: 'debian', snapshot: { accounts, plans }, run: run(null), statPath: async () => ({ uid: 0, gid: 0, mode: 0o755 }), present: async () => false })).state).toBe('unmanaged')
    const enabled = await observeCompilerAccess({ root: await saved({ restricted: false, accountIds: [] }), family: 'debian', snapshot: { accounts, plans }, run: run('xpanel-compilers:x:990:'), statPath: async () => ({ uid: 0, gid: 0, mode: 0o755 }), present: async (path, kind) => kind === 'directory' })
    expect(enabled).toMatchObject({ state: 'applied', group: { members: [] } })
  })
})

describe('compiler access in the generation', { tags: ['feature'] }, () => {
  it('adds the script, the hook and its run after provisioning only when saved', async () => {
    const state = await createTestStateStore()
    try {
      const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
      await state.store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
      const snapshot = await state.store.readSnapshot(), os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
      const plain = compileDesiredGeneration(snapshot, { os })
      expect(plain.files.some(file => file.path === system.COMPILER_ACCESS_SCRIPT)).toBe(false)
      const locked = compileDesiredGeneration(snapshot, { os, compilerAccess: { restricted: true, members: ['alice'], packageHook: true } })
      expect(locked.files.map(file => file.path)).toEqual(expect.arrayContaining([system.COMPILER_ACCESS_SCRIPT, system.COMPILER_ACCESS_HOOKS.debian]))
      expect(locked.postActions.at(-1)).toEqual({ kind: 'exec', argv: [system.COMPILER_ACCESS_SCRIPT] })
    } finally { await state.close() }
  })
})
