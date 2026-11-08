// @vitest-environment jsdom
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { qualifyHostTools, tools } from '@xpanel/catalog'
import { defaultPlan, type Account, type ServerSettings } from '@xpanel/core'
import { renderWhmSurface } from '../surfaces/xwhm.ts'
import { renderWhmAuditExports, renderWhmAuditSupplement, renderWhmDetailPage, renderWhmDnsSupplement, whmDetailRoutes } from './approved-xwhm.ts'
import { WHM_SSL_CLIENT_BINDING } from '../whm-ssl-client.ts'
import { WHM_SSH_CLIENT_BINDING } from '../whm-ssh-client.ts'

const root = { kind: 'root' as const, id: 'synthetic-root', username: 'synthetic-root' }

// Positive renderer fixtures model only the named accepted control-plane operations.
// Production acceptance and host evidence are never changed by these local inputs.
const qualifiedControlPlaneFixture = (ids: readonly string[]) => {
  const accepted = new Set(ids)
  const catalog = qualifyHostTools(tools.map(tool => accepted.has(tool.id)
    ? { ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }
    : tool), { executor: 'linux', probes: { 'control-plane': 'passed' } }, true)
  for (const id of accepted) {
    assert.equal(catalog.find(tool => tool.id === id)?.status, 'verified', id)
    assert.equal(catalog.find(tool => tool.id === id)?.delivery.status, 'verified', id)
  }
  return catalog
}

const readyCatalog = tools.map(tool => ['feature-list-crud', 'server-settings-edit'].includes(tool.id) ? { ...tool, status: 'verified' as const } : tool)
const settings: ServerSettings = {
  hostname: 'synthetic.example.test', nameservers: ['ns1.example.test', 'ns2.example.test'], adminEmail: 'owner@example.test',
  engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 2222,
  nginx: { workerProcesses: 'auto', workerConnections: 2048, workerRlimitNofile: 8192, multiAccept: false, keepaliveTimeoutSec: 45 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 8, maxRequestWorkers: 200, maxConnectionsPerChild: 3000, serverLimit: 200 },
  backendPort: 8080, backendTlsPort: 8444,
}

const rows = [{ id: 'synthetic-private-audit-key', at: '2026-10-25T09:30:00.123Z', actor: 'synthetic-root', action: 'auth.login', target: 'synthetic-root', detail: { apiToken: 'must-never-be-exported' }, outcome: 'ok' as const }]

describe('detailed administrator workspaces', () => {


  it.each(['en', 'ar'] as const)('restores the complete Web Server architecture and saved configuration reference in %s', locale => {
    const current = { ...settings, backendPort: 18181, backendTlsPort: 19443 }
    const host = document.createElement('div')
    host.innerHTML = renderWhmDetailPage({ activeRoute: '/whm/services/web', locale, principal: root, serverSettings: current, catalog: readyCatalog })!
    assert.equal(host.querySelectorAll('[data-whm-web-hop]').length, 3)
    for (const key of ['web-flow', 'web-proxy', 'web-comparison', 'web-test-gate']) assert.ok(host.querySelector(`[data-whm-detail-section="${key}"]`), key)
    assert.equal(host.querySelectorAll('[data-whm-web-snapshot="page-load"]').length, 3)
    assert.equal(host.querySelectorAll('[data-whm-web-snapshot-setting]').length, 15)
    const proxy = host.querySelector('[data-whm-web-proxy-reference]')!
    assert.equal(proxy.getAttribute('data-state'), 'saved')
    assert.match(proxy.textContent!, /proxy_pass http:\/\/127\.0\.0\.1:18181;/)
    assert.match(proxy.textContent!, /proxy_set_header X-Forwarded-For \$remote_addr;/)
    assert.doesNotMatch(proxy.textContent!, /\$proxy_add_x_forwarded_for/)
    assert.equal(host.querySelector('[data-whm-web-snapshot-setting="backendTlsPort"]')!.textContent, '19443')
    assert.equal(host.querySelectorAll('[data-whm-detail-section="web-comparison"] th[scope="col"]').length, 5)
    assert.equal(host.querySelectorAll('[data-server-settings-form]').length, 1)
    assert.equal(host.querySelectorAll('[data-whm-web-readback]').length, 1)
    assert.equal(host.querySelectorAll('[data-whm-web-generation]').length, 1)
    assert.equal(host.querySelectorAll('[data-whm-web-rollback]').length, 1)
    assert.equal(host.querySelectorAll('[href="#whm-detail-web-pending"]').length, 1)
    const ids = [...host.querySelectorAll('[id]')].map(item => item.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.doesNotMatch(host.textContent!, /alice-shop|20014|1\.24\.0|2\.4\.58|[\u0660-\u0669\u06f0-\u06f9]/)
    assert.ok([...host.querySelectorAll('[data-whm-web-snapshot-setting] bdi')].every(item => item.getAttribute('dir') === 'ltr'))
  })

  it('uses the saved Web Server engine and MPM without claiming the flow is running', () => {
    for (const [engine, apacheMpm, expected] of [
      ['apache', 'itk', 'Saved Apache MPM: itk.'],
      ['apache', 'prefork', 'Saved Apache MPM: prefork.'],
      ['openlitespeed', 'itk', 'OpenLiteSpeed is the saved engine.'],
    ] as const) {
      const host = document.createElement('div')
      host.innerHTML = renderWhmDetailPage({ activeRoute: '/whm/services/web', principal: root, serverSettings: { ...settings, engine, apacheMpm }, catalog: readyCatalog })!
      const flow = host.querySelector('[data-whm-web-flow]')!
      assert.ok(flow.textContent!.includes(expected))
      assert.ok(flow.textContent!.includes('Runtime not observed'))
      assert.doesNotMatch(flow.textContent!, /\bRunning\b/)
    }
  })

  it('keeps defaults, proposed values and runtime unknown when the page snapshot is unread or denied', () => {
    for (const props of [{ catalog: readyCatalog }, { catalog: readyCatalog, capabilityUnavailable: true, serverSettings: { ...settings, backendPort: 18181, backendTlsPort: 19443 } }]) {
      const host = document.createElement('div')
      host.innerHTML = renderWhmDetailPage({ activeRoute: '/whm/services/web', principal: root, ...props })!
      assert.equal(host.querySelector('[data-whm-web-proxy-reference]')!.getAttribute('data-state'), 'unread')
      assert.equal(host.querySelectorAll('[data-whm-web-snapshot-setting]').length, 15)
      assert.ok([...host.querySelectorAll('[data-whm-web-snapshot-setting]')].every(item => item.textContent === 'Not read'))
      assert.doesNotMatch(host.innerHTML, /18181|19443|proxy_pass http:\/\/127\.0\.0\.1:/)
      if (props.capabilityUnavailable) {
        assert.equal(host.querySelectorAll('form').length, 0)
        assert.ok([...host.querySelectorAll('input,select,textarea,button')].every(item => (item as HTMLInputElement).disabled))
      }
    }
    const host = document.createElement('div')
    host.innerHTML = renderWhmDetailPage({ activeRoute: '/whm/services/web', principal: root, serverSettings: settings, catalog: readyCatalog })!
    const comparison = host.querySelector('[data-whm-detail-section="web-comparison"]')!
    assert.ok(comparison.textContent!.includes('A host-specific default baseline has not been supplied.'))
    assert.ok(comparison.textContent!.includes('Not reviewed'))
    assert.doesNotMatch(comparison.textContent!, /Default for 4 cores \/ 8 GB/)
  })

  it.each(whmDetailRoutes)('retains %s structure without invented observations or mutations in unavailable mode', activeRoute => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWhmDetailPage({ activeRoute, locale, capabilityUnavailable: true, principal: root, serverSettings: settings, featureLists: [{ id: 'private-list', name: 'DO-NOT-RENDER', disabled: [] }] })!
      assert.match(html, new RegExp(`data-whm-detail-route="${activeRoute}"`))
      assert.match(html, /data-capability-state="unavailable"/)
      const doc = new DOMParser().parseFromString(html, 'text/html')
      assert.equal(doc.querySelectorAll('form').length, 0, 'unavailable documents contain no live native form')
      assert.doesNotMatch(html, /synthetic\.example\.test|DO-NOT-RENDER|must-never-be-exported/)
      for (const control of doc.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')) assert.equal(control.disabled, true, control.outerHTML)
      assert.doesNotMatch(html, /[\u0660-\u0669\u06f0-\u06f9]/)
    }
  })

  it('integrates backup and reseller native controls exactly once without duplicating page headings', () => {
    const catalog = qualifiedControlPlaneFixture(['reseller-center'])
    const backups = renderWhmSurface({ principal: root, activeRoute: '/whm/backups', catalog, accounts: [] })
    const backupDoc = new DOMParser().parseFromString(backups, 'text/html')
    assert.equal(backupDoc.querySelectorAll('[data-account-backups="true"]').length, 1)
    assert.equal(backupDoc.querySelectorAll('h1').length, 1)
    const resellers = renderWhmSurface({ principal: root, activeRoute: '/whm/resellers', catalog, resellers: [], accounts: [] })
    const resellerDoc = new DOMParser().parseFromString(resellers, 'text/html')
    assert.equal(resellerDoc.querySelectorAll('form[data-reseller-create-form="true"]').length, 1)
    assert.equal(resellerDoc.querySelectorAll('h1').length, 1)
  })

  it.each(['/whm/backups', '/whm/backups/restore', '/whm/resellers', '/whm/resellers/privileges'])('does not pass DTOs or native forms to the %s availability fallback', activeRoute => {
    const html = renderWhmSurface({ activeRoute, capabilityUnavailable: true, principal: root, hostname: 'PRIVATE-HOST-MARKER', resellers: [{ id: 'private', username: 'PRIVATE-RESELLER-MARKER', acl: [], maxAccounts: 1, totalDiskMb: 1, totalBandwidthMb: 1, oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [] }] })
    assert.doesNotMatch(html, /<form\b|PRIVATE-HOST-MARKER|PRIVATE-RESELLER-MARKER|data-reseller-create-form/)
    assert.match(html, /data-approved-whm-/)
  })

  it('does not replace unrelated native controllers', () => {
    for (const activeRoute of ['/whm', '/whm/accounts', '/whm/plans', '/whm/audit', '/whm/security/firewall']) {
      assert.equal(renderWhmDetailPage({ activeRoute, principal: root }), undefined)
    }
  })

  it('does not infer administrator access from a display username or absent principal', () => {
    for (const principal of [undefined, { kind: 'user' as const, id: 'user', username: 'root', accountId: 'account' }]) {
      const html = renderWhmDetailPage({ activeRoute: '/whm/services/web', principal, serverSettings: settings })!
      assert.match(html, /data-whm-detail-denied/)
      assert.doesNotMatch(html, /<form|synthetic\.example\.test|name="engine"/)
    }
  })

  it('retains root-only settings restrictions for resellers', () => {
    const html = renderWhmDetailPage({ activeRoute: '/whm/security/ssh', principal: { kind: 'reseller', id: 'reseller', username: 'root' }, serverSettings: settings })!
    assert.match(html, /data-whm-detail-denied/)
    assert.doesNotMatch(html, /name="sshPort"/)
  })

  it('connects supported settings fields while retaining the full web-engine workspace', () => {
    const html = renderWhmDetailPage({ activeRoute: '/whm/services/web', principal: root, serverSettings: settings, catalog: readyCatalog })!
    assert.match(html, /data-server-settings-form/)
    for (const field of ['engine', 'apacheMpm', 'backendPort', 'backendTlsPort', 'nginx.workerProcesses', 'nginx.workerConnections', 'nginx.workerRlimitNofile', 'nginx.multiAccept', 'nginx.keepaliveTimeoutSec', 'apache.startServers', 'apache.minSpareServers', 'apache.maxSpareServers', 'apache.maxRequestWorkers', 'apache.serverLimit', 'apache.maxConnectionsPerChild']) assert.ok(html.includes(`name="${field}"`), field)
    assert.match(html, /value="2048"/)
    for (const section of ['web-stack', 'web-backend', 'web-pending', 'web-generations']) assert.ok(html.includes(`data-whm-detail-section="${section}"`))
  })

  it.each(['en', 'ar'] as const)('keeps complete Setup components in %s with real workers and no invented global defaults', locale => {
    const html = renderWhmDetailPage({ activeRoute: '/whm/server/setup', locale, principal: root, serverSettings: settings, catalog: readyCatalog })!
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1)
    assert.equal([...html.matchAll(/data-setup-wizard-form/g)].length, 1)
    assert.equal([...html.matchAll(/data-server-settings-form/g)].length, 1)
    for (const name of ['hostname', 'adminEmail', 'primaryIpv4', 'nameservers', 'engine', 'apacheMpm', 'panelPort', 'sshPort', 'quotaFilesystem', 'nginx.workerProcesses', 'nginx.workerConnections', 'nginx.workerRlimitNofile', 'nginx.keepaliveTimeoutSec', 'nginx.multiAccept', 'apache.startServers', 'apache.minSpareServers', 'apache.maxSpareServers', 'apache.maxRequestWorkers', 'apache.serverLimit', 'apache.maxConnectionsPerChild']) assert.equal([...html.matchAll(new RegExp(`name="${name.replaceAll('.', '\.') }"`, 'g'))].length, 1, name)
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]!)
    assert.equal(new Set(ids).size, ids.length, 'Setup control and section IDs are unique')
    assert.match(html, /value="2048"/)
    assert.match(html, /name="setup-nameserver-1"[^>]*value="ns1\.example\.test"[^>]*disabled/)
    for (const name of ['setup-nameserver-1-address', 'setup-nameserver-2-address', 'setup-fpm-mode', 'setup-fpm-max-children', 'setup-fpm-idle-timeout', 'setup-fpm-max-requests', 'setup-lsphp-server-connections', 'setup-lsphp-account-children', 'setup-lsphp-account-connections']) assert.match(html, new RegExp(`<(?:input|select)[^>]*name="${name}"[^>]*disabled`), name)
    for (const name of ['setup-notice-config-failure', 'setup-notice-certificate', 'setup-notice-upgrade', 'setup-notice-signin']) assert.match(html, new RegExp(`<input[^>]*name="${name}"[^>]*disabled`), name)
    assert.doesNotMatch(html, /[\u0660-\u0669\u06f0-\u06f9]/)
    assert.doesNotMatch(html, /value="(?:10\.0\.0\.12|10\.0\.0\.13|srv1\.xpanel\.test)"/)
  })

  it('leaves Setup worker editing unavailable without a saved settings observation', () => {
    const html = renderWhmDetailPage({ activeRoute: '/whm/server/setup', principal: root, catalog: readyCatalog })!
    assert.match(html, /data-setup-wizard-form/)
    assert.doesNotMatch(html, /data-server-settings-form/)
    for (const name of ['nginx.workerProcesses', 'nginx.workerConnections', 'apache.maxRequestWorkers']) assert.match(html, new RegExp(`<input[^>]*name="${name.replaceAll('.', '\.') }"[^>]*value=""[^>]*disabled`))
    assert.match(html, /name="primaryIpv4"[^>]*value=""[^>]*required/)
    assert.match(html, /Worker settings have not been read/)
    assert.match(html, /No candidate-generation test result/)
  })

  it('uses only the actual configured primary IPv4 in Setup and excludes secondary/IPv6 fallbacks', () => {
    const base = { id: 'synthetic-ip', prefixLength: 24, interfaceName: 'synthetic0', role: 'shared' as const, ownerKind: 'root' as const, ownerId: null, ptrHostname: null, notes: '' }
    const ipPool = [{ ...base, address: '2001:db8::8', version: 6 as const, isPrimary: true }, { ...base, address: '192.0.2.28', version: 4 as const, isPrimary: false }, { ...base, address: '192.0.2.29', version: 4 as const, isPrimary: true }]
    const html = renderWhmDetailPage({ activeRoute: '/whm/server/setup', principal: root, serverSettings: settings, catalog: readyCatalog, ipPool })!
    assert.match(html, /name="primaryIpv4"[^>]*value="192\.0\.2\.29"[^>]*required/)
    assert.doesNotMatch(html, /value="(?:192\.0\.2\.28|2001:db8::8|203\.0\.113\.10)"/)
    const unavailable = renderWhmDetailPage({ activeRoute: '/whm/server/setup', capabilityUnavailable: true, principal: root, serverSettings: settings, catalog: readyCatalog, ipPool })!
    assert.doesNotMatch(unavailable, /192\.0\.2\.29|<form\b/)
  })

  it.each([
    ['/whm/software/php', ['php-install', 'php-extensions', 'php-functions'], ['Set as default', 'Reinstall selected version', 'Add exception', 'Grant exception']],
    ['/whm/transfers', ['transfer-source', 'transfer-identities', 'transfer-progress', 'transfer-import'], ['SSH key', 'API token', 'Parsed plan', 'Not imported or changed']],
    ['/whm/server/upgrade', ['upgrade-version', 'upgrade-job', 'upgrade-history', 'upgrade-touches'], ['What changes', 'Confirm upgrade', 'Start upgrade', 'Run preflight again', 'Added', 'Cancel pending upgrade']],
  ] as const)('retains all final approved components without activating unsupported operations in %s', (activeRoute, sections, labels) => {
    const html = renderWhmDetailPage({ activeRoute, principal: root, locale: 'en', version: 'synthetic-v1', availableVersion: 'synthetic-v2' })!
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1)
    for (const section of sections) assert.ok(html.includes(`data-whm-detail-section="${section}"`), section)
    for (const label of labels) assert.ok(html.includes(label), label)
    // Presentation tabs change only the local editor view; all other native operations remain fenced.
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const workspace = doc.querySelector<HTMLElement>('[data-whm-detail-route="' + activeRoute + '"]')!
    assert.ok(workspace)
    const phpTabs = new Set<Element>()
    let inventoryRead: HTMLButtonElement | null = null
    if (activeRoute === '/whm/software/php') {
      const modes = workspace.querySelector('[data-php-editor-modes][data-presentation-tabs="panels"]')!
      assert.ok(modes)
      assert.equal(modes.querySelectorAll('[data-presentation-tab]').length, 2)
      for (const [id, key, panelId] of [['whm-php-common-tab', 'common', 'whm-php-common-panel'], ['whm-php-file-tab', 'file', 'whm-php-file-panel']] as const) {
        const tab = modes.querySelector<HTMLButtonElement>('#' + id)!
        const panel = modes.querySelector<HTMLElement>('#' + panelId)!
        assert.ok(tab); assert.ok(panel)
        assert.equal(tab.tagName, 'BUTTON'); assert.equal(tab.type, 'button'); assert.equal(tab.getAttribute('role'), 'tab')
        assert.equal(tab.getAttribute('data-presentation-tab'), key); assert.equal(tab.getAttribute('aria-controls'), panelId)
        assert.equal(panel.getAttribute('role'), 'tabpanel'); assert.equal(panel.getAttribute('aria-labelledby'), id)
        assert.equal(tab.disabled, false)
        assert.equal(tab.matches('[data-php-action],[data-php-version-command],[data-php-install-pick],[data-php-exception-revoke],[data-action],[data-xp-action],[api-url],[data-api-url]'), false)
        phpTabs.add(tab)
      }
      assert.equal(workspace.querySelectorAll('[data-whm-php-refresh]').length, 1)
      inventoryRead = workspace.querySelector<HTMLButtonElement>('[data-whm-php-workspace] [data-whm-php-refresh]')!
      assert.ok(inventoryRead); assert.equal(inventoryRead.tagName, 'BUTTON'); assert.equal(inventoryRead.type, 'button')
    }
    for (const control of doc.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button')) {
      if (control === inventoryRead || phpTabs.has(control)) continue
      assert.equal(control.disabled, true, control.outerHTML)
    }
    assert.doesNotMatch(html, /<form\b|value="(?:8\.1|8\.3|1\.5\.0|srv0\.xpanel\.test)"/)
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]!)
    assert.equal(new Set(ids).size, ids.length)
  })

  it('appends DNS import/export, SOA, history and health without replacing native CRUD', () => {
    const catalog = qualifyHostTools(tools, { executor: 'linux', probes: { 'control-plane': 'passed' } })
    const html = renderWhmSurface({ principal: root, activeRoute: '/whm/dns', catalog, accounts: [] })
    const doc = new DOMParser().parseFromString(html, 'text/html')
    for (const selector of ['[data-dns-editor="true"]', '[data-dns-add-zone="true"]', '[data-dns-add-record="true"]', '[data-dns-save="true"]', '[data-dns-delete="true"]', '[data-approved-whm-dns-supplement]']) assert.equal(doc.querySelectorAll(selector).length, 1, selector)
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1)
    for (const label of ['Import BIND zone', 'Export zone file', 'SOA serial', 'Zone change history', 'PowerDNS API']) assert.ok(html.includes(label), label)
    assert.equal(renderWhmDnsSupplement({ principal: { kind: 'user', id: 'user', username: 'root', accountId: 'account' } }), '')
    const unavailable = renderWhmDetailPage({ activeRoute: '/whm/dns', capabilityUnavailable: true, accounts: [{ username: 'PRIVATE-DNS-ACCOUNT' } as never], services: [{ name: 'PRIVATE-PDNS' } as never] })!
    assert.doesNotMatch(unavailable, /<form\b|PRIVATE-DNS-ACCOUNT|PRIVATE-PDNS/)
    for (const element of unavailable.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/g)) assert.match(element[0], /\bdisabled\b/)
    assert.match(unavailable, /data-whm-detail-section="dns-record-unavailable"/)
  })

  it('uses the narrow settings capability from the full catalog and does not unlock forms from broad metadata', () => {
    const broadOnly = tools.map(tool => ({ ...tool, status: tool.id === 'server-settings-edit' ? 'researched' as const : 'verified' as const }))
    const held = renderWhmDetailPage({ activeRoute: '/whm/security/ssh', principal: root, catalog: broadOnly, serverSettings: settings })!
    assert.match(held, /data-capability-state="unavailable"/)
    assert.doesNotMatch(held, /<form\b|value="2222"/)
    const nativeOnly = tools.map(tool => ({ ...tool, status: tool.id === 'server-settings-edit' ? 'verified' as const : 'researched' as const }))
    const ready = renderWhmDetailPage({ activeRoute: '/whm/security/ssh', principal: root, catalog: nativeOnly, serverSettings: settings })!
    assert.match(ready, /data-whm-ssh-policy/)
    assert.match(ready, /data-whm-ssh-port [^>]*value="2222"/)
  })

  it.each([
    ['/whm/domains', ['Domain kind', 'SSL assignment', 'PHP version', 'Clear filters', 'Site type', 'Wildcard', 'Unbound requests', 'Save default site', 'Discard']],
    ['/whm/ssl', ['Challenge', 'Auto-renew', 'Retry', 'Replace', 'Renewal queue', 'Next attempt (UTC)', 'Validation', 'Save AutoSSL settings', 'Discard']],
    ['/whm/security/ssh', ['Keys and password', 'Added (UTC)', 'Last used (UTC)', 'Remove managed key', 'Last 24 hours', 'Method', 'Count', 'Result', 'Banned by SSH']],
    ['/whm/services/web', ['client_max_body_size', 'Use suggested values', 'Unlimited child lifetime', 'Pending configuration difference', 'Proposed', 'Discard pending change', 'Restore selected generation']],
    ['/whm/security', ['Enable secret entrance path', 'Enable IP allowlist', 'By IP address', 'Block the address for', 'No expiry', 'Unlimited request rate', 'Unlimited burst', 'Unlimited request body']],
  ] as const)('keeps all final reference microstates in %s with unique controls', (activeRoute, labels) => {
    const html = renderWhmDetailPage({ activeRoute, principal: root, catalog: readyCatalog, serverSettings: settings, domains: [], certificates: [{ names: ['synthetic.example.test'], notAfter: '2027-01-01T00:00:00.000Z' }] })!
    // Certificate and key rows are rendered by the client from observed data; their controls live there.
    const surface = html + (activeRoute === '/whm/ssl' ? WHM_SSL_CLIENT_BINDING : activeRoute === '/whm/security/ssh' ? WHM_SSH_CLIENT_BINDING : '')
    for (const label of labels) assert.ok(surface.includes(label), label)
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1)
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]!)
    assert.equal(new Set(ids).size, ids.length, activeRoute)
  })

  it.each(['/whm/accounts', '/whm/accounts/new', '/whm/plans', '/whm/security/firewall', '/whm/services'] as const)('keeps complete %s unavailable layout without private records or forms', activeRoute => {
    const html = renderWhmDetailPage({ activeRoute, capabilityUnavailable: true, principal: root, accounts: [{ username: 'PRIVATE-ACCOUNT' } as never], plans: [{ name: 'PRIVATE-PLAN' } as never], services: [{ name: 'PRIVATE-SERVICE' } as never] })!
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    assert.equal(doc.querySelectorAll('form').length, 0, 'unavailable documents contain no live native form')
    assert.doesNotMatch(html, /PRIVATE-ACCOUNT|PRIVATE-PLAN|PRIVATE-SERVICE/)
    for (const control of doc.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button')) assert.equal(control.disabled, true, control.outerHTML)
    if (activeRoute === '/whm/plans') for (const label of ['Read operations per second', 'Addon domains', 'Default mailbox quota', 'Impact', 'Unsaved changes']) assert.ok(html.includes(label), label)
    if (activeRoute === '/whm/accounts/new') for (const label of ['Username', 'Primary domain', 'Contact email', 'Password', 'IPv4 assignment', 'Owner', 'Shell', 'What will be created']) assert.ok(html.includes(label), label)
  })

  it('integrates account and plan components without nested forms, duplicate IDs or dropped native controls', () => {
    const plan = defaultPlan({ featureListId: '40000000-0000-4000-8000-000000000001', ownerId: null })
    const account: Account = { id: '20000000-0000-4000-8000-000000000001', username: 'synthetic7', uid: 1007, gid: 1007, home: '/home/synthetic7', primaryDomain: 'synthetic7.example.test', planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'synthetic7@example.test', ipv4: '192.0.2.7', shell: 'none', createdAt: '2026-10-25T00:00:00.000Z' }
    const catalog = qualifiedControlPlaneFixture(['list-accounts', 'modify-account'])
    for (const activeRoute of ['/whm/accounts', '/whm/accounts/new', '/whm/plans']) {
      const html = renderWhmSurface({ principal: root, catalog, activeRoute, accounts: [account], plans: [plan], resellers: [], featureLists: [{ id: plan.featureListId, name: 'Synthetic list', disabled: [] }] })
      assert.equal([...html.matchAll(/<h1\b/g)].length, 1)
      let depth = 0
      for (const token of html.matchAll(/<\/?form\b[^>]*>/g)) {
        depth += token[0].startsWith('</') ? -1 : 1
        assert.ok(depth >= 0 && depth <= 1, `nested form in ${activeRoute}`)
      }
      assert.equal(depth, 0)
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]!)
      assert.equal(new Set(ids).size, ids.length, activeRoute)
      if (activeRoute === '/whm/accounts') {
        for (const marker of ['data-account-row="synthetic7"', 'data-account-plan-form', 'data-account-table-value="disk"', 'data-account-table-value="bandwidth"', 'data-account-bulk-control']) assert.ok(html.includes(marker), marker)
        const doc = new DOMParser().parseFromString(html, 'text/html')
        assert.equal(doc.querySelectorAll('form[data-account-plan-form="true"][data-account-username="synthetic7"]').length, 1)
      }
      if (activeRoute === '/whm/accounts/new') for (const marker of ['data-create-account-form', 'data-approved-account-create-fields', 'data-account-generate-password', 'data-account-toggle-password', 'data-approved-account-create-status']) assert.equal([...html.matchAll(new RegExp(`<[a-z][^>]*\\s${marker}(?:[\\s=>])`, 'g'))].length, 1, marker)
      if (activeRoute === '/whm/plans') for (const label of ['Impact', 'Unsaved changes', 'How saving applies']) assert.ok(html.includes(label), label)
    }
  })

  it('places creation progress only after the native create form and never inside either of two account rows', () => {
    const plan = defaultPlan({ featureListId: '40000000-0000-4000-8000-000000000001', ownerId: null })
    const first: Account = { id: '20000000-0000-4000-8000-000000000001', username: 'synthetic7', uid: 1007, gid: 1007, home: '/home/synthetic7', primaryDomain: 'synthetic7.example.test', planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'synthetic7@example.test', ipv4: '192.0.2.7', shell: 'none', createdAt: '2026-10-25T00:00:00.000Z' }
    const second: Account = { ...first, id: '20000000-0000-4000-8000-000000000002', username: 'synthetic8', uid: 1008, gid: 1008, home: '/home/synthetic8', primaryDomain: 'synthetic8.example.test', contactEmail: 'synthetic8@example.test', ipv4: '192.0.2.8' }
    const props = { principal: root, catalog: qualifyHostTools(tools, { executor: 'linux', probes: { 'control-plane': 'passed' } }), accounts: [first, second], plans: [plan], resellers: [] }
    const create = renderWhmSurface({ ...props, activeRoute: '/whm/accounts/new' })
    assert.equal([...create.matchAll(/<[a-z][^>]*\sdata-approved-account-create-status(?:[\s=>])/g)].length, 1, 'native Create has one progress/result workspace')
    const createFormStart = create.indexOf('data-create-account-form="true"')
    const createFormEnd = create.indexOf('</form>', createFormStart)
    const createStatusStart = /<[a-z][^>]*\sdata-approved-account-create-status(?:[\s=>])/.exec(create)?.index ?? -1
    assert.ok(createFormStart >= 0 && createFormEnd > createFormStart && createStatusStart > createFormEnd, 'progress follows the native create form')
    assert.match(create, /What will be created/)
    assert.match(create, /data-account-create-another/)
    const list = renderWhmSurface({ ...props, activeRoute: '/whm/accounts' })
    assert.equal([...list.matchAll(/<tr data-account-row=/g)].length, 2)
    assert.doesNotMatch(list, /<[a-z][^>]*\s(?:data-approved-account-create-status|data-account-create-another|data-account-creation-step)(?:[\s=>])/)
    for (const html of [create, list]) {
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]!)
      assert.equal(new Set(ids).size, ids.length, 'actual HTML id attributes must be unique')
    }
  })

  it('does not represent desired engine or PHP compatibility as installed package evidence', () => {
    const html = renderWhmDetailPage({ activeRoute: '/whm/software/php', principal: root })!
    assert.match(html, /kept separate from installed package and runtime evidence/)
    assert.match(html, /Installed versions/)
    assert.match(html, /Configure a version/)
    assert.match(html, /Dangerous functions/)
  })

  it('uses persisted feature keys, deduplicates shared keys and preserves exact spelling', () => {
    const base = tools.find(tool => tool.featureKey !== null)!
    const catalog = [...readyCatalog.filter(tool => tool.id === 'feature-list-crud'), { ...base, id: 'one', featureKey: 'SSL/TLS' }, { ...base, id: 'two', featureKey: 'SSL/TLS' }, { ...base, id: 'three', featureKey: 'Email Filtering Manager' }]
    const html = renderWhmDetailPage({ activeRoute: '/whm/plans/features', principal: root, catalog, featureLists: [{ id: 'synthetic-list', name: 'Visible list', ownerId: null, disabled: ['SSL/TLS'] }] })!
    assert.match(html, /data-feature-list-create-form/)
    assert.match(html, /data-feature-list-update-form data-feature-list-id="synthetic-list"/)
    assert.equal([...html.matchAll(/name="disabled" value="SSL\/TLS"/g)].length, 1)
    assert.match(html, /name="disabled" value="SSL\/TLS" checked/)
    assert.match(html, /value="Email Filtering Manager"/)
    assert.doesNotMatch(html, /value="one"|value="two"|value="three"/)
    assert.match(html, /id="whm-feature-name-synthetic-list"/)
    assert.match(html, /id="whm-feature-create-name"/)
  })

  it('does not invent enabled feature membership when only list names were read', () => {
    const html = renderWhmDetailPage({ activeRoute: '/whm/plans/features', principal: root, catalog: readyCatalog, featureLists: [{ id: 'list', name: 'Only a name' }] })!
    assert.match(html, /Feature membership has not been read/)
    assert.doesNotMatch(html, /<form[^>]*data-feature-list-update-form/)
  })

  it('does not expose another reseller’s feature lists', () => {
    const principal = { kind: 'reseller' as const, id: 'mine', username: 'mine' }
    const html = renderWhmDetailPage({ activeRoute: '/whm/plans/features', principal, catalog: readyCatalog, visibility: { principal, reseller: { acl: ['manage-feature-lists'] } }, featureLists: [{ id: 'theirs', name: 'Not authorized', ownerId: 'other', disabled: [] }, { id: 'mine', name: 'Owned list', ownerId: 'mine', disabled: [] }] })!
    assert.match(html, /Owned list/)
    assert.doesNotMatch(html, /Not authorized/)
  })

  it('keeps shared feature lists read-only for a reseller while allowing owned lists', () => {
    const principal = { kind: 'reseller' as const, id: 'owner', username: 'owner' }
    const html = renderWhmDetailPage({ activeRoute: '/whm/plans/features', principal, catalog: readyCatalog, visibility: { principal, reseller: { acl: ['manage-feature-lists'] } }, featureLists: [{ id: 'global', name: 'Shared list', ownerId: null, disabled: [] }, { id: 'owned', name: 'Owned list', ownerId: 'owner', disabled: [] }] })!
    assert.match(html, /Shared list/)
    assert.match(html, /data-feature-list-update-form data-feature-list-id="owned"/)
    assert.doesNotMatch(html, /data-feature-list-update-form data-feature-list-id="global"|data-feature-list-delete data-feature-list-id="global"/)
    assert.match(html, /id="whm-feature-name-global"[^>]*disabled/)
  })

  it('keeps security components while declaring unsupported host writes honestly', () => {
    const html = renderWhmDetailPage({ activeRoute: '/whm/security', principal: root })!
    for (const title of ['Access', 'Two-factor for root', 'Sign-in lockout', 'API tokens', 'Nginx web application firewall', 'Dangerous PHP functions', 'Compiler lock', 'Path patterns', 'User-agent patterns', 'Answer for denied requests', 'Current API tokens', 'accounts:read', 'Add account', 'Remove exception', 'Unlock username', 'Unblock address']) assert.ok(html.includes(title), title)
    assert.match(html, /Enrollment is optional/)
    assert.doesNotMatch(html, /required enrollment|generate recovery|value="[0-9]{6}"/i)
  })
})

describe('administrator audit fidelity and data boundaries', () => {
  it.each(['en', 'ar'] as const)('retains %s locale, theme, density and all real filters in form submission and keyset navigation', locale => {
    const html = renderWhmSurface({ principal: root, locale, theme: 'dark', density: 'compact', activeRoute: '/whm/audit', auditEntries: rows, auditList: { actor: 'synthetic-root', action: 'auth.login', target: '', before: '42', hasMore: true, oldestId: '40', outcome: 'ok', from: '2026-10-25T09:00:00.000Z', to: '2026-10-25T10:00:00.000Z' } })
    for (const [name, expected] of [['lang', locale], ['theme', 'dark'], ['density', 'compact']]) assert.ok(html.includes(`type="hidden" name="${name}" value="${expected}"`))
    for (const filter of ['outcome=ok', 'from=2026-10-25', 'to=2026-10-25', `lang=${locale}`, 'theme=dark', 'density=compact', 'before=40']) assert.ok(html.includes(filter), filter)
    assert.match(html, /type="datetime-local" step="0.001" value="2026-10-25T09:00:00.000"/)
    assert.ok(html.includes('actor=synthetic-root'), 'Context switches retain audit filters')
    assert.match(html, /data-audit-entry-detail/)
    assert.match(html, /data-whm-detail-section="audit-config-generations"/)
  })

  it('exports only visible public audit fields without raw details or internal row keys', () => {
    const html = renderWhmAuditExports({ locale: 'en', auditEntries: rows })
    const match = /href="(data:application\/json[^"]+)"/.exec(html)!
    const body = JSON.parse(decodeURIComponent(match[1]!.split(',')[1]!)) as Array<Record<string, unknown>>
    assert.equal(body.length, 1)
    assert.deepEqual(Object.keys(body[0]!), ['at', 'actor', 'action', 'target', 'outcome'])
    assert.doesNotMatch(JSON.stringify(body), /synthetic-private-audit-key|must-never-be-exported|apiToken/)
    assert.doesNotMatch(renderWhmAuditSupplement({ auditEntries: rows }), /must-never-be-exported|apiToken/)
  })

  it('neutralizes spreadsheet formula prefixes in CSV exports', () => {
    const html = renderWhmAuditExports({ auditEntries: [{ ...rows[0]!, actor: '=SUM(1,1)' }] })
    const href = /href="(data:text\/csv[^"]+)"/.exec(html)![1]!
    const csv = decodeURIComponent(href.split(',')[1]!)
    assert.ok(csv.includes("'=SUM(1,1)"))
  })
})

describe('readable administrator audit and generation presentation', () => {
  it.each(['en', 'ar'] as const)('uses minute-precision human dates in %s without changing audit export or generation inputs', locale => {
    const at = '2026-10-27T14:00:01.123456+02:00'
    const auditEntries = [{ ...rows[0]!, at }]
    const generations = [{ generationId: 42, at, actor: 'synthetic-root', summary: 'Synthetic saved generation', stateChecksum: 'a'.repeat(64), filesCount: 7, durationMs: 5, status: 'superseded' as const }]
    const original = JSON.stringify({ auditEntries, generations })
    const supplement = renderWhmAuditSupplement({ locale, auditEntries, generations })
    const summary = /<details data-audit-entry-detail><summary>([\s\S]*?)<\/summary>/.exec(supplement)![1]!
    assert.ok(summary.includes('2026-10-27 12:00 UTC'))
    const auditGenerations = supplement.split('data-whm-detail-section="audit-config-generations"')[1]!.split('</section>')[0]!
    assert.ok(auditGenerations.includes('>2026-10-27 12:00 UTC<'))
    const web = renderWhmDetailPage({ activeRoute: '/whm/services/web', locale, principal: root, serverSettings: settings, catalog: readyCatalog, generations })!
    const webGenerations = web.split('data-whm-detail-section="web-generations"')[1]!.split('</section>')[0]!
    assert.ok(webGenerations.includes('>2026-10-27 12:00 UTC<'))
    const exportsHtml = renderWhmAuditExports({ locale, auditEntries })
    const jsonHref = /href="(data:application\/json[^"]+)"/.exec(exportsHtml)![1]!
    const exported = JSON.parse(decodeURIComponent(jsonHref.slice(jsonHref.indexOf(',') + 1))) as Array<Record<string, unknown>>
    assert.equal(exported[0]!.at, '2026-10-27T14:00:01.123456+02:00')
    assert.deepEqual(Object.keys(exported[0]!), ['at', 'actor', 'action', 'target', 'outcome'])
    assert.doesNotMatch(JSON.stringify(exported), /synthetic-private-audit-key|must-never-be-exported|apiToken/)
    const csvHref = /href="(data:text\/csv[^"]+)"/.exec(exportsHtml)![1]!
    assert.ok(decodeURIComponent(csvHref.slice(csvHref.indexOf(',') + 1)).includes('"2026-10-27T14:00:01.123456+02:00"'))
    assert.equal(JSON.stringify({ auditEntries, generations }), original)
    assert.doesNotMatch(summary + auditGenerations + webGenerations, /[\u0660-\u0669\u06f0-\u06f9]/)
  })
})
