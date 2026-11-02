import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import type { Account, Principal, Reseller } from '@xpanel/core'
import type { WhmSurfaceProps } from '../themes/contract.ts'
import type { SurfaceAuthority } from './theme-surface.ts'
import { accountFor, canCreate, readableAccounts } from './whm-account-access.ts'

const account: Account = { id: 'account-own', username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'alice.test', planId: 'plan-own', ownerId: 'dealer-own', status: 'active', suspendReason: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
const foreign: Account = { ...account, id: 'account-foreign', username: 'bob', ownerId: 'dealer-foreign' }
const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const root: Principal = { kind: 'root', id: 'root-fixture', username: 'operator' }
const props = (changes: Partial<WhmSurfaceProps> = {}): WhmSurfaceProps => ({ principal: root, visibility: { principal: root }, catalog, accounts: [account, foreign], ...changes })
type FactAuthority = Pick<SurfaceAuthority, 'presentation' | 'canReadFacts' | 'authorizedTools'>
const facts = (changes: Partial<FactAuthority> = {}): FactAuthority => ({ presentation: 'read-only', canReadFacts: true, authorizedTools: new Set(['list-accounts']), ...changes })
const principal: Principal = { kind: 'reseller', id: 'dealer-own', username: 'dealer' }
const reseller: Reseller = { id: principal.id, username: principal.username, acl: ['list-accounts'], maxAccounts: 10, totalDiskMb: 10000, totalBandwidthMb: 10000, oversell: false, nameservers: [], delegatedIps: [] }

describe('operator account stored-fact access', () => {
  it('keeps the normal qualified read and account lookup unchanged', () => {
    expect(readableAccounts(props())).toEqual([account, foreign])
    expect(accountFor(props(), 'alice')).toEqual(account)
    expect(canCreate(props())).toBe(true)
    expect(readableAccounts(props({ catalog: [] }))).toBeUndefined()
    expect(accountFor(props({ capabilityUnavailable: true }), 'alice')).toBeUndefined()
    expect(accountFor(props(), '../alice')).toBeUndefined()
  })
  it('accepts explicit authorized read-only facts without granting a provider or mutation lookup', () => {
    const unavailable = props({ catalog: [], capabilityUnavailable: true })
    expect(readableAccounts(unavailable, facts())).toEqual([account, foreign])
    expect(accountFor(unavailable, 'alice')).toBeUndefined()
    expect(canCreate(unavailable)).toBe(false)
  })
  it('never falls back to a qualified catalog when read-only facts or tool authority are denied', () => {
    for (const authority of [facts({ canReadFacts: false }), facts({ authorizedTools: new Set() }), facts({ canReadFacts: false, authorizedTools: new Set() })]) {
      expect(readableAccounts(props(), authority)).toBeUndefined()
    }
  })
  it('does not let live fact flags bypass the unchanged native qualification gate', () => {
    expect(readableAccounts(props({ catalog: [] }), facts({ presentation: 'live' }))).toBeUndefined()
    expect(readableAccounts(props(), facts({ presentation: 'live', canReadFacts: false, authorizedTools: new Set() }))).toEqual([account, foreign])
  })
  it('retains reseller ownership and rejects missing account-list ACL despite explicit fact authority', () => {
    const owned = props({ principal, visibility: { principal, reseller }, activeReseller: reseller, catalog: [], capabilityUnavailable: true })
    expect(readableAccounts(owned, facts())).toEqual([account])
    expect(readableAccounts({ ...owned, accounts: [foreign] }, facts())).toEqual([])
    expect(readableAccounts({ ...owned, visibility: { principal, reseller: { ...reseller, acl: [] } }, activeReseller: { ...reseller, acl: [] } }, facts())).toBeUndefined()
  })
  it('rejects user and missing principals even with explicit fact authority', () => {
    const user: Principal = { kind: 'user', id: 'user-fixture', username: account.username, accountId: account.id }
    expect(readableAccounts(props({ principal: user, visibility: { principal: user } }), facts())).toBeUndefined()
    expect(readableAccounts(props({ principal: undefined, visibility: undefined }), facts())).toBeUndefined()
  })
  it('preserves absent account facts separately from an observed empty collection', () => {
    expect(readableAccounts(props({ accounts: undefined }), facts())).toBeUndefined()
    expect(readableAccounts(props({ accounts: [] }), facts())).toEqual([])
  })
})