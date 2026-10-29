import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as dbApi from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'
import { TEST_SERVER_SECRET } from './testing.ts'

// Real-loopback acceptance for the owner-facing domain configuration seams that previously had
// no reachable client path: the owner PHP settings PATCH (self path) and the per-domain custom
// configuration workspace. The public independent Argon2 fixture vector authenticates synthetic
// temporary API tokens only; no native host effect is claimed.

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
const domainsPath = '/api/domains'
interface DomainView {
  context: { accountId: string; home: string }
  revision: string
  domains: Array<{ id: string; accountId: string; name: string; kind: string; docRoot: string; siteType: string; php: Record<string, unknown>; certificateId: string | null }>
  application: { status: string; targetVerified: boolean }
}
interface CustomConfig {
  nginxInclude: string; apacheInclude: string; userIni: Record<string, string>
  customHeaders: Record<string, string>; cacheBypassPaths: string[]
}
interface AuditRow {
  [column: string]: unknown
  actor: string; principal_id: string | null; action: string; target: string; outcome: string; detail: string
}

const fixture = async () => {
  const database = await dbApi.createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Owner web configuration policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Owner web configuration plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 3, aliasDomains: 3, subdomains: 3, mailboxes: 4, forwarders: 4, mailingLists: 4, ftpAccounts: 4, databases: 4, phpWorkers: 4 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.90', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = async (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: username + '.example.test', planId: plan.id, ownerId: null,
    contactEmail: 'owner@' + username + '.example.test', ipv4: '192.0.2.90', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await account('ownwebcfg'), other = await account('otherwebcfg')
  const primary = (await state.store.getDomainByName(owner.primaryDomain))!
  const principal = await dbApi.createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const neighbor = await dbApi.createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: HASH })
  await dbApi.reindexFromState(database.db, await state.store.readSnapshot())
  const token = async (scopes: string[], principalId = principal.id) => {
    const raw = 'xp_' + randomUUID()
    await dbApi.createApiToken(database.db, { principalId, name: 'Synthetic owner web configuration', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const credential = await token(['domains:read', 'domains:write'])
  const readOnly = await token(['domains:read'])
  const neighborCredential = await token(['domains:read', 'domains:write'], neighbor.id)
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET })
  const request = (path: string, method = 'GET', body?: unknown, raw: string | null = credential) => app.fetch(new Request('http://localhost' + path, { method,
    headers: { ...(raw ? { authorization: 'Bearer ' + raw } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const view = async (raw = credential): Promise<DomainView> => {
    const response = await request(domainsPath, 'GET', undefined, raw)
    expect(response.status).toBe(200)
    return await response.json() as DomainView
  }
  const domainId = primary.id
  const patch = (body: unknown, raw: string | null = credential) => request(`${domainsPath}/${domainId}`, 'PATCH', body, raw)
  const customPath = `${domainsPath}/${domainId}/custom-config`
  const stateBytes = async () => JSON.stringify(await state.store.readSnapshot())
  const auditRows = (action: string) => database.db.query<AuditRow>('SELECT actor, principal_id, action, target, outcome, detail FROM audit_log WHERE action = $1 ORDER BY id ASC', [action])
  const currentPhp = (viewValue: DomainView) => viewValue.domains.find(domain => domain.id === domainId)!.php
  const desiredPhp = (source: Record<string, unknown>) => ({
    version: source.version, handler: source.handler,
    fpm: source.fpm, ini: source.ini,
  })
  return { database, state, features, owner, other, primary, principal, neighbor, credential, readOnly, neighborCredential, request, view, patch, customPath, stateBytes, auditRows, currentPhp, desiredPhp, domainId }
}

describe('owner web configuration seams: PHP settings and per-domain custom configuration', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Synthetic owner web configuration cleanup failed')
  })

  it('saves the owner PHP settings with the captured public revision and reads them back with an audit join', async () => {
    const before = await f.view()
    const php = f.desiredPhp(f.currentPhp(before))
    const changed = { ...php, version: '8.2', handler: 'fpm', fpm: { ...(php.fpm as Record<string, unknown>), maxChildren: 3 }, ini: { ...(php.ini as Record<string, unknown>), memory_limit: '96M' } }
    expect(changed.version).not.toBe(php.version)
    const response = await f.patch({ php: changed, expectedRevision: before.revision })
    expect(response.status).toBe(200)
    const result = await response.json() as { domain: { id: string; php: Record<string, unknown> }; stateChanged: true; revision: string }
    expect(result.stateChanged).toBe(true)
    expect(result.domain.id).toBe(f.domainId)
    expect(result.domain.php).toMatchObject({ version: '8.2', ini: { memory_limit: '96M' } })
    expect(result.revision).toMatch(/^[0-9a-f]{64}$/)
    const after = await f.view()
    expect(f.currentPhp(after)).toMatchObject({ version: '8.2', ini: { memory_limit: '96M' } })
    expect(after.revision).not.toBe(before.revision)
    const audits = await f.auditRows('domain.updated')
    expect(audits.length).toBe(1)
    expect(audits[0]).toMatchObject({ actor: f.owner.username, principal_id: f.principal.id, outcome: 'ok' })
    expect(audits[0]!.target).toContain(f.primary.name)
  })

  it('requires the current workspace revision before any owner PHP change', async () => {
    const php = f.desiredPhp(f.currentPhp(await f.view())), before = await f.stateBytes()
    const missing = await f.patch({ php })
    expect(missing.status).toBe(412)
    const missingBody = await missing.json() as { code?: string; details?: { stateChanged?: boolean } }
    expect(missingBody.code).toBe('PRECONDITION_FAILED')
    expect(missingBody.details?.stateChanged).toBe(false)
    const malformed = await f.patch({ php, expectedRevision: 'not-a-revision' })
    expect(malformed.status).toBe(422)
    expect(await f.stateBytes()).toBe(before)
  })

  it('refuses a stale owner PHP change without writing or auditing it', async () => {
    const stale = await f.view()
    const moved = await f.patch({ docRoot: f.owner.home + '/changed', expectedRevision: stale.revision })
    expect(moved.status).toBe(200)
    const before = await f.stateBytes(), auditsBefore = (await f.auditRows('domain.updated')).length
    const php = f.desiredPhp(f.currentPhp(await f.view()))
    const response = await f.patch({ php, expectedRevision: stale.revision })
    expect(response.status).toBe(409)
    const body = await response.json() as { code?: string; details?: { stateChanged?: boolean } }
    expect(body.code).toBe('CONFLICT')
    expect(body.details?.stateChanged).toBe(false)
    expect(await f.stateBytes()).toBe(before)
    expect((await f.auditRows('domain.updated')).length).toBe(auditsBefore)
  })

  it('keeps the owner PHP change behind the domain-php-settings feature policy', async () => {
    await f.state.store.updateFeatureList(f.features.id, { disabled: ['domain-php-settings'] })
    const before = await f.view(), snapshot = await f.stateBytes()
    const response = await f.patch({ php: f.desiredPhp(f.currentPhp(before)), expectedRevision: before.revision })
    expect(response.status).toBe(403)
    expect(await f.stateBytes()).toBe(snapshot)
    await f.state.store.updateFeatureList(f.features.id, { disabled: [] })
    const allowed = await f.patch({ php: f.desiredPhp(f.currentPhp(await f.view())), expectedRevision: (await f.view()).revision })
    expect(allowed.status).toBe(200)
  })

  it.each([
    ['unknown php field', (php: Record<string, unknown>) => ({ ...php, extra: true })],
    ['invalid version', (php: Record<string, unknown>) => ({ ...php, version: '8' })],
    ['invalid handler', (php: Record<string, unknown>) => ({ ...php, handler: 'root' })],
    ['unknown top-level field', (php: Record<string, unknown>) => php],
  ])('refuses %s for the owner without changing stored state', async (name, mutate) => {
    const view = await f.view(), before = await f.stateBytes()
    const php = mutate(f.desiredPhp(f.currentPhp(view)))
    const body: Record<string, unknown> = name === 'unknown top-level field' ? { php, expectedRevision: view.revision, name: 'changed.example.test' } : { php, expectedRevision: view.revision }
    const response = await f.patch(body)
    expect(response.status).toBe(422)
    expect(await f.stateBytes()).toBe(before)
  })

  it('keeps the owner document-root change working and still refuses foreign owner fields', async () => {
    const view = await f.view(), root = f.owner.home + '/public_html'
    const docRoot = await f.patch({ docRoot: root, expectedRevision: view.revision })
    expect(docRoot.status).toBe(200)
    expect((await f.view()).domains.find(domain => domain.id === f.domainId)!.docRoot).toBe(root)
    const before = await f.stateBytes(), next = await f.view()
    const foreign = await f.patch({ php: f.desiredPhp(f.currentPhp(next)), expectedRevision: next.revision, certificateId: randomUUID() })
    expect(foreign.status).toBe(422)
    expect(await f.stateBytes()).toBe(before)
  })

  it('does not let a neighbor or a read-only token change the owner PHP settings', async () => {
    const view = await f.view(), before = await f.stateBytes()
    const php = f.desiredPhp(f.currentPhp(view))
    const neighbor = await f.patch({ php, expectedRevision: view.revision }, f.neighborCredential)
    expect([403, 404]).toContain(neighbor.status)
    const readOnly = await f.patch({ php, expectedRevision: view.revision }, f.readOnly)
    expect(readOnly.status).toBe(403)
    const anonymous = await f.patch({ php, expectedRevision: view.revision }, null)
    expect(anonymous.status).toBe(401)
    expect(await f.stateBytes()).toBe(before)
  })

  it('saves and reads back the owner per-domain custom configuration', async () => {
    const initial = await f.request(f.customPath)
    expect(initial.status).toBe(200)
    expect((await initial.json() as { config: unknown }).config).toBeNull()
    const body: CustomConfig = { nginxInclude: '# owner include\nadd_header X-Example "yes";', apacheInclude: '', userIni: { memory_limit: '256M' }, customHeaders: { 'X-Frame-Options': 'SAMEORIGIN' }, cacheBypassPaths: ['/cart'] }
    const saved = await f.request(f.customPath, 'PUT', body)
    expect(saved.status).toBe(200)
    const savedBody = await saved.json() as { config: CustomConfig; reconcile: unknown }
    expect(savedBody.config).toMatchObject(body)
    const readback = await f.request(f.customPath)
    expect(readback.status).toBe(200)
    expect((await readback.json() as { config: CustomConfig }).config).toMatchObject(body)
    const audits = await f.auditRows('domain.custom_config.updated')
    expect(audits.length).toBe(1)
    expect(audits[0]).toMatchObject({ actor: f.owner.username, principal_id: f.principal.id, outcome: 'ok' })
  })

  it('refuses unsafe custom configuration content and neighbor access without writing', async () => {
    const before = await f.stateBytes()
    const unsafe = await f.request(f.customPath, 'PUT', { nginxInclude: 'user nobody;', apacheInclude: '', userIni: {}, customHeaders: {}, cacheBypassPaths: [] })
    expect(unsafe.status).toBe(422)
    const neighbor = await f.request(f.customPath, 'GET', undefined, f.neighborCredential)
    expect([403, 404]).toContain(neighbor.status)
    const neighborWrite = await f.request(f.customPath, 'PUT', { nginxInclude: '# foreign', apacheInclude: '', userIni: {}, customHeaders: {}, cacheBypassPaths: [] }, f.neighborCredential)
    expect([403, 404]).toContain(neighborWrite.status)
    const anonymous = await f.request(f.customPath, 'GET', undefined, null)
    expect(anonymous.status).toBe(401)
    expect(await f.stateBytes()).toBe(before)
  })
})
