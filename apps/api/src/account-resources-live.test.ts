import { describe, expect, it } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { readLiveAccountResources } from './account-resources-live.ts'

const account: Account = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'alice',
  uid: 20001,
  gid: 20001,
  home: '/home/alice',
  primaryDomain: 'alice.example.test',
  planId: '22222222-2222-4222-8222-222222222222',
  ownerId: null,
  status: 'active',
  suspendReason: null,
  contactEmail: 'alice@example.test',
  ipv4: '192.0.2.10',
  shell: 'jailed',
  createdAt: '2026-11-01T00:00:00Z',
}
const plan = defaultPlan({ id: account.planId, name: 'Business' })
const ownerCaller = { principal: { kind: 'user', id: '33333333-3333-4333-8333-333333333333', username: 'alice', accountId: account.id } } as unknown as AuthenticatedCaller
const rootCaller = { principal: { kind: 'root', id: '44444444-4444-4444-8444-444444444444', username: 'root' } } as unknown as AuthenticatedCaller
const mailboxCaller = { principal: { kind: 'user', id: '55555555-5555-4555-8555-555555555555', username: 'info@alice.example.test', accountId: account.id } } as unknown as AuthenticatedCaller

function ports(usage: Awaited<ReturnType<Parameters<typeof readLiveAccountResources>[2]['readUsage']>>) {
  return {
    getAccount: async () => account,
    getPlan: async () => plan,
    listDomains: async () => [{ kind: 'primary' }, { kind: 'addon' }] as never,
    listServiceUsers: async () => [{ services: { email: true } }, { services: { email: false } }] as never,
    listDatabases: async () => [{ engine: 'mariadb', trashedAt: null }, { engine: 'mariadb', trashedAt: '2026-11-01T00:00:00Z' }] as never,
    readUsage: async () => usage,
    assertCanAccessAccount: async () => undefined,
    assertAccountFeatures: async () => undefined,
    now: () => new Date('2026-11-20T12:00:00.000Z'),
  }
}

describe('live account resources reader', () => {
  it('returns measured usage, plan limits, and counts for the authenticated owner', async () => {
    const result = await readLiveAccountResources(ownerCaller, new URL('http://panel.test/api/account/resources/live'), ports({
      phpVersion: '8.3',
      diskBytes: 2097152,
      memoryBytes: 67108864,
      processCount: 4,
      bandwidth: 'unmeasured',
      ioEnforced: true,
    }))
    expect(result.state).toBe('read')
    expect(result.observedAt).toBe('2026-11-20T12:00:00.000Z')
    expect(result.account.configuredSlice).toBe('xpanel-20001.slice')
    expect(result.plan?.name).toBe('Business')
    expect(result.usage?.diskBytes).toBe(2097152)
    expect(result.counts).toEqual({ addonDomains: 1, mailboxes: 1, mariadbDatabases: 1 })
  })

  it('reports unavailable honestly when the host agent returns no observation', async () => {
    const result = await readLiveAccountResources(ownerCaller, new URL('http://panel.test/api/account/resources/live'), ports(null))
    expect(result.state).toBe('unavailable')
    expect(result.usage).toBeNull()
  })

  it('forbids root, mailbox principals, and query selectors', async () => {
    await expect(readLiveAccountResources(rootCaller, new URL('http://panel.test/api/account/resources/live'), ports(null))).rejects.toThrow(/owner access/)
    await expect(readLiveAccountResources(mailboxCaller, new URL('http://panel.test/api/account/resources/live'), ports(null))).rejects.toThrow(/owner access/)
    await expect(readLiveAccountResources(ownerCaller, new URL('http://panel.test/api/account/resources/live?account=other'), ports(null))).rejects.toThrow(/query selectors/)
  })
})
