// @vitest-environment jsdom
import { qualifyHostTools, tools } from '@xpanel/catalog'
import { SYNTHETIC_WEBSITE_ANALYTICS, SYNTHETIC_WHM_IO_SNAPSHOT } from '../../../tests/fixtures/analytics-snapshots.ts'
import { LOGIN_CLIENT_SCRIPT } from './login-client.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import { planEditorRequest } from './plan-editor.ts'
import {
  BROWSER_REALTIME_SCRIPT,
  createLiveEventStore,
  localeDirection,
  getThresholdLevel,
  renderLoginSurface,
  renderMailSurface,
  renderPanelSurface,
  renderReconcileBanner,
  renderServerIoMonitorChart,
  renderStatusBadge,
  renderThresholdMeter,
  renderWebApp,
  renderWebsiteAnalyticsChart,
  renderWhmSurface,
  serveWebUi,
  translator,
  type PanelSurfaceProps,
  type WhmSurfaceProps,
  type MailSurfaceProps,
} from './index.ts'

// Explicit synthetic renderer observations. None are production defaults or live-host proof.
const fixtureAt = '2026-10-22T14:05:00Z'
const fixturePlan = { ...defaultPlan({ id: 'fixture-plan', name: 'Synthetic plan', featureListId: 'fixture-features' }), shell: 'jailed' as const }
const fixtureFeatureList = { id: fixturePlan.featureListId, name: 'Synthetic tools' }
const fixtureAccount: Account = {
  id: 'fixture-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice-shop.com',
  planId: fixturePlan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@alice-shop.com',
  ipv4: '10.0.0.21', ipv6: '2001:db8::12', shell: 'jailed', createdAt: fixtureAt,
}
const panelFixture: PanelSurfaceProps = {
  account: fixtureAccount, plan: fixturePlan,
  domains: [{ id: 'fixture-domain', accountId: fixtureAccount.id, name: fixtureAccount.primaryDomain, kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ipv4: fixtureAccount.ipv4, ipv6: fixtureAccount.ipv6 }],
  customConfig: { domainId: '11111111-1111-4111-8111-111111111111', accountId: fixtureAccount.id, domainName: fixtureAccount.primaryDomain, nginxInclude: '# synthetic include', apacheInclude: '# synthetic include', userIni: { memory_limit: '256M' }, customHeaders: {}, cacheBypassPaths: [], updatedAt: fixtureAt, updatedBy: 'user' },
  websiteAnalytics: SYNTHETIC_WEBSITE_ANALYTICS,
  files: [{ name: 'fixture.txt', path: '/home/alice/public_html/fixture.txt', kind: 'file', sizeBytes: 128, modeOctal: '0640', modifiedAt: fixtureAt }, { name: 'trashed-fixture.txt', path: '/home/alice/.trash/trashed-fixture.txt', kind: 'file', sizeBytes: 64, modeOctal: '0640', modifiedAt: fixtureAt, trashed: true }],
  databases: [{ id: 'fixture-db', accountId: fixtureAccount.id, engine: 'mariadb', name: 'alice_fixture', trashedAt: null }],
  serviceUsers: [{ id: 'fixture-user', accountId: fixtureAccount.id, login: 'info@alice-shop.com', services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 1024, ftpDir: 'public_html' }],
  dnsRecords: [{ id: 'fixture-dns', zone: fixtureAccount.primaryDomain, name: '@', type: 'A', ttl: 3600, content: fixtureAccount.ipv4, priority: null }],
}
const whmFixture: WhmSurfaceProps = {
  catalog: qualifyHostTools(tools, { executor: 'linux', probes: { 'control-plane': 'passed' } }),
  principal: { kind: 'root', id: 'fixture-root', username: 'synthetic-root' }, hostname: 'srv1.xpanel.test', adminSessionIp: '203.0.113.7',
  accounts: [fixtureAccount, { ...fixtureAccount, id: 'fixture-other', username: 'omar', uid: 20016, gid: 20016 }], plans: [fixturePlan],
  featureLists: [fixtureFeatureList],
  services: ['nginx', 'apache', 'php-fpm', 'mariadb', 'dovecot', 'postfix', 'pdns', 'nftables'].map(name => ({ name, unit: `${name}.service`, version: 'fixture', active: true, enabled: true, rssMb: 24, role: 'Synthetic observation' })),
  resellers: [{ id: 'fixture-reseller', username: 'fixture-reseller', acl: ['list-accounts'], maxAccounts: 5, totalDiskMb: 10240, totalBandwidthMb: 102400, oversell: false, nameservers: [], delegatedIps: [] }],
  ipPool: [{ id: 'fixture-ip', address: '10.0.0.12', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: 'Synthetic address' }],
  mailIpConfig: { mode: 'custom-map', defaultIpv4: fixtureAccount.ipv4, defaultIpv6: fixtureAccount.ipv6 ?? null, defaultHelo: 'mail.alice-shop.com', domainOverrides: [{ domainName: fixtureAccount.primaryDomain, ipv4: fixtureAccount.ipv4, ipv6: null, heloHostname: 'mail.alice-shop.com' }] },
  generations: [{ generationId: 142, at: fixtureAt, actor: 'synthetic-root', summary: 'Synthetic generation', stateChecksum: '9f86d081884c', filesCount: 38, durationMs: 184, status: 'superseded' }],
  auditEntries: [{ id: 'fixture-audit', at: fixtureAt, actor: 'synthetic-root', action: 'service_user.deleted', target: 'Synthetic target', detail: {}, outcome: 'ok' }],
}
const mailFixture: MailSurfaceProps = {
  mailbox: 'info@alice-shop.com', quotaUsedMb: 42, quotaLimitMb: 1024,
  messages: [{ uid: 1, folder: 'INBOX', from: 'sender@example.test', to: 'info@alice-shop.com', subject: 'Synthetic message', preview: 'Synthetic preview', body: 'Synthetic body', receivedAt: fixtureAt, sizeKb: 1, unread: true, dkimPass: true, spfPass: true, dmarcPass: true }],
  sieveRules: [{ id: 'fixture-sieve', name: 'Synthetic filter', condition: 'subject contains fixture', action: 'fileinto Archive', enabled: true }],
}
const whmAt = (activeRoute: string, props: WhmSurfaceProps = {}): string => renderWhmSurface({ ...whmFixture, ...props, activeRoute })
const panelAt = (activeRoute: string, props: PanelSurfaceProps = {}): string => renderPanelSurface({ ...panelFixture, ...props, activeRoute })
const mailAt = (activeRoute: string, props: MailSurfaceProps = {}): string => renderMailSurface({ ...mailFixture, ...props, activeRoute })
const documentFor = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')

/**
 * Verifies that every `.xp-badge` element in a rendered HTML document contains both an inline
 * `<svg` icon and a non-empty `<span class="xp-badge__label">` text label (WCAG 2.2 AA 1.4.1).
 */
const assertAllBadgesHaveSvgAndLabel = (html: string): void => {
  const badgePattern = /<span class="xp-badge\b[^>]*>([\s\S]*?)<\/span><\/span>/g
  const matches = [...html.matchAll(badgePattern)]
  assert.ok(matches.length > 0, 'Expected at least one .xp-badge in rendered HTML')
  for (const match of matches) {
    const fullBadge = match[0]
    assert.match(fullBadge, /<svg\b[^>]*class="xp-status-icon[^"]*"[\s\S]*?<\/svg>/)
    assert.match(fullBadge, /<span class="xp-badge__label">[^<]+<\/span>/)
  }
}

describe('@xpanel/web — Design Tokens, Threshold Meters, and Bilingual i18n', () => {
  it('enforces the 80% / 95% threshold rule and renders accessible status badges', () => {
    assert.equal(getThresholdLevel(0), 'ok')
    assert.equal(getThresholdLevel(79.9), 'ok')
    assert.equal(getThresholdLevel(80), 'warn')
    assert.equal(getThresholdLevel(94.9), 'warn')
    assert.equal(getThresholdLevel(95), 'critical')
    assert.equal(getThresholdLevel(100), 'critical')

    const options = { unit: 'GiB', label: 'Disk allocation', locale: 'en' as const }
    const okMeter = renderThresholdMeter(64, 100, options)
    assert.match(okMeter, /data-threshold="ok"/)
    assert.match(okMeter, /Within limit/)
    assert.match(okMeter, /\(64%\)/)

    const warnMeter = renderThresholdMeter(85, 100, options)
    assert.match(warnMeter, /data-threshold="warn"/)
    assert.match(warnMeter, /Warning/)

    const critMeter = renderThresholdMeter(97, 100, options)
    assert.match(critMeter, /data-threshold="critical"/)
    assert.match(critMeter, /Critical/)

    const unlimitedMeter = renderThresholdMeter(42, 'unlimited', options)
    assert.doesNotMatch(unlimitedMeter, /data-threshold="ok"|role="meter"/)
    assert.match(unlimitedMeter, /Unlimited/)

    const badge = renderStatusBadge('ok', 'Healthy')
    assertAllBadgesHaveSvgAndLabel(badge)
  })

  it('provides English LTR and Arabic RTL translations', () => {
    assert.equal(localeDirection('en'), 'ltr')
    assert.equal(localeDirection('ar'), 'rtl')
    assert.equal(translator('en')('Applied in generation #{generationId}', { generationId: 142 }), 'Applied in generation #142')
    assert.match(translator('ar')('Applied in generation #{generationId}', { generationId: 142 }), /#142/)
  })
})

describe('@xpanel/web — Login, xWHM, xPanel, and xMail Surfaces (EN/AR + Dark/Light)', () => {
  it('renders login, xwhm, xpanel, and xmail in English (ltr) and Arabic (rtl) across dark and light themes', () => {
    const surfaces = ['login', 'xwhm', 'xpanel', 'xmail'] as const
    const locales = ['en', 'ar'] as const
    const themes = ['dark', 'light'] as const

    for (const surface of surfaces) {
      for (const locale of locales) {
        for (const theme of themes) {
          const html = renderWebApp({ surface, locale, theme })
          const expectedDir = locale === 'ar' ? 'rtl' : 'ltr'
          assert.match(html, /^<!doctype html>/i)
          assert.match(
            html,
            new RegExp(`<html lang="${locale}" dir="${expectedDir}" data-theme="${theme}"[^>]*data-surface="${surface}"[^>]*>`),
          )
          assert.match(html, /id="xpanel-design-tokens"/)
          assert.match(html, /id="xpanel-login-client"/)
          assert.match(html, /\/api\/auth\/login/)
          if (surface === 'login') assert.match(html, /data-login-form/)
          else assert.match(html, /data-tool-availability="unverified"/)
        }
      }
    }
  })

  it('renders the login form, observed lockout, verification fields and safe CLI recovery instructions', () => {
    const html = renderLoginSurface({ locale: 'en', lockout: { locked: true, retryAfterSec: 300 } })
    assert.match(html, /data-login-form/)
    assert.match(html, /data-action="toggle-password"/)
    assert.match(html, /pattern="\[0-9\]\{6\}"/)
    assert.doesNotMatch(html, /passkey-login|TLS 1.3 Enforced|203\.0\.113\.7/)
    assert.match(html, /data-lockout-state="locked"/)
    assert.match(html, /data-admin-note/)
    assert.match(html, /operations runbook/)
    assert.doesNotMatch(html, /reset-password|disable-2fa/)
  })

  it('renders xWHM surface with Server IO Monitor, Plans, Accounts & Slices, Resellers, Multi-IPv4/IPv6 & Mail Outbound IPs, Firewall dead-man switch, and Config Generations', () => {
    const screens = ['/whm/monitoring/io', '/whm/services', '/whm/plans', '/whm/accounts', '/whm/resellers', '/whm/server/ips', '/whm/email/outbound', '/whm/security/firewall', '/whm/panel/data', '/whm/audit', '/whm/transfers'].map(route => whmAt(route))
    const html = screens.join('\n')
    assert.match(html, /data-surface="xwhm"/)
    // Server IO monitor: the metering workspace reads the cached per-account cgroup v2 sample in the browser
    assert.match(html, /data-whm-metering="io" data-metering-can-read="true"/)
    assert.match(html, /data-whm-metering-rows="io"/)
    assert.match(html, /data-whm-metering-rows="devices"/)
    // Managed services health table
    for (const svc of ['nginx', 'apache', 'php-fpm', 'mariadb', 'dovecot', 'postfix', 'pdns', 'nftables']) {
      assert.match(html, new RegExp(`data-service-row="${svc}"`))
    }
    // Plans & cgroup v2 limits + explicit Unlimited
    assert.match(html, /for="plan-cpu-quota">CPU \(%\)<\/label>/)
    assert.match(html, /for="plan-memory-max">Memory \(MiB\)<\/label>/)
    assert.match(html, /for="plan-tasks-max">Processes<\/label>/)
    assert.match(html, /for="plan-ioReadBps">Disk read \(MiB\/s\)<\/label>/)
    assert.match(html, /for="plan-ioWriteBps">Disk write \(MiB\/s\)<\/label>/)
    assert.match(html, /name="unlimited\.addonDomains"[^>]*data-plan-unlimited="addonDomains"/)
    assert.match(html, /for="plan-addonDomains-unlimited"[^>]*>[\s\S]*?<span>Unlimited<\/span>/)
    assert.match(html, /name="featureListId"[^>]*required>[\s\S]*?<option value="fixture-features" selected>Synthetic tools<\/option>/)
    assert.doesNotMatch(html, /name="ioMaxMbps"|data-plan-editor-form=/)
    // Accounts & type-to-confirm terminate guard
    assert.match(html, /data-type-to-confirm="true"/)
    // Resellers & 14-privilege ACL matrix
    assert.match(html, /data-reseller-acl-matrix="true"/)
    // Multi-IPv4/IPv6 Pool & Postfix Mail Outbound IPs
    assert.match(html, /data-ip-pool-table="true"/)
    assert.match(html, /data-mail-ip-config-form="true"/)
    assert.match(html, /for="mail-outbound-mode">Outbound mail routing<\/label>/)
    assert.match(html, /name="defaultIpv4"[^>]*value="10\.0\.0\.21"/)
    assert.match(html, /name="defaultHelo"[^>]*value="mail\.alice-shop\.com"/)
    // Firewall & 60s dead-man's switch
    assert.match(html, /data-firewall-deadman="60s"/)
    assert.match(html, /203\.0\.113\.7/)
    // Config generations rollback + audit log + root lifecycle
    assert.match(html, /data-action="rollback-generation"/)
    assert.match(whmAt('/whm/audit'), /data-audit-id="fixture-audit"/)
    assert.match(whmAt('/whm/audit'), /Deleted service user/)
    assert.match(whmAt('/whm/audit'), /Synthetic target/)
    assert.match(whmAt('/whm/audit'), /2026-10-22 14:05 UTC/)
    assert.doesNotMatch(whmAt('/whm/audit'), /service_user\.deleted/)
    const filtered = whmAt('/whm/audit', {
      auditEntries: [
        { id: '90', at: fixtureAt, actor: 'info@alice-shop.com', action: 'agent.peer_denied', target: '/health', detail: { peerUid: 0 }, outcome: 'denied' },
        { id: '80', at: fixtureAt, actor: 'synthetic-root', action: 'service_user.deleted', target: 'Synthetic target', detail: {}, outcome: 'ok' },
      ],
      auditList: { actor: 'info@alice-shop.com', action: '', target: '', before: '', hasMore: true, oldestId: '80' },
    })
    assert.match(filtered, /data-audit-filters="true"/)
    assert.match(filtered, /info@alice-shop\.com/)
    assert.match(filtered, /Agent refused a request from an unauthorized local user \(uid 0\)/)
    assert.match(filtered, />\/health</)
    assert.equal(filtered.includes('An internal record'), false)
    assert.equal(filtered.includes('mbx'), false)
    assert.match(filtered, /data-audit-older="true"/)
    assert.match(filtered, /before=80/)
    const older = whmAt('/whm/audit', {
      locale: 'ar',
      auditEntries: [
        { id: '90', at: fixtureAt, actor: 'info@alice-shop.com', action: 'agent.peer_denied', target: '/health', detail: { peerUid: 0 }, outcome: 'denied' },
      ],
      auditList: { actor: 'info@alice-shop.com', action: '', target: '', before: '90', hasMore: false, oldestId: '90' },
    })
    assert.match(older, /رفض الوكيل طلباً من مستخدم محلي غير مصرح/)
    assert.match(older, /<bdi dir="ltr">\(uid 0\)<\/bdi>/)
    assert.match(older, /الأحدث/)
    assert.equal(older.includes('سجل داخلي'), false)
    assert.match(html, /data-action="start-transfer"/)
    assert.doesNotMatch(html, /cpmove-ziad\.tar\.gz/)
    assertAllBadgesHaveSvgAndLabel(html)
  })

  it('renders one current native plan editor with real metadata and explicit create/edit/unavailable selection', () => {
    const storedPlan = { ...fixturePlan, id: '10000000-0000-4000-8000-000000000001', featureListId: '20000000-0000-4000-8000-000000000001' }
    const metadata: WhmSurfaceProps = {
      plans: [storedPlan], accounts: [{ ...fixtureAccount, planId: storedPlan.id }],
      featureLists: [{ id: storedPlan.featureListId, name: 'Synthetic tools' }],
    }
    const create = whmAt('/whm/plans', { ...metadata, planEditorState: { kind: 'create' } })
    const edit = whmAt('/whm/plans', { ...metadata, planEditorState: { kind: 'edit', plan: storedPlan } })
    const nativeForm = (html: string): string => {
      assert.equal(documentFor(html).querySelectorAll('form[data-native-plan-editor]').length, 1)
      assert.doesNotMatch(html, /data-plan-editor-form=|name="ioMaxMbps"/)
      return /<form\b[^>]*\bdata-native-plan-editor\b[\s\S]*?<\/form>/.exec(html)![0]
    }
    const createForm = nativeForm(create), editForm = nativeForm(edit)
    assert.match(createForm, /action="\/api\/plans" method="post"/)
    assert.match(createForm, /data-plan-editable="true"/)
    assert.doesNotMatch(createForm, /data-plan-id=/)
    assert.match(editForm, new RegExp(`data-plan-id="${storedPlan.id}"`))
    assert.match(editForm, /name="name"[^>]*value="Synthetic plan"/)
    assert.match(editForm, /name="featureListId"[^>]*required/)
    assert.match(editForm, new RegExp(`<option value="${storedPlan.featureListId}" selected>Synthetic tools<\/option>`))
    for (const key of ['diskMb', 'bandwidthMbMonth', 'ioReadBps', 'ioWriteBps', 'ioReadIops', 'ioWriteIops', 'memoryMb', 'maxProcesses', 'cpuPercent', 'addonDomains', 'aliasDomains', 'subdomains', 'mailboxes', 'forwarders', 'mailingLists', 'ftpAccounts', 'databases', 'phpWorkers', 'defaultMailboxQuotaMb']) {
      assert.match(editForm, new RegExp(`name="${key}"`))
      assert.match(editForm, new RegExp(`name="unlimited\\.${key}"`))
    }
    assert.match(editForm, /name="ioReadBps"[^>]*value="50"/)
    assert.match(editForm, /name="ioWriteBps"[^>]*value="25"/)
    assert.match(editForm, /data-native-plan-save disabled/)
    assert.match(edit, /data-plan-delete-dialog/)
    const { id: _id, ...payload } = storedPlan
    const renderedEditId = /data-plan-id="([^"]+)"/.exec(editForm)![1]!
    const post = planEditorRequest(payload)
    assert.equal(post.method, 'POST')
    assert.equal(post.path, '/api/plans')
    assert.equal(Object.hasOwn(post.body, 'ownerId'), true)
    const patch = planEditorRequest(payload, renderedEditId)
    assert.equal(patch.method, 'PATCH')
    assert.equal(patch.path, '/api/plans/' + storedPlan.id)
    assert.equal(Object.hasOwn(patch.body, 'ownerId'), false)
    assert.match(BROWSER_REALTIME_SCRIPT, /\[data-native-plan-editor\]/)
    assert.doesNotMatch(BROWSER_REALTIME_SCRIPT, /\[data-plan-editor-form\]/)
    const unread = nativeForm(whmAt('/whm/plans', { ...metadata, featureLists: [] }))
    assert.match(unread, /data-plan-editable="false"/)
    assert.match(unread, /feature list is unavailable/)
    assert.doesNotMatch(unread, new RegExp(`>${storedPlan.featureListId}<`))
    for (const planEditorState of [{ kind: 'unavailable' as const }, { kind: 'edit' as const, plan: { ...storedPlan, id: '30000000-0000-4000-8000-000000000001' } }]) {
      const unavailable = whmAt('/whm/plans', { ...metadata, planEditorState })
      assert.match(unavailable, /The requested plan is unavailable/)
      assert.equal(documentFor(unavailable).querySelectorAll('[data-native-plan-editor],[data-plan-editor-form]').length, 0)
    }
  })

  it('renders xPanel surface with Slice Meters, Multi-IP Domains, Dynamic userdata Config Editor, Website Analytics, Jailed File Manager (0640/0750), and Jailed Shell Terminal', () => {
    const html = ['/home', '/domains', '/domains/site-settings', '/metrics/traffic', '/files/manager', '/advanced/terminal'].map(route => panelAt(route)).join('\n')
    assert.match(html, /data-surface="xpanel"/)
    assert.match(html, /xpanel-20014\.slice/)
    // Domains & Multi-IPv4/IPv6 + PHP 8.1..8.4 handlers
    assert.match(html, /data-domains-table="true"/)
    assert.match(html, /10\.0\.0\.21/)
    assert.match(html, /2001:db8::12/)
    // Dynamic Custom Configurations (userdata model)
    assert.match(html, /\/etc\/xpanel\/userdata\/alice\/alice-shop\.com\/nginx\.conf/)
    assert.match(html, /\/etc\/xpanel\/userdata\/alice\/alice-shop\.com\/apache\.conf/)
    assert.match(html, /\/home\/alice\/public_html\/\.user\.ini/)
    assert.match(html, /nginx -t/)
    assert.match(html, /apachectl configtest/)
    assert.match(html, /SuexecUserGroup/)
    assert.match(html, /data-domain-custom-config="11111111-1111-4111-8111-111111111111"/)
    assert.match(html, /data-userdata-status/)
    assert.doesNotMatch(html, /action="\/api\/xpanel\/domains\/custom-config"/)
    assert.match(html, /AssignUserId/)
    // Website Analytics chart
    assert.match(html, /data-surface-widget="website-analytics"/)
    // Jailed File Manager (0640/0750 rules, 0777 blocked, .trash)
    assert.match(html, /data-file-manager-table="true"/)
    assert.doesNotMatch(html, /O_NOFOLLOW Symlink-Safe|Safe Edit/)
    assert.match(html, /0640/)
    assert.match(html, /0750/)
    assert.match(html, /0777/)
    assert.match(html, /data-action="restore-file"[^>]*>Restore<\/button>/)
    // Jailed Shell Terminal
    // The fixture has no signed-in owner, so the workspace renders but cannot open a shell.
    assert.match(html, /data-terminal-workspace data-terminal-kind="account" data-terminal-can-use="false"/)
    assert.doesNotMatch(html, /data-terminal-output|data-terminal-execution/)
    assert.match(html, /The account terminal is unavailable here\. Nothing was opened\./)
    assertAllBadgesHaveSvgAndLabel(html)

    // Verify honest disabled state when plan.shell === 'none'
    const noShellHtml = renderPanelSurface({
      account: { ...fixtureAccount, shell: 'none' }, activeRoute: '/advanced/terminal',
      plan: {
        id: 'plan-starter',
        name: 'Starter',
        ownerId: null,
        featureListId: 'feat-default',
        resources: {
          diskMb: 5120,
          bandwidthMbMonth: 51200,
          ioReadBps: 'unlimited',
          ioWriteBps: 'unlimited',
          ioReadIops: 'unlimited',
          ioWriteIops: 'unlimited',
          memoryMb: 512,
          maxProcesses: 64,
          cpuPercent: 100,
        },
        caps: {
          addonDomains: 1,
          aliasDomains: 1,
          subdomains: 5,
          mailboxes: 5,
          forwarders: 5,
          mailingLists: 0,
          ftpAccounts: 1,
          databases: 1,
          phpWorkers: 4,
        },
        dedicatedIp: false,
        shell: 'none',
        defaultMailboxQuotaMb: 512,
      },
    })
    assert.match(noShellHtml, /data-terminal-can-use="false"/)
    assert.match(noShellHtml, /Terminal access is disabled on your current plan\./)
  })

  it('renders xMail three-pane webmail, Sieve filter rules, Vacation autoresponder, and mailbox quota meter', () => {
    const html = ['/mail/inbox', '/mail/settings/filters', '/mail/settings/autoresponder', '/mail/compose', '/mail/overview'].map(route => mailAt(route, { locale: 'ar', theme: 'light' })).join('\n')
    assert.match(html, /data-surface="xmail"/)
    assert.match(html, /data-mail-pane="folders"/)
    assert.match(html, /data-mail-pane="message-list"/)
    assert.match(html, /data-mail-pane="reading-pane"/)
    assert.match(html, /data-section="sieve-filters"/)
    assert.match(html, /data-section="vacation-autoresponder"/)
    assert.match(html, /data-section="compose-drawer"/)
    assertAllBadgesHaveSvgAndLabel(html)
  })

  it('selects only the requested core screen and keeps unavailable routes explicit', () => {
    const routeCases: [string, (route: string) => string, string, string[]][] = [
      ['/whm/accounts', whmAt, 'data-section="accounts-isolation"', ['data-section="service-health"', 'data-section="plans-feature-lists"', 'data-create-account-form="true"']],
      ['/whm/accounts/new', whmAt, 'data-create-account-form="true"', ['data-terminate-account-form="true"', 'data-section="service-health"']],
      ['/whm/plans', whmAt, 'data-native-plan-editor', ['data-plan-editor-form="true"', 'data-section="accounts-isolation"', 'data-section="nftables-firewall"']],
      ['/whm/server/ips', whmAt, 'data-ip-pool-table="true"', ['data-mail-ip-config-form="true"']],
      ['/whm/email/outbound', whmAt, 'data-mail-ip-config-form="true"', ['data-ip-pool-table="true"', 'data-add-ip-form="true"']],
      ['/domains', panelAt, 'data-domains-table="true"', ['data-userdata-form="true"', 'data-file-manager-table="true"']],
      ['/domains/site-settings', panelAt, 'data-userdata-form="true"', ['data-domains-table="true"', 'data-file-manager-table="true"']],
      ['/files/manager', panelAt, 'data-file-manager-table="true"', ['data-domains-table="true"', 'data-terminal-workspace']],
      ['/mail/inbox', mailAt, 'data-mail-pane="message-list"', ['data-compose-form="true"', 'data-section="sieve-filters"']],
      ['/mail/compose', mailAt, 'data-compose-form="true"', ['data-mail-pane="message-list"', 'data-section="vacation-autoresponder"']],
      ['/mail/settings/filters', mailAt, 'data-section="sieve-filters"', ['data-compose-form="true"', 'data-section="vacation-autoresponder"']],
      ['/mail/settings/autoresponder', mailAt, 'data-section="vacation-autoresponder"', ['data-section="sieve-filters"', 'data-compose-form="true"']],
    ]
    for (const [route, render, selected, unrelated] of routeCases) {
      const html = render(route)
      assert.ok(html.includes(selected), `${route} must render ${selected}`)
      for (const marker of unrelated) assert.ok(!html.includes(marker), `${route} must not render ${marker}`)
    }
    for (const render of [whmAt, panelAt, mailAt]) {
      const html = render('/unimplemented-synthetic-route')
      assert.match(html, /data-screen="unavailable"/)
      assert.doesNotMatch(html, /<form\b|data-terminal-workspace/)
    }
    for (const [html, title] of [[panelAt('/home'), 'Home'], [panelAt('/domains'), 'Domains'], [whmAt('/whm/accounts/new'), 'Create account']]) {
      const headings = [...html!.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(match => match[1]!.replace(/<[^>]*>/g, '').trim())
      assert.equal(headings.length, 1, `${title} must have one task heading`)
      assert.equal(headings[0]!.toLowerCase(), title!.toLowerCase())
    }
  })

  it('keeps missing provider observations empty and never invents a session or measurement', () => {
    assert.match(panelAt('/domains/site-settings', { customConfig: undefined }), /data-screen="unavailable"/)
    assert.match(panelAt('/metrics/traffic', { websiteAnalytics: undefined }), /data-screen="unavailable"/)
    // No sample is rendered on the server: every IO fact and row says it was not read, nothing is shown as a measurement.
    const io = whmAt('/whm/monitoring/io')
    assert.match(io, /data-whm-metering="io"/)
    assert.match(io, /data-whm-metering-status data-state="unread"/)
    const facts = [...io.matchAll(/data-whm-metering-fact="([a-z]+)">([^<]*)</g)]
    assert.deepEqual(facts.map(match => match[1]), ['observed', 'read', 'write', 'iops', 'latency', 'pressure', 'host'])
    assert.ok(facts.every(match => match[2] === 'Not read'))
    assert.match(io, /No account resources have been read\./)
    assert.match(io, /No disk devices have been read\./)
    assert.doesNotMatch(io, /MiB\/s|IOPS<\/bdi>|xpanel-\d+\.slice|% CPU/)
    assert.doesNotMatch(whmAt('/whm/monitoring/io', { principal: undefined }), /data-metering-can-read="true"/)
    assert.match(whmAt('/whm/email/outbound', { mailIpConfig: undefined }), /data-screen="unavailable"/)
    const emptyMail = mailAt('/mail/inbox', { messages: [] })
    // Inert client <template> rows are not rendered observations.
    const emptyMailRendered = emptyMail.replace(/<template\b[\s\S]*?<\/template>/g, '')
    assert.match(emptyMail, /data-mail-pane="empty"/)
    assert.doesNotMatch(emptyMailRendered, /data-mail-uid=|Synthetic message/)
    const terminal = panelAt('/advanced/terminal')
    assert.match(terminal, /data-terminal-status data-state="(?:closed|unavailable)"/)
    assert.doesNotMatch(terminal, /Session open/)
    const trash = panelAt('/files/trash')
    assert.match(trash, /data-file-path="\/home\/alice\/\.trash\/trashed-fixture\.txt"/)
    assert.doesNotMatch(trash, /data-file-path="\/home\/alice\/public_html\/fixture\.txt"/)
    assert.match(trash, /data-file-manager="trash"/)
    assert.match(trash, /Deleted \(UTC\)/)
    assert.equal(documentFor(trash).querySelectorAll('#jailed-code-editor,[data-chmod-policy-modal]').length, 0)
    assert.doesNotMatch(trash, /data-action="upload-file"|data-action="new-file"|data-action="new-folder"/)
    const managerPage = panelAt('/files/manager')
    const managerDocument = documentFor(managerPage)
    assert.equal(managerDocument.querySelectorAll('#jailed-code-editor').length, 1)
    assert.equal(managerDocument.querySelectorAll('[data-chmod-policy-modal]').length, 1)
    assert.match(managerPage, /data-action="upload-file"/)
    assert.match(panelAt('/databases/mariadb'), /alice_fixture/)
    assert.match(panelAt('/email/accounts'), /info@alice-shop\.com/)
    assert.match(panelAt('/files/ftp'), /info@alice-shop\.com/)
    assert.match(panelAt('/domains/zone-editor'), /10\.0\.0\.21/)
    assert.match(panelAt('/home'), /data-resource-metrics="unavailable"/)
    for (const generationId of [undefined, 0, -1]) {
      for (const html of [whmAt('/whm', { generationId }), panelAt('/home', { generationId }), mailAt('/mail/inbox', { generationId })]) {
        assert.doesNotMatch(html, /data-generation-chip=/)
      }
    }
  })

  it('handles live WebSocket events in LiveEventStore and serves HTML via serveWebUi', async () => {
    const store = createLiveEventStore()
    store.dispatch({
      id: 'ev-1',
      at: '2026-10-22T14:06:00Z',
      kind: 'reconcile.stage',
      scope: { accountId: null },
      data: { generationId: 143, stage: 'test', status: 'running', detail: 'nginx -t' },
    })
    assert.equal(store.getState().reconcile.generationId, 143)
    assert.equal(store.getState().reconcile.status, 'running')

    store.dispatch({
      id: 'ev-2',
      at: '2026-10-22T14:06:01Z',
      kind: 'reconcile.applied',
      scope: { accountId: null },
      data: { generationId: 143, stateChecksum: 'abcdef123456', filesCount: 40, durationMs: 112 },
    })
    assert.equal(store.getState().reconcile.status, 'applied')

    const bannerHtml = renderReconcileBanner(store.getState(), 'en')
    assert.match(bannerHtml, /Applied in generation #143/)
    assertAllBadgesHaveSvgAndLabel(bannerHtml)

    const ioChartHtml = renderServerIoMonitorChart(SYNTHETIC_WHM_IO_SNAPSHOT, 'en')
    assert.match(ioChartHtml, /data-resource-observation-state="incomplete"/)
    assert.doesNotMatch(ioChartHtml, /xp-chart-svg|data-live-kpi=/)

    const webChartHtml = renderWebsiteAnalyticsChart(SYNTHETIC_WEBSITE_ANALYTICS, 'ar')
    assert.match(webChartHtml, /<svg class="xp-chart-svg"/)

    const res = await serveWebUi(new Request('http://localhost/whm?lang=ar&theme=light&density=compact'))
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, /<html lang="ar" dir="rtl" data-theme="light" data-density="compact" data-surface="xwhm"[^>]*>/)
  })

  it('preserves the active client request helpers', () => {
    // Verify interactive client script capabilities
    assert.match(BROWSER_REALTIME_SCRIPT, /window\.xpanelApiCall/)
    assert.match(LOGIN_CLIENT_SCRIPT, /x-csrf-token/)
    assert.match(BROWSER_REALTIME_SCRIPT, /window\.xpanelSessionRequest/)
    assert.match(BROWSER_REALTIME_SCRIPT, /window\.xpanelShowToast/)
    assert.match(BROWSER_REALTIME_SCRIPT, /window\.xpanelSwitchView/)
    assert.doesNotMatch(BROWSER_REALTIME_SCRIPT, /\/api\/xpanel\/terminal\/exec/)
    // File-manager mutations now travel through the validated account-files RPC; the dead
    // /api/xpanel/files/* handlers were removed so no button can call an unregistered route.
    assert.match(BROWSER_REALTIME_SCRIPT, /\/api\/accounts\//)
    assert.match(BROWSER_REALTIME_SCRIPT, /list-trash/)
    assert.doesNotMatch(BROWSER_REALTIME_SCRIPT, /\/api\/xpanel\/files\//)
    assert.doesNotMatch(BROWSER_REALTIME_SCRIPT, /\/api\/xpanel\/domains\/custom-config/)
    assert.match(BROWSER_REALTIME_SCRIPT, /data-domain-custom-config/)
    assert.match(BROWSER_REALTIME_SCRIPT, /\/custom-config/)
  })
})


describe('readable chart datetime metadata', () => {
  const parseChart = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')
  it.each(['en', 'ar'] as const)('keeps IO observation text human and machine datetime exact in %s', locale => {
    const snapshot = structuredClone(SYNTHETIC_WHM_IO_SNAPSHOT)
    snapshot.at = '2026-10-27T12:00:01.123456Z'
    const before = structuredClone(snapshot), doc = parseChart(renderServerIoMonitorChart(snapshot, locale))
    const time = doc.querySelector('time')!
    assert.equal(time.textContent, '2026-10-27 12:00 UTC')
    assert.equal(time.getAttribute('datetime'), '2026-10-27T12:00:01.123456Z')
    assert.equal(time.querySelector('bdi')!.getAttribute('dir'), 'ltr')
    assert.equal(doc.querySelectorAll('[data-resource-observation-state="incomplete"]').length, 1)
    assert.equal(doc.querySelectorAll('.xp-resource-history-unavailable').length, 1)
    assert.equal(doc.querySelectorAll('.xp-chart-svg').length, 0)
    assert.deepEqual(snapshot, before)
  })
  it.each(['en', 'ar'] as const)('keeps analytics header and SVG hover time human without changing bucket geometry in %s', locale => {
    const snapshot = structuredClone(SYNTHETIC_WEBSITE_ANALYTICS)
    snapshot.at = '2026-10-27T12:00:00.000Z'
    snapshot.series[0]!.at = '2026-10-22T14:01:00.123456Z'
    const before = structuredClone(snapshot), doc = parseChart(renderWebsiteAnalyticsChart(snapshot, locale, '24h'))
    const time = doc.querySelector('time')!
    assert.equal(time.textContent, '2026-10-27 12:00 UTC')
    assert.equal(time.getAttribute('datetime'), '2026-10-27T12:00:00.000Z')
    const expected = '2026-10-22 14:01 UTC — 2xx: 8510, 3xx: 580, 4xx: 98, 5xx: 12 | Hit: 7780, Miss: 1120 | P95: 58.0 ms'
    const point = doc.querySelector('.xp-chart-svg circle[data-tooltip]')!
    assert.equal(point.getAttribute('data-tooltip'), expected)
    assert.equal(point.querySelector('title')!.textContent, expected)
    const geometry = (document: Document) => [...document.querySelectorAll('.xp-chart-svg :is(polyline,polygon,circle,path)')].map(node => ['cx', 'cy', 'r', 'points', 'd'].map(name => node.getAttribute(name)))
    const axisText = (document: Document) => [...document.querySelectorAll('.xp-chart-svg text')].map(node => node.textContent)
    const base = parseChart(renderWebsiteAnalyticsChart(SYNTHETIC_WEBSITE_ANALYTICS, locale, '24h'))
    assert.deepEqual(geometry(doc), geometry(base))
    assert.deepEqual(axisText(doc), axisText(base))
    assert.equal(doc.querySelector('[data-analytics-range]')!.getAttribute('data-analytics-range'), '24h')
    assert.equal(doc.querySelector('[data-chart-state]')!.getAttribute('data-chart-state'), 'loaded')
    assert.deepEqual(snapshot, before)
  })
  it.each(['en', 'ar'] as const)('keeps empty analytics observation readable with exact ISO attributes in %s', locale => {
    const snapshot = { ...structuredClone(SYNTHETIC_WEBSITE_ANALYTICS), at: '2026-10-27T12:00:01.123456Z', series: [] }
    const before = structuredClone(snapshot), doc = parseChart(renderWebsiteAnalyticsChart(snapshot, locale, '7d'))
    const times = [...doc.querySelectorAll('time')]
    assert.equal(times.length, 2)
    assert.deepEqual(times.map(node => node.textContent), ['2026-10-27 12:00 UTC', '2026-10-27 12:00 UTC'])
    assert.deepEqual(times.map(node => node.getAttribute('datetime')), ['2026-10-27T12:00:01.123456Z', '2026-10-27T12:00:01.123456Z'])
    assert.equal(doc.querySelector('[data-chart-state]')!.getAttribute('data-chart-state'), 'empty')
    assert.equal(doc.querySelectorAll('[data-analytics-empty]').length, 1)
    assert.equal(doc.querySelectorAll('.xp-chart-svg,.xp-kpi-grid').length, 0)
    assert.deepEqual(snapshot, before)
  })
})

describe('readable initial file metadata', () => {
  it.each([
    { locale: 'en', route: '/files/manager' }, { locale: 'ar', route: '/files/manager' },
    { locale: 'en', route: '/files/trash' }, { locale: 'ar', route: '/files/trash' },
  ] as const)('renders readable UTC file metadata in the retained SSR table ($locale, $route)', ({ locale, route }) => {
    const rawTime = '2026-10-27T09:01:02.123Z'
    const file: NonNullable<PanelSurfaceProps['files']>[number] = { name: 'time-review.txt', path: '/home/alice/public_html/time-review.txt', kind: 'file', sizeBytes: 12345, modeOctal: '0640', modifiedAt: rawTime, trashed: route === '/files/trash' }
    const original = JSON.stringify(file), root = documentFor(panelAt(route, { locale, files: [file] }))
    const time = root.querySelector<HTMLTimeElement>('[data-file-manager-table] tbody time')
    assert.ok(time); assert.equal(time.textContent, '2026-10-27 09:01 UTC'); assert.equal(time.getAttribute('datetime'), rawTime)
    assert.equal(root.querySelector('[data-file-manager-table] tbody tr')!.getAttribute('data-file-path'), file.path)
    assert.equal(JSON.stringify(file), original)
  })
})

describe('readable administrator audit instants', () => {
  it.each(['en', 'ar'] as const)('keeps the %s human date separate from exact machine, filter and export instants', locale => {
    const at = '2026-10-27T14:00:01.123456+02:00'
    const from = '2026-10-27T09:00:00.123456Z'
    const to = '2026-10-27T11:00:00.654321Z'
    const auditEntries = [{ id: 'fractional-audit-private-key', at, actor: 'synthetic-root', action: 'auth.login', target: 'preview.example.test', detail: {}, outcome: 'ok' as const }]
    const before = structuredClone(auditEntries)
    const html = whmAt('/whm/audit', { locale, theme: 'dark', density: 'compact', auditEntries, auditList: { actor: 'synthetic-root', action: 'auth.login', target: 'preview.example.test', outcome: 'ok', from, to, before: '42', hasMore: true, oldestId: '40' } })
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const time = doc.querySelector('[data-section="audit-log"] tbody tr[data-audit-id="fractional-audit-private-key"] time')!
    assert.equal(time.getAttribute('datetime'), '2026-10-27T14:00:01.123456+02:00')
    assert.equal(time.textContent, '2026-10-27 12:00 UTC')
    assert.equal(time.querySelector('bdi')?.getAttribute('dir'), 'ltr')
    assert.equal(doc.querySelector('#audit-from')!.getAttribute('value'), '2026-10-27T09:00:00.123456')
    assert.equal(doc.querySelector('#audit-to')!.getAttribute('value'), '2026-10-27T11:00:00.654321')
    const older = new URL(doc.querySelector('[data-audit-older]')!.getAttribute('href')!, 'https://synthetic.invalid')
    for (const [key, value] of Object.entries({ lang: locale, theme: 'dark', density: 'compact', actor: 'synthetic-root', action: 'auth.login', target: 'preview.example.test', outcome: 'ok', from, to, before: '40' })) assert.equal(older.searchParams.get(key), value, key)
    const jsonHref = doc.querySelector('[data-audit-export] a[download="xpanel-audit-page.json"]')!.getAttribute('href')!
    const exported = JSON.parse(decodeURIComponent(jsonHref.slice(jsonHref.indexOf(',') + 1))) as Array<Record<string, unknown>>
    assert.equal(exported[0]!.at, '2026-10-27T14:00:01.123456+02:00')
    assert.deepEqual(Object.keys(exported[0]!), ['at', 'actor', 'action', 'target', 'outcome'])
    assert.doesNotMatch(JSON.stringify(exported), /fractional-audit-private-key|"detail"/)
    const csvHref = doc.querySelector('[data-audit-export] a[download="xpanel-audit-page.csv"]')!.getAttribute('href')!
    assert.ok(decodeURIComponent(csvHref.slice(csvHref.indexOf(',') + 1)).includes('"2026-10-27T14:00:01.123456+02:00"'))
    assert.deepEqual(auditEntries, before)
    assert.doesNotMatch(time.textContent!, /[\u0660-\u0669\u06f0-\u06f9]/)
  })
})
