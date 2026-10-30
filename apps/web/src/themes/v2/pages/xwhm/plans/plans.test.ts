import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import { defaultPlan, type Account, type Plan, type Reseller } from '@xpanel/core'
import { translator } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { renderV2WhmPlans } from './plans.ts'
import { renderV2WhmFeatures } from './features.ts'
import { renderV2WhmEnhancements } from './enhancements.ts'
import { renderV2PlanEditor } from './editor.ts'
import type { WhmPlanAuthority } from './common.ts'

const root = { kind: 'root' as const, id: '10000000-0000-4000-8000-000000000001', username: 'operator' }
const reseller: Reseller = { id: '10000000-0000-4000-8000-000000000002', username: 'provider', acl: ['manage-plans', 'manage-feature-lists'], maxAccounts: 10, totalDiskMb: 10000, totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [] }
const plan: Plan = { ...defaultPlan({ id: '20000000-0000-4000-8000-000000000001', name: 'Saved plan', featureListId: '30000000-0000-4000-8000-000000000001' }), resources: { ...defaultPlan().resources, maxProcesses: 'unlimited' } }
const account: Account = { id: '40000000-0000-4000-8000-000000000001', username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', primaryDomain: 'alice.example.test', planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.1', shell: 'jailed', createdAt: '2026-01-01T00:00:00Z' }
const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const props = (overrides: Partial<WhmSurfaceProps> = {}): WhmSurfaceProps => ({ locale: 'en', principal: root, catalog, plans: [plan], featureLists: [{ id: plan.featureListId, name: 'Saved features', ownerId: null, disabled: [] }], accounts: [account], ...overrides })
const authority: WhmPlanAuthority = { canRead: true, canManage: true, allowUnlimited: true, ownerId: null, canReadAccounts: true }
const t = translator('en')

describe('v2 plan family', () => {
  it('hides supplied private records and never mounts mutation forms without read authority', () => {
    const html = renderV2WhmPlans(t, props())
    expect(html).not.toContain('Saved plan')
    expect(html).not.toContain('Saved features')
    expect(html).not.toContain('data-plan-delete="')
    expect(html).toContain('data-plan-editable="false"')
    const isolated = renderV2PlanEditor(t, props(), { ...authority, canRead: false }, plan, true)
    expect(isolated).not.toContain('Saved plan')
    expect(isolated).not.toContain(`data-plan-id="${plan.id}"`)
    expect(isolated).toContain('data-plan-editable="false"')
  })
  it('preserves every native resource, service cap, unlimited switch and save-status control', () => {
    const html = renderV2WhmPlans(t, props({ planEditorState: { kind: 'edit', plan } }), authority)
    for (const key of [...Object.keys(plan.resources), ...Object.keys(plan.caps), 'defaultMailboxQuotaMb']) {
      expect(html, key).toContain(`name="${key}"`)
      expect(html, key).toContain(`data-plan-unlimited="${key}"`)
    }
    for (const hook of ['data-native-plan-editor', 'data-native-plan-status', 'data-native-plan-save', 'data-plan-owner', 'data-plan-delete-dialog', 'data-dialog-status', 'data-dialog-cancel']) expect(html).toContain(hook)
    expect(html).toContain('name="unlimited.maxProcesses" data-plan-unlimited="maxProcesses" checked')
    expect(html).toContain(String.raw`pattern="[A-Za-z0-9](?:[A-Za-z0-9 _.\-]{0,62}[A-Za-z0-9_.\-])?"`)
    expect(html).not.toContain('type="reset"')
    expect(html).toContain(`planId=${plan.id}`)
  })
  it('never substitutes a foreign requested plan into an authorized reseller editor', () => {
    const html = renderV2WhmPlans(t, props({ principal: { kind: 'reseller', id: reseller.id, username: reseller.username }, activeReseller: reseller, plans: [], planEditorState: { kind: 'edit', plan } }), { ...authority, ownerId: reseller.id })
    expect(html).toContain('The requested plan is unavailable.')
    expect(html).not.toContain(`data-plan-id="${plan.id}"`)
    expect(html).not.toContain('Saved plan')
  })
  it('distinguishes unread assignments from measured empty assignments', () => {
    expect(renderV2WhmPlans(t, props({ accounts: undefined }), authority)).toContain('Account assignments have not been read.')
    expect(renderV2WhmPlans(t, props({ accounts: [] }), authority)).toContain('No assigned accounts were returned in this snapshot.')
    expect(renderV2WhmPlans(t, props(), authority)).toContain('Current usage and over-cap accounts have not been observed.')
  })
  it('escapes saved plan and feature-list text while retaining the actual stored values', () => {
    const hostile = { ...plan, name: '<script>bad()</script>' }
    const html = renderV2WhmPlans(t, props({ plans: [hostile], planEditorState: { kind: 'edit', plan: hostile } }), authority)
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toContain('<script>bad()')
    expect(html).toContain('name="maxProcesses"')
  })
  it('uses valid associated list forms without inverting the API disabled-membership contract', () => {
    const item = catalog.find(tool => tool.featureKey)!
    const html = renderV2WhmFeatures(t, props({ featureLists: [{ id: plan.featureListId, name: 'Saved features', ownerId: null, disabled: [item.featureKey!] }] }), authority)
    expect(html).toContain('data-feature-list-update-form')
    expect(html).toContain('data-feature-list-create-form')
    expect(html).toContain(`name="disabled" value="${item.featureKey}" form="v2-feature-form-0"`)
    expect(html).toMatch(new RegExp(`value="${item.featureKey}" form="v2-feature-form-0"[^>]* checked`))
    expect(html).toContain('Checked controls disable the named tool.')
  })
  it('preserves an unread feature membership instead of treating it as all enabled', () => {
    const html = renderV2WhmFeatures(t, props({ featureLists: [{ id: plan.featureListId, name: 'Unread features', ownerId: null }] }), authority)
    expect(html).toContain('Feature membership has not been read. Reload this list before editing its tools.')
    expect(html).not.toContain('data-feature-list-update-form')
    expect(html).not.toContain('data-feature-list-duplicate-form')
  })
  it('keeps unsupported legacy keys from silently disappearing during duplication', () => {
    const html = renderV2WhmFeatures(t, props({ featureLists: [{ id: plan.featureListId, name: 'Legacy features', ownerId: null, disabled: ['legacy-private-key'] }] }), authority)
    expect(html).toContain('legacy-private-key')
    expect(html).not.toContain('data-feature-list-duplicate-form')
    expect(html).toContain('Copying is unavailable until every saved feature key can be retained')
  })
  it('retains enhancement controls and explicitly states that stored entitlements do not alter account limits', () => {
    const html = renderV2WhmEnhancements(t, props(), authority)
    for (const name of ['id', 'label', 'kind', 'min', 'max', 'assign-scope', 'assign-target', 'assign-enhancement', 'assign-value', 'limit-reseller', 'limit-enhancement', 'limit-value']) expect(html).toContain(`data-acct-enh-input="${name}"`)
    for (const name of ['definition', 'assignment', 'limit']) expect(html).toContain(`data-acct-enh-form="${name}"`)
    expect(html).toContain('Saving here changes no account limit.')
    expect(html).toContain('data-state="unread"')
  })
  it('never grants root-only enhancement operations to a reseller presentation', () => {
    const html = renderV2WhmEnhancements(t, props({ principal: { kind: 'reseller', id: reseller.id, username: reseller.username }, activeReseller: reseller }), authority)
    expect(html).toContain('data-enh-can-manage="false"')
    expect(html).not.toContain('<form')
  })
})


describe('v2 stored plan facts remain separate from native reads', () => {
  const stored: WhmPlanAuthority = { ...authority, presentation: 'read-only', canRead: false, canReadFacts: true, canManage: false, allowUnlimited: false, authorizedTools: new Set(['add-package', 'edit-package', 'delete-package', 'feature-list-crud', 'list-accounts']) }
  it('shows saved plan values with a disabled editor without granting native reads', () => {
    const html = renderV2WhmPlans(t, props({ capabilityUnavailable: true, planEditorState: { kind: 'edit', plan } }), stored)
    expect(html).toContain('Saved plan')
    expect(html).toContain('data-plan-editable="false"')
    expect(html).not.toContain('data-plan-delete="')
    expect(html).toContain('Current usage and over-cap accounts have not been observed.')
  })
  it('requires independent feature-list authority for saved membership', () => {
    const denied = renderV2WhmFeatures(t, props({ capabilityUnavailable: true }), { ...stored, authorizedTools: new Set(['add-package']) })
    expect(denied).not.toContain('Saved features')
    const allowed = renderV2WhmFeatures(t, props({ capabilityUnavailable: true }), stored)
    expect(allowed).toContain('Saved features')
    expect(allowed).not.toContain('data-feature-list-update-form')
    expect(allowed).not.toContain('data-feature-list-create-form')
  })
  it('never falls back to native qualification for an explicitly denied stored-fact authority', () => {
    const stale = { ...stored, canRead: true, canManage: true, authorizedTools: new Set<string>() }
    const html = renderV2WhmPlans(t, props({ planEditorState: { kind: 'edit', plan } }), stale)
    expect(html).not.toContain('Saved plan')
    expect(html).not.toContain('Saved features')
    expect(html).not.toContain('data-plan-delete="')
    const features = renderV2WhmFeatures(t, props(), stale)
    expect(features).not.toContain('Saved features')
    expect(features).not.toContain('data-feature-list-update-form')
  })
  it('keeps account assignment facts behind their independent account-list grant', () => {
    const html = renderV2WhmPlans(t, props({ capabilityUnavailable: true }), { ...stored, authorizedTools: new Set(['add-package']) })
    expect(html).toContain('Saved plan')
    expect(html).toContain('Account assignments have not been read.')
    expect(html).not.toContain('alice.example.test')
  })
  it('does not promote stored-fact authority to the enhancements provider controller', () => {
    const html = renderV2WhmEnhancements(t, props({ capabilityUnavailable: true }), stored)
    expect(html).toContain('data-enh-can-manage="false"')
    expect(html).not.toContain('<form')
  })
})
