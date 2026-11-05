import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApiToken, createResellerPrincipal, createRootPrincipal, createTestDb, listAudit, listJobs, setTotpSecret } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { AgentApp } from '@xpanel/agent'
import { ACCOUNT_BULK_LIMIT } from './account-bulk-actions.ts'
import { createApiApp } from './server.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: (() => Promise<unknown>)[] = []
afterAll(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** Built once per file: real API authorization and single-account use cases over an in-process fake agent that only acknowledges applies. */
const fixture = async () => {
  const database = await createTestDb()
  const state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const { store } = state
  const features = await store.createFeatureList({ name: 'Bulk features', ownerId: null, disabled: [] })
  const plan = await store.createPlan({ name: 'Bulk plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
    caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 4 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await store.saveServerIp({ address: '192.0.2.42', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })
  const resellerInput = { passwordHash: HASH, acl: ['list-accounts', 'edit-account', 'suspend-account', 'terminate-account', 'change-plan'] as const, maxAccounts: 100, totalDiskMb: 1000000, totalBandwidthMb: 'unlimited' as const, oversell: false, nameservers: [], delegatedIps: ['192.0.2.42'] }
  const resellerA = await store.createReseller({ ...resellerInput, acl: [...resellerInput.acl], username: 'resellera' })
  const resellerB = await store.createReseller({ ...resellerInput, acl: [...resellerInput.acl], username: 'resellerb' })
  const accountInput = { passwordHash: HASH, planId: plan.id, contactEmail: 'owner@example.test', ipv4: '192.0.2.42', shell: 'none' as const,
    php: { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} } }
  const account = (username: string, ownerId: string | null) => store.createAccount({ ...accountInput, username, primaryDomain: username + '.example.test', ownerId })
  // Each case gets its own accounts, so cases share the expensive database, state and app.
  const accounts = async (prefix: string) => ({ a1: await account(prefix + 'a1', resellerA.id), a2: await account(prefix + 'a2', resellerA.id), a3: await account(prefix + 'a3', resellerA.id), b1: await account(prefix + 'b1', resellerB.id) })
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  await setTotpSecret(database.db, root.id, new Uint8Array(32))
  await createResellerPrincipal(database.db, { id: resellerA.id, username: resellerA.username, passwordHash: HASH })
  const token = async (principalId: string) => {
    const raw = 'xp_' + randomUUID()
    await createApiToken(database.db, { principalId, name: 'Bulk token', tokenHash: createHash('sha256').update(raw).digest('hex'), scopes: ['*'], expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const tokens = { root: await token(root.id), resellerA: await token(resellerA.id) }
  let applies = 0, rejectApply: number | null = null
  const agentApp: AgentApp = {
    subscribe: () => () => {},
    fetch: async request => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET' && /^\/accounts\/[a-z0-9]+\/purge$/.test(path)) return Response.json({ available: true, contract: 'target-bound-userdel' })
      if (path !== '/state/apply') return new Response(null, { status: 404 })
      applies++
      if (applies === rejectApply) return Response.json({ status: 'failed' }, { status: 422 })
      // The terminate generation removes accounts marked terminating, as the agent's teardown plan does.
      for (const item of await store.listAccounts()) if (item.status === 'terminating') await store.deleteAccount(item.id)
      return Response.json({ status: 'applied', generation: { id: applies, status: 'active', checksum: 'a'.repeat(64) }, filesCount: 1, durationMs: 1 })
    },
  }
  const app = createApiApp({ db: database.db, store, serverSecret: 'account-bulk-synthetic-server-secret-32-bytes', agentApp, agentToken: 'a'.repeat(64) })
  const call = async (bearer: string, method: string, path: string, body: unknown) => {
    const response = await app.fetch(new Request('http://localhost' + path, { method, headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> }
  }
  const status = async (id: string) => (await store.getAccount(id))?.status ?? 'removed'
  const jobs = async () => (await listJobs(database.db)).filter(job => job.kind === 'account.bulk')
  return { database, store, plan, accounts, tokens, call, status, jobs, applies: () => applies, rejectApplyAt: (n: number | null) => { rejectApply = n === null ? null : applies + n } }
}
const ids = (...items: { id: string }[]) => items.map(item => ({ id: item.id }))

describe('WHM bulk account actions', { tags: ['feature'] }, () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeAll(async () => { f = await fixture() })

  it('runs each account through the single-account authorization: a reseller cannot act on another reseller account', async () => {
    const a = await f.accounts('one'), before = f.applies()
    const response = await f.call(f.tokens.resellerA, 'POST', '/api/accounts/bulk-actions/suspend', { operationId: randomUUID(), accounts: ids(a.a1, a.b1), reason: 'Synthetic bulk reason' })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([
      { accountId: a.a1.id, outcome: 'applied', code: null, reason: null },
      { accountId: a.b1.id, outcome: 'refused', code: 'NOT_FOUND', reason: null },
    ])
    expect(response.body.operation).toMatchObject({ status: 'completed', replay: false, reference: expect.stringMatching(/^XP-JOB-/) })
    expect(await f.status(a.a1.id)).toBe('suspended')
    expect(await f.status(a.b1.id)).toBe('active')
    expect(f.applies() - before).toBe(1)
    const audits = (await listAudit(f.database.db, { limit: 1000 })).filter(entry => entry.action === 'account.desired.suspended' && entry.target.startsWith('account:one'))
    expect(audits.map(entry => entry.target)).toEqual(['account:onea1'])
    // Ownership changes stay root-only per account, exactly as the single PATCH path.
    const owner = await f.call(f.tokens.resellerA, 'POST', '/api/accounts/bulk-actions/owner', { operationId: randomUUID(), accounts: ids(a.a2), ownerId: null })
    expect(owner.body.results).toEqual([{ accountId: a.a2.id, outcome: 'refused', code: 'FORBIDDEN', reason: null }])
    expect((await f.store.getAccount(a.a2.id))?.ownerId).toBe(a.a2.ownerId)
  })

  it('reports partial failure truthfully and stops after an outcome that needs review', async () => {
    const a = await f.accounts('two'), before = f.applies()
    await f.store.suspendAccount(a.a2.id, 'Already suspended')
    f.rejectApplyAt(2)
    const response = await f.call(f.tokens.root, 'POST', '/api/accounts/bulk-actions/suspend', { operationId: randomUUID(), accounts: ids(a.a1, a.a2, a.a3, a.b1) })
    f.rejectApplyAt(null)
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([
      { accountId: a.a1.id, outcome: 'applied', code: null, reason: null },
      { accountId: a.a2.id, outcome: 'refused', code: 'CONFLICT', reason: null },
      { accountId: a.a3.id, outcome: 'review-required', code: 'CONFIG_TEST_FAILED', reason: 'host_apply_rejected' },
      { accountId: a.b1.id, outcome: 'not-attempted', code: null, reason: null },
    ])
    expect(response.body.operation.status).toBe('stopped')
    expect(response.body.summary).toEqual({ applied: 1, refused: 1, reviewRequired: 1, notAttempted: 1 })
    expect(await f.status(a.b1.id)).toBe('active')
    expect(f.applies() - before).toBe(2)
    const job = (await f.jobs()).find(item => item.referenceCode === response.body.operation.reference)
    expect(job).toMatchObject({ status: 'failed', error: '3 of 4 accounts were not changed' })
  })

  it('refuses an oversized or repeated selection before any change', async () => {
    const a = await f.accounts('three'), before = f.applies(), jobs = (await f.jobs()).length
    const accounts = Array.from({ length: ACCOUNT_BULK_LIMIT + 1 }, () => ({ id: randomUUID() }))
    const oversized = await f.call(f.tokens.root, 'POST', '/api/accounts/bulk-actions/unsuspend', { operationId: randomUUID(), accounts })
    expect(oversized.status).toBe(422)
    expect(oversized.body.details).toEqual({ stateChanged: false })
    const repeated = await f.call(f.tokens.root, 'POST', '/api/accounts/bulk-actions/suspend', { operationId: randomUUID(), accounts: ids(a.a1, a.a1) })
    expect(repeated.status).toBe(422)
    expect(f.applies()).toBe(before)
    expect(await f.jobs()).toHaveLength(jobs)
    expect(await f.status(a.a1.id)).toBe('active')
  })

  it('replays the recorded result for the same operation id and refuses its reuse for another request', async () => {
    const a = await f.accounts('four'), jobs = (await f.jobs()).length
    const request = { operationId: randomUUID(), accounts: ids(a.a1, a.a2), planId: f.plan.id }
    await f.store.suspendAccount(a.a1.id, 'Synthetic')
    const first = await f.call(f.tokens.root, 'POST', '/api/accounts/bulk-actions/suspend', { operationId: request.operationId, accounts: request.accounts })
    expect(first.body.results.map((item: { outcome: string }) => item.outcome)).toEqual(['refused', 'applied'])
    const applies = f.applies()
    const replay = await f.call(f.tokens.root, 'POST', '/api/accounts/bulk-actions/suspend', { operationId: request.operationId, accounts: request.accounts })
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual({ ...first.body, operation: { ...first.body.operation, replay: true } })
    expect(f.applies()).toBe(applies)
    const reused = await f.call(f.tokens.root, 'POST', '/api/accounts/bulk-actions/plan', request)
    expect(reused.status).toBe(409)
    expect(reused.body.details).toEqual({ stateChanged: false, reason: 'operation_id_reused' })
    expect(f.applies()).toBe(applies)
    expect(await f.jobs()).toHaveLength(jobs + 1)
  })

  it('terminates only accounts whose typed username confirmation matches', async () => {
    const a = await f.accounts('five')
    const missing = await f.call(f.tokens.root, 'DELETE', '/api/accounts/bulk-actions', { operationId: randomUUID(), accounts: ids(a.a1) })
    expect(missing.status).toBe(422)
    expect(await f.call(f.tokens.root, 'POST', '/api/accounts/bulk-actions', { operationId: randomUUID(), accounts: [] }).then(item => item.status)).toBe(405)
    const response = await f.call(f.tokens.root, 'DELETE', '/api/accounts/bulk-actions', { operationId: randomUUID(), accounts: [
      { id: a.a1.id, confirmUsername: 'fivea2' }, { id: a.a2.id, confirmUsername: 'fivea2' },
    ] })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([
      { accountId: a.a1.id, outcome: 'refused', code: 'VALIDATION', reason: null },
      { accountId: a.a2.id, outcome: 'applied', code: null, reason: null },
    ])
    expect(await f.status(a.a1.id)).toBe('active')
    expect(await f.status(a.a2.id)).toBe('removed')
    expect((await listAudit(f.database.db, { limit: 1000 })).filter(entry => entry.action === 'account.terminated').map(entry => entry.target)).toEqual(['account:fivea2'])
  })
})
