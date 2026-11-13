// Real registered-theme fixture for integrated core/controller diagnostics.
// It uses the installed registry and proves no native capability, asset HTTP delivery or design parity.
import { beforeAll, describe, expect, it } from 'vitest'
import { tools, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { defaultPlan, type Domain, type MailIpConfig } from '@xpanel/core'
import { renderWebApp } from '../app.ts'
import { createInitialLiveEventState } from '../ws-client.ts'
import { parseMarkup, registeredThemeDocuments } from './contract.ts'
import { checkV2Conformance, v2RouteContracts } from './v2-semantics.ts'
import { isHtmlElement } from './markup.ts'


describe('candidate V2 full-document controller conformance', () => {
  // Fixed document census: independent of the renderer and generated controller contracts.
  const expectedRoutes = {
    xpanel: [
      '/advanced/api-shell',
      '/advanced/cron',
      '/advanced/error-pages',
      '/advanced/handlers',
      '/advanced/indexes',
      '/advanced/mime-types',
      '/advanced/network-tools',
      '/advanced/terminal',
      '/databases/insights',
      '/databases/mariadb',
      '/databases/phpmyadmin',
      '/databases/phppgadmin',
      '/databases/postgresql',
      '/databases/remote-access',
      '/domains',
      '/domains/cloudflare',
      '/domains/dynamic-dns',
      '/domains/redirects',
      '/domains/reverse-proxy',
      '/domains/site-publisher',
      '/domains/site-settings',
      '/domains/staging',
      '/domains/zone-editor',
      '/email/accounts',
      '/email/archive',
      '/email/calendars-contacts',
      '/email/deliverability',
      '/email/encryption',
      '/email/filters',
      '/email/forwarders',
      '/email/mailing-lists',
      '/email/spam-filters',
      '/email/spam-quarantine',
      '/files/backup',
      '/files/directory-privacy',
      '/files/ftp',
      '/files/git',
      '/files/manager',
      '/files/trash',
      '/files/web-disk',
      '/health',
      '/home',
      '/metrics/logs',
      '/metrics/traffic',
      '/metrics/web-stats',
      '/preferences',
      '/preferences/language',
      '/preferences/team',
      '/preferences/users',
      '/resources',
      '/security/account',
      '/security/hotlink',
      '/security/ip-blocker',
      '/security/ssh',
      '/security/ssl',
      '/security/ssl/files',
      '/security/ssl/issue',
      '/security/virus-scanner',
      '/security/waf',
      '/server-information',
      '/software/apps',
      '/software/cache',
      '/software/containers',
      '/software/htaccess',
      '/software/installer',
      '/software/optimize',
      '/software/packages',
      '/software/php',
      '/software/store',
      '/software/store/app',
      '/software/store/error',
      '/software/store/install',
      '/software/store/installed',
      '/software/store/progress',
      '/software/store/updates',
    ],
    xwhm: [
      '/whm',
      '/whm/accounts',
      '/whm/accounts/announcements',
      '/whm/accounts/bandwidth',
      '/whm/accounts/health',
      '/whm/accounts/new',
      '/whm/accounts/templates',
      '/whm/audit',
      '/whm/backups',
      '/whm/backups/destinations',
      '/whm/backups/files',
      '/whm/backups/restore',
      '/whm/backups/restore-more',
      '/whm/databases',
      '/whm/databases/mongodb',
      '/whm/databases/phpmyadmin',
      '/whm/databases/processes',
      '/whm/databases/redis',
      '/whm/databases/servers',
      '/whm/databases/tuning',
      '/whm/databases/upgrade',
      '/whm/databases/users',
      '/whm/dns',
      '/whm/dns/cluster',
      '/whm/dns/more',
      '/whm/dns/providers',
      '/whm/domains',
      '/whm/email/bcc',
      '/whm/email/delivery',
      '/whm/email/maintenance',
      '/whm/email/marketing',
      '/whm/email/monitor',
      '/whm/email/outbound',
      '/whm/email/quality',
      '/whm/email/queue',
      '/whm/email/relay',
      '/whm/email/routing',
      '/whm/email/server',
      '/whm/email/spam',
      '/whm/jobs',
      '/whm/monitoring/alerts',
      '/whm/monitoring/benchmark',
      '/whm/monitoring/disk',
      '/whm/monitoring/health',
      '/whm/monitoring/io',
      '/whm/monitoring/limits',
      '/whm/monitoring/logs',
      '/whm/monitoring/performance',
      '/whm/monitoring/processes',
      '/whm/monitoring/repair',
      '/whm/monitoring/server-info',
      '/whm/monitoring/traffic',
      '/whm/panel/api-tokens',
      '/whm/panel/branding',
      '/whm/panel/data',
      '/whm/panel/developer',
      '/whm/panel/integrations',
      '/whm/panel/languages',
      '/whm/panel/notifications',
      '/whm/panel/settings',
      '/whm/panel/whmcs',
      '/whm/plans',
      '/whm/plans/enhancements',
      '/whm/plans/features',
      '/whm/preferences',
      '/whm/resellers',
      '/whm/resellers/ips-nameservers',
      '/whm/resellers/more',
      '/whm/resellers/privileges',
      '/whm/security',
      '/whm/security/antivirus',
      '/whm/security/firewall',
      '/whm/security/flood',
      '/whm/security/intrusion',
      '/whm/security/isolation',
      '/whm/security/panel-access',
      '/whm/security/sign-in',
      '/whm/security/ssh',
      '/whm/security/waf',
      '/whm/server/cron',
      '/whm/server/file-sharing',
      '/whm/server/ips',
      '/whm/server/networking',
      '/whm/server/nodes',
      '/whm/server/role',
      '/whm/server/setup',
      '/whm/server/terminal',
      '/whm/server/trusted-proxies',
      '/whm/server/upgrade',
      '/whm/services',
      '/whm/services/certificates',
      '/whm/services/default-index',
      '/whm/services/nginx-proxy',
      '/whm/services/dns',
      '/whm/services/ftp',
      '/whm/services/ftp-log-analysis',
      '/whm/services/health',
      '/whm/services/more',
      '/whm/services/web',
      '/whm/software/addon-services',
      '/whm/software/application-projects',
      '/whm/software/catalog',
      '/whm/software/composer',
      '/whm/software/containers',
      '/whm/software/containers/engine',
      '/whm/software/deployments',
      '/whm/software/modules',
      '/whm/software/php',
      '/whm/software/runtimes',
      '/whm/software/site-software',
      '/whm/software/store',
      '/whm/software/store/activity',
      '/whm/software/store/extensions',
      '/whm/software/updates',
      '/whm/ssl',
      '/whm/ssl/install',
      '/whm/support',
      '/whm/transfers',
      '/whm/transfers/convert-addon',
      '/whm/transfers/server',
    ],
    xmail: [
      '/mail/calendar',
      '/mail/compose',
      '/mail/contacts',
      '/mail/drafts',
      '/mail/folders',
      '/mail/inbox',
      '/mail/later',
      '/mail/overview',
      '/mail/search',
      '/mail/sent',
      '/mail/settings/autoresponder',
      '/mail/settings/calendars',
      '/mail/settings/filters',
      '/mail/settings/forwarders',
      '/mail/settings/identities',
      '/mail/settings/preferences',
      '/mail/settings/security',
      '/mail/settings/spam',
      '/mail/tools/connect-devices',
      '/mail/tools/disk-usage',
      '/mail/tools/mailing-lists',
      '/mail/tools/track-delivery',
      '/mail/trash',
    ],
  } as const
  const locales = ['en', 'ar'] as const
  const documents = registeredThemeDocuments()

  beforeAll(() => {
    const expectedDocuments = Object.entries(expectedRoutes).flatMap(([surface, routes]) => routes.map(route => `${surface} ${route}`))
    expect(documents).toHaveLength(218)
    expect(new Set(documents.map(document => document.route)).size).toBe(218)
    expect(documents.map(document => `${document.surface} ${document.route}`).sort()).toEqual(expectedDocuments.sort())
    const caseIdentities = locales.flatMap(locale => documents.map(document => `${locale} ${document.surface} ${document.route}`))
    expect(caseIdentities).toHaveLength(436)
    expect(new Set(caseIdentities).size).toBe(436)
    expect(Object.fromEntries(locales.map(locale => [locale, documents.length]))).toEqual({ en: 218, ar: 218 })
  })

  const catalog: CatalogTool[] = tools.map(tool => tool.status === 'out-of-scope' ? tool : ({
    ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Conformance unit fixture only.', evidence: [] },
  }))
  const accountId = '11111111-1111-4111-8111-111111111111'
  const user = { kind: 'user' as const, id: accountId, username: 'contractuser', accountId }
  const visibility = (principal: VisibilityContext['principal']): VisibilityContext => ({ principal, disabledFeatures: new Set() })
  const live = createInitialLiveEventState()
  const account = {
    id: accountId, username: 'contractuser', uid: 2000, gid: 2000, home: '/home/contractuser', primaryDomain: 'example.test', planId: '22222222-2222-4222-8222-222222222222', ownerId: null,
    status: 'active' as const, suspendReason: null, contactEmail: 'contractuser@example.test', ipv4: '192.0.2.10', shell: 'none' as const, createdAt: '2026-01-01T00:00:00.000Z',
  }

  const sslDomain: Domain = {
    id: '44444444-4444-4444-8444-444444444444', accountId: account.id, name: account.primaryDomain,
    kind: 'primary', parentId: null, docRoot: account.home + '/public_html', siteType: 'php', upstream: null, redirect: null,
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} },
    wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
  }

  const mailIpConfig: MailIpConfig = { mode: 'server-default', defaultIpv4: null, defaultIpv6: null, defaultHelo: null, domainOverrides: [] }
  const contractsByRoute = new Map(v2RouteContracts().map(item => [item.route, item]))

  beforeAll(() => {
    const warmRoutes = ['/whm/ssl/install', '/whm/backups/restore-more', '/email/forwarders', '/mail/inbox'] as const
    for (const locale of locales) {
      for (const route of warmRoutes) {
        const doc = documents.find(item => item.route === route)!
        const identity = doc.surface === 'xwhm'
          ? { visibility: visibility({ kind: 'root', id: '33333333-3333-4333-8333-333333333333', username: 'contractroot' }) }
          : doc.surface === 'xpanel'
            ? { visibility: visibility(user), panel: { account, plan: defaultPlan({ id: '22222222-2222-4222-8222-222222222222', name: 'Basic' }), ...(doc.route === '/email/forwarders' ? { domains: [sslDomain] } : {}) } }
            : { visibility: visibility(user), mail: { mailbox: 'contractuser@example.test', domain: 'example.test' } }
        const html = renderWebApp({ ...identity, surface: doc.surface, activeRoute: doc.route, locale, uiTheme: 'v2', theme: 'dark', catalog, liveState: live })
        const nodes = parseMarkup(html)
        const contract = contractsByRoute.get(doc.route)!
        checkV2Conformance(html, { ...contract, context: { ...contract.context, facts: { 'account-domains': doc.route === '/email/forwarders' ? 'present' : 'absent' } } }, nodes)
      }
    }
  })

  for (const locale of locales) it.each(documents)('$route core V2 contract in ' + locale, document => {
    const identity = document.surface === 'xwhm'
      ? { visibility: visibility({ kind: 'root', id: '33333333-3333-4333-8333-333333333333', username: 'contractroot' }), ...(document.route === '/whm/email/outbound' ? { whm: { mailIpConfig: mailIpConfig } } : {}) }
      : document.surface === 'xpanel'
        ? { visibility: visibility(user), panel: { account, plan: defaultPlan({ id: '22222222-2222-4222-8222-222222222222', name: 'Basic' }), ...(document.route === '/domains/site-settings' ? { domains: [sslDomain], activeDomain: sslDomain.name, customConfig: { domainId: sslDomain.id, accountId: sslDomain.accountId, domainName: sslDomain.name, nginxInclude: '', apacheInclude: '', userIni: {}, customHeaders: {}, cacheBypassPaths: [], updatedAt: '', updatedBy: 'user' as const } } : {}), ...(['/security/ssl', '/email/forwarders'].includes(document.route) ? { domains: [sslDomain] } : {}) } }
        : { visibility: visibility(user), mail: { mailbox: 'contractuser@example.test', domain: 'example.test' } }
    const securityFixture = document.route === '/security/account' ? { security: { totpEnabled: false }, mfaRuntimeMode: 'disabled' as const } : {}
    const html = renderWebApp({ ...identity, ...securityFixture, surface: document.surface, activeRoute: document.route, locale, uiTheme: 'v2', theme: 'dark', catalog, liveState: live })
    const nodes = parseMarkup(html)
    const roots = nodes.filter(node => node.template < 0 && isHtmlElement(node, 'html'))
    expect(roots).toHaveLength(1)
    const attributes = roots[0]?.attrs
    expect(attributes?.get('data-ui-theme')).toBe('v2')
    expect(attributes?.get('lang')).toBe(locale)
    expect(attributes?.get('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr')
    expect(attributes?.get('data-theme')).toBe('dark')
    expect(attributes?.get('data-surface')).toBe(document.surface)
    const contract = contractsByRoute.get(document.route)!
    // Mirror the authorized domain filter passed to renderAccountForwarders by account-pages.ts.
    const accountDomains = (identity.panel?.domains ?? []).filter(domain => domain.accountId === identity.panel?.account.id)
    const domainFact: 'present' | 'absent' = accountDomains.length ? 'present' : 'absent'
    const issues = checkV2Conformance(html, { ...contract, context: { ...contract.context, facts: { 'account-domains': domainFact } } }, nodes)
    expect(issues, 'CONFORMANCE_JSON=' + JSON.stringify({ route: document.route, locale, issues }) + '\n').toEqual([])
  })

})
