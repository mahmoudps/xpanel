import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defaultPlan, validateUsername, type Account, type PhpSettings } from '@xpanel/core'
import { createApiToken, createResellerPrincipal, createRootPrincipal, createTestDb, createUserPrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { AgentApp } from '@xpanel/agent'
import { policyForRequest } from './authorization.ts'
import { createApiApp, listenApiServer } from './server.ts'

const names = ['a', 'ab', 'abc', 'abcdefghijklmnop'] as const
const hash = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const php: PhpSettings = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }

describe('short usernames retain API routes, scope and transport limits', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  let state: Awaited<ReturnType<typeof createTestStateStore>>
  let app: ReturnType<typeof createApiApp>
  let rootToken: string, resellerToken: string, featureId: string
  const tokens = new Map<string, string>()
  const accounts = new Map<string, Account>()
  const seen: { method: string; path: string }[] = []
  const tokenFor = async (principalId: string, scopes = ['*']) => {
    const raw = 'xp_' + randomUUID()
    await createApiToken(db.db, { principalId, name: 'Synthetic boundary', tokenHash: createHash('sha256').update(raw).digest('hex'), scopes, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    return raw
  }
  const call = (token: string, path: string, method = 'POST', body?: unknown) => app.fetch(new Request('http://localhost' + path, {
    method, headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))

  beforeAll(async () => {
    db = await createTestDb(); state = await createTestStateStore()
    const feature = await state.store.createFeatureList({ name: 'Short account tools', ownerId: null, disabled: [] }); featureId = feature.id
    const { id: _id, ...seed } = defaultPlan({ name: 'Short account plan', featureListId: feature.id })
    const plan = await state.store.createPlan(seed)
    await state.store.saveServerIp({ address: '192.0.2.42', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const root = await createRootPrincipal(db.db, { username: 'root', passwordHash: hash, forcePasswordChange: false }); rootToken = await tokenFor(root.id)
    const reseller = await state.store.createReseller({ username: 'reseller7', passwordHash: hash, acl: ['list-accounts', 'edit-account', 'manage-ssl', 'transfer'], maxAccounts: 10, totalDiskMb: 100000, totalBandwidthMb: 100000, oversell: false, nameservers: [], delegatedIps: [] })
    const resellerPrincipal = await createResellerPrincipal(db.db, { id: reseller.id, username: reseller.username, passwordHash: hash })
    resellerToken = await tokenFor(resellerPrincipal.id)
    for (const username of names) {
      const account = await state.store.createAccount({ username, passwordHash: hash, primaryDomain: username + '.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.42', shell: 'none', php })
      accounts.set(username, account)
      const principal = await createUserPrincipal(db.db, { username, accountId: account.id, passwordHash: hash })
      tokens.set(username, await tokenFor(principal.id))
    }
    // This transport records API admission only; no host, shell or CA is executed.
    const agentApp: AgentApp = { subscribe: () => () => {}, fetch: async request => {
      const path = new URL(request.url).pathname; seen.push({ method: request.method, path })
      if (path.endsWith('/certificates')) return Response.json({ detail: 'Synthetic CA unavailable' }, { status: 503 })
      return Response.json(path.endsWith('/backups') ? { backups: [] } : { files: [], stdout: 'Synthetic transport' })
    } }
    app = createApiApp({ db: db.db, store: state.store, serverSecret: 'short-username-synthetic-server-secret-32-bytes', agentToken: 'a'.repeat(64), agentApp })
  })
  beforeEach(() => { seen.length = 0 })
  afterAll(async () => { await state?.close(); await db?.close() })

  it.each(names)('dispatches owned files/shell/certificate and root backup for %s', async username => {
    const token = tokens.get(username)!
    expect(validateUsername(username)).toBe(username)
    expect((await call(token, `/api/accounts/${username}/files`, 'POST', { op: 'list', path: '' })).status).toBe(200)
    expect((await call(token, `/api/accounts/${username}/shell`, 'POST', { command: 'whoami' })).status).toBe(200)
    expect((await call(token, `/api/accounts/${username}/certificates`, 'POST', { domain: username + '.example.test' })).status).toBe(503)
    expect((await call(rootToken, `/api/backups/accounts/${username}`, 'GET')).status).toBe(200)
    expect(seen.map(item => item.path)).toEqual([`/accounts/${username}/files`, `/accounts/${username}/shell`, `/accounts/${username}/certificates`, `/accounts/${username}/backups`])
  })
  it.each(names)('keeps capability and backup role classifications for %s', async username => {
    expect(policyForRequest(`/api/accounts/${username}/files`, 'POST')).toMatchObject({ resource: 'files', acl: 'edit-account', toolIds: ['file-manager'] })
    expect(policyForRequest(`/api/accounts/${username}/shell`, 'POST')).toMatchObject({ resource: 'shell', acl: 'edit-account', toolIds: ['ssh-access'] })
    expect(policyForRequest(`/api/accounts/${username}/certificates`, 'POST')).toMatchObject({ resource: 'accounts', acl: 'manage-ssl', toolIds: ['ssl-install'] })
    expect(policyForRequest(`/api/backups/accounts/${username}`, 'GET')).toEqual({ resource: 'backups', rootOnly: true, toolIds: ['backup-restoration'] })
    expect((await call(tokens.get(username)!, `/api/backups/accounts/${username}`, 'GET')).status).toBe(403)
    expect((await call(resellerToken, `/api/backups/accounts/${username}`, 'GET')).status).toBe(403)
    expect(seen).toEqual([])
  })
  it('does not forward neighboring account requests and preserves feature refusal', async () => {
    const token = tokens.get('a')!
    for (const suffix of ['files', 'shell', 'certificates']) expect((await call(token, '/api/accounts/ab/' + suffix, 'POST', suffix === 'certificates' ? { domain: 'ab.example.test' } : suffix === 'files' ? { op: 'list', path: '' } : { command: 'whoami' })).status).toBe(404)
    expect(seen).toEqual([])
    await state.store.updateFeatureList(featureId, { disabled: ['file-manager', 'ssh-access', 'ssl-install'] })
    try {
      for (const suffix of ['files', 'shell', 'certificates']) expect((await call(token, '/api/accounts/a/' + suffix, 'POST', suffix === 'files' ? { op: 'list', path: '' } : {})).status).toBe(403)
      expect(seen).toEqual([])
    } finally { await state.store.updateFeatureList(featureId, { disabled: [] }) }
  })
  it.each(['abcdefghijklmnopq', 'A', 'a_', 'a-b', 'root'])('does not route or create invalid/reserved username %s', async username => {
    expect(() => validateUsername(username)).toThrow()
    expect((await call(rootToken, `/api/accounts/${username}/files`, 'POST', { op: 'list', path: '' })).status).toBe(404)
    expect(seen).toEqual([])
  })
  it('retains the file 3 MiB transport bucket for 1/2-character routes, while generic requests remain 1 MiB', async () => {
    const server = await listenApiServer(app)
    try {
      const body = JSON.stringify({ op: 'write', path: 'public_html/large.txt', content: 'x'.repeat(1024 * 1024 + 128) })
      for (const username of ['a', 'ab']) {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/accounts/${username}/files`, { method: 'POST', headers: { authorization: 'Bearer ' + rootToken, 'content-type': 'application/json' }, body })
        expect(response.status).toBe(200)
      }
      const generic = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(generic.status).toBe(413)
      expect(seen.map(item => item.path)).toEqual(['/accounts/a/files', '/accounts/ab/files'])
    } finally { await server.close() }
  })
})
