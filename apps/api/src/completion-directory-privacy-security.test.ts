import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as dbApi from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'
import { TEST_SERVER_SECRET } from './testing.ts'

// Real-loopback acceptance for the directory-privacy web-features route. The route compiles
// nginx/apache fragments from the stored rules, so input normalization is security-relevant.
// Synthetic temporary API tokens only; no host effect is claimed.

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
interface RuleView { path: string; authName: string; enabled: boolean; users: { username: string }[] }
interface ConfigView { config: { rules: RuleView[]; compiledNginx: string; compiledApache: string; updatedAt: string; accountId?: string } }
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
  const config = async (raw = credential): Promise<ConfigView> => {
    const response = await request(base, 'GET', undefined, raw)
    expect(response.status).toBe(200)
    return await response.json() as ConfigView
  }
  const rules = (patch: Record<string, unknown> = {}) => [{ path: 'private', authName: 'Private area', enabled: true, users: [{ username: 'alice', password: 'correct horse battery' }], ...patch }]
  const storedBytes = async () => JSON.stringify(await state.store.readSnapshot())
  const auditRows = (action: string) => database.db.query<AuditRow>('SELECT actor, principal_id, action, target, outcome FROM audit_log WHERE action = $1 ORDER BY id ASC', [action])
  return { database, state, features, owner, other, principal, credential, readOnly, neighborCredential, request, base, config, rules, storedBytes, auditRows }
}

describe('directory privacy web-features HTTP security acceptance', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Synthetic directory privacy cleanup failed')
  })

  it('reads an empty configuration without exposing credential material', async () => {
    const body = await f.config()
    expect(body.config.rules).toEqual([])
    expect(body.config.compiledNginx).toBe('')
    expect(body.config.compiledApache).toBe('')
    expect(body.config.updatedAt).toEqual(expect.any(String))
    const text = JSON.stringify(body)
    expect(text).not.toMatch(/passwordHash|compiledHtpasswd|\$argon2/)
    const anonymous = await f.request(f.base, 'GET', undefined, null)
    expect(anonymous.status).toBe(401)
  })

  it('stores normalized rules, compiles directives and hides password hashes', async () => {
    const response = await f.request(f.base, 'PUT', { rules: f.rules() })
    expect(response.status).toBe(200)
    const body = await response.json() as ConfigView
    expect(body.config.rules).toEqual([{ path: '/private', authName: 'Private area', enabled: true, users: [{ username: 'alice' }] }])
    expect(body.config.compiledNginx).toContain('location ^~ /private')
    expect(body.config.compiledNginx).toContain('auth_basic "Private area"')
    expect(body.config.compiledNginx).toContain(`${f.owner.home}/.htpasswd`)
    expect(body.config.compiledApache).toContain('<Directory ')
    const text = JSON.stringify(body)
    expect(text).not.toMatch(/passwordHash|compiledHtpasswd|correct horse|\$argon2/)
    const readback = await f.config()
    expect(readback).toEqual(body)
    const audited = await f.auditRows('web_features.directory_privacy.updated')
    expect(audited.length).toBe(1)
    expect(audited[0]).toMatchObject({ actor: f.owner.username, principal_id: f.principal.id, outcome: 'ok' })
  })

  it.each([
    ['traversal path', { path: '../etc' }],
    ['control characters in path', { path: '/private\nuser root;' }],
    ['absolute injection path', { path: '/private; root' }],
    ['prompt injection', { authName: 'x"\n}location / {' }],
    ['unbounded prompt', { authName: 'x'.repeat(129) }],
    ['non-boolean enabled', { enabled: 'yes' }],
    ['malformed username', { users: [{ username: '../root', password: 'correct horse battery' }] }],
  ])('refuses %s and keeps the stored configuration unchanged', async (_name, patch) => {
    const before = await f.storedBytes()
    const response = await f.request(f.base, 'PUT', { rules: f.rules(patch) })
    expect(response.status).toBe(422)
    expect(await f.storedBytes()).toBe(before)
  })

  it('refuses duplicate folders and duplicate users without writing', async () => {
    const before = await f.storedBytes()
    const duplicatePath = await f.request(f.base, 'PUT', { rules: [f.rules()[0], f.rules()[0]] })
    expect(duplicatePath.status).toBe(422)
    const duplicateUser = await f.request(f.base, 'PUT', { rules: f.rules({ users: [{ username: 'alice', password: 'correct horse battery' }, { username: 'alice', password: 'another horse battery' }] }) })
    expect(duplicateUser.status).toBe(422)
    expect(await f.storedBytes()).toBe(before)
  })

  it('refuses a short password and an over-limit rule list without writing', async () => {
    const before = await f.storedBytes()
    const short = await f.request(f.base, 'PUT', { rules: f.rules({ users: [{ username: 'alice', password: 'short' }] }) })
    expect(short.status).toBe(422)
    const tooMany = await f.request(f.base, 'PUT', { rules: Array.from({ length: 1001 }, (_value, index) => ({ path: '/p' + index, enabled: true, users: [] })) })
    expect(tooMany.status).toBe(422)
    expect(await f.storedBytes()).toBe(before)
  })

  it('keeps the route behind the directory-privacy feature policy', async () => {
    await f.state.store.updateFeatureList(f.features.id, { disabled: ['directory-privacy'] })
    const before = await f.storedBytes()
    const denied = await f.request(f.base, 'PUT', { rules: f.rules() })
    expect(denied.status).toBe(403)
    expect(await f.storedBytes()).toBe(before)
    await f.state.store.updateFeatureList(f.features.id, { disabled: [] })
    const allowed = await f.request(f.base, 'PUT', { rules: f.rules() })
    expect(allowed.status).toBe(200)
  })

  it('does not let a neighbor or a read-only token write rules', async () => {
    const before = await f.storedBytes()
    const neighbor = await f.request('/api/web-features/' + f.owner.username + '/directory-privacy', 'PUT', { rules: f.rules() }, f.neighborCredential)
    expect([403, 404]).toContain(neighbor.status)
    const readOnly = await f.request(f.base, 'PUT', { rules: f.rules() }, f.readOnly)
    expect(readOnly.status).toBe(403)
    expect(await f.storedBytes()).toBe(before)
  })

  it('replaces rules on a later save and stops compiling disabled folders', async () => {
    expect((await f.request(f.base, 'PUT', { rules: f.rules() })).status).toBe(200)
    const response = await f.request(f.base, 'PUT', { rules: [{ path: '/disabled-area', authName: 'Disabled', enabled: false, users: [{ username: 'bob', password: 'another horse battery' }] }] })
    expect(response.status).toBe(200)
    const body = await response.json() as ConfigView
    expect(body.config.rules).toEqual([{ path: '/disabled-area', authName: 'Disabled', enabled: false, users: [{ username: 'bob' }] }])
    expect(body.config.compiledNginx).not.toContain('location ^~ /disabled-area')
    expect((await f.config()).config.rules).toEqual(body.config.rules)
  })
})
