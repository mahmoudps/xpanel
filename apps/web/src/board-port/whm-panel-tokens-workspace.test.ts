import { describe, expect, it } from 'vitest'
import { PANEL_TOKEN_SCOPE_LABELS, renderWhmPanelTokensWorkspace } from './whm-panel-tokens-workspace.ts'

const controls = (html: string): string[] => html.match(/<(?:input|select|textarea|button)\b[^>]*>/g) ?? []

describe('WHM API tokens workspace renderer', () => {
  it('renders the complete English page with truthful unread states', () => {
    const html = renderWhmPanelTokensWorkspace({ locale: 'en', canManage: true })
    expect(html).toContain('data-whm-detail-route="/whm/panel/api-tokens"')
    expect(html).toContain('data-tokens-can-manage="true"')
    expect(html).toContain('data-capability-state="authorized"')
    expect(html).toContain('<h1>API tokens</h1>')
    expect(html).toContain('Your API tokens have not been read. No token is assumed to exist or to be active.')
    expect(html).toContain('<bdi dir="ltr"><code>Authorization: Bearer &lt;token&gt;</code></bdi>')
    expect(html).toContain('sign-in listeners refuse bearer tokens by design')
    expect(html).toContain('This version does not record when a token is used')
    for (const header of ['Name', 'Scopes', 'Allowed from', 'Created (UTC)', 'Expires (UTC)', 'Last used (UTC)', 'State', 'Action']) expect(html).toContain(`>${header}</th>`)
    for (const marker of ['data-whm-tokens-reveal', 'data-whm-tokens-secret', 'data-whm-tokens-copy', 'data-whm-tokens-done', 'data-whm-tokens-rows', 'data-whm-tokens-loading', 'data-whm-tokens-empty',
      'data-whm-tokens-name', 'data-whm-tokens-expiry', 'data-whm-tokens-ips', 'data-whm-tokens-all', 'data-whm-tokens-all-warning', 'data-whm-tokens-create-submit', 'data-whm-tokens-refresh']) expect(html).toContain(marker)
    expect(html).toMatch(/<form class="xp-whm-tokens__group" data-whm-tokens-create [^>]*novalidate>/)
    expect(html.match(/data-whm-tokens-scope/g)).toHaveLength(Object.keys(PANEL_TOKEN_SCOPE_LABELS).length * 2)
    expect(html).toContain('value="server:write"')
    expect(html).toContain('<option value="90" selected>90 days</option>')
    expect(html).toContain('<option value="365">1 year (365 days)</option>')
    expect(html).toContain('Full access lets the token do anything root can do')
    expect(html).toMatch(/data-whm-tokens-reveal role="status" hidden/)
  })

  it('renders Arabic RTL copy with ASCII digits only and technical values isolated', () => {
    const html = renderWhmPanelTokensWorkspace({ locale: 'ar', canManage: true })
    expect(html).toContain('lang="ar" dir="rtl"')
    expect(html).toContain('<h1>رموز API</h1>')
    expect(html).toContain('<bdi dir="ltr">server</bdi>')
    expect(html).toContain('<option value="30">30 يومًا</option>')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
    expect(html).not.toMatch(/>(?:Name|Scopes|Create token|Revoke|Refresh|Done|Copy token)</)
  })

  it('keeps the full layout but renders every control disabled and no form when unavailable', () => {
    const html = renderWhmPanelTokensWorkspace({ locale: 'en', canManage: false })
    expect(html).toContain('data-tokens-can-manage="false"')
    expect(html).toContain('data-capability-state="unavailable"')
    expect(html).not.toContain('<form')
    expect(html).toContain('data-whm-tokens-rows')
    const all = controls(html)
    expect(all.length).toBeGreaterThan(80)
    for (const control of all) expect(control, control).toMatch(/\sdisabled(?:[\s>]|$)/)
    expect(html).not.toContain('type="submit"')
  })
})
