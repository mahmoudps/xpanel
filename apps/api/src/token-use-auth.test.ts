import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createApiToken,
  createRootPrincipal,
  createTestDb,
  listApiTokensForPrincipal,
  recordApiTokenUse,
  revokeApiToken,
  setPrincipalDisabled,
} from '@xpanel/db'
import type { DbHandle } from '@xpanel/db'
import { authenticateRequest, sha256Hex } from './auth.ts'

// Independently generated fixture already used by identity-security.test.ts; no KDF is needed here.
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SERVER_SECRET = 'synthetic-token-usage-test-server-secret'

describe('API token successful-use recording', () => {
  let handle: DbHandle
  let principalId: string
  let tokenId: string
  let rawToken: string

  const request = (token = rawToken): Request => new Request('http://localhost/api/auth/me', {
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '198.51.100.99' },
  })
  const stored = async () => (await listApiTokensForPrincipal(handle.db, principalId)).find(token => token.id === tokenId)!

  beforeEach(async () => {
    handle = await createTestDb()
    const root = await createRootPrincipal(handle.db, { username: 'root', passwordHash: PASSWORD_HASH })
    principalId = root.id
    rawToken = randomBytes(32).toString('base64url')
    const token = await createApiToken(handle.db, {
      principalId,
      name: 'Use recording fixture',
      tokenHash: sha256Hex(rawToken),
      scopes: ['accounts:read'],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    tokenId = token.id
  })

  afterEach(async () => { await handle.close() })

  it('records a real timestamp and canonical trusted address after successful authentication', async () => {
    expect((await stored()).lastUsedAt).toBeNull()
    const before = Date.now()
    const caller = await authenticateRequest(handle.db, request(), { serverSecret: SERVER_SECRET, clientIp: '::ffff:192.0.2.7' })
    const token = await stored()
    expect(caller?.apiTokenId).toBe(tokenId)
    expect(caller?.scopes).toEqual(['accounts:read'])
    expect(Date.parse(token.lastUsedAt!)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(token.lastUsedAt!)).toBeLessThanOrEqual(Date.now())
    expect(token.lastUsedIp).toBe('192.0.2.7')
    expect(token.tokenHash).toBe(sha256Hex(rawToken))
    expect(token.revokedAt).toBeNull()
  })

  it.each([undefined, null, 'invalid-address'])('records use with unknown IP %s without trusting forwarded headers', async (clientIp) => {
    expect(await authenticateRequest(handle.db, request(), { serverSecret: SERVER_SECRET, clientIp })).not.toBeNull()
    const token = await stored()
    expect(Number.isFinite(Date.parse(token.lastUsedAt!))).toBe(true)
    expect(token.lastUsedIp).toBeNull()
  })

  it('coalesces same-address bursts in the database and records changed addresses or later use', async () => {
    const recent = new Date(Date.now() - 10_000).toISOString()
    await handle.db.query('UPDATE api_tokens SET last_used_at = $1, last_used_ip = $2 WHERE id = $3', [recent, '192.0.2.7', tokenId])
    const opts = { serverSecret: SERVER_SECRET, clientIp: '192.0.2.7' }
    expect(await authenticateRequest(handle.db, request(), opts)).not.toBeNull()
    expect((await stored()).lastUsedAt).toBe(recent)
    expect(await authenticateRequest(handle.db, request(), { ...opts, clientIp: '192.0.2.8' })).not.toBeNull()
    expect((await stored()).lastUsedIp).toBe('192.0.2.8')
    expect(Date.parse((await stored()).lastUsedAt!)).toBeGreaterThan(Date.parse(recent))
    const old = new Date(Date.now() - 61_000).toISOString()
    await handle.db.query('UPDATE api_tokens SET last_used_at = $1 WHERE id = $2', [old, tokenId])
    expect(await authenticateRequest(handle.db, request(), { ...opts, clientIp: '192.0.2.8' })).not.toBeNull()
    expect(Date.parse((await stored()).lastUsedAt!)).toBeGreaterThan(Date.parse(old))
  })

  it.each(['wrong secret', 'expired', 'revoked', 'disabled', 'IP denied', 'IP unavailable', 'interactive listener', 'malformed header'])('does not change usage after %s rejection', async (reason) => {
    const originalUse = new Date(Date.now() - 120_000).toISOString()
    await handle.db.query('UPDATE api_tokens SET last_used_at = $1, last_used_ip = $2 WHERE id = $3', [originalUse, '192.0.2.1', tokenId])
    if (reason === 'expired') await handle.db.query('UPDATE api_tokens SET created_at = $1, expires_at = $2 WHERE id = $3', [new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 1000).toISOString(), tokenId])
    if (reason === 'revoked') await revokeApiToken(handle.db, tokenId)
    if (reason === 'disabled') await setPrincipalDisabled(handle.db, principalId, true)
    if (reason.startsWith('IP ')) await handle.db.query('UPDATE api_tokens SET allowed_ips = $1 WHERE id = $2', [JSON.stringify(['192.0.2.0/24']), tokenId])
    const req = reason === 'malformed header'
      ? new Request('http://localhost/api/auth/me', { headers: { authorization: 'Basic invalid' } })
      : request(reason === 'wrong secret' ? randomBytes(32).toString('base64url') : rawToken)
    const caller = await authenticateRequest(handle.db, req, {
      serverSecret: SERVER_SECRET,
      clientIp: reason === 'IP unavailable' ? null : '198.51.100.2',
      ...(reason === 'interactive listener' ? { entryPoint: 'xwhm' as const } : {}),
    })
    expect(caller).toBeNull()
    const token = await stored()
    expect(token.lastUsedAt).toBe(originalUse)
    expect(token.lastUsedIp).toBe('192.0.2.1')
  })

  it.each(['expired', 'revoked', 'disabled'])('guards the persistence write if a previously valid token becomes %s', async (reason) => {
    if (reason === 'expired') await handle.db.query('UPDATE api_tokens SET created_at = $1, expires_at = $2 WHERE id = $3', [new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 1000).toISOString(), tokenId])
    if (reason === 'revoked') await revokeApiToken(handle.db, tokenId)
    if (reason === 'disabled') await setPrincipalDisabled(handle.db, principalId, true)
    await recordApiTokenUse(handle.db, tokenId, '192.0.2.7')
    const token = await stored()
    expect(token.lastUsedAt).toBeNull()
    expect(token.lastUsedIp).toBeNull()
  })
})
