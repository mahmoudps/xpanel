import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRootPrincipal, createSession, createTestDb } from '@xpanel/db'
import { authenticateRequest, hashPasswordArgon2id, SESSION_COOKIE_NAME } from './auth.ts'
import { sessionTokenHash } from './entry-points.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
const LIMITS = { idleMs: 3_600_000, absoluteMs: 86_400_000 }

async function fixture() {
  const database = await createTestDb()
  cleanup.push(() => database.close())
  const principal = await createRootPrincipal(database.db, { username: 'root', passwordHash: await hashPasswordArgon2id('fixture-password'), forcePasswordChange: false })
  await createSession(database.db, { principalId: principal.id, tokenHash: sessionTokenHash('token'), ip: '203.0.113.9', mfaVerified: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
  const request = new Request('http://panel.test/api/server/settings', { headers: { cookie: `${SESSION_COOKIE_NAME}=token` } })
  return (clientIp: string, ipMode: 'strict' | 'loose' | 'disabled', onSessionAddressMismatch = vi.fn()) => authenticateRequest(database.db, request, { serverSecret: 'a'.repeat(64), clientIp, sessionLimits: { ...LIMITS, ipMode }, onSessionAddressMismatch })
}

describe('session address validation', { tags: ['feature'] }, () => {
  it('refuses a valid cookie replayed from another address and says why', async () => {
    const authenticate = await fixture(), mismatch = vi.fn()
    expect(await authenticate('198.51.100.7', 'strict', mismatch)).toBeNull()
    expect(mismatch).toHaveBeenCalledOnce()
  })
  it('admits the signing address, the same network in loose mode, and any address when disabled', async () => {
    const authenticate = await fixture()
    expect(await authenticate('203.0.113.9', 'strict')).not.toBeNull()
    expect(await authenticate('203.0.113.200', 'loose')).not.toBeNull()
    expect(await authenticate('198.51.100.7', 'disabled')).not.toBeNull()
  })
})
