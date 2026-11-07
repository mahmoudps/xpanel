import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { applicationDigest } from '../../../packages/os/src/application-artifact.ts'
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
})
