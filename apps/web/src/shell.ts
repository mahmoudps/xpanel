import { renderPlannedNavigation, renderUserMenu, surfaceContextHref, type PanelId, type UserMenuModel } from './chrome.ts'
import { SOURCE_LOCALE, alternateLocales, catalogText, localeInfo, translator, type Locale } from './i18n.ts'
import { escapeHtml, normalizeAsciiDigits, renderStatusBadge } from './tokens.ts'

type SurfaceKind = SurfaceShellProps['surface']
type LocalizedTitle = string

const surfacePageTitles: Record<SurfaceKind, Readonly<Record<string, LocalizedTitle>>> = {
  xpanel: {
    overview: msgid('Home'), resources: msgid('Resources & quotas'),
    domains: msgid('Domains'), config: msgid('Site settings'),
    analytics: msgctxt('shell', 'Metrics'), files: msgid('File manager'),
    terminal: msgid('Terminal'), databases: 'MariaDB',
    users: msgid('Email and service users'), dns: msgid('Zone editor'),
    ssl: 'SSL/TLS', security: msgid('Account security'),
  },
  xwhm: {
    overview: msgid('Server dashboard'), io: msgid('Disk I/O'),
    services: msgid('Services'), accounts: msgid('Accounts'),
    dns: msgid('DNS zones'), backups: msgid('Account backups'),
    'server-info': msgid('Server information'),
    'create-account': msgid('Create account'), plans: msgid('Plans'),
    resellers: msgid('Resellers'), ips: msgid('IP addresses'),
    'mail-ips': msgid('Outbound mail routing'), firewall: msgctxt('shell', 'Firewall'),
    audit: msgid('Audit log'), generations: msgid('Configuration history'),
    upgrade: msgid('Upgrade'), transfer: msgid('Transfer tool'),
    security: msgid('Sign-in security'),
  },
  xmail: {
    inbox: msgctxt('shell', 'Inbox'), compose: msgid('Compose message'),
    filters: msgid('Mail filters'), autoresponder: msgid('Auto-responder'),
    identities: msgid('Identities & signatures'),
    overview: msgid('Mail overview'),
    security: msgid('Mail security'),
  },
}

const routePageTitles: Readonly<Record<string, LocalizedTitle>> = {
  '/files/trash': msgctxt('shell', 'Trash'), '/files/ftp': msgid('FTP accounts'),
  '/security/ssl/issue': msgid('Issue certificate'),
  '/whm/plans/features': msgid('Feature lists'),
  '/whm/preferences': msgid('My preferences'),
  '/whm/backups': msgid('Server backups'),
  '/whm/resellers/privileges': msgid('Reseller privileges'),
  '/mail/folders': msgid('Folders'),
  '/mail/search': msgid('Search mail'),
  '/mail/calendar': msgid('Calendar'),
  '/mail/settings/calendars': msgid('Calendars and events'),
  '/mail/tools/disk-usage': msgctxt('shell', 'Disk usage'),
  '/mail/tools/connect-devices': msgid('Connect devices'),
  '/mail/tools/track-delivery': msgid('Track delivery'),
  '/mail/settings/forwarders': msgctxt('shell', 'Forwarders'),
  '/mail/settings/preferences': msgid('Preferences'),
}

export const hasRoutePageTitle = (activeRoute: string): boolean => Object.hasOwn(routePageTitles, activeRoute)

export const getSurfacePageTitle = (surface: SurfaceKind, section: string | undefined, locale: Locale, activeRoute: string): string => {
  const title = routePageTitles[activeRoute] ?? surfacePageTitles[surface][section ?? ''] ?? msgid('Page unavailable')
  return translator(locale)(title)
}

export const getSurfaceNavigationLabel = (surface: SurfaceKind, kind: 'section' | 'page', item: { id: string; name: string }, locale: Locale): string =>
  catalogText(locale, `nav.${kind}.${surface}.${item.id}.name`, item.name)

export const normalizeSurfaceRoute = (surface: SurfaceKind, activeRoute: string): string =>
  surface === 'xpanel' && activeRoute === '/panel' ? '/home' : surface === 'xmail' && activeRoute === '/mail' ? '/mail/inbox' : activeRoute

export const renderPageSearchButton = (locale: Locale): string => {
  const label = translator(locale)(msgctxt('shell', 'Find a page'))
  const font = localeInfo(locale).script === 'Arab' ? 'sans-serif' : "'IBM Plex Sans', sans-serif"
  return `<button type="button" class="xp-btn xp-page-search" style="font-family: ${font}" data-action="open-cmdk" aria-keyshortcuts="Control+K Meta+K" aria-label="${label} Ctrl K" title="${label} (Ctrl K)">
    <svg class="xp-page-search__icon" aria-hidden="true" focusable="false" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4 4" /></svg>
    <span class="xp-page-search__label">${label}</span><kbd class="xp-mono">Ctrl K</kbd>
  </button>`
}

export const renderLiveUpdatesIndicator = (locale: Locale, realtimeEnabled: boolean): string => {
  const label = realtimeEnabled
    ? (translator(locale)('Connecting'))
    : (translator(locale)('Live updates unavailable'))
  const visibleLabel = realtimeEnabled ? label : (translator(locale)('Live off'))
  const description = realtimeEnabled ? '' : ` aria-label="${label}" title="${label}"`
  return `<span data-ws-indicator="${realtimeEnabled ? 'disconnected' : 'unavailable'}" role="status"${description}>${renderStatusBadge('suspended', visibleLabel)}</span>`
}

export interface SurfaceToolbarProps extends UserMenuModel {
  realtimeEnabled?: boolean
  generationId?: number
  version?: string
}

/** Shared account tools retain their actions while leaving room for the page search. */
export const renderSurfaceToolbarEnd = (props: SurfaceToolbarProps): string => {
  const languageLinks = alternateLocales(props.locale ?? SOURCE_LOCALE).map(info => `<a href="${escapeHtml(surfaceContextHref(props, { locale: info.tag }))}" class="xp-btn xp-btn--quiet xp-toolbar-language" lang="${info.tag}" data-lang-switch="${info.tag}">${escapeHtml(info.nativeName)}</a>`).join('')
  const generation = Number.isSafeInteger(props.generationId) && props.generationId! > 0
    ? `<span data-generation-chip="${props.generationId}">${renderStatusBadge('ok', translator(props.locale ?? SOURCE_LOCALE)('Generation {generationId}', { generationId: props.generationId! }))}</span>` : ''
  const version = props.version ? `<span class="xp-toolbar-version xp-mono"><bdi dir="ltr">${escapeHtml(normalizeAsciiDigits(props.version))}</bdi></span>` : ''
  return `<div class="xp-topbar__end">${renderLiveUpdatesIndicator(props.locale, props.realtimeEnabled === true)}${generation}${version}${languageLinks}${renderUserMenu(props)}</div>`
}

export const renderSurfaceToolbar = (props: SurfaceToolbarProps & { leadingHtml?: string }): string =>
  `<div class="xp-topbar__start">${renderPageSearchButton(props.locale)}${props.leadingHtml ?? ''}</div>${renderSurfaceToolbarEnd(props)}`

const surfaceSections: Record<SurfaceShellProps['surface'], Readonly<Record<string, string>>> = {
  xpanel: {
    '/home': 'overview', '/panel': 'overview', '/resources': 'resources',
    '/domains': 'domains', '/domains/site-settings': 'config',
    '/metrics/traffic': 'analytics', '/metrics/web-stats': 'analytics',
    '/files/manager': 'files', '/files/trash': 'files', '/advanced/terminal': 'terminal',
    '/databases/mariadb': 'databases', '/email/accounts': 'users', '/files/ftp': 'users',
    '/security/ssl': 'ssl', '/security/ssl/issue': 'ssl',
    '/security/account': 'security',
    '/domains/zone-editor': 'dns',
    '/files/backup': 'design', '/files/directory-privacy': 'design',
    '/software/php': 'design', '/software/htaccess': 'design', '/advanced/cron': 'design',
    '/design/system': 'design', '/design/components': 'design', '/design/navigation': 'design',
  },
  xwhm: {
    '/whm': 'overview', '/whm/monitoring/io': 'io', '/whm/services': 'services',
    '/whm/services/health': 'services', '/whm/accounts': 'accounts', '/whm/accounts/new': 'create-account',
    '/whm/plans': 'plans', '/whm/plans/features': 'design', '/whm/resellers': 'resellers',
    '/whm/dns': 'dns', '/whm/backups/restore': 'backups', '/whm/monitoring/server-info': 'server-info',
    '/whm/resellers/privileges': 'resellers', '/whm/server/ips': 'ips', '/whm/email/outbound': 'mail-ips',
    '/whm/security/firewall': 'firewall', '/whm/audit': 'audit', '/whm/panel/data': 'generations',
    '/whm/server/upgrade': 'upgrade', '/whm/transfers': 'transfer',
    '/whm/security/sign-in': 'security',
    '/whm/server/setup': 'design', '/whm/domains': 'design', '/whm/ssl': 'design',
    '/whm/backups': 'backups',
    '/whm/services/web': 'design', '/whm/software/php': 'design', '/whm/security': 'design',
    '/whm/security/ssh': 'design',
  },
  xmail: {
    '/mail': 'inbox', '/mail/inbox': 'inbox', '/mail/compose': 'compose',
    '/mail/settings/filters': 'filters', '/mail/settings/autoresponder': 'autoresponder',
    '/mail/settings/identities': 'identities',
    '/mail/settings/security': 'security',
    '/mail/overview': 'overview',
  },
}

/** Select only an implemented screen; catalog visibility and route authorization remain separate gates. */
export const resolveSurfaceSection = (surface: SurfaceShellProps['surface'], activeRoute: string): string | undefined =>
  surfaceSections[surface][activeRoute]

export const renderMobileNavToggle = (locale: Locale): string => `
<button type="button" class="xp-btn xp-mobile-nav-toggle" data-action="toggle-mobile-nav" aria-controls="xp-sidebar" aria-expanded="false">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>${translator(locale)('Menu')}</span>
</button>`

export const renderMobileNavBackdrop = (locale: Locale): string => `
<button type="button" class="xp-nav-backdrop" data-action="close-mobile-nav" data-xp-nav-backdrop hidden tabindex="-1" aria-label="${translator(locale)(msgctxt('shell', 'Close navigation'))}"></button>`

export const renderMobileNavClose = (locale: Locale): string => `
<button type="button" class="xp-btn xp-mobile-nav-close" data-action="close-mobile-nav" aria-controls="xp-sidebar">${translator(locale)(msgctxt('shell', 'Close navigation'))}</button>`

export interface SurfaceShellProps {
  surface: 'xpanel' | 'xwhm' | 'xmail'
  locale: Locale
  attributes?: string
  sidebar: string
  topbar: string
  content: string
}

export const renderSurfaceShell = (props: SurfaceShellProps): string => `
<div class="xp-shell" data-surface="${props.surface}" ${props.attributes ?? ''}>
  <a class="xp-skip-link" href="#main-content">${translator(props.locale)('Skip to content')}</a>
  <aside class="xp-sidebar" id="xp-sidebar" data-xp-sidebar tabindex="-1" aria-label="${props.surface === 'xwhm' ? 'xWHM' : props.surface === 'xmail' ? 'xMail' : 'xPanel'} ${translator(props.locale)('navigation')}">
    ${renderMobileNavClose(props.locale)}
    ${props.sidebar}
  </aside>
  ${renderMobileNavBackdrop(props.locale)}
  <div class="xp-workspace" data-xp-shell-content>
    <header class="xp-topbar" role="banner">
      ${renderMobileNavToggle(props.locale)}
      <strong class="xp-mobile-brand">${props.surface === 'xwhm' ? 'xWHM' : props.surface === 'xmail' ? 'xMail' : 'xPanel'}</strong>
      <details class="xp-toolbar-options" open data-xp-toolbar-options>
        <summary class="xp-btn">${translator(props.locale)('Search & account')}</summary>
        <div class="xp-toolbar-options__content">${props.topbar}</div>
      </details>
    </header>
    <main id="main-content" class="xp-main" role="main" tabindex="-1">${props.content}</main>
  </div>
</div>`

const backIcon = `<span class="xp-icon-back"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 6 9 12l6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`

export const renderSurfaceUnavailable = (locale: Locale, homeRoute: string): string => `
<section class="xp-card xp-screen-state" data-screen="unavailable" role="status">
  <h1 class="xp-page-title">${translator(locale)('This page is unavailable')}</h1>
  <p class="xp-prose">${translator(locale)('A qualified screen for this task is not available yet. You can return to the overview.')}</p>
  <a class="xp-btn xp-back-link" href="${escapeHtml(homeRoute)}">${backIcon}<span>${translator(locale)('Back to overview')}</span></a>
</section>`

export const renderUnavailableSurfaceShell = (surface: SurfaceShellProps['surface'], locale: Locale): string => renderSurfaceShell({
  surface, locale,
  sidebar: `<div class="xp-sidebar__brand"><strong>${surface === 'xwhm' ? 'xWHM' : surface === 'xmail' ? 'xMail' : 'xPanel'}</strong></div>${renderPlannedNavigation(surface as PanelId, locale)}`,
  topbar: '',
  content: renderSurfaceUnavailable(locale, surface === 'xwhm' ? '/whm' : surface === 'xmail' ? '/mail/inbox' : '/home'),
})
