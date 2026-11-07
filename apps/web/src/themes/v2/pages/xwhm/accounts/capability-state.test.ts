import { describe, expect, it } from 'vitest'
import { tools, type CatalogTool } from '@xpanel/catalog'
import { defaultPlan, type Principal, type Reseller } from '@xpanel/core'
import { projectReadOnlyWhmSurface } from '../../../../../models/theme-surface.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { parseMarkup } from '../../../../markup.ts'
import { v2Messages } from '../../../messages.ts'
import { renderV2WhmAccountToolsPage } from '../account-tools/index.ts'
import { renderV2WhmAccountCreate } from './create.ts'

const locales = ['en', 'ar'] as const
const toolCases = [
  { route: '/whm/accounts/health', root: 'data-whm-health-workspace', action: 'data-whm-health-run', readOnlyState: 'authorized' },
  { route: '/whm/accounts/bandwidth', root: 'data-whm-metering', action: 'data-whm-metering-refresh', readOnlyState: 'authorized' },
  { route: '/whm/accounts/templates', root: 'data-acct-templates-workspace', action: 'data-acct-templates-refresh', readOnlyState: 'unavailable' },
] as const

function liveRoot(html: string, attribute: string) {
  const nodes = parseMarkup(html).filter(node => node.template < 0 && node.attrs.has(attribute))
  expect(nodes).toHaveLength(1)
  const root = nodes[0]
  if (!root) throw new Error('Missing live root: ' + attribute)
  return root
}

function action(html: string, attribute: string) {
  const nodes = parseMarkup(html).filter(node => node.template < 0 && node.attrs.has(attribute))
  expect(nodes).toHaveLength(1)
  const control = nodes[0]
  if (!control) throw new Error('Missing action: ' + attribute)
  return control
}

describe('V2 account-tool capability projection', () => {
  for (const locale of locales) for (const entry of toolCases) {
    it(entry.route + ' exposes admitted controls without claiming observed results in ' + locale, { tags: ['feature'] }, () => {
      const html = renderV2WhmAccountToolsPage({ activeRoute: entry.route, locale }, { canRead: true, canManage: true })
      if (html === undefined) throw new Error('Missing exact account route')
      expect(liveRoot(html, entry.root).attrs.get('data-capability-state')).toBe('authorized')
      expect(action(html, entry.action).attrs.has('disabled')).toBe(false)
      expect(html).toContain('dir="' + (locale === 'ar' ? 'rtl' : 'ltr') + '"')
      expect(html).not.toContain('data-state="verified"')
    })

    it(entry.route + ' preserves the existing read-versus-manage boundary in ' + locale, { tags: ['feature'] }, () => {
      const html = renderV2WhmAccountToolsPage({ activeRoute: entry.route, locale }, { canRead: true, canManage: false })
      if (html === undefined) throw new Error('Missing exact account route')
      expect(liveRoot(html, entry.root).attrs.get('data-capability-state')).toBe(entry.readOnlyState)
      expect(action(html, entry.action).attrs.has('disabled')).toBe(entry.readOnlyState === 'unavailable')
      if (entry.route === '/whm/accounts/templates') {
        expect(html).not.toContain('<form')
        expect(action(html, 'data-acct-templates-save').attrs.has('disabled')).toBe(true)
      }
    })

    it(entry.route + ' closes host-unavailable controls despite caller admission in ' + locale, { tags: ['feature'] }, () => {
      const html = renderV2WhmAccountToolsPage({ activeRoute: entry.route, locale, capabilityUnavailable: true }, { canRead: true, canManage: true })
      if (html === undefined) throw new Error('Missing exact account route')
      expect(liveRoot(html, entry.root).attrs.get('data-capability-state')).toBe('unavailable')
      const controls = parseMarkup(html).filter(node => node.template < 0 && ['button', 'input', 'select', 'textarea'].includes(node.tag))
      expect(controls.length).toBeGreaterThan(0)
      expect(controls.every(control => control.attrs.has('disabled'))).toBe(true)
      expect(html).not.toContain('<form')
    })
  }
})

const principal: Principal = { kind: 'root', id: 'capability-root', username: 'operator' }
const plan = defaultPlan({ id: 'capability-plan', name: 'Account plan' })
// Synthetic qualification selects renderer branches only; it is not native evidence.
const qualified: CatalogTool[] = tools.filter(tool => tool.id === 'create-account').map((tool): CatalogTool => ({ ...tool, status: 'verified', delivery: { ...tool.delivery, status: 'verified' } }))
const unqualified: CatalogTool[] = qualified.map((tool): CatalogTool => ({ ...tool, status: 'researched', delivery: { ...tool.delivery, status: 'researched' } }))
const createProps: WhmSurfaceProps = { principal, visibility: { principal }, activeRoute: '/whm/accounts/new', plans: [plan], accounts: [], resellers: [], catalog: qualified }

function expectCreateClosed(html: string): void {
  expect(liveRoot(html, 'data-accounts-workspace').attrs.get('data-capability-state')).toBe('unavailable')
  const controls = parseMarkup(html).filter(node => node.template < 0 && ['button', 'input', 'select', 'textarea'].includes(node.tag))
  expect(controls.length).toBeGreaterThan(0)
  expect(controls.every(control => control.attrs.has('disabled'))).toBe(true)
}

describe('V2 account-create capability projection', () => {
  for (const locale of locales) {
    it('reflects actual create admission while keeping results unobserved in ' + locale, { tags: ['feature'] }, () => {
      const html = renderV2WhmAccountCreate(v2Messages.translator(locale), { ...createProps, locale })
      expect(liveRoot(html, 'data-accounts-workspace').attrs.get('data-capability-state')).toBe('authorized')
      const form = liveRoot(html, 'data-create-account-form')
      expect(form.attrs.get('action')).toBe('/api/accounts')
      expect(form.attrs.get('data-account-create-actor')).toBe('root:operator')
      expect(action(html, 'data-account-generate-password').attrs.has('disabled')).toBe(false)
      expect(parseMarkup(html).filter(node => node.template < 0 && node.attrs.has('data-account-creation-step'))).toHaveLength(6)
    })

    it('does not derive host qualification from supplied plans in ' + locale, { tags: ['feature'] }, () => {
      expectCreateClosed(renderV2WhmAccountCreate(v2Messages.translator(locale), { ...createProps, locale, catalog: unqualified }))
    })

    it('does not derive create permission from a qualified host in ' + locale, { tags: ['feature'] }, () => {
      const reseller: Reseller = { id: 'denied-reseller', username: 'partner', acl: [], maxAccounts: 2, totalDiskMb: 1000, totalBandwidthMb: 1000, oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [] }
      const actor: Principal = { kind: 'reseller', id: reseller.id, username: reseller.username }
      expectCreateClosed(renderV2WhmAccountCreate(v2Messages.translator(locale), { ...createProps, locale, principal: actor, visibility: { principal: actor, reseller }, activeReseller: reseller }))
    })

    it('retains projected read-only authority even if caller props claim qualification in ' + locale, { tags: ['feature'] }, () => {
      const view = projectReadOnlyWhmSurface({ ...createProps, locale, capabilityUnavailable: true, catalog: unqualified })
      if (!view) throw new Error('Missing read-only account-create projection')
      expectCreateClosed(renderV2WhmAccountCreate(v2Messages.translator(locale), { ...view.props, capabilityUnavailable: false, catalog: qualified }, view.authority))
    })
  }
})
