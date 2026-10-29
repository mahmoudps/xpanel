import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from '../client.ts'
import { ARGON2, sha } from '../testing.ts'
import { toXpanelError } from '../sqlite-errors.ts'
import { consumePanelHandoff, issuePanelHandoff, PANEL_HANDOFF_TTL_MS } from './panel-handoffs.ts'
import { deleteMailboxSession, getMailboxSession, saveHandoffMailboxSession } from './mailbox-sessions.ts'
import { createRootPrincipal, createUserPrincipal, deletePrincipal } from './principals.ts'
import { createSession, findActiveSessionByTokenHash } from './sessions.ts'

let h: TestDbHandle
beforeEach(async () => { h = await createTestDb() })
afterEach(async () => { await h.close() })

const accountId = '10000000-0000-4000-8000-000000000001'
const code = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run(); return 'ok' } catch (error) { const mapped = toXpanelError(error); return isXpanelError(mapped) ? mapped.code : `raw:${(error as Error).message}` }
}
const principals = async () => ({
  root: await createRootPrincipal(h.db, { username: 'root', passwordHash: ARGON2, forcePasswordChange: false }),
  owner: await createUserPrincipal(h.db, { username: 'alice', passwordHash: ARGON2, accountId }),
})
const ownerHandoff = (tokenHash: string, issuer: string, target: string) => ({
  tokenHash, audience: 'xpanel' as const, landing: 'home' as const,
  target: { kind: 'account-owner' as const, accountId, principalId: target },
  issuer: { principalId: issuer, entryPoint: 'xwhm' as const, login: 'root' },
})

describe('panel handoff rows', () => {
  it('stores only the hash, expires after 60 s and consumes exactly once for its audience', async () => {
    const { root, owner } = await principals()
    const now = new Date('2026-10-28T12:00:00.000Z')
    const issued = await issuePanelHandoff(h.db, ownerHandoff(sha('a'), root.id, owner.id), now)
    expect(Date.parse(issued.expiresAt) - Date.parse(issued.createdAt)).toBe(PANEL_HANDOFF_TTL_MS)
    expect(Object.keys((await h.query('SELECT * FROM panel_handoffs'))[0]!).some(column => /secret|token$/.test(column))).toBe(false)
    expect(await consumePanelHandoff(h.db, sha('a'), 'xmail', now)).toEqual({ refused: 'audience' })
    const consumed = await consumePanelHandoff(h.db, sha('a'), 'xpanel', new Date(now.getTime() + 1000))
    expect('record' in consumed && consumed.record.target).toEqual({ kind: 'account-owner', accountId, principalId: owner.id })
    expect('record' in consumed && consumed.record.issuer).toEqual({ principalId: root.id, entryPoint: 'xwhm', login: 'root' })
    expect(await consumePanelHandoff(h.db, sha('a'), 'xpanel', new Date(now.getTime() + 2000))).toEqual({ refused: 'consumed' })
    expect(await consumePanelHandoff(h.db, sha('b'), 'xpanel', now)).toEqual({ refused: 'unknown' })
    expect(await consumePanelHandoff(h.db, 'not-a-hash', 'xpanel', now)).toEqual({ refused: 'unknown' })
  })

  it('refuses an expired link at the exact deadline and purges expired rows on the next use', async () => {
    const { root, owner } = await principals()
    const now = new Date('2026-10-28T12:00:00.000Z')
    await issuePanelHandoff(h.db, ownerHandoff(sha('c'), root.id, owner.id), now)
    expect(await consumePanelHandoff(h.db, sha('c'), 'xpanel', new Date(now.getTime() + PANEL_HANDOFF_TTL_MS))).toEqual({ refused: 'expired' })
    expect(await h.query('SELECT token_hash FROM panel_handoffs')).toEqual([])
    await issuePanelHandoff(h.db, ownerHandoff(sha('d'), root.id, owner.id), now)
    await issuePanelHandoff(h.db, ownerHandoff(sha('e'), root.id, owner.id), new Date(now.getTime() + PANEL_HANDOFF_TTL_MS + 1))
    expect((await h.query<{ token_hash: string }>('SELECT token_hash FROM panel_handoffs')).map(row => row.token_hash)).toEqual([sha('e')])
  })

  it('rejects mismatched audience, target and issuer pairings in the schema and deletes rows with their issuer', async () => {
    const { root, owner } = await principals()
    expect(await code(() => issuePanelHandoff(h.db, { ...ownerHandoff(sha('f'), root.id, owner.id), audience: 'xmail' }))).toBe('VALIDATION')
    expect(await code(() => issuePanelHandoff(h.db, { ...ownerHandoff(sha('f'), root.id, owner.id), landing: 'calendar' }))).toBe('VALIDATION')
    expect(await code(() => issuePanelHandoff(h.db, { tokenHash: sha('f'), audience: 'xmail', landing: 'calendar',
      target: { kind: 'mailbox', accountId, serviceUserId: randomUUID(), mailbox: 'info@alice.example.test' },
      issuer: { principalId: owner.id, entryPoint: 'xwhm', login: 'alice' } }))).toBe('VALIDATION')
    expect(await code(() => issuePanelHandoff(h.db, { tokenHash: sha('f'), audience: 'xmail', landing: 'calendar',
      target: { kind: 'mailbox', accountId, serviceUserId: randomUUID(), mailbox: 'info@alice.example.test' },
      issuer: { principalId: owner.id, entryPoint: 'xpanel', login: 'alice' } }))).toBe('ok')
    expect(await code(() => issuePanelHandoff(h.db, ownerHandoff(sha('f'), root.id, owner.id)))).toBe('CONFLICT')
    await deletePrincipal(h.db, owner.id)
    expect(await h.query('SELECT token_hash FROM panel_handoffs')).toEqual([])
  })
})

describe('impersonated sessions and handed-off mailbox bindings', () => {
  it('records the issuing identity, refuses self impersonation and ends with the issuer', async () => {
    const { root, owner } = await principals()
    const expiresAt = new Date(Date.now() + 3600_000).toISOString()
    const session = await createSession(h.db, { principalId: owner.id, tokenHash: sha('1'), expiresAt, impersonator: { principalId: root.id, login: 'root' } })
    expect(session).toMatchObject({ impersonatorPrincipalId: root.id, impersonatorLogin: 'root' })
    expect(await findActiveSessionByTokenHash(h.db, sha('1'))).toMatchObject({ impersonatorPrincipalId: root.id })
    expect((await createSession(h.db, { principalId: owner.id, tokenHash: sha('2'), expiresAt })).impersonatorPrincipalId).toBeNull()
    expect(await code(() => createSession(h.db, { principalId: owner.id, tokenHash: sha('3'), expiresAt, impersonator: { principalId: owner.id, login: 'alice' } }))).toBe('VALIDATION')
    expect(await code(() => h.query(`UPDATE sessions SET impersonator_login = NULL WHERE id = $1`, [session.id]))).toBe('VALIDATION')
    const member = '77777777-7777-4777-8777-000000000001'
    expect((await createSession(h.db, { principalId: owner.id, tokenHash: sha('5'), expiresAt, impersonator: { principalId: root.id, login: 'sam@alice.example.test', teamMemberId: member } })).impersonatorTeamMemberId).toBe(member)
    expect(await code(() => h.query(`UPDATE sessions SET impersonator_team_member_id = $1 WHERE impersonator_principal_id IS NULL`, [member]))).toBe('VALIDATION')
    await deletePrincipal(h.db, root.id)
    expect(await findActiveSessionByTokenHash(h.db, sha('1'))).toBeNull()
    expect(await findActiveSessionByTokenHash(h.db, sha('2'))).not.toBeNull()
  })

  it('binds a handed-off mailbox without a credential and removes it with the session', async () => {
    const { owner } = await principals()
    const session = await createSession(h.db, { principalId: owner.id, tokenHash: sha('4'), expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    const serviceUserId = randomUUID()
    await saveHandoffMailboxSession(h.db, { sessionId: session.id, mailbox: 'Info@Alice.Example.Test', serviceUserId, accountId })
    expect(await getMailboxSession(h.db, session.id)).toMatchObject({ mailbox: 'info@alice.example.test', serviceUserId, accountId, sealedPassword: null })
    await deleteMailboxSession(h.db, session.id)
    expect(await getMailboxSession(h.db, session.id)).toBeNull()
  })
})
