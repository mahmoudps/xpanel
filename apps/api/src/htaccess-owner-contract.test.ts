import { randomUUID } from 'node:crypto'
import type { PhpSettings } from '@xpanel/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiToken, createTestDb, createUserPrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { authenticateRequest, sha256Hex } from './auth.ts'
import { assertAccountAuthorized, assertRequestAuthorized, policyForRequest } from './authorization.ts'

// Synthetic credentials and local StateStore records test policy ports only.
// No API/Agent native I/O, parser, workload or serving qualification is claimed.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo'
const SERVER_SECRET = 'synthetic-a35-policy-test-server-secret-32-bytes'
const php: PhpSettings = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture(disabled: string[] = []) {
  const db = await createTestDb(); cleanups.push(() => db.close())
  const state = await createTestStateStore(); cleanups.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Rewrite features', ownerId: null, disabled })
  const plan = await state.store.createPlan({ name: 'Rewrite plan', ownerId: null, featureListId: features.id, resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }, caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 10, forwarders: 10, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.41', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = await state.store.createAccount({ username: 'alice', passwordHash: HASH, primaryDomain: 'alice.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@alice.example.test', ipv4: '192.0.2.41', shell: 'none', php })
  const other = await state.store.createAccount({ username: 'bob', passwordHash: HASH, primaryDomain: 'bob.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@bob.example.test', ipv4: '192.0.2.41', shell: 'none', php })
  const principal = await createUserPrincipal(db.db, { username: account.username, accountId: account.id, passwordHash: HASH, forcePasswordChange: false })
  const path = '/api/domains/' + randomUUID() + '/htaccess'
  async function caller(scopes: string[]) {
    const raw = 'xp_' + randomUUID()
    await createApiToken(db.db, { principalId: principal.id, name: 'Synthetic rewrite token', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    const observed = await authenticateRequest(db.db, new Request('http://localhost' + path, { headers: { authorization: 'Bearer ' + raw } }), { serverSecret: SERVER_SECRET })
    if (!observed) throw new Error('Synthetic token did not authenticate')
    return observed
  }
  return { store: state.store, account, other, path, caller }
}
const request = (path: string, method: string) => new Request('http://localhost' + path, { method })

describe('bounded rewrite request authority', () => {
  it('declares the bounded core while retaining method-sensitive files scopes and reseller privileges', () => {
    const path = '/api/domains/11111111-1111-4111-8111-111111111111/htaccess'
    expect(policyForRequest(path, 'GET')).toEqual({ resource: 'files', acl: 'list-accounts', toolIds: ['domain-htaccess'] })
    expect(policyForRequest(path, 'POST')).toEqual({ resource: 'files', acl: 'edit-account', toolIds: ['domain-htaccess'], scopeAccess: 'read' })
    expect(policyForRequest(path, 'PUT')).toEqual({ resource: 'files', acl: 'edit-account', toolIds: ['domain-htaccess'] })
    expect(policyForRequest(path + '/restore', 'POST')).toEqual({ resource: 'files', acl: 'edit-account', toolIds: ['domain-htaccess'] })
  })
  it('admits a current owner files-read token for read and draft validation only', async () => {
    const f = await fixture(), caller = await f.caller(['files:read'])
    await expect(assertRequestAuthorized(f.store, caller, request(f.path, 'GET'))).resolves.toBeUndefined()
    await expect(assertRequestAuthorized(f.store, caller, request(f.path, 'POST'))).resolves.toBeUndefined()
    for (const [method, suffix] of [['PUT', ''], ['POST', '/restore'], ['POST', '/migrate-php']]) await expect(assertRequestAuthorized(f.store, caller, request(f.path + suffix, method!))).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { requiredScope: 'files:write' } })
  })
  it('does not let a read token borrow an unrelated write scope', async () => {
    const f = await fixture(), caller = await f.caller(['files:read', 'mail:write'])
    await expect(assertRequestAuthorized(f.store, caller, request(f.path, 'PUT'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it.each(['domain-htaccess', 'aapanel-url-rewrite'])('refuses %s disabled by the real account feature list', async id => {
    const f = await fixture([id]), caller = await f.caller(['files:*'])
    for (const method of ['GET', 'POST', 'PUT']) await expect(assertRequestAuthorized(f.store, caller, request(f.path, method))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('refuses unavailable current policy rather than treating it as no disabled features', async () => {
    const f = await fixture(), caller = await f.caller(['files:*'])
    vi.spyOn(f.store, 'getFeatureList').mockResolvedValue(null)
    await expect(assertRequestAuthorized(f.store, caller, request(f.path, 'GET'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('preserves current own-account checks after a legitimate request policy was bound', async () => {
    const f = await fixture(), caller = await f.caller(['files:*'])
    await assertRequestAuthorized(f.store, caller, request(f.path, 'PUT'))
    await expect(assertAccountAuthorized(f.store, caller, f.account, 'files.save')).resolves.toBeUndefined()
    await expect(f.store.getAccount(f.other.id)).resolves.toMatchObject({ id: f.other.id, username: f.other.username })
    await expect(assertAccountAuthorized(f.store, caller, f.other, 'files.save')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
