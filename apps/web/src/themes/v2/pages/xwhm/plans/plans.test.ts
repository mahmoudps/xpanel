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
import { parseMarkup } from '../../../../markup.ts'
import { v2Messages } from '../../../messages.ts'

const root = { kind: 'root' as const, id: '10000000-0000-4000-8000-000000000001', username: 'operator' }
const reseller: Reseller = { id: '10000000-0000-4000-8000-000000000002', username: 'provider', acl: ['manage-plans', 'manage-feature-lists'], maxAccounts: 10, totalDiskMb: 10000, totalBandwidthMb: 'unlimited', oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [] }
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
  it('names the open plan with its owner and account count, and marks its row instead of linking to itself', () => {
    const open = renderV2WhmPlans(t, props({ planEditorState: { kind: 'edit', plan } }), authority)
    expect(open).toContain('>Edit plan: Saved plan</h2>')
    expect(open).toContain('Owner Root · <bdi class="v2-mono v2-num" dir="ltr">1</bdi> Accounts')
    expect(open).toContain('aria-current="true">Editing above</span>')
    expect(open).toContain(`data-plan-delete="${plan.id}"`)
    const closed = renderV2WhmPlans(t, props(), authority)
    expect(closed).not.toContain('Editing above')
    expect(closed).toContain('>Create plan</h2>')
    expect(renderV2WhmPlans(t, props({ planEditorState: { kind: 'edit', plan }, accounts: undefined }), authority)).toContain('Owner Root · Not read Accounts')
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
    const total = new Set(catalog.filter(tool => tool.featureKey).map(tool => tool.featureKey)).size
    expect(html).toContain(`${total - 1}</bdi> / <bdi class="v2-mono v2-num" dir="ltr">${total}</bdi> Shown · <bdi class="v2-mono v2-num" dir="ltr">1</bdi> Hidden`)
  })
  it('preserves an unread feature membership instead of treating it as all enabled', () => {
    const custom = renderV2WhmFeatures(t, props({ pluginFeatures: [{ key: 'plugin:acme', label: 'Acme notes' }], featureLists: [{ id: plan.featureListId, name: 'Saved features', ownerId: null, disabled: ['plugin:acme'] }] }), authority)
    expect(custom).toContain('Acme notes')
    expect(custom).toMatch(/value="plugin:acme"[^>]* checked/)
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
    expect(html).toContain('the panel changes no account limit from them')
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


describe('approved plan editor tabs and review structure', () => {
  it.each(['en', 'ar'] as const)('retains the %s Resources, Services and Features tabs around one complete native form', locale => {
    const translate = v2Messages.translator(locale)
    const html = renderV2PlanEditor(translate, props({ locale }), authority, plan, true), nodes = parseMarkup(html)
    const controls = nodes.filter(node => ['input', 'select'].includes(node.tag) && node.attrs.has('name'))
    const names = controls.map(node => node.attrs.get('name')!)
    expect(new Set(names).size).toBe(names.length)
    expect(nodes.filter(node => node.tag === 'form')).toHaveLength(1)
    expect(nodes.filter(node => node.tag === 'button' && node.attrs.get('type') === 'submit')).toHaveLength(1)
    expect(nodes.filter(node => node.attrs.has('data-presentation-tab')).map(node => node.attrs.get('data-presentation-tab'))).toEqual(['resources', 'services', 'features'])
    expect(nodes.filter(node => node.attrs.get('role') === 'tabpanel')).toHaveLength(3)
    expect(nodes.filter(node => node.attrs.has('data-plan-review-key'))).toHaveLength(24)
    expect(nodes.filter(node => node.attrs.has('data-plan-review-from'))).toHaveLength(24)
    expect(nodes.filter(node => node.attrs.has('data-plan-review-to'))).toHaveLength(24)
    const ids = nodes.filter(node => node.attrs.has('id')).map(node => node.attrs.get('id'))
    expect(new Set(ids).size).toBe(ids.length)
    for (const key of [...Object.keys(plan.resources), ...Object.keys(plan.caps), 'defaultMailboxQuotaMb']) {
      expect(names.filter(name => name === key)).toHaveLength(1); expect(names.filter(name => name === 'unlimited.' + key)).toHaveLength(1)
    }
    expect(html).toContain('data-native-plan-review'); expect(html).toContain('data-plan-review-readable="true"')
    expect(html).not.toContain('nextGen'); expect(html).not.toContain('systemctl set-property')
  })
  it('retains every control and current-read boundary when the editor is read only', () => {
    const html = renderV2PlanEditor(t, props(), { ...authority, canManage: false }, plan, false), nodes = parseMarkup(html)
    expect(html).toContain('data-plan-editable="false"')
    for (const node of nodes.filter(node => node.tag === 'input' || node.tag === 'select')) expect(node.attrs.has('disabled')).toBe(true)
    expect(nodes.filter(node => node.attrs.has('data-plan-review-key'))).toHaveLength(24)
  })
  it('does not copy denied saved records into the review metadata or control values', () => {
    const html = renderV2PlanEditor(t, props(), { ...authority, canRead: false }, { ...plan, name: 'PRIVATE-PLAN' }, true)
    expect(html).toContain('data-plan-review-readable="false"'); expect(html).toContain('data-plan-review-saved="false"')
    expect(html).not.toContain('PRIVATE-PLAN'); expect(html).not.toContain(plan.id)
  })
})

describe('v2 plan list search', () => {
  it('admits each plan row to the list filter and searches only a loaded list', () => {
    const html = renderV2WhmPlans(t, props(), authority)
    expect(html).toMatch(/<div class="v2-plan-filter" data-list-filter>.*id="v2-plan-search"[^>]*data-list-filter-search/s)
    expect(html).toMatch(/<tr data-plan-row="Saved plan" data-list-row>/)
    expect(renderV2WhmPlans(t, props({ plans: [] }), authority)).not.toContain('data-list-filter-search')
  })

  it('renders plan last-saved-by actor and timestamp when recorded and honest dash when unrecorded', () => {
    const saved = renderV2WhmPlans(t, props({ plans: [{ ...plan, updatedBy: 'operator', updatedAt: '2026-11-10T14:30:00.000Z' }] }), authority)
    expect(saved).toContain('Last saved by')
    expect(saved).toContain('operator')
    expect(saved).toContain('2026-11-10 14:30 UTC')
  })
})
