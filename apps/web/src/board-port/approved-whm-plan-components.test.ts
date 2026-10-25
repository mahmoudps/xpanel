import { describe, expect, it } from 'vitest'
import { qualifyHostTools, tools } from '@xpanel/catalog'
import { defaultPlan, type Account, type Reseller, type ResellerAcl } from '@xpanel/core'
import type { WhmSurfaceProps } from '../surfaces/xwhm.ts'
import { approvedWhmPlanImpact, renderApprovedWhmFeatureListSupplement, renderApprovedWhmPlanSupplement } from './approved-whm-plan-components.ts'

const root = { kind: 'root' as const, id: 'private-root-key', username: 'administrator7' }
const catalog = qualifyHostTools(tools, { executor: 'linux', probes: { 'control-plane': 'passed' } })
const owned = defaultPlan({ id: 'private-plan-one', name: 'Configured plan7', ownerId: 'owner-key', featureListId: 'private-list-own' })
const otherPlan = defaultPlan({ id: 'private-plan-two', name: 'Other plan7', ownerId: 'other-key', featureListId: 'private-list-other' })
const first: Account = {
  id: 'private-account-one', username: 'account7', uid: 1007, gid: 1007, home: '/home/account7',
  primaryDomain: 'account7.example.test', planId: owned.id, ownerId: 'owner-key', status: 'active', suspendReason: null,
  contactEmail: 'account7@example.test', ipv4: '192.0.2.7', shell: 'none', createdAt: '2026-01-01T00:00:00.000Z',
}
const second: Account = { ...first, id: 'private-account-two', username: 'account8', primaryDomain: 'account8.example.test' }
const foreign: Account = { ...first, id: 'private-account-foreign', username: 'foreign7', primaryDomain: 'foreign7.example.test', planId: otherPlan.id, ownerId: 'other-key' }
const base = (): WhmSurfaceProps => ({ principal: root, catalog, locale: 'en', plans: [owned, otherPlan], accounts: [first, second, foreign] })
const reseller = (acl: ResellerAcl[]): WhmSurfaceProps => ({ ...base(), principal: { kind: 'reseller', id: 'owner-key', username: 'provider7' }, activeReseller: { id: 'owner-key', username: 'provider7', acl, maxAccounts: 10, totalDiskMb: 1024, totalBandwidthMb: 1024, oversell: false, nameservers: [], delegatedIps: [] } satisfies Reseller })
const featureBase = (): WhmSurfaceProps => ({ ...base(), featureLists: [
  { id: 'private-list-own', name: 'Owned source7', ownerId: 'owner-key', disabled: ['SSL/TLS', 'popaccts (Email Accounts)', 'SSL/TLS', 'Email Filtering Manager'] },
  { id: 'private-list-shared', name: 'Shared source7', ownerId: null, disabled: [] },
  { id: 'private-list-other', name: 'Other source7', ownerId: 'other-key', disabled: ['SSL/TLS'] },
] })
const textOnly = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '')

describe('approved plan impact and draft components', () => {
  it('counts exact persisted assignments without inferring usage or live cap enforcement', () => {
    expect(approvedWhmPlanImpact(base())).toEqual({ state: 'read', accountsRead: true, rows: [
      { name: owned.name, accountCount: 2, accounts: [{ username: first.username, primaryDomain: first.primaryDomain }, { username: second.username, primaryDomain: second.primaryDomain }] },
      { name: otherPlan.name, accountCount: 1, accounts: [{ username: foreign.username, primaryDomain: foreign.primaryDomain }] },
    ] })
    const html = renderApprovedWhmPlanSupplement(base())
    expect(html).toContain('Observed cap compliance')
    expect(html).toContain('Current usage and over-cap accounts have not been observed')
    expect(html).not.toMatch(/aria-valuenow|role="meter"/)
    expect(textOnly(html)).not.toMatch(/(?:^|[\s>])0%|within the caps/)
    for (const id of [owned.id, first.id, root.id]) expect(textOnly(html)).not.toContain(id)
  })

  it('distinguishes missing assignments from a real empty assignment snapshot', () => {
    expect(approvedWhmPlanImpact({ ...base(), accounts: undefined }).rows.map(row => row.accountCount)).toEqual([undefined, undefined])
    expect(approvedWhmPlanImpact({ ...base(), accounts: [] }).rows.map(row => row.accountCount)).toEqual([0, 0])
    expect(renderApprovedWhmPlanSupplement({ ...base(), accounts: undefined })).toContain('Account assignments have not been read')
    expect(renderApprovedWhmPlanSupplement({ ...base(), accounts: undefined })).not.toContain('>0<')
  })

  it('limits impact to the authorized selected edit plan', () => {
    const model = approvedWhmPlanImpact({ ...base(), planEditorState: { kind: 'edit', plan: owned } })
    expect(model.rows.map(row => row.name)).toEqual([owned.name])
    expect(model.rows[0]?.accountCount).toBe(2)
  })

  it('scopes reseller plans and account assignments independently', () => {
    const model = approvedWhmPlanImpact(reseller(['manage-plans', 'list-accounts']))
    expect(model.rows.map(row => row.name)).toEqual([owned.name])
    expect(model.rows[0]?.accounts.map(account => account.username)).toEqual([first.username, second.username])
    const html = renderApprovedWhmPlanSupplement(reseller(['manage-plans', 'list-accounts']))
    expect(html).not.toContain(foreign.primaryDomain)
    expect(html).not.toContain(otherPlan.name)
  })

  it('does not expose account assignments to a reseller without list-accounts', () => {
    const model = approvedWhmPlanImpact(reseller(['manage-plans']))
    expect(model.accountsRead).toBe(false)
    expect(model.rows[0]?.accountCount).toBeUndefined()
    expect(model.rows[0]?.accounts).toEqual([])
    expect(renderApprovedWhmPlanSupplement(reseller(['manage-plans']))).not.toContain(first.primaryDomain)
  })

  it('does not accept a foreign edit-plan object as reseller authority', () => {
    expect(approvedWhmPlanImpact({ ...reseller(['manage-plans', 'list-accounts']), planEditorState: { kind: 'edit', plan: otherPlan } }).rows).toEqual([])
  })

  it('keeps every missing summary component without claiming an unsent draft matches saved state', () => {
    const html = renderApprovedWhmPlanSupplement(base())
    for (const label of ['Impact', 'Unsaved changes', 'Discard changes', 'How saving applies']) expect(html).toContain(label)
    expect(html).toContain('No browser draft comparison is available')
    expect(html).toMatch(/<button[^>]*disabled>Discard changes/)
    expect(html).not.toMatch(/Nothing to save|Sites.*keep running|All slices updated|<h1|<form/)
  })
})

describe('approved feature-list duplication and draft components', () => {
  it('uses the existing create binding with a required blank new name and the exact distinct persisted keys', () => {
    const html = renderApprovedWhmFeatureListSupplement(featureBase())
    const firstDetails = html.slice(html.indexOf('data-feature-list-duplicate="0"'), html.indexOf('data-feature-list-duplicate="1"'))
    expect(firstDetails).toContain('data-feature-list-create-form data-feature-list-duplicate-form')
    expect(firstDetails).toMatch(/name="name" type="text" value="" required maxlength="128"/)
    for (const key of ['SSL/TLS', 'popaccts (Email Accounts)', 'Email Filtering Manager']) expect(firstDetails.match(new RegExp(`value="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'))).toHaveLength(1)
    expect(firstDetails.match(/name="disabled"/g)).toHaveLength(3)
    expect(firstDetails.match(/type="checkbox"[^>]*checked/g)).toHaveLength(3)
    expect(firstDetails).toContain('type="reset"')
    expect(firstDetails).not.toContain('data-feature-list-update-form')
    expect(textOnly(firstDetails)).not.toContain('private-list-own')
  })

  it('represents a known empty disabled set without inventing feature membership', () => {
    const html = renderApprovedWhmFeatureListSupplement({ ...featureBase(), featureLists: [{ id: 'shared', name: 'Empty copy source', ownerId: null, disabled: [] }] })
    expect(html).toContain('data-feature-list-create-form')
    expect(html).toContain('saved list has no disabled feature keys')
    expect(html).not.toContain('name="disabled"')
  })

  it('prevents copies with unknown legacy keys so restrictions cannot disappear', () => {
    const html = renderApprovedWhmFeatureListSupplement({ ...featureBase(), featureLists: [{ id: 'legacy', name: 'Legacy copy source', ownerId: null, disabled: ['SSL/TLS', 'unsupported legacy flag'] }] })
    expect(html).not.toContain('<form')
    expect(html).toContain('legacy feature key that the create operation does not support')
    expect(html).toMatch(/value="unsupported legacy flag" checked disabled/)
    expect(html).toMatch(/type="submit"[^>]*disabled>Duplicate list/)
  })

  it('leaves an unread membership unavailable rather than copying an assumed empty set', () => {
    const html = renderApprovedWhmFeatureListSupplement({ ...featureBase(), featureLists: [{ id: 'unread', name: 'Unread copy source', ownerId: null }] })
    expect(html).not.toContain('<form')
    expect(html).toContain('Feature membership has not been read')
    expect(html).not.toContain('saved list has no disabled feature keys')
  })

  it('permits copies of visible own/shared lists while excluding another reseller’s list', () => {
    const html = renderApprovedWhmFeatureListSupplement({ ...reseller(['manage-feature-lists']), featureLists: featureBase().featureLists })
    expect(html).toContain('Owned source7')
    expect(html).toContain('Shared source7')
    expect(html).not.toContain('Other source7')
    expect(html.match(/<form\b/g)).toHaveLength(2)
  })

  it('requires both real feature-list status and delivery qualification for new create forms', () => {
    const unqualified = catalog.map(tool => tool.id === 'feature-list-crud' ? { ...tool, delivery: { ...tool.delivery, status: 'researched' as const } } : tool)
    const html = renderApprovedWhmFeatureListSupplement({ ...featureBase(), catalog: unqualified })
    expect(html).not.toContain('<form')
    expect(html).not.toContain('Owned source7')
    expect(html).toContain('Copying is unavailable')
  })

  it('retains Unsaved/Discard with an honest scope and unique IDs across duplicate forms', () => {
    const html = renderApprovedWhmFeatureListSupplement(featureBase())
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
    expect(new Set(ids).size).toBe(ids.length)
    expect(html).toContain('Unsaved changes')
    expect(html).toContain('Global draft discard is unavailable')
    expect(html).not.toContain('Every switch matches')
    expect(html).not.toContain('<h1')
  })
})

describe('supplement boundaries and localized output', () => {
  it('discards all supplied DTOs and actions when capabilityUnavailable is explicit', () => {
    const props = { ...featureBase(), capabilityUnavailable: true }
    for (const html of [renderApprovedWhmPlanSupplement(props), renderApprovedWhmFeatureListSupplement(props)]) {
      expect(html).not.toMatch(/<form|Configured plan7|Owned source7|account7\.example\.test/)
      expect(html).toContain('Unsaved changes')
    }
  })

  it('does not use a display username or absent principal as role authority', () => {
    for (const principal of [undefined, { kind: 'user' as const, id: 'user', username: 'root', accountId: 'account' }]) {
      expect(renderApprovedWhmPlanSupplement({ ...base(), principal })).toBe('')
      expect(renderApprovedWhmFeatureListSupplement({ ...featureBase(), principal })).toBe('')
    }
  })

  it('does not qualify an operation merely because catalog is omitted', () => {
    expect(approvedWhmPlanImpact({ ...base(), catalog: undefined }).state).toBe('unread')
    expect(renderApprovedWhmFeatureListSupplement({ ...featureBase(), catalog: undefined })).not.toContain('<form')
  })

  it.each(['en', 'ar'] as const)('escapes dynamic names and preserves ASCII numerals and isolated technical values in %s', locale => {
    const props = { ...featureBase(), locale, plans: [{ ...owned, name: '<b>Plan٧</b>' }], featureLists: [{ id: 'private-list-key', name: '<img src=x onerror=alert(1)>٧', ownerId: null, disabled: ['SSL/TLS'] }] }
    const html = renderApprovedWhmPlanSupplement(props) + renderApprovedWhmFeatureListSupplement(props)
    expect(html).not.toMatch(/<img|<b>Plan|[\u0660-\u0669\u06f0-\u06f9]/)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;7')
    expect(html).toMatch(/<bdi[^>]*>account7\.example\.test<\/bdi>/)
  })
})
