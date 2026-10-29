import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { ENTRY_POINTS } from './entry-points.ts'
import { createApiApp } from './server.ts'
import { SEC_PANEL_ACCESS_STATE } from '../../agent/src/sec-policy.ts'

const SECRET = 'sec-panel-gate-fixture-secret-32-bytes-minimum'
const origin = `https://panel.example.test:${ENTRY_POINTS.xwhm.port}`
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

describe('sec panel-access gate in the API request pipeline', () => {
  it('refuses addresses outside the saved xWHM allowlist before sign-in, with a 403 page for documents', async () => {
    const database = await createTestDb(), state = await createTestStateStore()
    cleanup.push(() => database.close(), () => state.close())
    const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, entryPoint: 'xwhm', publicOrigin: origin, allowedOrigins: [origin] })
    const get = (path: string, remoteAddress: string, accept = 'application/json') => app.fetch(new Request(origin + path, { headers: { accept } }), { remoteAddress })
    expect((await get('/api/auth/me', '198.51.100.1')).status).not.toBe(403)
    await mkdir(join(state.store.rootDir, 'extended', 'server'), { recursive: true })
    await writeFile(join(state.store.rootDir, SEC_PANEL_ACCESS_STATE), JSON.stringify({ version: 1, policy: { listeners: { xpanel: [], xwhm: [{ cidr: '203.0.113.0/24', note: 'office' }], xmail: [] } }, updatedAt: '2026-10-28T12:00:00.000Z' }))
    const denied = await get('/api/auth/me', '198.51.100.1')
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: 'FORBIDDEN', detail: 'this address is not allowed on this entry point' })
    const page = await get('/login', '198.51.100.1', 'text/html')
    expect(page.status).toBe(403)
    expect(await page.text()).toContain('data-status-page="403"')
    expect((await get('/api/auth/me', '203.0.113.7')).status).not.toBe(403)
    expect((await get('/api/health', '198.51.100.1')).status).toBe(200)
  })
})
