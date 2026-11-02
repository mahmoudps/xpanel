import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { translator } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { parseMarkup } from '../../../../markup.ts'
import type { WhmAdminAuthority } from '../server/common.ts'
import { renderV2WhmPanelPage, V2_WHM_PANEL_ROUTES, V2_PANEL_TOKEN_SCOPES, V2_PANEL_NOTIFICATION_EVENTS } from './index.ts'

const principal = { kind: 'root' as const, id: 'root-fixture', username: 'operator' }
const authority: WhmAdminAuthority = { canRead: true, canManage: true }
const props = (activeRoute: string, extra: Partial<WhmSurfaceProps> = {}): WhmSurfaceProps => ({ principal, activeRoute, locale: 'en', ...extra })
const render = (route: string, extra: Partial<WhmSurfaceProps> = {}, admission: WhmAdminAuthority = authority) => renderV2WhmPanelPage(translator(extra.locale ?? 'en'), props(route, extra), admission)!
const controls = (html: string) => html.match(/<(?:input|select|textarea|button)\b[^>]*>/g) ?? []
const one = (html: string, name: string) => parseMarkup(html).find(node => node.attrs.has(name))

describe('v2 panel administration family', () => {
  it.each(V2_WHM_PANEL_ROUTES)('retains the full %s layout but no submit flow without core read admission', route => {
    const html = render(route, {}, { canRead: false, canManage: true, themePackages: [{ label: 'PRIVATE-PACKAGE', surfaces: ['xwhm'], available: true }] })
    expect(html).toContain(`data-v2-panel-route="${route}"`)
    expect(html).not.toContain('<form'); expect(html).not.toContain('PRIVATE-PACKAGE')
    for (const control of controls(html)) expect(control).toMatch(/\sdisabled(?:\s|>)/)
    expect((html.match(/<h1\b/g) ?? [])).toHaveLength(1)
  })
  it('returns undefined for another family and for an unregistered arbitrary panel path', () => {
    expect(renderV2WhmPanelPage(translator('en'), props('/whm/server/setup'), authority)).toBeUndefined()
    expect(renderV2WhmPanelPage(translator('en'), props('/whm/panel/unknown'), authority)).toBeUndefined()
  })
  it('matches token resource controls and notification events to the API source without importing API code into the theme', () => {
    const api = readFileSync(new URL('../../../../../../../api/src/panel-tokens-workspace.ts', import.meta.url), 'utf8')
    const scopes = [...api.match(/export const API_TOKEN_SCOPE_RESOURCES = \[([\s\S]*?)\] as const/)![1]!.matchAll(/'([^']+)'/g)].map(match => match[1])
    expect(Object.keys(V2_PANEL_TOKEN_SCOPES).sort()).toEqual(scopes.sort())
    const eventsSource = readFileSync(new URL('../../../../../../../api/src/panel-notifications.ts', import.meta.url), 'utf8')
    const alertSource = readFileSync(new URL('../../../../../../../api/src/alert-delivery.ts', import.meta.url), 'utf8')
    const alert = alertSource.match(/export const ALERT_NOTIFICATION_EVENT = '([^']+)'/)![1]!
    const events = [alert, ...[...eventsSource.match(/export const NOTIFICATION_EVENTS = \[([\s\S]*?)\] as const/)![1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!)]
    expect(Object.keys(V2_PANEL_NOTIFICATION_EVENTS).sort()).toEqual(events.sort())
  })
  it('retains finite expiring token scopes and initially empty one-time reveal regions', () => {
    const html = render('/whm/panel/api-tokens')
    expect(html).toContain('data-whm-tokens-reveal role="status" hidden')
    expect(html).toContain('data-whm-tokens-secret></code>')
    expect(html.match(/data-whm-tokens-scope\b/g)).toHaveLength(Object.keys(V2_PANEL_TOKEN_SCOPES).length * 2)
    expect(html).toContain('value="server:write"'); expect(html).toContain('value="*"')
    expect(html).toContain('<option value="90" selected>90 days</option>')
    expect(html).not.toContain('No expiry')
    expect(one(html, 'data-whm-tokens-name')?.attrs.get('maxlength')).toBe('64')
    expect(one(html, 'data-whm-tokens-ips')?.attrs.get('maxlength')).toBe('1024')
    expect(html).toContain('sign-in listeners refuse bearer tokens')
  })
  it('keeps absent theme-registry evidence distinct from an explicit empty registry', () => {
    const unread = render('/whm/panel/branding')
    expect(unread).toContain('No installed theme registry has been supplied by core.')
    expect(unread).not.toContain('No other theme package is installed')
    const empty = render('/whm/panel/branding', {}, { ...authority, themePackages: [] })
    expect(empty).toContain('No available theme packages were returned.')
    const selected = render('/whm/panel/branding', {}, { ...authority, themePackages: [{ label: 'Actual registry choice', surfaces: ['xpanel', 'xwhm'], available: true }] })
    expect(selected).toContain('Actual registry choice'); expect(selected).toContain('xpanel')
    for (const hook of ['data-branding-input="companyName"', 'data-branding-input="productName"', 'data-branding-input="defaultTheme"', 'data-branding-upload="logo"', 'data-branding-file="favicon"']) expect(selected).toContain(hook)
  })
  it('keeps saved panel mode controls disabled until their own read supplies values', () => {
    const html = render('/whm/panel/settings')
    for (const key of ['offlineMode', 'offlineMessage', 'developerMode', 'liveUpdates', 'reverseProxyAllowedHosts']) {
      const node = parseMarkup(html).find(node => node.attrs.get('data-panel-settings-input') === key)
      expect(node?.attrs.has('disabled')).toBe(true)
      expect(node?.attrs.has('checked')).toBe(false)
    }
    expect(html).toContain('Panel settings have not been read. No saved values are assumed.')
    expect(one(html, 'data-panel-settings-save')?.attrs.has('disabled')).toBe(true)
  })
  it('keeps WHMCS connection, token issuance, plan mapping and activity independently unread', () => {
    const html = render('/whm/panel/whmcs')
    for (const hook of ['data-whm-whmcs-form', 'data-whm-whmcs-plan-rows', 'data-whm-whmcs-plan-add', 'data-whm-whmcs-download', 'data-whm-whmcs-log-rows', 'data-whm-whmcs-secret', 'data-whm-whmcs-rotate']) expect(html).toContain(hook)
    expect(html).toContain('data-whm-whmcs-secret></code>')
    expect(html).toContain('data-whm-whmcs-reveal role="status" hidden')
    expect(html).toContain('Supported by the module'); expect(html).toContain('not a verified WHMCS connection')
    expect(one(html, 'data-whm-whmcs-save')?.attrs.has('disabled')).toBe(true)
    expect(one(html, 'data-whm-whmcs-identifier')?.attrs.has('readonly')).toBe(true)
  })
  it('retains the finite developer read explorer and signed webhook editor without raw request inputs', () => {
    const developer = render('/whm/panel/developer'), integrations = render('/whm/panel/integrations')
    expect(developer).toContain('data-developer-surface="administrator"')
    expect(developer).toContain('data-dev-operation'); expect(developer).toContain('data-dev-result-fields')
    expect(developer).not.toContain('name="url"'); expect(developer).not.toContain('name="requestBody"')
    expect(integrations).toContain('data-developer-surface="integrations"')
    for (const marker of ['data-ops-int-rows', 'data-ops-int-log', 'data-ops-int-events', 'data-ops-int-save']) expect(integrations).toContain(marker)
    expect(integrations).toContain('Secrets are stored on the server and never shown here.')
  })
  it('preserves persisted generation references and does not infer an applied generation when no observation was supplied', () => {
    const unread = render('/whm/panel/data')
    expect(unread).toContain('The current applied generation has not been read.')
    expect(unread).not.toContain('No generation is applied yet.')
    const loaded = render('/whm/panel/data', { generationId: 9, generations: [{ generationId: 9, at: '2026-10-29T00:00:00.000Z', actor: 'private-internal-actor', summary: '<script>unsafe</script>', stateChecksum: 'a'.repeat(64), filesCount: 4, durationMs: 120, status: 'active' }] })
    expect(loaded).toContain('#9'); expect(loaded).not.toContain('private-internal-actor')
    expect(loaded).toContain('&lt;script&gt;unsafe&lt;/script&gt;'); expect(loaded).not.toContain('<script>unsafe')
    expect(loaded).toContain('data-generation-id="9" disabled')
  })
  it('allows the personal preferences layout for a reseller while keeping root panel settings inert', () => {
    const reseller = { kind: 'reseller' as const, id: 'reseller-fixture', username: 'provider' }
    const prefs = render('/whm/preferences', { principal: reseller, locale: 'ar' })
    expect(prefs).toContain('data-preferences-can-manage="true"'); expect(prefs).toContain('lang="ar" dir="rtl"')
    expect(prefs).not.toMatch(/[٠-٩۰-۹]/)
    for (const key of ['language', 'theme', 'density']) expect(prefs).toContain(`data-whm-preferences-input="${key}"`)
    expect(render('/whm/panel/settings', { principal: reseller })).toContain('data-panel-settings-can-manage="false"')
  })
  it('retains exact notification fields and only the API-known event controls', () => {
    const html = render('/whm/panel/notifications')
    expect(html.match(/data-whm-notifications-event\b/g)).toHaveLength(Object.keys(V2_PANEL_NOTIFICATION_EVENTS).length)
    expect(one(html, 'data-whm-notifications-recipients')?.attrs.get('maxlength')).toBe('2600')
    expect(one(html, 'data-whm-notifications-webhook-url')?.attrs.get('maxlength')).toBe('2048')
    expect(one(html, 'data-whm-notifications-test')?.attrs.has('disabled')).toBe(true)
    expect(html).toContain('the other events are not sent yet.')
  })
})
