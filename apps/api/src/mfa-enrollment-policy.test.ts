import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PhpSettings } from '@xpanel/core'
import {
  createApiToken,
  createResellerPrincipal,
  createRootPrincipal,
  createTestDb,
  createUserPrincipal,
  listAudit,
  setTotpSecret,
} from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { computeTotpCode, hashPasswordArgon2id, sealTotpSecret, sha256Hex } from './auth.ts'
import { PASSWORD_ONLY_ROOT_ENV, PASSWORD_ONLY_ROOT_WARNING, warnIfPasswordOnlyOperators } from './mfa-policy.ts'
import { createApiApp } from './server.ts'
import type { ApiApp } from './server.ts'

const SERVER_SECRET = 'test-only-mfa-policy-server-secret-at-least-32'
const PASSWORD = 'PolicyFixturePassword!'
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
const php: PhpSettings = {
  version: '8.3',
  handler: 'fpm',
  fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 },
  ini: {},
}

describe('operator MFA enrollment policy', () => {
  let passwordHash: string
  let db: TestDbHandle
  let state: TestStateStoreHandle
  let app: ApiApp
  let rootId: string

  beforeAll(async () => { passwordHash = await hashPasswordArgon2id(PASSWORD) })

  beforeEach(async () => {
    db = await createTestDb()
    state = await createTestStateStore()
    rootId = (await createRootPrincipal(db.db, { username: 'root', passwordHash, forcePasswordChange: false })).id
    const featureList = await state.store.createFeatureList({ name: 'Policy features', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({
      name: 'Policy plan',
      ownerId: null,
      featureListId: featureList.id,
      resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
      caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 10, forwarders: 10, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 },
      dedicatedIp: false,
      shell: 'none',
      defaultMailboxQuotaMb: 100,
    })
    await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const demohost = await state.store.createAccount({
      username: 'demohost',
      passwordHash,
      primaryDomain: 'demohost.example.test',
      planId: plan.id,
      ownerId: null,
      contactEmail: 'owner@demohost.example.test',
      ipv4: '192.0.2.10',
      shell: 'none',
      php,
    })
    await createUserPrincipal(db.db, { username: demohost.username, accountId: demohost.id, passwordHash })
    const reseller = await state.store.createReseller({
      username: 'resell',
      passwordHash,
      acl: ['list-accounts'],
      maxAccounts: 5,
      totalDiskMb: 10000,
      totalBandwidthMb: 100000,
      oversell: false,
      nameservers: [],
      delegatedIps: [],
    })
    await createResellerPrincipal(db.db, { id: reseller.id, username: reseller.username, passwordHash })
    app = createApiApp({ db: db.db, store: state.store, serverSecret: SERVER_SECRET })
  })

  afterEach(async () => {
    delete process.env[PASSWORD_ONLY_ROOT_ENV]
    await state.close()
    await db.close()
  })

  const login = (username: string, password = PASSWORD, totpCode?: string) => app.fetch(new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, ...(totpCode ? { totpCode } : {}) }),
  }))
  const cookieOf = (response: Response): string => response.headers.get('set-cookie')!.split(';')[0]!
  const sessionRequest = (cookie: string, csrf: string, path: string, method = 'GET', body?: unknown) => app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { cookie, 'x-csrf-token': csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))

  it('writes a startup warning only when the development opt-out is set', () => {
    const lines: string[] = []
    const write = (line: string) => { lines.push(line) }
    warnIfPasswordOnlyOperators({}, write)
    warnIfPasswordOnlyOperators({ [PASSWORD_ONLY_ROOT_ENV]: '0' }, write)
    expect(lines).toEqual([])
    warnIfPasswordOnlyOperators({ [PASSWORD_ONLY_ROOT_ENV]: '1' }, write)
    expect(lines).toEqual([`WARNING: ${PASSWORD_ONLY_ROOT_WARNING}\n`])
  })

  it('keeps an unenrolled root session on enrollment and logout until a valid code is enrolled', async () => {
    const signedIn = await login('root')
    expect(signedIn.status).toBe(200)
    const body = await signedIn.json() as { csrfToken: string }
    expect(body).toMatchObject({ mfaEnrollmentRequired: true, totpEnabled: false })
    const cookie = cookieOf(signedIn)
    expect((await sessionRequest(cookie, body.csrfToken, '/api/auth/me')).status).toBe(200)
    const accounts = await sessionRequest(cookie, body.csrfToken, '/api/accounts')
    expect(accounts.status).toBe(403)
    expect(await accounts.json()).toMatchObject({
      detail: 'root must complete two-factor enrollment before administration',
      details: { mfaEnrollmentRequired: true },
    })
    expect((await sessionRequest(cookie, body.csrfToken, '/api/auth/change-password', 'POST', {
      currentPassword: PASSWORD,
      newPassword: 'ReplacementPolicyPassword!',
    })).status).toBe(403)
    expect((await sessionRequest(cookie, body.csrfToken, '/api/auth/2fa/disable', 'POST', { password: PASSWORD })).status).toBe(403)
    expect((await sessionRequest(cookie, body.csrfToken, '/api/auth/logout', 'POST', {})).status).toBe(200)
    expect((await sessionRequest(cookie, body.csrfToken, '/api/auth/me')).status).toBe(401)

    const again = await login('root')
    const next = await again.json() as { csrfToken: string }
    const nextCookie = cookieOf(again)
    const setup = await sessionRequest(nextCookie, next.csrfToken, '/api/auth/2fa/setup', 'POST', { password: PASSWORD })
    expect(setup.status).toBe(200)
    const enrollment = await setup.json() as { secret: string }
    const enable = await sessionRequest(nextCookie, next.csrfToken, '/api/auth/2fa/enable', 'POST', { code: computeTotpCode(enrollment.secret) })
    expect(enable.status).toBe(200)
    expect((await sessionRequest(nextCookie, next.csrfToken, '/api/accounts')).status).toBe(200)
    expect(await listAudit(db.db, { action: 'auth.password_only_opt_out' })).toEqual([])
  })

  it('refuses an enrolled root password without a code and accepts a current code', async () => {
    await setTotpSecret(db.db, rootId, sealTotpSecret(TOTP_SECRET, SERVER_SECRET), [])
    const missing = await login('root')
    expect(missing.status).toBe(401)
    expect(await missing.json()).toMatchObject({ details: { mfaRequired: true } })
    expect(missing.headers.get('set-cookie')).toBeNull()
    const signedIn = await login('root', PASSWORD, computeTotpCode(TOTP_SECRET))
    expect(signedIn.status).toBe(200)
    const body = await signedIn.json() as { csrfToken: string }
    expect(body).toMatchObject({ totpEnabled: true, mfaEnrollmentRequired: false })
    expect((await sessionRequest(cookieOf(signedIn), body.csrfToken, '/api/accounts')).status).toBe(200)
  })

  it('holds an unenrolled reseller and leaves the demohost account on password sign-in', async () => {
    const resellerLogin = await login('resell')
    expect(resellerLogin.status).toBe(200)
    const resellerBody = await resellerLogin.json() as { csrfToken: string }
    expect(resellerBody).toMatchObject({ mfaEnrollmentRequired: true, totpEnabled: false })
    const resellerDenied = await sessionRequest(cookieOf(resellerLogin), resellerBody.csrfToken, '/api/accounts')
    expect(resellerDenied.status).toBe(403)
    expect(await resellerDenied.json()).toMatchObject({
      detail: 'reseller must complete two-factor enrollment before administration',
      details: { mfaEnrollmentRequired: true },
    })

    const userLogin = await login('demohost')
    expect(userLogin.status).toBe(200)
    const userBody = await userLogin.json() as { csrfToken: string }
    expect(userBody).toMatchObject({ mfaEnrollmentRequired: false, totpEnabled: false })
    expect((await sessionRequest(cookieOf(userLogin), userBody.csrfToken, '/api/domains')).status).toBe(200)
  })

  it('holds an unenrolled root API token with full scope', async () => {
    const raw = `xp_${randomUUID()}`
    await createApiToken(db.db, {
      principalId: rootId,
      name: 'Policy token',
      tokenHash: sha256Hex(raw),
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const denied = await app.fetch(new Request('http://localhost/api/accounts', { headers: { authorization: `Bearer ${raw}` } }))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      detail: 'root must complete two-factor enrollment before administration',
      details: { mfaEnrollmentRequired: true },
    })
  })

  it('lets root and resellers administer under the development opt-out and audits every such login', async () => {
    const previous = process.env[PASSWORD_ONLY_ROOT_ENV]
    process.env[PASSWORD_ONLY_ROOT_ENV] = '1'
    const stderr: string[] = []
    const original = process.stderr.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stderr.write
    try {
      const rootLogin = await login('root')
      expect(rootLogin.status).toBe(200)
      const rootBody = await rootLogin.json() as { csrfToken: string }
      expect(rootBody).toMatchObject({ mfaEnrollmentRequired: false, totpEnabled: false })
      expect((await sessionRequest(cookieOf(rootLogin), rootBody.csrfToken, '/api/accounts')).status).toBe(200)
      const rootAgain = await login('root')
      const rootAgainBody = await rootAgain.json() as { csrfToken: string }
      expect((await sessionRequest(cookieOf(rootAgain), rootAgainBody.csrfToken, '/api/accounts')).status).toBe(200)

      const resellerLogin = await login('resell')
      const resellerBody = await resellerLogin.json() as { csrfToken: string }
      expect(resellerBody).toMatchObject({ mfaEnrollmentRequired: false, totpEnabled: false })
      expect((await sessionRequest(cookieOf(resellerLogin), resellerBody.csrfToken, '/api/accounts')).status).toBe(200)

      const userLogin = await login('demohost')
      const userBody = await userLogin.json() as { csrfToken: string }
      expect(userBody).toMatchObject({ mfaEnrollmentRequired: false })
      expect((await sessionRequest(cookieOf(userLogin), userBody.csrfToken, '/api/domains')).status).toBe(200)

      const events = await listAudit(db.db, { action: 'auth.password_only_opt_out', limit: 20 })
      expect(events.map(event => event.actor).sort()).toEqual(['resell', 'root', 'root'])
      for (const event of events) {
        expect(event.outcome).toBe('ok')
        expect(event.detail).toMatchObject({ severity: 'high', flag: PASSWORD_ONLY_ROOT_ENV, warning: PASSWORD_ONLY_ROOT_WARNING })
      }
      const warnings = stderr.filter(line => line.includes(PASSWORD_ONLY_ROOT_WARNING))
      expect(warnings).toHaveLength(3)
      expect(warnings.join('\n')).not.toContain('principal=demohost')
    } finally {
      process.stderr.write = original
      if (previous === undefined) delete process.env[PASSWORD_ONLY_ROOT_ENV]
      else process.env[PASSWORD_ONLY_ROOT_ENV] = previous
    }
  })
})
