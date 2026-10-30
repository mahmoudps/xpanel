import { describe, expect, it } from 'vitest'
import type { Account, Certificate, Domain, ServiceUser } from '@xpanel/core'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { matchesHook, parseMarkup, type HookSelector } from '../../../../markup.ts'
import { V2_SECURITY_SLOT } from '../../../surfaces/slots.ts'
import { renderV2PanelSettingsPage, V2_PANEL_SETTINGS_ROUTES } from './remaining.ts'
import { settingsContext, type PanelSettingsAuthority } from './common.ts'

const account: Account = { id: '10000000-0000-4000-8000-000000000001', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test', planId: 'plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
const domain: Domain = { id: '20000000-0000-4000-8000-000000000001', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 0, processIdleTimeoutSec: 10 }, ini: { memory_limit: '128M', max_input_vars: '2000', display_errors: 'Off', 'date.timezone': 'UTC' } }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }
const user: ServiceUser = { id: '30000000-0000-4000-8000-000000000001', accountId: account.id, login: 'docs@alice.example.test', services: { email: true, ftp: false, webdisk: true }, mailboxQuotaMb: 128, ftpDir: 'documents' }
const certificate: Certificate = { id: '40000000-0000-4000-8000-000000000001', accountId: account.id, names: [domain.name], source: 'acme', challenge: 'http-01', notAfter: '2027-01-01T00:00:00Z', autoRenew: true }
const allowed: PanelSettingsAuthority = { canRead: true, canManage: true, relatedRoutes: new Set(V2_PANEL_SETTINGS_ROUTES) }
const readonly: PanelSettingsAuthority = { canRead: true, canManage: false }
const props = (activeRoute: string, extra: Partial<PanelSurfaceProps> = {}): PanelSurfaceProps => ({ activeRoute, locale: 'en', account, domains: [domain], serviceUsers: [user], certificates: [certificate], ...extra })
const render = (route: string, authority: PanelSettingsAuthority = allowed, extra: Partial<PanelSurfaceProps> = {}): string => renderV2PanelSettingsPage(props(route, extra), authority)!
const nodes = (html: string, selector: HookSelector) => parseMarkup(html).filter(node => matchesHook(node, selector))
const liveControls = (html: string) => parseMarkup(html).filter(node => node.template < 0 && ['input', 'textarea', 'select', 'button'].includes(node.tag))

describe('v2 remaining account workspaces', () => {
  it('dispatches the exact 31 owned documents without absorbing other families or an absent route', () => {
    expect(V2_PANEL_SETTINGS_ROUTES.length).toBe(31)
    expect(new Set(V2_PANEL_SETTINGS_ROUTES).size).toBe(31)
    for (const route of V2_PANEL_SETTINGS_ROUTES) expect(render(route), route).toContain(`data-v2-settings-route="${route}"`)
    for (const activeRoute of ['/home', '/domains', '/security/ssl', '/software/apps', '/advanced/terminal', '/email/accounts', '/whm/security', '/software/store/unknown']) expect(renderV2PanelSettingsPage(props(activeRoute), allowed)).toBeUndefined()
    expect(renderV2PanelSettingsPage({ account }, allowed)).toBeUndefined()
  })

  it.each(V2_PANEL_SETTINGS_ROUTES)('does not expose supplied account or foreign collections without read authority: %s', route => {
    const html = render(route, { canRead: false, canManage: true })
    expect(html).not.toContain(account.id)
    expect(html).not.toContain(account.username)
    expect(html).not.toContain(account.primaryDomain)
    expect(html).not.toContain(user.login)
    expect(html).not.toContain(certificate.id)
    expect(html).not.toContain(certificate.notAfter)
    const outline = parseMarkup(html)
    const workspace = outline.find(node => node.attrs.get('data-v2-settings-route') === route)
    expect(workspace?.attrs.get('data-readonly')).toBe('true')
    for (const node of outline.filter(node => node.template < 0)) {
      for (const [key, value] of node.attrs) {
        if (/^data-.*(?:can-read|can-manage|manage|enabled)$/.test(key)) expect(value, key).not.toBe('true')
        if (key === 'data-contact-account' || key === 'data-htaccess-account' || key === 'data-wd-account') expect(value).toBe('')
      }
    }
    const controls = liveControls(html)
    for (const control of controls.filter(node => node.tag === 'button' && node.attrs.get('type') === 'submit')) expect(control.attrs.has('disabled')).toBe(true)
    if (html.includes('An authorized account has not been read.')) {
      expect(controls).toHaveLength(0)
    } else {
      expect(outline.some(node => node.attrs.get('class')?.split(' ').includes('v2-card'))).toBe(true)
      expect(html).toMatch(/Not read|not been read|unavailable|Unavailable/)
    }
  })

  it('does not turn populated props into management authority or enable suspended account writes', () => {
    const expected: readonly (readonly [string, HookSelector, string])[] = [
      ['/security/ssh', '[data-ssh-manage]', 'data-ssh-manage'], ['/security/virus-scanner', '[data-vscan-manage]', 'data-vscan-manage'], ['/security/waf', '[data-sec-can-manage]', 'data-sec-can-manage'], ['/preferences/team', '[data-team-can-manage]', 'data-team-can-manage'], ['/preferences', '[data-contact-manage]', 'data-contact-manage'],
    ]
    for (const [route, selector, attribute] of expected) {
      expect(nodes(render(route, readonly), selector)[0]!.attrs.get(attribute)).toBe('false')
      expect(nodes(render(route, allowed, { account: { ...account, status: 'suspended' } }), selector)[0]!.attrs.get(attribute)).toBe('false')
    }
    const php = render('/software/php', readonly)
    expect(nodes(php, '[data-domain-php-form]')[0]!.attrs.get('data-readonly')).toBe('true')
    expect(liveControls(php).every(node => node.attrs.has('disabled'))).toBe(true)
  })

  it('preserves one explicit security slot and locks session management in a read-only account view', () => {
    const html = render('/security/account', readonly)
    expect(html.split(V2_SECURITY_SLOT).length).toBe(2)
    expect(nodes(html, '[data-account-sessions]')[0]!.attrs.get('data-readonly')).toBe('true')
    expect(nodes(html, '[data-sessions-revoke-others]')[0]!.attrs.has('disabled')).toBe(true)
    expect(html).not.toContain('data-auth-setup-form')
    expect(html).toContain('No token was issued by this workspace.')
    expect(html).not.toContain('data-action="create-token"')
  })

  it('retains the six linked security check cards without inventing healthy status counts', () => {
    const html = render('/security/account')
    const checks = nodes(html, '[data-v2-security-check]')
    expect(checks).toHaveLength(6)
    expect(checks.every(node => node.tag === 'a' && node.attrs.get('href')?.startsWith('#'))).toBe(true)
    expect(html).toContain('Site protection')
    expect(html).toContain('href="#v2-account-password"')
    expect(html).toContain('href="#account-security-heading"')
    expect(html).not.toContain('in order')
  })

  it('keeps ACME names account-owned and disables unsupported sources without dropping the wizard', () => {
    const html = render('/security/ssl/issue', allowed, { domains: [domain, { ...domain, id: 'foreign-domain', accountId: 'foreign', name: 'foreign.example.test' }] })
    expect(html).not.toContain('foreign.example.test')
    expect(nodes(html, '[data-certificate-form]')[0]!.tag).toBe('form')
    expect(nodes(html, '[name="domain"]')[0]!.tag).toBe('select')
    expect(html).toContain('HTTP-01')
    expect(html).toContain('DNS-01')
    expect(html).toContain('No certificate request has run.')
    const uploaded = parseMarkup(html).find(node => node.template < 0 && node.tag === 'input' && node.attrs.get('name') === 'v2-certificate-source' && node.attrs.get('value') === 'upload')
    expect(uploaded).toBeDefined()
    expect(uploaded!.attrs.has('disabled')).toBe(true)
    expect(html).not.toContain('Certificate issued')
  })

  it('shows certificate names while hiding stored keys and foreign certificate metadata', () => {
    const html = render('/security/ssl/files', allowed, { certificates: [certificate, { ...certificate, id: 'foreign-cert', accountId: 'foreign', names: ['foreign.example.test'] }] })
    expect(html).toContain(domain.name)
    expect(html).not.toContain('foreign.example.test')
    expect(html).not.toContain(`>${certificate.id}<`)
    expect(html).toContain('Private key is never displayed.')
    expect(html).not.toContain('BEGIN PRIVATE KEY')
    expect(liveControls(html).every(node => node.attrs.has('disabled'))).toBe(true)
  })

  it('keeps real SSH key restrictions and scanner limits beside unread, nonzero-assuming observations', () => {
    const ssh = render('/security/ssh')
    expect(nodes(ssh, '[data-ssh-key]')[0]!.attrs.get('maxlength')).toBe('8192')
    expect(nodes(ssh, '[data-ssh-rows]')[0]!.tag).toBe('tbody')
    const virus = render('/security/virus-scanner')
    for (const hook of ['[data-vscan-engine]', '[data-vscan-version]', '[data-vscan-signatures]', '[data-vscan-signature-date]', '[data-vscan-next]', '[data-vscan-status]', '[data-vscan-rows]'] as const) expect(nodes(virus, hook).length).toBe(1)
    expect(virus).toContain('15 minutes')
    expect(virus).toContain('400 MB')
    expect(virus).toContain('Quarantine and automatic deletion are not available')
    expect(virus).not.toContain('48,213')
  })

  it.each(['/advanced/error-pages', '/advanced/indexes', '/advanced/mime-types', '/security/ip-blocker', '/security/hotlink'])('retains revision-dependent draft controls disabled until an authorized fresh read: %s', route => {
    const html = render(route)
    expect(nodes(html, '[data-web-directives]')[0]!.attrs.get('data-wd-account')).toBe(account.id)
    expect(nodes(html, '[data-wd-domain]')[0]!.attrs.has('disabled')).toBe(true)
    expect(nodes(html, '[data-wd-save]')[0]!.attrs.has('disabled')).toBe(true)
    expect(nodes(html, '[data-wd-issues]')[0]!.tag).toBe('ul')
    expect(html).toContain('other lines stay byte-for-byte')
    expect(html).not.toContain('Test passed')
  })

  it('does not activate an executable handler editor', () => {
    const html = render('/advanced/handlers')
    expect(html).toContain('data-web-directives-unavailable="handlers"')
    expect(html).not.toContain('data-web-directives="handlers"')
    expect(html).not.toContain('data-wd-save')
    expect(liveControls(html).every(node => node.attrs.has('disabled'))).toBe(true)
  })

  it('keeps network diagnostics finite and the API explorer read-only with fixed operation discovery', () => {
    const network = render('/advanced/network-tools')
    expect(nodes(network, '[data-nettools-host]')[0]!.attrs.get('maxlength')).toBe('253')
    expect(nodes(network, '[data-nettools-port]')[0]!.attrs.get('max')).toBe('65535')
    expect(network).toContain('Only public internet addresses are tested')
    const api = render('/advanced/api-shell')
    expect(nodes(api, '[data-dev-operation]')[0]!.attrs.has('disabled')).toBe(true)
    expect(nodes(api, '[data-dev-run]')[0]!.attrs.has('disabled')).toBe(true)
    expect(nodes(api, '[data-dev-token-rows]')[0]!.tag).toBe('tbody')
    expect(api).toContain('No server setting is changed.')
    expect(api).not.toContain('name="method"')
    expect(api).not.toContain('name="route"')
  })

  it('keeps stored PHP settings separate from unobserved runtime and does not submit unsupported INI edits', () => {
    const html = render('/software/php')
    expect(nodes(html, '[data-domain-php-form]')[0]!.attrs.get('data-domain-id')).toBe(domain.id)
    expect(nodes(html, '[name="fpm.maxChildren"]')[0]!.attrs.get('value')).toBe('4')
    expect(nodes(html, '[name="ini.memory_limit"]')[0]!.attrs.get('value')).toBe('128M')
    expect(nodes(html, '[name="ini.max_input_vars"]').length).toBe(0)
    expect(html).toContain('value="2000"')
    expect(html).toContain('does not claim that a pool is running')
    expect(html).not.toContain('In sync')
    expect(html).not.toContain('/run/xpanel/php/')
  })

  it('retains the unavailable file editor’s diagnostics, migration preview and recovery history without enabling operations', () => {
    const html = render('/software/htaccess')
    for (const hook of ['[data-htaccess-gutter]', '[data-htaccess-editor]', '[data-htaccess-php-before]', '[data-htaccess-php-after]', '[data-htaccess-issues]', '[data-htaccess-versions]', '[data-htaccess-undo-migration]'] as const) expect(nodes(html, hook).length).toBe(1)
    expect(nodes(html, '[data-htaccess-workspace]')[0]!.attrs.get('data-htaccess-manage')).toBe('false')
    expect(nodes(html, '[data-htaccess-editor]')[0]!.attrs.has('readonly')).toBe(true)
    expect(nodes(html, '[data-htaccess-save]')[0]!.attrs.has('disabled')).toBe(true)
    expect(html).toContain('The actual file has not been read.')
  })

  it('keeps the separate configuration-test output and four-column diff cards in the unavailable file editor', () => {
    const html = render('/software/htaccess')
    expect(html).toContain('Test before the switch')
    expect(html).toContain('Changes against the live version')
    expect(nodes(html, '[data-htaccess-test-output]')[0]!.tag).toBe('pre')
    expect(nodes(html, '[data-htaccess-validate]')).toHaveLength(1)
    expect(nodes(html, '[data-htaccess-copy-test]')[0]!.attrs.has('disabled')).toBe(true)
    expect(nodes(html, '[data-htaccess-diff-rows]')[0]!.tag).toBe('tbody')
    expect(html).toContain('Live line</th>')
    expect(html).toContain('Draft line</th>')
    expect(nodes(html, '[data-htaccess-diff-clean]')[0]!.attrs.has('hidden')).toBe(true)
    expect(html).toContain('The live file and draft have not been compared.')
    expect(html).not.toContain('Syntax OK')
  })

  it('keeps account contact reads and mutations bound to their own saved baseline controls', () => {
    const html = render('/preferences')
    expect(nodes(html, '[data-contact-account]')[0]!.attrs.get('data-contact-account')).toBe(account.id)
    expect(nodes(html, '[name="contactEmail"]')[0]!.attrs.get('type')).toBe('text')
    expect(nodes(html, '[name="contactEmail"]')[0]!.attrs.has('disabled')).toBe(true)
    expect(nodes(html, '[data-contact-save]')[0]!.attrs.has('disabled')).toBe(true)
    expect(html).toContain('Saved contact details have not been read.')
    expect(html).not.toContain(account.contactEmail)
  })

  it('retains team role, one-time password-link and expiry controls without showing a generated credential', () => {
    const html = render('/preferences/team')
    expect(nodes(html, '[data-acct-team-role]').map(node => node.attrs.get('value'))).toEqual(['administrator', 'database', 'email', 'web'])
    expect(nodes(html, '[data-acct-team-input="expiresAt"]')[0]!.attrs.get('type')).toBe('datetime-local')
    expect(nodes(html, '[data-acct-team-link]')[0]!.attrs.has('hidden')).toBe(true)
    expect(nodes(html, '[data-acct-team-link-url]')[0]!.attrs.get('value')).toBeUndefined()
    expect(html).toContain('Up to 7 members can hold a role.')
    expect(html).not.toContain('https://')
  })

  it('filters service users and Web Disk directories by the owned account and distinguishes unread from empty', () => {
    const foreign = { ...user, accountId: 'foreign', login: 'foreign@example.test', ftpDir: 'foreign-directory' }
    for (const route of ['/preferences/users', '/files/web-disk']) {
      const html = render(route, allowed, { serviceUsers: [user, foreign] })
      expect(html).toContain(user.login)
      expect(html).not.toContain(foreign.login)
      expect(html).not.toContain(foreign.ftpDir)
      expect(html).not.toContain(`>${user.id}<`)
    }
    expect(render('/files/web-disk', allowed, { serviceUsers: undefined })).toContain('Web Disk logins have not been read.')
    expect(render('/files/web-disk', allowed, { serviceUsers: [] })).toContain('No Web Disk logins were returned.')
  })

  it('does not admit another domain’s saved custom configuration in the combined read-only site editor', () => {
    const html = render('/domains/site-settings', allowed, { customConfig: { domainId: 'foreign', accountId: account.id, domainName: 'foreign.example.test', nginxInclude: '', apacheInclude: '', userIni: {}, customHeaders: { 'X-Foreign': 'do-not-show' }, cacheBypassPaths: [], updatedAt: '2026-10-29T00:00:00Z', updatedBy: 'user' } })
    expect(html).not.toContain('X-Foreign')
    expect(html).not.toContain('do-not-show')
    expect(html).toContain('Stop, expiry and path quota')
    expect(html).toContain('Template and headers')
    expect(liveControls(html).every(node => node.attrs.has('disabled'))).toBe(true)
  })

  it('retains site protection, PHP, rewrite, upstream request headers and review groups while operations stay locked', () => {
    const html = render('/domains/site-settings', allowed, { domains: [{ ...domain, proxy: { websocket: true, hostHeader: 'client', headers: [{ name: 'X-Upstream-Test', value: 'request-value' }] } }] })
    for (const id of ['v2-site-php', 'v2-site-rewrite', 'v2-site-privacy', 'v2-site-ip-blocker', 'v2-site-hotlink', 'v2-site-review', 'v2-site-upstream-headers']) expect(html).toContain(`id="${id}"`)
    expect(html).toContain('Headers to the upstream')
    expect(html).toContain('X-Upstream-Test')
    expect(html).toContain('request-value')
    expect(nodes(html, '#v2-site-proxy-ttl')[0]!.attrs.get('type')).toBe('number')
    expect(nodes(html, '#v2-site-review-ack')[0]!.attrs.has('disabled')).toBe(true)
    expect(html).toContain('Configuration tests and local site checks have not run.')
    expect(liveControls(html).every(node => node.attrs.has('disabled'))).toBe(true)
  })

  it.each(['/software/installer', '/software/store', '/software/store/app', '/software/store/install', '/software/store/progress', '/software/store/installed', '/software/store/updates', '/software/store/error'])('preserves an honest signed-catalog and installer state on its distinct route: %s', route => {
    const html = render(route)
    expect(html).toContain('data-installer-state="unavailable"')
    expect(html).toContain('job state has not been read.')
    expect(liveControls(html).every(node => node.attrs.has('disabled'))).toBe(true)
    expect(html).not.toContain('Installation succeeded')
    expect(html).not.toContain('data-install-job-id')
  })

  it('escapes supplied values, keeps technical isolation and preserves Arabic document direction with ASCII digits', () => {
    const html = render('/preferences/language', allowed, { locale: 'ar', account: { ...account, username: '<img src=x onerror=alert(1)>', primaryDomain: '" onmouseover="bad' } })
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('<bdi dir="ltr" class="v2-mono">0-9</bdi>')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})


describe('stored settings facts do not grant provider access', () => {
  it('rejects stale live flags and ungranted account facts in read-only presentation', () => {
    const context = settingsContext(props('/preferences'), { presentation: 'read-only', canReadFacts: true, authorizedTools: new Set(), canRead: true, canManage: true })
    expect(context.readable).toBe(false)
    expect(context.editable).toBe(false)
    expect(context.account).toBeUndefined()
    expect(context.domains).toBeUndefined()
  })
  it('preserves the unknown account cards without native controller admission', () => {
    const authority: PanelSettingsAuthority = { presentation: 'read-only', canReadFacts: false, authorizedTools: new Set(), canRead: true, canManage: true }
    for (const route of ['/preferences', '/security/ssh', '/software/php', '/software/htaccess', '/advanced/network-tools']) {
      const html = render(route, authority, { account: undefined })
      expect(html).toContain('data-readonly="true"')
      expect(html).toContain('v2-card')
      expect(html).not.toContain('data-account="' + account.id + '"')
      expect(html).not.toContain('data-sec-can-read="true"')
      expect(html).not.toContain('data-sec-can-manage="true"')
    }
  })
})
