import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'vitest'
import type { AgentApp } from '@xpanel/agent'
import { tools } from '@xpanel/catalog'
import { createRootPrincipal, createTestDb, setTotpSecret } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { hashPasswordArgon2id, parseCookies, sealTotpSecret, sha256Hex } from './auth.ts'
import { resetQualifiedCatalogCache } from './host-catalog.ts'
import { createApiApp } from './server.ts'
import type { ApiApp } from './server.ts'
import { TEST_SERVER_SECRET } from './testing.ts'

const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
const RECOVERIES = [
  'catalog-recovery-code-one-128-bits-at-least',
  'catalog-recovery-code-two-128-bits-at-least',
]
let recoveryIndex = 0

const healthAgent = (body: unknown): AgentApp => ({
  fetch: async (request) => {
    if (new URL(request.url).pathname !== '/health') return new Response('missing', { status: 404 })
    return Response.json(body)
  },
  subscribe: () => () => undefined,
})

describe('GET /api/catalog', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle

  beforeEach(async () => {
    resetQualifiedCatalogCache()
    db = await createTestDb()
    state = await createTestStateStore()
    recoveryIndex = 0
    const root = await createRootPrincipal(db.db, {
      username: 'root',
      passwordHash: await hashPasswordArgon2id('RootPassword!2026'),
      forcePasswordChange: false,
    })
    await setTotpSecret(db.db, root.id, sealTotpSecret(TOTP_SECRET, TEST_SERVER_SECRET), RECOVERIES.map(code => sha256Hex(code)))
  })

  afterEach(async () => {
    resetQualifiedCatalogCache()
    await state.close()
    await db.close()
  })

  const open = (agent: AgentApp | undefined, token = 'b'.repeat(64)): ApiApp => createApiApp({
    db: db.db,
    store: state.store,
    serverSecret: TEST_SERVER_SECRET,
    ...(agent ? { agentApp: agent, agentToken: token } : {}),
  })

  const catalog = async (app: ApiApp): Promise<{ tools: { id: string; status: string }[]; navigation: { sections: { pages: { route: string }[] }[] }[] }> => {
    const login = await app.fetch(new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPassword!2026', recoveryCode: RECOVERIES[recoveryIndex++] }),
    }), { remoteAddress: '192.0.2.40' })
    assert.equal(login.status, 200)
    const setCookie = login.headers.get('set-cookie')
    const cookie = parseCookies(setCookie
      ? setCookie.split(',').map(part => part.split(';')[0]?.trim()).filter(Boolean).join('; ')
      : null)
    const cookieHeader = Object.entries(cookie).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ')
    const response = await app.fetch(new Request('http://localhost/api/catalog', {
      headers: { cookie: cookieHeader },
    }), { remoteAddress: '192.0.2.40' })
    assert.equal(response.status, 200)
    return response.json() as Promise<{ tools: { id: string; status: string }[]; navigation: { sections: { pages: { route: string }[] }[] }[] }>
  }

  it('returns the same host-qualified catalog the sidebar uses', async () => {
    assert.equal(tools.some(tool => tool.status === 'verified'), false)
    const body = await catalog(open(healthAgent({
      executor: 'linux',
      probes: {
        'linux-account': 'passed',
        apache: 'failed',
        mariadb: 'failed',
        mail: 'failed',
        files: 'failed',
        acme: 'failed',
      },
    })))
    const ids = new Set(body.tools.map(tool => tool.id))
    assert.equal(body.tools.every(tool => tool.status === 'verified'), true)
    assert.equal(ids.has('list-accounts'), true)
    assert.equal(ids.has('terminate-accounts'), true)
    assert.equal(ids.has('file-manager'), false)
    assert.equal(ids.has('create-account'), false)
    const routes = body.navigation.flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))
    assert.equal(routes.includes('/whm/accounts'), true)
    assert.equal(routes.includes('/files/manager'), false)
  })

  it('stays unqualified for a fake executor and for a disconnected agent', async () => {
    const fake = await catalog(open(healthAgent({ executor: 'fake', probes: { apache: 'passed', 'linux-account': 'passed' } }), 'c'.repeat(64)))
    assert.deepEqual(fake.tools, [])
    assert.deepEqual(fake.navigation, [])
    const missing = await catalog(open(undefined, 'd'.repeat(64)))
    assert.deepEqual(missing.tools, [])
    assert.deepEqual(missing.navigation, [])
  })
})
