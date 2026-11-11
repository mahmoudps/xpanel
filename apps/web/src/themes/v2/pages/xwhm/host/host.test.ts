import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import { HOST_PAGES_CSS, type HostPageProps } from './common.ts'
import { renderV2WhmServices, renderV2WhmServiceManager } from './services.ts'
import { renderV2WhmFirewall } from './firewall.ts'
import { renderV2WhmPhp } from './php.ts'

const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const root: HostPageProps = { principal: { kind: 'root', id: 'r1', username: 'root' }, catalog }
const owner: HostPageProps = { principal: { kind: 'user', id: 'u1', accountId: 'a1', username: 'alice' }, catalog }

describe('v2 host page authorization and observations', () => {
  for (const [name, render] of [['services', renderV2WhmServices], ['manager', renderV2WhmServiceManager], ['firewall', renderV2WhmFirewall], ['php', renderV2WhmPhp]] as const) {
    it(`${name} keeps server data and controls out of an account surface`, () => {
      const html = render({ ...owner, adminSessionIp: '192.0.2.91', hostname: 'private.example.test' })
      expect(html).toContain('data-whm-detail-denied')
      expect(html).not.toContain('192.0.2.91')
      expect(html).not.toContain('private.example.test')
      expect(html).not.toMatch(/<form\b|data-host-services|data-sm-reboot|data-whm-php-workspace/)
    })
  }

  it('distinguishes an unread service snapshot from a checked stopped service', () => {
    const unread = renderV2WhmServices(root)
    expect(unread).toContain('Service state has not been read.')
    const html = renderV2WhmServices({ ...root, services: [{ name: 'dovecot', unit: 'dovecot.service', role: 'IMAP', version: '2.4', active: false, enabled: true, rssMb: 0 }] })
    expect(html).toContain('data-service-row="dovecot"')
    expect(html).toContain('Stopped')
    expect(html).toContain('0 MB')
    expect(html).not.toContain('14:04')
  })

  it('does not reinterpret unprobed service flags as observed failures or memory', () => {
    const html = renderV2WhmServices({ ...root, services: [{ name: 'redis', unit: 'redis.service', role: 'Cache', version: '', active: false, enabled: false, rssMb: 900, checked: false }] })
    expect(html).not.toContain('900 MB')
    expect(html).not.toContain('>Stopped<')
  })

  it('fences service action admission independently of a server row', () => {
    const html = renderV2WhmServices({ ...root, catalog: [], services: [] })
    expect(html).toContain('data-capability-unavailable="true"')
    expect(html).toContain('data-operation-state="unavailable"')
  })

  it('retains all service manager controls with no synthetic readback or reboot', () => {
    const html = renderV2WhmServiceManager(root)
    for (const hook of ['data-sm-status', 'data-sm-result', 'data-sm-refresh', 'data-sm-rows', 'data-sm-search', 'data-sm-filter', 'data-sm-confirm', 'data-sm-reboot', 'data-sm-job', 'data-sm-job-link']) expect(html).toContain(hook)
    expect(html).toContain('maxlength="13" data-sm-confirm disabled')
    expect(html).toContain('data-sm-can-manage="true"')
    expect(html).not.toContain('reboot completed')
  })

  it('reads firewall rows only under the explicitly qualified capability', () => {
    const rule = { id: 'private-rule-id', kind: 'port' as const, action: 'accept' as const, protocol: 'tcp' as const, port: '8443', source: null, forwardTo: null, list: null, comment: 'Read <this>', enabled: true }
    const html = renderV2WhmFirewall({ ...root, firewallRules: [rule], adminSessionIp: '192.0.2.3' })
    expect(html).toContain('8443')
    expect(html).toContain('Read &lt;this&gt;')
    expect(html).not.toContain('private-rule-id')
    expect(html).toContain('data-firewall-port-rule-form')
    expect(html).not.toContain('Enforced ·')
    const unavailable = renderV2WhmFirewall({ ...root, catalog: [], firewallRules: [rule], adminSessionIp: '192.0.2.3' })
    expect(unavailable).not.toContain('8443')
    expect(unavailable).not.toContain('192.0.2.3')
    expect(unavailable).not.toContain('data-firewall-port-rule-form')
    expect(unavailable).toContain('data-firewall-port-rule-unavailable')
  })

  it('preserves all rule categories and connected exchange field hooks', () => {
    const html = renderV2WhmFirewall(root)
    for (const kind of ['port', 'ip', 'forward', 'banned', 'icmp', 'prefix-list']) expect(html).toContain(`data-whm-firewall-panel="${kind}"`)
    for (const name of ['firewall-import-file', 'firewall-import-json', 'firewall-prefix-name', 'firewall-prefix-file', 'firewall-prefix-ports', 'firewall-prefix-action', 'firewall-unban-address']) expect(html).toContain(`name="${name}"`)
    expect(html).not.toContain('generation 143')
  })

  it('keeps PHP runtime evidence unread while exposing the neutral controller hooks', () => {
    const html = renderV2WhmPhp(root)
    for (const hook of ['data-whm-php-workspace', 'data-whm-php-status', 'data-whm-php-source', 'data-whm-php-observed-at', 'data-whm-php-refresh', 'data-whm-php-usage', 'data-whm-php-binary-status']) expect(html).toContain(hook)
    for (const name of ['php-selected-version', 'php-extension-version', 'php-version', 'php-install-request', 'memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_vars', 'php-exception-account', 'php-exception-reason']) expect(html).toContain(`name="${name}"`)
    expect(html).toContain('data-whm-detail-section="php-versions"')
    expect(html).toContain('data-whm-detail-section="php-extensions"')
    expect(html).toContain('data-whm-detail-section="php-functions"')
    expect(html).not.toContain('/usr/bin/php8.3')
    expect(html).not.toContain('Until 2027-12-31')
  })

  it('builds the defaults card from saved facts and states the unsourced pool settings as not read, without controls', () => {
    const saved = renderV2WhmPhp({ ...root, serverSettings: { defaultPhpVersion: '8.4' } as HostPageProps['serverSettings'], domains: [{ php: { handler: 'cgi' } }, { php: { handler: 'fpm' } }] as unknown as HostPageProps['domains'] })
    expect(saved).toContain('data-php-default-saved="saved"'); expect(saved).toContain('1 of 2 saved domains use CGI.')
    const unread = renderV2WhmPhp(root)
    expect(unread).toContain('data-php-default-saved="unread"')
    const pool = unread.slice(unread.indexOf('id="v2-host-php-pool-heading"'), unread.indexOf('v2-php-configure-heading'))
    expect(pool).not.toMatch(/<input|<button|<select/)
    expect(pool).toContain('<dt>Process manager</dt><dd>Not read</dd>')
    expect(pool.match(/<dt>pm\.[a-z_]+<\/dt><dd>Not read<\/dd>/g)).toHaveLength(6)
    expect(pool.match(/class="v2-php-mode"/g)).toHaveLength(3)
  })

  it('retains qualified capability-unavailable layouts without leaking observations', () => {
    const html = renderV2WhmPhp({ ...root, capabilityUnavailable: true, hostname: 'hidden.example.test', serverSettings: { defaultPhpVersion: '8.4' } as HostPageProps['serverSettings'] })
    expect(html).toContain('data-capability-state="unavailable"')
    expect(html).toContain('data-php-can-read="false"')
    expect(html).not.toContain('hidden.example.test')
    expect(html).not.toContain('>8.4<')
  })

  it('lays the firewall out as the board: guard notice, switch beside the ruleset, counted tabs and a review state', () => {
    const rule = { id: 'r1', kind: 'port' as const, action: 'accept' as const, protocol: 'tcp' as const, port: '8443', source: null, forwardTo: null, list: null, comment: '', enabled: true }
    const html = renderV2WhmFirewall({ ...root, firewallRules: [rule] })
    expect(html).toMatch(/class="v2-notice v2-notice--info"[^>]*>[\s\S]*trusted session address/)
    expect(html).toContain('<div class="v2-host__power" data-whm-firewall-policy')
    expect(html).toMatch(/data-whm-firewall-tab="port" disabled>Ports<span class="v2-count v2-num">1<\/span>/)
    expect(html).toMatch(/data-whm-firewall-tab="banned" disabled>Temporary blocks<\/button>/)
    expect(html).toContain('href="#v2-host-firewall-create-heading"')
    expect(html).toContain('id="v2-host-firewall-create-heading"')
    // Without a qualified read no count is shown on any tab and the review stays unread.
    const unread = renderV2WhmFirewall({ ...root, catalog: [], firewallRules: [rule] })
    expect(unread).not.toContain('v2-count')
    expect(unread).toMatch(/Review pending changes<\/h2><\/div><div class="v2-card__actions"><span class="v2-pill[^"]*"[^>]*>(?:<[^>]+>)*Not read/)
  })

  it('fills the ruleset tiles from supplied props only and leaves enforcement unread', () => {
    const rule = { id: 'r1', kind: 'port' as const, action: 'accept' as const, protocol: 'tcp' as const, port: '8443', source: null, forwardTo: null, list: null, comment: '', enabled: true }
    const html = renderV2WhmFirewall({ ...root, firewallRules: [rule], generationId: 7, generationActivatedAt: '2026-10-22T11:45:00Z', adminSessionIp: '192.0.2.3', serverSettings: { panelPort: 2087, sshPort: 2222, backendPort: 8080 } as HostPageProps['serverSettings'] })
    const tile = (label: string): string => html.match(new RegExp(`<div class="v2-host__tile"><dt>${label}</dt>(.*?)</div>`))![1]!
    expect(tile('Generation')).toContain('Applied at <bdi class="v2-num" dir="ltr">2026-10-22 11:45 UTC</bdi>')
    expect(tile('Management ports')).toMatch(/2087<\/bdi> xWHM.*2222<\/bdi> SSH/)
    expect(tile('Saved rules')).toContain('>1</bdi>')
    for (const label of ['Enforcement', 'Input policy', 'Temporary blocks']) expect(tile(label)).toBe('<dd class="v2-num">Not read</dd>')
    const bare = renderV2WhmFirewall(root)
    expect(bare).not.toContain('v2-host__tile-note')
    expect(bare.match(/<div class="v2-host__tile"><dt>Management ports<\/dt>(.*?)<\/div>/)![1]).toBe('<dd class="v2-num">Not read</dd>')
  })

  it('names every rule value for phone rows, in saved rows and in the rows the controller clones', () => {
    const rule = { id: 'r1', kind: 'port' as const, action: 'accept' as const, protocol: 'tcp' as const, port: '8443', source: null, forwardTo: null, list: null, comment: '', enabled: true }
    const html = renderV2WhmFirewall({ ...root, firewallRules: [rule] })
    expect(html).toContain('<td><span data-phone-label="Port"><bdi class="v2-mono" dir="ltr">8443</bdi></span></td>')
    const row = html.match(/<template data-xp-template="firewall-port-row"><tr data-list-row>(.*?)<\/tr>/)![1]!
    expect(row.match(/<td/g)).toHaveLength(9)
    for (const label of ['Position', 'Action', 'Protocol', 'Port', 'Source', 'Purpose', 'Origin', 'Note']) expect(row).toContain(`data-phone-label="${label}"`)
    expect(row).toContain('<td data-phone-label="Purpose" data-xp-slot="purpose"></td><td data-phone-label="Origin" data-xp-slot="origin"></td>')
    expect(HOST_PAGES_CSS).toMatch(/@media\(max-width:600px\)\{[^@]*\[data-phone-label\]\)::before\{content:attr\(data-phone-label\)/)
    // A tab count is hidden once the controller has painted rows, so a count never outlives the rows it described.
    expect(HOST_PAGES_CSS).toContain('[data-whm-firewall-tabs]:has(tbody [data-xp-slot]) [data-whm-firewall-tab] .v2-count{display:none}')
  })
})
