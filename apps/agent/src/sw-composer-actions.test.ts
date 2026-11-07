import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import { readComposerWorkspaceView } from '../../../packages/os/src/composer-command-view.ts'
import { handleComposerWorkspaceRoute } from './composer-workspace.ts'
import type { ComposerWorkspaceContext } from './composer-workspace.ts'

const account = { id: 'a', username: 'alpha', uid: 1001, gid: 1001, home: '/home/alpha', status: 'active', planId: 'plan' } as Account
const domain = { id: 'site-a', accountId: 'a', name: 'example.test', siteType: 'php', docRoot: '/home/alpha/public_html', suspended: false, php: { version: '8.3' } } as Domain
const context = (composerJobs: ComposerWorkspaceContext['composerJobs'], installed = true): ComposerWorkspaceContext => ({ assertRoot: async () => ({ actor: 'root' }), run: installed ? async () => ({ ok: true, stdout: 'Composer version 2.8.12 2024-01-01 00:00:00\n', stderr: '' }) : null, files: () => null, now: () => new Date('2026-10-27T00:00:00.000Z'), composerJobs,
  store: { listAccounts: async () => [account], listDomains: async () => [domain], getPlan: async () => ({ id: 'plan' }) as Plan, withAccountLifecycleLease: async (_id, operation) => operation(account) } })
const read = async (ctx: ComposerWorkspaceContext) => { const url = new URL('http://local/host/composer'); return readComposerWorkspaceView(await (await handleComposerWorkspaceRoute(new Request(url), url, 'GET', ctx))!.json()) }

describe('Composer job availability on the read view', () => {
  const services = { family: 'debian' as const, phpVersions: async () => ['8.3'], submitJob: vi.fn(), audit: vi.fn() }
  it('advertises install, update and a mirror only with Composer, a package family and the job runner', async () => {
    expect((await read(context(services))).actions).toEqual({ install: true, update: true, mirror: true, reason: null })
    for (const partial of [null, { ...services, family: null }, { ...services, submitJob: null }]) expect((await read(context(partial))).actions).toEqual({ install: false, update: false, mirror: false, reason: 'isolated-composer-runner-unavailable' })
    expect((await read(context(services, false))).actions.install).toBe(false)
  })
  it('the agent preview refuses with an unchanged-state precondition without a job runner', async () => {
    const url = new URL('http://local/host/composer/jobs/preview')
    const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'install', domainId: '11111111-2222-4333-8444-555555555555', phpVersion: null, mirror: null }) })
    await expect(handleComposerWorkspaceRoute(request, url, 'POST', context({ ...services, submitJob: null }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
})
