import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRootPrincipal, createTestDb, createUserPrincipal, linkExternalIdentity, listSessionsForPrincipal, listVerifiedIps, replaceSecurityQuestions, setTotpSecret } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { computeTotpCode, hashPasswordArgon2id, sealTotpSecret, sha256Hex } from './auth.ts'
import { EXTERNAL_AUTH_STATE } from './external-auth.ts'
import { ISSUER, oidcTestProvider } from './oidc-test-fixture.ts'
import { SECURITY_QUESTIONS_POLICY } from './security-questions.ts'
import { createApiApp } from './server.ts'
import type { ApiApp } from './server.ts'

// The security-question step and the external sign-in entry of the real login path.
const PASSWORD = 'Root-Password-2026'
let db: TestDbHandle, state: TestStateStoreHandle, app: ApiApp, rootId = ''
beforeEach(async () => {
  db = await createTestDb(); state = await createTestStateStore()
  rootId = (await createRootPrincipal(db.db, { username: 'root', passwordHash: await hashPasswordArgon2id(PASSWORD, { timeCost: 1, parallelism: 1 }), forcePasswordChange: false })).id
  app = createApiApp({ db: db.db, store: state.store, serverSecret: 'identity-http-synthetic-server-secret' })
})
afterEach(async () => { await db.close(); await state.close() })
const login = (body: unknown) => app.fetch(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const problem = async (response: Response) => { const body = await response.json() as { code?: string; details?: Record<string, unknown> }; return { status: response.status, code: body.code, details: body.details ?? {} } }

describe('identity sign-in over HTTP', () => {
  it('asks the security questions after the password from an unverified address, then remembers the address', async () => {
    await replaceSecurityQuestions(db.db, rootId, [{ question: 'First pet name?', answerHash: await hashPasswordArgon2id('rex', { timeCost: 1, parallelism: 1 }) },
      { question: 'City of birth?', answerHash: await hashPasswordArgon2id('amman', { timeCost: 1, parallelism: 1 }) }])
    expect((await login({ username: 'root', password: PASSWORD })).status).toBe(200)
    await mkdir(join(state.rootDir, 'extended/panel'), { recursive: true })
    await writeFile(join(state.rootDir, SECURITY_QUESTIONS_POLICY), JSON.stringify({ version: 1, verifiedIpSignIn: true, updatedAt: '2026-11-07T00:00:00.000Z' }))

    const wrongPassword = await problem(await login({ username: 'root', password: 'wrong-password-1' }))
    expect(wrongPassword).toMatchObject({ status: 401 })
    expect(wrongPassword.details.questions).toBeUndefined()
    const challenge = await problem(await login({ username: 'root', password: PASSWORD }))
    expect(challenge).toMatchObject({ status: 401, details: { securityQuestionsRequired: true, questions: [{ position: 1, question: 'First pet name?' }, { position: 2, question: 'City of birth?' }] } })
    expect(await problem(await login({ username: 'root', password: PASSWORD, securityAnswers: ['rex', 'paris'] }))).toMatchObject({ status: 401, details: { securityQuestionsRequired: true } })
    const answered = await login({ username: 'root', password: PASSWORD, securityAnswers: ['Rex', 'Amman'] })
    expect(answered.status).toBe(200)
    expect((await listVerifiedIps(db.db, rootId)).map(item => item.source)).toEqual(['answered'])
    expect((await login({ username: 'root', password: PASSWORD })).status).toBe(200)
  })

  it('refuses an account owner whose plan disabled the security policy feature', async () => {
    const features = await state.store.createFeatureList({ name: 'Synthetic features', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({ name: 'Synthetic plan', ownerId: null, featureListId: features.id, resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }, caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
    await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const passwordHash = await hashPasswordArgon2id(PASSWORD, { timeCost: 1, parallelism: 1 })
    const account = await state.store.createAccount({ username: 'owner', passwordHash, primaryDomain: 'owner.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.10', shell: 'none', php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
    await createUserPrincipal(db.db, { username: 'owner', accountId: account.id, passwordHash })
    const cookie = (await login({ username: 'owner', password: PASSWORD })).headers.get('set-cookie')!.split(';')[0]!
    const read = () => app.fetch(new Request('http://localhost/api/auth/security-questions', { headers: { cookie } }))
    expect((await read()).status).toBe(200)
    await state.store.updateFeatureList(features.id, { disabled: ['security-policy'] })
    expect((await read()).status).toBe(403)
  })

  it('takes an external sign-in only as its own request shape, and only on a panel listener', async () => {
    expect(await problem(await login({ external: true, username: 'root' }))).toMatchObject({ status: 422, code: 'VALIDATION' })
    expect(await problem(await login({ external: true }))).toMatchObject({ status: 403, details: { reason: 'entry_point_unsupported' } })
  })

  describe('through a provider on the xWHM listener', () => {
    const ORIGIN = 'https://whm.example.test:2087', SERVER_SECRET = 'identity-http-synthetic-server-secret', TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
    let whm: ApiApp, idp: ReturnType<typeof oidcTestProvider>['idp']
    beforeEach(async () => {
      const provider = oidcTestProvider()
      idp = provider.idp
      vi.stubGlobal('fetch', (input: string, init?: RequestInit) => provider.fetcher(input, init))
      await mkdir(join(state.rootDir, 'extended/panel'), { recursive: true })
      await writeFile(join(state.rootDir, EXTERNAL_AUTH_STATE), JSON.stringify({ version: 1, providers: [{ id: 'corp', label: 'Corporate', issuer: ISSUER, clientId: 'panel', clientSecret: 's3cret', entryPoints: { xpanel: false, xwhm: true }, createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z' }] }))
      await linkExternalIdentity(db.db, { principalId: rootId, providerId: 'corp', issuer: ISSUER, subject: 'person-1', label: null })
      whm = createApiApp({ db: db.db, store: state.store, serverSecret: SERVER_SECRET, entryPoint: 'xwhm', publicOrigin: ORIGIN, allowedOrigins: [ORIGIN], secureCookies: true })
    })
    afterEach(() => { vi.unstubAllGlobals() })

    /** Browser round trip through the provider; returns the cookie that binds the verified sign-in to this browser. */
    const throughProvider = async (): Promise<string> => {
      const started = await whm.fetch(new Request(ORIGIN + '/api/auth/oidc/start?provider=corp'))
      const cookie = started.headers.get('set-cookie')!.split(';')[0]!, authorization = new URL(started.headers.get('location')!)
      idp.challenge = authorization.searchParams.get('code_challenge')!; idp.nonce = authorization.searchParams.get('nonce')!
      const landed = await whm.fetch(new Request(ORIGIN + '/api/auth/oidc/callback?' + new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'one-time-code' }), { headers: { cookie } }))
      expect(landed.headers.get('location')).toBe('/login?external=verified')
      return cookie
    }
    const external = (cookie: string, extra: Record<string, unknown> = {}) => whm.fetch(new Request(ORIGIN + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie }, body: JSON.stringify({ external: true, ...extra }) }))

    it('opens a session for the linked principal without a password, once', async () => {
      const cookie = await throughProvider()
      const pending = await whm.fetch(new Request(ORIGIN + '/api/auth/oidc/pending', { headers: { cookie } }))
      expect(await pending.json()).toEqual({ pending: true, provider: { id: 'corp', label: 'Corporate' }, username: 'root', secondFactor: 'none' })
      expect((await external(cookie)).status).toBe(200)
      expect(await listSessionsForPrincipal(db.db, rootId)).toHaveLength(1)
      expect(await problem(await external(cookie))).toMatchObject({ status: 401, details: { reason: 'external_flow_missing' } })
    })

    it('keeps the enrolled second factor on an external sign-in', async () => {
      await setTotpSecret(db.db, rootId, sealTotpSecret(TOTP, SERVER_SECRET), [sha256Hex('unused-fixture-recovery')])
      expect(await problem(await external(await throughProvider()))).toMatchObject({ status: 401, details: { mfaRequired: true } })
      expect(await listSessionsForPrincipal(db.db, rootId)).toEqual([])
      expect((await external(await throughProvider(), { totpCode: computeTotpCode(TOTP) })).status).toBe(200)
    })
  })
})
