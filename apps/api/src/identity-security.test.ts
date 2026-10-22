import assert from 'node:assert/strict'
import { createHash, randomUUID, scryptSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { createApiToken, createRootPrincipal, createSession, createTestDb } from '@xpanel/db'
import type { Db, PrincipalRecord } from '@xpanel/db'
import { StateStore } from '@xpanel/state'
import * as auth from './auth.ts'
import { createApiApp } from './server.ts'

// Independent libargon2 fixture: https://argon2-cffi.readthedocs.io/en/21.3.0/
const PASSWORD = 'correct horse battery staple'
const SALT = Buffer.from('MIIRqgvgQbgj220jfp0MPA', 'base64')
const INDEPENDENT_HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'

describe('identity: independent Argon2id interoperability', () => {
  it('verifies a PHC produced by the independent libargon2 implementation', async () => {
    assert.equal(await auth.verifyPasswordArgon2id(PASSWORD, INDEPENDENT_HASH), true)
    assert.equal(await auth.verifyPasswordArgon2id('incorrect', INDEPENDENT_HASH), false)
  })

  it('produces the exact independently verified PHC with the same salt and parameters', async () => {
    assert.equal(await auth.hashPasswordArgon2id(PASSWORD, { salt: SALT }), INDEPENDENT_HASH)
  })

  it('does not export a password verification bypass for tests', () => {
    assert.equal('registerTestPasswordHash' in auth, false)
  })

  it('refuses the former scrypt digest mislabeled as Argon2id', async () => {
    const salt = createHash('sha256').update('xpanel-argon2id-v19:m=65536,t=3,p=4:').update(SALT).digest()
    const digest = scryptSync(PASSWORD, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    const mislabeled = INDEPENDENT_HASH.slice(0, INDEPENDENT_HASH.lastIndexOf('$') + 1) + digest.toString('base64url').replace(/-/g, '+').replace(/_/g, '/')
    assert.equal(await auth.verifyPasswordArgon2id(PASSWORD, mislabeled), false)
  })

  it('uses random salts for independently generated credentials', async () => {
    const first = await auth.hashPasswordArgon2id(PASSWORD)
    const second = await auth.hashPasswordArgon2id(PASSWORD)
    assert.notEqual(first, second)
    assert.equal(await auth.verifyPasswordArgon2id(PASSWORD, first), true)
    assert.equal(await auth.verifyPasswordArgon2id(PASSWORD, second), true)
  })
})

describe('identity: bounded native password work', () => {
  it('rejects malformed, weak, excessive and noncanonical PHC input', async () => {
    const invalid = [
      INDEPENDENT_HASH.replace('argon2id', 'argon2i'),
      INDEPENDENT_HASH.replace('v=19', 'v=16'),
      INDEPENDENT_HASH.replace('m=65536', 'm=32768'),
      INDEPENDENT_HASH.replace('m=65536', 'm=4294967295'),
      INDEPENDENT_HASH.replace('t=3', 't=64'),
      INDEPENDENT_HASH.replace('p=4', 'p=64'),
      INDEPENDENT_HASH.replace('MIIRqgvgQbgj220jfp0MPA', 'MIIRqgvgQbgj220jfp0MPB'),
      INDEPENDENT_HASH.replace('MIIRqgvgQbgj220jfp0MPA', 'c29tZXNhbHQ'),
      INDEPENDENT_HASH.replace('TQbg', 'TQbh'),
      INDEPENDENT_HASH + '=',
      INDEPENDENT_HASH + 'A'.repeat(512),
    ]
    for (const encoded of invalid) assert.equal(await auth.verifyPasswordArgon2id(PASSWORD, encoded), false)
  })

  it('bounds password bytes and parameters before deriving a credential', async () => {
    await assert.rejects(auth.hashPasswordArgon2id(''), /password/)
    await assert.rejects(auth.hashPasswordArgon2id('أ'.repeat(513)), /UTF-8/)
    await assert.rejects(auth.hashPasswordArgon2id(PASSWORD, { memoryKiB: 32_768 }), /65536/)
    await assert.rejects(auth.hashPasswordArgon2id(PASSWORD, { memoryKiB: 131_073 }), /131072/)
    await assert.rejects(auth.hashPasswordArgon2id(PASSWORD, { timeCost: 7 }), /t=1..6/)
    await assert.rejects(auth.hashPasswordArgon2id(PASSWORD, { parallelism: 5 }), /p=1..4/)
    await assert.rejects(auth.hashPasswordArgon2id(PASSWORD, { salt: Buffer.alloc(8) }), /16..64/)
    assert.equal(await auth.verifyPasswordArgon2id('x'.repeat(1025), INDEPENDENT_HASH), false)
  })

  it('validates supplied PHC credentials with the same cost and encoding policy', () => {
    assert.equal(auth.assertPasswordHashArgon2id(INDEPENDENT_HASH), INDEPENDENT_HASH)
    assert.throws(() => auth.assertPasswordHashArgon2id(INDEPENDENT_HASH.replace('t=3', 't=64')), /supported Argon2id/)
    assert.throws(() => auth.assertPasswordHashArgon2id(`${INDEPENDENT_HASH}=`), /canonical/)
  })

  it('provisions only explicit credentials and preserves the service hash scheme', async () => {
    await assert.rejects(auth.passwordHashFromInput({}), /at least 8/)
    await assert.rejects(auth.passwordHashFromInput({ password: 'short' }), /at least 8/)
    await assert.rejects(auth.passwordHashFromInput({ password: PASSWORD, passwordHash: INDEPENDENT_HASH }), /not both/)
    await assert.rejects(auth.passwordHashFromInput({ passwordHash: INDEPENDENT_HASH }, { service: true }), /scheme/)
    assert.equal(await auth.passwordHashFromInput({ passwordHash: INDEPENDENT_HASH }), INDEPENDENT_HASH)
    assert.equal(await auth.passwordHashFromInput({ passwordHash: `{ARGON2ID}${INDEPENDENT_HASH}` }, { service: true }), `{ARGON2ID}${INDEPENDENT_HASH}`)
    const generated = await auth.passwordHashFromInput({ password: PASSWORD }, { service: true })
    assert.ok(generated.startsWith('{ARGON2ID}'))
    assert.equal(await auth.verifyPasswordArgon2id(PASSWORD, generated.slice('{ARGON2ID}'.length)), true)
  })

  it('allows the event loop to serve other work during a native KDF', async () => {
    let completed = false
    const pending = auth.hashPasswordArgon2id(PASSWORD).then(() => { completed = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(completed, false)
    await pending
  })

  it('rejects excess queued password work rather than allocating unbounded native jobs', async () => {
    const capacity = auth.MAX_PASSWORD_DERIVATIONS + auth.MAX_PENDING_PASSWORD_DERIVATIONS
    const attempts = Array.from({ length: capacity + 1 }, () => auth.hashPasswordArgon2id(PASSWORD))
    const results = await Promise.allSettled(attempts)
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, capacity)
    const rejected = results.filter((r) => r.status === 'rejected')
    assert.equal(rejected.length, 1)
    assert.match(String(rejected[0]!.reason), /capacity/)
    assert.equal((rejected[0]!.reason as { code?: string }).code, 'SERVICE_UNAVAILABLE')
    assert.deepEqual(auth.getPasswordDerivationStats(), {
      active: 0,
      pending: 0,
      maxActive: auth.MAX_PASSWORD_DERIVATIONS,
      maxPending: auth.MAX_PENDING_PASSWORD_DERIVATIONS,
    })
    assert.equal(await auth.verifyPasswordArgon2id(PASSWORD, INDEPENDENT_HASH), true)
  })

  it('enforces HTTP 503 queue bounds during a concurrent login burst while keeping /api/health responsive and RSS bounded', async () => {
    await withIdentity(async (db) => {
      const store = new StateStore(join(tmpdir(), `xpanel-kdf-burst-${randomUUID()}`))
      const app = createApiApp({
        db,
        store,
        serverSecret: 'burst-test-server-secret-at-least-32-bytes!!',
        lockoutThreshold: 1000,
      })

      const capacity = auth.MAX_PASSWORD_DERIVATIONS + auth.MAX_PENDING_PASSWORD_DERIVATIONS
      const totalBurst = capacity + 3 // 17 accepted (1 active + 16 queued) + 3 rejected with 503
      const baselineRss = process.memoryUsage().rss
      let peakRss = baselineRss
      const rssSampler = setInterval(() => {
        const current = process.memoryUsage().rss
        if (current > peakRss) peakRss = current
      }, 10)

      let healthStatus = 0
      let healthLatencyMs = 0
      let observedActiveDuringHealth = 0

      try {
        const loginPromises = Array.from({ length: totalBurst }, (_, i) => {
          const startedAt = performance.now()
          const req = new Request('http://localhost/api/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'root', password: PASSWORD }),
          })
          return app
            .fetch(req, { remoteAddress: `198.51.100.${(i % 200) + 1}` })
            .then(async (res) => ({
              status: res.status,
              durationMs: performance.now() - startedAt,
              bodyText: await res.text(),
            }))
        })

        // Dispatch concurrent health probe while KDF burst is active
        await new Promise((resolve) => setTimeout(resolve, 15))
        observedActiveDuringHealth = auth.getPasswordDerivationStats().active
        const healthStart = performance.now()
        const healthRes = await app.fetch(new Request('http://localhost/api/health'))
        healthLatencyMs = performance.now() - healthStart
        healthStatus = healthRes.status

        const outcomes = await Promise.all(loginPromises)
        const currentRss = process.memoryUsage().rss
        if (currentRss > peakRss) peakRss = currentRss

        const succeeded = outcomes.filter((o) => o.status === 200)
        const rejected503 = outcomes.filter((o) => o.status === 503)

        assert.equal(succeeded.length, capacity)
        assert.equal(rejected503.length, 3)
        assert.equal(healthStatus, 200)
        assert.equal(observedActiveDuringHealth, 1)
        assert.ok(healthLatencyMs < 250, `expected responsive health probe during KDF burst, got ${healthLatencyMs}ms`)

        const peakRssDeltaMiB = (peakRss - baselineRss) / (1024 * 1024)
        assert.ok(peakRssDeltaMiB < 256, `expected bounded RSS delta (< 256 MiB), got ${peakRssDeltaMiB.toFixed(2)} MiB`)

        for (const r of rejected503) {
          const problem = JSON.parse(r.bodyText) as { code?: string; status?: number; detail?: string }
          assert.equal(problem.status, 503)
          assert.equal(problem.code, 'SERVICE_UNAVAILABLE')
          assert.match(problem.detail ?? '', /capacity/)
          assert.equal(r.bodyText.includes(PASSWORD), false)
          assert.equal(r.bodyText.includes(INDEPENDENT_HASH), false)
        }

        assert.deepEqual(auth.getPasswordDerivationStats(), {
          active: 0,
          pending: 0,
          maxActive: auth.MAX_PASSWORD_DERIVATIONS,
          maxPending: auth.MAX_PENDING_PASSWORD_DERIVATIONS,
        })
      } finally {
        clearInterval(rssSampler)
      }
    })
  })
})

const withIdentity = async (run: (db: Db, root: PrincipalRecord) => Promise<void>): Promise<void> => {
  const handle = await createTestDb()
  try {
    const root = await createRootPrincipal(handle.db, { username: 'root', passwordHash: INDEPENDENT_HASH })
    await run(handle.db, root)
  } finally {
    await handle.close()
  }
}

const sessionRequest = (token: string): Request => new Request('http://localhost/api/auth/me', {
  headers: { cookie: `${auth.SESSION_COOKIE_NAME}=${token}` },
})

describe('identity: authorization constraints and session lifetime', () => {
  it('never upgrades an empty API token scope list to wildcard access', async () => {
    await withIdentity(async (db, root) => {
      const token = 'empty-scope-test-token'
      await createApiToken(db, { principalId: root.id, name: 'No access', tokenHash: auth.sha256Hex(token), scopes: [], expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
      const caller = await auth.authenticateRequest(db, new Request('http://localhost/api/accounts', {
        headers: { authorization: `Bearer ${token}` },
      }), { serverSecret: 'test-secret' })
      assert.ok(caller)
      assert.deepEqual(caller.scopes, [])
    })
  })

  it('denies an IP-bound API token when no client address is available', async () => {
    await withIdentity(async (db, root) => {
      const token = 'ip-bound-test-token'
      await createApiToken(db, { principalId: root.id, name: 'Bound', tokenHash: auth.sha256Hex(token), scopes: ['*'], allowedIps: ['192.0.2.0/24'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
      const req = new Request('http://localhost/api/accounts', { headers: { authorization: `Bearer ${token}` } })
      assert.equal(await auth.authenticateRequest(db, req, { serverSecret: 'test-secret' }), null)
      assert.equal(await auth.authenticateRequest(db, req, { serverSecret: 'test-secret', clientIp: null }), null)
      assert.ok(await auth.authenticateRequest(db, req, { serverSecret: 'test-secret', clientIp: '192.0.2.4' }))
    })
  })

  it('denies an idle session before touching its last activity timestamp', async () => {
    await withIdentity(async (db, root) => {
      const token = 'idle-session-test-token'
      const session = await createSession(db, { principalId: root.id, tokenHash: auth.sha256Hex(token), expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
      const oldActivity = new Date(Date.now() - auth.SESSION_IDLE_TIMEOUT_MS - 1000).toISOString()
      await db.query('UPDATE sessions SET last_seen_at = $1 WHERE id = $2', [oldActivity, session.id])
      assert.equal(await auth.authenticateRequest(db, sessionRequest(token), { serverSecret: 'test-secret' }), null)
      const [row] = await db.query<{ last_seen_at: string }>('SELECT last_seen_at FROM sessions WHERE id = $1', [session.id])
      assert.equal(row!.last_seen_at, oldActivity)
    })
  })

  it('enforces absolute lifetime despite recent activity and a later stored expiresAt', async () => {
    await withIdentity(async (db, root) => {
      const token = 'absolute-session-test-token'
      const session = await createSession(db, { principalId: root.id, tokenHash: auth.sha256Hex(token), expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
      await db.query('UPDATE sessions SET created_at = $1 WHERE id = $2', [new Date(Date.now() - auth.SESSION_ABSOLUTE_TIMEOUT_MS - 1000).toISOString(), session.id])
      assert.equal(await auth.authenticateRequest(db, sessionRequest(token), { serverSecret: 'test-secret' }), null)
    })
  })

  it('does not extend activity during passive WebSocket revalidation', async () => {
    await withIdentity(async (db, root) => {
      const token = 'passive-session-test-token'
      const session = await createSession(db, { principalId: root.id, tokenHash: auth.sha256Hex(token), expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
      const previousActivity = new Date(Date.now() - 60_000).toISOString()
      await db.query('UPDATE sessions SET last_seen_at = $1 WHERE id = $2', [previousActivity, session.id])
      const caller = await auth.authenticateRequest(db, sessionRequest(token), { serverSecret: 'test-secret', touchSession: false })
      assert.ok(caller)
      const [row] = await db.query<{ last_seen_at: string }>('SELECT last_seen_at FROM sessions WHERE id = $1', [session.id])
      assert.equal(row!.last_seen_at, previousActivity)
      assert.ok(await auth.authenticateRequest(db, sessionRequest(token), { serverSecret: 'test-secret' }))
      const [touched] = await db.query<{ last_seen_at: string }>('SELECT last_seen_at FROM sessions WHERE id = $1', [session.id])
      assert.notEqual(touched!.last_seen_at, previousActivity)
    })
  })
})

describe('identity: MFA primitives', () => {
  it('returns the precise RFC 6238 counter so storage can reject replay', () => {
    const secret = auth.encodeBase32(Buffer.from('12345678901234567890'))
    const time = 59_000
    assert.equal(auth.computeTotpCode(secret, time), '287082')
    assert.equal(auth.verifyTotpStep(secret, '287082', time, 0), 1)
    assert.equal(auth.verifyTotpStep(secret, '287082', time + 30_000, 1), 1)
    assert.equal(auth.verifyTotpStep(secret, '287082', time + 90_000, 1), null)
    assert.equal(auth.verifyTotpStep(secret, '287082', NaN), null)
    assert.equal(auth.verifyTotpStep(secret, 'invalid', time), null)
  })

  it('refuses to seal or unseal MFA secrets with an absent server key', () => {
    const secret = auth.generateTotpSecret()
    assert.throws(() => auth.sealTotpSecret(secret, ''), /serverSecret/)
    const sealed = auth.sealTotpSecret(secret, 'test-key-present')
    assert.throws(() => auth.unsealTotpSecret(sealed, ''), /serverSecret/)
    assert.throws(() => auth.unsealTotpSecret(sealed, 'another-key'))
  })
})
