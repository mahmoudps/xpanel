import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createApiToken, createSession, createTestDb, createUserPrincipal, setTotpSecret } from '@xpanel/db'
import { authenticateRequest, type AuthenticatedCaller } from './auth.ts'
import { captureMfaRuntimePolicy } from '@xpanel/core'
import { sessionCookieName, sessionTokenHash, type EntryPoint } from './entry-points.ts'
import { assertAuthPersonalOwner } from './auth-personal.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'auth-personal-isolated-test-secret-only'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const fixture = async () => {
  const database = await createTestDb()
  cleanup.push(() => database.close())
  const owner = await createUserPrincipal(database.db, { username: 'alice', accountId: randomUUID(), passwordHash: HASH })
  const raw = 'auth-personal-test-' + randomUUID()
  const saved = await createSession(database.db, { principalId: owner.id, tokenHash: sessionTokenHash(raw, 'xpanel'),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), mfaVerified: false })
  const request = () => new Request('https://panel.example.test:2083/security/account', { headers: { cookie: sessionCookieName('xpanel', true) + '=' + raw } })
  const options: Parameters<typeof authenticateRequest>[2] = { serverSecret: SECRET, entryPoint: 'xpanel', mfaRuntimePolicy: captureMfaRuntimePolicy(), touchSession: false }
  const caller = await authenticateRequest(database.db, request(), options)
  if (!caller) throw new Error('the existing optional-MFA owner middleware did not authenticate the isolated session')
  return { database, owner, raw, saved, request, options, caller }
}

describe('canonical original-owner auth-personal policy', { tags: ['feature'] }, () => {
  it('accepts the middleware result for an unenrolled owner without a verified session bit', async () => {
    const f = await fixture()
    expect(f.saved.mfaVerified).toBe(false)
    expect(f.caller.mfaVerified).toBe(true)
    expect(f.caller.csrfValid).toBe(false)
    expect(() => assertAuthPersonalOwner(f.caller, 'xpanel')).not.toThrow()
  })

  const cases: { name: string; change: (caller: AuthenticatedCaller) => AuthenticatedCaller }[] = [
    { name: 'missing session identity', change: c => ({ ...c, sessionId: null }) },
    { name: 'missing original session credential', change: c => ({ ...c, sessionToken: null }) },
    { name: 'hybrid API-token identity', change: c => ({ ...c, apiTokenId: 'untrusted-token-identity' }) },
    { name: 'unsatisfied middleware MFA policy', change: c => ({ ...c, mfaVerified: false }) },
    { name: 'disabled persisted principal', change: c => ({ ...c, principalRecord: { ...c.principalRecord, disabled: true } }) },
    { name: 'forced password-change principal', change: c => ({ ...c, principalRecord: { ...c.principalRecord, forcePasswordChange: true } }) },
    { name: 'different persisted principal', change: c => ({ ...c, principalRecord: { ...c.principalRecord, id: 'different-principal' } }) },
    { name: 'different persisted account', change: c => ({ ...c, principalRecord: { ...c.principalRecord, accountId: 'different-account' } }) },
    { name: 'different persisted username', change: c => ({ ...c, principalRecord: { ...c.principalRecord, username: 'different-owner' } }) },
    { name: 'team credential', change: c => ({ ...c, team: { kind: 'team', id: 'member', username: 'member', login: 'member@example.test', accountId: c.principalRecord.accountId ?? '', roles: ['web'] } }) },
    { name: 'handed-off credential', change: c => ({ ...c, impersonator: { principalId: 'issuer', login: 'operator' } }) },
    { name: 'operator identity', change: c => ({ ...c, principal: { kind: 'root', id: c.principal.id, username: c.principal.username }, principalRecord: { ...c.principalRecord, kind: 'root', accountId: null } }) },
    { name: 'mailbox identity', change: c => ({ ...c, principal: { kind: 'user', id: c.principal.id, username: 'mbx' + 'a'.repeat(28), accountId: c.principalRecord.accountId ?? '' }, principalRecord: { ...c.principalRecord, username: 'mbx' + 'a'.repeat(28) } }) },
  ]
  it.each(cases)('refuses $name without acquiring or granting authority', async ({ change }) => {
    const f = await fixture()
    expect(() => assertAuthPersonalOwner(change(f.caller), 'xpanel')).toThrow(/original authenticated account-owner session/)
  })

  const otherListeners: EntryPoint[] = ['xwhm', 'xmail']
  it.each(otherListeners)('refuses an owner presentation on the %s listener', async entryPoint => {
    const f = await fixture()
    expect(() => assertAuthPersonalOwner(f.caller, entryPoint)).toThrow(/original authenticated account-owner session/)
  })

  it('refuses an enrolled session whose real middleware factor policy is pending', async () => {
    const f = await fixture()
    await setTotpSecret(f.database.db, f.owner.id, new Uint8Array(32))
    // A factor reset revokes every old credential; pending MFA requires a new current login session.
    expect(await authenticateRequest(f.database.db, f.request(), f.options)).toBeNull()
    const pendingRaw = 'auth-personal-pending-test-' + randomUUID()
    await createSession(f.database.db, { principalId: f.owner.id, tokenHash: sessionTokenHash(pendingRaw, 'xpanel'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), mfaVerified: false })
    const pendingRequest = new Request(f.request(), { headers: { cookie: sessionCookieName('xpanel', true) + '=' + pendingRaw } })
    const caller = await authenticateRequest(f.database.db, pendingRequest, f.options)
    if (!caller) throw new Error('pending MFA should remain an authenticated but restricted session')
    expect(caller.mfaVerified).toBe(false)
    expect(() => assertAuthPersonalOwner(caller, 'xpanel')).toThrow(/original authenticated account-owner session/)
  })

  it('refuses a real bearer-authenticated owner even though bearer middleware has no MFA step', async () => {
    const f = await fixture(), raw = 'auth-personal-bearer-test-' + randomUUID()
    await createApiToken(f.database.db, { principalId: f.owner.id, name: 'Isolated policy fixture', tokenHash: sessionTokenHash(raw), scopes: ['files:read'], expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const caller = await authenticateRequest(f.database.db, new Request('http://localhost/api/account', { headers: { authorization: 'Bearer ' + raw } }), { serverSecret: SECRET, touchSession: false })
    if (!caller) throw new Error('isolated legacy bearer fixture did not authenticate')
    expect(caller.sessionId).toBeNull()
    expect(caller.mfaVerified).toBe(true)
    expect(() => assertAuthPersonalOwner(caller)).toThrow(/original authenticated account-owner session/)
  })
})
