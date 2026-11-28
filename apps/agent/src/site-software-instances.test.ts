import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { applicationDigest } from '../../../packages/os/src/application-artifact.ts'
import { applicationCatalogSigningBytes, verifyApplicationCatalog } from './application-catalog.ts'
import { applicationInstanceKey } from './application-provider.ts'
import type { ApplicationInstanceRecord } from './application-provider.ts'
import { handleSiteSoftwareInstancesRoute } from './site-software-instances.ts'
import type { SiteSoftwareInstancesContext } from './site-software-instances.ts'

const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', planId: 'plan', status: 'active', uid: 2001, gid: 2001, home: '/home/alice' } as Account
const domain = { id: '22222222-2222-4222-8222-222222222222', accountId: account.id, name: 'a.example', docRoot: '/home/alice/public_html', suspended: false } as Domain
const record: ApplicationInstanceRecord = { domain: 'a.example', path: 'blog', appId: 'sample', version: '1.0.0', previousVersion: null, artifactSha256: 'a'.repeat(64), database: { name: 'alice_app1', user: 'alice_app1' }, config: null, updatedAt: '2026-11-07T12:00:00.000Z', revision: 'b'.repeat(64), key: applicationInstanceKey('public_html/blog') }
const descriptor = { format: 'xpanel-files-v1', sha256: 'c'.repeat(64), bytes: 3 }
const context = (overrides: Partial<SiteSoftwareInstancesContext> = {}): SiteSoftwareInstancesContext => ({
  authenticate: async () => ({ actor: 'root', role: 'root', principalId: 'root-id' }),
  store: { getAccountByUsername: async name => name === 'alice' ? account : null, listAccounts: async () => [account], listDomains: async () => [domain], getPlan: async () => ({ featureListId: 'f' }) as Plan, getFeatureList: async () => ({ disabled: [] }) as unknown as FeatureList, withAccountLifecycleLease: (async (_id: string, work: (fresh: Account) => unknown) => work(account)) as never },
  source: { catalog: async () => ({ applications: [{ id: 'sample', name: 'Sample', releases: [{ version: '1.0.0', minimumPanelVersion: '1.0.0', artifact: descriptor }] }] }) } as never,
  provider: null, database: null, coordinator: null, artifacts: { has: async () => false, append: vi.fn(async () => ({ received: 3, complete: true })) }, instances: async () => [record], submitJob: vi.fn(), audit: vi.fn(async () => {}), ...overrides,
})
const call = (ctx: SiteSoftwareInstancesContext, path: string, body?: unknown) => { const url = new URL('http://agent.local' + path); return handleSiteSoftwareInstancesRoute(new Request(url, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), url, body === undefined ? 'GET' : 'POST', ctx) }

describe('host site software instances', () => {
  it('lists each account copy by domain and path, and drops a record whose name does not match its directory', async () => {
    const reply = await (await call(context(), '/host/site-software/instances'))!.json() as { instances: Record<string, unknown>[] }
    expect(reply.instances).toEqual([{ username: 'alice', accountId: account.id, domainId: domain.id, domain: 'a.example', path: 'blog', appId: 'sample', version: '1.0.0', previousVersion: null, database: 'alice_app1', updatedAt: record.updatedAt, revision: record.revision, accountStatus: 'active' }])
    const forged = await (await call(context({ instances: async () => [{ ...record, key: applicationDigest('other').slice(0, 32) }] }), '/host/site-software/instances'))!.json() as { instances: unknown[] }
    expect(forged.instances).toEqual([])
  })
  it('is root only, strict about its body and refuses a job for a row that changed', async () => {
    await expect(call(context({ authenticate: async () => ({ actor: 'bob', role: 'reseller', principalId: 'r' }) }), '/host/site-software/instances')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const body = { username: 'alice', domainId: domain.id, path: 'blog', action: 'remove', expectedRecord: record.revision }
    await expect(call(context(), '/host/site-software/instances/jobs', { ...body, extra: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(context(), '/host/site-software/instances/jobs', { ...body, action: 'install' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(context(), '/host/site-software/instances/jobs', body)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'application_provider_unavailable' } })
    expect((await call(context(), '/host/site-software/instances?x=1').catch(error => error)).code).toBe('VALIDATION')
  })
  it('accepts a release chunk only for a release of the signed catalog', async () => {
    const ctx = context(), body = { appId: 'sample', version: '1.0.0', offset: 0, contentBase64: 'AQID' }
    expect(await (await call(ctx, '/host/site-software/artifacts', body))!.json()).toEqual({ received: 3, complete: true, bytes: 3 })
    expect(ctx.artifacts!.append).toHaveBeenCalledWith(descriptor, 'sample', '1.0.0', 0, Buffer.from([1, 2, 3]))
    expect(ctx.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.site_software.artifact_stored', outcome: 'ok' }))
    await expect(call(ctx, '/host/site-software/artifacts', { ...body, version: '9.9.9' })).rejects.toMatchObject({ code: 'NOT_FOUND', detail: { reason: 'application_not_in_catalog' } })
    await expect(call(ctx, '/host/site-software/artifacts', { ...body, contentBase64: 'AQ' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(ctx, '/host/site-software/artifacts', { ...body, offset: -1 })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('dispatches one-click deploy and app-installer install jobs through the real coordinator', async () => {
    const rev = 'e'.repeat(64)
    const job = { id: '44444444-4444-4444-8444-444444444444', kind: 'application.install', accountId: account.id, status: 'queued' }
    const submitJob = vi.fn(async () => job)
    const coordinator = { prepare: vi.fn(async () => ({ plan: { kind: 'application.install' }, discardUnstarted: () => true })) } as unknown as NonNullable<SiteSoftwareInstancesContext['coordinator']>
    const provider = {
      admission: {
        descriptorConfinement: true, accountLifetimeFence: true, durablePreimages: true,
        scopedWrites: true, digestReadback: true, boundedDeadlines: true, contentAddressedEgress: true,
      },
      readArtifact: vi.fn(),
      openTarget: vi.fn(),
      pendingTransactions: vi.fn(),
    } as unknown as NonNullable<SiteSoftwareInstancesContext['provider']>
    const ctx = context({ coordinator, provider, submitJob: submitJob as unknown as NonNullable<SiteSoftwareInstancesContext['submitJob']> })

    for (const [endpoint, action] of [['/host/software/one-click/deploy', 'server.one_click.job_submitted'], ['/host/software/app-installer/install', 'server.app_installer.job_submitted']] as const) {
      const payload = {
        accountId: account.id, username: 'alice', domainId: domain.id, docRoot: domain.docRoot, path: 'blog',
        appId: 'sample', version: '1.0.0', expectedRevision: rev, expectedCatalogRevision: rev,
      }
      const res = await call(ctx, endpoint, payload)
      expect(res?.status).toBe(202)
      expect(await res?.json()).toEqual({ job })
      expect(ctx.audit).toHaveBeenCalledWith(expect.objectContaining({ action, target: 'account:alice', outcome: 'ok' }))
    }
    await expect(call(ctx, '/host/software/one-click/deploy', {
      accountId: '99999999-9999-4999-8999-999999999999', username: 'alice', domainId: domain.id, docRoot: domain.docRoot,
      path: '', appId: 'sample', version: '1.0.0', expectedRevision: rev, expectedCatalogRevision: rev,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reads observed application target revision on GET /host/site-software/target', async () => {
    const TARGET_REV = 'f'.repeat(64)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const payload = JSON.stringify({
      schemaVersion: 1,
      sequence: 1,
      issuedAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2026-11-25T00:00:00.000Z',
      applications: [{ id: 'sample', name: 'Sample', releases: [{ version: '1.0.0', minimumPanelVersion: '1.0.0', artifact: descriptor }] }],
    })
    const signature = sign(null, applicationCatalogSigningBytes(payload), privateKey).toString('hex')
    const policy = { now: new Date('2026-11-10T00:00:00.000Z'), minimumSequence: 1, panelVersion: '1.0.0' }
    const verifiedCatalog = verifyApplicationCatalog({ keyId: 'test-key', payload, signature }, [{ keyId: 'test-key', publicKeyPem }], policy)
    const provider = {
      admission: {
        descriptorConfinement: true, accountLifetimeFence: true, durablePreimages: true,
        scopedWrites: true, digestReadback: true, boundedDeadlines: true, contentAddressedEgress: true,
      },
      readArtifact: vi.fn(),
      openTarget: vi.fn(async (target: unknown) => ({
        target,
        observe: vi.fn(async () => ({
          empty: true,
          managedClean: true,
          recoveryRequired: false,
          installation: null,
          unmanagedRevision: TARGET_REV,
          revision: TARGET_REV,
        })),
        close: vi.fn(async () => undefined),
      })),
      pendingTransactions: vi.fn(async () => []),
    } as unknown as NonNullable<SiteSoftwareInstancesContext['provider']>
    const coordinator = { prepare: vi.fn() } as unknown as NonNullable<SiteSoftwareInstancesContext['coordinator']>
    const source = {
      catalog: async () => verifiedCatalog,
      removalCatalog: async () => verifiedCatalog,
      policy: () => policy,
    } as unknown as NonNullable<SiteSoftwareInstancesContext['source']>
    const ctx = context({ source, provider, coordinator, submitJob: vi.fn() as unknown as NonNullable<SiteSoftwareInstancesContext['submitJob']> })
    const res = await call(ctx, `/host/site-software/target?username=alice&domainId=${domain.id}&path=blog`)
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({
      state: 'read',
      reason: null,
      revision: TARGET_REV,
      catalogRevision: verifiedCatalog.revision,
      installation: null,
      writesAvailable: true,
    })
  })
})
