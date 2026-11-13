import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MIN_ARGON2_MEMORY_KIB } from '@xpanel/core'
import { createDb, createRootPrincipal, createTestDb } from '@xpanel/db'
import type { DbHandle } from '@xpanel/db'
import { createStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { hashPasswordArgon2id, passwordHashFromInput } from './auth.ts'
import { usePasswordStrengthPolicy, defaultPasswordStrength } from './password-policy.ts'
import { createApiApp } from './server.ts'
import { defaultSignInPolicy, parseSignInPolicy, signInAddressRule } from './sign-in-policy.ts'
import { writeSignInPolicy } from './testing/sign-in-policy-fixture.ts'

const SERVER_SECRET = 'sign-in-policy-synthetic-server-secret-at-least-32-bytes'
const ORIGIN = 'https://panel.example.test'
const PASSWORD = 'SyntheticRootPassword!2026'
const STATE_PARENT = existsSync('/dev/shm') ? '/dev/shm' : tmpdir()
let passwordHash: string
let sqliteTemplate: Uint8Array
beforeAll(async () => {
  passwordHash = await hashPasswordArgon2id(PASSWORD, { memoryKiB: MIN_ARGON2_MEMORY_KIB, timeCost: 1, parallelism: 1 })
  const seedDb = await createTestDb()
  try {
    await createRootPrincipal(seedDb.db, { username: 'root', passwordHash, forcePasswordChange: false })
    sqliteTemplate = seedDb.sqlite.serialize()
  } finally {
    await seedDb.close()
  }
})

describe('sign-in policy rules', { tags: ['unit'] }, () => {
  it('canonicalizes ranges, rounds strength up to a multiple of 5 and refuses out-of-range values', () => {
    const policy = defaultSignInPolicy()
    const parsed = parseSignInPolicy({ ...policy, lockout: { ...policy.lockout, ipAllow: ['198.51.100.0/24', ' 2001:DB8::1 '] },
      passwordStrength: { default: 42, perService: { ...policy.passwordStrength.perService, mail: 70 } } })
    expect(parsed.lockout.ipAllow).toEqual(['198.51.100.0/24', '2001:db8::1'])
    expect(parsed.passwordStrength).toMatchObject({ default: 45, perService: { mail: 70, panel: null } })
    for (const bad of [
      { ...policy, lockout: { ...policy.lockout, username: { attempts: 0, windowMin: 15, durationMin: 15 } } },
      { ...policy, lockout: { ...policy.lockout, ipAllow: ['198.51.100.1/24'] } },
      { ...policy, lockout: { ...policy.lockout, ipAllow: ['198.51.100.7'], ipDeny: ['198.51.100.7'] } },
      { ...policy, session: { idleMin: 31, absoluteHours: 24 } },
      { ...policy, session: { idleMin: 30, absoluteHours: 25 } },
      { ...policy, passwordStrength: { default: 101, perService: policy.passwordStrength.perService } },
      { ...policy, extra: true },
    ]) expect(() => parseSignInPolicy(bad)).toThrow()
  })

  it('lets an allowed address win over a denied range', () => {
    const policy = parseSignInPolicy({ ...defaultSignInPolicy(), lockout: { ...defaultSignInPolicy().lockout, ipAllow: ['203.0.113.7'], ipDeny: ['203.0.113.0/24'] } })
    expect([signInAddressRule(policy, '203.0.113.7'), signInAddressRule(policy, '203.0.113.8'), signInAddressRule(policy, '198.51.100.1'), signInAddressRule(policy, null)])
      .toEqual(['allowed', 'denied', 'counted', 'counted'])
  })
})

describe('sign-in policy routes and effects', () => {
  let db: DbHandle
  let state: TestStateStoreHandle
  beforeEach(async () => {
    db = createDb(':memory:')
    db.sqlite.deserialize(sqliteTemplate)
    const rootDir = await mkdtemp(join(STATE_PARENT, 'xpanel-signin-'))
    state = { store: createStateStore(rootDir), rootDir, close: () => rm(rootDir, { recursive: true, force: true }) }
  })
  afterEach(async () => { usePasswordStrengthPolicy(defaultPasswordStrength()); await state.close(); await db.close() })

  const app = () => createApiApp({ db: db.db, store: state.store, serverSecret: SERVER_SECRET, allowedOrigins: [ORIGIN] })
  const login = (api: ReturnType<typeof app>, password = PASSWORD) => api.fetch(new Request(ORIGIN + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ username: 'root', password }),
  }))
  const session = async (api: ReturnType<typeof app>) => {
    const response = await login(api)
    expect(response.status).toBe(200)
    const body = await response.json() as { csrfToken: string; session: { id: string } }
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: body.csrfToken, id: body.session.id }
  }
  const call = (api: ReturnType<typeof app>, s: { cookie: string; csrf: string }, method: string, path: string, body?: unknown) => api.fetch(new Request(ORIGIN + path, {
    method, headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const save = async (api: ReturnType<typeof app>, s: { cookie: string; csrf: string }, change: (policy: ReturnType<typeof defaultSignInPolicy>) => void) => {
    const view = await (await call(api, s, 'GET', '/api/server/sec/sign-in')).json() as { revision: string; policy: ReturnType<typeof defaultSignInPolicy> }
    change(view.policy)
    return call(api, s, 'PUT', '/api/server/sec/sign-in', { expectedRevision: view.revision, policy: view.policy })
  }

  it('locks the username on the third failure when the policy allows three attempts, and root lifts the lock', async () => {
    const api = app(), root = await session(api)
    const saved = await save(api, root, policy => { policy.lockout.username = { attempts: 3, windowMin: 10, durationMin: 30 } })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ state: 'saved', policy: { lockout: { username: { attempts: 3 } } } })
    expect((await login(api, 'wrong-password-1')).status).toBe(401)
    expect((await login(api, 'wrong-password-2')).status).toBe(401)
    const third = await login(api, 'wrong-password-3')
    expect(third.status).toBe(429)
    expect(await third.json()).toMatchObject({ code: 'LOCKED_OUT', details: { lockedOut: true } })
    expect((await login(api)).status).toBe(429)
    const locks = await (await call(api, root, 'GET', '/api/server/sec/sign-in/lockouts')).json() as { lockouts: { username: string | null }[] }
    expect(locks.lockouts.map(lock => lock.username)).toContain('root')
    const unlock = await call(api, root, 'POST', '/api/server/sec/sign-in/unlock', { username: 'root' })
    expect(await unlock.json()).toMatchObject({ cleared: 1 })
    expect((await login(api)).status).toBe(200)
  })

  it('never locks an allowed address and refuses a denied one before checking the password', async () => {
    await writeSignInPolicy(state.store.rootDir, policy => { policy.lockout.username = { attempts: 2, windowMin: 15, durationMin: 15 }; policy.lockout.ip = { attempts: 2, windowMin: 15, durationMin: 15 }; policy.lockout.ipAllow = ['127.0.0.1'] })
    const api = app()
    for (let attempt = 0; attempt < 4; attempt++) expect((await login(api, 'wrong-password')).status).toBe(401)
    expect((await login(api)).status).toBe(200)
    await writeSignInPolicy(state.store.rootDir, policy => { policy.lockout.ipDeny = ['127.0.0.0/8'] })
    const denied = await login(api)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ details: { reason: 'address_denied' } })
  })

  it('refuses a policy that denies the address of the saving session', async () => {
    const api = app(), root = await session(api)
    const response = await save(api, root, policy => { policy.lockout.ipDeny = ['127.0.0.0/8'] })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ details: { reason: 'self_lockout', stateChanged: false } })
  })

  it('applies the saved mail strength to new mail passwords', async () => {
    const api = app(), root = await session(api)
    expect((await save(api, root, policy => { policy.passwordStrength.perService.mail = 70 })).status).toBe(200)
    await expect(passwordHashFromInput({ password: 'abcdefgh' }, { service: ['mail'] })).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'weak_password', required: 70 } })
    await expect(passwordHashFromInput({ password: 'abcdefgh' })).resolves.toMatch(/^\$argon2id\$/)
  })

  it('ends a session idle longer than the saved idle timeout', async () => {
    const api = app(), root = await session(api)
    expect((await save(api, root, policy => { policy.session.idleMin = 5 })).status).toBe(200)
    expect((await call(api, root, 'GET', '/api/auth/me')).status).toBe(200)
    await db.db.query('UPDATE sessions SET last_seen_at = $1 WHERE id = $2', [new Date(Date.now() - 6 * 60_000).toISOString(), root.id])
    expect((await call(api, root, 'GET', '/api/auth/me')).status).toBe(401)
  })

  it('keeps sign-in policy routes root-only and revision-bound', async () => {
    const api = app(), root = await session(api)
    const view = await (await call(api, root, 'GET', '/api/server/sec/sign-in')).json() as { revision: string; state: string }
    expect(view.state).toBe('default')
    const stale = await call(api, root, 'PUT', '/api/server/sec/sign-in', { expectedRevision: '0'.repeat(64), policy: defaultSignInPolicy() })
    expect(stale.status).toBe(409)
    expect((await api.fetch(new Request(ORIGIN + '/api/server/sec/sign-in'))).status).toBe(401)
  })
})
