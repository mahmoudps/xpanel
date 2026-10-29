import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import { readComposerWorkspaceView } from '../../../packages/os/src/composer-command-view.ts'
import { handleComposerWorkspaceRoute } from './composer-workspace.ts'
import type { ComposerWorkspaceContext } from './composer-workspace.ts'
import type { ComposerJobProvider } from './composer-job-provider.ts'

const H = (value: string): string => createHash('sha256').update(value).digest('hex')
const account = { id: 'a', username: 'alpha', uid: 1001, gid: 1001, home: '/home/alpha', status: 'active', planId: 'plan' } as Account
const domain = { id: 'site-a', accountId: 'a', name: 'example.test', siteType: 'php', docRoot: '/home/alpha/public_html', suspended: false, php: { version: '8.3' } } as Domain
const qualified = { qualification: { protocol: 1, native: true, helperSha256: H('helper'), sourcePolicyRevision: H('policy'), descriptorConfined: true, numericAccountIdentity: true, lifecycleFencing: true, isolatedStaging: true, offlineExecution: true, approvedArtifactDigests: true, resourceLimits: true, durableSnapshotRecovery: true, completeOwnershipReadback: true, sanitizedOutput: true },
  observe: vi.fn(), resolve: vi.fn(), prepare: vi.fn(), recover: vi.fn(), close: vi.fn() } as unknown as ComposerJobProvider
const context = (composerJobs: ComposerWorkspaceContext['composerJobs']): ComposerWorkspaceContext => ({ assertRoot: async () => ({ actor: 'root' }), run: null, files: () => null, now: () => new Date('2026-10-28T00:00:00.000Z'), composerJobs,
  store: { listAccounts: async () => [account], listDomains: async () => [domain], getPlan: async () => ({ id: 'plan' }) as Plan, withAccountLifecycleLease: async (_id, operation) => operation(account) } })
const read = async (ctx: ComposerWorkspaceContext) => { const url = new URL('http://local/host/composer'); return readComposerWorkspaceView(await (await handleComposerWorkspaceRoute(new Request(url), url, 'GET', ctx))!.json()) }

describe('Composer job availability on the read view', () => {
  it('advertises install/update only with a qualified provider, a package family and the job runner', async () => {
    const services = { provider: qualified, family: 'debian' as const, submitJob: vi.fn(), audit: vi.fn() }
    expect((await read(context(services))).actions).toEqual({ install: true, update: true, mirror: false, reason: null })
    for (const partial of [null, { ...services, provider: null }, { ...services, family: null }, { ...services, submitJob: null }, { ...services, provider: { ...qualified, qualification: { ...qualified.qualification, offlineExecution: false } } as unknown as ComposerJobProvider }])
      expect((await read(context(partial))).actions).toEqual({ install: false, update: false, mirror: false, reason: 'isolated-composer-runner-unavailable' })
  })
  it('the agent preview refuses with an unchanged-state precondition when no provider is wired', async () => {
    const url = new URL('http://local/host/composer/jobs/preview')
    const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'install', domainId: '11111111-2222-4333-8444-555555555555' }) })
    await expect(handleComposerWorkspaceRoute(request, url, 'POST', context({ provider: null, family: 'debian', submitJob: vi.fn(), audit: vi.fn() }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
})
