import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { createRootPrincipal, createTestDb, listExternalIdentities } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import type { AuthenticatedCaller } from './auth.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'
import { createExternalAuth, EXTERNAL_AUTH_STATE } from './external-auth.ts'
import type { ExternalAuth, ExternalAuthHelpers } from './external-auth.ts'
import { ISSUER, oidcTestProvider } from './oidc-test-fixture.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const ORIGIN = 'https://whm.example.test:2087', COOKIE = '__Host-xpanel_external'
const reason = async (run: () => Promise<unknown>) => { try { await run(); return 'passed' } catch (error) { return isXpanelError(error) ? `${error.code}:${String(error.detail.reason ?? '')}` : error } }

describe('external sign-in with OpenID Connect', () => {
  let db: TestDbHandle, root = '', rootId = ''
  beforeEach(async () => {
    db = await createTestDb(); root = await mkdtemp(join(tmpdir(), 'xp-oidc-'))
    rootId = (await createRootPrincipal(db.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })).id
  })
  afterEach(async () => { await db.close(); await rm(root, { recursive: true, force: true }) })

  const setup = () => {
    const { idp, fetcher } = oidcTestProvider()
    const events: string[] = []
    const caller = { principal: { kind: 'root', id: rootId, username: 'root' }, principalRecord: {}, sessionId: 's1', apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
    const lease = { assertFencingToken: async () => undefined, release: async () => undefined }
    const helpers: ExternalAuthHelpers = {
      db: db.db, store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) } as unknown as ExternalAuthHelpers['store'],
      requireCaller: async () => caller, assertRoot: async () => undefined, emitAudit: async entry => { events.push(entry.action + ':' + entry.outcome + (entry.detail?.reason ? ':' + String(entry.detail.reason) : '')) },
      verifyPassword: async (_caller, password) => password === 'current-password', checkLockout: async () => null, recordFailure: async () => undefined,
      entryPoint: 'xwhm', publicOrigin: ORIGIN, otherOrigins: { xpanel: 'https://panel.example.test:2083' }, secureCookies: () => true, fetch: fetcher,
    }
    const auth = createExternalAuth(helpers)
    let cookie = ''
    const send = async (path: string, method = 'GET', body?: unknown) => {
      const response = await auth.handle(new Request(ORIGIN + path, { method, headers: { ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(ORIGIN + path), method)
      const set = response?.headers.get('set-cookie')
      if (set) cookie = /=([^;]*)/.exec(set)![1]!
      return response!
    }
    /** Follows the browser through the provider: records the request parameters, then lands on the callback. */
    const throughProvider = async (authorizationUrl: string, patch: Record<string, string> = {}) => {
      const url = new URL(authorizationUrl)
      expect(url.origin + url.pathname).toBe(ISSUER + '/authorize')
      expect(url.searchParams.get('redirect_uri')).toBe(ORIGIN + '/api/auth/oidc/callback')
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      idp.challenge = url.searchParams.get('code_challenge')!; idp.nonce = url.searchParams.get('nonce')!
      const query = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'one-time-code', ...patch })
      return send('/api/auth/oidc/callback?' + query)
    }
    const saveProviders = async (providers: unknown[]) => {
      const current = await (await send('/api/server/sec/external-auth')).json()
      return send('/api/server/sec/external-auth', 'PUT', { expectedRevision: current.revision, providers })
    }
    const corp = { id: 'corp', label: 'Corporate sign-in', issuer: ISSUER, clientId: 'panel', clientSecret: 's3cret', entryPoints: { xpanel: false, xwhm: true } }
    return { idp, events, auth, send, throughProvider, saveProviders, corp, setCookie: (value: string) => { cookie = value }, request: () => new Request(ORIGIN + '/api/auth/login', { headers: { cookie: `${COOKIE}=${cookie}` } }) }
  }

  it('links an identity only after a password-confirmed request and then signs in with it, once', async () => {
    const t = setup(), auth: ExternalAuth = t.auth
    const saved = await (await t.saveProviders([t.corp])).json()
    expect(saved.providers).toEqual([expect.objectContaining({ id: 'corp', clientId: 'panel', entryPoints: { xpanel: false, xwhm: true } })])
    expect(JSON.stringify(saved)).not.toContain('s3cret')
    expect(saved.redirectUris).toEqual({ xpanel: 'https://panel.example.test:2083/api/auth/oidc/callback', xwhm: ORIGIN + '/api/auth/oidc/callback' })
    expect((await stat(join(root, EXTERNAL_AUTH_STATE))).mode & 0o077).toBe(0)

    expect(await reason(() => t.send('/api/auth/external-identities/start', 'POST', { providerId: 'corp', currentPassword: 'wrong' }))).toBe('UNAUTHENTICATED:')
    const started = await t.send('/api/auth/external-identities/start', 'POST', { providerId: 'corp', currentPassword: 'current-password' })
    const landed = await t.throughProvider((await started.json()).authorizationUrl)
    expect(landed.status).toBe(303)
    expect(landed.headers.get('location')).toBe('/whm/security/sign-in?external=verified')
    expect((await t.send('/api/auth/external-identities', 'POST', {})).status).toBe(201)
    expect((await listExternalIdentities(db.db, { principalId: rootId })).map(item => [item.issuer, item.subject, item.label])).toEqual([[ISSUER, 'person-1', 'admin@example.test']])

    const begin = await t.send('/api/auth/oidc/start?provider=corp')
    expect(begin.status).toBe(303)
    expect((await t.throughProvider(begin.headers.get('location')!)).headers.get('location')).toBe('/login?external=verified')
    expect(await (await t.send('/api/auth/oidc/pending')).json()).toMatchObject({ pending: true, username: 'root', provider: { id: 'corp' } })
    expect(await auth.redeemSignIn(t.request())).toEqual({ principalId: rootId, username: 'root', providerId: 'corp' })
    expect(await reason(() => auth.redeemSignIn(t.request()))).toBe('UNAUTHENTICATED:external_flow_missing')
    expect(t.events).toEqual(expect.arrayContaining(['auth.external_identity_linked:ok', 'auth.external_verified:ok', 'server.sec.external_auth.saved:ok']))
  })

  it('refuses a callback from another browser, a replayed state, an unlinked identity and a disabled provider', async () => {
    const t = setup()
    await t.saveProviders([t.corp])
    const begin = await t.send('/api/auth/oidc/start?provider=corp')
    const location = begin.headers.get('location')!
    t.setCookie('')
    // Login CSRF: the attacker's own callback URL opened in a browser that never started the flow.
    expect((await t.throughProvider(location)).headers.get('location')).toBe('/login?external=failed&reason=state_invalid')
    expect((await t.throughProvider(location)).headers.get('location')).toBe('/login?external=failed&reason=state_invalid')

    t.idp.subject = 'stranger'
    const again = await t.send('/api/auth/oidc/start?provider=corp')
    expect((await t.throughProvider(again.headers.get('location')!)).headers.get('location')).toBe('/login?external=verified')
    expect(await reason(() => t.auth.redeemSignIn(t.request()))).toBe('UNAUTHENTICATED:identity_not_linked')

    const mixed = await t.send('/api/auth/oidc/start?provider=corp')
    expect((await t.throughProvider(mixed.headers.get('location')!, { iss: 'https://evil.example.test' })).headers.get('location')).toBe('/login?external=failed&reason=issuer_mismatch')
    t.idp.refuse = true
    const refused = await t.send('/api/auth/oidc/start?provider=corp')
    expect((await t.throughProvider(refused.headers.get('location')!)).headers.get('location')).toBe('/login?external=failed&reason=provider_refused')

    t.idp.refuse = false
    const pending = await t.send('/api/auth/oidc/start?provider=corp')
    await t.saveProviders([{ ...t.corp, clientSecret: undefined, entryPoints: { xpanel: true, xwhm: false } }])
    expect((await t.throughProvider(pending.headers.get('location')!)).headers.get('location')).toBe('/login?external=failed&reason=provider_disabled')
    expect((await t.send('/api/auth/oidc/start?provider=corp')).headers.get('location')).toBe('/login?external=failed&reason=provider_disabled')
  })

  it('saves only providers that pass discovery and revokes links of a removed provider', async () => {
    const t = setup()
    expect(await reason(() => t.saveProviders([{ ...t.corp, issuer: 'https://unknown.example.test' }]))).toBe('PRECONDITION_FAILED:provider_refused')
    expect(await reason(() => t.saveProviders([{ ...t.corp, clientSecret: undefined }]))).toBe('VALIDATION:')
    expect(await reason(() => t.saveProviders([{ ...t.corp, issuer: 'http://id.example.test' }]))).toBe('VALIDATION:')
    await t.saveProviders([t.corp])
    const started = await t.send('/api/auth/external-identities/start', 'POST', { providerId: 'corp', currentPassword: 'current-password' })
    await t.throughProvider((await started.json()).authorizationUrl)
    await t.send('/api/auth/external-identities', 'POST', {})
    expect(await reason(() => t.saveProviders([{ ...t.corp, issuer: ISSUER + '/other' }]))).toBe('VALIDATION:')
    const removed = await (await t.saveProviders([])).json()
    expect(removed.providers).toEqual([])
    expect(await listExternalIdentities(db.db, { principalId: rootId })).toEqual([])
    expect(t.events).toContain('server.sec.external_auth.saved:ok')
  })

  it('is admitted on the panel listeners and never on xMail', () => {
    for (const path of ['/api/auth/oidc/start', '/api/auth/oidc/callback', '/api/auth/oidc/pending']) {
      expect(entryPointAllowsApiRoute('xwhm', path, 'GET')).toBe(true)
      expect(entryPointAllowsApiRoute('xmail', path, 'GET')).toBe(false)
    }
    expect(entryPointAllowsApiRoute('xpanel', '/api/auth/external-identities/00000000-0000-4000-8000-000000000000', 'DELETE')).toBe(true)
    expect(entryPointAllowsApiRoute('xpanel', '/api/server/sec/external-auth', 'GET')).toBe(false)
  })
})
