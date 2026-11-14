import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { createDb, createResellerPrincipal, createRootPrincipal, createTestDb, createUserPrincipal, getPrincipal, listSessionsForPrincipal, setPasswordHash, setTotpSecret } from '@xpanel/db'
import { createStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { authenticateRequest, hashPasswordArgon2id, sealTotpSecret, sha256Hex } from './auth.ts'
import { createApiApp, listenApiServer } from './server.ts'
import { createDefaultWebRenderer } from './main.ts'
import WebSocket from 'ws'
import { writeSignInLockout } from './testing/sign-in-policy-fixture.ts'

const SERVER_SECRET = 'development-policy-synthetic-server-secret-at-least-32-bytes'
const PASSWORD = 'SyntheticDevelopmentPassword!'
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
const ORIGIN = 'http://localhost'
const MFA_TMP = existsSync('/dev/shm') ? '/dev/shm' : tmpdir()
let passwordHash: string
let emptyDbSqlite: Uint8Array
let userDbSqlite: Uint8Array
let userStateFiles: { relPath: string; bytes: Buffer }[]
let userBaselinePrincipal: Awaited<ReturnType<typeof createUserPrincipal>>

async function snapshotDir(rootDir: string, mutexFilePath: string, lockDirPath: string) {
  const out: { relPath: string; bytes: Buffer }[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (full === mutexFilePath || full.startsWith(mutexFilePath + '-') || full === lockDirPath || full.startsWith(lockDirPath + sep)) continue
      if (entry.isDirectory()) await walk(full)
      else out.push({ relPath: relative(rootDir, full), bytes: await readFile(full) })
    }
  }
  await walk(rootDir)
  return out
}

async function restoreDir(rootDir: string, files: readonly { relPath: string; bytes: Buffer }[]) {
  const dirs = new Set(files.map(file => dirname(join(rootDir, file.relPath))))
  for (const dir of dirs) await mkdir(dir, { recursive: true, mode: 0o750 })
  await Promise.all(files.map(file => writeFile(join(rootDir, file.relPath), file.bytes, { mode: 0o640 })))
}

beforeAll(async () => {
  passwordHash = await hashPasswordArgon2id(PASSWORD, { timeCost: 1, parallelism: 1 })
  const baseDb = await createTestDb()
  try { emptyDbSqlite = baseDb.sqlite.serialize() } finally { await baseDb.close() }
  const userDb = createDb(':memory:')
  userDb.sqlite.deserialize(emptyDbSqlite)
  const userDir = await mkdtemp(join(MFA_TMP, 'xpanel-mfa-user-'))
  const userStore = createStateStore(userDir)
  try {
    await writeSignInLockout(userDir, 2)
    const features = await userStore.createFeatureList({ name: 'Synthetic features', ownerId: null, disabled: [] })
    const plan = await userStore.createPlan({ name: 'Synthetic plan', ownerId: null, featureListId: features.id, resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }, caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
    await userStore.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const account = await userStore.createAccount({ username: 'owner', passwordHash, primaryDomain: 'owner.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.10', shell: 'none', php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
    userBaselinePrincipal = await createUserPrincipal(userDb.db, { username: 'owner', accountId: account.id, passwordHash })
    userDbSqlite = userDb.sqlite.serialize()
    const lock = userStore.getWriterLock()
    userStateFiles = await snapshotDir(userDir, lock.mutexFilePath, lock.lockDirPath)
  } finally {
    await userDb.close()
    await rm(userDir, { recursive: true, force: true })
  }
  const warmDb = createDb(':memory:')
  warmDb.sqlite.deserialize(userDbSqlite)
  const warmDir = await mkdtemp(join(MFA_TMP, 'xpanel-mfa-warm-'))
  const warmStore = createStateStore(warmDir)
  try {
    await restoreDir(warmDir, userStateFiles)
    const root = await createRootPrincipal(warmDb.db, { username: 'root', passwordHash, forcePasswordChange: false })
    const warmApi = createApiApp({ db: warmDb.db, store: warmStore, serverSecret: SERVER_SECRET, allowedOrigins: [ORIGIN] })
    const warmRenderer = await createDefaultWebRenderer({ db: warmDb.db, store: warmStore, serverSecret: SERVER_SECRET })
    for (const [u, p] of [['root', '/whm/security/sign-in'], ['owner', '/security/account']] as const) {
      const r = await warmApi.fetch(new Request(ORIGIN + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: PASSWORD }) }))
      const c = r.headers.get('set-cookie')!.split(';')[0]!
      await warmRenderer(new Request(ORIGIN + p, { headers: { cookie: c } }))
      void root
    }
  } finally {
    await warmDb.close()
    await rm(warmDir, { recursive: true, force: true })
  }
})

describe('trusted development MFA runtime policy', () => {
  let db: ReturnType<typeof createDb>
  let state: TestStateStoreHandle
  beforeEach(async () => {
    db = createDb(':memory:')
    db.sqlite.deserialize(emptyDbSqlite)
    const rootDir = await mkdtemp(join(MFA_TMP, 'xpanel-mfa-'))
    state = { store: createStateStore(rootDir), rootDir, close: () => rm(rootDir, { recursive: true, force: true }) }
    await writeSignInLockout(state.store.rootDir, 2)
  })
  afterEach(async () => { vi.unstubAllEnvs(); await state.close(); await db.close() })

  const app = () => createApiApp({ db: db.db, store: state.store, serverSecret: SERVER_SECRET, allowedOrigins: [ORIGIN] })
  const login = (api: ReturnType<typeof app>, username: string, extra: Record<string, unknown> = {}) => api.fetch(new Request(ORIGIN + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD, ...extra }),
  }))
  const actor = async (kind: 'root' | 'reseller' | 'user', enrolled: boolean, corrupt = false) => {
    const username = kind === 'root' ? 'root' : kind === 'reseller' ? 'reseller' : 'owner'
    let principal
    if (kind === 'root') principal = await createRootPrincipal(db.db, { username, passwordHash, forcePasswordChange: false })
    else if (kind === 'reseller') {
      const reseller = await state.store.createReseller({ username, passwordHash, acl: ['list-accounts'], maxAccounts: 10, totalDiskMb: 1000, totalBandwidthMb: 'unlimited', oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [] })
      principal = await createResellerPrincipal(db.db, { id: reseller.id, username, passwordHash })
    } else {
      db.sqlite.deserialize(userDbSqlite)
      await restoreDir(state.rootDir, userStateFiles)
      principal = userBaselinePrincipal
    }
    if (enrolled) await setTotpSecret(db.db, principal.id, corrupt ? new Uint8Array(64) : sealTotpSecret(SECRET, SERVER_SECRET), [sha256Hex('unused-fixture-recovery')])
    return principal
  }
  const sessionRequest = (api: ReturnType<typeof app>, cookie: string, path: string, csrf?: string, body?: unknown) => api.fetch(new Request(ORIGIN + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))
  const upgrade = (api: ReturnType<typeof app>, cookie: string) => api.authenticateUpgrade({ url: '/api/ws', headers: { cookie, origin: ORIGIN, host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } } as Parameters<typeof api.authenticateUpgrade>[0])

  it('skips an enrolled factor only in development and preserves its persistent state', async () => {
    const principal = await createRootPrincipal(db.db, { username: 'root', passwordHash, forcePasswordChange: false })
    await setTotpSecret(db.db, principal.id, sealTotpSecret(SECRET, SERVER_SECRET), [sha256Hex('unused-fixture-recovery')])
    const before = await getPrincipal(db.db, principal.id)
    vi.stubEnv('NODE_ENV', 'development')
    const api = app()
    const response = await login(api, 'root', { recoveryCode: 'unused-fixture-recovery' })
    expect(response.status).toBe(200)
    const result = await response.json() as { mfaMode: string; session: { mfaVerified: boolean }; csrfToken: string }
    expect(result).toMatchObject({ mfaMode: 'disabled', session: { mfaVerified: false }, mfaEnrollmentRequired: false })
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    const session = (await listSessionsForPrincipal(db.db, principal.id))[0]!
    expect(session.mfaVerified).toBe(false)
    expect(await getPrincipal(db.db, principal.id)).toMatchObject({ totpEnabled: before!.totpEnabled, totpSecretEnc: before!.totpSecretEnc, totpRecoveryHashes: before!.totpRecoveryHashes, totpLastStep: before!.totpLastStep })
    expect((await authenticateRequest(db.db, new Request(ORIGIN, { headers: { cookie } }), { serverSecret: SERVER_SECRET }))!.mfaVerified).toBe(false)
    await expect(authenticateRequest(db.db, new Request(ORIGIN, { headers: { cookie } }), { serverSecret: SERVER_SECRET, mfaRuntimePolicy: { mode: 'disabled' } })).rejects.toThrow('trusted process')
    // A running listener keeps its policy even if the surrounding process changes.
    vi.stubEnv('NODE_ENV', 'production')
    const request = () => new Request(ORIGIN + '/api/events/recent', { headers: { cookie } })
    expect((await api.fetch(request())).status).toBe(200)
    const production = app()
    expect((await production.fetch(request())).status).toBe(403)
  })

  it.each(['root', 'reseller', 'user'] as const)('keeps %s password sessions and REST/HTML/WS consistent for configured and unconfigured factors', async kind => {
    const principal = await actor(kind, false)
    vi.stubEnv('NODE_ENV', 'development')
    const devRenderer = await createDefaultWebRenderer({ db: db.db, store: state.store, serverSecret: SERVER_SECRET })
    for (const enrolled of [false, true]) {
      if (enrolled) {
        await setTotpSecret(db.db, principal.id, new Uint8Array(64), [sha256Hex('unused-fixture-recovery')])
      }
      const before = await getPrincipal(db.db, principal.id)
      vi.stubEnv('NODE_ENV', 'development')
      const api = app()
      const response = await login(api, principal.username)
      expect(response.status).toBe(200)
      const result = await response.json() as { mfaMode: string; csrfToken: string }
      expect(result).toMatchObject({ mfaMode: 'disabled', session: { mfaVerified: false }, totpEnabled: enrolled })
      const cookie = response.headers.get('set-cookie')!.split(';')[0]!
      expect((await sessionRequest(api, cookie, '/api/events/recent')).status).toBe(200)
      expect(await upgrade(api, cookie)).not.toBeNull()
      const path = kind === 'user' ? '/security/account' : '/whm/security/sign-in'
      const document = await devRenderer(new Request(ORIGIN + path, { headers: { cookie } }))
      expect(document.status).toBe(200)
      const html = await document.text()
      expect(html).toContain('data-mfa-mode="disabled"')
      expect(html).toContain(`data-mfa-configured="${enrolled}"`)
      expect(html).not.toMatch(/<form[^>]*(?:data-auth-setup-form|data-auth-enroll-form)|<[^>]+data-mfa-(?:recommendation|enabled="true")/)
      for (const endpoint of ['setup', 'enable', 'disable']) {
        const denied = await sessionRequest(api, cookie, '/api/auth/2fa/' + endpoint, result.csrfToken, { password: PASSWORD, code: '123456', recoveryCode: 'unused-fixture-recovery' })
        expect(denied.status).toBe(403)
        expect((await denied.json() as { detail: string }).detail).toBe('two-factor changes are disabled in development')
      }
      const noCsrf = await sessionRequest(api, cookie, '/api/auth/2fa/setup', undefined, { password: PASSWORD })
      expect(noCsrf.status).toBe(403)
      expect((await noCsrf.json() as { detail: string }).detail).not.toBe('two-factor changes are disabled in development')
      expect(await getPrincipal(db.db, principal.id)).toMatchObject({ totpEnabled: before!.totpEnabled, totpSecretEnc: before!.totpSecretEnc, totpRecoveryHashes: before!.totpRecoveryHashes, totpLastStep: before!.totpLastStep })
      vi.stubEnv('NODE_ENV', 'production')
      expect((await sessionRequest(app(), cookie, '/api/events/recent')).status).toBe(enrolled ? 403 : 200)
      if (enrolled) {
        expect(await upgrade(app(), cookie)).toBeNull()
        const productionHtml = await createDefaultWebRenderer({ db: db.db, store: state.store, serverSecret: SERVER_SECRET })
        expect((await productionHtml(new Request(ORIGIN + path, { headers: { cookie } }))).status).toBe(303)
      }
    }
  })

  it.each(['development', 'production'] as const)('opens only a no-ACL reseller own security state under captured %s policy', async environment => {
    const principal = await actor('reseller', false)
    await state.store.updateReseller(principal.id, { acl: [] })
    const before = await getPrincipal(db.db, principal.id)
    vi.stubEnv('NODE_ENV', environment)
    const api = app()
    const response = await login(api, principal.username)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ mfaMode: environment === 'development' ? 'disabled' : 'optional', mfaEnrollmentRequired: false, totpEnabled: false })
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    const renderer = await createDefaultWebRenderer({ db: db.db, store: state.store, serverSecret: SERVER_SECRET })
    const readSnapshot = vi.spyOn(state.store, 'readSnapshot')
    const readWorkspace = vi.spyOn(state.store, 'readAccountWorkspace')
    const getSettings = vi.spyOn(state.store, 'getServerSettings')
    // The document uses its startup capture, not a later process environment change.
    vi.stubEnv('NODE_ENV', environment === 'development' ? 'production' : 'development')
    const document = await renderer(new Request(ORIGIN + '/whm/security/sign-in?accountId=foreign-account-marker&principalId=foreign-actor-marker', { headers: { cookie } }))
    expect(document.status).toBe(200)
    const html = await document.text()
    expect(html).toContain(`data-mfa-mode="${environment === 'development' ? 'disabled' : 'optional'}"`)
    expect(html).toContain('data-account-security="two-factor"')
    expect(html).not.toMatch(/foreign-actor-marker|<[^>]+data-mfa-recommendation|Multi-factor enrollment is required/)
    expect(html).toContain('accountId=foreign-account-marker')
    expect(html.replace(/href="[^"]*"/g, '')).not.toContain('foreign-account-marker')
    if (environment === 'development') {
      expect(html).toContain('data-mfa-configured="false"')
      expect(html).not.toMatch(/<form[^>]*(?:data-auth-setup-form|data-auth-enroll-form)/)
    } else {
      expect(html).toContain('data-auth-state="optional"')
      expect(html).toMatch(/<form[^>]*data-auth-setup-form/)
    }
    expect((await sessionRequest(api, cookie, '/api/server/settings')).status).toBe(403)
    expect(readSnapshot).not.toHaveBeenCalled()
    expect(readWorkspace).not.toHaveBeenCalled()
    expect(getSettings).not.toHaveBeenCalled()
    expect(await getPrincipal(db.db, principal.id)).toMatchObject({ totpEnabled: before!.totpEnabled, totpSecretEnc: before!.totpSecretEnc, totpRecoveryHashes: before!.totpRecoveryHashes, totpLastStep: before!.totpLastStep })
  })

  it('does not bypass password lockout, forced password change or session expiry', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const principal = await actor('root', true, true)
    const api = app()
    expect((await login(api, 'root', { password: 'wrong-password' })).status).toBe(401)
    expect((await login(api, 'root', { password: 'wrong-password' })).status).toBe(429)
    expect((await login(api, 'root')).status).toBe(429)
    await db.db.query('DELETE FROM lockouts')
    await setPasswordHash(db.db, principal.id, passwordHash, { forceChange: true })
    const signedIn = await login(api, 'root')
    expect(signedIn.status).toBe(200)
    let cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!
    expect((await sessionRequest(api, cookie, '/api/events/recent')).status).toBe(403)
    await setPasswordHash(db.db, principal.id, passwordHash, { forceChange: false })
    cookie = (await login(api, 'root')).headers.get('set-cookie')!.split(';')[0]!
    await db.db.query('UPDATE sessions SET last_seen_at = $1 WHERE principal_id = $2', [new Date(Date.now() - 2 * 3600_000).toISOString(), principal.id])
    expect((await sessionRequest(api, cookie, '/api/events/recent')).status).toBe(401)
  })

  it('rejects disabled principals even when their factor is corrupt', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const principal = await actor('root', true, true)
    const api = app()
    const signedIn = await login(api, 'root')
    expect(signedIn.status).toBe(200)
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!
    await db.db.query('UPDATE principals SET disabled = 1 WHERE id = $1', [principal.id])
    expect((await sessionRequest(api, cookie, '/api/events/recent')).status).toBe(401)
    expect((await login(api, 'root')).status).toBe(401)
  })

  it('admits an actual development WebSocket and rejects the same enrolled session after restart in production', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    await actor('root', true, true)
    const api = app()
    const signedIn = await login(api, 'root')
    expect(signedIn.status).toBe(200)
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!
    const development = await listenApiServer(api, { port: 0, host: '127.0.0.1' })
    const socket = new WebSocket(`ws://127.0.0.1:${development.port}/api/ws`, { headers: { cookie }, origin: ORIGIN })
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
      expect(socket.readyState).toBe(WebSocket.OPEN)
    } finally { socket.terminate(); await development.close() }
    vi.stubEnv('NODE_ENV', 'production')
    const production = await listenApiServer(app(), { port: 0, host: '127.0.0.1' })
    const refused = new WebSocket(`ws://127.0.0.1:${production.port}/api/ws`, { headers: { cookie }, origin: ORIGIN })
    refused.on('error', () => {})
    try {
      const status = await new Promise<number>((resolve, reject) => { refused.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!) }); refused.once('open', () => reject(new Error('An unverified development session opened a production socket'))) })
      expect(status).toBe(401)
    } finally { refused.terminate(); await production.close() }
  })

  it.each(['production', '', 'staging', 'Development'])('ignores request and configuration bypass markers in %s', async environment => {
    const principal = await actor('root', true)
    vi.stubEnv('NODE_ENV', environment)
    vi.stubEnv('XPANEL_MFA_MODE', 'disabled')
    const api = app()
    const response = await api.fetch(new Request(ORIGIN + '/api/auth/login?mfa=disabled&NODE_ENV=development', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mfa-mode': 'disabled', 'x-node-env': 'development' }, body: JSON.stringify({ username: principal.username, password: PASSWORD, mfaMode: 'disabled', nodeEnv: 'development' }) }))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ details: { mfaRequired: true } })
    expect((await listSessionsForPrincipal(db.db, principal.id)).length).toBe(0)
    expect(() => createApiApp({ db: db.db, store: state.store, serverSecret: SERVER_SECRET, mfaRuntimePolicy: { mode: 'disabled' } })).toThrow('trusted process')
  })
})
