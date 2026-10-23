import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendAudit, createApiToken, createRootPrincipal, createSession, createTestDb, createUserPrincipal,
  findActiveApiTokenByHash, findActiveSessionByTokenHash, getPrincipal,
  revokeAccountSessionsAndTokens, setTotpSecret, startTotpEnrollment,
  type TestDbHandle,
} from '../index.ts'
import { ARGON2 } from '../testing.ts'

const accountId = 'a1111111-1111-4111-8111-111111111111'
const neighborAccountId = 'a1111111-1111-4111-8111-111111111112'
const missingAccountId = 'a1111111-1111-4111-8111-111111111113'
const handles: TestDbHandle[] = []
const future = (): string => new Date(Date.now() + 3_600_000).toISOString()
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const syntheticHash = (label: string): string => digest({ fixture: 'account-access', label })
const emptyResult = { principalIds: [], revokedSessions: 0, revokedApiTokens: 0, removedTotpEnrollments: 0 }

afterEach(async () => { await Promise.all(handles.splice(0).map(handle => handle.close())) })

const database = async (): Promise<TestDbHandle> => {
  const handle = await createTestDb()
  handles.push(handle)
  return handle
}

// Fingerprints compare preserved rows without printing passwords, token hashes or MFA material on failure.
const snapshot = async (handle: TestDbHandle): Promise<Record<string, string>> => {
  const tables = [['principals', 'id'], ['sessions', 'id'], ['api_tokens', 'id'], ['totp_enrollments', 'principal_id'], ['audit_log', 'id']] as const
  return Object.fromEntries(await Promise.all(tables.map(async ([table, order]) => [table, digest(await handle.db.query('SELECT * FROM ' + table + ' ORDER BY ' + order))])))
}

const withAccess = async (handle: TestDbHandle, username: string, ownerAccountId: string) => {
  const principal = await createUserPrincipal(handle.db, { username, accountId: ownerAccountId, passwordHash: ARGON2 })
  await setTotpSecret(handle.db, principal.id, new Uint8Array(48).fill(7), [syntheticHash(username + ':recovery')])
  const sessionHashes = [0, 1].map(index => syntheticHash(username + ':session:' + index))
  const tokenHashes = [0, 1].map(index => syntheticHash(username + ':api:' + index))
  const sessions = []
  for (const tokenHash of sessionHashes) sessions.push(await createSession(handle.db, { principalId: principal.id, tokenHash, expiresAt: future(), mfaVerified: true }))
  const tokens = []
  for (const tokenHash of tokenHashes) tokens.push(await createApiToken(handle.db, { principalId: principal.id, tokenHash, name: 'synthetic', scopes: ['account.read'], expiresAt: future() }))
  await startTotpEnrollment(handle.db, {
    principalId: principal.id, sessionId: sessions[0]!.id, sealedSecret: new Uint8Array(48).fill(8),
    recoveryHashes: [syntheticHash(username + ':pending-recovery')], expectedPasswordHash: ARGON2,
  })
  return { principal, sessions, tokens, sessionHashes, tokenHashes }
}

const fixture = async () => {
  const handle = await database()
  const owner = await withAccess(handle, 'linkedowner', accountId)
  const alias = await withAccess(handle, 'linkedalias', accountId)
  const neighbor = await withAccess(handle, 'neighbor', neighborAccountId)
  await appendAudit(handle.db, { principalId: owner.principal.id, actor: 'synthetic-admin', action: 'account.test', target: 'linkedowner', outcome: 'ok' })
  return { handle, owner, alias, neighbor }
}

const active = async (handle: TestDbHandle, access: Awaited<ReturnType<typeof withAccess>>) => ({
  sessions: await Promise.all(access.sessionHashes.map(async hash => Boolean(await findActiveSessionByTokenHash(handle.db, hash)))),
  tokens: await Promise.all(access.tokenHashes.map(async hash => Boolean(await findActiveApiTokenByHash(handle.db, hash)))),
})

const enrollmentIds = async (handle: TestDbHandle): Promise<string[]> => (await handle.db.query<{ principal_id: string }>('SELECT principal_id FROM totp_enrollments ORDER BY principal_id')).map(row => row.principal_id)

describe('account-wide principal access revocation', () => {
  it('revokes every linked alias while preserving the neighboring account, identities, active MFA and audit rows', async () => {
    const f = await fixture(), before = await snapshot(f.handle)
    const result = await revokeAccountSessionsAndTokens(f.handle.db, accountId)
    expect(result).toEqual({ principalIds: [f.owner.principal.id, f.alias.principal.id].sort(), revokedSessions: 4, revokedApiTokens: 4, removedTotpEnrollments: 2 })
    expect(await active(f.handle, f.owner)).toEqual({ sessions: [false, false], tokens: [false, false] })
    expect(await active(f.handle, f.alias)).toEqual({ sessions: [false, false], tokens: [false, false] })
    expect(await active(f.handle, f.neighbor)).toEqual({ sessions: [true, true], tokens: [true, true] })
    expect(await enrollmentIds(f.handle)).toEqual([f.neighbor.principal.id])
    const after = await snapshot(f.handle)
    expect(after.principals).toBe(before.principals)
    expect(after.audit_log).toBe(before.audit_log)
    expect(Object.keys(result).sort()).toEqual(['principalIds', 'removedTotpEnrollments', 'revokedApiTokens', 'revokedSessions'])
  })

  it('preserves independently disabled identities rather than toggling manual access flags', async () => {
    const f = await fixture()
    // Model a previously disabled legacy identity whose stored credentials still need revocation.
    await f.handle.db.query('UPDATE principals SET disabled = 1 WHERE id = $1', [f.alias.principal.id])
    const before = await snapshot(f.handle)
    await revokeAccountSessionsAndTokens(f.handle.db, accountId)
    expect((await getPrincipal(f.handle.db, f.owner.principal.id))?.disabled).toBe(false)
    expect((await getPrincipal(f.handle.db, f.alias.principal.id))?.disabled).toBe(true)
    expect((await snapshot(f.handle)).principals).toBe(before.principals)
    expect(await active(f.handle, f.alias)).toEqual({ sessions: [false, false], tokens: [false, false] })
  })

  it('preserves old revocation timestamps and counts expired but previously unrevoked credentials', async () => {
    const f = await fixture()
    const old = '2020-01-01T00:00:00.000Z'
    await f.handle.db.query('UPDATE sessions SET revoked_at = $1 WHERE id = $2', [old, f.owner.sessions[0]!.id])
    await f.handle.db.query('UPDATE api_tokens SET revoked_at = $1 WHERE id = $2', [old, f.owner.tokens[0]!.id])
    for (const [table, id] of [['sessions', f.alias.sessions[1]!.id], ['api_tokens', f.alias.tokens[1]!.id]]) {
      await f.handle.db.query('UPDATE ' + table + ' SET created_at = $1, expires_at = $2 WHERE id = $3', ['2019-01-01T00:00:00.000Z', old, id])
    }
    const result = await revokeAccountSessionsAndTokens(f.handle.db, accountId)
    expect(result.revokedSessions).toBe(3)
    expect(result.revokedApiTokens).toBe(3)
    expect((await f.handle.db.query<{ revoked_at: string }>('SELECT revoked_at FROM sessions WHERE id = $1', [f.owner.sessions[0]!.id]))[0]?.revoked_at).toBe(old)
    expect((await f.handle.db.query<{ revoked_at: string }>('SELECT revoked_at FROM api_tokens WHERE id = $1', [f.owner.tokens[0]!.id]))[0]?.revoked_at).toBe(old)
    const remaining = await f.handle.db.query<{ count: number }>('SELECT count(*) AS count FROM sessions WHERE principal_id IN ($1, $2) AND revoked_at IS NULL', [f.owner.principal.id, f.alias.principal.id])
    expect(remaining[0]?.count).toBe(0)
  })

  it('is idempotent and never revives credentials after a repeated suspension', async () => {
    const f = await fixture()
    await revokeAccountSessionsAndTokens(f.handle.db, accountId)
    const before = await snapshot(f.handle)
    expect(await revokeAccountSessionsAndTokens(f.handle.db, accountId)).toEqual({ ...emptyResult, principalIds: [f.owner.principal.id, f.alias.principal.id].sort() })
    expect(await snapshot(f.handle)).toEqual(before)
  })

  it('serializes concurrent retries so each credential is revoked only once', async () => {
    const f = await fixture()
    const results = await Promise.all([revokeAccountSessionsAndTokens(f.handle.db, accountId), revokeAccountSessionsAndTokens(f.handle.db, accountId)])
    expect(results.map(result => result.revokedSessions).sort()).toEqual([0, 4])
    expect(results.map(result => result.revokedApiTokens).sort()).toEqual([0, 4])
    expect(results.map(result => result.removedTotpEnrollments).sort()).toEqual([0, 2])
    for (const result of results) expect(result.principalIds).toEqual([f.owner.principal.id, f.alias.principal.id].sort())
    expect(await active(f.handle, f.neighbor)).toEqual({ sessions: [true, true], tokens: [true, true] })
  })

  it('normalizes the target UUID without broadening the account boundary', async () => {
    const f = await fixture()
    expect((await revokeAccountSessionsAndTokens(f.handle.db, accountId.toUpperCase())).principalIds).toEqual([f.owner.principal.id, f.alias.principal.id].sort())
    expect(await active(f.handle, f.neighbor)).toEqual({ sessions: [true, true], tokens: [true, true] })
  })

  it('returns an empty result for a valid account with no linked identity and leaves all rows unchanged', async () => {
    const f = await fixture(), before = await snapshot(f.handle)
    expect(await revokeAccountSessionsAndTokens(f.handle.db, missingAccountId)).toEqual(emptyResult)
    expect(await snapshot(f.handle)).toEqual(before)
  })

  it.each(['', 'invalid', 'a1111111-1111-4111-8111-111111111111 OR 1=1'])('rejects an invalid target before any credential changes: %s', async target => {
    const f = await fixture(), before = await snapshot(f.handle)
    await expect(revokeAccountSessionsAndTokens(f.handle.db, target)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await snapshot(f.handle)).toEqual(before)
  })

  it('handles multiple linked identities with no issued access records without deleting either identity', async () => {
    const handle = await database()
    const first = await createUserPrincipal(handle.db, { username: 'first', accountId, passwordHash: ARGON2 })
    const second = await createUserPrincipal(handle.db, { username: 'second', accountId, passwordHash: ARGON2 })
    const before = await snapshot(handle)
    expect(await revokeAccountSessionsAndTokens(handle.db, accountId)).toEqual({ ...emptyResult, principalIds: [first.id, second.id].sort() })
    expect(await snapshot(handle)).toEqual(before)
  })

  it('does not touch an unlinked administrator identity or its session', async () => {
    const f = await fixture()
    const administrator = await createRootPrincipal(f.handle.db, { username: 'admin', passwordHash: ARGON2, forcePasswordChange: false })
    const tokenHash = syntheticHash('unlinked-admin-session')
    await createSession(f.handle.db, { principalId: administrator.id, tokenHash, expiresAt: future(), mfaVerified: false })
    await revokeAccountSessionsAndTokens(f.handle.db, accountId)
    expect(Boolean(await findActiveSessionByTokenHash(f.handle.db, tokenHash))).toBe(true)
    expect((await getPrincipal(f.handle.db, administrator.id))?.disabled).toBe(false)
  })

  it.each(['enrollment', 'session', 'api-token'] as const)('rolls back the entire transition when %s revocation fails', async stage => {
    const f = await fixture(), before = await snapshot(f.handle)
    const trigger = stage === 'enrollment'
      ? "CREATE TRIGGER reject_account_access BEFORE DELETE ON totp_enrollments WHEN OLD.principal_id IN (SELECT id FROM principals WHERE username = 'linkedalias') BEGIN SELECT RAISE(ABORT, 'Synthetic account revocation failure'); END"
      : 'CREATE TRIGGER reject_account_access BEFORE UPDATE OF revoked_at ON ' + (stage === 'session' ? 'sessions' : 'api_tokens') + " WHEN NEW.principal_id IN (SELECT id FROM principals WHERE username = 'linkedalias') BEGIN SELECT RAISE(ABORT, 'Synthetic account revocation failure'); END"
    await f.handle.db.exec(trigger)
    await expect(revokeAccountSessionsAndTokens(f.handle.db, accountId)).rejects.toThrow('Synthetic account revocation failure')
    expect(await snapshot(f.handle)).toEqual(before)
    expect(await active(f.handle, f.owner)).toEqual({ sessions: [true, true], tokens: [true, true] })
    expect(await active(f.handle, f.alias)).toEqual({ sessions: [true, true], tokens: [true, true] })
    expect(await enrollmentIds(f.handle)).toHaveLength(3)
    await f.handle.db.exec('DROP TRIGGER reject_account_access')
    expect((await revokeAccountSessionsAndTokens(f.handle.db, accountId)).revokedSessions).toBe(4)
  })
})
