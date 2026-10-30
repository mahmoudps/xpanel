import { isToolAuthorized, tools as defaultCatalog, visibleNavigation, visibleTools } from '@xpanel/catalog'
import { resolveResourceUsage, type Domain, type Limit, type Plan } from '@xpanel/core'
import { alternateLocales, type Translate } from '../../../../i18n.ts'
import { auditActionLabel, auditActorLabel, auditTargetLabel } from '../../../../audit-labels.ts'
import { parseWebsiteAnalyticsSnapshot } from '../../../../models/website-analytics.ts'
import type { PanelSurfaceProps, ThemeViewProps } from '../../../contract.ts'
import { card, dataTable, emptyState, errorState, kpiCard, meter, notice, pageHeader, rowMenu, statusPill, type MeterProps } from '../../components/index.ts'
import { escapeHtml, type Tone } from '../../html.ts'
import { icon, type IconName } from '../../icons.ts'
import { v2Messages } from '../../messages.ts'

import type { SurfaceAuthority } from '../../../../models/theme-surface.ts'

export type PanelPageProps = PanelSurfaceProps & ThemeViewProps

/** Read-only callers carry core authority; stored facts never grant provider reads. */
export function scopePrimaryPanelFacts(props: PanelPageProps, authority?: SurfaceAuthority): PanelPageProps {
  const principal = props.visibility?.principal
  const matched = !!props.account && principal?.kind === 'user' && principal.accountId === props.account.id
  if (props.account && authority?.presentation !== 'read-only') return props
  const account = matched && authority?.canReadFacts === true ? props.account : undefined
  const permit = (id: string): boolean => !!account && authority?.authorizedTools.has(id) === true && !!props.visibility && (props.catalog ?? defaultCatalog).some(tool => tool.id === id && isToolAuthorized(tool, props.visibility!))
  return { ...props, account, plan: account && props.plan?.id === account.planId ? props.plan : undefined,
    domains: permit('domains') ? props.domains?.filter(row => row.accountId === account!.id) : undefined,
    serviceUsers: permit('email-accounts') ? props.serviceUsers?.filter(row => row.accountId === account!.id) : undefined,
    databases: permit('mysql-databases') ? props.databases?.filter(row => row.accountId === account!.id) : undefined,
    databaseUsers: permit('mysql-users') ? props.databaseUsers?.filter(row => row.accountId === account!.id) : undefined,
    certificates: permit('ssl-certificates') ? props.certificates?.filter(row => row.accountId === account!.id) : undefined,
    dnsRecords: permit('dns-zone-records') ? props.dnsRecords?.filter(row => props.domains?.some(domain => domain.accountId === account!.id && domain.name === row.zone)) : undefined,
    usage: permit('resource-usage') ? props.usage : undefined,
    websiteAnalytics: permit('bandwidth') ? props.websiteAnalytics : undefined,
    files: permit('file-manager') ? props.files : undefined,
    recentAudit: permit('raw-access') ? props.recentAudit : undefined,
    lastSignInAt: account ? props.lastSignInAt : undefined,
  }
}

/** These pages receive the account that core already admitted for this surface. */
export const selectedPanelPlan = (props: PanelPageProps): Plan | undefined =>
  props.account && props.plan?.id === props.account.planId ? props.plan : undefined

export const panelCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

export function panelBytes(value: number): string {
  if (value < 1024 * 1024 && value > 0) return `${value} B`
  return `${Number((value / (1024 * 1024)).toFixed(2))} MiB`
}

export const panelLimit = (value: Limit | undefined, t: Translate, unit = ''): string =>
  value === 'unlimited' ? t('Unlimited') : typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER
    ? t(msgctxt('resources-board', 'Not read')) : `${value}${unit ? ` ${unit}` : ''}`

export const panelFact = (label: string, value: string, technical = false): string =>
  `<div><dt>${escapeHtml(label)}</dt><dd>${technical ? `<bdi dir="ltr" class="v2-mono">${escapeHtml(value)}</bdi>` : escapeHtml(value)}</dd></div>`

const bytesCap = (value: Limit | undefined): Limit | undefined => typeof value === 'number' ? value * 1024 * 1024 : value

function quantity(t: Translate, label: string, used: number | undefined, limit: Limit | undefined, bytes = false): MeterProps {
  const resolved = resolveResourceUsage(used, limit)
  const usedText = used === undefined ? t('Unavailable') : bytes ? panelBytes(used) : String(used)
  const limitText = typeof limit === 'number' && bytes ? panelBytes(limit) : panelLimit(limit, t)
  const tone: Tone = resolved.kind === 'bounded' ? resolved.threshold === 'critical' ? 'bad' : resolved.threshold
    : resolved.kind === 'zero-limit' && resolved.exceeded ? 'bad' : 'neutral'
  return {
    label, valueText: `${usedText} / ${limitText}`, tone,
    ...(resolved.kind === 'bounded' ? { percent: resolved.fillPercent } : {}),
    ...(resolved.kind === 'zero-limit' ? { note: t(msgctxt('theme:v2', 'Stored limit is 0.')) }
      : used === undefined ? { note: t('Not reported by the agent') } : {}),
  }
}

/** Only observed counts become zero; an unread collection remains unknown. */
export function panelHomeMeters(props: PanelPageProps, t: Translate): MeterProps[] {
  const account = props.account
  const plan = selectedPanelPlan(props)
  const domains = account && props.domains?.filter(domain => domain.accountId === account.id)
  const users = account && props.serviceUsers?.filter(user => user.accountId === account.id)
  const databases = account && props.databases?.filter(database => database.accountId === account.id && database.trashedAt === null)
  return [
    quantity(t, t('Disk'), panelCount(props.usage?.diskBytes), bytesCap(plan?.resources.diskMb), true),
    quantity(t, t('Monthly bandwidth'), panelCount(props.usage?.bandwidthMonth?.totalBytes), bytesCap(plan?.resources.bandwidthMbMonth), true),
    { label: t(msgctxt('theme:v2', 'IO write cap')), valueText: panelLimit(plan?.resources.ioWriteBps, t, 'B/s'),
      note: t(props.usage?.ioEnforced === true ? msgid('Verified for this sample') : props.usage?.ioEnforced === false ? msgid('Observed mismatch') : msgctxt('resources-board', 'Not read')),
      tone: props.usage?.ioEnforced === false ? 'warn' : 'neutral' },
    quantity(t, t('Memory'), panelCount(props.usage?.memoryBytes), bytesCap(plan?.resources.memoryMb), true),
    quantity(t, t('Processes'), panelCount(props.usage?.processCount), plan?.resources.maxProcesses),
    quantity(t, t('Addon domains'), domains?.filter(domain => domain.kind === 'addon').length, plan?.caps.addonDomains),
    quantity(t, t('Mailboxes'), users?.filter(user => user.services.email).length, plan?.caps.mailboxes),
    quantity(t, t('Databases'), databases?.length, plan?.caps.databases),
  ]
}

const domainHref = (route: string, domain: string): string => `${route}?domain=${encodeURIComponent(domain)}`

function sites(props: PanelPageProps, t: Translate, routes: ReadonlySet<string>): string {
  const account = props.account
  const domains = account ? props.domains?.filter(domain => domain.accountId === account.id) : undefined
  const manageDefinition = (props.catalog ?? defaultCatalog).find(tool => tool.id === 'manage-domain')
  const manageAuthorized = !!props.visibility && !!manageDefinition && isToolAuthorized(manageDefinition, props.visibility)
  const siteRows = (domains ?? []).map((domain: Domain, index) => {
    const links = [
      ['/files/manager', t('File manager')], ['/software/php', t('PHP version & handler')],
      ['/security/ssl', t('SSL/TLS')], ['/domains/zone-editor', t('Zone editor')], ['/metrics/traffic', t('Bandwidth')],
    ].filter(([route]) => routes.has(route!)).map(([route, label]) => ({ label: label!, href: domainHref(route!, domain.name) }))
    const storedCertificate = props.certificates?.find(certificate => certificate.id === domain.certificateId && certificate.accountId === account?.id)
    const certificateLabel = t(domain.certificateId === null ? msgctxt('theme:v2', 'No stored certificate')
      : storedCertificate ? msgctxt('theme:v2', 'Stored certificate') : msgctxt('resources-board', 'Not read'))
    const name = routes.has('/domains/site-settings')
      ? `<a class="v2-mono" href="${escapeHtml(domainHref('/domains/site-settings', domain.name))}"><bdi dir="ltr">${escapeHtml(domain.name)}</bdi></a>`
      : `<bdi dir="ltr" class="v2-mono">${escapeHtml(domain.name)}</bdi>`
    const identity = `<div class="v2-home-site"><span class="v2-home-site__mark" aria-hidden="true">${icon('globe', 18)}</span><div class="v2-home-site__text"><span class="v2-home-site__name">${name}<span class="v2-home-site__kind">${escapeHtml(t(domain.kind === 'primary' ? 'Primary' : domain.kind === 'addon' ? 'Addon' : domain.kind === 'alias' ? 'Alias' : 'Subdomain'))}</span></span><bdi dir="ltr" class="v2-home-site__root v2-mono">${escapeHtml(domain.docRoot)}</bdi></div></div>`
    return {
      cellsHtml: [
        identity,
        `<bdi dir="ltr" class="v2-mono">${escapeHtml(`${domain.php.version} · ${domain.php.handler}`)}</bdi>`,
        `<span class="v2-home-site__certificate">${icon('shield', 16)}<span>${escapeHtml(certificateLabel)}</span></span>`,
        statusPill({ tone: domain.suspended ? 'warn' : 'info', label: t(domain.suspended ? msgid('Suspended') : msgctxt('theme:v2', 'Saved active configuration')) }),
      ],
      actionsHtml: (placement: 'table' | 'card'): string =>
        `${routes.has('/domains/site-settings') ? `<a class="v2-btn" href="${escapeHtml(domainHref('/domains/site-settings', domain.name))}" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Manage {domain}'), { domain: domain.name }))}">${escapeHtml(t('Manage'))}</a>` : manageAuthorized ? `<button type="button" class="v2-btn" disabled aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Manage {domain}'), { domain: domain.name }))}">${escapeHtml(t('Manage'))}</button>` : ''}${links.length ? rowMenu({ id: `v2-home-site-${placement}-${index}`, label: t(msgctxt('theme:v2', 'More actions for {domain}'), { domain: domain.name }), items: links }) : ''}`,
    }
  })
  const rows = siteRows.map(row => ({ cellsHtml: row.cellsHtml, actionsHtml: row.actionsHtml('table') }))
  const mobile = domains === undefined ? errorState(t, { lead: t(msgctxt('theme:v2', 'The account domain list was not read.')) })
    : siteRows.length === 0 ? emptyState({ icon: 'globe', title: t(msgctxt('theme:v2', 'No domains.')) })
      : `<ul class="v2-home-site-cards">${siteRows.map(row => `<li class="v2-home-site-card"><div class="v2-home-site-card__head">${row.cellsHtml[0]}</div><dl class="v2-home-site-card__facts"><div><dt>${escapeHtml(t(msgid('Status')))}</dt><dd>${row.cellsHtml[3]}</dd></div><div><dt>${escapeHtml(t('PHP'))}</dt><dd>${row.cellsHtml[1]}</dd></div><div><dt>${escapeHtml(t(msgid('Certificate')))}</dt><dd>${row.cellsHtml[2]}</dd></div></dl>${row.actionsHtml('card') ? `<div class="v2-home-site-card__actions">${row.actionsHtml('card')}</div>` : ''}</li>`).join('')}</ul>`
  return card({ title: t(msgctxt('theme:v2', 'Your sites')), titleId: 'v2-home-sites-title', flush: true,
    hooks: { 'data-home-sites': true },
    description: t(msgctxt('theme:v2', 'Saved site configuration. Serving status and TLS are verified separately.')),
    ...(routes.has('/domains') ? { actionsHtml: `<a class="v2-btn" href="/domains">${icon('plus', 16)}${escapeHtml(t(msgctxt('theme:v2', 'Manage domains')))}</a>` } : {}),
    bodyHtml: `<div class="v2-home-sites-desktop">${dataTable(t, { id: 'v2-home-sites', caption: t(msgctxt('theme:v2', 'Your sites')),
      columns: [{ label: t(msgid('Site')) }, { label: t('PHP') }, { label: t(msgid('Certificate')) }, { label: t(msgid('Status')) }],
      rows, actions: true,
      state: domains === undefined ? 'error' : rows.length ? 'ready' : 'empty',
      error: { lead: t(msgctxt('theme:v2', 'The account domain list was not read.')) }, emptyText: t(msgctxt('theme:v2', 'No domains.')),
    })}</div><div class="v2-home-sites-mobile">${mobile}</div>`,
  })
}

interface HomeTool {
  label: string
  route: string
  icon: IconName
  capability: string
  hint?: string
  keywords: string
}

interface HomeToolGroup { label: string; icon: IconName; tone?: Tone; tools: readonly HomeTool[] }

const homeTool = (label: string, route: string, iconName: IconName, capability: string, keywords: string, hint?: string): HomeTool =>
  ({ label, route, icon: iconName, capability, keywords, ...(hint ? { hint } : {}) })

/** Presentation aliases may share a workspace; catalog policy still owns each capability's visibility. */
export const PANEL_HOME_TOOL_GROUPS: readonly HomeToolGroup[] = [
  { label: msgid('Files'), icon: 'folder', tools: [
    homeTool(msgid('File manager'), '/files/manager', 'folder', 'file-manager', 'upload edit permissions chmod', 'home'),
    homeTool(msgctxt('xpanel-home', 'Backup wizard'), '/files/backup', 'archive', 'backup', 'restore archive download'),
    homeTool(msgid('FTP & Web Disk users'), '/files/ftp', 'users', 'ftp-accounts', 'ftp webdisk sftp', 'ftp'),
    homeTool(msgid('Disk usage'), '/resources', 'disk', 'disk-usage', 'quota space', 'disk'),
    homeTool(msgctxt('xpanel-home', 'Trash'), '/files/trash', 'files', 'file-trash', 'deleted recycle restore'),
  ] },
  { label: msgid('Databases'), icon: 'database', tools: [
    homeTool(msgctxt('xpanel-home', 'MariaDB databases'), '/databases/mariadb', 'database', 'mysql-databases', 'mysql sql', 'databases'),
    homeTool(msgid('Database users'), '/databases/mariadb', 'user', 'mysql-users', 'mysql privileges grant', 'databaseUsers'),
    homeTool(msgid('Database trash'), '/databases/mariadb', 'files', 'mysql-databases', 'drop restore deleted', 'databaseTrash'),
  ] },
  { label: msgid('Domains'), icon: 'globe', tools: [
    homeTool(msgid('Domains'), '/domains', 'globe', 'domains', 'addon alias subdomain wildcard rename', 'domains'),
    homeTool(msgid('Site settings'), '/domains/site-settings', 'sliders', 'manage-domain', 'document root static proxy node python suspend', 'sites'),
    homeTool(msgid('Zone editor'), '/domains/zone-editor', 'layers', 'dns-zone-records', 'dns records mx txt cname', 'zones'),
    homeTool(msgctxt('xpanel-home', 'Redirects'), '/domains/redirects', 'arrow', 'redirects', 'redirect 301 302 rewrite', 'redirects'),
  ] },
  { label: msgctxt('xpanel-home', 'Email'), icon: 'mail', tools: [
    homeTool(msgid('Email accounts'), '/email/accounts', 'mail', 'email-accounts', 'mailbox imap smtp quota', 'mailboxes'),
    homeTool(msgid('Forwarders'), '/email/forwarders', 'arrow', 'forwarders', 'forward alias'),
    homeTool(msgid('Filters'), '/email/filters', 'filter', 'email-filters', 'spam rules sieve'),
    homeTool(msgid('xMail webmail'), '/email/accounts', 'inbox', 'email-accounts', 'webmail inbox read compose'),
  ] },
  { label: msgid('Metrics'), icon: 'activity', tone: 'ok', tools: [
    homeTool(msgid('Visitors'), '/metrics/traffic', 'users', 'visitors', 'stats traffic analytics', 'visitors'),
    homeTool(msgid('Errors'), '/metrics/traffic', 'alert', 'errors', '404 500 status codes'),
    homeTool(msgctxt('xpanel-home', 'Bandwidth'), '/metrics/traffic', 'activity', 'bandwidth', 'traffic transfer', 'bandwidth'),
    homeTool(msgid('Raw access logs'), '/metrics/logs', 'download', 'raw-access', 'nginx log download'),
  ] },
  { label: msgid('Security'), icon: 'shield', tone: 'warn', tools: [
    homeTool(msgid('SSL/TLS'), '/security/ssl', 'shield', 'ssl-certificates', 'https certificate autossl wildcard tls'),
    homeTool(msgctxt('xpanel-home', 'Two-factor authentication'), '/security/account', 'shield', 'two-factor-auth', '2fa totp otp'),
    homeTool(msgid('API tokens'), '/security/account', 'code', 'api-tokens', 'api token automation'),
    homeTool(msgid('Path protection'), '/files/directory-privacy', 'shield', 'directory-privacy', 'directory privacy password folder'),
  ] },
  { label: msgid('Software'), icon: 'code', tools: [
    homeTool(msgid('PHP version & handler'), '/software/php', 'code', 'domain-php-settings', 'php fpm cgi workers version', 'php'),
    homeTool(msgid('PHP settings'), '/software/php', 'sliders', 'domain-php-settings', 'php ini memory_limit extensions'),
    homeTool(msgctxt('xpanel-home', '.htaccess editor'), '/software/htaccess', 'files', 'aapanel-url-rewrite', 'htaccess rewrite apache'),
    homeTool(msgid('Node.js & Python apps'), '/software/apps', 'code', 'nodejs-apps', 'node python app proxy'),
  ] },
  { label: msgid('Advanced'), icon: 'calendar', tools: [
    homeTool(msgid('Cron jobs'), '/advanced/cron', 'calendar', 'cron-jobs', 'cron schedule timer'),
    homeTool(msgid('Resources & quotas'), '/resources', 'activity', 'resource-usage', 'limits io memory slice cgroup'),
    homeTool(msgid('Processes'), '/resources', 'cpu', 'resource-usage', 'process pid kill tasks', 'processes'),
    homeTool(msgid('Site logs'), '/metrics/logs', 'files', 'raw-access', 'error log apache nginx'),
  ] },
  { label: msgid('Preferences'), icon: 'gear', tools: [
    homeTool(msgid('Language'), '/preferences/language', 'language', 'change-language', 'arabic locale language'),
    homeTool(msgid('Password'), '/security/account', 'shield', 'password-security', 'password change sign-in'),
    homeTool(msgid('Contact email'), '/security/account', 'mail', 'password-security', 'notifications contact email'),
  ] },
]

function tools(props: PanelPageProps, t: Translate, visitors: number | undefined): string {
  const catalog = props.catalog ?? defaultCatalog
  const context = props.visibility
  const qualified = new Set(context ? visibleTools(catalog, context).map(tool => tool.id) : [])
  const routes = new Set(visibleNavigation(context, catalog).find(surface => surface.surface === 'xpanel')?.sections.flatMap(section => section.pages.map(page => page.route)))
  const definitions = new Map(catalog.map(tool => [tool.id, tool]))
  const groups = PANEL_HOME_TOOL_GROUPS.map(group => ({ ...group, tools: group.tools.filter(item => {
    const definition = definitions.get(item.capability)
    return context && definition && isToolAuthorized(definition, context)
  }) })).filter(group => group.tools.length)
  const total = groups.reduce((sum, group) => sum + group.tools.length, 0)
  const count = t(msgctxt('theme:v2', '{count, plural, one {# tool} other {# tools}} in {groups, plural, one {# group} other {# groups}}'), { count: total, groups: groups.length })
  const meters = panelHomeMeters(props, t)
  const account = props.account
  const domains = account ? props.domains?.filter(domain => domain.accountId === account.id) : undefined
  const users = account ? props.serviceUsers?.filter(user => user.accountId === account.id) : undefined
  const databases = account ? props.databases?.filter(database => database.accountId === account.id) : undefined
  const hints: Readonly<Record<string, string | undefined>> = {
    home: account?.home, disk: meters[0]!.valueText, bandwidth: meters[1]!.valueText,
    ftp: users ? String(users.filter(user => user.services.ftp).length) : undefined,
    databases: databases ? String(databases.filter(database => database.engine === 'mariadb' && database.trashedAt === null).length) : undefined,
    databaseTrash: databases ? String(databases.filter(database => database.trashedAt !== null).length) : undefined,
    databaseUsers: props.databaseUsers ? String(props.databaseUsers.length) : undefined,
    domains: meters[5]!.valueText, sites: domains ? String(domains.length) : undefined,
    zones: props.dnsRecords && domains ? String(new Set(props.dnsRecords.filter(record => domains.some(domain => domain.name === record.zone)).map(record => record.zone)).size) : undefined,
    redirects: domains ? String(domains.filter(domain => domain.redirect !== null).length) : undefined,
    mailboxes: meters[6]!.valueText, visitors: visitors === undefined ? undefined : String(visitors),
    php: props.usage?.phpVersion ?? undefined, processes: meters[4]!.valueText,
  }
  const body = groups.map((group, index) => {
    const label = t(group.label)
    const rest = t('{count, plural, one {# tool} other {# tools}}', { count: group.tools.length })
    return `<details class="v2-home-tool-group" open data-home-accordion data-home-collapse-below="600" data-tool-group data-group-label="${escapeHtml(label)}" data-size="${group.tools.length}" aria-labelledby="v2-home-tools-${index}"><summary class="v2-home-tool-heading"><h3 id="v2-home-tools-${index}"><span class="v2-home-group-tile v2-tile v2-tile--${group.tone ?? 'info'}" aria-hidden="true">${icon(group.icon, 16)}</span><span class="v2-home-group-label">${escapeHtml(label)}</span><span class="v2-muted v2-num" data-group-count data-rest="${escapeHtml(rest)}">${escapeHtml(rest)}</span>${icon('chevDown', 16)}</h3></summary><div class="v2-home-tool-grid" data-tool-panel>${group.tools.map(item => {
      const name = t(item.label)
      const enabled = qualified.has(item.capability) && (routes.has(item.route) || item.capability === 'change-language')
      const hint = enabled ? (item.hint ? hints[item.hint] : undefined) ?? t(msgctxt('resources-board', 'Not read')) : t('Unavailable')
      const href = item.capability === 'change-language' ? `?lang=${alternateLocales(t.locale)[0]!.tag}` : item.route
      const technicalHint = enabled && item.hint !== undefined && hints[item.hint] !== undefined
      const content = `<span class="v2-home-tool__tile v2-tile v2-tile--${enabled ? group.tone ?? 'info' : 'neutral'}" aria-hidden="true">${icon(item.icon, 16)}</span><span class="v2-home-tool__label">${escapeHtml(name)}</span><span class="v2-home-tool__hint v2-num">${technicalHint ? `<bdi dir="ltr" class="v2-mono">${escapeHtml(hint)}</bdi>` : escapeHtml(hint)}</span>`
      const attrs = ` data-tool data-tool-capability="${escapeHtml(item.capability)}" data-tool-keys="${escapeHtml([name, item.keywords].join(' '))}"`
      return enabled ? `<a class="v2-home-tool" href="${escapeHtml(href)}"${attrs}>${content}</a>`
        : `<button type="button" class="v2-home-tool" disabled${attrs}>${content}</button>`
    }).join('')}</div></details>`
  }).join('')
  return `<section class="v2-home-tools" data-home-tools aria-labelledby="v2-home-tools-title"><header class="v2-home-tools__head"><div class="v2-home-tools__title"><h2 id="v2-home-tools-title">${escapeHtml(t('Tools'))}</h2><p class="v2-muted v2-num" id="tool-filter-count" role="status" data-rest="${escapeHtml(count)}">${escapeHtml(count)}</p></div><div class="v2-field v2-home-tool-filter"><label for="tool-filter">${escapeHtml(t('Find a tool'))}</label><span class="v2-home-tool-search">${icon('search', 18)}<input type="search" id="tool-filter" dir="auto" autocomplete="off" placeholder="${escapeHtml(t(msgctxt('theme:v2', 'Search tools')))}" data-home-filter aria-controls="v2-home-tool-list" aria-describedby="tool-filter-count"></span></div></header><div id="v2-home-tool-list" class="v2-home-tool-list" data-tool-section>${body || emptyState({ icon: 'tools', title: t(msgctxt('theme:v2', 'No tools are available for this account.')) })}</div><div class="v2-home-filter-empty" data-tool-empty hidden><h3 data-home-empty-title>${escapeHtml(t(msgctxt('theme:v2', 'No matching tools.')))}</h3><p>${escapeHtml(t('Clear the field or try a shorter word, such as “mail”.'))}</p><button type="button" class="v2-btn" data-home-filter-clear>${escapeHtml(t(msgctxt('theme:v2', 'Clear filter')))}</button></div></section>`
}

function information(props: PanelPageProps, t: Translate): string {
  const account = props.account
  const plan = selectedPanelPlan(props)
  return card({ title: t('General information'), titleId: 'v2-home-information-title', bodyHtml:
    `<dl class="v2-panel-facts">${[
      panelFact(t('Username'), account?.username ?? t('Not read'), true), panelFact(t('Primary domain'), account?.primaryDomain ?? t('Not read'), true),
      panelFact(t('Home directory'), account?.home ?? t('Not read'), true), panelFact(t('Shared IP'), account?.ipv4 ?? t('Not read'), true),
      panelFact(t('Plan'), plan?.name ?? t(msgctxt('resources-board', 'Not read'))),
      panelFact(t('Default PHP'), props.usage?.phpVersion ?? t('Not reported by the agent'), true),
      panelFact(t('Isolation slice'), account ? `xpanel-${account.uid}.slice` : t('Not read'), true),
      panelFact(t('Last sign-in'), props.lastSignInAt && Number.isFinite(Date.parse(props.lastSignInAt)) ? new Date(props.lastSignInAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : t('Not reported by the agent'), true),
    ].join('')}</dl>`,
  })
}

function recentChanges(props: PanelPageProps, t: Translate): string {
  const events = props.recentAudit
  return card({ title: t('Recent changes'), titleId: 'v2-home-changes-title', bodyHtml:
    events === undefined ? `<p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'Recent account changes were not read.')))}</p>`
      : events.length ? `<ol class="v2-home-changes">${events.slice(0, 8).map(event => {
        const target = auditTargetLabel(event.target, t.locale)
        const actor = event.actor ? auditActorLabel(event.actor) : ''
        return `<li>${icon('activity', 18)}<div><h3>${escapeHtml(auditActionLabel(event.action, t.locale, event))}</h3>${target ? `<p><bdi dir="ltr">${escapeHtml(target)}</bdi></p>` : ''}${actor ? `<p class="v2-muted">${escapeHtml(t('Actor'))}: <bdi dir="ltr">${escapeHtml(actor)}</bdi></p>` : ''}</div></li>`
      }).join('')}</ol>`
        : `<p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'No recent changes.')))}</p>`,
  })
}

/** Inner page only: the surface adapter supplies navigation and document-level controllers. */
export function renderV2PanelHome(props: PanelPageProps, authority?: SurfaceAuthority): string {
  const t = v2Messages.translator(props.locale ?? 'en')
  props = scopePrimaryPanelFacts(props, authority)
  const account = props.account
  const domain = account ? props.domains?.find(item => item.accountId === account.id && item.name === props.activeDomain)?.name ?? account.primaryDomain : t('Not read')
  const routes = new Set(visibleNavigation(props.visibility, props.catalog).find(surface => surface.surface === 'xpanel')?.sections.flatMap(section => section.pages.map(page => page.route)))
  const domainsDefinition = (props.catalog ?? defaultCatalog).find(tool => tool.id === 'domains')
  const domainsAuthorized = !!props.visibility && !!domainsDefinition && isToolAuthorized(domainsDefinition, props.visibility)
  const meters = panelHomeMeters(props, t)
  const domains = account ? props.domains?.filter(item => item.accountId === account.id) : undefined
  const traffic = !account || props.websiteAnalyticsUnavailable === true ? null
    : parseWebsiteAnalyticsSnapshot(props.websiteAnalytics, { accountId: account.id, domain })
  const summary = [
    { label: t('Domains'), value: domains === undefined ? '—' : String(domains.length), icon: 'globe' as const,
      note: meters[5]!.valueText },
    { label: t('Disk'), value: panelCount(props.usage?.diskBytes) === undefined ? '—' : panelBytes(props.usage!.diskBytes!), icon: 'disk' as const,
      note: meters[0]!.valueText, ...(meters[0]!.percent === undefined ? {} : { meter: { percent: meters[0]!.percent!, tone: meters[0]!.tone } }) },
    { label: t('Bandwidth'), value: panelCount(props.usage?.bandwidthMonth?.totalBytes) === undefined ? '—' : panelBytes(props.usage!.bandwidthMonth!.totalBytes!), icon: 'activity' as const,
      note: meters[1]!.valueText, ...(meters[1]!.percent === undefined ? {} : { meter: { percent: meters[1]!.percent!, tone: meters[1]!.tone } }) },
    { label: t('Visitors'), value: traffic ? String(traffic.totals.uniqueVisitors) : '—', icon: 'users' as const,
      note: traffic ? `${props.websiteAnalyticsWindow ?? t(msgctxt('theme:v2', 'Traffic window not reported'))} · ${traffic.domain}`
        : t(msgctxt('theme:v2', 'A validated account traffic observation is required.')) },
  ]
  const bandwidthNotice = props.usage?.bandwidthMonth?.limited === true
    ? notice(t, { tone: 'warn', lead: t('Limit page served'), text: t(msgctxt('theme:v2', 'The account is over its enforced monthly bandwidth limit.')),
      ...(routes.has('/resources') ? { action: { label: t('Resources & quotas'), href: '/resources' } } : {}) }) : ''
  const resourceCard = card({
    title: t('Resource usage'), titleId: 'v2-home-resources-title', bodyHtml: meters.map(item => meter(item)).join(''),
    ...(routes.has('/resources') ? { footerHtml: `<a href="/resources">${escapeHtml(t('Resources & quotas'))}${icon('arrow', 16)}</a>` } : {}),
  })
  return `<div class="v2-layout v2-panel-home" data-panel-home ${account ? `data-account="${escapeHtml(account.id)}" data-uid="${account.uid}"` : ''}>
${pageHeader(t, { breadcrumb: [{ label: t('Home') }], route: '/home', title: t(msgctxt('theme:v2', 'Welcome back, {username}'), { username: account?.username ?? t('Not read') }),
    description: t(msgctxt('theme:v2', 'Your sites, tools and account resources.')),
    actionsHtml: `<div class="v2-home-page-actions"><p class="v2-home-selected-domain"><span>${escapeHtml(t('Selected domain'))}</span><bdi dir="ltr" class="v2-mono">${escapeHtml(domain)}</bdi></p>${routes.has('/domains') ? `<a class="v2-btn v2-btn--primary" href="/domains">${icon('plus', 18)}${escapeHtml(t(msgid('Add domain')))}</a>` : domainsAuthorized ? `<button type="button" class="v2-btn" disabled>${icon('plus', 18)}${escapeHtml(t(msgid('Add domain')))}</button>` : ''}</div>` })}
${bandwidthNotice}<section class="v2-kpi-row" aria-label="${escapeHtml(t('Account summary'))}">${summary.map(item => kpiCard({ headingLevel: 2, ...item })).join('')}</section>
${sites(props, t, routes)}<div class="v2-home-columns">${tools(props, t, traffic?.totals.uniqueVisitors)}<aside class="v2-stack" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Account information')))}">${resourceCard}${information(props, t)}${recentChanges(props, t)}</aside></div>
</div>`
}

export const V2_PANEL_HOME_CSS = `.v2-panel-home .v2-home-columns{display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:flex-start}
.v2-panel-home .v2-home-page-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-panel-home .v2-home-columns>.v2-home-tools{flex:1.75 1 560px;min-inline-size:0}
.v2-panel-home .v2-home-columns>aside{flex:1 1 300px;min-inline-size:0;gap:var(--space-3)}
.v2-panel-home .v2-home-site{display:flex;align-items:center;gap:12px;min-inline-size:0}
.v2-panel-home .v2-home-site__mark{display:flex;align-items:center;justify-content:center;flex:none;inline-size:34px;block-size:34px;border-radius:9px;background:var(--accent-soft);color:var(--accent)}
.v2-panel-home .v2-home-site__text{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-panel-home .v2-home-site__name{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1);font-size:13px;font-weight:600}
.v2-panel-home .v2-home-site__name>a{text-decoration:none}
.v2-panel-home .v2-home-site__kind{padding:1px var(--space-1);border-radius:var(--radius-pill);background:var(--sunken);color:var(--text-2);font-family:var(--font-sans);font-size:11px;font-weight:600}
.v2-panel-home .v2-home-site__root{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.v2-panel-home .v2-home-site__certificate{display:inline-flex;align-items:center;gap:var(--space-1);font-size:13px}
.v2-home-sites-mobile{display:none}.v2-home-site-cards{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--space-2)}
.v2-home-site-card{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--v2-panel-padding);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-card);box-shadow:var(--shadow)}
.v2-home-site-card__head{min-inline-size:0;overflow-wrap:anywhere}
.v2-home-site-card__facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);padding-block-start:var(--space-2);border-block-start:1px solid var(--line)}
.v2-home-site-card__facts>div{display:flex;flex-direction:column;align-items:stretch;gap:var(--space-1);min-inline-size:0;text-align:start}.v2-home-site-card__facts>div:last-child{grid-column:1/-1}
.v2-home-site-card__facts dt{font-size:12px;color:var(--muted)}.v2-home-site-card__facts dd{font-size:13px;overflow-wrap:anywhere;text-align:start}
.v2-home-site-card__actions{display:flex;align-items:center;gap:var(--space-1)}.v2-home-site-card__actions>.v2-btn{flex:1}
.v2-panel-home .v2-home-tools{display:flex;flex-direction:column;gap:var(--space-2)}
.v2-panel-home .v2-home-tools__head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:var(--space-2)}
.v2-panel-home .v2-home-tools__title{display:flex;flex-direction:column;gap:var(--space-1)}
.v2-panel-home .v2-home-tools__title>p{font-size:13px}
.v2-panel-home .v2-home-tool-filter{flex:0 1 360px;min-inline-size:min(240px,100%)}
.v2-panel-home .v2-home-tool-search{display:block;position:relative}
.v2-panel-home .v2-home-tool-search>.v2-icon{position:absolute;inset-inline-start:14px;top:13px;color:var(--muted);pointer-events:none}
.v2-panel-home .v2-home-tool-search>input{inline-size:100%;padding-inline-start:42px;padding-inline-end:12px;text-align:start}
.v2-panel-home .v2-home-tool-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3);align-items:start;min-inline-size:0}
.v2-panel-home .v2-home-tool-group{display:block;min-inline-size:0;padding:var(--v2-panel-padding);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);box-shadow:var(--shadow)}
.v2-home-tool-heading{display:flex;align-items:center;justify-content:space-between;gap:var(--space-1)}
.v2-home-tool-heading{list-style:none;min-block-size:var(--target);cursor:pointer}.v2-home-tool-heading::-webkit-details-marker{display:none}
.v2-home-tool-heading h3{flex:1;display:flex;align-items:center;gap:var(--space-1)}.v2-home-group-label{flex:1}
.v2-home-tool-heading h3>.v2-icon{display:none;color:var(--muted);transition:transform .15s}.v2-home-tool-group[open]>.v2-home-tool-heading>h3>.v2-icon{transform:rotate(180deg)}
.v2-home-group-tile{display:none}
.v2-home-tool-heading h3>.v2-muted{font-size:12px;font-weight:400}
.v2-panel-home .v2-home-tool-grid{display:flex;flex-direction:column;gap:var(--space-1);margin-block-start:var(--space-3)}
.v2-panel-home .v2-home-tool{display:flex;align-items:center;gap:12px;inline-size:100%;min-block-size:44px;padding:var(--space-1) 0;border:1px solid transparent;border-radius:var(--radius-control);background:transparent;text-align:start;text-decoration:none;color:var(--text);font-size:14px}
.v2-home-tool:hover{background:var(--subtle);border-color:var(--line)}
.v2-panel-home .v2-home-tool__tile{inline-size:30px;block-size:30px;border-radius:8px}
.v2-panel-home .v2-home-tool__label{flex:1;min-inline-size:0;font-weight:500;overflow-wrap:anywhere}
.v2-panel-home .v2-home-tool__hint{flex:0 1 auto;max-inline-size:45%;font-size:12px;font-weight:400;color:var(--muted);overflow-wrap:anywhere}
.v2-home-tool:disabled{cursor:not-allowed}
.v2-panel-home .v2-meter__row{flex-direction:column;align-items:stretch;gap:var(--space-1)}
.v2-panel-home .v2-meter__value{align-self:stretch;justify-content:flex-start;flex-wrap:wrap;min-inline-size:0;white-space:normal;overflow-wrap:anywhere;text-align:start}
.v2-panel-home .v2-meter__value>span{min-inline-size:0}
.v2-panel-facts{display:grid;gap:var(--space-2);min-inline-size:0}
.v2-panel-facts>div,.v2-home-selected-domain{display:flex;flex-direction:column;align-items:stretch;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-panel-facts dt{font-size:12px;color:var(--muted)}.v2-panel-facts dd{font-size:13px;min-inline-size:0;overflow-wrap:anywhere;text-align:start}
.v2-panel-facts bdi{display:inline;unicode-bidi:isolate}.v2-home-selected-domain>span{font-size:12px;color:var(--muted)}
.v2-home-changes{display:flex;flex-direction:column;gap:var(--space-3);list-style:none;margin:0;padding:0}
.v2-home-changes>li{display:flex;align-items:flex-start;gap:12px}.v2-home-changes>li>.v2-icon{margin-block-start:2px;color:var(--muted)}
.v2-home-changes>li>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;overflow-wrap:anywhere}
.v2-home-changes p{font-size:12px}.v2-home-filter-empty{display:flex;flex-direction:column;gap:var(--space-1);padding:var(--v2-panel-padding);border:1px dashed var(--line-strong);border-radius:var(--radius-card)}
@media(max-width:600px){.v2-home-sites-desktop{display:none}.v2-home-sites-mobile{display:block}.v2-panel-home [data-home-sites]{padding:0;background:transparent;border:0;box-shadow:none}
.v2-panel-home [data-home-sites]>.v2-card__head{padding:0;margin-block-end:var(--space-2)}
.v2-card[aria-labelledby=v2-home-resources-title]>.v2-card__body{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-panel-home .v2-home-tool-list{grid-template-columns:minmax(0,1fr);gap:var(--space-2)}.v2-panel-home .v2-home-tool-group{overflow:hidden}
.v2-home-tool-heading{min-block-size:44px;gap:12px}.v2-home-tool-heading h3{font-size:15px}.v2-home-group-tile{display:flex;inline-size:30px;block-size:30px}
.v2-home-tool-heading h3>.v2-icon{display:block}.v2-panel-home .v2-home-tool-grid{margin-block-start:var(--space-2)}.v2-home-tool{min-block-size:56px}.v2-home-columns>aside{display:flex}
.v2-panel-home .v2-home-tool-filter{flex-basis:100%;min-inline-size:0}.v2-panel-home .v2-home-tool__hint{max-inline-size:45%}}
`
