import { describe, expect, it } from 'vitest'
import { tools } from './data/index.ts'
import { navigation } from './data/navigation.ts'
import { HOST_PROBES, PHASE1_TOOL_PROBES, QUALIFIED_SCOPE, qualifyHostTools, type HostProbe, type HostQualificationReport } from './host-qualification.ts'
import { visibleNavigation } from './navigation.ts'
import type { VisibilityContext } from './visibility.ts'

// Synthetic already-assessed input for this readiness unit boundary; not acceptance evidence.
const acceptedTools = tools.map(tool => PHASE1_TOOL_PROBES[tool.id] !== undefined && tool.status !== 'out-of-scope'
  ? { ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const, reason: 'Synthetic already-assessed release acceptance.' } }
  : tool)

const passed = (executor: HostQualificationReport['executor'], probes: HostQualificationReport['probes']): HostQualificationReport =>
  ({ executor, probes })

describe('host qualification', () => {
  it('never promotes incomplete acceptance even when every host probe passes', () => {
    const declaration = tools.find(tool => tool.id === 'server-information')!
    const report = passed('linux', Object.fromEntries(HOST_PROBES.map(probe => [probe, 'passed'])))
    for (const status of ['researched', 'implemented', 'integrated', 'out-of-scope'] as const) {
      const original = { ...declaration, status, delivery: { ...declaration.delivery, status, reason: `Acceptance remains ${status}.` } }
      const [result] = qualifyHostTools([original], report, true)
      expect(result).toEqual(original)
      expect(result).not.toBe(original)
      expect(result!.delivery).not.toBe(original.delivery)
    }
  })

  it('cannot retain verified admission through absent, fake, disabled or unknown readiness', () => {
    const accepted = acceptedTools.find(tool => tool.id === 'server-information')!
    const report = passed('linux', Object.fromEntries(HOST_PROBES.map(probe => [probe, 'passed'])))
    const outcomes = [
      qualifyHostTools([accepted], null, true),
      qualifyHostTools([accepted], passed('fake', report.probes), true),
      qualifyHostTools([accepted], passed('unknown', report.probes), true),
      qualifyHostTools([accepted], report, false),
      qualifyHostTools([{ ...accepted, id: 'no-reviewed-host-prerequisites' }], report, true),
    ]
    for (const [result] of outcomes) {
      expect(result?.status).toBe('researched')
      expect(result?.delivery.status).toBe('researched')
      expect(result?.delivery.evidence).toBe(accepted.delivery.evidence)
      expect(result?.delivery.reason).toContain('host readiness')
    }
    expect(accepted.status).toBe('verified')
    expect(accepted.delivery.status).toBe('verified')
    expect(qualifyHostTools([accepted], report, true)[0]).toEqual(accepted)
  })

  it('cannot use a verified outer label to bypass incomplete delivery assessment', () => {
    const accepted = acceptedTools.find(tool => tool.id === 'server-information')!
    const input = { ...accepted, delivery: { ...accepted.delivery, status: 'implemented' as const } }
    const report = passed('linux', Object.fromEntries(HOST_PROBES.map(probe => [probe, 'passed'])))
    expect(qualifyHostTools([input], report, true)[0]?.status).toBe('implemented')
  })

  it('leaves the production catalog unqualified', () => {
    expect(tools.filter(tool => tool.status === 'verified')).toEqual([])
    expect(qualifyHostTools(tools, null).filter(tool => tool.status === 'verified')).toEqual([])
    expect(qualifyHostTools(tools, passed('linux', Object.fromEntries(HOST_PROBES.map(probe => [probe, 'passed'])))).filter(tool => tool.status === 'verified')).toEqual([])
    expect(qualifyHostTools(acceptedTools, passed('fake', { 'control-plane': 'passed', apache: 'passed', 'linux-account': 'passed' })).filter(tool => tool.status === 'verified')).toEqual([])
  })

  it('verifies only implemented tools whose probes passed', () => {
    const report = passed('linux', {
      'control-plane': 'passed',
      'linux-account': 'passed',
      apache: 'failed',
      mariadb: 'passed',
      mail: 'failed',
      files: 'failed',
    })
    const qualified = new Set(qualifyHostTools(acceptedTools, report).filter(tool => tool.status === 'verified').map(tool => tool.id))
    expect(qualified).toEqual(new Set(['aapanel-saved-commands', 'linked-server-nodes', 'configuration-cluster', 'database-wizard', 'list-accounts', 'modify-account', 'password-modification', 'manage-account-suspension', 'terminate-accounts', 'add-package', 'edit-package', 'delete-package', 'feature-list-crud', 'feature-manager', 'server-settings-edit', 'basic-server-setup', 'mysql-databases', 'mysql-users', 'ssl-tls-status', 'reseller-center',
      'aapanel-provider-dns-records', 'aapanel-auto-dns-on-site-create', 'notification-templates', 'panel-upgrade', 'aapanel-language-theme', 'service-ssl-certificates', 'xwhm-api-tokens', 'notification-center', 'mail-quality', 'panel-news',
      'service-config-health', 'api-shell', 'api-explorer', 'integrations-hub', 'aapanel-third-party-plugin-import', 'metrics-export', 'error-reporting', 'config-as-code', 'trusted-proxies', 'backup-destinations',
      'change-root-password', 'security-questions', 'security-policy', 'external-authentication',
      'aapanel-panel-general', 'panel-branding', 'application-locales', 'whmcs-integration',
      'manage-demo-mode', 'hooks-manager', 'registered-apps', 'plugin-generator', 'theme-manager', 'site-software-catalog', 'account-enhancements',
      'tweak-domains', 'xpanel-tools-home', 'xpanel-general-info', 'xpanel-global-search', 'cloudflare-account', 'password-security', 'two-factor-auth', 'api-tokens', 'command-line-api',
      'change-language', 'xpanel-notifications', 'xpanel-onboarding-assistant',
      'account-preferences', 'change-style', 'manage-team', 'whm-global-search', 'list-suspended-accounts', 'show-reseller-accounts', 'reseller-account-limits', 'reseller-nameservers',
      'reseller-privileges', 'manage-reseller-ip-delegation', 'aapanel-site-list', 'list-parked-domains', 'list-subdomains', 'cloudflare-integration',
      'aapanel-dns-provider-accounts', 'aapanel-provider-domains', 'manage-shell-access', 'root-ssh-keys', 'aapanel-recovery-cli', 'xwhm-two-factor-auth',
      'aapanel-security-entrance', 'aapanel-unauth-response', 'aapanel-basic-auth', 'aapanel-temporary-login',
      'transfer-tool-selection', 'account-transfer-progress', 'review-transfers-and-restores', 'tweak-display', 'locale-list', 'locale-edit', 'locale-xml-import',
      'locale-xml-export', 'xwhm-api-shell', 'reserved-ips', 'ip-usage-report', 'reset-resellers', 'reseller-package-limits', 'manage-reseller-shared-ip',
      'advanced-settings-browser', 'tweak-system', 'tweak-security', 'tweak-stats-logs', 'tweak-logging', 'password-strength', 'security-policies', 'default-key-type', 'panel-change-log',
      'change-ownership-multiple-accounts', 'user-manager', 'locale-delete', 'tweak-notifications', 'tweak-development', 'disk-usage', 'webmail-filter-test',
      'force-password-change', 'account-enhancements', 'tweak-packages', 'whm-home-favorites', 'whm-notifications', 'locale-copy']))
    expect(qualified.has('create-account')).toBe(false)
    expect(qualified.has('file-manager')).toBe(false)
    expect(qualified.has('email-accounts')).toBe(false)
    expect(qualified.has('ssl-install')).toBe(false)
    expect(qualified.has('webmail-message-list')).toBe(false)
    expect(qualified.has('webmail-compose')).toBe(false)
    for (const id of qualified) expect(PHASE1_TOOL_PROBES[id]?.every(probe => report.probes[probe] === 'passed')).toBe(true)
  })

  it('verifies certificate issuance when Apache and the ACME probe passed', () => {
    const report = passed('linux', { 'control-plane': 'passed', apache: 'passed', acme: 'passed' })
    const qualified = new Set(qualifyHostTools(acceptedTools, report).filter(tool => tool.status === 'verified').map(tool => tool.id))
    expect(qualified.has('ssl-install')).toBe(true)
    expect(qualified.has('ssl-tls-status')).toBe(true)
    expect(qualified.has('create-account')).toBe(false)
  })

  it('verifies the mailbox inbox when the mail probe passed', () => {
    const report = passed('linux', { 'control-plane': 'passed', mail: 'passed' })
    const qualified = new Set(qualifyHostTools(acceptedTools, report).filter(tool => tool.status === 'verified').map(tool => tool.id))
    expect(qualified.has('webmail-message-list')).toBe(true)
    expect(qualified.has('webmail-message-read')).toBe(true)
    expect(qualified.has('webmail-compose')).toBe(true)
    expect(qualified.has('webmail-folders')).toBe(true)
    expect(qualified.has('webmail-disk-cleanup')).toBe(true)
    expect(qualified.has('webmail-mail-client-setup')).toBe(true)
    expect(qualified.has('webmail-track-delivery')).toBe(false)
    expect(qualified.has('email-accounts')).toBe(true)
  })

  it('verifies phase 2 administrator tools only when their own probes passed', () => {
    const report = passed('linux', {
      'control-plane': 'passed',
      pdns: 'passed',
      backups: 'passed',
      systemd: 'passed',
      'host-info': 'passed',
    })
    const qualified = new Set(qualifyHostTools(acceptedTools, report).filter(tool => tool.status === 'verified').map(tool => tool.id))
    for (const id of ['reseller-center', 'dns-zone-manager', 'add-dns-zone', 'delete-dns-zone', 'backup-restoration', 'restart-web', 'restart-mysql', 'restart-mta', 'restart-imap', 'restart-ftp', 'restart-dns', 'server-information', 'zone-ttl-bulk']) {
      expect(qualified.has(id), id).toBe(true)
    }
    for (const id of ['restart-ssh', 'aapanel-performance-test', 'backup-config', 'create-account', 'file-manager']) {
      expect(qualified.has(id), id).toBe(false)
    }
    const root = { principal: { kind: 'root' as const, id: '00000000-0000-4000-8000-000000000001', username: 'root' } }
    const routes = visibleNavigation(root, qualifyHostTools(acceptedTools, report)).flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))
    expect(routes).toContain('/whm')
    expect(routes).toContain('/whm/monitoring/server-info')
    const withoutHost = passed('linux', { 'control-plane': 'passed', pdns: 'passed', backups: 'passed', systemd: 'passed' })
    const hidden = visibleNavigation(root, qualifyHostTools(acceptedTools, withoutHost)).flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))
    expect(hidden).not.toContain('/whm')
  })

  it('verifies the audit log when the log can be read', () => {
    const report = passed('linux', { 'control-plane': 'passed', audit_log: 'passed' })
    const qualified = new Set(qualifyHostTools(acceptedTools, report).filter(tool => tool.status === 'verified').map(tool => tool.id))
    expect(qualified.has('audit-log')).toBe(true)
    const root = { principal: { kind: 'root' as const, id: '00000000-0000-4000-8000-000000000001', username: 'root' } }
    const routes = visibleNavigation(root, qualifyHostTools(acceptedTools, report)).flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))
    expect(routes).toContain('/whm/audit')
    const hidden = visibleNavigation(root, qualifyHostTools(acceptedTools, passed('linux', { 'control-plane': 'passed' }))).flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))
    expect(hidden).not.toContain('/whm/audit')
  })

  const root = { principal: { kind: 'root' as const, id: '00000000-0000-4000-8000-000000000001', username: 'root' } }
  const owner = { principal: { kind: 'user' as const, id: 'owner', username: 'owner', accountId: 'account' }, disabledFeatures: new Set<string>() }
  const allPassed = passed('linux', Object.fromEntries(HOST_PROBES.map(probe => [probe, 'passed'])))
  const routesFor = (report: HostQualificationReport, context: VisibilityContext = root): string[] =>
    visibleNavigation(context, qualifyHostTools(acceptedTools, report)).flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))
  const withProbe = (probe: HostProbe, result: 'failed' | undefined): HostQualificationReport => {
    const probes = { ...allPassed.probes }
    if (result === undefined) delete probes[probe]
    else probes[probe] = result
    return passed('linux', probes)
  }

  it.each([
    ['/whm/jobs', 'host-jobs'], ['/whm/software/updates', 'packages'], ['/whm/software/updates', 'host-jobs'], ['/whm/monitoring/repair', 'packages'],
    ['/whm/email/queue', 'mail-queue'], ['/whm/software/catalog', 'packages'], ['/whm/software/modules', 'packages'], ['/whm/software/runtimes', 'host-jobs'],
    ['/whm/server/upgrade', 'control-plane'], ['/whm/monitoring/processes', 'procps'], ['/whm/monitoring/disk', 'procps'], ['/whm/monitoring/logs', 'journal'],
    ['/whm/email/delivery', 'journal'], ['/whm/email/monitor', 'mail'], ['/whm/databases', 'mariadb-admin'], ['/whm/databases/users', 'mariadb-admin'],
    ['/whm/databases/processes', 'mariadb-admin'], ['/whm/databases/servers', 'mariadb-admin'], ['/whm/email/server', 'mail-config'], ['/whm/email/routing', 'mail-config'],
    ['/whm/server/cron', 'systemd'], ['/whm/server/networking', 'iproute'], ['/whm/server/role', 'systemd'], ['/whm/services/dns', 'pdns'],
    ['/whm/services/ftp', 'systemd'], ['/whm/services/certificates', 'control-plane'], ['/whm/accounts/health', 'getent'], ['/whm/panel/api-tokens', 'control-plane'],
    ['/whm/panel/notifications', 'control-plane'], ['/whm/security/intrusion', 'fail2ban'], ['/whm/security/antivirus', 'clamav'], ['/whm/security/isolation', 'getent'],
    ['/whm/monitoring/performance', 'host-info'], ['/whm/monitoring/performance', 'procps'],
  ] as const)('opens %s on a Linux host only while the %s probe passes', (route, probe) => {
    expect(routesFor(allPassed)).toContain(route)
    expect(routesFor(withProbe(probe, 'failed'))).not.toContain(route)
    expect(routesFor(withProbe(probe, undefined))).not.toContain(route)
    expect(routesFor(passed('fake', allPassed.probes))).not.toContain(route)
  })

  it.each([
    ['/mail/tools/track-delivery', 'journal'], ['/mail/folders', 'mail'], ['/mail/tools/disk-usage', 'mail'], ['/mail/tools/connect-devices', 'mail'],
    ['/advanced/error-pages', 'files'], ['/advanced/indexes', 'apache'], ['/advanced/mime-types', 'files'], ['/security/hotlink', 'files'], ['/domains/redirects', 'apache'],
    ['/security/ip-blocker', 'apache'], ['/advanced/handlers', 'files'], ['/advanced/handlers', 'apache'], ['/domains/site-publisher', 'files'],
  ] as const)('opens the owner page %s only while the %s probe passes', (route, probe) => {
    expect(routesFor(allPassed, owner)).toContain(route)
    expect(routesFor(withProbe(probe, 'failed'), owner)).not.toContain(route)
    expect(routesFor(passed('fake', allPassed.probes), owner)).not.toContain(route)
  })

  it('keeps unimplemented pages and extra tools closed even when every probe passed', () => {
    const qualified = qualifyHostTools(acceptedTools, allPassed)
    for (const id of ['distro-packages',
      'web-stack-builder', 'nameserver-report', 'connect-devices',
      // Saved but never applied, unwired or refused on main: no host effect to prepare for.
      'git-deployments', 'spam-quarantine', 'app-installer']) {
      expect(qualified.find(tool => tool.id === id)?.status, id).toBe('researched')
    }
    const dnsReseller: VisibilityContext = { principal: { kind: 'reseller', id: 'reseller', username: 'reseller' }, reseller: { acl: ['manage-dns'] } }
    expect(qualified.find(tool => tool.id === 'xwhm-email-routing')?.status).toBe('verified')
    expect(routesFor(allPassed, dnsReseller)).not.toContain('/whm/email/routing')
  })

  // Each implemented effect names the binaries, units and readers its API and agent path use.
  const IMPLEMENTED_EFFECT_PROBES: Readonly<Record<string, readonly HostProbe[]>> = {
    'live-transfer': ['control-plane', 'linux-account', 'apache', 'mariadb-admin', 'mail', 'pdns'],
    'linked-server-nodes': ['control-plane'],
    'configuration-cluster': ['control-plane'],
    'account-repair': ['control-plane', 'linux-account', 'files', 'host-jobs'],
    'email-disk-usage': ['control-plane', 'mail', 'files'],
    gitweb: ['control-plane', 'files', 'systemd'],
    'raw-ftp-log-download': ['control-plane', 'journal', 'files'],
    'mail-troubleshooter': ['control-plane', 'mail'],
    'view-relayers': ['control-plane', 'mail', 'journal'],
    'view-sent-summary': ['control-plane', 'mail', 'journal'],
    'repair-mailbox-permissions': ['control-plane', 'mail', 'host-jobs'],
    'spam-daemon-startup': ['control-plane', 'mail', 'mail-config', 'systemd'],
    'incoming-mail-country-filter': ['control-plane', 'mail', 'mail-config'],
    'address-importer': ['control-plane', 'mail'],
    'email-deliverability': ['control-plane', 'mail', 'pdns'],
    'email-routing': ['control-plane', 'mail', 'mail-config'],
    'email-encryption': ['control-plane', 'linux-account', 'files'],
    greylisting: ['control-plane', 'mail', 'mail-config'],
    'track-delivery': ['control-plane', 'mail', 'journal'],
    'webmail-search-index': ['control-plane', 'mail', 'host-jobs'],
    'webmail-spam-marking': ['control-plane', 'mail'],
    'site-publisher': ['control-plane', 'files'],
    'ssl-private-keys': ['control-plane', 'files'],
    'ssl-csrs': ['control-plane', 'files', 'openssl'],
    'ssl-certificates': ['control-plane', 'files', 'openssl'],
    'generate-csr': ['control-plane', 'files', 'openssl'],
    'ssl-storage': ['control-plane', 'files'],
    'default-key-type': ['control-plane'],
    'webmail-password': ['control-plane', 'mail'],
    'webmail-two-factor': ['control-plane', 'mail'],
    'ip-blocker': ['control-plane', 'apache'],
    'apache-handlers': ['control-plane', 'files', 'apache'],
    'nginx-cache-control': ['control-plane', 'apache'],
    'nginx-proxy-manager': ['control-plane', 'apache'],
    'leech-protection': ['control-plane', 'files', 'apache'],
    'file-restoration': ['control-plane', 'files', 'backups'],
    'web-apps': ['control-plane', 'systemd', 'files'],
    'website-backups': ['control-plane', 'files', 'backups'],
    'images': ['control-plane', 'files'],
    'html-editor': ['control-plane', 'files'],
    'perl-modules': ['control-plane', 'systemd', 'files'],
    'optimize-website': ['control-plane', 'systemd'],
    'change-language': ['control-plane'],
    'xpanel-notifications': ['control-plane'],
    'xpanel-onboarding-assistant': ['control-plane'],
    'xpanel-server-information': ['control-plane', 'systemd'],
    'team-audit-log': ['control-plane', 'audit_log'],
    'webmail-plus-addressing': ['control-plane', 'mail'],
    'webmail-contact-info': ['control-plane', 'mail'],
    'web-disk': ['control-plane', 'dav'],
    'calendars-contacts-config': ['control-plane', 'dav'],
    'calendars-contacts-management': ['control-plane', 'mail', 'dav'],
    'webmail-calendar': ['control-plane', 'mail', 'dav'],
    'webmail-address-book': ['control-plane', 'mail', 'dav'],
    'webmail-dav-config': ['control-plane', 'mail', 'dav'],
    'server-software-update': ['control-plane', 'packages', 'host-jobs'],
    'xwhm-email-routing': ['control-plane', 'mail', 'mail-config'],
    'tweak-mail': ['control-plane', 'mail', 'mail-config'],
    'aapanel-system-monitor': ['control-plane', 'host-info', 'procps'],
    'notification-channels': ['control-plane', 'mail'],
    'restart-ssh': ['control-plane', 'systemd', 'host-jobs'],
    'aapanel-boot-items': ['control-plane', 'systemd', 'host-jobs'],
    'system-reboot': ['control-plane', 'systemd', 'host-jobs'],
    'domain-htaccess': ['control-plane', 'files', 'apache'],
    'feature-manager': ['control-plane'],
    'basic-server-setup': ['control-plane'],
    'zone-editor': ['control-plane', 'pdns'],
    'php-version-selector': ['control-plane', 'apache', 'systemd'],
    'multiphp-ini-editor': ['control-plane', 'apache', 'systemd'],
    'add-ip': ['control-plane', 'iproute'],
    'change-site-ip': ['control-plane', 'iproute', 'apache', 'pdns'],
    'ip-migration-wizard': ['control-plane', 'iproute', 'apache', 'pdns'],
    'rebuild-ip-pool': ['control-plane', 'iproute'],
    'reserved-ips': ['control-plane'],
    'ip-usage-report': ['control-plane'],
    'ipv6-ranges': ['control-plane', 'iproute'],
    'assign-ipv6': ['control-plane', 'iproute', 'apache', 'pdns'],
    'reset-resellers': ['control-plane'],
    'reseller-package-limits': ['control-plane'],
    'manage-reseller-shared-ip': ['control-plane'],
    'email-all-resellers': ['control-plane', 'mail'],
    'reseller-nameservers': ['control-plane'],
    'advanced-settings-browser': ['control-plane'],
    'tweak-system': ['control-plane'],
    'password-strength': ['control-plane'],
    'security-policies': ['control-plane'],
    'apache-global-config': ['control-plane', 'apache', 'systemd'],
    'directory-index-priority': ['control-plane', 'apache'],
    'web-config-includes': ['control-plane', 'apache', 'systemd'],
    'process-memory-limit': ['control-plane', 'apache', 'systemd'],
    'tweak-compression': ['control-plane', 'backups'],
    'web-stats-awstats': ['control-plane', 'awstats'],
    'web-stats-webalizer': ['control-plane', 'webalizer'],
    'metrics-editor': ['control-plane', 'web-stats'],
    'web-stats-engines': ['control-plane', 'web-stats'],
    'manage-demo-mode': ['control-plane'],
    'hooks-manager': ['control-plane', 'linux-account'],
    'registered-apps': ['control-plane'],
    'plugin-generator': ['control-plane'],
    'theme-manager': ['control-plane'],
    'site-software-catalog': ['control-plane'],
    'site-software-instances': ['control-plane', 'files', 'mariadb', 'host-jobs'],
    'account-enhancements': ['control-plane'],
    'db-repair': ['control-plane', 'mariadb-admin'],
    'db-root-password': ['control-plane', 'mariadb-admin'],
    'db-access-hosts': ['control-plane', 'mariadb-admin', 'systemd'],
    'db-ownership-map': ['control-plane', 'mariadb-admin'],
    'postgresql-setup': ['control-plane', 'systemd'],
    'tweak-sql': ['control-plane', 'mariadb-admin', 'systemd'],
    'database-wizard': ['control-plane', 'mariadb'],
    'postgresql-database-wizard': ['control-plane', 'systemd'],
    phppgadmin: ['control-plane', 'packages'],
    'ftp-server-selection': ['control-plane', 'systemd'],
    'anonymous-ftp': ['control-plane', 'linux-account', 'files', 'systemd'],
    'ftp-connections': ['control-plane', 'procps', 'systemd'],
    'web-stats-ftp': ['control-plane', 'journal'],
    'aapanel-db-quota': ['control-plane', 'mariadb-admin'],
    'aapanel-phpmyadmin-access': ['control-plane', 'packages', 'apache', 'systemd'],
    'aapanel-postgresql-service': ['control-plane', 'packages', 'systemd', 'host-jobs'],
    'aapanel-redis-keys': ['control-plane', 'packages', 'systemd'],
    'aapanel-mongodb': ['control-plane', 'packages', 'systemd', 'host-jobs'],
    'aapanel-redis-service': ['control-plane', 'packages', 'systemd', 'host-jobs'],
    'aapanel-mongodb-service': ['control-plane', 'packages', 'systemd'],
  }

  it('declares the host needs of every implemented effect without an exception', () => {
    expect(Object.fromEntries(Object.keys(IMPLEMENTED_EFFECT_PROBES).map(id => [id, PHASE1_TOOL_PROBES[id]]))).toEqual(IMPLEMENTED_EFFECT_PROBES)
    for (const id of Object.keys(IMPLEMENTED_EFFECT_PROBES)) {
      // A probe list is readiness only: the shipped catalog keeps each tool researched on a fully passing host.
      expect(qualifyHostTools(tools, allPassed).find(tool => tool.id === id)?.status, id).toBe('researched')
      // Partial workspaces name what they leave undelivered; these two deliver their whole declared behavior.
      if (!['restart-ssh', 'domain-htaccess'].includes(id)) expect(QUALIFIED_SCOPE[id], id).toBeDefined()
    }
  })

  it('opens scoped workspaces only with their affected host evidence', () => {
    expect(routesFor(allPassed)).toEqual(expect.arrayContaining(['/whm/services/more', '/whm/monitoring/benchmark', '/whm/monitoring/traffic']))
    expect(routesFor(allPassed)).toEqual(expect.arrayContaining(['/whm/services/default-index', '/whm/software/composer']))
    expect(routesFor(withProbe('apache', 'failed'))).not.toContain('/whm/services/default-index')
    expect(routesFor(withProbe('files', 'failed'))).not.toContain('/whm/software/composer')
    expect(routesFor(withProbe('host-jobs', 'failed'))).not.toContain('/whm/services/more')
    expect(routesFor(withProbe('benchmark', 'failed'))).not.toContain('/whm/monitoring/benchmark')
    expect(routesFor(withProbe('network-counters', 'failed'))).not.toContain('/whm/monitoring/traffic')
    expect(routesFor(allPassed, owner)).toContain('/domains/dynamic-dns')
    expect(routesFor(withProbe('pdns', 'failed'), owner)).not.toContain('/domains/dynamic-dns')
    for (const id of ['aapanel-supervisor', 'service-watchdog']) {
      expect(qualifyHostTools(acceptedTools, withProbe('systemd', 'failed')).find(tool => tool.id === id)?.status, id).not.toBe('verified')
    }
    for (const id of ['restart-ssh', 'aapanel-boot-items', 'system-reboot']) {
      expect(qualifyHostTools(acceptedTools, withProbe('host-jobs', 'failed')).find(tool => tool.id === id)?.status, id).toBe('researched')
    }
  })

  it('declares readiness only for placed in-scope catalog tools and known probes', () => {
    const placed = new Set(navigation.flatMap(surface => surface.sections.flatMap(section => section.pages.flatMap(page => page.tools))))
    for (const [id, probes] of Object.entries(PHASE1_TOOL_PROBES)) {
      const tool = tools.find(entry => entry.id === id)
      expect(tool, id).toBeDefined()
      expect(tool!.status, id).not.toBe('out-of-scope')
      expect(placed.has(id), id).toBe(true)
      expect(probes.length, id).toBeGreaterThan(0)
      expect(new Set(probes).size, id).toBe(probes.length)
      for (const probe of probes) expect(HOST_PROBES, `${id}: ${probe}`).toContain(probe)
      // Only the audit log reads without the panel control plane.
      if (id !== 'audit-log') expect(probes[0], id).toBe('control-plane')
    }
  })

  it.each(Object.entries(PHASE1_TOOL_PROBES))('retains %s only while each declared probe passes', (id, probes) => {
    const accepted = acceptedTools.find(tool => tool.id === id)!
    expect(qualifyHostTools([accepted], allPassed)[0]?.status).toBe('verified')
    for (const probe of probes) {
      expect(qualifyHostTools([accepted], withProbe(probe, 'failed'))[0]?.status, probe).toBe('researched')
      expect(qualifyHostTools([accepted], withProbe(probe, undefined))[0]?.status, probe).toBe('researched')
    }
  })

  it('does not replace release acceptance with a historical partial host scope', () => {
    const qualified = new Map(qualifyHostTools(acceptedTools, allPassed).map(tool => [tool.id, tool]))
    for (const [id, scope] of Object.entries(QUALIFIED_SCOPE)) {
      expect(PHASE1_TOOL_PROBES[id], id).toBeDefined()
      expect(scope.length, id).toBeGreaterThan(0)
      expect(qualified.get(id)?.delivery.reason, id).toBe('Synthetic already-assessed release acceptance.')
    }
    expect(qualified.get('mail-queue-manager')?.delivery.reason).not.toContain('Qualified scope')
  })

  it('stays unqualified when the operator turns host qualification off', () => {
    const previous = process.env.XPANEL_HOST_QUALIFICATION
    process.env.XPANEL_HOST_QUALIFICATION = 'off'
    try {
      const report = passed('linux', { 'control-plane': 'passed' })
      expect(qualifyHostTools(acceptedTools, report).some(tool => tool.status === 'verified')).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.XPANEL_HOST_QUALIFICATION
      else process.env.XPANEL_HOST_QUALIFICATION = previous
    }
  })
})
