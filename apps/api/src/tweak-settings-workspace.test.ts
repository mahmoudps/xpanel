import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SETTINGS_INDEX, suggestServerSettings, TWEAKS } from '@xpanel/core'
import { createRootPrincipal, createTestDb } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { alertStateFiles } from './alert-runtime.ts'
import { hashPasswordArgon2id } from './auth.ts'
import { createApiApp } from './server.ts'

const SERVER_SECRET = 'tweak-settings-synthetic-server-secret-at-least-32-bytes'
const ORIGIN = 'https://panel.example.test'
const PASSWORD = 'SyntheticRootPassword!2026'
let passwordHash: string
beforeAll(async () => { passwordHash = await hashPasswordArgon2id(PASSWORD) })

describe('settings index', { tags: ['unit'] }, () => {
  it('lists every tweak and each other setting once, each with its source page', () => {
    const keys = SETTINGS_INDEX.map(entry => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const tweak of TWEAKS) expect(SETTINGS_INDEX).toContainEqual(expect.objectContaining({ key: tweak.key, source: 'tweak', page: tweak.consumer }))
    for (const entry of SETTINGS_INDEX) expect(entry.page).toMatch(/^\/whm\//)
  })
})

describe('Tweak Settings and the Advanced Settings Browser', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle
  beforeEach(async () => { db = await createTestDb(); state = await createTestStateStore(); await createRootPrincipal(db.db, { username: 'root', passwordHash, forcePasswordChange: false }) })
  afterEach(async () => { await state.close(); await db.close() })

  const session = async () => {
    const api = createApiApp({ db: db.db, store: state.store, serverSecret: SERVER_SECRET, allowedOrigins: [ORIGIN] })
    const login = await api.fetch(new Request(ORIGIN + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ username: 'root', password: PASSWORD }) }))
    const { csrfToken } = await login.json() as { csrfToken: string }
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    return (method: string, path: string, body?: unknown) => api.fetch(new Request(ORIGIN + path, {
      method, headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrfToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))
  }

  it('saves a value inside its definition, refuses others and feeds the alert schedule', async () => {
    const call = await session()
    const initial = await (await call('GET', '/api/server/tweak-settings')).json() as { state: string; revision: string; values: Record<string, unknown> }
    expect(initial).toMatchObject({ state: 'default', values: { 'server.healthCheckMinutes': 5 } })
    for (const values of [{ 'server.healthCheckMinutes': 0 }, { 'server.healthCheckMinutes': 2.5 }, { 'server.unknown': 1 }]) {
      const refused = await call('PUT', '/api/server/tweak-settings', { expectedRevision: initial.revision, values })
      expect(refused.status).toBe(422)
      expect(await refused.json()).toMatchObject({ code: 'VALIDATION', details: { stateChanged: false } })
    }
    const saved = await call('PUT', '/api/server/tweak-settings', { expectedRevision: initial.revision, values: { 'server.healthCheckMinutes': 30 } })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ state: 'saved', values: { 'server.healthCheckMinutes': 30 } })
    expect((await call('PUT', '/api/server/tweak-settings', { expectedRevision: initial.revision, values: {} })).status).toBe(409)
    expect(await alertStateFiles(state.store).readEveryMinutes()).toBe(30)
  })

  it('reads every indexed setting from its own store', async () => {
    const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
    await state.store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk',
      panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
    const call = await session()
    const { values } = await (await call('GET', '/api/server/settings-index')).json() as { values: Record<string, unknown> }
    expect(Object.keys(values).sort()).toEqual(SETTINGS_INDEX.map(entry => entry.key).sort())
    expect(values).toMatchObject({ 'server.healthCheckMinutes': 5, hostname: 'srv1.example.com', 'apache.serverLimit': suggested.apache.serverLimit,
      'web.gzip.level': 1, 'web.directoryIndex': ['index.php', 'index.html', 'index.htm'], 'lockout.username.attempts': 5, 'passwordStrength.perService.mail': null, 'session.idleMin': 30 })
  })
})
