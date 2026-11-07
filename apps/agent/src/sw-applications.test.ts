import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { readSwApplicationsView } from '../../../packages/os/src/sw-applications-command.ts'
import { applicationCatalogSigningBytes } from './application-catalog.ts'
import { createSwApplicationCatalogSource } from './sw-application-catalog-store.ts'
import type { SwCatalogTrust } from './sw-application-catalog-store.ts'
import { ApplicationInstallCoordinator } from './application-install.ts'
import type { ApplicationArtifactProvider } from './application-install.ts'
import { applicationInstanceKey } from './application-provider.ts'
import { handleSwApplicationsRoute } from './sw-applications.ts'
import type { SwApplicationsContext } from './sw-applications.ts'

const pair = generateKeyPairSync('ed25519'), pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const catalog = (sequence = 7) => ({ schemaVersion: 1, sequence, issuedAt: '2026-10-28T11:00:00.000Z', expiresAt: '2026-10-29T12:00:00.000Z', applications: [{ id: 'sample', name: 'Sample', releases: [{ version: '1.2.3', minimumPanelVersion: '1.0.0', artifact: { format: 'xpanel-files-v1', sha256: 'a'.repeat(64), bytes: 99 } }] }] })
const envelope = (sequence = 7) => { const payload = JSON.stringify(catalog(sequence)); return JSON.stringify({ keyId: 'apps-2026', payload, signature: sign(null, applicationCatalogSigningBytes(payload), pair.privateKey).toString('hex') }) }
const now = () => new Date('2026-10-28T12:00:00.000Z')
const files = (initial: { trust?: SwCatalogTrust; envelope?: string | null; floor?: string | null } = {}) => {
  const state = { trust: initial.trust ?? { state: 'configured' as const, keys: [{ keyId: 'apps-2026', publicKeyPem: pem }], reason: null }, envelope: initial.envelope === undefined ? envelope() : initial.envelope, floor: initial.floor ?? null }
  return { state, files: { readTrust: async () => state.trust, readEnvelope: async () => state.envelope, writeEnvelope: vi.fn(async (text: string) => { state.envelope = text }), readFloor: async () => state.floor, writeFloor: vi.fn(async (text: string) => { state.floor = text }) } }
}
const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', planId: 'plan', status: 'active', uid: 2001, gid: 2001, home: '/home/alice' } as Account
const domain = { id: '22222222-2222-4222-8222-222222222222', accountId: account.id, name: 'a.example', docRoot: '/home/alice/public_html', suspended: false } as Domain
const context = (overrides: Partial<SwApplicationsContext> = {}): SwApplicationsContext => ({
  caller: { role: 'user', accountId: account.id, principalId: 'p1', actor: 'alice' } as never, currentPrincipal: async () => ({ kind: 'user', id: 'p1', username: 'alice', accountId: account.id, disabled: false }),
  store: { getAccountByUsername: async name => name === 'alice' ? account : null, listDomains: async () => [domain], getPlan: async () => ({ featureListId: 'f' }) as Plan, getFeatureList: async () => ({ disabled: [] }) as unknown as FeatureList, withAccountLifecycleLease: async (_id, operation) => operation(account) },
  catalog: createSwApplicationCatalogSource(files().files, '1.4.2', now), offered: async () => ['sample'], provider: null, database: null, coordinator: null, instances: async () => [], submitJob: vi.fn(), audit: vi.fn(async () => {}), ...overrides,
})
const call = (ctx: SwApplicationsContext, path: string, body?: unknown) => { const url = new URL('http://agent.local' + path); return handleSwApplicationsRoute(new Request(url, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), url, body === undefined ? 'GET' : 'POST', ctx) }

describe('signed application catalog store', () => {
  it('verifies the stored envelope with the release keys and persists a monotonic sequence floor', async () => {
    const f = files(), source = createSwApplicationCatalogSource(f.files, '1.4.2', now)
    expect((await source.catalog()).sequence).toBe(7); expect(f.state.floor).toBe('7\n'); expect(source.policy().minimumSequence).toBe(7)
    f.state.floor = '9\n'; await expect(source.catalog()).rejects.toThrow()
    f.state.envelope = envelope(10); expect((await source.catalog()).sequence).toBe(10); expect(f.state.floor).toBe('10\n')
  })
  it('reports unconfigured, invalid trust and tampered caches without trusting them', async () => {
    await expect(createSwApplicationCatalogSource(files({ envelope: null }).files, '1.4.2', now).catalog()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'application_catalog_unavailable' } })
    await expect(createSwApplicationCatalogSource(files({ trust: { state: 'missing', keys: [], reason: 'no-trusted-release-keys' } }).files, '1.4.2', now).catalog()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'release_keys_unavailable' } })
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    await expect(createSwApplicationCatalogSource(files({ trust: { state: 'configured', keys: [{ keyId: 'apps-2026', publicKeyPem: other }], reason: null } }).files, '1.4.2', now).catalog()).rejects.toMatchObject({ code: 'VALIDATION' })
    const tampered = JSON.parse(envelope()); tampered.payload = tampered.payload.replace('Sample', 'Evil')
    await expect(createSwApplicationCatalogSource(files({ envelope: JSON.stringify(tampered) }).files, '1.4.2', now).catalog()).rejects.toThrow()
    expect(() => createSwApplicationCatalogSource(files().files, 'dev', now)).toThrow()
  })
})

describe('signed catalog import', () => {
  it('stores only an envelope the release key signed, never an older or tampered one, and raises the floor after the write', async () => {
    const f = files({ envelope: null }), source = createSwApplicationCatalogSource(f.files, '1.4.2', now)
    expect((await source.import(envelope(8))).sequence).toBe(8)
    expect(f.state.floor).toBe('8\n'); expect(f.files.writeEnvelope).toHaveBeenCalledTimes(1)
    await expect(source.import(envelope(5))).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    const tampered = JSON.parse(envelope(9)); tampered.payload = tampered.payload.replace('Sample', 'Evil')
    await expect(source.import(JSON.stringify(tampered))).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(f.files.writeEnvelope).toHaveBeenCalledTimes(1); expect((await source.catalog()).sequence).toBe(8)
    const failing = files({ envelope: null }); failing.files.writeEnvelope.mockRejectedValueOnce(new Error('disk full'))
    await expect(createSwApplicationCatalogSource(failing.files, '1.4.2', now).import(envelope(8))).rejects.toThrow('disk full')
    expect(failing.state.floor).toBeNull()
  })
})

describe('account applications route', () => {
  it('reads the verified catalog and owned domains, and never reports an installation without the provider', async () => {
    const all = readSwApplicationsView(await (await call(context(), '/accounts/alice/applications'))!.json())
    expect(all.catalog).toMatchObject({ state: 'read', sequence: 7, applications: [{ id: 'sample', name: 'Sample', versions: ['1.2.3'] }] }); expect(all.domains).toEqual([{ id: domain.id, name: 'a.example' }]); expect(all.instances).toEqual([])
    const one = readSwApplicationsView(await (await call(context(), '/accounts/alice/applications?domainId=' + domain.id))!.json())
    expect(one.selected).toEqual({ domainId: domain.id, path: '', state: 'unavailable', reason: 'application_provider_unavailable', revision: null, installation: null, recoveryRequired: null, modified: null, writesAvailable: false })
    const unoffered = readSwApplicationsView(await (await call(context({ offered: async () => [] }), '/accounts/alice/applications'))!.json())
    expect(unoffered.catalog).toMatchObject({ state: 'read', applications: [] })
    const none = readSwApplicationsView(await (await call(context({ catalog: null }), '/accounts/alice/applications?domainId=' + domain.id))!.json())
    expect(none.catalog.reason).toBe('not-configured'); expect(none.selected!.reason).toBe('application_catalog_unavailable')
  })
  it('refuses writes before any job when the provider is not admitted (no JSON-only success)', async () => {
    const ctx = context()
    const body = { domainId: domain.id, action: 'install', appId: 'sample', version: '1.2.3', expectedRevision: 'b'.repeat(64), expectedCatalogRevision: 'c'.repeat(64) }
    await expect(call(ctx, '/accounts/alice/applications/jobs', body)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, reason: 'application_provider_unavailable' } })
    expect(ctx.submitJob).not.toHaveBeenCalled(); expect(ctx.audit).not.toHaveBeenCalled()
    await expect(call(context({ offered: async () => [] }), '/accounts/alice/applications/jobs', body)).rejects.toMatchObject({ code: 'NOT_FOUND', detail: { reason: 'application_not_offered' } })
    await expect(call(context({ offered: async () => null }), '/accounts/alice/applications/jobs', body)).rejects.toMatchObject({ code: 'NOT_FOUND', detail: { reason: 'application_not_offered' } })
    const fakeAdmission = context({ provider: { admission: { descriptorConfinement: true } } as never })
    await expect(call(fakeAdmission, '/accounts/alice/applications/jobs', body)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('installs under a path through the process coordinator, lists records and recovers a stranded journal', async () => {
    const observed = { revision: 'b'.repeat(64), unmanagedRevision: 'd'.repeat(64), empty: true, managedClean: true, recoveryRequired: false, installation: null }
    const opened: unknown[] = [], recovered: string[] = []
    const provider: ApplicationArtifactProvider = {
      admission: { descriptorConfinement: true, accountLifetimeFence: true, durablePreimages: true, scopedWrites: true, digestReadback: true, boundedDeadlines: true, contentAddressedEgress: true },
      readArtifact: async () => { throw Object.assign(new Error('unused')) },
      pendingTransactions: async () => [{ transactionId: 'e0e0e0e0-0000-4000-8000-000000000000', beforeRevision: observed.revision, expectedCommittedRevision: null }],
      openTarget: async target => { opened.push(target); return { target, observe: async () => observed, recover: async (id: string) => { recovered.push(id); return { transactionId: id, state: 'restored', beforeRevision: observed.revision, committedRevision: null, observation: observed } }, close: async () => {} } as never },
    }
    const record = { domain: 'a.example', path: 'blog', appId: 'sample', version: '1.2.3', previousVersion: null, artifactSha256: 'a'.repeat(64), database: { name: 'alice_app1', user: 'alice_app1' }, config: 'config.php', updatedAt: '2026-10-28T12:00:00.000Z', revision: 'c'.repeat(64), key: applicationInstanceKey('public_html/blog') }
    const ctx = context({ provider, coordinator: new ApplicationInstallCoordinator(), instances: async () => [record, { ...record, domain: 'other.example' }] })
    const view = readSwApplicationsView(await (await call(ctx, `/accounts/alice/applications?domainId=${domain.id}&path=blog`))!.json())
    expect(view.selected).toMatchObject({ path: 'blog', state: 'read', revision: observed.revision, modified: false, writesAvailable: true })
    expect(opened[0]).toMatchObject({ root: 'public_html/blog', path: 'blog', domain: 'a.example', username: 'alice', home: '/home/alice' })
    expect(view.instances).toEqual([{ domainId: domain.id, domain: 'a.example', path: 'blog', appId: 'sample', version: '1.2.3', previousVersion: null, database: 'alice_app1', updatedAt: record.updatedAt }])
    const refused = { domainId: domain.id, path: '../up', action: 'install', appId: 'sample', version: '1.2.3', expectedRevision: observed.revision, expectedCatalogRevision: view.catalog.revision }
    await expect(call(ctx, '/accounts/alice/applications/jobs', refused)).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'application_path_invalid' } })
    expect(await (await call(ctx, '/accounts/alice/applications/recover', { domainId: domain.id, path: 'blog' }))!.json()).toEqual({ results: [{ transactionId: 'e0e0e0e0-0000-4000-8000-000000000000', state: 'restored', verified: true }] })
    expect(recovered).toEqual(['e0e0e0e0-0000-4000-8000-000000000000'])
    expect(ctx.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.application.recovered', outcome: 'ok' }))
  })
  it('pins owner, domain ownership and strict selectors', async () => {
    await expect(call(context(), '/accounts/bob/applications')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(context({ caller: { role: 'root', accountId: null } as never }), '/accounts/alice/applications')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(context(), '/accounts/alice/applications?domainId=33333333-3333-4333-8333-333333333333')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call(context(), '/accounts/alice/applications?path=blog')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(context(), `/accounts/alice/applications?domainId=${domain.id}&path=/home`)).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'application_path_invalid' } })
    await expect(call(context(), `/accounts/alice/applications?domainId=${domain.id}&path=../up`)).rejects.toMatchObject({ code: 'VALIDATION' })
    const nested = readSwApplicationsView(await (await call(context(), `/accounts/alice/applications?domainId=${domain.id}&path=blog`))!.json())
    expect(nested.selected).toMatchObject({ domainId: domain.id, path: 'blog', state: 'unavailable' })
    await expect(call(context({ currentPrincipal: async () => null }), '/accounts/alice/applications')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
