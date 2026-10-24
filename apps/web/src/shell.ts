import { renderPlannedNavigation, type PanelId } from './chrome.ts'
import type { Locale } from './i18n.ts'
import { escapeHtml, renderStatusBadge } from './tokens.ts'
import arCatalog from '../../../packages/catalog/src/locales/ar.json' with { type: 'json' }

type SurfaceKind = SurfaceShellProps['surface']
type LocalizedTitle = readonly [english: string, arabic: string]

const surfacePageTitles: Record<SurfaceKind, Readonly<Record<string, LocalizedTitle>>> = {
  xpanel: {
    overview: ['Home', 'الرئيسية'], resources: ['Resources & quotas', 'الموارد والحصص'],
    domains: ['Domains', 'النطاقات'], config: ['Site settings', 'إعدادات الموقع'],
    analytics: ['Metrics', 'القياسات'], files: ['File manager', 'مدير الملفات'],
    terminal: ['Terminal', 'الطرفية'], databases: ['MariaDB', 'MariaDB'],
    users: ['Email and service users', 'البريد ومستخدمو الخدمة'], dns: ['Zone editor', 'محرر المنطقة'],
    ssl: ['SSL/TLS', 'SSL/TLS'], security: ['Account security', 'أمان الحساب'],
  },
  xwhm: {
    overview: ['Server dashboard', 'لوحة الخادم'], io: ['Disk I/O', 'عمليات القرص'],
    services: ['Services', 'الخدمات'], accounts: ['Accounts', 'الحسابات'],
    dns: ['DNS zones', 'مناطق DNS'], backups: ['Account backups', 'نسخ الحسابات'],
    'server-info': ['Server information', 'معلومات الخادم'],
    'create-account': ['Create account', 'إنشاء حساب'], plans: ['Plans', 'الخطط'],
    resellers: ['Resellers', 'الموزعون'], ips: ['IP addresses', 'عناوين IP'],
    'mail-ips': ['Outbound mail routing', 'توجيه البريد الصادر'], firewall: ['Firewall', 'جدار الحماية'],
    audit: ['Audit log', 'سجل التدقيق'], generations: ['Configuration history', 'سجل الإعدادات'],
    upgrade: ['Upgrade', 'الترقية'], transfer: ['Transfer tool', 'أداة النقل'],
    security: ['Sign-in security', 'أمان تسجيل الدخول'],
  },
  xmail: {
    inbox: ['Inbox', 'البريد الوارد'], compose: ['Compose message', 'إنشاء رسالة'],
    filters: ['Mail filters', 'مرشحات البريد'], autoresponder: ['Auto-responder', 'الرد التلقائي'],
    overview: ['Mail overview', 'نظرة عامة على البريد'],
    security: ['Mail security', 'أمان البريد'],
  },
}

const routePageTitles: Readonly<Record<string, LocalizedTitle>> = {
  '/files/trash': ['Trash', 'المهملات'], '/files/ftp': ['FTP accounts', 'حسابات FTP'],
  '/security/ssl/issue': ['Issue certificate', 'إصدار شهادة'],
  '/whm/plans/features': ['Feature lists', 'قوائم الميزات'],
  '/whm/backups': ['Server backups', 'نسخ الخادم'],
  '/whm/resellers/privileges': ['Reseller privileges', 'صلاحيات الموزعين'],
  '/mail/folders': ['Folders', 'المجلدات'],
}

export const getSurfacePageTitle = (surface: SurfaceKind, section: string | undefined, locale: Locale, activeRoute: string): string => {
  const title = routePageTitles[activeRoute] ?? surfacePageTitles[surface][section ?? ''] ?? ['Page unavailable', 'الصفحة غير متاحة']
  return title[locale === 'ar' ? 1 : 0]
}

export const getSurfaceNavigationLabel = (surface: SurfaceKind, kind: 'section' | 'page', item: { id: string; name: string }, locale: Locale): string =>
  locale === 'ar' ? (arCatalog as Readonly<Record<string, string>>)[`nav.${kind}.${surface}.${item.id}.name`] ?? item.name : item.name

export const normalizeSurfaceRoute = (surface: SurfaceKind, activeRoute: string): string =>
  surface === 'xpanel' && activeRoute === '/panel' ? '/home' : surface === 'xmail' && activeRoute === '/mail' ? '/mail/inbox' : activeRoute

export const renderPageSearchButton = (locale: Locale): string => {
  const label = locale === 'ar' ? 'ابحث عن صفحة' : 'Find a page'
  return `<button type="button" class="xp-btn xp-page-search" data-action="open-cmdk" aria-keyshortcuts="Control+K Meta+K" aria-label="${label} Ctrl K" title="${label} (Ctrl K)">
    <svg class="xp-page-search__icon" aria-hidden="true" focusable="false" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4 4" /></svg>
    <span class="xp-page-search__label">${label}</span><kbd class="xp-mono">Ctrl K</kbd>
  </button>`
}

export const renderLiveUpdatesIndicator = (locale: Locale, realtimeEnabled: boolean): string => {
  const label = realtimeEnabled
    ? (locale === 'ar' ? 'جار الاتصال' : 'Connecting')
    : (locale === 'ar' ? 'التحديثات المباشرة غير متاحة' : 'Live updates unavailable')
  const visibleLabel = realtimeEnabled ? label : (locale === 'ar' ? 'التحديث متوقف' : 'Live off')
  const description = realtimeEnabled ? '' : ` aria-label="${label}" title="${label}"`
  return `<span data-ws-indicator="${realtimeEnabled ? 'disconnected' : 'unavailable'}" role="status"${description}>${renderStatusBadge('suspended', visibleLabel)}</span>`
}

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
    '/mail': 'inbox', '/mail/inbox': 'inbox', '/mail/folders': 'inbox', '/mail/compose': 'compose',
    '/mail/settings/filters': 'filters', '/mail/settings/autoresponder': 'autoresponder',
    '/mail/settings/security': 'security',
    '/mail/overview': 'overview',
  },
}

/** Select only an implemented screen; catalog visibility and route authorization remain separate gates. */
export const resolveSurfaceSection = (surface: SurfaceShellProps['surface'], activeRoute: string): string | undefined =>
  surfaceSections[surface][activeRoute]

export const renderMobileNavToggle = (locale: Locale): string => `
<button type="button" class="xp-btn xp-mobile-nav-toggle" data-action="toggle-mobile-nav" aria-controls="xp-sidebar" aria-expanded="false">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>${locale === 'ar' ? 'القائمة' : 'Menu'}</span>
</button>`

export const renderMobileNavBackdrop = (locale: Locale): string => `
<button type="button" class="xp-nav-backdrop" data-action="close-mobile-nav" data-xp-nav-backdrop hidden tabindex="-1" aria-label="${locale === 'ar' ? 'إغلاق القائمة' : 'Close navigation'}"></button>`

export const renderMobileNavClose = (locale: Locale): string => `
<button type="button" class="xp-btn xp-mobile-nav-close" data-action="close-mobile-nav" aria-controls="xp-sidebar">${locale === 'ar' ? 'إغلاق القائمة' : 'Close navigation'}</button>`

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
  <a class="xp-skip-link" href="#main-content">${props.locale === 'ar' ? 'انتقل إلى المحتوى' : 'Skip to content'}</a>
  <aside class="xp-sidebar" id="xp-sidebar" data-xp-sidebar tabindex="-1" aria-label="${props.surface === 'xwhm' ? 'xWHM' : props.surface === 'xmail' ? 'xMail' : 'xPanel'} ${props.locale === 'ar' ? 'التنقل' : 'navigation'}">
    ${renderMobileNavClose(props.locale)}
    ${props.sidebar}
  </aside>
  ${renderMobileNavBackdrop(props.locale)}
  <div class="xp-workspace" data-xp-shell-content>
    <header class="xp-topbar" role="banner">
      ${renderMobileNavToggle(props.locale)}
      <strong class="xp-mobile-brand">${props.surface === 'xwhm' ? 'xWHM' : props.surface === 'xmail' ? 'xMail' : 'xPanel'}</strong>
      <details class="xp-toolbar-options" open data-xp-toolbar-options>
        <summary class="xp-btn">${props.locale === 'ar' ? 'البحث والحساب' : 'Search & account'}</summary>
        <div class="xp-toolbar-options__content">${props.topbar}</div>
      </details>
    </header>
    <main id="main-content" class="xp-main" role="main" tabindex="-1">${props.content}</main>
  </div>
</div>`

const backIcon = `<span class="xp-icon-back"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 6 9 12l6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`

export const renderSurfaceUnavailable = (locale: Locale, homeRoute: string): string => `
<section class="xp-card xp-screen-state" data-screen="unavailable" role="status">
  <h1 class="xp-page-title">${locale === 'ar' ? 'هذه الصفحة غير متاحة' : 'This page is unavailable'}</h1>
  <p class="xp-prose">${locale === 'ar' ? 'لم تتوفر واجهة مؤهلة لهذه المهمة بعد. يمكنك العودة إلى نظرة عامة.' : 'A qualified screen for this task is not available yet. You can return to the overview.'}</p>
  <a class="xp-btn xp-back-link" href="${escapeHtml(homeRoute)}">${backIcon}<span>${locale === 'ar' ? 'العودة إلى النظرة العامة' : 'Back to overview'}</span></a>
</section>`

export const renderUnavailableSurfaceShell = (surface: SurfaceShellProps['surface'], locale: Locale): string => renderSurfaceShell({
  surface, locale,
  sidebar: `<div class="xp-sidebar__brand"><strong>${surface === 'xwhm' ? 'xWHM' : surface === 'xmail' ? 'xMail' : 'xPanel'}</strong></div>${renderPlannedNavigation(surface as PanelId, locale)}`,
  topbar: '',
  content: renderSurfaceUnavailable(locale, surface === 'xwhm' ? '/whm' : surface === 'xmail' ? '/mail/inbox' : '/home'),
})
