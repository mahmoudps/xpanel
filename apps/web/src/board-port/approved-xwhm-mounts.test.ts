// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import type { ServerSettings } from '@xpanel/core'
import type { WhmSurfaceProps } from '../surfaces/xwhm.ts'
import { renderWhmDetailPage } from './approved-xwhm.ts'

const root = { kind: 'root' as const, id: 'synthetic-root', username: 'synthetic-root' }
const catalog = tools.map(tool => tool.id === 'server-settings-edit' ? { ...tool, status: 'verified' as const } : tool)
const settings: ServerSettings = {
  hostname: 'private-saved-host.example.test', nameservers: ['ns1.example.test', 'ns2.example.test'], adminEmail: 'owner@example.test',
  engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 2222,
  nginx: { workerProcesses: 'auto', workerConnections: 2048, workerRlimitNofile: 8192, multiAccept: false, keepaliveTimeoutSec: 45 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 8, maxRequestWorkers: 200, maxConnectionsPerChild: 3000, serverLimit: 200 },
  backendPort: 8080, backendTlsPort: 8444,
}
const pages = [
  { route: '/whm/domains', marker: 'data-whm-domains-workspace', cards: ['domain-list', 'server-ops-domain-forwards', 'default-site', 'name-resolution'] },
  { route: '/whm/ssl', marker: 'data-whm-ssl', cards: ['ssl-certificates', 'ssl-renewal-queue', 'ssl-renewal-log', 'ssl-storage', 'autossl', 'panel-certificate'] },
  { route: '/whm/security/ssh', marker: 'data-whm-ssh-keys', cards: ['ssh-signin', 'ssh-service', 'ssh-alarm', 'ssh-keys', 'ssh-effective', 'ssh-failures', 'ssh-autoban', 'ssh-banned'] },
  { route: '/whm/security', marker: 'data-whm-security-evidence', cards: ['security-evidence', 'panel-access', 'panel-lockout', 'panel-ip-lockout', 'panel-passwords', 'panel-tokens', 'panel-mfa', 'panel-waf', 'panel-dangerous-php', 'panel-compiler', 'panel-apply'] },
  { route: '/whm/software/php', marker: 'data-whm-php-workspace', cards: ['php-versions', 'php-install', 'php-handlers', 'php-extensions', 'php-configure', 'php-functions', 'host-tool-php-guardian'] },
  { route: '/whm/services/web', marker: 'data-whm-web-readback', cards: ['web-flow', 'web-stack', 'web-directives', 'web-comparison', 'web-backend', 'web-proxy', 'web-test-gate', 'web-pending', 'web-generations'] },
  { route: '/whm/transfers', marker: 'data-transfer-workspace', cards: ['transfer-source', 'transfer-identities', 'transfer-progress', 'transfer-import', 'transfer-plans'] },
]
const documentFor = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')
const count = (html: string, marker: string) => documentFor(html).querySelectorAll(`[${marker}]`).length
const render = (route: string, locale: 'en' | 'ar', extra: Partial<WhmSurfaceProps> = {}) => renderWhmDetailPage({ activeRoute: route, locale, principal: root, catalog, serverSettings: settings, hostname: settings.hostname, ...extra })!
const preservesCards = (html: string, cards: string[]) => {
  const document = documentFor(html)
  const mountedCards = [...document.querySelectorAll('section[data-whm-detail-section]')]
  expect(mountedCards.map(card => card.getAttribute('data-whm-detail-section'))).toEqual(cards)
  const presentation = new Set<Element>()
  if (cards.includes('php-handlers')) {
    const handlers = [...document.querySelectorAll('[data-whm-detail-section="php-handlers"] tbody > tr')]
    expect(handlers.map(row => row.querySelector('td')?.textContent?.trim())).toEqual(['PHP-FPM', 'CGI / suexec', 'suPHP', 'lsphp'])
    expect(document.querySelectorAll('details')).toHaveLength(2)
    for (const card of ['php-versions', 'php-functions']) expect(document.querySelectorAll(`[data-whm-detail-section="${card}"] details`)).toHaveLength(1)
    expect(document.querySelectorAll('[data-whm-detail-section="php-configure"] details')).toHaveLength(0)
    const editorRoots = document.querySelectorAll('[data-whm-detail-section="php-configure"] [data-php-editor-modes][data-presentation-tabs="panels"]')
    expect(editorRoots).toHaveLength(1)
    const modes = editorRoots[0]!
    expect(modes.querySelectorAll('[data-presentation-tab]')).toHaveLength(2)
    expect(modes.querySelectorAll('[role="tabpanel"]')).toHaveLength(2)
    for (const [id, key, panelId, selected] of [
      ['whm-php-common-tab', 'common', 'whm-php-common-panel', true],
      ['whm-php-file-tab', 'file', 'whm-php-file-panel', false],
    ] as const) {
      const tab = modes.querySelector<HTMLButtonElement>('#' + id)!
      const panel = modes.querySelector<HTMLElement>('#' + panelId)!
      expect(tab).not.toBeNull(); expect(panel).not.toBeNull()
      expect(tab.tagName).toBe('BUTTON'); expect(tab.type).toBe('button'); expect(tab.disabled).toBe(false)
      expect(tab.getAttribute('role')).toBe('tab'); expect(tab.getAttribute('data-presentation-tab')).toBe(key)
      expect(tab.getAttribute('aria-controls')).toBe(panelId); expect(tab.getAttribute('aria-selected')).toBe(String(selected))
      expect(tab.tabIndex).toBe(selected ? 0 : -1)
      expect(panel.getAttribute('role')).toBe('tabpanel'); expect(panel.getAttribute('aria-labelledby')).toBe(id)
      expect(panel.hidden).toBe(!selected)
      expect(tab.matches('[name],[formaction],[data-php-action],[data-php-version-command],[data-php-install-pick],[data-php-exception-revoke],[data-action],[data-xp-action],[api-url],[data-api-url]')).toBe(false)
      presentation.add(tab)
    }
    expect(document.querySelectorAll('[data-whm-php-refresh]')).toHaveLength(1)
    const inventoryRead = document.querySelector<HTMLButtonElement>('[data-whm-php-workspace] [data-whm-php-refresh]')!
    expect(inventoryRead.tagName).toBe('BUTTON'); expect(inventoryRead.type).toBe('button')
    expect(document.querySelector('[data-whm-php-status]')?.getAttribute('data-state')).toBe('unread')
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button')) {
      if (control !== inventoryRead && !presentation.has(control)) expect(control.disabled, control.outerHTML).toBe(true)
    }
  }
  return { document, presentation }
}
describe.each(pages)('saved-workspace mount $route', ({ route, marker, cards }) => {
  it('mounts once in English and Arabic while preserving all approved cards and field identities', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = render(route, locale)
      expect(count(html, marker)).toBe(1); preservesCards(html, cards)
      expect(count(html, 'data-whm-detail-route')).toBe(1); expect(html.match(/<h1\b/g)).toHaveLength(1)
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1])
      expect(new Set(ids).size).toBe(ids.length)
      expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
      if (route === '/whm/domains') { expect(count(html, 'data-whm-filter-table')).toBe(1); expect(count(html, 'data-whm-domain-settings')).toBe(1); expect(count(html, 'data-whm-domain-create')).toBe(1) }
      if (route === '/whm/ssl') {
        for (const hook of ['data-ssl-queue-rows', 'data-ssl-queue-status', 'data-ssl-order-log-rows', 'data-ssl-order-log-status', 'data-ssl-management-status', 'data-ssl-observations-refresh']) expect(count(html, hook)).toBe(1)
        expect(html).toMatch(/data-ssl-observations-refresh disabled/)
        expect(html).toMatch(/name="autossl-enabled"[^>]*disabled/)
      }
      if (route === '/whm/security/ssh') { expect(count(html, 'data-whm-ssh-policy')).toBe(1); expect(html).toMatch(/data-whm-ssh-port[^>]*value="2222"/); expect(html).toContain('data-whm-ssh-can-manage="true"'); expect(html).toContain('data-whm-ssh-manage="true"') }
      if (route === '/whm/security') expect(html).toContain(locale === 'en' ? 'Enrollment is optional.' : 'التسجيل اختياري.')
      if (route === '/whm/software/php') { expect(html).toContain('data-php-can-read="true"'); expect(html).toMatch(/name="php-install-request"[^>]*disabled/); expect(html).toMatch(/name="php-ini"[^>]*disabled/) }
      if (route === '/whm/services/web') {
        expect(count(html, 'data-server-settings-form')).toBe(1); expect(html).toContain('data-web-can-read="true"'); expect(html).toContain('data-web-can-rollback="false"')
        expect(count(html, 'data-whm-web-generation')).toBe(1); expect(count(html, 'data-whm-web-rollback')).toBe(1); expect(html).toMatch(/data-whm-web-rollback disabled/)
        for (const name of ['engine', 'apacheMpm', 'backendPort', 'backendTlsPort', 'nginx.workerProcesses', 'nginx.workerConnections', 'nginx.workerRlimitNofile', 'nginx.keepaliveTimeoutSec', 'nginx.multiAccept', 'apache.startServers', 'apache.minSpareServers', 'apache.maxSpareServers', 'apache.maxRequestWorkers', 'apache.serverLimit', 'apache.maxConnectionsPerChild']) expect(html.split('name="' + name + '"')).toHaveLength(2)
        expect(html).toContain('value="2048"')
      }
    }
  })

  it('retains the complete unavailable layout while withholding private state and executable forms', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = render(route, locale, { capabilityUnavailable: true })
      const { document, presentation } = preservesCards(html, cards); expect(count(html, marker)).toBe(1)
      expect(html).toContain('data-capability-state="unavailable"'); expect(document.querySelectorAll('form')).toHaveLength(0)
      expect(html).not.toContain(settings.hostname); expect(html).not.toContain('value="2222"'); expect(html).not.toContain('value="2048"')
      for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button')) {
        if (!presentation.has(control)) expect(control.disabled, control.outerHTML).toBe(true)
      }
      if (route === '/whm/software/php') expect(html).toContain('data-php-can-read="false"')
      if (route === '/whm/services/web') expect(html).toContain('data-web-can-read="false"')
      if (route === '/whm/security/ssh') expect(html).toContain('data-whm-ssh-manage="false"')
    }
  })

  it('requires authoritative administrator context regardless of a root display username', () => {
    for (const locale of ['en', 'ar'] as const) for (const principal of [undefined, { kind: 'user' as const, id: 'synthetic-user', username: 'root', accountId: 'synthetic-account' }, { kind: 'reseller' as const, id: 'synthetic-reseller', username: 'root' }]) {
      const html = render(route, locale, { principal })
      expect(html).toContain('data-whm-detail-denied'); expect(count(html, marker)).toBe(0)
      expect(html).not.toContain(settings.hostname); expect(html).not.toMatch(/<form\b|data-server-settings-form|value="2048"/)
    }
  })
})

describe('saved-workspace locale defaults', () => {
  it.each(['/whm/domains', '/whm/ssl'])('normalizes absent locale to English for %s', activeRoute => {
    for (const capabilityUnavailable of [false, true]) {
      const html = renderWhmDetailPage({ activeRoute, principal: root, catalog, capabilityUnavailable })!
      expect(html).not.toContain('lang="undefined"'); expect(html).toContain('lang="en"'); expect(html).toContain('dir="ltr"')
      expect(count(html, activeRoute === '/whm/domains' ? 'data-whm-domains-workspace' : 'data-whm-ssl')).toBe(1)
    }
  })
})

describe('global default-site policy authority', () => {
  it.each(['en', 'ar'] as const)('keeps the global policy root-only in %s within the shared domains page', locale => {
    const owned = render('/whm/domains', locale)
    expect(count(owned, 'data-default-site-workspace')).toBe(1); expect(owned).toContain('data-default-site-enabled="true"')
    for (const hook of ['form', 'response', 'redirect', 'refuse-https', 'save', 'discard', 'refresh', 'requests']) expect(count(owned, 'data-default-site-' + hook)).toBe(1)
    const reseller = render('/whm/domains', locale, { visibility: { principal: { kind: 'reseller', id: 'synthetic-reseller', username: 'reseller' }, reseller: { acl: ['list-accounts', 'edit-account'] } } })
    expect(render('/whm/domains', locale, { visibility: { principal: { kind: 'reseller', id: 'synthetic-reseller', username: 'reseller' }, reseller: { acl: ['edit-account'] } } })).toContain('data-whm-detail-denied')
    expect(reseller).toContain('data-whm-domains-manage="true"'); expect(reseller).toContain('data-default-site-enabled="false"')
    for (const html of [reseller, render('/whm/domains', locale, { capabilityUnavailable: true })]) {
      const policy = html.match(/<section class="xp-default-site"[\s\S]*?<\/section>/)![0]
      expect(policy).not.toMatch(/<form\b/)
      for (const tag of policy.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/g)) expect(tag[0]).toMatch(/\bdisabled\b/)
    }
  })
})
