import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultPlan, type Account, type PhpSettings } from '@xpanel/core'
import { createRootPrincipal, createTestDb } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import { LinuxHostExecutor, type ConfigTestResult } from './executor.ts'
import { HostReconciler } from './reconciler.ts'
import { agentCallerHeaders, createAgentApp } from './server.ts'

const hash = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const token = 'a'.repeat(64)
const php: PhpSettings = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }

describe('native account purge requires positive absence evidence', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  let state: Awaited<ReturnType<typeof createTestStateStore>>
  let rootId: string, account: Account
  let app: ReturnType<typeof createAgentApp>, executor: LinuxHostExecutor
  let commands: string[][]
  let presence: 'present' | 'absent' | 'unknown'
  let commandResult: ConfigTestResult
  beforeAll(async () => {
    db = await createTestDb(); state = await createTestStateStore()
    rootId = (await createRootPrincipal(db.db, { username: 'root', passwordHash: hash, forcePasswordChange: false })).id
    const feature = await state.store.createFeatureList({ name: 'Purge boundary', ownerId: null, disabled: [] })
    const { id: _id, ...seed } = defaultPlan({ name: 'Purge plan', featureListId: feature.id })
    const plan = await state.store.createPlan({ ...seed, shell: 'jailed' })
    await state.store.saveServerIp({ address: '192.0.2.42', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const created = await state.store.createAccount({ username: 'purgetest', passwordHash: hash, primaryDomain: 'purge.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.42', shell: 'jailed', php })
    account = { ...created, status: 'terminating' }
    vi.spyOn(state.store, 'getAccountByUsername').mockResolvedValue(account)
    executor = new LinuxHostExecutor()
    vi.spyOn(executor, 'runCommand').mockImplementation(async argv => {
      commands.push(argv)
      return argv[0] === '/usr/bin/test' ? { ok: false, code: 2, stdout: '', stderr: 'malformed predicate' } : commandResult
    })
    // Override only the observation primitive; no userdel or real home is touched.
    Object.assign(executor, { probeRemovalTarget: async () => presence })
    const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os })
    app = createAgentApp({ db: db.db, store: state.store, executor, reconciler, agentToken: token, os: { id: os.id, family: os.family, versionId: os.versionId } })
  })
  beforeEach(() => { commands = []; presence = 'absent'; commandResult = { ok: true, code: 0, stdout: '', stderr: '' } })
  afterAll(async () => { vi.restoreAllMocks(); await state?.close(); await db?.close() })
  const purge = (override = {}) => app.fetch(new Request('http://agent.local/accounts/purgetest/purge', {
    method: 'POST', headers: { ...agentCallerHeaders({ principalId: rootId, token }), 'content-type': 'application/json' },
    body: JSON.stringify({ confirmUsername: account.username, uid: account.uid, home: account.home, ...override }),
  }))
  it('acknowledges only confirmed absence and never invokes the ambiguous test predicate', async () => {
    const response = await purge()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ purged: true })
    expect(commands).toEqual([['/usr/sbin/userdel', '-r', '--', account.username]])
  })
  it.each(['present', 'unknown'] as const)('refuses %s home evidence', async value => {
    presence = value
    const response = await purge()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ purged: false, reason: value === 'present' ? 'home_still_present' : 'home_presence_unknown' })
  })
  it('refuses mismatched target before any destructive command', async () => {
    expect((await purge({ home: '/home/neighbor' })).status).toBe(409)
    expect(commands).toEqual([])
  })
  it('does not turn a failed user deletion into a successful purge', async () => {
    commandResult = { ok: false, code: 1, stdout: '', stderr: 'permission denied' }
    expect((await purge()).status).toBe(409)
    expect(commands).toHaveLength(1)
  })
})
