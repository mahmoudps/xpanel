// @vitest-environment jsdom
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { qualifyHostTools, tools } from '@xpanel/catalog'
import type { FirewallRule } from '@xpanel/core'
import { APPROVED_WHM_OPERATIONS_TABS_CLIENT, renderApprovedWhmOperationsSupplement } from './approved-whm-operations-components.ts'

const root = { kind: 'root' as const, id: 'private-root-id', username: 'operator' }
const portCatalog = tools.map(tool => tool.id === 'aapanel-port-rules' ? { ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } } : tool)
const serviceCatalog = qualifyHostTools(tools, { executor: 'linux', probes: { 'control-plane': 'passed', systemd: 'passed' } })
const rule: FirewallRule = { id: 'private-rule-id', kind: 'port', action: 'drop', protocol: 'tcp', port: '8448', source: '192.0.2.32/28', forwardTo: null, list: null, comment: 'synthetic saved rule', enabled: true }
const inputs = (html: string): string[] => [...html.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)].map(match => match[0])

describe('approved native operations component supplement', () => {
  it('does not replace other routes or add a second page heading', () => {
    assert.equal(renderApprovedWhmOperationsSupplement({ principal: root, activeRoute: '/whm' }), '')
    for (const activeRoute of ['/whm/security/firewall', '/whm/services']) {
      const html = renderApprovedWhmOperationsSupplement({ principal: root, activeRoute, catalog: portCatalog })
      assert.doesNotMatch(html, /<h1\b|data-host-services|data-host-service-rows/)
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]!)
      assert.equal(new Set(ids).size, ids.length)
    }
  })

  it.each(['/whm/security/firewall', '/whm/services'])('requires root authority for %s even if display identity or catalog suggests it', activeRoute => {
    for (const principal of [undefined, { kind: 'reseller' as const, id: 'other', username: 'root' }, { kind: 'user' as const, id: 'other', accountId: 'tenant', username: 'root' }]) {
      const html = renderApprovedWhmOperationsSupplement({ activeRoute, principal, catalog: portCatalog, firewallRules: [rule] })
      assert.match(html, /data-whm-ops-denied/)
      assert.doesNotMatch(html, /<form\b|synthetic saved rule|192\.0\.2\.32|<input\b/)
    }
  })

  it.each(['/whm/security/firewall', '/whm/services'])('retains %s components without DTOs, forms or mutations when capabilities are unavailable', activeRoute => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderApprovedWhmOperationsSupplement({ activeRoute, locale, principal: root, catalog: portCatalog, capabilityUnavailable: true, firewallRules: [rule], hostname: 'private-host-marker' })
      assert.match(html, /data-operation-state="unavailable"/)
      assert.doesNotMatch(html, /<form\b|synthetic saved rule|192\.0\.2\.32|private-rule-id|private-host-marker|value="8448"/)
      for (const input of inputs(html)) assert.match(input, /\bdisabled\b/, input)
      assert.doesNotMatch(html, /[\u0660-\u0669\u06f0-\u06f9]/)
    }
  })

  it('does not treat an absent catalog or a status-only flag as port-rule qualification', () => {
    const deliveryUnverified = portCatalog.map(tool => tool.id === 'aapanel-port-rules' ? { ...tool, delivery: { ...tool.delivery, status: 'researched' as const } } : tool)
    for (const catalog of [undefined, tools, deliveryUnverified]) {
      const html = renderApprovedWhmOperationsSupplement({ activeRoute: '/whm/security/firewall', principal: root, catalog, firewallRules: [rule] })
      assert.doesNotMatch(html, /<form\b|synthetic saved rule|value="8448"/)
      for (const input of inputs(html)) assert.match(input, /\bdisabled\b/)
    }
  })

  it('connects only root-qualified port creation to its exact client contract', () => {
    const html = renderApprovedWhmOperationsSupplement({ activeRoute: '/whm/security/firewall', principal: root, catalog: portCatalog, firewallRules: [rule] })
    assert.equal([...html.matchAll(/<form\b/g)].length, 1)
    assert.match(html, /<form[^>]*data-firewall-port-rule-form/)
    assert.match(html, /data-firewall-port-rule-status role="status"/)
    for (const name of ['protocol', 'port', 'source', 'comment']) {
      const input = inputs(html).find(item => item.includes(`name="${name}"`))!
      assert.ok(input, name)
      assert.doesNotMatch(input, /\bdisabled\b/, name)
    }
    for (const value of ['accept', 'drop', 'reject']) assert.match(html, new RegExp(`name="action" value="${value}" required`))
    const position = inputs(html).find(item => item.includes('name="position"'))!
    assert.doesNotMatch(position, /\bdisabled\b/)
    assert.match(html, /<option value="top">At the top<\/option>/)
    assert.match(html, /value="end" selected/)
    assert.match(html, /type="submit">Check and save/)
    assert.doesNotMatch(html, /data-endpoint|\/api\/|sessionIp|value="203\.0\.113\.7"/)
    assert.match(html, /do not establish that the live firewall accepted or enforced/)
    assert.doesNotMatch(html, /private-rule-id/)
  })

  it('renders all six rule categories with honest observed values and unread unsupported metadata', () => {
    const rows: FirewallRule[] = [rule, { ...rule, id: 'private-prefix-id', kind: 'prefix-list', list: 'synthetic-feed', port: '443', source: null }, { ...rule, id: 'private-forward-id', kind: 'forward', forwardTo: '192.0.2.31:3306' }]
    const html = renderApprovedWhmOperationsSupplement({ activeRoute: '/whm/security/firewall', principal: root, catalog: portCatalog, firewallRules: rows })
    for (const category of ['port', 'ip', 'forward', 'icmp', 'prefix-list', 'banned']) assert.match(html, new RegExp(`data-firewall-category="${category}"`))
    assert.equal([...html.matchAll(/data-whm-firewall-tab="/g)].length, 6)
    assert.match(html, /synthetic saved rule/)
    assert.match(html, /synthetic-feed/)
    assert.match(html, /192\.0\.2\.31:3306/)
    assert.match(html, /No saved address rules/)
    assert.match(html, /live ban set and its timeouts have not been read/)
    assert.match(html, /<h3>Banned <span class="xp-help">\(Not read\)<\/span>/)
    for (const title of ['Upload prefix list', 'Replace file', 'Unban', 'Import JSON', 'Export JSON', 'What a save does']) assert.ok(html.includes(title), title)
    assert.match(html, /data-firewall-action="import"/)
    assert.match(html, /data-firewall-action="export"/)
    assert.doesNotMatch(html, /not connected in this view|not exposed by the HTTP API/)
    for (const name of ['firewall-prefix-name', 'firewall-prefix-file', 'firewall-prefix-ports', 'firewall-prefix-action', 'firewall-unban-address', 'firewall-import-file', 'firewall-import-json']) {
      assert.match(inputs(html).find(input => input.includes(`name="${name}"`))!, /\bdisabled\b/, name)
    }
    assert.doesNotMatch(html, /private-prefix-id|private-forward-id|Generation 142|Banned now.*3 addresses/)
  })

  it('escapes saved rule fields rather than copying markup or internal keys', () => {
    const html = renderApprovedWhmOperationsSupplement({ activeRoute: '/whm/security/firewall', principal: root, catalog: portCatalog, firewallRules: [{ ...rule, comment: '<img src=x onerror=alert(1)>', source: '<source>' }] })
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
    assert.match(html, /&lt;source&gt;/)
    assert.doesNotMatch(html, /<img|private-rule-id/)
  })

  it('keeps optional service installation honest while pointing to real settings routes', () => {
    const html = renderApprovedWhmOperationsSupplement({ activeRoute: '/whm/services', principal: root, catalog: serviceCatalog, services: [{ name: 'synthetic-service', unit: 'private-unit', version: 'private-version', active: true, enabled: true, rssMb: 9, role: 'private-role' }] })
    for (const title of ['Restart confirmation', 'Cancel', 'Optional services', 'OpenLiteSpeed', 'ModSecurity with OWASP CRS', 'Install OpenLiteSpeed', 'Install ModSecurity', 'Installation state', 'Not read']) assert.ok(html.includes(title), title)
    assert.match(html, /href="\/whm\/services\/web\?lang=en&amp;theme=dark&amp;density=comfortable"/)
    assert.match(html, /href="\/whm\/security\?lang=en&amp;theme=dark&amp;density=comfortable"/)
    assert.doesNotMatch(html, /<form\b|data-service-restart|synthetic-service|private-unit|private-version|>Installing<|>Not installed<|>Queued<|4\.1 GB|12 of 12/)
    for (const input of inputs(html)) assert.match(input, /\bdisabled\b/)
    for (const install of html.matchAll(/<button\b[^>]*>Install (?:OpenLiteSpeed|ModSecurity)<\/button>/g)) assert.match(install[0], /\bdisabled\b/)
    assert.match(html, /No installation has been requested or queued/)
  })
})


describe('serialized rule-category tabs', () => {
  it.each(['en', 'ar'] as const)('switches visible panels and maintains %s keyboard navigation without a host request', locale => {
    document.body.innerHTML = renderApprovedWhmOperationsSupplement({ activeRoute: '/whm/security/firewall', locale, capabilityUnavailable: true })
    new Function(`(${APPROVED_WHM_OPERATIONS_TABS_CLIENT})();`)()
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-whm-firewall-tab]'))
    const panels = Array.from(document.querySelectorAll<HTMLElement>('[data-whm-firewall-panel]'))
    assert.equal(tabs.length, 6)
    assert.equal(panels.filter(panel => !panel.hidden).length, 1)
    assert.equal(panels.find(panel => !panel.hidden)?.dataset.whmFirewallPanel, 'port')
    tabs[4]!.click()
    assert.equal(panels.find(panel => !panel.hidden)?.dataset.whmFirewallPanel, 'prefix-list')
    assert.equal(tabs[4]!.getAttribute('aria-selected'), 'true')
    assert.equal(tabs[4]!.tabIndex, 0)
    tabs[4]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
    assert.equal(document.activeElement, tabs[0])
    tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    assert.equal(document.activeElement, tabs[locale === 'ar' ? 5 : 1])
    assert.equal(document.querySelectorAll('form').length, 0)
    for (const input of document.querySelectorAll<HTMLInputElement>('input')) assert.equal(input.disabled, true)
    document.body.replaceChildren()
  })

  it('preserves modifier and IME behavior and ignores an incomplete tab contract', () => {
    document.body.innerHTML = renderApprovedWhmOperationsSupplement({ activeRoute: '/whm/security/firewall', capabilityUnavailable: true })
    new Function(`(${APPROVED_WHM_OPERATIONS_TABS_CLIENT})();`)()
    const first = document.querySelector<HTMLButtonElement>('[data-whm-firewall-tab]')!
    for (const init of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }]) {
      const event = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true, ...init })
      first.dispatchEvent(event)
      assert.equal(event.defaultPrevented, false)
      assert.equal(first.getAttribute('aria-selected'), 'true')
    }
    document.body.innerHTML = '<div data-whm-firewall-tabs><button data-whm-firewall-tab="port" disabled>Ports</button></div>'
    new Function(`(${APPROVED_WHM_OPERATIONS_TABS_CLIENT})();`)()
    assert.equal(document.querySelector<HTMLButtonElement>('button')!.disabled, true)
    document.body.replaceChildren()
  })
})
