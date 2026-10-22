import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import {
  createApiToken,
  createResellerPrincipal,
  createRootPrincipal,
  createSession,
  createTestDb,
  findActiveApiTokenByHash,
  findActiveSessionByTokenHash,
  findPrincipalByUsername,
  setTotpSecret,
} from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { StateStore } from '@xpanel/state'
import { sha256Hex, verifyPasswordArgon2id } from './auth.ts'
import { runCli } from './cli.ts'

const PUBLIC_HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const PASSWORD = 'PublicSyntheticBootstrap!2026'

const withCli = async (run: (db: Db, store: StateStore) => Promise<void>): Promise<void> => {
  const handle = await createTestDb()
  const store = new Proxy(new StateStore(join(tmpdir(), `xpanel-cli-unused-${randomUUID()}`)), {
    get: () => assert.fail('credential bootstrap must not access hosting state'),
  })
  try {
    await run(handle.db, store)
  } finally {
    await handle.close()
  }
}

describe('CLI: explicit one-time root provisioning', () => {
  it('creates root only from standard input and requires a first-login password change', async () => {
    const handle = await createTestDb()
    try {
      const password = 'PublicSyntheticBootstrap!2026'
      const result = await runCli(['init-root', '--password-stdin'], {
        db: handle.db,
        store: new StateStore(join(tmpdir(), `xpanel-cli-unused-${randomUUID()}`)),
        readPassword: async () => `${password}\n`,
      })
      assert.equal(result.code, 0)
      const root = await findPrincipalByUsername(handle.db, 'root')
      assert.ok(root)
      assert.equal(root.kind, 'root')
      assert.equal(root.forcePasswordChange, true)
      assert.equal(root.disabled, false)
      assert.equal(await verifyPasswordArgon2id(password, root.passwordHash), true)
      assert.equal(JSON.stringify(result).includes(password), false)
      assert.equal(JSON.stringify(result).includes(root.passwordHash), false)
    } finally {
      await handle.close()
    }
  })

  it('does not overwrite or consume stdin when root already exists', async () => {
    await withCli(async (db, store) => {
      const existing = await createRootPrincipal(db, { username: 'root', passwordHash: PUBLIC_HASH, forcePasswordChange: false })
      let reads = 0
      const result = await runCli(['init-root', '--password-stdin'], {
        db, store, readPassword: async () => { reads++; return PASSWORD },
      })
      assert.equal(result.code, 1)
      assert.match(result.stderr, /CONFLICT: root is already initialized/)
      assert.equal(reads, 0)
      assert.deepEqual(await findPrincipalByUsername(db, 'root'), existing)
    })
  })

  it('does not convert an existing non-root principal with the reserved username', async () => {
    await withCli(async (db, store) => {
      const existing = await createResellerPrincipal(db, { username: 'root', passwordHash: PUBLIC_HASH })
      const result = await runCli(['init-root', '--password-stdin'], { db, store, readPassword: async () => PASSWORD })
      assert.equal(result.code, 1)
      assert.deepEqual(await findPrincipalByUsername(db, 'root'), existing)
    })
  })

  it.each([
    [],
    [PASSWORD],
    ['--password-stdin', PASSWORD],
    ['root', '--password-stdin'],
    ['--password-stdin', '--unknown'],
    ['--password-stdin', '--password-stdin'],
  ])('rejects positional passwords and extra flags without reading stdin: %j', async (...flags) => {
    await withCli(async (db, store) => {
      let reads = 0
      const result = await runCli(['init-root', ...flags], {
        db, store, readPassword: async () => { reads++; return PASSWORD },
      })
      assert.equal(result.code, 1)
      assert.match(result.stderr, /usage: xpanel init-root --password-stdin/)
      assert.equal(reads, 0)
      assert.equal(JSON.stringify(result).includes(PASSWORD), false)
      assert.equal(await findPrincipalByUsername(db, 'root'), null)
    })
  })

  it('requires a stdin reader and never provisions a fallback credential', async () => {
    await withCli(async (db, store) => {
      const result = await runCli(['init-root', '--password-stdin'], { db, store })
      assert.equal(result.code, 1)
      assert.equal(await findPrincipalByUsername(db, 'root'), null)
    })
  })

  it.each(['', 'short', 'x'.repeat(1025), 'two\nlines', 'eightchars\n\n'])('rejects invalid single-line password input case %#', async (password) => {
    await withCli(async (db, store) => {
      const result = await runCli(['init-root', '--password-stdin'], { db, store, readPassword: async () => password })
      assert.equal(result.code, 1)
      assert.match(result.stderr, /single line/)
      assert.equal(await findPrincipalByUsername(db, 'root'), null)
      if (password.length) assert.equal(JSON.stringify(result).includes(password), false)
    })
  })

  it('does not print a failed password reader error or its secret contents', async () => {
    await withCli(async (db, store) => {
      const result = await runCli(['init-root', '--password-stdin'], {
        db, store, readPassword: async () => { throw new Error(`reader failed with ${PASSWORD}`) },
      })
      assert.equal(result.code, 1)
      assert.match(result.stderr, /could not read password/)
      assert.equal(JSON.stringify(result).includes(PASSWORD), false)
      assert.equal(await findPrincipalByUsername(db, 'root'), null)
    })
  })

  it('treats a PHC-looking stdin value as plaintext rather than accepting a precomputed hash', async () => {
    await withCli(async (db, store) => {
      const result = await runCli(['xpanel', 'init-root', '--password-stdin'], {
        db, store, readPassword: async () => `${PUBLIC_HASH}\r\n`,
      })
      assert.equal(result.code, 0)
      const root = await findPrincipalByUsername(db, 'root')
      assert.ok(root)
      assert.notEqual(root.passwordHash, PUBLIC_HASH)
      assert.equal(await verifyPasswordArgon2id(PUBLIC_HASH, root.passwordHash), true)
      assert.equal(await verifyPasswordArgon2id('correct horse battery staple', root.passwordHash), false)
    })
  })

  it('commits one initialized root during concurrent attempts without overwriting the winner', async () => {
    await withCli(async (db, store) => {
      let arrivals = 0
      let release!: () => void
      const ready = new Promise<void>((resolve) => { release = resolve })
      const passwords = ['ConcurrentPublicPassword-A', 'ConcurrentPublicPassword-B']
      const results = await Promise.all(passwords.map((password) => runCli(['init-root', '--password-stdin'], {
        db, store,
        readPassword: async () => { if (++arrivals === 2) release(); await ready; return password },
      })))
      assert.deepEqual(results.map((r) => r.code).sort(), [0, 1])
      const winner = results.findIndex((r) => r.code === 0)
      const root = await findPrincipalByUsername(db, 'root')
      assert.ok(root)
      assert.equal(await verifyPasswordArgon2id(passwords[winner]!, root.passwordHash), true)
      assert.equal(await verifyPasswordArgon2id(passwords[1 - winner]!, root.passwordHash), false)
      assert.equal(root.forcePasswordChange, true)
      const [row] = await db.query<{ count: number }>('SELECT count(*) AS count FROM principals WHERE username = $1', ['root'])
      assert.equal(row!.count, 1)
      for (const password of passwords) assert.equal(JSON.stringify(results).includes(password), false)
    })
  })

  it('rolls back principal creation if its transactional audit record cannot be written', async () => {
    await withCli(async (db, store) => {
      await db.query("CREATE TRIGGER reject_bootstrap_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'fixture audit denied'); END")
      const result = await runCli(['init-root', '--password-stdin'], { db, store, readPassword: async () => PASSWORD })
      assert.equal(result.code, 1)
      assert.equal(await findPrincipalByUsername(db, 'root'), null)
      assert.equal(JSON.stringify(result).includes(PASSWORD), false)
    })
  })

  it('redacts credentials in output and audit, and never calls the privileged agent', async () => {
    await withCli(async (db, store) => {
      const lines: string[] = []
      let hostCalls = 0
      const result = await runCli(['init-root', '--password-stdin'], {
        db, store, readPassword: async () => `${PASSWORD}\n`,
        stdout: (line) => lines.push(line), stderr: (line) => lines.push(line),
        agentToken: 'public-test-token',
        agentApp: {
          fetch: async () => { hostCalls++; return new Response(null, { status: 500 }) },
          subscribe: () => () => {},
        },
      })
      assert.equal(result.code, 0)
      assert.equal(hostCalls, 0)
      const root = await findPrincipalByUsername(db, 'root')
      assert.ok(root)
      const audit = await db.query('SELECT * FROM audit_log')
      assert.equal(audit.length, 1)
      const serialized = JSON.stringify({ lines, result, audit })
      assert.equal(serialized.includes(PASSWORD), false)
      assert.equal(serialized.includes(root.passwordHash), false)
    })
  })

  it('keeps reset-password as recovery for an existing principal only', async () => {
    await withCli(async (db, store) => {
      let reads = 0
      const result = await runCli(['reset-password', 'root', '--password-stdin'], {
        db, store, readPassword: async () => { reads++; return PASSWORD },
      })
      assert.equal(result.code, 1)
      assert.match(result.stderr, /NOT_FOUND/)
      assert.equal(reads, 0)
      assert.equal(await findPrincipalByUsername(db, 'root'), null)
    })
  })

  it('documents the fixed one-time stdin-only command in CLI help', async () => {
    await withCli(async (db, store) => {
      const result = await runCli(['help'], { db, store })
      assert.equal(result.code, 0)
      assert.match(result.stdout, /init-root --password-stdin/)
    })
  })

  it('rolls back reset-password completely (password, sessions, API tokens) if audit or revocation fails, without leaking secrets', async () => {
    await withCli(async (db, store) => {
      const root = await createRootPrincipal(db, {
        username: 'root',
        passwordHash: PUBLIC_HASH,
        forcePasswordChange: false,
      })
      const sessionHash = sha256Hex('cli-reset-session-token')
      const apiTokenHash = sha256Hex('cli-reset-api-token')
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
      await createSession(db, { principalId: root.id, tokenHash: sessionHash, expiresAt, mfaVerified: true })
      await createApiToken(db, { principalId: root.id, name: 'ops', tokenHash: apiTokenHash, scopes: ['*'], expiresAt })

      await db.query(
        "CREATE TRIGGER reject_reset_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'auth.password_reset' BEGIN SELECT RAISE(ABORT, 'fixture reset audit denied'); END",
      )
      const result = await runCli(['reset-password', 'root', '--password-stdin'], {
        db,
        store,
        readPassword: async () => `${PASSWORD}\n`,
      })
      assert.equal(result.code, 1)
      const unchanged = await findPrincipalByUsername(db, 'root')
      assert.equal(unchanged?.passwordHash, PUBLIC_HASH)
      assert.ok(await findActiveSessionByTokenHash(db, sessionHash))
      assert.ok(await findActiveApiTokenByHash(db, apiTokenHash))
      assert.equal(JSON.stringify(result).includes(PASSWORD), false)
    })
  })

  it('rolls back disable-2fa completely and rejects extra flags if audit or revocation fails', async () => {
    await withCli(async (db, store) => {
      const root = await createRootPrincipal(db, {
        username: 'root',
        passwordHash: PUBLIC_HASH,
        forcePasswordChange: false,
      })
      const sealed = new Uint8Array(48).fill(9)
      await setTotpSecret(db, root.id, sealed, [sha256Hex('rec-code-1')])
      const sessionHash = sha256Hex('cli-2fa-session-token')
      const apiTokenHash = sha256Hex('cli-2fa-api-token')
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
      await createSession(db, { principalId: root.id, tokenHash: sessionHash, expiresAt, mfaVerified: true })
      await createApiToken(db, { principalId: root.id, name: 'ops', tokenHash: apiTokenHash, scopes: ['*'], expiresAt })

      // Reject extra flags on disable-2fa
      const extraFlagResult = await runCli(['disable-2fa', 'root', '--unexpected'], { db, store })
      assert.equal(extraFlagResult.code, 1)
      assert.match(extraFlagResult.stderr, /usage: xpanel disable-2fa <username>/)
      assert.equal((await findPrincipalByUsername(db, 'root'))?.totpEnabled, true)

      // Roll back disable-2fa if audit fails
      await db.query(
        "CREATE TRIGGER reject_2fa_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'auth.2fa_disabled' BEGIN SELECT RAISE(ABORT, 'fixture 2fa audit denied'); END",
      )
      const auditFailResult = await runCli(['disable-2fa', 'root'], { db, store })
      assert.equal(auditFailResult.code, 1)
      const afterAbort = await findPrincipalByUsername(db, 'root')
      assert.equal(afterAbort?.totpEnabled, true)
      assert.deepEqual(afterAbort?.totpSecretEnc, sealed)
      assert.ok(await findActiveSessionByTokenHash(db, sessionHash))
      assert.ok(await findActiveApiTokenByHash(db, apiTokenHash))
    })
  })
})
