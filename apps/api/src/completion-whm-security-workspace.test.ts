import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiToken, createResellerPrincipal, createRootPrincipal, createSession, createTestDb, setPrincipalDisabled } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { createAgentApp, FakeHostExecutor } from '@xpanel/agent'
import type { HostReconciler } from '@xpanel/agent'
import { deriveCsrfToken, sha256Hex } from './auth.ts'
import { sessionCookieName, sessionTokenHash } from './entry-points.ts'
import { createApiApp, listenApiServer } from './server.ts'

// Actual loopback HTTP/session/CSRF and protected Agent dispatch, with disposable
// stores and a declared memory-only host. No SSH, key or native qualification.
// Independent public libargon2 test vector; these are not operational credentials.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const origin = 'https://security.example.test:2087'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks(); const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Security fixture cleanup failed')
})
const publicKey = () => {
  const value = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' })
  const field = (bytes: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); return Buffer.concat([size, bytes]) }
  return 'ssh-ed25519 ' + Buffer.concat([field(Buffer.from('ssh-ed25519')), field(Buffer.from(value.x!, 'base64url'))]).toString('base64') + ' synthetic-test'
}
// Interactive xWHM listeners refuse bearer tokens by contract, so their default caller is a real
// audience-bound root session; bearer scope checks use the token-capable API listener.
async function fixture(options: { qualifiedGate?: boolean; transport?: boolean; listener?: 'xwhm' | 'api' } = {}) {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const reseller = await state.store.createReseller({ username: 'securityseller', passwordHash: HASH, acl: ['list-accounts'], maxAccounts: 2, totalDiskMb: 1000, totalBandwidthMb: 1000, oversell: false, nameservers: [], delegatedIps: [] })
  await createResellerPrincipal(database.db, { id: reseller.id, username: reseller.username, passwordHash: HASH })
  const token = async (principalId: string, scopes = ['*']) => {
    const raw = 'xp_' + randomUUID()
    await createApiToken(database.db, { principalId, name: 'Synthetic security HTTP', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const rootToken = await token(root.id), resellerToken = await token(reseller.id), secret = randomBytes(32).toString('hex'), agentToken = randomBytes(32).toString('hex')
  const executor = new FakeHostExecutor()
  executor.files.set('/etc/os-release', { path: '/etc/os-release', content: 'ID=ubuntu\nVERSION_ID="24.04"\nID_LIKE=debian\n', mode: 0o644 })
  const agent = createAgentApp({ db: database.db, store: state.store, reconciler: { subscribe: () => () => {} } as unknown as HostReconciler, executor, os: { id: 'ubuntu', versionId: '24.04', family: 'debian' }, agentToken })
  const dispatch = vi.spyOn(agent, 'fetch'); let revokeOnGate = false
  const gate = vi.fn(async () => { if (revokeOnGate) await setPrincipalDisabled(database.db, root.id, true) })
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: secret, ...(options.listener === 'api' ? {} : { entryPoint: 'xwhm' as const }), publicOrigin: origin, allowedOrigins: [origin], secureCookies: true, requireOriginHeader: true,
    ...(options.transport === false ? {} : { agentApp: agent, agentToken }), ...(options.qualifiedGate ? { assertSshKeyMutationQualified: gate } : {}) })
  const server = await listenApiServer(app, { host: '127.0.0.1', port: 0 }); cleanup.push(() => { server.server.closeAllConnections(); return server.close() })
  let rootSession: { cookie: string; csrf: string } | null = null
  const request = (path: string, method = 'GET', body?: unknown, auth: { bearer?: string | null; cookie?: string; csrf?: string; origin?: string | null } = {}): Promise<Response> => new Promise((resolve, reject) => {
    const interactive = auth.bearer === undefined && auth.cookie === undefined ? rootSession : null
    const bearer = auth.bearer === undefined ? (interactive ? null : rootToken) : auth.bearer
    auth = { ...auth, cookie: auth.cookie ?? interactive?.cookie, csrf: auth.csrf ?? interactive?.csrf }
    const req = httpRequest({ hostname: '127.0.0.1', port: server.port, path, method, headers: { host: new URL(origin).host,
      ...(auth.origin === null ? {} : { origin: auth.origin ?? origin }), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(auth.cookie ? { cookie: auth.cookie } : {}), ...(auth.csrf ? { 'x-csrf-token': auth.csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('error', reject)
      response.on('end', () => { const headers = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value); resolve(new Response(Buffer.concat(chunks), { status: response.statusCode!, headers })) })
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const session = async (profile: 'xpanel' | 'xwhm' = 'xwhm') => {
    const raw = randomBytes(32).toString('hex')
    await createSession(database.db, { principalId: root.id, tokenHash: sessionTokenHash(raw, profile), expiresAt: new Date(Date.now() + 60000).toISOString() })
    return { cookie: sessionCookieName('xwhm', true) + '=' + raw, csrf: deriveCsrfToken(raw, secret, profile) }
  }
  if (options.listener !== 'api') rootSession = await session()
  return { database, state, root, rootToken, resellerToken, token, executor, dispatch, gate, request, session, revokeOnGate: () => { revokeOnGate = true } }
}
const keyBody = () => ({ publicKey: publicKey(), expectedRevision: 'a'.repeat(64) })

describe('xWHM security protected loopback HTTP', () => {
  it('authenticates root and forwards its exact identity to actual Agent routing without inventing host success', async () => {
    const f = await fixture(), response = await f.request('/api/security/workspace')
    expect(response.status).toBe(200)
    const value = await response.json() as { overall: string; checks: Array<{ state: string }> }
    expect(value.overall).toBe('not-qualified'); expect(value.checks).toHaveLength(5)
    expect(value.checks.every(check => check.state === 'unavailable')).toBe(true)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    const forwarded = f.dispatch.mock.calls[0]![0]
    expect(forwarded.headers.get('x-xpanel-principal-id')).toBe(f.root.id)
    expect(new URL(forwarded.url).pathname).toBe('/host/security/ssh')
    expect(f.executor.executedActions).toHaveLength(0)
  })
  it('keeps authentication, current root authority and bearer scopes mandatory', async () => {
    const interactive = await fixture()
    expect((await interactive.request('/api/security/ssh', 'GET', undefined, { bearer: interactive.rootToken })).status).toBe(401)
    expect(interactive.dispatch).not.toHaveBeenCalled()
    const f = await fixture({ listener: 'api' })
    expect((await f.request('/api/security/ssh', 'GET', undefined, { bearer: null })).status).toBe(401)
    expect((await f.request('/api/security/ssh', 'GET', undefined, { bearer: f.resellerToken })).status).toBe(403)
    expect((await f.request('/api/security/ssh', 'GET', undefined, { bearer: await f.token(f.root.id, ['dns:read']) })).status).toBe(403)
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('preserves the exact 7-day selector and rejects selector injection before native dispatch', async () => {
    const f = await fixture(), result = await f.request('/api/security/ssh?window=7d')
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ ssh: { failedLogins: { window: '7d', state: 'unavailable' } }, keyActions: { add: false, remove: false } })
    expect(new URL(f.dispatch.mock.calls[0]![0].url).searchParams.get('window')).toBe('7d')
    f.dispatch.mockClear()
    for (const path of ['/api/security/ssh?window=7d&window=24h', '/api/security/workspace?path=/etc/passwd']) expect((await f.request(path)).status).toBe(422)
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('requires audience-bound session CSRF and origin, then defaults key mutation admission to denial', async () => {
    const f = await fixture(), session = await f.session(), body = keyBody(), path = '/api/security/ssh/keys'
    expect((await f.request(path, 'POST', body, { bearer: null, cookie: session.cookie })).status).toBe(403)
    expect((await f.request(path, 'POST', body, { bearer: null, ...session, csrf: 'wrong' })).status).toBe(403)
    expect((await f.request(path, 'POST', body, { bearer: null, ...session, origin: null })).status).toBe(403)
    const refused = await f.request(path, 'POST', body, { bearer: null, ...session })
    expect(refused.status).toBe(412); expect(await refused.json()).toMatchObject({ details: { stateChanged: false } })
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.executor.executedActions).toHaveLength(0)
  })
  it('refuses cross-panel session replay even with the destination cookie name', async () => {
    const f = await fixture(), session = await f.session('xpanel')
    expect((await f.request('/api/security/workspace', 'GET', undefined, { bearer: null, ...session })).status).toBe(401)
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('rechecks root revocation after trusted qualification and before any key RPC', async () => {
    const f = await fixture({ qualifiedGate: true }); f.revokeOnGate()
    const response = await f.request('/api/security/ssh/keys', 'POST', keyBody())
    expect(response.status).toBe(401); expect(f.gate).toHaveBeenCalledTimes(1)
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.executor.executedActions).toHaveLength(0)
  })
  it('rejects request-controlled qualification/profile fields before invoking the host bridge', async () => {
    const f = await fixture()
    for (const extra of [{ qualified: true }, { accountId: randomUUID() }, { profile: '/tmp/sshd_config' }]) expect((await f.request('/api/security/ssh/keys', 'POST', { ...keyBody(), ...extra })).status).toBe(422)
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('keeps workspace configuration evidence available when protected host transport is absent', async () => {
    const f = await fixture({ transport: false }), response = await f.request('/api/security/workspace')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ssh: null, overall: 'not-qualified', checks: expect.arrayContaining([{ id: 'ssh-service', source: 'host-observation', state: 'unavailable', value: null }]) })
    expect((await f.request('/api/security/ssh')).status).toBe(412)
    expect(f.dispatch).not.toHaveBeenCalled()
  })
})
