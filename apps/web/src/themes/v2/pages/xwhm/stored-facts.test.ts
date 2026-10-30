import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import type { Account, Reseller } from '@xpanel/core'
import type { WhmSurfaceProps } from '../../../contract.ts'
import { translator } from '../../../../i18n.ts'
import { whmStoredFacts } from './stored-facts.ts'
import { networkContext, type WhmNetworkAuthority } from './domains/common.ts'
import { renderV2WhmDomainsPage } from './domains/index.ts'
import { renderV2WhmResellers } from './resellers/index.ts'
import { adminContext } from './server/common.ts'

const root = { kind: 'root' as const, id: 'root', username: 'operator' }
const account: Account = { id: 'account', username: 'privateaccount', uid: 20001, gid: 20001, home: '/home/privateaccount', primaryDomain: 'private.test', planId: 'plan', ownerId: 'dealer', status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.1', shell: 'jailed', createdAt: '2026-10-30T00:00:00Z' }
const reseller: Reseller = { id: 'dealer', username: 'storeddealer', acl: ['list-accounts', 'manage-dns'], maxAccounts: 10, totalDiskMb: 10000, totalBandwidthMb: 10000, oversell: false, nameservers: ['ns.example.test'], delegatedIps: [] }
const props = (activeRoute: string, extra: Partial<WhmSurfaceProps> = {}): WhmSurfaceProps => ({ principal: root, visibility: { principal: root }, catalog: tools, activeRoute, ...extra })
const fact = (...ids: string[]): WhmNetworkAuthority => ({ presentation: 'read-only', canReadFacts: true, authorizedTools: new Set(ids), canRead: true, canManage: true })

describe('WHM supplied facts remain separate from native authority', () => {
  it('requires explicit fact grant, current catalog authorization, route and matching principal', () => {
    const p = props('/whm/domains')
    expect(whmStoredFacts(p, fact('list-accounts'), ['list-accounts'])).toBe(true)
    expect(whmStoredFacts(p, fact(), ['list-accounts'])).toBe(false)
    expect(whmStoredFacts({ ...p, catalog: [] }, fact('list-accounts'), ['list-accounts'])).toBe(false)
    expect(whmStoredFacts({ ...p, principal: { ...root, id: 'foreign' } }, fact('list-accounts'), ['list-accounts'])).toBe(false)
    expect(whmStoredFacts({ ...p, activeRoute: '/whm/not-registered' }, fact('list-accounts'), ['list-accounts'])).toBe(false)
  })
  it('does not use a facts flag or stale native flags to admit account collections or provider reads', () => {
    const denied = networkContext(props('/whm/domains', { accounts: [account] }), fact())
    expect(denied.accounts).toEqual([])
    expect(denied.canRead).toBe(false)
    expect(denied.canManage).toBe(false)
    const admitted = networkContext(props('/whm/domains', { accounts: [account] }), fact('list-accounts'))
    expect(admitted.accounts).toEqual([account])
    expect(admitted.canRead).toBe(false)
    expect(admitted.canManage).toBe(false)
  })
  it('filters reseller-owned accounts and refuses another collection tool', () => {
    const principal = { kind: 'reseller' as const, id: reseller.id, username: reseller.username }
    const p = props('/whm/domains', { principal, visibility: { principal, reseller }, activeReseller: reseller, accounts: [account, { ...account, id: 'foreign', ownerId: 'another' }] })
    expect(networkContext(p, fact('list-accounts')).accounts).toEqual([account])
    expect(networkContext(p, fact('dns-zone-manager')).accounts).toEqual([])
  })
  it('preserves the entire unknown domain workspace without native action admission', () => {
    const html = renderV2WhmDomainsPage(props('/whm/domains'), fact())
    expect(html).toContain('data-whm-domain-refresh')
    expect(html).toContain('data-default-site-form')
    expect(html).toContain('data-readonly="true"')
    expect(html).not.toContain('data-default-site-enabled="true"')
    expect(html).not.toContain('privateaccount')
  })
  it('does not let a reseller record grant expose account allocations or enable forms', () => {
    const html = renderV2WhmResellers(translator('en'), props('/whm/resellers', { resellers: [reseller], accounts: [account] }), { ...fact('reseller-center'), canChangeOwner: true })
    expect(html).toContain(reseller.username)
    expect(html).not.toContain(account.username)
    expect(html).not.toContain('data-reseller-create-form')
    expect(html).not.toContain('data-reseller-update-form')
    expect(html).toContain('data-workspace-mode="read-only"')
  })
  it('keeps root settings facts and native service observations independently gated', () => {
    const h = adminContext(translator('en'), props('/whm/server/setup'), fact('server-settings-edit'), '/whm/server/setup', 'server')
    expect(h.canReadFacts(['server-settings-edit'])).toBe(true)
    expect(h.canReadFacts(['theme-manager'])).toBe(false)
    expect(h.canRead).toBe(false)
    expect(h.canManage).toBe(false)
  })
})