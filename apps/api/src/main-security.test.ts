import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createResellerPrincipal, createRootPrincipal, createSession, createTestDb, setTotpSecret } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { SESSION_COOKIE_NAME, sha256Hex } from './auth.ts'
import { createDefaultWebRenderer } from './main.ts'

const PUBLIC_VECTOR = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SERVER_SECRET = 'main-security-fixture-secret-for-tests-only'

describe('production HTML authentication boundary', () => {
  let handle: TestDbHandle
  let state: TestStateStoreHandle

  beforeEach(async () => {
    handle = await createTestDb()
    state = await createTestStateStore()
  })

  afterEach(async () => {
    await handle.close()
    await state.close()
  })

  it.each(['/whm', '/panel', '/mail', '/login?surface=xwhm'])('does not read hosting state for anonymous %s', async (path) => {
    let reads = 0
    const original = state.store.readSnapshot.bind(state.store)
    state.store.readSnapshot = async () => { reads++; return original() }
    const render = await createDefaultWebRenderer({ store: state.store, db: handle.db, serverSecret: SERVER_SECRET })
    const response = await render(new Request(`http://localhost${path}`))
    expect(reads).toBe(0)
    if (path.startsWith('/login')) {
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('data-surface="login"')
    } else {
      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/login')
    }
  })

  it('renders the authenticated root surface and refuses a revoked session', async () => {
    const root = await createRootPrincipal(handle.db, { username: 'root', passwordHash: PUBLIC_VECTOR, forcePasswordChange: false })
    await setTotpSecret(handle.db, root.id, new Uint8Array(32))
    const rawToken = 'html-session-fixture'
    const session = await createSession(handle.db, { principalId: root.id, tokenHash: sha256Hex(rawToken), expiresAt: new Date(Date.now() + 60_000).toISOString(), mfaVerified: true })
    const render = await createDefaultWebRenderer({ store: state.store, db: handle.db, serverSecret: SERVER_SECRET })
    const request = () => new Request('http://localhost/whm', { headers: { cookie: `${SESSION_COOKIE_NAME}=${rawToken}` } })
    const response = await render(request())
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('data-surface="xwhm"')
    await handle.db.query('UPDATE sessions SET revoked_at = $1 WHERE id = $2', [new Date().toISOString(), session.id])
    expect((await render(request())).status).toBe(303)
  })

  it('redirects a forced password change before reading hosting state', async () => {
    const root = await createRootPrincipal(handle.db, { username: 'root', passwordHash: PUBLIC_VECTOR })
    await setTotpSecret(handle.db, root.id, new Uint8Array(32))
    const token = 'forced-change-html-session'
    await createSession(handle.db, { principalId: root.id, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 60_000).toISOString(), mfaVerified: true })
    let reads = 0
    const original = state.store.readSnapshot.bind(state.store)
    state.store.readSnapshot = async () => { reads++; return original() }
    const render = await createDefaultWebRenderer({ store: state.store, db: handle.db, serverSecret: SERVER_SECRET })
    const response = await render(new Request('http://localhost/whm', { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/login')
    expect(reads).toBe(0)
  })

  it('checks reseller HTML privileges before hydrating a hosting snapshot', async () => {
    const principal = await createResellerPrincipal(handle.db, { username: 'reseller', passwordHash: PUBLIC_VECTOR })
    const token = 'unprivileged-reseller-html-session'
    await createSession(handle.db, { principalId: principal.id, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 60_000).toISOString(), mfaVerified: true })
    state.store.getReseller = async () => ({ id: principal.id, username: 'reseller', acl: [], maxAccounts: 'unlimited', totalDiskMb: 'unlimited', totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [] })
    let reads = 0
    const original = state.store.readSnapshot.bind(state.store)
    state.store.readSnapshot = async () => { reads++; return original() }
    const render = await createDefaultWebRenderer({ store: state.store, db: handle.db, serverSecret: SERVER_SECRET })
    const response = await render(new Request('http://localhost/panel', { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }))
    expect(response.status).toBe(403)
    expect(reads).toBe(0)
  })
})
