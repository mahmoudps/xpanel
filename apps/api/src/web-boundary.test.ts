import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tools } from '@xpanel/catalog'
import {
  createApiToken, createRootPrincipal, createSession, createTestDb, createUserPrincipal, setTotpSecret,
} from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { SESSION_COOKIE_NAME, sha256Hex } from './auth.ts'
import { createDefaultWebRenderer } from './main.ts'

const hydration = vi.hoisted(() => [] as Record<string, unknown>[])
vi.mock('../../web/src/index.ts', async (importOriginal) => {
  const web = await importOriginal<typeof import('../../web/src/index.ts')>()
  return {
    ...web,
    serveWebUi: async (req: Request, provider?: () => Promise<Record<string, unknown>>) => {
      if (!provider) return web.serveWebUi(req)
      const state = await provider()
      hydration.push(state)
      return web.serveWebUi(req, () => state as unknown as import('../../web/src/app.ts').WebAppRenderState)
    },
  }
})

const PUBLIC_VECTOR = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SERVER_SECRET = 'web-boundary-fixture-secret-for-tests-only'
const observations: Record<string, unknown>[] = []
const future = () => new Date(Date.now() + 60_000).toISOString()
const protectedPaths = ['/', '/whm', '/panel', '/mail', '/home', '/resources', '/files/manager', '/panel/files/manager', '/whm/accounts', '/mail/inbox']

afterAll(async () => {
  const path = process.env.XPANEL_WEB_BOUNDARY_EVIDENCE
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  const source = await readFile(new URL('./main.ts', import.meta.url))
  await writeFile(path, `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    proof: 'In-process production HTML renderer with real SQLite session authentication and an isolated state store; no host services or browser execution.',
    nodeVersion: process.version,
    mainSha256: createHash('sha256').update(source).digest('hex'),
    verifiedCatalogTools: tools.filter(tool => tool.status === 'verified' && tool.delivery.status === 'verified').length,
    observations,
  }, null, 2)}\n`)
})

describe('production web renderer boundary regressions', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle
  let snapshotReads: number

  beforeEach(async () => {
    db = await createTestDb()
    state = await createTestStateStore()
    snapshotReads = 0
    hydration.length = 0
    const readSnapshot = state.store.readSnapshot.bind(state.store)
    state.store.readSnapshot = async () => { snapshotReads++; return readSnapshot() }
  })

  afterEach(async () => { await state.close(); await db.close() })

  const renderer = () => createDefaultWebRenderer({ store: state.store, db: db.db, serverSecret: SERVER_SECRET })
  const request = (path: string, cookie?: string, authorization?: string) => new Request(`http://localhost${path}`, {
    headers: { ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}) },
  })
  const session = async (principalId: string, mfaVerified = true) => {
    const token = 'web-boundary-session-fixture'
    await createSession(db.db, { principalId, tokenHash: sha256Hex(token), expiresAt: future(), mfaVerified })
    return `${SESSION_COOKIE_NAME}=${token}`
  }
  const root = async (opts: { enrolled?: boolean; forcePasswordChange?: boolean } = {}) => {
    const principal = await createRootPrincipal(db.db, { username: 'root', passwordHash: PUBLIC_VECTOR, forcePasswordChange: opts.forcePasswordChange ?? false })
    if (opts.enrolled !== false) await setTotpSecret(db.db, principal.id, new Uint8Array(32))
    return principal
  }
  const observe = async (id: string, response: Response, expectedStatus: number, expectedLocation?: string) => {
    const html = await response.text()
    const observation = {
      id,
      status: response.status,
      location: response.headers.get('location'),
      expectedStatus,
      ...(expectedLocation ? { expectedLocation } : {}),
      statusPassed: response.status === expectedStatus,
      ...(expectedLocation ? { locationPassed: response.headers.get('location') === expectedLocation } : {}),
      snapshotReads,
      unavailableWorkspace: html.includes('data-tool-availability="unverified"'),
      sampleDataPresent: /alice-shop\.com|srv1\.xpanel\.test/.test(html),
    }
    observations.push(observation)
    expect.soft(response.status, id).toBe(expectedStatus)
    if (expectedLocation) expect.soft(response.headers.get('location'), id).toBe(expectedLocation)
    return html
  }

  it('redirects anonymous surface requests without reading hosting state', async () => {
    const render = await renderer()
    for (const path of protectedPaths) {
      await observe(`anonymous:${path}`, await render(request(path)), 303, '/login')
    }
    expect(snapshotReads).toBe(0)
  })

  it('rejects forged UI cookies, including substring matches', async () => {
    const render = await renderer()
    for (const cookie of ['xpanel_ui_session=1', 'unrelated=xpanel_ui_session=1']) {
      for (const path of protectedPaths) {
        await observe(`forged-ui-cookie:${cookie.startsWith('unrelated') ? 'substring' : 'exact'}:${path}`, await render(request(path, cookie)), 303, '/login')
      }
    }
    expect(snapshotReads).toBe(0)
  })

  it('does not publish prototype boards or their runtime from the production renderer', async () => {
    const render = await renderer()
    for (const path of ['/reference-a.dc.html', '/reference-b.dc.html', '/reference-c.dc.html', '/reference-d.dc.html', '/support.js', '/assets/support.js']) {
      await observe(`prototype:${path}`, await render(request(path)), 404)
    }
    expect(snapshotReads).toBe(0)
  })

  it('refuses an account owner on the administrative surface before reading state', async () => {
    const principal = await createUserPrincipal(db.db, { username: 'owner', passwordHash: PUBLIC_VECTOR, accountId: '10000000-0000-4000-8000-000000000001' })
    const render = await renderer()
    const cookie = await session(principal.id)
    for (const path of ['/whm', '/whm/accounts']) {
      await observe(`owner-crosses-whm:${path}`, await render(request(path, cookie)), 403)
    }
    expect(snapshotReads).toBe(0)
  })

  it('requires a real active account for account owners', async () => {
    const principal = await createUserPrincipal(db.db, { username: 'owner', passwordHash: PUBLIC_VECTOR, accountId: '10000000-0000-4000-8000-000000000001' })
    const cookie = await session(principal.id)
    const render = await renderer()
    for (const path of ['/panel', '/mail']) await observe(`missing-owner-account:${path}`, await render(request(path, cookie)), 403)
  })

  it.each(['mfa-pending', 'password-change', 'revoked', 'api-token'] as const)('requires a completed interactive session: %s', async (condition) => {
    const principal = await root({ forcePasswordChange: condition === 'password-change' })
    let cookie = 'xpanel_ui_session=1'
    let authorization: string | undefined
    if (condition === 'api-token') {
      const token = 'web-boundary-api-token-fixture'
      await createApiToken(db.db, { principalId: principal.id, name: 'Web boundary fixture', tokenHash: sha256Hex(token), scopes: ['*'], expiresAt: future() })
      authorization = `Bearer ${token}`
    } else {
      cookie = `${await session(principal.id, condition !== 'mfa-pending')}; ${cookie}`
      if (condition === 'revoked') await db.db.query('UPDATE sessions SET revoked_at = $1 WHERE principal_id = $2', [new Date().toISOString(), principal.id])
    }
    const render = await renderer()
    await observe(`interactive-session:${condition}`, await render(request('/whm', cookie, authorization)), 303, '/login')
    expect(snapshotReads).toBe(0)
  })

  it('requires root MFA enrollment before administrative HTML', async () => {
    const principal = await root({ enrolled: false })
    const render = await renderer()
    const cookie = await session(principal.id)
    for (const path of ['/whm', '/whm/accounts']) {
      await observe(`root-mfa-unenrolled:${path}`, await render(request(path, cookie)), 403)
    }
    expect(snapshotReads).toBe(0)
  })

  it('preserves the real catalog qualification state', async () => {
    const principal = await root()
    const cookie = await session(principal.id)
    const render = await renderer()
    expect(tools.some(tool => tool.status === 'verified' && tool.delivery.status === 'verified')).toBe(false)
    for (const path of ['/whm', '/whm/accounts']) {
      const html = await observe(`unverified-catalog:${path}`, await render(request(path, cookie)), 200)
      expect.soft(html.includes('data-tool-availability="unverified"')).toBe(true)
      expect.soft(/alice-shop\.com|srv1\.xpanel\.test/.test(html)).toBe(false)
    }
  })

  it('hydrates true empty collections and principal without sample identities', async () => {
    const principal = await root()
    const cookie = await session(principal.id)
    const render = await renderer()
    for (const path of ['/whm/accounts', '/panel/files/manager', '/mail/inbox']) {
      await observe(`empty-state:${path}`, await render(request(path, cookie)), 200)
      const supplied = hydration.at(-1)
      expect(supplied).toBeDefined()
      const whm = supplied!.whm as Record<string, unknown>
      const panel = supplied!.panel as Record<string, unknown>
      const mail = supplied!.mail as Record<string, unknown>
      const visibility = supplied!.visibility as { principal: { kind: string } }
      observations.push({
        id: `hydration:${path}`,
        visibilityPrincipalKind: visibility.principal.kind,
        catalogOverridden: supplied!.catalog !== undefined,
        whmEmptyCollections: ['accounts', 'plans', 'resellers', 'ipPool', 'firewallRules'].filter(key => Array.isArray(whm[key]) && (whm[key] as unknown[]).length === 0),
        panelEmptyCollections: ['domains', 'databases', 'serviceUsers', 'files'].filter(key => Array.isArray(panel[key]) && (panel[key] as unknown[]).length === 0),
        mailEmptyCollections: ['messages', 'sieveRules'].filter(key => Array.isArray(mail[key]) && (mail[key] as unknown[]).length === 0),
        accountSupplied: panel.account !== undefined,
        planSupplied: panel.plan !== undefined,
      })
      expect.soft(visibility.principal.kind).toBe('root')
      expect.soft(supplied!.catalog !== undefined).toBe(false)
      expect.soft(whm).toMatchObject({ accounts: [], plans: [], resellers: [], ipPool: [], firewallRules: [] })
      expect.soft(panel).toMatchObject({ domains: [], databases: [], serviceUsers: [], files: [] })
      expect.soft(panel.account).toBeUndefined()
      expect.soft(panel.plan).toBeUndefined()
      expect.soft(mail).toMatchObject({ mailbox: '', domain: '', messages: [], sieveRules: [], quotaUsedMb: 0 })
    }
  })
})
