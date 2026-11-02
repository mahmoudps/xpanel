// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { translator } from './i18n.ts'
import { ACCOUNT_NETWORK_TOOLS_CLIENT_BINDING } from './account-network-tools-client.ts'
import { SITE_HEALTH_CLIENT_BINDING } from './site-health-client.ts'
import { renderAccountNetworkToolsWorkspace } from './board-port/account-network-tools-workspace.ts'
import { renderSiteHealthWorkspace } from './board-port/site-health-workspace.ts'
import { networkDiagnosticClientTemplates, siteHealthClientTemplates } from './themes/v2/pages/xpanel/diagnostic-client-templates.ts'
import { renderV2NetworkToolsPage } from './themes/v2/pages/xpanel/advanced/tools.ts'
import { renderV2PanelSiteHealth } from './themes/v2/pages/xpanel/observations/health.ts'

let dom: EnvironmentReturn | undefined
beforeEach(async () => { dom = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://panel.example.test', runScripts: 'outside-only' } }) })
afterEach(async () => { document.body.replaceChildren(); delete (window as Window & { xpT?: unknown }).xpT; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; await dom?.teardown(globalThis); dom = undefined })
const accountId = '11111111-1111-4111-8111-111111111111'
const domainId = '22222222-2222-4222-8222-222222222222'
const observedAt = '2026-10-29T12:00:00.000Z'
const tick = async () => { for (let n = 0; n < 4; n++) await new Promise(resolve => setTimeout(resolve, 0)) }
function mount(family: 'network' | 'health', theme: 'classic' | 'v2', canManage = true) {
  document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'
  document.body.innerHTML = family === 'network' ? renderAccountNetworkToolsWorkspace({ lang: 'en', accountId, canManage }) : renderSiteHealthWorkspace({ lang: 'en', accountId, canManage })
  const root = document.querySelector<HTMLElement>(family === 'network' ? '[data-account-network-tools]' : '[data-site-health]')!
  if (theme === 'v2') { root.querySelectorAll('template[data-xp-template]').forEach(item => item.remove()); root.insertAdjacentHTML('beforeend', family === 'network' ? networkDiagnosticClientTemplates() : siteHealthClientTemplates()) }
  Object.assign(window, { xpT: translator('en') })
  return { root, boot: () => window.eval(family === 'network' ? ACCOUNT_NETWORK_TOOLS_CLIENT_BINDING : SITE_HEALTH_CLIENT_BINDING)(undefined) }
}
const dns = { context: { accountId, tool: 'dns' }, query: { name: 'example.test', type: 'A' }, outcome: 'completed', target: null, observedAt, result: { status: 'answer', records: ['<img src=x>'], truncated: false } }
const health = { context: { accountId }, checkedAt: observedAt, total: 1, truncated: false, domains: [{ domainId, name: 'example.test', checks: [
  { id: 'dns', state: 'problem', cause: 'no_address', fix: '/domains/zone-editor', detail: {} },
  { id: 'http', state: 'ok', cause: 'reachable', fix: '/metrics/logs', detail: { status: 200 } },
  { id: 'certificate', state: 'problem', cause: 'expiring', fix: '/security/ssl', detail: { notAfter: '2026-11-01T00:00:00.000Z', daysLeft: 3 } },
  { id: 'php', state: 'ok', cause: 'supported', fix: '/software/php', detail: { version: '8.3' } },
] }] }

describe.each(['classic', 'v2'] as const)('account diagnostics selected %s templates', theme => {
  it('renders validated DNS cells as literal technical values through the serialized controller', async () => {
    const { root, boot } = mount('network', theme), send = vi.fn(async () => dns)
    Object.assign(window, { xpanelSessionRequest: send }); boot()
    root.querySelector<HTMLInputElement>('[data-nettools-host]')!.value = 'example.test'
    root.querySelector<HTMLButtonElement>('[data-nettools-run]')!.click(); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('POST', '/api/account/network-tools/dns', { name: 'example.test', type: 'A' })
    const rows = root.querySelector('[data-nettools-rows]')!
    expect(rows.querySelectorAll('td')).toHaveLength(2); expect(rows.textContent).toContain('<img src=x>'); expect(rows.querySelector('img')).toBeNull()
    expect(rows.querySelector('bdi')?.dir).toBe('ltr')
    if (theme === 'v2') expect(rows.querySelector('[class*="xp-"]')).toBeNull()
  })
  it('preserves health findings, state, safe fix links and isolated certificate dates', async () => {
    const { root, boot } = mount('health', theme), send = vi.fn(async () => health)
    Object.assign(window, { xpanelSessionRequest: send }); boot()
    expect(send).not.toHaveBeenCalled(); root.querySelector<HTMLButtonElement>('[data-health-run]')!.click(); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('GET', '/api/account/site-health')
    const rows = root.querySelector('[data-health-rows]')!
    expect(rows.querySelectorAll('tr')).toHaveLength(4); expect(rows.querySelectorAll('td')).toHaveLength(20)
    expect(rows.querySelectorAll('a')).toHaveLength(2); expect(rows.querySelector('a')?.getAttribute('href')).toBe('/domains/zone-editor?lang=en')
    expect(rows.querySelector('[data-state-chip="problem"]')?.textContent).toBe('Problem')
    expect(rows.querySelector<HTMLElement>('[data-xp-slot="detail"] bdi')?.dir).toBe('ltr')
    if (theme === 'v2') expect(rows.querySelector('[class*="xp-"]')).toBeNull()
  })
  for (const family of ['network', 'health'] as const) {
    it(family + ' refuses missing, duplicate or invalid-slot contracts before dispatch', async () => {
      for (const mode of ['missing', 'duplicate', 'slot'] as const) {
        const { root, boot } = mount(family, theme), send = vi.fn()
        Object.assign(window, { xpanelSessionRequest: send })
        const template = root.querySelector('template[data-xp-template="' + (family === 'network' ? 'network-diagnostic-technical-cell' : 'site-health-result') + '"]')!
        if (mode === 'duplicate') template.after(template.cloneNode(true)); else if (mode === 'missing') template.remove(); else (template as HTMLTemplateElement).content.querySelector('[data-xp-slot]')!.removeAttribute('data-xp-slot')
        boot(); root.querySelector<HTMLButtonElement>(family === 'network' ? '[data-nettools-run]' : '[data-health-run]')!.click(); await tick()
        expect(send).not.toHaveBeenCalled(); expect(root.querySelector<HTMLElement>(family === 'network' ? '[data-nettools-status]' : '[data-health-status]')!.dataset.state).toBe('unavailable')
      }
    })
    it(family + ' preserves denied native admission', async () => {
      const { root, boot } = mount(family, theme, false), send = vi.fn()
      Object.assign(window, { xpanelSessionRequest: send }); boot(); root.querySelector<HTMLButtonElement>(family === 'network' ? '[data-nettools-run]' : '[data-health-run]')!.click(); await tick()
      expect(send).not.toHaveBeenCalled()
    })
  }
})

it('mounts the selected diagnostic contracts inside both actual V2 route bodies', () => {
  expect(renderV2NetworkToolsPage({})).toContain('data-xp-template="network-diagnostic-technical-cell"')
  expect(renderV2PanelSiteHealth({})).toContain('data-xp-template="site-health-result"')
})
