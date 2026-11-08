import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { handleEmailDiskUsageWorkspaceRoute } from './email-disk-usage-workspace.ts'
import { handleGitWorkspaceRoute } from './git-workspace.ts'

const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', planId: 'plan', status: 'active' } as Account
const caller = { principal: { kind: 'user', id: 'principal', username: 'alice', accountId: account.id }, principalRecord: {}, apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
function setup(disabled: string[] = []) {
  const readAgent = vi.fn(async () => ({ ok: true }))
  const ports = { store: { getAccount: async () => account, getPlan: async () => ({ featureListId: 'features' }), getFeatureList: async () => ({ disabled }) } as unknown as StateStore, requireCaller: async () => caller, readAgent } as unknown as AccountSshPorts
  return { ports, readAgent }
}
const mail = (ports: AccountSshPorts, path: string, method = 'GET', body?: unknown) => { const url = new URL('http://panel.test/api/account/email/disk-usage' + path); return handleEmailDiskUsageWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, ports) }
const git = (ports: AccountSshPorts, query: string, method = 'GET') => { const url = new URL('http://panel.test/api/account/git/view' + query); return handleGitWorkspaceRoute(new Request(url, { method }), url, method, ports) }
const cleanup = { mailbox: 'bob@example.com', folder: 'INBOX', preset: 'custom', query: 'LARGER 30M', confirmFolder: 'INBOX' }

describe('Email Disk Usage workspace', () => {
  it('forwards a read and a validated cleanup under the signed-in account', async () => {
    const { ports, readAgent } = setup()
    await mail(ports, '?mailbox=bob%40example.com'); await mail(ports, '/cleanup', 'POST', cleanup)
    expect(readAgent.mock.calls[0]).toEqual([caller, '/accounts/alice/email/disk-usage?mailbox=bob%40example.com', undefined, false, 'GET'])
    expect(readAgent.mock.calls[1]).toEqual([caller, '/accounts/alice/email/disk-usage/cleanup', cleanup, true, 'POST'])
  })
  it('refuses an empty search, a bad mailbox, a disabled feature and the wrong method before the agent', async () => {
    const { ports, readAgent } = setup()
    await expect(mail(ports, '/cleanup', 'POST', { ...cleanup, query: '' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(mail(ports, '?mailbox=*')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(mail(setup(['email-disk-usage']).ports, '?mailbox=bob%40example.com')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await mail(ports, '', 'POST'))!.status).toBe(405); expect(readAgent).not.toHaveBeenCalled()
  })
})

describe('Git viewer workspace', () => {
  it('forwards validated views only and accepts no mutating method', async () => {
    const { ports, readAgent } = setup()
    await git(ports, '?view=log&path=site&rev=main')
    expect(readAgent.mock.calls[0]).toEqual([caller, '/accounts/alice/git/view?view=log&path=site&rev=main', undefined, false, 'GET'])
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await git(ports, '?view=log&path=site', method))!.status).toBe(405)
    await expect(git(ports, '?view=log&path=../other')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(git(setup(['gitweb']).ports, '?view=log&path=site')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
