import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createApiToken, createResellerPrincipal, createRootPrincipal, createSession, createTestDb,
  createUserPrincipal, deletePrincipal, findPrincipalByUsername, listAudit, setTotpSecret,
} from '@xpanel/db'
import { StateStore, createTestStateStore } from '@xpanel/state'
import { WRITER_MUTEX_FILE } from '../../../packages/state/src/writer-mutex.ts'
import * as dbApi from '@xpanel/db'
import type { AgentApp } from '@xpanel/agent'
import { XpanelError } from '@xpanel/core'
import * as lifecycleAdmission from '../../../scripts/lifecycle-admission.mjs'
import { deriveCsrfToken } from './auth.ts'
import { sessionCookieName, sessionTokenHash } from './entry-points.ts'
import { createApiApp, INGRESS_SECRET_HEADER, listenApiServer } from './server.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'account-mutation-synthetic-server-secret-32-bytes'
const INGRESS = 'account-mutation-synthetic-ingress-secret-32-bytes'
const ORIGIN = 'https://whm.example.test:2087'
const RAW_HOST_MARKER = '/private-host-fixture/path?token=fixture-not-a-real-secret'
const outcomes = ['http422', 'failed', 'malformed', 'noop', 'transport', 'unknown'] as const
type Outcome = typeof outcomes[number] | 'applied' | 'invalid-applied' | 'oversized'
type Action = 'create' | 'suspend' | 'unsuspend' | 'update' | 'delete'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

const fixture = async () => {
  const database = await createTestDb()
  const state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const features = await state.store.createFeatureList({ name: 'Mutation features', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Mutation plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
    caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 4 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await state.store.saveServerIp({ address: '192.0.2.42', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })
  const reseller = await state.store.createReseller({ username: 'reseller7', passwordHash: HASH, acl: ['create-account', 'list-accounts', 'edit-account', 'suspend-account', 'terminate-account', 'change-plan'], maxAccounts: 10, totalDiskMb: 100000, totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: ['192.0.2.42'] })
  const accountInput = { passwordHash: HASH, planId: plan.id, contactEmail: 'owner@example.test', ipv4: '192.0.2.42', shell: 'none' as const,
    php: { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} },
  }
  const account = await state.store.createAccount({ ...accountInput, username: 'owner7', primaryDomain: 'owner7.example.test', ownerId: reseller.id })
  const other = await state.store.createAccount({ ...accountInput, username: 'other7', primaryDomain: 'other7.example.test', ownerId: null })
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  await setTotpSecret(database.db, root.id, new Uint8Array(32))
  const resellerPrincipal = await createResellerPrincipal(database.db, { id: reseller.id, username: reseller.username, passwordHash: HASH })
  const owner = await createUserPrincipal(database.db, { username: account.username, accountId: account.id, passwordHash: HASH })
  const alias = await createUserPrincipal(database.db, { username: 'alias7', accountId: account.id, passwordHash: HASH })
  const neighbor = await createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: HASH })
  for (const principal of [owner, alias, neighbor]) {
    await createSession(database.db, { principalId: principal.id, tokenHash: sessionTokenHash('test-session-' + principal.username, 'xpanel'), expiresAt: new Date(Date.now() + 60000).toISOString(), mfaVerified: true })
    await createApiToken(database.db, { principalId: principal.id, name: 'Synthetic token', tokenHash: createHash('sha256').update('test-token-' + principal.username).digest('hex'), scopes: ['accounts:read'], expiresAt: new Date(Date.now() + 60000).toISOString() })
  }
  const session = async (principalId: string) => {
    const token = 'session-' + principalId
    await createSession(database.db, { principalId, tokenHash: sessionTokenHash(token, 'xwhm'), expiresAt: new Date(Date.now() + 60000).toISOString(), mfaVerified: true })
    return { cookie: sessionCookieName('xwhm', true) + '=' + token, csrf: deriveCsrfToken(token, SECRET, 'xwhm') }
  }
  const rootSession = await session(root.id)
  const resellerSession = await session(resellerPrincipal.id)
  let mode: Outcome = 'applied'
  let purgeMode: 'missing' | 'ready' = 'missing'
  let calls = 0
  let pause: { enter: () => void; gate: Promise<void> } | undefined
  const holdNextApply = () => {
    let release!: () => void
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    pause = { enter, gate }
    return { entered, release }
  }
  const host = createHttpServer(async (request, response) => {
    const purgePath = '/accounts/' + account.username + '/purge'
    if (request.url === purgePath) {
      if (purgeMode !== 'ready') { response.writeHead(404); response.end(); return }
      response.setHeader('content-type', 'application/json')
      if (request.method === 'GET') { response.end(JSON.stringify({ available: true, contract: 'target-bound-userdel' })); return }
      request.resume()
      response.end(JSON.stringify({ purged: true }))
      return
    }
    if (request.url !== '/state/apply') { response.writeHead(404); response.end(); return }
    calls++
    request.resume()
    const held = pause
    pause = undefined
    if (held) { held.enter(); await held.gate }
    if (mode === 'transport') { request.socket.destroy(); return }
    response.setHeader('content-type', 'application/json')
    if (mode === 'http422') { response.writeHead(422); response.end(JSON.stringify({ status: 'failed', error: RAW_HOST_MARKER })); return }
    if (mode === 'failed') { response.end(JSON.stringify({ status: 'failed', error: RAW_HOST_MARKER, rolledBack: true })); return }
    if (mode === 'malformed') { response.end('not-json ' + RAW_HOST_MARKER); return }
    if (mode === 'noop') { response.end(JSON.stringify({ status: 'noop', generation: null, stateChecksum: 'a'.repeat(64) })); return }
    if (mode === 'unknown') { response.end(JSON.stringify({ ok: true, note: RAW_HOST_MARKER })); return }
    if (mode === 'invalid-applied') { response.end(JSON.stringify({ status: 'applied', generation: { id: 1, status: 'active', checksum: 'invalid' }, filesCount: 2, durationMs: 1, error: RAW_HOST_MARKER })); return }
    if (mode === 'oversized') { response.end(JSON.stringify({ status: 'applied', generation: { id: 1, status: 'active', checksum: 'a'.repeat(64) }, filesCount: 2, durationMs: 1, padding: RAW_HOST_MARKER + 'x'.repeat(70000) })); return }
    response.end(JSON.stringify({ status: 'applied', generation: { id: 1, createdAt: '2026-10-23T00:00:00Z', status: 'active', checksum: 'a'.repeat(64), error: null, actor: 'root', testedAt: '2026-10-23T00:00:00Z', activatedAt: '2026-10-23T00:00:00Z' }, filesCount: 2, durationMs: 1 }))
  })
  await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve))
  const hostPort = (host.address() as { port: number }).port
  cleanup.push(() => new Promise<void>(resolve => { host.closeAllConnections(); host.close(() => resolve()) }))
  const agentApp: AgentApp = {
    subscribe: () => () => {},
    fetch: async request => {
      const method = request.method
      const body = method === 'GET' || method === 'HEAD' ? undefined : await request.text()
      return fetch('http://127.0.0.1:' + hostPort + new URL(request.url).pathname, { method, headers: request.headers, ...(body !== undefined ? { body } : {}) })
    },
  }
  const servers: Awaited<ReturnType<typeof listenApiServer>>[] = []
  const open = async (agent: 'connected' | 'missing' | 'missing-token' = 'connected') => {
    const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, entryPoint: 'xwhm', publicOrigin: ORIGIN, allowedOrigins: [ORIGIN], ingressSecret: INGRESS, requireSecureCookies: true, requireOriginHeader: true,
      ...(agent !== 'missing' ? { agentApp } : {}), ...(agent === 'connected' ? { agentToken: 'a'.repeat(64) } : {}),
    })
    const server = await listenApiServer(app, { host: '127.0.0.1', port: 0 })
    servers.push(server)
    cleanup.push(() => { server.server.closeAllConnections(); return server.close() })
    return server.port
  }
  const port = await open()
  const request = (method: string, path: string, body?: unknown, options: { port?: number; session?: typeof rootSession; csrf?: string; origin?: string } = {}): Promise<Response> => new Promise((resolve, reject) => {
    const auth = options.session ?? rootSession
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const outgoing = httpRequest({ hostname: '127.0.0.1', port: options.port ?? port, path, method, headers: { host: new URL(ORIGIN).host, origin: options.origin ?? ORIGIN, 'content-type': 'application/json', ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}), cookie: auth.cookie, 'x-csrf-token': options.csrf ?? auth.csrf, [INGRESS_SECRET_HEADER]: INGRESS, 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.20' } }, incoming => {
      const chunks: Buffer[] = []
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
      incoming.once('error', reject)
      incoming.once('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: incoming.headers as Record<string, string> })))
    })
    outgoing.once('error', reject)
    outgoing.end(payload)
  })
  const fingerprints = async () => {
    const entries: [string, string][] = []
    const operationalFiles = new Set(['', '-journal', '-wal', '-shm'].map(suffix => WRITER_MUTEX_FILE + suffix))
    const visit = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        // A raw close can cancel a process's POSIX SQLite locks; skip before opening.
        if (dir === state.rootDir && operationalFiles.has(entry.name)) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await visit(path)
        else if (entry.isFile()) entries.push([relative(state.rootDir, path), createHash('sha256').update(await readFile(path)).digest('hex')])
      }
    }
    await visit(state.rootDir)
    return entries.sort(([a], [b]) => a.localeCompare(b))
  }
  const identities = async () => ({
    principals: await database.db.query('SELECT id, account_id, disabled FROM principals ORDER BY id'),
    sessions: await database.db.query('SELECT id, principal_id, revoked_at FROM sessions ORDER BY id'),
    tokens: await database.db.query('SELECT id, principal_id, revoked_at FROM api_tokens ORDER BY id'),
  })
  const accountSuccess = async () => (await listAudit(database.db, { limit: 1000 })).filter(entry => entry.action.startsWith('account.') && entry.outcome === 'ok')
  const perform = async (action: Action, options: { port?: number; session?: typeof rootSession } = {}) => {
    if (action === 'create') return request('POST', '/api/accounts', { ...accountInput, username: 'newowner7', primaryDomain: 'newowner7.example.test', ownerId: null }, options)
    if (action === 'suspend' || action === 'unsuspend') return request('POST', '/api/accounts/' + account.id + '/' + action, { reason: 'Synthetic reason' }, options)
    if (action === 'update') return request('PATCH', '/api/accounts/' + account.id, { shell: 'jailed' }, options)
    return request('DELETE', '/api/accounts/' + account.id, { confirmUsername: account.username }, options)
  }
  return { database, state, plan, account, other, root, reseller, owner, alias, neighbor, rootSession, resellerSession, request, open, fingerprints, identities, accountSuccess, perform, holdNextApply, setMode: (value: Outcome) => { mode = value }, setPurge: (value: 'missing' | 'ready') => { purgeMode = value }, calls: () => calls }
}

describe('real HTTP account mutation security', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })

  it('reports an unknown result when the final read fails after account creation was committed', async () => {
    const original = f.state.store.listDomains.bind(f.state.store)
    vi.spyOn(f.state.store, 'listDomains').mockImplementation(async filter => {
      if (filter?.accountId) {
        const account = await f.state.store.getAccount(filter.accountId)
        if (account?.username === 'newowner7') throw new Error(RAW_HOST_MARKER)
      }
      return original(filter)
    })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await f.perform('create')
    const text = await response.text()
    expect(response.status).toBe(500)
    expect(JSON.parse(text)).toMatchObject({ code: 'INTERNAL_ERROR', details: { unknownOutcome: true, verificationRequired: true } })
    expect(JSON.parse(text).details).not.toHaveProperty('stateChanged')
    expect(text).not.toContain(RAW_HOST_MARKER)
    expect(await f.state.store.getAccountByUsername('newowner7')).toMatchObject({ primaryDomain: 'newowner7.example.test' })
    expect(await findPrincipalByUsername(f.database.db, 'newowner7')).toMatchObject({ kind: 'user' })
    expect(f.calls()).toBe(1)
    expect(errorLog).toHaveBeenCalled()
  })

  it.each(['missing-body', 'missing', 'empty', 'other-row', 'case-change', 'whitespace', 'wrong-type'])('refuses DELETE %s confirmation with zero lifecycle effects', async condition => {
    const beforeState = await f.fingerprints()
    const beforeIdentity = await f.identities()
    const confirmation = condition === 'missing-body' ? undefined : condition === 'missing' ? {} : { confirmUsername: condition === 'empty' ? '' : condition === 'other-row' ? f.other.username : condition === 'case-change' ? f.account.username.toUpperCase() : condition === 'whitespace' ? f.account.username + ' ' : 7 }
    const response = await f.request('DELETE', '/api/accounts/' + f.account.id, confirmation)
    expect.soft(response.status).toBe(422)
    expect.soft(await f.fingerprints()).toEqual(beforeState)
    expect.soft(await f.identities()).toEqual(beforeIdentity)
    expect.soft(await f.accountSuccess()).toEqual([])
    expect.soft(f.calls()).toBe(0)
  })

  it('does not disclose or mutate a foreign target even with its exact confirmation', async () => {
    const beforeState = await f.fingerprints()
    const beforeIdentity = await f.identities()
    const response = await f.request('DELETE', '/api/accounts/' + f.other.id, { confirmUsername: f.other.username }, { session: f.resellerSession })
    expect(response.status).toBe(404)
    expect(await f.fingerprints()).toEqual(beforeState)
    expect(await f.identities()).toEqual(beforeIdentity)
    expect(f.calls()).toBe(0)
  })

  it.each([...outcomes, 'applied'] as const)('does not finalize DELETE from generic %s without a target-bound purge contract', async outcome => {
    f.setMode(outcome)
    const beforeState = await f.fingerprints()
    const beforeIdentity = await f.identities()
    const response = await f.perform('delete')
    expect.soft(response.status).toBe(412)
    const data = await response.json() as { code?: string; details?: { verificationRequired?: boolean; stateChanged?: boolean }; ok?: boolean }
    expect.soft(data.code).toBe('PRECONDITION_FAILED')
    expect.soft(data.details?.verificationRequired).toBe(true)
    expect.soft(data.details?.stateChanged).toBe(false)
    expect.soft(data.ok).not.toBe(true)
    expect.soft(await f.fingerprints()).toEqual(beforeState)
    expect.soft(await f.identities()).toEqual(beforeIdentity)
    expect.soft(await f.accountSuccess()).toEqual([])
    expect.soft(f.calls()).toBe(0)
  })

  it.each(['create', 'suspend', 'unsuspend', 'update', 'delete'] as const)('refuses %s without a host connection before lifecycle effects', async action => {
    if (action === 'unsuspend') await f.state.store.suspendAccount(f.account.id, 'Fixture initial state')
    const port = await f.open('missing')
    const beforeState = await f.fingerprints()
    const beforeIdentity = await f.identities()
    const response = await f.perform(action, { port })
    expect.soft(response.status).toBe(412)
    expect.soft(await f.fingerprints()).toEqual(beforeState)
    expect.soft(await f.identities()).toEqual(beforeIdentity)
    expect.soft(await f.accountSuccess()).toEqual([])
    expect.soft(f.calls()).toBe(0)
  })

  it.each(['create', 'suspend', 'unsuspend', 'update'] as const)('refuses %s with missing protected agent credentials before lifecycle effects', async action => {
    if (action === 'unsuspend') await f.state.store.suspendAccount(f.account.id, 'Fixture initial state')
    const port = await f.open('missing-token')
    const beforeState = await f.fingerprints()
    const beforeIdentity = await f.identities()
    const response = await f.perform(action, { port })
    expect.soft(response.status).toBe(412)
    expect.soft(await f.fingerprints()).toEqual(beforeState)
    expect.soft(await f.identities()).toEqual(beforeIdentity)
    expect.soft(await f.accountSuccess()).toEqual([])
    expect.soft(f.calls()).toBe(0)
  })

  it.each(outcomes.flatMap(outcome => (['create', 'suspend', 'unsuspend', 'update'] as const).map(action => ({ outcome, action }))))('does not wrap $outcome as $action success', async ({ outcome, action }) => {
    if (action === 'unsuspend') await f.state.store.suspendAccount(f.account.id, 'Fixture initial state')
    f.setMode(outcome)
    const response = await f.perform(action)
    expect.soft(response.status).toBeGreaterThanOrEqual(400)
    const text = await response.text()
    expect.soft(text).not.toContain(RAW_HOST_MARKER)
    expect.soft(text).not.toContain('rolledBack')
    expect.soft(await f.accountSuccess()).toEqual([])
    for (const principal of [f.owner, f.alias, f.neighbor]) expect.soft(await findPrincipalByUsername(f.database.db, principal.username)).not.toBeNull()
    expect.soft(f.calls()).toBe(1)
  })

  it('rejects CSRF and cross-origin DELETE before all lifecycle effects', async () => {
    const beforeState = await f.fingerprints()
    const beforeIdentity = await f.identities()
    for (const options of [{ csrf: 'wrong' }, { origin: 'https://foreign.example.test:2087' }]) {
      expect((await f.request('DELETE', '/api/accounts/' + f.account.id, { confirmUsername: f.account.username }, options)).status).toBe(403)
    }
    expect(await f.fingerprints()).toEqual(beforeState)
    expect(await f.identities()).toEqual(beforeIdentity)
    expect(f.calls()).toBe(0)
  })
})

describe('account mutation outcomes and race boundaries', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })

  it.each(['create', 'suspend', 'unsuspend', 'update'] as const)('reports %s only as a global configuration apply requiring target verification', async action => {
    if (action === 'unsuspend') await f.state.store.suspendAccount(f.account.id, 'Fixture initial state')
    const response = await f.perform(action)
    expect(response.status).toBe(action === 'create' ? 201 : 200)
    const data = await response.json() as { account: { username: string }; execution: object; reconcile: { status: string }; operation?: unknown; jobId?: unknown }
    expect(data.execution).toEqual({ status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true })
    expect(data.reconcile.status).toBe('applied')
    expect(data.operation).toBeUndefined()
    expect(data.jobId).toBeUndefined()
    const audit = await f.accountSuccess()
    expect(audit).toHaveLength(1)
    expect(audit[0]!.action).toMatch(/^account\.desired\./)
    expect(audit[0]!.detail.execution).toEqual(data.execution)
    expect(f.calls()).toBe(1)
    if (action === 'create') {
      const principal = await findPrincipalByUsername(f.database.db, 'newowner7')
      expect(principal?.accountId).toBe((await f.state.store.getAccountByUsername('newowner7'))!.id)
    }
  })

  it('does not establish a new login principal before unknown host apply completes', async () => {
    f.setMode('http422')
    const response = await f.perform('create')
    expect(response.status).toBe(422)
    expect(await findPrincipalByUsername(f.database.db, 'newowner7')).toBeNull()
    expect(await f.state.store.getAccountByUsername('newowner7')).not.toBeNull()
    expect(await f.accountSuccess()).toEqual([])
  })

  it('refuses an existing foreign principal username before creating state or contacting the host', async () => {
    const beforeState = await f.fingerprints()
    const beforeIdentity = await f.identities()
    const response = await f.request('POST', '/api/accounts', { username: f.alias.username, passwordHash: HASH, primaryDomain: 'reserved7.example.test', planId: f.plan.id, ipv4: '192.0.2.43' })
    expect(response.status).toBe(409)
    // The short authorization lease advances fencing metadata; tenant state and identity remain unchanged.
    expect((await f.state.store.readSnapshot()).accounts.map(a => a.username)).toEqual(['other7', 'owner7'])
    expect(await f.identities()).toEqual(beforeIdentity)
    expect((await f.fingerprints()).filter(([path]) => path !== 'authority.json')).toEqual(beforeState.filter(([path]) => path !== 'authority.json'))
    expect(f.calls()).toBe(0)
  })

  it('does not invent a documentation IPv4 address when no authoritative server address exists', async () => {
    const beforeState = await f.fingerprints()
    const response = await f.request('POST', '/api/accounts', { username: 'newowner7', passwordHash: HASH, primaryDomain: 'newowner7.example.test', planId: f.plan.id })
    expect(response.status).toBe(412)
    expect((await f.fingerprints()).filter(([path]) => path !== 'authority.json')).toEqual(beforeState.filter(([path]) => path !== 'authority.json'))
    expect(await findPrincipalByUsername(f.database.db, 'newowner7')).toBeNull()
    expect(f.calls()).toBe(0)
  })

  it.each(['connected', 'missing'] as const)('updates a contact email through the index writer without a host call (%s)', async agent => {
    const port = await f.open(agent)
    const beforeIdentity = await f.identities()
    const response = await f.request('PATCH', '/api/accounts/' + f.account.id, { contactEmail: 'changed-metadata@example.test' }, { port })
    expect(response.status).toBe(200)
    expect((await f.state.store.getAccount(f.account.id))!.contactEmail).toBe('changed-metadata@example.test')
    const indexed = await f.database.db.query<{ contact_email: string }>('SELECT contact_email FROM idx_accounts WHERE id = $1', [f.account.id])
    expect(indexed[0]?.contact_email).toBe('changed-metadata@example.test')
    expect(await f.identities()).toEqual(beforeIdentity)
    expect(f.calls()).toBe(0)
  })

  it('restores the previous contact email when the index writer fails', async () => {
    vi.spyOn(dbApi, 'syncAccountContactIndex').mockRejectedValueOnce(new Error('Synthetic index outage'))
    const response = await f.request('PATCH', '/api/accounts/' + f.account.id, { contactEmail: 'changed-metadata@example.test' })
    expect(response.status).toBe(503)
    const data = await response.json() as { details: { stateChanged: boolean; reason: string } }
    expect(data.details).toMatchObject({ reason: 'contact_index_failed', stateChanged: false })
    expect((await f.state.store.getAccount(f.account.id))!.contactEmail).toBe('owner@example.test')
    expect(f.calls()).toBe(0)
  })

  it('changes every login for the account and leaves the neighbor untouched', async () => {
    const before = await f.identities()
    const response = await f.request('POST', '/api/accounts/' + f.account.id + '/password', { password: 'correct-horse-battery' })
    expect(response.status).toBe(200)
    const owner = await findPrincipalByUsername(f.database.db, f.owner.username)
    const alias = await findPrincipalByUsername(f.database.db, f.alias.username)
    const neighbor = await findPrincipalByUsername(f.database.db, f.neighbor.username)
    expect(owner?.passwordHash).not.toBe(HASH)
    expect(alias?.passwordHash).not.toBe(HASH)
    expect(neighbor?.passwordHash).toBe(HASH)
    const after = await f.identities()
    for (const row of after.sessions) if ([f.owner.id, f.alias.id].includes(String(row.principal_id))) expect(row.revoked_at).not.toBeNull()
    expect(after.sessions.filter(row => row.principal_id === f.neighbor.id)).toEqual(before.sessions.filter(row => row.principal_id === f.neighbor.id))
    expect(after.tokens.filter(row => row.principal_id === f.neighbor.id)).toEqual(before.tokens.filter(row => row.principal_id === f.neighbor.id))
    expect(f.calls()).toBe(0)
  })

  it('terminates an account only after the target-bound purge contract succeeds', async () => {
    f.setPurge('ready')
    const response = await f.request('DELETE', '/api/accounts/' + f.account.id, { confirmUsername: f.account.username })
    expect(response.status).toBe(200)
    expect(await f.state.store.getAccount(f.account.id)).toBeNull()
    expect(await f.database.db.query('SELECT id FROM principals WHERE account_id = $1', [f.account.id])).toEqual([])
    expect(await findPrincipalByUsername(f.database.db, f.neighbor.username)).not.toBeNull()
    expect(await f.state.store.getAccount(f.other.id)).not.toBeNull()
    expect(f.calls()).toBe(0)
  })

  it('revokes all linked aliases and tokens during suspension without changing disabled flags or neighbor access', async () => {
    await dbApi.setPrincipalDisabled(f.database.db, f.alias.id, true)
    const before = await f.identities()
    expect((await f.perform('suspend')).status).toBe(200)
    const after = await f.identities()
    expect(after.principals).toEqual(before.principals)
    const targets = new Set([f.owner.id, f.alias.id])
    for (const row of after.sessions) if (targets.has(String(row.principal_id))) expect(row.revoked_at).not.toBeNull()
    for (const row of after.tokens) if (targets.has(String(row.principal_id))) expect(row.revoked_at).not.toBeNull()
    expect(after.sessions.filter(row => row.principal_id === f.neighbor.id)).toEqual(before.sessions.filter(row => row.principal_id === f.neighbor.id))
    expect(after.tokens.filter(row => row.principal_id === f.neighbor.id)).toEqual(before.tokens.filter(row => row.principal_id === f.neighbor.id))
    expect((await f.perform('unsuspend')).status).toBe(200)
    expect((await dbApi.getPrincipal(f.database.db, f.alias.id))!.disabled).toBe(true)
    expect((await dbApi.getPrincipal(f.database.db, f.owner.id))!.disabled).toBe(false)
  })

  it('repairs a failed suspension revocation before making the account active again', async () => {
    vi.spyOn(dbApi, 'revokeAccountSessionsAndTokens').mockRejectedValueOnce(new Error('Synthetic DB outage'))
    const failed = await f.perform('suspend')
    expect(failed.status).toBe(503)
    expect((await f.state.store.getAccount(f.account.id))!.status).toBe('suspended')
    expect(f.calls()).toBe(0)
    const during = await f.identities()
    expect(during.sessions.find(row => row.principal_id === f.owner.id)!.revoked_at).toBeNull()
    expect((await f.perform('unsuspend')).status).toBe(200)
    const after = await f.identities()
    for (const row of after.sessions) if ([f.owner.id, f.alias.id].includes(String(row.principal_id))) expect(row.revoked_at).not.toBeNull()
    for (const row of after.tokens) if ([f.owner.id, f.alias.id].includes(String(row.principal_id))) expect(row.revoked_at).not.toBeNull()
    expect((await f.state.store.getAccount(f.account.id))!.status).toBe('active')
    expect(f.calls()).toBe(1)
  })

  it('keeps an account suspended if cleanup still fails before unsuspend', async () => {
    await f.state.store.suspendAccount(f.account.id, 'Fixture initial state')
    vi.spyOn(dbApi, 'revokeAccountSessionsAndTokens').mockRejectedValueOnce(new Error('Synthetic DB outage'))
    expect((await f.perform('unsuspend')).status).toBe(503)
    expect((await f.state.store.getAccount(f.account.id))!.status).toBe('suspended')
    expect(f.calls()).toBe(0)
    expect(await f.accountSuccess()).toEqual([])
  })

  it.each(['owner-transfer', 'acl-revoked'] as const)('rechecks %s under the authorization lease before a transition', async scenario => {
    const external = new StateStore(f.state.rootDir)
    const lock = f.state.store.getWriterLock()
    const acquire = lock.acquire.bind(lock)
    vi.spyOn(lock, 'acquire').mockImplementationOnce(async options => {
      if (scenario === 'owner-transfer') await external.changeOwner(f.account.id, null)
      else await external.updateReseller(f.reseller.id, { acl: ['list-accounts'] })
      return acquire(options)
    })
    const beforeIdentity = await f.identities()
    const response = await f.perform('suspend', { session: f.resellerSession })
    expect([403, 404, 409]).toContain(response.status)
    expect((await f.state.store.getAccount(f.account.id))!.status).toBe('active')
    expect(await f.identities()).toEqual(beforeIdentity)
    expect(await f.accountSuccess()).toEqual([])
    expect(f.calls()).toBe(0)
  })

  it('rejects an ownership change after authorization through revision CAS before side effects', async () => {
    const external = new StateStore(f.state.rootDir)
    const suspend = f.state.store.suspendAccount.bind(f.state.store)
    vi.spyOn(f.state.store, 'suspendAccount').mockImplementationOnce(async (id, reason, options) => {
      await external.changeOwner(f.account.id, null)
      return suspend(id, reason, options)
    })
    const beforeIdentity = await f.identities()
    expect((await f.perform('suspend', { session: f.resellerSession })).status).toBe(409)
    expect((await f.state.store.getAccount(f.account.id))!.status).toBe('active')
    expect(await f.identities()).toEqual(beforeIdentity)
    expect(await f.accountSuccess()).toEqual([])
    expect(f.calls()).toBe(0)
  })

  it.each(['suspend', 'unsuspend', 'update'] as const)('does not launch duplicate host work for concurrent identical %s requests', async action => {
    if (action === 'unsuspend') await f.state.store.suspendAccount(f.account.id, 'Fixture initial state')
    const held = f.holdNextApply()
    const first = f.perform(action)
    await held.entered
    let second: Response
    try { second = await f.perform(action) } finally { held.release() }
    expect(second!.status).toBe(409)
    expect((await first).status).toBe(200)
    expect(f.calls()).toBe(1)
  })

  it('reports an unknown target outcome when desired state changes during a global apply', async () => {
    const held = f.holdNextApply()
    const first = f.perform('suspend')
    await held.entered
    try { await new StateStore(f.state.rootDir).updateAccount(f.account.id, { contactEmail: 'concurrent@example.test' }) } finally { held.release() }
    const response = await first
    expect(response.status).toBe(409)
    const data = await response.json() as { details: { reason: string; verificationRequired: boolean } }
    expect(data.details.reason).toBe('state_changed_during_apply')
    expect(data.details.verificationRequired).toBe(true)
    expect(await f.accountSuccess()).toEqual([])
    expect(f.calls()).toBe(1)
  })
  it.each(['invalid-applied', 'oversized'] as const)('refuses %s host acknowledgment without false success or raw diagnostics', async mode => {
    f.setMode(mode)
    const beforeIdentity = await f.identities()
    const response = await f.perform('update')
    expect(response.status).toBe(503)
    const text = await response.text()
    expect(text).not.toContain(RAW_HOST_MARKER)
    expect(text.length).toBeLessThan(1024)
    expect(JSON.parse(text).details).toMatchObject({ verificationRequired: true, stateChanged: true, reason: 'host_reply_unverified' })
    expect(await f.identities()).toEqual(beforeIdentity)
    expect(await f.accountSuccess()).toEqual([])
    expect(f.calls()).toBe(1)
  })

  it('gives a new account a panel login and password change can create a missing identity', async () => {
    const created = await f.request('POST', '/api/accounts', {
      username: 'loginowner', primaryDomain: 'loginowner.example.test', planId: f.plan.id, password: 'SyntheticLogin!2026', ipv4: '192.0.2.42',
    })
    expect(created.status).toBe(201)
    const body = await created.json() as { account: { id: string; username: string }; reconcile: { status: string }; execution: { status: string; scope: string } }
    expect(body.account.username).toBe('loginowner')
    expect(body.reconcile.status).toBe('applied')
    expect(body.execution).toMatchObject({ status: 'configuration_applied', scope: 'global_configuration' })
    const principal = await findPrincipalByUsername(f.database.db, 'loginowner')
    expect(principal?.accountId).toBe(body.account.id)
    await deletePrincipal(f.database.db, principal!.id)
    const changed = await f.request('POST', '/api/accounts/' + body.account.id + '/password', { password: 'SyntheticLogin!2027' })
    expect(changed.status).toBe(200)
    const panelOrigin = 'https://panel.example.test:2083'
    const panel = createApiApp({
      db: f.database.db, store: f.state.store, serverSecret: SECRET, entryPoint: 'xpanel', publicOrigin: panelOrigin,
      allowedOrigins: [panelOrigin], ingressSecret: INGRESS, requireSecureCookies: true, requireOriginHeader: true,
    })
    const login = await panel.fetch(new Request(panelOrigin + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: panelOrigin, 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ username: 'loginowner', password: 'SyntheticLogin!2027' }),
    }), { remoteAddress: '192.0.2.20', tls: true })
    expect(login.status, await login.clone().text()).toBe(200)
    expect(await login.json()).toMatchObject({ principal: { username: 'loginowner', kind: 'user' } })
  })

  it('reports identity-establishment failure after host apply without claiming rollback or issuing login', async () => {
    vi.spyOn(dbApi, 'createUserPrincipal').mockRejectedValueOnce(new Error(RAW_HOST_MARKER))
    const response = await f.perform('create')
    const text = await response.text()
    expect(response.status, text).toBe(503)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(text).not.toContain(RAW_HOST_MARKER)
    expect(JSON.parse(text), text).toMatchObject({ code: 'SERVICE_UNAVAILABLE', details: { verificationRequired: true, stateChanged: true, reason: 'identity_establishment_unverified' } })
    expect(await findPrincipalByUsername(f.database.db, 'newowner7')).toBeNull()
    expect(await f.state.store.getAccountByUsername('newowner7')).not.toBeNull()
    expect(await f.accountSuccess()).toEqual([])
    expect(f.calls()).toBe(1)
  })

  it.each(['typed', 'unknown'] as const)('keeps %s admission retirement failure fail-closed after the request callback', async kind => {
    // Modeled retirement failure, not a native kernel/FD qualification fixture.
    vi.spyOn(lifecycleAdmission, 'withLifecycleWriterAdmission').mockImplementationOnce(async callback => {
      const response = await callback() as Response
      expect(response.status).toBe(201)
      throw kind === 'typed'
        ? new XpanelError('PRECONDITION_FAILED', RAW_HOST_MARKER, { unsafeDiagnostic: RAW_HOST_MARKER })
        : new Error(RAW_HOST_MARKER)
    })
    const response = await f.perform('create')
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(response.headers.get('set-cookie')).toBeNull()
    const text = await response.text()
    expect(text).not.toContain(RAW_HOST_MARKER)
    expect(text).not.toContain('PRECONDITION_FAILED')
    expect(JSON.parse(text)).toEqual({ error: 'Lifecycle writer admission is unavailable.' })
    expect(await f.state.store.getAccountByUsername('newowner7')).not.toBeNull()
    expect(f.calls()).toBe(1)
  })

  it.each([true, false])('uses only an explicitly configured primary IPv4 as an omitted-address default (isPrimary=%s)', async isPrimary => {
    await f.state.store.saveServerIp({ address: '192.0.2.70', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary, notes: '' })
    const beforeState = await f.fingerprints()
    const response = await f.request('POST', '/api/accounts', { username: 'newowner7', passwordHash: HASH, primaryDomain: 'newowner7.example.test', planId: f.plan.id })
    if (isPrimary) {
      expect(response.status).toBe(201)
      expect((await response.json() as { account: { ipv4: string } }).account.ipv4).toBe('192.0.2.70')
      expect(f.calls()).toBe(1)
    } else {
      expect(response.status).toBe(412)
      expect((await f.fingerprints()).filter(([path]) => path !== 'authority.json')).toEqual(beforeState.filter(([path]) => path !== 'authority.json'))
      expect(await findPrincipalByUsername(f.database.db, 'newowner7')).toBeNull()
      expect(f.calls()).toBe(0)
    }
  })

})
