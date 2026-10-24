import { SYNTHETIC_WEBSITE_ANALYTICS, SYNTHETIC_WHM_IO_SNAPSHOT } from '../../../tests/fixtures/analytics-snapshots.ts'
import { LOGIN_CLIENT_SCRIPT } from './login-client.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import {
  BROWSER_REALTIME_SCRIPT,
  createLiveEventStore,
  dirForLocale,
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
  t,
  type PanelSurfaceProps,
  type WhmSurfaceProps,
  type MailSurfaceProps,
} from './index.ts'

// Explicit synthetic renderer observations. None are production defaults or live-host proof.
const fixtureAt = '2026-10-22T14:05:00Z'
const fixturePlan = { ...defaultPlan({ id: 'fixture-plan', name: 'Synthetic plan', featureListId: 'fixture-features' }), shell: 'jailed' as const }
const fixtureAccount: Account = {
  id: 'fixture-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice-shop.com',
  planId: fixturePlan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@alice-shop.com',
  ipv4: '10.0.0.21', ipv6: '2001:db8::12', shell: 'jailed', createdAt: fixtureAt,
}
const panelFixture: PanelSurfaceProps = {
  account: fixtureAccount, plan: fixturePlan,
  domains: [{ id: 'fixture-domain', accountId: fixtureAccount.id, name: fixtureAccount.primaryDomain, kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ipv4: fixtureAccount.ipv4, ipv6: fixtureAccount.ipv6 }],
  customConfig: { domainId: 'fixture-domain', accountId: fixtureAccount.id, domainName: fixtureAccount.primaryDomain, nginxInclude: '# synthetic include', apacheInclude: '# synthetic include', userIni: { memory_limit: '256M' }, customHeaders: {}, cacheBypassPaths: [], updatedAt: fixtureAt, updatedBy: 'user' },
  websiteAnalytics: SYNTHETIC_WEBSITE_ANALYTICS,
  files: [{ name: 'fixture.txt', path: '/home/alice/public_html/fixture.txt', kind: 'file', sizeBytes: 128, modeOctal: '0640', modifiedAt: fixtureAt }, { name: 'trashed-fixture.txt', path: '/home/alice/.trash/trashed-fixture.txt', kind: 'file', sizeBytes: 64, modeOctal: '0640', modifiedAt: fixtureAt, trashed: true }],
  databases: [{ id: 'fixture-db', accountId: fixtureAccount.id, engine: 'mariadb', name: 'alice_fixture', trashedAt: null }],
  serviceUsers: [{ id: 'fixture-user', accountId: fixtureAccount.id, login: 'info@alice-shop.com', services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 1024, ftpDir: 'public_html' }],
  dnsRecords: [{ id: 'fixture-dns', zone: fixtureAccount.primaryDomain, name: '@', type: 'A', ttl: 3600, content: fixtureAccount.ipv4, priority: null }],
}
const whmFixture: WhmSurfaceProps = {
  principal: { kind: 'root', id: 'fixture-root', username: 'synthetic-root' }, hostname: 'srv1.xpanel.test', adminSessionIp: '203.0.113.7',
  ioSnapshot: SYNTHETIC_WHM_IO_SNAPSHOT, accounts: [fixtureAccount, { ...fixtureAccount, id: 'fixture-other', username: 'omar', uid: 20016, gid: 20016 }], plans: [fixturePlan],
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
    assert.equal(dirForLocale('en'), 'ltr')
    assert.equal(dirForLocale('ar'), 'rtl')
    assert.equal(t('en', 'reconcile.status.applied', { generationId: 142 }), 'Applied in generation #142')
    assert.match(t('ar', 'reconcile.status.applied', { generationId: 142 }), /#142/)
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
    // Real-time Server IO Monitor & cgroup v2 slice rankings
    assert.match(html, /data-surface-widget="io-monitor"/)
    assert.match(html, /xpanel-20014\.slice/)
    assert.match(html, /xpanel-20016\.slice/)
    // Managed services health table
    for (const svc of ['nginx', 'apache', 'php-fpm', 'mariadb', 'dovecot', 'postfix', 'pdns', 'nftables']) {
      assert.match(html, new RegExp(`data-service-row="${svc}"`))
    }
    // Plans & cgroup v2 limits + explicit Unlimited
    assert.match(html, /for="plan-cpu-quota">CPU \(%\)<\/label>/)
    assert.match(html, /for="plan-memory-max">Memory \(MB\)<\/label>/)
    assert.match(html, /for="plan-tasks-max">Processes<\/label>/)
    assert.match(html, /name="unlimitedAddonDomains" value="unlimited"/)
    assert.match(html, /Unlimited addon domains/)
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
    assert.match(whmAt('/whm/audit'), /2026-10-22 14:05:00 UTC/)
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
    assert.match(html, /data-terminal-output=""/)
    assert.match(html, /No terminal session has started/)
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
    assert.match(noShellHtml, /data-terminal-disabled="true"/)
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
      ['/whm/plans', whmAt, 'data-plan-editor-form="true"', ['data-section="accounts-isolation"', 'data-section="nftables-firewall"']],
      ['/whm/server/ips', whmAt, 'data-ip-pool-table="true"', ['data-mail-ip-config-form="true"']],
      ['/whm/email/outbound', whmAt, 'data-mail-ip-config-form="true"', ['data-ip-pool-table="true"', 'data-add-ip-form="true"']],
      ['/domains', panelAt, 'data-domains-table="true"', ['data-userdata-form="true"', 'data-file-manager-table="true"']],
      ['/domains/site-settings', panelAt, 'data-userdata-form="true"', ['data-domains-table="true"', 'data-file-manager-table="true"']],
      ['/files/manager', panelAt, 'data-file-manager-table="true"', ['data-domains-table="true"', 'data-terminal-output=']],
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
      assert.doesNotMatch(html, /<form\b|data-terminal-output=/)
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
    assert.match(whmAt('/whm/monitoring/io', { ioSnapshot: undefined }), /data-screen="unavailable"/)
    assert.match(whmAt('/whm/email/outbound', { mailIpConfig: undefined }), /data-screen="unavailable"/)
    const emptyMail = mailAt('/mail/inbox', { messages: [] })
    assert.match(emptyMail, /data-mail-pane="empty"/)
    assert.doesNotMatch(emptyMail, /data-mail-uid=|Synthetic message/)
    const terminal = panelAt('/advanced/terminal')
    assert.match(terminal, /No terminal session has started/)
    assert.doesNotMatch(terminal, /data-terminal-output="[^"\s]+"/)
    const trash = panelAt('/files/trash')
    assert.match(trash, /data-file-path="\/home\/alice\/\.trash\/trashed-fixture\.txt"/)
    assert.doesNotMatch(trash, /data-file-path="\/home\/alice\/public_html\/fixture\.txt"/)
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
    assert.match(BROWSER_REALTIME_SCRIPT, /\/api\/xpanel\/terminal\/exec/)
    assert.match(BROWSER_REALTIME_SCRIPT, /\/api\/xpanel\/files\/chmod/)
    assert.match(BROWSER_REALTIME_SCRIPT, /\/api\/xpanel\/domains\/custom-config/)
  })
})
