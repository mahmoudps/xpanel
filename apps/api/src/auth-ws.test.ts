import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { assertArgon2Hash } from '@xpanel/core'
import {
  createApiToken,
  createRootPrincipal,
  createSession,
  createTestDb,
} from '@xpanel/db'
import {
  CSRF_HEADER_NAME,
  HOST_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  authenticateRequest,
  clearSessionCookie,
  computeTotpCode,
  deriveCsrfToken,
  formatSessionCookie,
  generateTotpSecret,
  hashPasswordArgon2id,
  parseCookies,
  sealTotpSecret,
  sha256Hex,
  unsealTotpSecret,
  verifyCsrfToken,
  verifyPasswordArgon2id,
  verifyTotpCode,
} from './auth.ts'

describe('auth: Argon2id password hashing and verification', () => {
  it('produces RFC 9106 Argon2id PHC strings with m >= 65536 and verifies in constant time', async () => {
    const hash = await hashPasswordArgon2id('CorrectHorseBatteryStaple!99')
    assert.equal(assertArgon2Hash(hash), hash)
    assert.match(hash, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/)

    assert.equal(await verifyPasswordArgon2id('CorrectHorseBatteryStaple!99', hash), true)
    assert.equal(await verifyPasswordArgon2id('WrongPassword!99', hash), false)
  })

  it('rejects weak memory (< 65536 KiB) and argon2i hashes', async () => {
    await assert.rejects(hashPasswordArgon2id('secret', { memoryKiB: 32_768 }), /65536/)

    const weakHash = '$argon2id$v=19$m=4096,t=3,p=4$c29tZXNhbHR2YWx1ZQ$c29tZWhhc2h2YWx1ZXRoaXNpc2xvbmdlbm91Z2g'
    const argon2iHash = '$argon2i$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$c29tZWhhc2h2YWx1ZXRoaXNpc2xvbmdlbm91Z2g'
    assert.equal(await verifyPasswordArgon2id('secret', weakHash), false)
    assert.equal(await verifyPasswordArgon2id('secret', argon2iHash), false)
  })

})

describe('auth: TOTP 2FA and secret sealing', () => {
  it('generates 160-bit Base32 secrets and verifies codes across the ±1 step window', () => {
    const secret = generateTotpSecret()
    assert.match(secret, /^[A-Z2-7]{32}$/)

    const fixedTime = 1_700_000_000_000
    const codeNow = computeTotpCode(secret, fixedTime)
    assert.match(codeNow, /^\d{6}$/)

    // Exact timestamp and ±30s step should pass
    assert.equal(verifyTotpCode(secret, codeNow, fixedTime), true)
    assert.equal(verifyTotpCode(secret, codeNow, fixedTime + 30_000, 1), true)
    assert.equal(verifyTotpCode(secret, codeNow, fixedTime - 30_000, 1), true)

    // Outside window (+90s) or malformed code should fail
    assert.equal(verifyTotpCode(secret, codeNow, fixedTime + 90_000, 1), false)
    assert.equal(verifyTotpCode(secret, '000000', fixedTime, 0) && codeNow !== '000000', false)
    assert.equal(verifyTotpCode(secret, 'not-a-code', fixedTime), false)
  })

  it('seals and unseals TOTP secrets with AES-256-GCM', () => {
    const secret = generateTotpSecret()
    const sealed = sealTotpSecret(secret, 'server-master-secret')
    assert.ok(sealed.byteLength >= 16 && sealed.byteLength <= 1024)
    assert.equal(unsealTotpSecret(sealed, 'server-master-secret'), secret)
    assert.throws(() => unsealTotpSecret(sealed, 'wrong-secret'))
  })
})

describe('auth: cookies, CSRF, and authenticateRequest', () => {
  it('formats, parses, and clears session cookies and verifies CSRF tokens', () => {
    const cookieHeader = formatSessionCookie('tok_abc123', { secure: true, maxAgeSec: 3600 })
    assert.match(cookieHeader, /^__Host-xpanel_session=tok_abc123; HttpOnly; SameSite=Strict; Path=\/; Max-Age=3600; Secure$/)

    const parsed = parseCookies(`${HOST_SESSION_COOKIE_NAME}=tok_abc123; theme=dark`)
    assert.equal(parsed[HOST_SESSION_COOKIE_NAME], 'tok_abc123')
    assert.equal(parsed.theme, 'dark')

    const cleared = clearSessionCookie()
    assert.match(cleared, new RegExp(`^${SESSION_COOKIE_NAME}=;.*Max-Age=0`))

    const csrf = deriveCsrfToken('tok_abc123', 'srv-secret')
    assert.equal(verifyCsrfToken('tok_abc123', csrf, 'srv-secret'), true)
    assert.equal(verifyCsrfToken('tok_abc123', csrf, 'wrong-secret'), false)
    assert.equal(verifyCsrfToken('tok_abc123', 'bad-csrf', 'srv-secret'), false)
  })

  it('authenticates both session cookies and Bearer API tokens against SQLite', async () => {
    const handle = await createTestDb()
    try {
      const serverSecret = 'test-server-secret-key'
      const pwHash = await hashPasswordArgon2id('RootPass!2026')
      const rootPrincipal = await createRootPrincipal(handle.db, {
        username: 'root',
        passwordHash: pwHash,
        forcePasswordChange: false,
      })

      const sessionToken = 'sess_live_token_001'
      const session = await createSession(handle.db, {
        principalId: rootPrincipal.id,
        tokenHash: sha256Hex(sessionToken),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        ip: '192.0.2.10',
        userAgent: 'node-test',
        mfaVerified: true,
      })

      const csrf = deriveCsrfToken(sessionToken, serverSecret)
      const reqWithCsrf = new Request('http://localhost/api/accounts', {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          [CSRF_HEADER_NAME]: csrf,
        },
      })
      const caller1 = await authenticateRequest(handle.db, reqWithCsrf, { serverSecret })
      assert.ok(caller1)
      assert.equal(caller1.principal.kind, 'root')
      assert.equal(caller1.sessionId, session.id)
      assert.equal(caller1.csrfValid, true)

      const reqWithoutCsrf = new Request('http://localhost/api/accounts', {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        },
      })
      const callerNoCsrf = await authenticateRequest(handle.db, reqWithoutCsrf, { serverSecret })
      assert.ok(callerNoCsrf)
      assert.equal(callerNoCsrf.csrfValid, false)

      // Bearer API token authentication
      const rawApiToken = 'xp_live_token_998877'
      await createApiToken(handle.db, {
        principalId: rootPrincipal.id,
        name: 'CI Deploy Token',
        tokenHash: sha256Hex(rawApiToken),
        scopes: ['accounts:read', 'domains:write'],
        allowedIps: ['192.0.2.0/24'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })

      const bearerReq = new Request('http://localhost/api/accounts', {
        headers: {
          authorization: `Bearer ${rawApiToken}`,
        },
      })
      const bearerCaller = await authenticateRequest(handle.db, bearerReq, {
        serverSecret,
        clientIp: '192.0.2.55',
      })
      assert.ok(bearerCaller)
      assert.equal(bearerCaller.principal.id, rootPrincipal.id)
      assert.equal(bearerCaller.sessionId, null)
      assert.deepEqual(bearerCaller.scopes, ['accounts:read', 'domains:write'])
      assert.equal(bearerCaller.csrfValid, true)

      // Disallowed client IP is rejected
      const blockedIpCaller = await authenticateRequest(handle.db, bearerReq, {
        serverSecret,
        clientIp: '198.51.100.9',
      })
      assert.equal(blockedIpCaller, null)
    } finally {
      await handle.close()
    }
  })
})
