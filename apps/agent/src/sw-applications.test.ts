import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { readSwApplicationsView } from '../../../packages/os/src/sw-applications-command.ts'
import { applicationCatalogSigningBytes } from './application-catalog.ts'
import { createSwApplicationCatalogSource, parseSwCatalogTrustKeys } from './sw-application-catalog-store.ts'
import { handleSwApplicationsRoute } from './sw-applications.ts'
import type { SwApplicationsContext } from './sw-applications.ts'

const pair = generateKeyPairSync('ed25519'), pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const catalog = (sequence = 7) => ({ schemaVersion: 1, sequence, issuedAt: '2026-10-28T11:00:00.000Z', expiresAt: '2026-10-29T12:00:00.000Z', applications: [{ id: 'sample', name: 'Sample', releases: [{ version: '1.2.3', minimumPanelVersion: '1.0.0', artifact: { format: 'xpanel-files-v1', sha256: 'a'.repeat(64), bytes: 99 } }] }] })
const envelope = (sequence = 7) => { const payload = JSON.stringify(catalog(sequence)); return JSON.stringify({ keyId: 'apps-2026', payload, signature: sign(null, applicationCatalogSigningBytes(payload), pair.privateKey).toString('hex') }) }
const now = () => new Date('2026-10-28T12:00:00.000Z')
const files = (initial: { keys?: string | null; envelope?: string | null; floor?: string | null } = {}) => {
  const state = { keys: initial.keys === undefined ? JSON.stringify([{ keyId: 'apps-2026', publicKeyPem: pem }]) : initial.keys, envelope: initial.envelope === undefined ? envelope() : initial.envelope, floor: initial.floor ?? null }
  return { state, files: { readTrustKeys: async () => state.keys, readEnvelope: async () => state.envelope, readFloor: async () => state.floor, writeFloor: vi.fn(async (text: string) => { state.floor = text }) } }
}
const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', planId: 'plan', status: 'active', uid: 2001, gid: 2001, home: '/home/alice' } as Account
const domain = { id: '22222222-2222-4222-8222-222222222222', accountId: account.id, name: 'a.example', docRoot: '/home/alice/public_html', suspended: false } as Domain
const context = (overrides: Partial<SwApplicationsContext> = {}): SwApplicationsContext => ({
  caller: { role: 'user', accountId: account.id, principalId: 'p1', actor: 'alice' } as never, currentPrincipal: async () => ({ kind: 'user', id: 'p1', username: 'alice', accountId: account.id, disabled: false }),
  store: { getAccountByUsername: async name => name === 'alice' ? account : null, listDomains: async () => [domain], getPlan: async () => ({ featureListId: 'f' }) as Plan, getFeatureList: async () => ({ disabled: [] }) as unknown as FeatureList, withAccountLifecycleLease: async (_id, operation) => operation(account) },
  catalog: createSwApplicationCatalogSource(files().files, '1.4.2', now), provider: null, submitJob: vi.fn(), audit: vi.fn(async () => {}), ...overrides,
})
const call = (ctx: SwApplicationsContext, path: string, body?: unknown) => { const url = new URL('http://agent.local' + path); return handleSwApplicationsRoute(new Request(url, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), url, body === undefined ? 'GET' : 'POST', ctx) }

describe('signed application catalog bootstrap and cache', () => {
  it('verifies the cached envelope with bootstrap keys and persists a monotonic sequence floor', async () => {
    const f = files(), source = createSwApplicationCatalogSource(f.files, '1.4.2', now)
    expect((await source.catalog()).sequence).toBe(7); expect(f.state.floor).toBe('7\n'); expect(source.policy().minimumSequence).toBe(7)
    f.state.floor = '9\n'; await expect(source.catalog()).rejects.toThrow()
    f.state.envelope = envelope(10); expect((await source.catalog()).sequence).toBe(10); expect(f.state.floor).toBe('10\n')
  })
  it('reports unconfigured, invalid trust and tampered caches without trusting them', async () => {
    await expect(createSwApplicationCatalogSource(files({ envelope: null }).files, '1.4.2', now).catalog()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'application_catalog_unavailable' } })
    expect(() => parseSwCatalogTrustKeys(JSON.stringify([{ keyId: 'a', publicKeyPem: pem, url: 'https://x' }]))).toThrow()
    expect(() => parseSwCatalogTrustKeys('[]')).toThrow()
    const tampered = JSON.parse(envelope()); tampered.payload = tampered.payload.replace('Sample', 'Evil')
    await expect(createSwApplicationCatalogSource(files({ envelope: JSON.stringify(tampered) }).files, '1.4.2', now).catalog()).rejects.toThrow()
    expect(() => createSwApplicationCatalogSource(files().files, 'dev', now)).toThrow()
  })
})

describe('account applications route', () => {
  it('reads the verified catalog and owned domains, and never reports an installation without the provider', async () => {
    const all = readSwApplicationsView(await (await call(context(), '/accounts/alice/applications'))!.json())
    expect(all.catalog).toMatchObject({ state: 'read', sequence: 7, applications: [{ id: 'sample', name: 'Sample', versions: ['1.2.3'] }] }); expect(all.domains).toEqual([{ id: domain.id, name: 'a.example' }])
    const one = readSwApplicationsView(await (await call(context(), '/accounts/alice/applications?domainId=' + domain.id))!.json())
    expect(one.selected).toEqual({ domainId: domain.id, state: 'unavailable', reason: 'application_provider_unavailable', revision: null, installation: null, recoveryRequired: null, writesAvailable: false })
    const none = readSwApplicationsView(await (await call(context({ catalog: null }), '/accounts/alice/applications?domainId=' + domain.id))!.json())
    expect(none.catalog.reason).toBe('not-configured'); expect(none.selected!.reason).toBe('application_catalog_unavailable')
  })
  it('refuses writes before any job when the provider is not admitted (no JSON-only success)', async () => {
    const ctx = context()
    const body = { domainId: domain.id, action: 'install', appId: 'sample', version: '1.2.3', expectedRevision: 'b'.repeat(64), expectedCatalogRevision: 'c'.repeat(64) }
    await expect(call(ctx, '/accounts/alice/applications/jobs', body)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, reason: 'application_provider_unavailable' } })
    expect(ctx.submitJob).not.toHaveBeenCalled(); expect(ctx.audit).not.toHaveBeenCalled()
    const fakeAdmission = context({ provider: { admission: { descriptorConfinement: true } } as never })
    await expect(call(fakeAdmission, '/accounts/alice/applications/jobs', body)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('pins owner, domain ownership and strict selectors', async () => {
    await expect(call(context(), '/accounts/bob/applications')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(context({ caller: { role: 'root', accountId: null } as never }), '/accounts/alice/applications')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(context(), '/accounts/alice/applications?domainId=33333333-3333-4333-8333-333333333333')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call(context(), '/accounts/alice/applications?path=/home')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(context({ currentPrincipal: async () => null }), '/accounts/alice/applications')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
