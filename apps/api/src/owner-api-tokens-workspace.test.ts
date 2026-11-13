import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureMfaRuntimePolicy, fail, SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from '@xpanel/core'
import { createApiToken, createRootPrincipal, createSession, createTestDb, createUserPrincipal, findActiveApiTokenByHash, findActiveSessionByTokenHash, listApiTokensForPrincipal, renameApiToken, setTotpSecret } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { createStateStore, StateStore, type TestStateStoreHandle } from '@xpanel/state'
import { authenticateRequest, computeTotpCode, deriveCsrfToken, generateTotpSecret, sealTotpSecret, sha256Hex } from './auth.ts'
import { assertAuthPersonalOwner } from './auth-personal.ts'
import { sessionCookieName, sessionTokenHash } from './entry-points.ts'
import { createApiApp } from './server.ts'
import { handleOwnerApiTokensWorkspaceRoute, parseOwnerApiTokenCreate, assertOwnerApiTokenFeatureAccess } from './owner-api-tokens-workspace.ts'
import type { OwnerApiTokensWorkspaceHelpers } from './owner-api-tokens-workspace.ts'

const BASE = '/api/auth/api-tokens'
const OWNER_ORIGIN = 'https://localhost:2083'
const FOREIGN_ID = '00000000-0000-4000-8000-000000000001'
const SERVER_SECRET = 'isolated-owner-token-test-server-secret'
const PASSWORD = 'correct horse battery staple'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const createdBody = async (response: Response | null) => {
  if (!response || response.status !== 201) throw new Error('synthetic_create_was_not_accepted')
  const value: unknown = await response.json()
  if (!object(value) || !object(value.token) || typeof value.token.id !== 'string' || typeof value.secret !== 'string') throw new Error('invalid_synthetic_create_shape')
  return { id: value.token.id, secret: value.secret }
}

const OWNER_TOK_TMP = existsSync('/dev/shm') ? '/dev/shm' : tmpdir()
let ownerTokTplDir: string
let ownerTokSeed: {
  features: Awaited<ReturnType<TestStateStoreHandle['store']['createFeatureList']>>
  plan: Awaited<ReturnType<TestStateStoreHandle['store']['createPlan']>>
  account: Awaited<ReturnType<TestStateStoreHandle['store']['createAccount']>>
  neighborAccount: Awaited<ReturnType<TestStateStoreHandle['store']['createAccount']>>
}

beforeAll(async () => {
  await createTestDb().then(h => h.close())
  ownerTokTplDir = await mkdtemp(join(OWNER_TOK_TMP, 'xpanel-owntok-tpl-'))
  const tplStore = createStateStore(ownerTokTplDir)
  const features = await tplStore.createFeatureList({ name: 'Owner token features', ownerId: null, disabled: [] })
  const plan = await tplStore.createPlan({ name: 'Owner token plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
    caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 4 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await tplStore.saveServerIp({ address: '192.0.2.42', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })
  const accountInput = { passwordHash: PASSWORD_HASH, planId: plan.id, contactEmail: 'owner@example.test', ipv4: '192.0.2.42', shell: 'none' as const,
    php: { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} } }
  const account = await tplStore.createAccount({ ...accountInput, username: 'tokowner', primaryDomain: 'tokowner.example.test', ownerId: null })
  const neighborAccount = await tplStore.createAccount({ ...accountInput, username: 'tokother', primaryDomain: 'tokother.example.test', ownerId: null })
  ownerTokSeed = { features, plan, account, neighborAccount }
})

afterAll(async () => {
  if (ownerTokTplDir) await rm(ownerTokTplDir, { recursive: true, force: true })
})

async function fixture() {
  const database = await createTestDb()
  const rootDir = await mkdtemp(join(OWNER_TOK_TMP, 'xpanel-owntok-'))
  await cp(ownerTokTplDir, rootDir, { recursive: true, force: true })
  const state: TestStateStoreHandle = { store: createStateStore(rootDir), rootDir, close: () => rm(rootDir, { recursive: true, force: true }) }
  const { features, plan, account, neighborAccount } = ownerTokSeed
  const owner = await createUserPrincipal(database.db, { username: account.username, accountId: account.id, passwordHash: PASSWORD_HASH })
  const neighbor = await createUserPrincipal(database.db, { username: neighborAccount.username, accountId: neighborAccount.id, passwordHash: PASSWORD_HASH })
  let sessionSecret = 'isolated-owner-session-not-a-live-credential'
  let session = await createSession(database.db, { principalId: owner.id, tokenHash: sessionTokenHash(sessionSecret, 'xpanel'), expiresAt: new Date(Date.now() + 3600_000).toISOString(), mfaVerified: false })
  let policy = captureMfaRuntimePolicy()
  const audits: Parameters<OwnerApiTokensWorkspaceHelpers['emitAudit']>[0][] = []
  const request = (path: string, method = 'GET', body?: unknown, changes: Record<string, string | null> = {}) => {
    const headers = new Headers({ cookie: sessionCookieName('xpanel', true) + '=' + sessionSecret, 'x-csrf-token': deriveCsrfToken(sessionSecret, SERVER_SECRET, 'xpanel'), origin: OWNER_ORIGIN })
    if (body !== undefined) headers.set('content-type', 'application/json')
    for (const [key, value] of Object.entries(changes)) { if (value === null) headers.delete(key); else headers.set(key, value) }
    return new Request(OWNER_ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  const authenticate = async (db: Db, req: Request) => {
    const caller = await authenticateRequest(db, req, { serverSecret: SERVER_SECRET, entryPoint: 'xpanel', touchSession: false, mfaRuntimePolicy: policy })
    if (!caller) return fail('FORBIDDEN', 'the synthetic original session is not authenticated')
    assertAuthPersonalOwner(caller, 'xpanel')
    if (req.method !== 'GET' && (!caller.csrfValid || req.headers.get('origin') !== OWNER_ORIGIN)) return fail('FORBIDDEN', 'the synthetic CSRF/origin proof is missing')
    return caller
  }
  const helpers: OwnerApiTokensWorkspaceHelpers = { db: database.db, store: state.store, entryPoint: 'xpanel',
    requireCaller: req => authenticate(database.db, req), authorizeSession: (tx, req) => authenticate(tx, req), emitAudit: async event => { audits.push(event) } }
  const call = (path: string, method = 'GET', body?: unknown, override: Partial<OwnerApiTokensWorkspaceHelpers> = {}) => {
    const req = request(path, method, body)
    return handleOwnerApiTokensWorkspaceRoute(req, new URL(req.url), method, { ...helpers, ...override })
  }
  const create = (name = 'owner_sync', override: Partial<OwnerApiTokensWorkspaceHelpers> = {}) => call(BASE, 'POST', { name, scopes: ['files:read'], expiresInDays: 90 }, override)
  const app = () => createApiApp({ db: database.db, store: state.store, entryPoint: 'xpanel', publicOrigin: OWNER_ORIGIN, allowedOrigins: [OWNER_ORIGIN], requireOriginHeader: true, serverSecret: SERVER_SECRET, secureCookies: true, mfaRuntimePolicy: policy })
  const enrollCurrentSession = async (verifyFactor: boolean): Promise<void> => {
    const stale = request(BASE), secret = generateTotpSecret()
    await setTotpSecret(database.db, owner.id, sealTotpSecret(secret, SERVER_SECRET))
    expect(await authenticateRequest(database.db, stale, { serverSecret: SERVER_SECRET, entryPoint: 'xpanel', touchSession: false, mfaRuntimePolicy: policy }) === null).toBe(true)
    sessionSecret = randomUUID() + randomUUID()
    session = await createSession(database.db, { principalId: owner.id, tokenHash: sessionTokenHash(sessionSecret, 'xpanel'),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), mfaVerified: false })
    const pending = await authenticateRequest(database.db, request(BASE), { serverSecret: SERVER_SECRET, entryPoint: 'xpanel', touchSession: false, mfaRuntimePolicy: policy })
    if (!pending) throw new Error('current_enrolled_fixture_session_missing')
    expect(pending.principalRecord.totpEnabled).toBe(true)
    expect(session.mfaVerified).toBe(false)
    if (!verifyFactor) {
      expect(policy.mode).toBe('disabled')
      expect(pending.mfaVerified).toBe(true)
      assertAuthPersonalOwner(pending, 'xpanel')
      return
    }
    expect(pending.mfaVerified).toBe(false)
    expect(pending.scopes).toEqual(['mfa:verify'])
    expect(() => assertAuthPersonalOwner(pending, 'xpanel')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    // A verified current session comes from the real password/TOTP login, not a raw fixture MFA-bit grant.
    const login = await app().fetch(request('/api/auth/login', 'POST', { username: owner.username, password: PASSWORD, totpCode: computeTotpCode(secret) }))
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '', prefix = sessionCookieName('xpanel', true) + '='
    if (!cookie.startsWith(prefix)) throw new Error('verified_fixture_cookie_missing')
    const raw = decodeURIComponent(cookie.slice(prefix.length))
    if (!raw) throw new Error('verified_fixture_cookie_empty')
    const current = await findActiveSessionByTokenHash(database.db, sessionTokenHash(raw, 'xpanel'))
    if (!current) throw new Error('verified_fixture_session_missing')
    sessionSecret = raw; session = current
    expect(session.mfaVerified).toBe(true)
    expect((await authenticate(database.db, request(BASE))).mfaVerified).toBe(true)
  }
  return { database, state, features, plan, account, neighborAccount, owner, neighbor, get session() { return session }, get sessionSecret() { return sessionSecret }, request, helpers, call, create, audits, app, enrollCurrentSession,
    setPolicy: (next: typeof policy) => { policy = next }, close: async () => { await database.close(); await state.close() } }
}
let f: Awaited<ReturnType<typeof fixture>>
beforeEach(() => { vi.stubEnv('NODE_ENV', 'production') })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const useFixture = (): void => { beforeEach(async () => { f = await fixture() }); afterEach(async () => { await f.close() }) }

function deferred() { let release: (() => void) | undefined; const promise = new Promise<void>(done => { release = done }); return { promise, resolve: () => { if (!release) throw new Error('gate_not_initialized'); release() } } }
function queuedMutation(db: Db, mutate: (tx: Db) => Promise<void>) {
  const entered = deferred(), enqueued = deferred(), release = deferred()
  let held: Promise<void> | undefined, intercepted = false
  const runner: Db = {
    query: <T extends Record<string, unknown>>(text: string, params?: readonly unknown[]) => db.query<T>(text, params), exec: script => db.exec(script),
    transaction: async <T>(work: (tx: Db) => Promise<T>): Promise<T> => {
      if (intercepted) return db.transaction(work)
      intercepted = true
      held = db.transaction(async tx => { entered.resolve(); await release.promise; await mutate(tx) })
      await entered.promise
      const pending = db.transaction(work); enqueued.resolve(); return pending
    },
  }
  return { runner, enqueued: enqueued.promise, release: release.resolve, held: () => held }
}

describe('owner API token input', () => {
  it.each(['*', 'server:read', 'auth:write', 'jobs:write', 'accounts:write', 'email:write', 'backups:create', 'files:*'])('refuses non-owner or noncanonical scope %s', scope => {
    expect(() => parseOwnerApiTokenCreate({ name: 'safe_name', scopes: [scope], expiresInDays: 90 })).toThrow()
  })
  it.each([undefined, null, 0, 366, 1.5, '90'])('requires a bounded explicit expiry %j', expiresInDays => {
    expect(() => parseOwnerApiTokenCreate({ name: 'safe_name', scopes: ['files:read'], expiresInDays })).toThrow()
  })
  it.each(['my token', '', 'a'.repeat(51), 'bad\nname', 'é'])('refuses invalid owner token name %j', name => {
    expect(() => parseOwnerApiTokenCreate({ name, scopes: ['files:read'], expiresInDays: 90 })).toThrow()
  })
  it('does not let readonly or an unknown selector widen the fixed account grant', () => {
    expect(() => parseOwnerApiTokenCreate({ name: 'safe', scopes: ['files:write'], expiresInDays: 90, readOnly: true })).toThrow()
    expect(() => parseOwnerApiTokenCreate({ name: 'safe', scopes: ['files:read'], expiresInDays: 90, principalId: FOREIGN_ID })).toThrow()
    expect(parseOwnerApiTokenCreate({ name: 'Safe_Name-2', scopes: ['files:read'], expiresInDays: 90, readOnly: true }).scopes).toEqual(['files:read'])
  })
  it('normalizes bounded allowed addresses and rejects duplicates or malformed CIDRs', () => {
    expect(parseOwnerApiTokenCreate({ name: 'safe', scopes: ['dns:read'], expiresInDays: 30, allowedIps: ['192.0.2.0/24'] }).allowedIps).toEqual(['192.0.2.0/24'])
    for (const allowedIps of [['192.0.2.1/24'], ['not-an-ip'], ['192.0.2.0/24', '192.0.2.0/24']]) expect(() => parseOwnerApiTokenCreate({ name: 'safe', scopes: ['files:read'], expiresInDays: 30, allowedIps })).toThrow()
  })
})

describe('owner API token authority and disclosure', { tags: ['feature'] }, () => {
  useFixture()
  it('creates one scoped secret, then exposes only metadata and real stored usage', async () => {
    const created = await createdBody(await f.create())
    const stored = (await listApiTokensForPrincipal(f.database.db, f.owner.id))[0]
    expect(!!stored && stored.tokenHash === sha256Hex(created.secret)).toBe(true)
    const reply = await f.call(BASE)
    if (!reply) throw new Error('missing_metadata_reply')
    const text = await reply.text()
    expect(text.includes(created.secret)).toBe(false)
    expect(text.includes('tokenHash') || text.includes('secret')).toBe(false)
    expect(f.audits.length).toBe(1)
    expect(JSON.stringify(f.audits).includes(created.secret)).toBe(false)
    const token = await findActiveApiTokenByHash(f.database.db, sha256Hex(created.secret))
    expect(token?.principalId === f.owner.id && token.scopes.join() === 'files:read').toBe(true)
  })
  it.each(['csrf', 'origin'] as const)('keeps the actual API %s fence before any token INSERT', async missing => {
    const app = f.app(), request = f.request(BASE, 'POST', { name: 'safe', scopes: ['files:read'], expiresInDays: 90 }, missing === 'csrf' ? { 'x-csrf-token': null } : { origin: 'https://foreign.invalid' })
    const response = await app.fetch(request)
    expect(response.status).toBe(403)
    expect((await listApiTokensForPrincipal(f.database.db, f.owner.id)).length).toBe(0)
  })
  it('uses the real xPanel listener route for its owner while retaining administrative denial', async () => {
    const app = f.app()
    expect((await app.fetch(f.request(BASE))).status).toBe(200)
    expect((await app.fetch(f.request('/api/server/panel/api-tokens'))).status).toBe(404)
    const selector = await app.fetch(f.request(BASE + '?principalId=' + f.neighbor.id))
    expect(selector.status).toBe(422)
    expect(await selector.json()).toMatchObject({ code: 'VALIDATION', details: { stateChanged: false } })
  })
  it('never lets a bearer token mint or list tokens', async () => {
    const created = await createdBody(await f.create())
    const request = f.request(BASE, 'GET', undefined, { authorization: 'Bearer ' + created.secret })
    await expect(handleOwnerApiTokensWorkspaceRoute(request, new URL(request.url), 'GET', f.helpers)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await listApiTokensForPrincipal(f.database.db, f.owner.id)).length).toBe(1)
  })
  it('enforces a created readonly grant on the real API listener before a file write', async () => {
    const created = await createdBody(await f.call(BASE, 'POST', { name: 'readonly_owner', scopes: ['files:read'], expiresInDays: 90, readOnly: true }))
    const api = createApiApp({ db: f.database.db, store: f.state.store, serverSecret: SERVER_SECRET, secureCookies: false })
    const response = await api.fetch(new Request('http://localhost/api/accounts/' + f.account.username + '/files', { method: 'POST', headers: { authorization: 'Bearer ' + created.secret, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'write', path: 'blocked.txt', content: 'not-written', overwrite: false }) }))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN', details: { requiredScope: 'files:write' } })
  })
  it('rejects a real root session instead of widening the administrative issuer', async () => {
    const root = await createRootPrincipal(f.database.db, { username: 'root', passwordHash: PASSWORD_HASH, forcePasswordChange: false })
    const session = await createSession(f.database.db, { principalId: root.id, tokenHash: sessionTokenHash('isolated-root-session', 'xwhm'), expiresAt: new Date(Date.now() + 60000).toISOString(), mfaVerified: true })
    const original = await f.helpers.requireCaller(f.request(BASE))
    await expect(f.create('no_root', { requireCaller: async () => ({ ...original, principal: { kind: 'root', id: root.id, username: root.username }, principalRecord: root, sessionId: session.id, sessionToken: 'isolated-root-session' }) })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await listApiTokensForPrincipal(f.database.db, root.id)).length).toBe(0)
  })
  it.each(['team', 'handoff', 'wrong-listener'] as const)('does not accept %s as the original owner', async denied => {
    const original = await f.helpers.requireCaller(f.request(BASE))
    const requireCaller: OwnerApiTokensWorkspaceHelpers['requireCaller'] = async () => denied === 'team'
      ? { ...original, team: { kind: 'team', id: f.neighbor.id, username: 'member', login: 'member', accountId: f.account.id, roles: ['administrator'] } }
      : denied === 'handoff' ? { ...original, impersonator: { principalId: f.neighbor.id, login: 'other' } } : original
    await expect(f.create('denied', { requireCaller, ...(denied === 'wrong-listener' ? { entryPoint: 'xwhm' } : {}) })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await listApiTokensForPrincipal(f.database.db, f.owner.id)).length).toBe(0)
  })
  it.each(['api-tokens', 'apitokens (Manage API Tokens)'])('rechecks the real disabled feature %s under state admission', async feature => {
    if (feature === 'api-tokens') await f.state.store.updateFeatureList(f.features.id, { disabled: [feature] })
    else {
      // Current writers accept canonical keys; the raw catalog label is a legacy read-compatibility fixture.
      await expect(f.state.store.updateFeatureList(f.features.id, { disabled: [feature] })).rejects.toMatchObject({ code: 'VALIDATION', message: 'invalid feature key' })
      const read = f.state.store.getFeatureList.bind(f.state.store)
      vi.spyOn(f.state.store, 'getFeatureList').mockImplementation(async (...args) => {
        const actual = await read(...args)
        return actual?.id === f.features.id ? { ...actual, disabled: [feature] } : actual
      })
      expect((await read(f.features.id))?.disabled).toEqual([])
    }
    await expect(f.create()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await listApiTokensForPrincipal(f.database.db, f.owner.id)).length).toBe(0)
  })
  it('releases the state writer before an audit callback that reads a real snapshot', async () => {
    const response = await f.create('audit_snapshot', { emitAudit: async () => { const snapshot = await f.state.store.readSnapshot(); expect(snapshot.accounts.some(account => account.id === f.account.id)).toBe(true) } })
    expect(response?.status).toBe(201)
  })
  it('revokes an unaudited credential without revealing it', async () => {
    await expect(f.create('audit_failure', { emitAudit: async () => { throw new Error('synthetic_audit_failure') } })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: false } })
    const rows = await listApiTokensForPrincipal(f.database.db, f.owner.id)
    expect(rows.length === 1 && rows.every(row => row.revokedAt !== null)).toBe(true)
  })
})

describe('owner token admitted concurrency', { tags: ['feature'] }, () => {
  useFixture()
  it.each([
    ['GET', 'before-effect', 'expiry'], ['GET', 'before-effect', 'absolute'], ['GET', 'before-effect', 'idle'],
    ['GET', 'before-commit', 'expiry'], ['GET', 'before-commit', 'absolute'], ['GET', 'before-commit', 'idle'],
    ['POST', 'before-effect', 'expiry'], ['POST', 'before-effect', 'absolute'], ['POST', 'before-effect', 'idle'],
    ['POST', 'before-commit', 'expiry'], ['POST', 'before-commit', 'absolute'], ['POST', 'before-commit', 'idle'],
  ] as const)('closes %s %s when persisted %s expires during the last source await', async (method, phase, boundary) => {
    const now = Date.now(), deadline = now + 1000
    const created = boundary === 'absolute' ? deadline - SESSION_ABSOLUTE_TIMEOUT_MS : boundary === 'idle' ? now - SESSION_IDLE_TIMEOUT_MS - 10000 : now
    const seen = boundary === 'idle' ? deadline - SESSION_IDLE_TIMEOUT_MS : now
    const expires = boundary === 'expiry' ? deadline : now + 3600_000
    await f.database.db.query('UPDATE sessions SET created_at = $1, last_seen_at = $2, expires_at = $3 WHERE id = $4', [new Date(created).toISOString(), new Date(seen).toISOString(), new Date(expires).toISOString(), f.session.id])
    let leaves = 0
    const getFeatureList = f.state.store.getFeatureList.bind(f.state.store)
    vi.spyOn(f.state.store, 'getFeatureList').mockImplementation(async id => {
      const result = await getFeatureList(id)
      leaves++
      if (leaves === (phase === 'before-effect' ? 1 : 2)) { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(deadline + 1) }
      return result
    })
    try {
      await expect(method === 'POST' ? f.create('late_expiry') : f.call(BASE)).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'the original owner session expired' })
      expect(leaves).toBe(phase === 'before-effect' ? 1 : 2)
      expect((await listApiTokensForPrincipal(f.database.db, f.owner.id)).length).toBe(0)
      expect(f.audits.length).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it.each(['revoked', 'expired', 'principal-disabled', 'force-change', 'mfa-cleared', 'account-rebound', 'audience-changed'] as const)('refuses %s by a real queued writer before issuing a credential', async change => {
    if (change === 'mfa-cleared') await f.enrollCurrentSession(true)
    const queue = queuedMutation(f.database.db, async tx => {
      if (change === 'revoked') await tx.query('UPDATE sessions SET revoked_at = $1 WHERE id = $2', [new Date().toISOString(), f.session.id])
      else if (change === 'expired') await tx.query('UPDATE sessions SET created_at = $1, last_seen_at = $1, expires_at = $2 WHERE id = $3', [new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() - 1).toISOString(), f.session.id])
      else if (change === 'mfa-cleared') await tx.query('UPDATE sessions SET mfa_verified = 0 WHERE id = $1', [f.session.id])
      else if (change === 'audience-changed') await tx.query('UPDATE sessions SET token_hash = $1 WHERE id = $2', [sessionTokenHash(f.sessionSecret, 'xwhm'), f.session.id])
      else if (change === 'account-rebound') await tx.query('UPDATE principals SET account_id = $1 WHERE id = $2', [f.neighborAccount.id, f.owner.id])
      else await tx.query(change === 'principal-disabled' ? 'UPDATE principals SET disabled = 1 WHERE id = $1' : 'UPDATE principals SET force_password_change = 1 WHERE id = $1', [f.owner.id])
    })
    const outcome = f.create('queued', { db: queue.runner }).then(response => ({ accepted: true, status: response?.status }), error => ({ accepted: false, code: object(error) ? error.code : undefined }))
    try {
      expect(await Promise.race([queue.enqueued.then(() => true), outcome.then(() => false)])).toBe(true)
      queue.release(); await queue.held()
      expect(await outcome).toMatchObject({ accepted: false, code: 'FORBIDDEN' })
      expect((await listApiTokensForPrincipal(f.database.db, f.owner.id)).length).toBe(0)
      expect(f.audits.length).toBe(0)
    } finally { queue.release(); await queue.held()?.catch(() => undefined); await outcome }
  })
  it('checks the feature after a state-writer wait instead of using the document projection', async () => {
    const lock = f.state.store.getWriterLock(), acquire = lock.acquire.bind(lock)
    vi.spyOn(lock, 'acquire').mockImplementationOnce(async options => {
      await new StateStore(f.state.rootDir).updateFeatureList(f.features.id, { disabled: ['api-tokens'] })
      return acquire(options)
    })
    await expect(f.create()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await listApiTokensForPrincipal(f.database.db, f.owner.id)).length).toBe(0)
  })
  it('rolls back an INSERT if the original credential is revoked during admitted work', async () => {
    let checks = 0
    await expect(f.create('rolled_back', { authorizeSession: async (tx, req, original) => {
      checks++
      if (checks === 2) await tx.query('UPDATE sessions SET revoked_at = $1 WHERE id = $2', [new Date().toISOString(), f.session.id])
      return f.helpers.authorizeSession(tx, req, original)
    } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await listApiTokensForPrincipal(f.database.db, f.owner.id)).length).toBe(0)
  })
  it('admits only one of two creates when the real account has one active slot left', async () => {
    await f.database.db.transaction(async tx => {
      for (let index = 0; index < 49; index++) await createApiToken(tx, { principalId: f.owner.id, name: 'seed_' + index, tokenHash: sha256Hex('isolated-seed-token-' + index), scopes: ['files:read'], expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    })
    const results = await Promise.allSettled([f.create('last_slot_one'), f.create('last_slot_two')])
    expect(results.filter(result => result.status === 'fulfilled').length).toBe(1)
    expect(results.filter(result => result.status === 'rejected' && object(result.reason) && result.reason.code === 'CONFLICT').length).toBe(1)
    expect((await listApiTokensForPrincipal(f.database.db, f.owner.id)).filter(row => row.revokedAt === null).length).toBe(50)
  })
  it.each(['optional-unenrolled', 'development-disabled'] as const)('retains %s without mandatory enrollment', async mode => {
    if (mode === 'development-disabled') { vi.stubEnv('NODE_ENV', 'development'); f.setPolicy(captureMfaRuntimePolicy()); await f.enrollCurrentSession(false) }
    expect(f.session.mfaVerified).toBe(false)
    expect((await f.helpers.requireCaller(f.request(BASE))).mfaVerified).toBe(true)
    expect((await f.create())?.status).toBe(201)
  })
})

describe('owned token rename and revoke', { tags: ['feature'] }, () => {
  useFixture()
  it('renames one owned record without changing the credential or exposing it', async () => {
    const created = await createdBody(await f.create())
    await createApiToken(f.database.db, { principalId: f.neighbor.id, name: 'Renamed_owner', tokenHash: sha256Hex('isolated-neighbor-same-name'), scopes: ['files:read'], expiresAt: new Date(Date.now() + 60000).toISOString() })
    const response = await f.call(BASE + '/' + created.id, 'PATCH', { name: 'Renamed_owner' })
    if (!response) throw new Error('missing_rename_reply')
    expect(response.status).toBe(200)
    expect((await response.text()).includes(created.secret)).toBe(false)
    const token = await findActiveApiTokenByHash(f.database.db, sha256Hex(created.secret))
    expect(token?.name).toBe('Renamed_owner')
    expect((await listApiTokensForPrincipal(f.database.db, f.neighbor.id))[0]?.name).toBe('Renamed_owner')
  })
  it('denies foreign rename and single/bulk revocation without changing any owned token', async () => {
    const mine = await createdBody(await f.create()), foreign = await createApiToken(f.database.db, { principalId: f.neighbor.id, name: 'foreign', tokenHash: sha256Hex('isolated-neighbor-token'), scopes: ['files:read'], expiresAt: new Date(Date.now() + 60000).toISOString() })
    await expect(f.database.db.transaction(tx => renameApiToken(tx, foreign.id, f.owner.id, 'stolen'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    for (const [path, method, body] of [[BASE + '/' + foreign.id, 'PATCH', { name: 'stolen' }], [BASE + '/' + foreign.id + '/revoke', 'POST', undefined], [BASE + '/revoke', 'POST', { ids: [mine.id, foreign.id] }]] as const) {
      await expect(f.call(path, method, body)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    expect((await listApiTokensForPrincipal(f.database.db, f.owner.id)).every(token => token.revokedAt === null)).toBe(true)
    expect((await listApiTokensForPrincipal(f.database.db, f.neighbor.id)).every(token => token.name === 'foreign' && token.revokedAt === null)).toBe(true)
  })
  it('keeps duplicate names scoped to the owner and serializes two conflicting renames', async () => {
    const first = await createdBody(await f.create('first')), second = await createdBody(await f.create('second'))
    const outcomes = await Promise.allSettled([f.call(BASE + '/' + first.id, 'PATCH', { name: 'Shared_Name' }), f.call(BASE + '/' + second.id, 'PATCH', { name: 'shared_name' })])
    expect(outcomes.filter(result => result.status === 'fulfilled').length).toBe(1)
    expect(outcomes.filter(result => result.status === 'rejected' && object(result.reason) && result.reason.code === 'CONFLICT').length).toBe(1)
    expect((await listApiTokensForPrincipal(f.database.db, f.owner.id)).filter(token => token.name.toLowerCase() === 'shared_name').length).toBe(1)
  })
  it('revokes a confirmed owned bulk atomically and makes both credentials stop authenticating', async () => {
    const first = await createdBody(await f.create('first')), second = await createdBody(await f.create('second'))
    const response = await f.call(BASE + '/revoke', 'POST', { ids: [first.id, second.id] })
    expect(response?.status).toBe(200)
    expect(await findActiveApiTokenByHash(f.database.db, sha256Hex(first.secret))).toBeNull()
    expect(await findActiveApiTokenByHash(f.database.db, sha256Hex(second.secret))).toBeNull()
    if (!response) throw new Error('missing_bulk_reply')
    const text = await response.text(); expect(text.includes(first.secret) || text.includes(second.secret) || text.includes('tokenHash')).toBe(false)
  })
  it('reports a saved rename audit failure truthfully without returning a secret', async () => {
    const created = await createdBody(await f.create())
    await expect(f.call(BASE + '/' + created.id, 'PATCH', { name: 'Saved_name' }, { emitAudit: async () => { throw new Error('synthetic_audit_failure') } })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } })
    expect((await listApiTokensForPrincipal(f.database.db, f.owner.id))[0]?.name).toBe('Saved_name')
  })
  it('keeps metadata reads separate from feature verification and never infers native qualification', async () => {
    const owner = await f.helpers.requireCaller(f.request(BASE))
    const account = await assertOwnerApiTokenFeatureAccess(f.state.store, owner)
    expect(account.id).toBe(f.account.id)
    expect((await f.call(BASE))?.status).toBe(200)
  })
})
