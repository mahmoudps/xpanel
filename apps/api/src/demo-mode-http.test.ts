import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Account, PhpSettings } from '@xpanel/core'
import { createApiToken, createTestDb, createUserPrincipal } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { hashPasswordArgon2id, sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'
import type { ApiApp } from './server.ts'

const SERVER_SECRET = 'test-only-demo-mode-server-secret-at-least-32-bytes'
const php: PhpSettings = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
let passwordHash: string
beforeAll(async () => { passwordHash = await hashPasswordArgon2id('GeneratedFixturePassword!') })

describe('demo mode at the API boundary', { tags: ['feature'] }, () => {
  let db: TestDbHandle, state: TestStateStoreHandle, app: ApiApp, alice: Account, bob: Account
  const tokens: Record<string, string> = {}
  beforeEach(async () => {
    db = await createTestDb()
    state = await createTestStateStore()
    const featureListId = (await state.store.createFeatureList({ name: 'Fixture features', ownerId: null, disabled: [] })).id
    const plan = await state.store.createPlan({ name: 'Fixture plan', ownerId: null, featureListId, resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }, caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 10, forwarders: 10, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
    await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    alice = await state.store.createAccount({ username: 'alice', passwordHash, primaryDomain: 'alice.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@alice.example.test', ipv4: '192.0.2.10', shell: 'none', php })
    bob = await state.store.createAccount({ username: 'bobby', passwordHash, primaryDomain: 'bob.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@bob.example.test', ipv4: '192.0.2.10', shell: 'none', php })
    for (const account of [alice, bob]) {
      const principalId = (await createUserPrincipal(db.db, { username: account.username, accountId: account.id, passwordHash })).id
      tokens[account.username] = `xp_${randomUUID()}`
      await createApiToken(db.db, { principalId, name: 'Fixture token', tokenHash: sha256Hex(tokens[account.username]!), scopes: ['*'], expiresAt: new Date(Date.now() + 60000).toISOString() })
    }
    app = createApiApp({ db: db.db, store: state.store, serverSecret: SERVER_SECRET })
  })
  afterEach(async () => { await state.close(); await db.close() })

  const demo = (accountIds: string[]) => atomicWriteJson(join(state.store.rootDir, 'extended', 'panel', 'demo-mode.json'), { version: 1, accountIds: accountIds.sort(), updatedAt: '2026-11-07T08:00:00.000Z' }, 0o640)
  const call = (who: string, path: string, method = 'GET', body?: unknown) => app.fetch(new Request(`http://localhost${path}`, { method,
    headers: { authorization: `Bearer ${tokens[who]}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  const reason = async (response: Response): Promise<unknown> => ((await response.json()) as { details?: { reason?: unknown } }).details?.reason

  it('refuses every write of the demo account with demo_mode_readonly while its reads and other accounts keep working', async () => {
    await demo([alice.id])
    expect((await call('alice', '/api/account/preferences')).status).toBe(200)
    expect(await (await call('alice', '/api/account/plugins')).json()).toEqual({ items: [] })
    const write = await call('alice', '/api/account/preferences', 'PATCH', { contactEmail: 'changed@alice.example.test' })
    expect(write.status).toBe(403)
    expect(await reason(write)).toBe('demo_mode_readonly')
    const files = await call('alice', `/api/accounts/${alice.username}/files`, 'POST', { op: 'write', path: 'public_html/index.html', content: 'x' })
    expect(files.status).toBe(403)
    expect(await reason(files)).toBe('demo_mode_readonly')
    expect(await reason(await call('bobby', '/api/account/preferences', 'PATCH', { contactEmail: 'changed@bob.example.test' }))).not.toBe('demo_mode_readonly')
    expect((await state.store.getAccount(alice.id))?.contactEmail).toBe('owner@alice.example.test')
    await demo([])
    expect(await reason(await call('alice', '/api/account/preferences', 'PATCH', { contactEmail: 'changed@alice.example.test' }))).not.toBe('demo_mode_readonly')
  })
})
