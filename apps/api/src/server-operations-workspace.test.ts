import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { suggestServerSettings } from '@xpanel/core'
import { createRootPrincipal, createTestDb } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { hashPasswordArgon2id } from './auth.ts'
import { createApiApp } from './server.ts'
import { zoneWithMailAuth } from './server-operations-workspace.ts'

const SERVER_SECRET = 'server-operations-synthetic-server-secret-at-least-32-bytes'
const ORIGIN = 'https://panel.example.test'
const PASSWORD = 'SyntheticRootPassword!2026'
let passwordHash: string
beforeAll(async () => { passwordHash = await hashPasswordArgon2id(PASSWORD) })

type Reply = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('WHM server operations', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle
  beforeEach(async () => { db = await createTestDb(); state = await createTestStateStore(); await createRootPrincipal(db.db, { username: 'root', passwordHash, forcePasswordChange: false }) })
  afterEach(async () => { await state.close(); await db.close() })

  const session = async () => {
    const api = createApiApp({ db: db.db, store: state.store, serverSecret: SERVER_SECRET, allowedOrigins: [ORIGIN] })
    const login = await api.fetch(new Request(ORIGIN + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ username: 'root', password: PASSWORD }) }))
    const { csrfToken } = await login.json() as { csrfToken: string }
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Reply }> => {
      const response = await api.fetch(new Request(ORIGIN + path, { method, headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrfToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
      return { status: response.status, body: await response.json() as Reply }
    }
  }
  const server = async () => {
    const suggested = suggestServerSettings({ cores: 2, memoryMb: 4096 })
    await state.store.saveServerSettings({ hostname: 'srv.example.net', nameservers: ['ns1.example.net', 'ns2.example.net'], adminEmail: 'root@example.net', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
  }

  it('saves resolvers bound to their revision and reports them as not applied without an agent', async () => {
    const call = await session()
    const read = await call('GET', '/api/server/resolvers')
    expect(read.body.resolvers).toBeNull()
    expect((await call('PUT', '/api/server/resolvers', { resolvers: ['192.0.2.1'], expectedRevision: read.body.revision })).status).toBe(422)
    const saved = await call('PUT', '/api/server/resolvers', { resolvers: ['192.0.2.2', '192.0.2.1', '2001:db8::1'], expectedRevision: read.body.revision })
    expect(saved.body).toMatchObject({ resolvers: ['192.0.2.2', '192.0.2.1', '2001:db8::1'], applied: null })
    expect((await call('PUT', '/api/server/resolvers', { resolvers: ['192.0.2.1', '192.0.2.3'], expectedRevision: read.body.revision })).status).toBe(409)
  })

  it('applies the host name rules at the hostname API', async () => {
    const call = await session()
    await server()
    for (const hostname of ['www.example.com', '1host.example.com', 'host-', 'a'.repeat(52) + '.example.com']) {
      const refused = await call('POST', '/api/server/hostname', { hostname })
      expect(refused.status).toBe(422)
      expect(JSON.stringify(refused.body)).toContain('INVALID_HOSTNAME')
    }
    expect((await call('POST', '/api/server/hostname', { hostname: 'server1.example.net' })).body.hostname).toBe('server1.example.net')
  })

  it('refuses the current profile and a change that stops what accounts use', async () => {
    const call = await session()
    const read = await call('GET', '/api/server/role-profile')
    expect(read.body.effective).toContain('ftp')
    const same = await call('POST', '/api/server/role-profile/review', { profile: 'full', optional: [] })
    expect(JSON.stringify(same.body)).toContain('NO_CHANGES')
    const review = await call('POST', '/api/server/role-profile/review', { profile: 'dns-only', optional: [] })
    expect(review.body.changes).toContainEqual({ role: 'ftp', change: 'disable' })
    const saved = await call('PUT', '/api/server/role-profile', { profile: 'dns-only', optional: [], expectedRevision: read.body.revision })
    expect(saved.body).toMatchObject({ effective: ['dns'], job: null })
    expect(JSON.stringify((await call('PUT', '/api/server/role-profile', { profile: 'dns-only', optional: [], expectedRevision: saved.body.revision })).body)).toContain('NO_CHANGES')
  })

  it('offers only a disable option beside the one DNS and FTP daemon', async () => {
    const call = await session()
    const read = await call('GET', '/api/server/service-selection')
    expect((await call('PUT', '/api/server/service-selection', { dnsServer: 'bind', ftpServer: 'pure-ftpd', expectedRevision: read.body.revision })).status).toBe(422)
    const saved = await call('PUT', '/api/server/service-selection', { dnsServer: 'powerdns', ftpServer: 'disabled', expectedRevision: read.body.revision })
    expect(saved.body.effective).not.toContain('ftp')
    expect(saved.body.changes).toEqual([{ role: 'ftp', change: 'disable' }])
  })

  it('refuses a forward without a free pool address', async () => {
    const call = await session()
    const read = await call('GET', '/api/server/domain-forwards')
    const refused = await call('POST', '/api/server/domain-forwards', { domain: 'example.org', url: 'https://example.net/', expectedRevision: read.body.revision })
    expect(refused.status).toBe(412)
    expect(JSON.stringify(refused.body)).toContain('NO_FREE_IP')
  })

  it('validates and saves system mail, panel TLS, the schedule and update preferences', async () => {
    const call = await session()
    const mail = await call('GET', '/api/server/system-mail')
    expect(JSON.stringify((await call('PUT', '/api/server/system-mail', { forwards: { root: 'nosuchuser', nobody: null, xpanel: null }, expectedRevision: mail.body.revision })).body)).toContain('forward_target_unknown')
    expect((await call('PUT', '/api/server/system-mail', { forwards: { root: 'admin@example.net', nobody: 'root', xpanel: 'root' }, expectedRevision: mail.body.revision })).body.forwards.root).toBe('admin@example.net')

    const tls = await call('GET', '/api/server/panel-tls')
    expect(tls.body).toMatchObject({ saved: false, policy: { protocols: ['TLSv1.2', 'TLSv1.3'] } })
    expect((await call('PUT', '/api/server/panel-tls', { protocols: ['TLSv1.3'], ciphers: 'HIGH:!aNULL', expectedRevision: tls.body.revision })).body).toMatchObject({ saved: true, policy: { protocols: ['TLSv1.3'] } })

    const schedule = await call('GET', '/api/server/maintenance-schedule')
    expect(schedule.body).toMatchObject({ updater: '30 3 * * *', backup: null })
    for (const updater of ['60 2 * * *', '0 2 * * 7']) expect((await call('PUT', '/api/server/maintenance-schedule', { updater, backup: null, expectedRevision: schedule.body.revision })).status).toBe(422)
    expect((await call('PUT', '/api/server/maintenance-schedule', { updater: '*/5 2 * * *', backup: null, expectedRevision: schedule.body.revision })).body).toMatchObject({ moreThanDaily: { updater: true } })

    const updates = await call('GET', '/api/server/update-preferences')
    expect(updates.body).toMatchObject({ tier: 'release', updates: 'manual', securityPatches: true, owner: null })
    expect((await call('PUT', '/api/server/update-preferences', { tier: 'nightly', updates: 'manual', securityPatches: true, expectedRevision: updates.body.revision })).status).toBe(422)
    expect((await call('PUT', '/api/server/update-preferences', { tier: 'stable', updates: 'automatic', securityPatches: true, expectedRevision: updates.body.revision })).body).toMatchObject({ tier: 'stable', owner: 'root' })
  })

  it('reports the cluster on saved update preferences only when asked, and no push without members', async () => {
    const call = await session()
    const updates = await call('GET', '/api/server/update-preferences')
    const first = await call('PUT', '/api/server/update-preferences', { tier: 'stable', updates: 'manual', securityPatches: true, expectedRevision: updates.body.revision })
    expect(first.body).not.toHaveProperty('cluster')
    const second = await call('PUT', '/api/server/update-preferences', { tier: 'stable', updates: 'manual', securityPatches: true, sendToCluster: true, expectedRevision: first.body.revision })
    expect(second.body).toMatchObject({ tier: 'stable', cluster: null })
    expect((await call('PUT', '/api/server/update-preferences', { tier: 'stable', updates: 'manual', securityPatches: true, sendToCluster: 'yes', expectedRevision: second.body.revision })).status).toBe(422)
  })

  it('creates a hostname zone with its A record when no parent zone exists, and uses the parent otherwise', async () => {
    const call = await session()
    await server()
    const created = await call('POST', '/api/server/dns-ops/hostname-a-record', { ip: '192.0.2.10' })
    expect(created.body).toMatchObject({ zone: 'srv.example.net', created: true, ip: '192.0.2.10', verified: null })
    expect((await state.store.getDnsZone('srv.example.net'))!.records.find(record => record.type === 'A')).toMatchObject({ name: '@', content: '192.0.2.10' })
    await state.store.saveDnsZone({ id: '11111111-1111-4111-8111-111111111111', accountId: null, name: 'example.net', serial: 1, records: [] })
    await state.store.deleteDnsZone('srv.example.net')
    const parent = await call('POST', '/api/server/dns-ops/hostname-a-record', { ip: '192.0.2.11' })
    expect(parent.body).toMatchObject({ zone: 'example.net', created: false })
    expect((await state.store.getDnsZone('example.net'))!.records).toContainEqual(expect.objectContaining({ name: 'srv', type: 'A', content: '192.0.2.11' }))
  })

  it('refuses the DNS cleanup without a host agent and these routes for a query', async () => {
    const call = await session()
    expect(JSON.stringify((await call('GET', '/api/server/dns-ops/cleanup')).body)).toContain('host_agent_unavailable')
    expect((await call('GET', '/api/server/resolvers?x=1')).status).toBe(422)
  })
})

describe('Enable DKIM and SPF for all', { tags: ['unit'] }, () => {
  const zone = (content?: string) => ({ id: 'z', accountId: 'a', name: 'example.org', serial: 4, records: content ? [{ id: 'r', zone: 'example.org', name: '@', type: 'TXT' as const, ttl: 300, content, priority: null }] : [] })

  it('appends the main address, keeps other terms and leaves a done zone alone', () => {
    const next = zoneWithMailAuth(zone('v=spf1 include:x ~all'), '192.0.2.1')!
    expect(next.records[0]!.content).toBe('v=spf1 include:x +ip4:192.0.2.1 ~all')
    expect(next.serial).toBe(5)
    expect(zoneWithMailAuth(zone('v=spf1 +ip4:192.0.2.1 ~all'), '192.0.2.1')).toBeNull()
    expect(zoneWithMailAuth(zone(), '192.0.2.1')!.records[0]).toMatchObject({ name: '@', type: 'TXT', content: 'v=spf1 +a +mx +ip4:192.0.2.1 ~all' })
  })
})
