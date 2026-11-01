import { describe, expect, it } from 'vitest'
import { parseMarkup, type MarkupNode } from '../../../../markup.ts'
import { renderV2TransferPage } from './transfers.ts'
import { renderV2WhmRecoveryToolsPage } from '../recovery-tools/index.ts'

// Presentation receives core-projected admission. No native action or source connection is executed.
const routes = ['/whm/transfers', '/whm/transfers/server', '/whm/transfers/convert-addon'] as const
const states = [
  { label: 'denied', canRead: false, canManage: false },
  { label: 'write flag without read', canRead: false, canManage: true },
  { label: 'read without write', canRead: true, canManage: false },
  { label: 'read and write', canRead: true, canManage: true },
] as const
const cases = (['en', 'ar'] as const).flatMap(locale => routes.flatMap(route => states.map(state => ({ locale, route, ...state }))))

function liveControlsUnder(nodes: readonly MarkupNode[], root: MarkupNode): MarkupNode[] {
  const rootIndex = nodes.indexOf(root)
  return nodes.filter(node => {
    if (node.template >= 0 || node.namespace !== 'html' || !['button', 'input', 'select', 'textarea'].includes(node.tag)) return false
    for (let index = nodes.indexOf(node); index >= 0; index = nodes[index]!.parent) {
      if (index === rootIndex) return true
    }
    return false
  })
}

describe('V2 transfer capability state from projected admission', () => {
  it.each(cases)('$route ($locale) preserves $label', ({ route, locale, canRead, canManage }) => {
    const conversion = route === '/whm/transfers/convert-addon'
    const html = conversion
      ? renderV2WhmRecoveryToolsPage({ activeRoute: route, locale }, { canRead, canManage, root: true })!
      : renderV2TransferPage({ locale, canRead, canManage, scope: route === '/whm/transfers/server' ? 'server' : 'accounts' })
    const outline = parseMarkup(html)
    const nodes = outline.filter(node => node.template < 0 && node.namespace === 'html')
    const page = nodes.find(node => node.attrs.has('data-whm-detail-route'))!
    expect(page.attrs.get('data-whm-detail-route')).toBe(route)
    expect(page.attrs.get('data-capability-state')).toBe(canRead ? 'authorized' : 'unavailable')
    expect(nodes.filter(node => node.attrs.has('data-capability-state'))).toHaveLength(1)
    const workspace = nodes.find(node => node.attrs.has(conversion ? 'data-acct-convert-addon' : 'data-transfer-workspace'))!
    expect(workspace.attrs.get(conversion ? 'data-can-manage' : 'data-transfer-manage')).toBe(String(canRead && canManage))
    const controls = liveControlsUnder(outline, workspace)
    expect(controls.length).toBeGreaterThan(0)
    if (!conversion || !canRead || !canManage) expect(controls.every(node => node.attrs.has('disabled'))).toBe(true)
    if (conversion) {
      for (const marker of ['data-acct-convert-preview', 'data-acct-convert-apply']) expect(nodes.find(node => node.attrs.has(marker))?.attrs.has('disabled')).toBe(true)
      expect(nodes.find(node => node.attrs.get('data-acct-convert-input') === 'confirm')?.attrs.has('disabled')).toBe(true)
    } else {
      expect(workspace.attrs.get('data-transfer-credentials')).toBe(canRead ? 'read' : undefined)
      expect(html).not.toContain('Transfer completed')
      const credentialRoot = nodes.find(node => node.attrs.has('data-acct-transfer-credentials'))
      if (route === '/whm/transfers/server') {
        expect(credentialRoot?.attrs.get('data-can-manage')).toBe(String(canRead && canManage))
        const credentialControls = liveControlsUnder(outline, credentialRoot!)
        expect(credentialControls).toHaveLength(4)
        expect(credentialControls.every(node => node.attrs.has('disabled') === !(canRead && canManage))).toBe(true)
      } else expect(credentialRoot).toBeUndefined()
    }
  })

  it.each(['en', 'ar'] as const)('respects the existing explicit conversion outage in %s', locale => {
    const html = renderV2WhmRecoveryToolsPage({ activeRoute: '/whm/transfers/convert-addon', locale, capabilityUnavailable: true }, { canRead: true, canManage: true, root: true })!
    const outline = parseMarkup(html)
    const nodes = outline.filter(node => node.template < 0 && node.namespace === 'html')
    expect(nodes.find(node => node.attrs.has('data-whm-detail-route'))?.attrs.get('data-capability-state')).toBe('unavailable')
    const workspace = nodes.find(node => node.attrs.has('data-acct-convert-addon'))!
    expect(workspace.attrs.get('data-can-manage')).toBe('false')
    const controls = liveControlsUnder(outline, workspace)
    expect(controls.length).toBeGreaterThan(0)
    expect(controls.every(node => node.attrs.has('disabled'))).toBe(true)
  })
})
