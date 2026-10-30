import { describe, expect, it } from 'vitest'
import { tools } from './data/index.ts'
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
    expect(qualified).toEqual(new Set(['list-accounts', 'modify-account', 'password-modification', 'manage-account-suspension', 'terminate-accounts', 'add-package', 'edit-package', 'delete-package', 'feature-list-crud', 'server-settings-edit', 'mysql-databases', 'mysql-users', 'ssl-tls-status', 'reseller-center',
      'panel-upgrade', 'aapanel-language-theme', 'service-ssl-certificates', 'xwhm-api-tokens', 'notification-center', 'mail-quality', 'panel-news',
      'service-config-health', 'api-shell', 'api-explorer', 'integrations-hub', 'trusted-proxies', 'backup-destinations',
      'aapanel-panel-general', 'panel-branding', 'application-locales', 'whmcs-integration']))
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
    for (const id of ['restart-ssh', 'aapanel-performance-test', 'backup-config', 'hostname-a-record', 'dns-config-cleanup', 'create-account', 'file-manager']) {
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
  ] as const)('opens %s on a Linux host only while the %s probe passes', (route, probe) => {
    expect(routesFor(allPassed)).toContain(route)
    expect(routesFor(withProbe(probe, 'failed'))).not.toContain(route)
    expect(routesFor(withProbe(probe, undefined))).not.toContain(route)
    expect(routesFor(passed('fake', allPassed.probes))).not.toContain(route)
  })

  it.each([
    ['/mail/tools/track-delivery', 'journal'], ['/mail/folders', 'mail'], ['/mail/tools/disk-usage', 'mail'], ['/mail/tools/connect-devices', 'mail'],
    ['/advanced/error-pages', 'files'], ['/advanced/indexes', 'apache'], ['/advanced/mime-types', 'files'], ['/security/hotlink', 'files'], ['/domains/redirects', 'apache'],
  ] as const)('opens the owner page %s only while the %s probe passes', (route, probe) => {
    expect(routesFor(allPassed, owner)).toContain(route)
    expect(routesFor(withProbe(probe, 'failed'), owner)).not.toContain(route)
    expect(routesFor(passed('fake', allPassed.probes), owner)).not.toContain(route)
  })

  it('keeps unimplemented pages and extra tools closed even when every probe passed', () => {
    const qualified = qualifyHostTools(acceptedTools, allPassed)
    for (const id of ['server-software-update', 'distro-packages', 'package-db-rebuild', 'aapanel-third-party-plugin-import', 'xwhm-email-routing', 'mail-troubleshooter',
      'db-root-password', 'db-ownership-map', 'aapanel-system-monitor', 'update-preferences', 'tweak-mail', 'account-repair', 'ip-blocker', 'apache-handlers', 'notification-channels', 'git-version-control', 'email-encryption', 'site-publisher']) {
      expect(qualified.find(tool => tool.id === id)?.status, id).toBe('researched')
    }
    expect(routesFor(allPassed)).not.toContain('/whm/monitoring/performance')
    expect(routesFor(allPassed, owner)).not.toContain('/security/ip-blocker')
    expect(routesFor(allPassed, owner)).not.toContain('/advanced/handlers')
    const dnsReseller: VisibilityContext = { principal: { kind: 'reseller', id: 'reseller', username: 'reseller' }, reseller: { acl: ['manage-dns'] } }
    expect(routesFor(allPassed, dnsReseller)).not.toContain('/whm/email/routing')
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
    for (const id of ['restart-ssh', 'aapanel-boot-items', 'aapanel-supervisor', 'system-reboot', 'service-watchdog']) {
      expect(qualifyHostTools(acceptedTools, allPassed).find(tool => tool.id === id)?.status, id).not.toBe('verified')
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
