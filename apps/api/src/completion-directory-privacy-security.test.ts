import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as dbApi from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'
import { TEST_SERVER_SECRET } from './testing.ts'

// Real-loopback acceptance for the directory-privacy web-features route: authority, scope and feature policy
// run before the protected host agent is asked, and without that agent the route refuses truthfully.
// Synthetic temporary API tokens only; no host effect is claimed.

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
interface AuditRow { [column: string]: unknown; actor: string; principal_id: string | null; action: string; target: string; outcome: string }

const fixture = async () => {
  const database = await dbApi.createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Directory privacy policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Directory privacy plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 3, aliasDomains: 3, subdomains: 3, mailboxes: 4, forwarders: 4, mailingLists: 4, ftpAccounts: 4, databases: 4, phpWorkers: 4 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.111', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = async (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: username + '.example.test', planId: plan.id, ownerId: null,
    contactEmail: 'owner@' + username + '.example.test', ipv4: '192.0.2.111', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await account('dirpriva'), other = await account('dirprivb')
  const principal = await dbApi.createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const neighbor = await dbApi.createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: HASH })
  await dbApi.reindexFromState(database.db, await state.store.readSnapshot())
  const token = async (scopes: string[], principalId = principal.id) => {
    const raw = 'xp_' + randomUUID()
    await dbApi.createApiToken(database.db, { principalId, name: 'Synthetic directory privacy', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const credential = await token(['files:read', 'files:write'])
  const readOnly = await token(['files:read'])
  const neighborCredential = await token(['files:read', 'files:write'], neighbor.id)
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET })
  const base = '/api/web-features/' + owner.username + '/directory-privacy'
  const request = (path: string, method = 'GET', body?: unknown, raw: string | null = credential) => app.fetch(new Request('http://localhost' + path, { method,
    headers: { ...(raw ? { authorization: 'Bearer ' + raw } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const save = (patch: Record<string, unknown> = {}) => ({ path: 'public_html/private', expectedRevision: 'a'.repeat(64), enabled: true, authName: 'Private area', users: [{ username: 'alice', password: 'correct horse battery' }], ...patch })
  const storedBytes = async () => JSON.stringify(await state.store.readSnapshot())
  const auditRows = (action: string) => database.db.query<AuditRow>('SELECT actor, principal_id, action, target, outcome FROM audit_log WHERE action = $1 ORDER BY id ASC', [action])
  return { database, state, features, owner, other, principal, credential, readOnly, neighborCredential, request, base, save, storedBytes, auditRows }
}

describe('directory privacy web-features HTTP security acceptance', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Synthetic directory privacy cleanup failed')
  })

  it('refuses truthfully without the protected host agent and writes nothing', async () => {
    const before = await f.storedBytes()
    for (const [method, body] of [['GET', undefined], ['PUT', f.save()]] as const) {
      const response = await f.request(f.base, method, body)
      expect(response.status, method).toBe(412)
      const problem = await response.json() as { code: string; details: Record<string, unknown> }
      expect(problem.code).toBe('PRECONDITION_FAILED')
      expect(problem.details).toMatchObject({ stateChanged: false, reason: 'host_agent_unavailable' })
      expect(JSON.stringify(problem)).not.toMatch(/correct horse|\$6\$|\$argon2/)
    }
    expect(await f.storedBytes()).toBe(before)
    expect(await f.auditRows('web_features.directory_privacy.updated')).toEqual([])
    const anonymous = await f.request(f.base, 'GET', undefined, null)
    expect(anonymous.status).toBe(401)
  })

  it('keeps the route behind the directory-privacy feature policy', async () => {
    await f.state.store.updateFeatureList(f.features.id, { disabled: ['directory-privacy'] })
    const before = await f.storedBytes()
    const denied = await f.request(f.base, 'PUT', f.save())
    expect(denied.status).toBe(403)
    expect(await f.storedBytes()).toBe(before)
    await f.state.store.updateFeatureList(f.features.id, { disabled: [] })
    const allowed = await f.request(f.base, 'PUT', f.save())
    expect(allowed.status).toBe(412)
  })

  it('does not let a neighbor or a read-only token write rules', async () => {
    const before = await f.storedBytes()
    const neighbor = await f.request('/api/web-features/' + f.owner.username + '/directory-privacy', 'PUT', f.save(), f.neighborCredential)
    expect([403, 404]).toContain(neighbor.status)
    const readOnly = await f.request(f.base, 'PUT', f.save(), f.readOnly)
    expect(readOnly.status).toBe(403)
    expect(await f.storedBytes()).toBe(before)
  })
})
