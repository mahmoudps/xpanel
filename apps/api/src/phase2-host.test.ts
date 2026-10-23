import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { PhpSettings } from '@xpanel/core'
import { createApiToken, createRootPrincipal, createTestDb, createUserPrincipal, setTotpSecret } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { AgentApp } from '@xpanel/agent'
import { sealTotpSecret } from './auth.ts'
import { createApiApp } from './server.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'

const SECRET = 'phase2-host-synthetic-server-secret-32-bytes'
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const php: PhpSettings = {
  version: '8.3', handler: 'fpm',
  fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 },
  ini: {},
}

describe('phase 2 host routes', () => {
  const cleanup: (() => Promise<unknown>)[] = []
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

  it('keeps server measurements on xWHM and account backups root-only', () => {
    for (const [method, path] of [['GET', '/api/server/info'], ['GET', '/api/server/services'], ['POST', '/api/server/services/apache/restart']] as const) {
      expect(entryPointAllowsApiRoute('xwhm', path, method)).toBe(true)
      expect(entryPointAllowsApiRoute('xpanel', path, method)).toBe(false)
      expect(entryPointAllowsApiRoute('xmail', path, method)).toBe(false)
    }
    expect(entryPointAllowsApiRoute('xwhm', '/api/backups/accounts/alice', 'POST')).toBe(true)
    expect(entryPointAllowsApiRoute('xmail', '/api/backups/accounts/alice', 'GET')).toBe(false)
  })

  it('refuses a user and proxies root to the agent', async () => {
    const database = await createTestDb()
    const state = await createTestStateStore()
    cleanup.push(() => database.close(), () => state.close())
    const features = await state.store.createFeatureList({ name: 'Phase 2', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({
      name: 'Phase 2 plan', ownerId: null, featureListId: features.id,
      resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
      caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 },
      dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
    })
    await state.store.saveServerIp({ address: '192.0.2.42', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const account = await state.store.createAccount({
      username: 'owner7', passwordHash: HASH, primaryDomain: 'owner7.example.test', planId: plan.id, ownerId: null,
      contactEmail: 'owner@example.test', ipv4: '192.0.2.42', shell: 'none', php,
    })
    const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
    await setTotpSecret(database.db, root.id, sealTotpSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', SECRET), [])
    const owner = await createUserPrincipal(database.db, { username: account.username, accountId: account.id, passwordHash: HASH })
    const tokenFor = async (principalId: string) => {
      const raw = `xp_${randomUUID()}`
      await createApiToken(database.db, { principalId, name: 'Phase 2', tokenHash: createHash('sha256').update(raw).digest('hex'), scopes: ['*'], expiresAt: new Date(Date.now() + 60000).toISOString() })
      return raw
    }
    const userToken = await tokenFor(owner.id)
    const rootToken = await tokenFor(root.id)
    const seen: { method: string; path: string; body: string | null }[] = []
    const agentApp: AgentApp = {
      subscribe: () => () => {},
      fetch: async request => {
        const path = new URL(request.url).pathname
        seen.push({ method: request.method, path, body: request.method === 'GET' ? null : await request.text() })
        if (path === '/host/services') return Response.json({ services: [{ id: 'apache', label: 'Apache', unit: 'apache2.service', state: 'active' }] })
        if (path === '/host/info') return Response.json({ load: { load1: 0.1, load5: 0.1, load15: 0.1 }, memory: { totalBytes: 1, availableBytes: 1 }, disk: { filesystem: '/dev/sda1', mount: '/', totalBytes: 1, usedBytes: 1, availableBytes: 1 } })
        return Response.json({ backup: { file: 'xpanel-backup-owner7-20261023T165300Z.tar.gz', bytes: 10 } }, { status: 201 })
      },
    }
    const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, agentApp, agentToken: 'a'.repeat(64) })
    const call = (token: string, method: string, path: string, body?: unknown) => app.fetch(new Request(`http://localhost${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }))
    for (const path of ['/api/server/info', '/api/server/services', '/api/backups/accounts/owner7']) {
      expect((await call(userToken, 'GET', path)).status, path).toBe(403)
    }
    expect(seen).toEqual([])
    expect((await call(rootToken, 'GET', '/api/backups/accounts/missing1')).status).toBe(404)
    expect(seen).toEqual([])
    const services = await call(rootToken, 'GET', '/api/server/services')
    expect(services.status).toBe(200)
    expect(await services.json()).toMatchObject({ services: [{ id: 'apache', state: 'active' }] })
    const info = await call(rootToken, 'GET', '/api/server/info')
    expect(info.status).toBe(200)
    const created = await call(rootToken, 'POST', '/api/backups/accounts/owner7', { op: 'create' })
    expect(created.status).toBe(201)
    expect(seen.map(entry => `${entry.method} ${entry.path}`)).toEqual([
      'GET /host/services',
      'GET /host/info',
      'POST /accounts/owner7/backups',
    ])
    expect(seen[2]?.body).toBe(JSON.stringify({ op: 'create' }))
  })
})
