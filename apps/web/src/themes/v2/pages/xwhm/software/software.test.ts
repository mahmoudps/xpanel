import type { Plan } from '@xpanel/core'
import { describe, expect, it } from 'vitest'
import { parseMarkup } from '../../../../markup.ts'
import { renderV2WhmSoftwarePage, V2_WHM_SOFTWARE_ROUTES, WHM_SOFTWARE_PAGES_CSS, type WhmDataPageInput } from './index.ts'

const render = (route: string, input: WhmDataPageInput = {}) => renderV2WhmSoftwarePage({ dataAuthority: { canRead: true, canManage: true }, ...input, activeRoute: route })!
const node = (html: string, name: string, value?: string) => {
  const found = parseMarkup(html).find(item => item.attrs.has(name) && (value === undefined || item.attrs.get(name) === value))
  if (!found) throw new Error(`Missing ${name}`)
  return found
}

describe('V2 WHM software documents', () => {
  it('maps 11 canonical software routes and three store aliases exactly', () => {
    expect(new Set(V2_WHM_SOFTWARE_ROUTES).size).toBe(14)
    for (const route of V2_WHM_SOFTWARE_ROUTES) {
      const html = render(route)
      expect(html).toContain(`data-whm-detail-route="${route}"`)
      expect(html.match(/<h1\b/g)).toHaveLength(1)
      expect(html).not.toMatch(/class="[^"\n]*\bxp-|<style\b|<script\b/)
    }
    expect(renderV2WhmSoftwarePage({ activeRoute: '/whm/software/php' })).toBeUndefined()
  })

  it('fails closed on omitted read/manage authority and on a host capability fence', () => {
    for (const route of V2_WHM_SOFTWARE_ROUTES) {
      for (const input of [{ dataAuthority: undefined }, { capabilityUnavailable: true }]) {
        const html = render(route, input)
        expect(html).toContain('data-capability-state="unavailable"')
        expect(html).not.toMatch(/data-(?:sc|sw|updates)-can-(?:read|manage|apply)="true"/)
        expect(parseMarkup(html).filter(item => item.tag === 'button' && !item.attrs.has('data-sc-cancel')).every(item => item.attrs.has('disabled'))).toBe(true)
      }
    }
  })

  it('retains category distinctions while keeping installed package data unread', () => {
    for (const [route, kind, category] of [['/whm/software/catalog', 'catalog', 'cache'], ['/whm/software/runtimes', 'runtime', 'nodejs'], ['/whm/software/modules', 'module', 'php']]) {
      const html = render(route!)
      expect(node(html, 'data-sc-page').attrs.get('data-sc-page')).toBe(kind)
      expect(html).toContain(`value="${category}"`)
      expect(node(html, 'data-sc-status').attrs.get('data-state')).toBe('unread')
      expect(html).not.toMatch(/data-sc-family>\w*(?:debian|rhel)/)
      expect(node(html, 'data-sc-category').attrs.has('disabled')).toBe(true)
    }
  })

  it('retains the actual package preview, extra-removal acknowledgement and disabled confirmation', () => {
    const html = render('/whm/software/catalog')
    expect(node(html, 'data-sc-preview').attrs.has('hidden')).toBe(true)
    expect(node(html, 'data-sc-preview-extra').attrs.has('hidden')).toBe(true)
    for (const key of ['install', 'upgrade', 'remove']) expect(node(html, `data-sc-preview-${key}`).tag).toBe('ul')
    expect(node(html, 'data-sc-accept-extra').attrs.has('disabled')).toBe(true)
    expect(node(html, 'data-sc-confirm').attrs.has('disabled')).toBe(true)
    expect(node(html, 'data-sc-source', 'external').tag).toBe('li')
    expect(html).not.toMatch(/name="(?:catalogUrl|signingKey|password)"/)
  })

  it('preserves host container inventory and keeps creation and compose unavailable', () => {
    const html = render('/whm/software/containers')
    expect(node(html, 'data-sw-filter-engine').attrs.has('disabled')).toBe(true)
    expect(parseMarkup(html).find(item => item.tag === 'tbody' && item.attrs.has('data-sw-containers'))?.attrs.get('data-columns')).toBe('7')
    expect(node(html, 'data-container-create-state').attrs.get('data-container-create-state')).toBe('unavailable')
    expect(html).toContain('Account rootless containers')
  })

  it('retains all engine resources without exposing an unreviewed writer', () => {
    const html = render('/whm/software/containers/engine')
    for (const key of ['facts', 'images', 'registries', 'networks', 'volumes']) expect(node(html, `data-sw-${key}`).tag).toBe('tbody')
    expect(html).not.toContain('data-sw-can-manage="true"')
    expect(parseMarkup(html).filter(item => item.tag === 'button' && !item.attrs.has('data-sw-refresh')).every(item => item.attrs.has('disabled'))).toBe(true)
  })

  it('keeps add-on configuration disabled while admitting independent inventory reads', () => {
    const html = render('/whm/software/addon-services', { dataAuthority: { canRead: true, canManage: false } })
    expect(node(html, 'data-sw-addons-refresh').attrs.has('disabled')).toBe(false)
    expect(html).toContain('data-sw-can-manage="false"')
    expect(node(html, 'data-service-configuration-state').attrs.get('data-service-configuration-state')).toBe('unavailable')
  })

  it('requires repository observation before deployment and keeps account-runner facts separate', () => {
    const html = render('/whm/software/deployments')
    for (const key of ['native', 'files', 'path', 'branch', 'head', 'remote', 'tree']) expect(node(html, `data-sw-dep-${key}`).tag).toBe('dd')
    expect(node(html, 'data-sw-dep-pull').attrs.has('disabled')).toBe(true)
    expect(node(html, 'data-sw-dep-commits').attrs.get('data-columns')).toBe('3')
    expect(html).toContain('uncommitted files, a moved commit or a changed repository list')
  })

  it('does not present an absent project provider as a successful empty project list', () => {
    const html = render('/whm/software/application-projects')
    expect(node(html, 'data-project-runner-state').attrs.get('data-project-runner-state')).toBe('unavailable')
    expect(html).toContain('Project state has not been read.')
    expect(html).not.toContain('No projects exist.')
    expect(node(html, 'data-sw-projects-runtimes').tag).toBe('tbody')
  })

  it('retains Composer metadata and execution controls without a job provider', () => {
    const html = render('/whm/software/composer')
    for (const key of ['version', 'observed', 'account', 'directory', 'php', 'manifest', 'lock', 'vendor', 'match']) expect(node(html, `data-composer-${key}`).tag).toBe('dd')
    for (const key of ['run-action', 'review', 'run']) expect(node(html, `data-composer-${key}`).attrs.has('disabled')).toBe(true)
    expect(node(html, 'data-composer-review-region').attrs.has('hidden')).toBe(true)
    expect(node(html, 'data-composer-live-log').attrs.get('role')).toBe('status')
    expect(html).not.toMatch(/<form\b|type="password"/)
  })

  it('requires a current update plan before any package apply and preserves kernel exclusion help', () => {
    const html = render('/whm/software/updates')
    expect(node(html, 'data-whm-updates-action', 'read').attrs.has('disabled')).toBe(false)
    for (const action of ['refresh', 'security', 'selected', 'all']) expect(node(html, 'data-whm-updates-action', action).attrs.has('disabled')).toBe(true)
    expect(node(html, 'data-whm-updates-exclude-kernel').attrs.get('aria-describedby')).toBe('v2-updates-exclude-help')
    expect(node(html, 'data-whm-updates-rows').attrs.get('data-columns')).toBe('7')
  })

  it('escapes observed plan names without displaying internal plan identifiers or leaking denied data', () => {
    const plans = [{ id: 'opaque-plan-key', name: '<script>untrusted</script>' } as Plan]
    const html = render('/whm/software/store', { plans })
    expect(html).toContain('&lt;script&gt;untrusted&lt;/script&gt;')
    expect(html).not.toContain('opaque-plan-key')
    expect(render('/whm/software/store', { plans, dataAuthority: undefined })).not.toContain('untrusted')
    const activity = render('/whm/software/store/activity')
    expect(activity).toContain('General audit events are not installer activity.')
  })

  it('preserves RTL, ASCII digits and aligned field/fact spacing tokens', () => {
    const html = render('/whm/software/updates', { locale: 'ar' })
    expect(html).toContain('dir="rtl"')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(WHM_SOFTWARE_PAGES_CSS).toContain('text-align:start')
    expect(WHM_SOFTWARE_PAGES_CSS).toContain('gap:var(--space-2)')
    expect(WHM_SOFTWARE_PAGES_CSS).not.toMatch(/text-align:(?:left|right)/)
  })
})
