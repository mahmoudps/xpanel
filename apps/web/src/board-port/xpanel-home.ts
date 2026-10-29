import { LOCALES, SOURCE_LOCALE, alternateLocales, localeDirection, localeInfo, translator, type Locale } from '../i18n.ts'
import { ARABIC_TYPE_CSS } from '../arabic-type.ts'
import { isolateLtrRuns, metaPieces } from '../bidi-runs.ts'
import { formatDisplayName } from '../display-name.ts'
import { escapeHtml, formatAsciiBytes, formatUtcClock } from '../tokens.ts'
import { renderLiveUpdatesIndicator, renderPageSearchButton } from '../shell.ts'


// Preserve the approved light swatches; dark paint uses the existing semantic theme roles.
// Fixed brand/logo colors are kept by their rendering sites.
type HomeColorRole = 'ink' | 'surface' | 'border'
const HOME_THEME_ROLES: Record<HomeColorRole, Readonly<Record<string, string>>> = {
  "ink": {
    "#101828": "--xp-text-primary",
    "#344054": "--xp-text-secondary",
    "#475467": "--xp-text-secondary",
    "#5D6B7E": "--xp-text-muted",
    "#98A2B3": "--xp-text-muted",
    "#8A99AF": "--xp-text-muted",
    "#C9D3E1": "--xp-text-secondary",
    "#1D5BD6": "--xp-accent",
    "#1546A8": "--xp-accent-hover",
    "#0E7A4E": "--xp-status-ok-fg",
    "#B54708": "--xp-status-warn-fg",
    "#B42318": "--xp-status-critical-fg"
  },
  "surface": {
    "#F5F6F8": "--xp-bg-canvas",
    "#FFFFFF": "--xp-bg-surface",
    "#F8F9FB": "--xp-bg-elevated",
    "#EEF0F3": "--xp-bg-elevated",
    "#E9ECF1": "--xp-border",
    "#E8EFFD": "--xp-accent-soft",
    "#F3F7FE": "--xp-accent-soft",
    "#E7F5EE": "--xp-status-ok-bg",
    "#FDECEA": "--xp-status-critical-bg",
    "#FFF6EE": "--xp-status-warn-bg",
    "#10182866": "--xp-nav-backdrop"
  },
  "border": {
    "#E2E6EC": "--xp-border",
    "#EEF0F3": "--xp-border",
    "#D0D5DD": "--xp-border-strong",
    "#C9CFD8": "--xp-border-strong",
    "#E8EFFD": "--xp-accent-border",
    "#C7D7F8": "--xp-accent-border",
    "#F9C9A0": "--xp-status-warn-border",
    "#1D5BD6": "--xp-border-focus"
  }
}
const themeColor = (value: string, role: HomeColorRole = 'ink'): string => {
  const token = HOME_THEME_ROLES[role][value.toUpperCase()]
  return token ? `light-dark(${value},var(${token},${value}))` : value
}

type IconName = keyof typeof ICONS

const ICONS = {
  home: 'M3 11l9-7 9 7M5 9.5V20h14V9.5M10 20v-6h4v6',
  gauge: 'M3.5 17a8.5 8.5 0 1 1 17 0M12 17l3.5-5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  archive: 'M3 4h18v5H3zM5 9v11h14V9M10 13h4',
  globe: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  zone: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  database: 'M4 6a8 3 0 1 0 16 0a8 3 0 1 0-16 0M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  mail: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 7l9 6 9-6',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1.5 2.5h5L16 13h5',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14',
  filecode: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M10 12.5l-2 2 2 2M14 12.5l2 2-2 2',
  clock: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7v5l3 2',
  chart: 'M4 20h16M7 17v-6M12 17V7M17 17v-3',
  lock: 'M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V8a4 4 0 0 1 8 0v3',
  shield: 'M12 3l7 3v5c0 4.4-3 8.3-7 10c-4-1.7-7-5.6-7-10V6z',
  shieldcheck: 'M12 3l7 3v5c0 4.4-3 8.3-7 10c-4-1.7-7-5.6-7-10V6zM9 12l2 2 4-4',
  users: 'M5.5 8a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 7M21 20c0-2.8-1.6-5-4-5.7',
  pie: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 3v9l6.4 6.4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5',
  key: 'M4 15a4 4 0 1 0 8 0a4 4 0 1 0-8 0M11 12l9-9M16 7l3 3',
  redirect: 'M4 12h12M12 7l5 5-5 5M20 5v14',
  forward: 'M15 5l6 6-6 6M21 11H10a6 6 0 0 0-6 6v2',
  filter: 'M3 5h18l-7 8v6l-4 1v-7z',
  alert: 'M12 3l9.5 17h-19zM12 10v4M12 17h.01',
  updown: 'M7 20V4M3 8l4-4 4 4M17 4v16M13 16l4 4 4-4',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  phone: 'M9 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM11 17h2',
  tune: 'M4 6h16M4 12h16M4 18h16M8 4v4M15 10v4M10 16v4',
  terminal: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM7 9l3 3-3 3M13 15h4',
  cpu: 'M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  lines: 'M4 6h16M4 10h16M4 14h10M4 18h7',
  language: 'M4 5h9M8.5 3v2M6 5c.8 3.4 3 6 6 7.5M11 5c-.8 3.4-3 6-6 7.5M13 21l4-9 4 9M14.5 18h5',
  'password': 'M5 7h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zM7.5 12h.01M12 12h.01M16.5 12h.01',
  at: 'M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1',
} as const

export const MONO = "'IBM Plex Mono', monospace"

const PORT_CSS = `.xp-board-port{line-height:normal;font-size:16px;font-kerning:auto;font-feature-settings:normal;font-synthesis:weight style small-caps;-webkit-font-smoothing:antialiased}
.xp-board-port a{color:light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))}.xp-board-port a:hover{color:light-dark(#1546A8,var(--xp-accent-hover,#1546A8))}
.xp-board-port :focus-visible{outline:2px solid light-dark(#1D5BD6,var(--xp-border-focus,#1D5BD6));outline-offset:2px}
.xp-board-port p{max-inline-size:none}
[data-home-desktop] [aria-labelledby="info-title"]{padding:var(--xp-space-card,24px)!important;gap:var(--xp-space-group,24px)!important}
[data-home-desktop] [aria-labelledby="info-title"] dl{gap:var(--xp-space-field,16px)}
[data-home-desktop] [aria-labelledby="info-title"] dl>div{flex-direction:column;align-items:stretch!important;gap:var(--xp-space-label,8px)!important;padding:0!important;border:0!important}
[data-home-desktop] [aria-labelledby="info-title"] dd{text-align:start!important;align-items:stretch!important;min-inline-size:0;overflow-wrap:anywhere}
[data-home-desktop] label[for="tool-filter"]{box-sizing:border-box;padding-inline-start:41px}
[data-home-desktop] #tool-filter{text-align:match-parent!important}
[data-home-desktop][dir="rtl"] #tool-filter{padding-right:40px!important;padding-left:12px!important;text-align:right!important}
${ARABIC_TYPE_CSS}`

export interface Hint {
  text: string
  mono: boolean
  dir: 'ltr' | 'rtl'
}

export interface ToolDef {
  id: string
  icon: IconName
  href: string
  /** Message of the tool name. */
  name: string
  /** Message of the English search keywords; its translation holds the locale's own keywords. */
  keys: string
  flip?: boolean
}

interface NavItem { label: string; href: string; icon: IconName }
interface NavGroup { label: string; items: NavItem[] }

const tool = (id: string, icon: IconName, href: string, name: string, keys: string, flip = false): ToolDef =>
  ({ id, icon, href, name, keys, ...(flip ? { flip: true } : {}) })

export const num = (text: string): Hint => ({ text, mono: false, dir: 'ltr' })
export const mono = (text: string): Hint => ({ text, mono: true, dir: 'ltr' })
export const plain = (text: string, monoFace = false): Hint => ({ text, mono: monoFace, dir: 'ltr' })

const GROUPS: Array<{ label: string; tools: ToolDef[] }> = [
  { label: msgid('Files'), tools: [
    tool('files.manager', 'folder', '/files/manager', msgid('File manager'), msgid('file manager upload edit permissions chmod')),
    tool('files.backup', 'archive', '/files/backup', msgctxt('xpanel-home', 'Backup wizard'), msgid('backup restore archive download')),
    tool('files.ftp', 'users', '/files/ftp', msgid('FTP & Web Disk users'), msgid('ftp webdisk sftp')),
    tool('files.disk', 'pie', '/resources', msgid('Disk usage'), msgid('disk usage quota space')),
    tool('files.trash', 'trash', '/files/trash', msgctxt('xpanel-home', 'Trash'), msgid('trash deleted recycle restore')),
  ] },
  { label: msgid('Databases'), tools: [
    tool('db.list', 'database', '/databases/mariadb', msgctxt('xpanel-home', 'MariaDB databases'), msgid('mariadb mysql databases sql')),
    tool('db.users', 'key', '/databases/mariadb', msgid('Database users'), msgid('database users privileges grant')),
    tool('db.trash', 'trash', '/databases/mariadb', msgid('Database trash'), msgid('database trash drop restore deleted')),
  ] },
  { label: msgid('Domains'), tools: [
    tool('domains.list', 'globe', '/domains', msgid('Domains'), msgid('domains addon alias subdomain wildcard rename')),
    tool('domains.site', 'sliders', '/domains/site-settings', msgid('Site settings'), msgid('site settings document root static proxy node python suspend')),
    tool('domains.zone', 'zone', '/domains/zone-editor', msgid('Zone editor'), msgid('dns zone records mx txt cname')),
    tool('domains.redirect', 'redirect', '/domains/site-settings', msgctxt('xpanel-home', 'Redirects'), msgid('redirects redirect 301 302 rewrite'), true),
  ] },
  { label: msgctxt('xpanel-home', 'Email'), tools: [
    tool('email.accounts', 'mail', '/email/accounts', msgid('Email accounts'), msgid('email accounts mailbox imap smtp quota')),
    tool('email.forward', 'forward', '/email/accounts', msgid('Forwarders'), msgid('forwarders forward alias'), true),
    tool('email.filters', 'filter', '/email/accounts', msgid('Filters'), msgid('filters spam rules sieve')),
    // Webmail opens per mailbox from Email accounts with a one-time sign-in; xPanel links no other panel.
    tool('email.webmail', 'inbox', '/email/accounts', msgid('xMail webmail'), msgid('webmail xmail inbox read compose')),
  ] },
  { label: msgid('Metrics'), tools: [
    tool('metrics.visitors', 'users', '/metrics/traffic', msgid('Visitors'), msgid('visitors stats traffic analytics')),
    tool('metrics.errors', 'alert', '/metrics/traffic', msgid('Errors'), msgid('errors 404 500 status codes')),
    tool('metrics.bandwidth', 'updown', '/metrics/traffic', msgctxt('xpanel-home', 'Bandwidth'), msgid('bandwidth traffic transfer')),
    tool('metrics.logs', 'download', '/metrics/traffic', msgid('Raw access logs'), msgid('raw access logs nginx log download')),
  ] },
  { label: msgid('Security'), tools: [
    tool('security.ssl', 'lock', '/security/ssl', msgid('SSL/TLS'), msgid('ssl tls https certificate autossl wildcard')),
    tool('security.2fa', 'phone', '/security/account', msgctxt('xpanel-home', 'Two-factor authentication'), msgid('2fa two-factor totp otp')),
    tool('security.api', 'key', '/security/account', msgid('API tokens'), msgid('api tokens token automation')),
    tool('security.path', 'shieldcheck', '/files/directory-privacy', msgid('Path protection'), msgid('path protection directory privacy password folder')),
  ] },
  { label: msgid('Software'), tools: [
    tool('software.php', 'code', '/software/php', msgid('PHP version & handler'), msgid('php version handler fpm cgi workers')),
    tool('software.ini', 'tune', '/software/php', msgid('PHP settings'), msgid('php settings ini user.ini memory_limit extensions')),
    tool('software.htaccess', 'filecode', '/software/htaccess', msgctxt('xpanel-home', '.htaccess editor'), msgid('htaccess rewrite apache')),
    tool('software.apps', 'terminal', '/domains/site-settings', msgid('Node.js & Python apps'), msgid('node python app proxy')),
  ] },
  { label: msgid('Advanced'), tools: [
    tool('advanced.cron', 'clock', '/advanced/cron', msgid('Cron jobs'), msgid('cron jobs schedule timer')),
    tool('advanced.resources', 'gauge', '/resources', msgid('Resources & quotas'), msgid('resources quotas limits slice io memory cgroup')),
    tool('advanced.processes', 'cpu', '/resources', msgid('Processes'), msgid('processes process pid kill tasks')),
    tool('advanced.logs', 'lines', '/domains/site-settings', msgid('Site logs'), msgid('site logs error log apache nginx')),
  ] },
  { label: msgid('Preferences'), tools: [
    // groupViews points this row at the next language.
    tool('prefs.language', 'language', '?lang', msgid('Language'), msgid('language arabic english locale')),
    tool('prefs.password', 'password', '/security/account', msgid('Password'), msgid('password change sign-in')),
    tool('prefs.contact', 'at', '/security/account', msgid('Contact email'), msgid('contact email notifications')),
  ] },
]

const NAV: NavGroup[] = [
  { label: msgid('General'), items: [
    { label: msgid('Home'), href: '/home', icon: 'home' },
    { label: msgid('Resources & quotas'), href: '/resources', icon: 'gauge' },
  ] },
  { label: msgid('Files'), items: [
    { label: msgid('File manager'), href: '/files/manager', icon: 'folder' },
    { label: msgctxt('xpanel-home', 'Backup wizard'), href: '/files/backup', icon: 'archive' },
  ] },
  { label: msgid('Domains'), items: [
    { label: msgid('Domains'), href: '/domains', icon: 'globe' },
    { label: msgid('Site settings'), href: '/domains/site-settings', icon: 'sliders' },
    { label: msgid('Zone editor'), href: '/domains/zone-editor', icon: 'zone' },
  ] },
  { label: msgid('Databases'), items: [{ label: msgid('MariaDB'), href: '/databases/mariadb', icon: 'database' }] },
  { label: msgctxt('xpanel-home', 'Email'), items: [
    { label: msgid('Email & users'), href: '/email/accounts', icon: 'mail' },
    { label: msgid('xMail'), href: '/email/accounts', icon: 'inbox' },
  ] },
  { label: msgid('Software'), items: [
    { label: msgid('PHP'), href: '/software/php', icon: 'code' },
    { label: msgid('.htaccess'), href: '/software/htaccess', icon: 'filecode' },
  ] },
  { label: msgid('Advanced'), items: [
    { label: msgid('Cron jobs'), href: '/advanced/cron', icon: 'clock' },
    { label: msgid('Metrics'), href: '/metrics/traffic', icon: 'chart' },
  ] },
  { label: msgid('Security'), items: [
    { label: msgid('SSL/TLS'), href: '/security/ssl', icon: 'lock' },
    { label: msgid('Security'), href: '/security/account', icon: 'shield' },
  ] },
]

const iconSvg = (name: IconName, size: number, style = ''): string =>
  `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${style}><path d="${ICONS[name]}"></path></svg>`

const bareIcon = (name: IconName, style = ''): string =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${style}><path d="${ICONS[name]}"></path></svg>`

const TOOL_COUNT = msgid('{count, plural, one {# tool} other {# tools}}')

/** The languages a switch offers: every registered locale except the current one. */

const pill = (label: string, bg: string, fg: string): string =>
  `<span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${themeColor(bg, 'surface')}; color: ${themeColor(fg)}; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${themeColor(fg)}"></span>${escapeHtml(label)}</span>`

const meterPaint = (pct: number): { color: string; noteColor: string; noteWeight: string } => ({
  color: pct >= 95 ? '#B42318' : pct >= 80 ? '#B54708' : '#1D5BD6',
  noteColor: pct >= 80 ? '#B54708' : '#5D6B7E',
  noteWeight: pct >= 80 ? '600' : '500',
})

export interface HomeMeter {
  label: string
  value: string
  pct: number
  note: string
}

export interface HomeChange {
  pill: string
  pillBg: string
  pillFg: string
  titleHtml: string
  detailHtml: string
  actionHref?: string
  actionLabel?: string
}

export interface HomeInfoRow {
  label: string
  valueHtml: string
  ddStyle: string
}

export interface HomeToolView {
  href: string
  icon: IconName
  name: string
  hint: string
  hintFont: string
  hintDir: 'ltr' | 'rtl'
  flip: boolean
  keys: string
  /** False when this account has not qualified the tool. The row stays visible. */
  enabled: boolean
}

export interface HomeGroupView {
  label: string
  countText: string
  size: number
  tools: HomeToolView[]
  open: boolean
}

export interface HomeNavView {
  id: string
  label: string
  items: Array<{ href: string; route?: string; label: string; icon: IconName; current: boolean; enabled?: boolean }>
}

export interface HomeDesktopModel {
  locale: Locale
  theme?: 'dark' | 'light'
  realtimeEnabled?: boolean
  username: string
  domain: string
  planLabel: string
  diskLabel: string
  diskValue: string
  diskPct: number
  procLabel: string
  procValue: string
  procPct: number
  nav: HomeNavView[]
  title: string
  ledeHtml: string
  pill: { label: string; bg: string; fg: string } | null
  generationHtml: string
  bannerHtml: string | null
  bannerHref: string
  bannerLabel: string
  countText: string
  groups: HomeGroupView[]
  infoTitle: string
  info: HomeInfoRow[]
  usageTitle: string
  usageLink: string
  meters: HomeMeter[]
  changesTitle: string
  changes: HomeChange[]
  emptyChanges: string
  metricsUnavailable: boolean
  actionHtml: string
  signOutLabel?: string
}

export interface HomePhoneModel {
  locale: Locale
  theme?: 'dark' | 'light'
  realtimeEnabled?: boolean
  username: string
  domain: string
  planLabel: string
  title: string
  titleTag: 'h1' | 'div'
  ledeHtml: string
  countText: string
  groups: HomeGroupView[]
  meters: HomeMeter[]
  nav: HomeNavView[]
  metricsUnavailable: boolean
  actionHtml: string
  signOutLabel?: string
}

const ALWAYS_LIVE_HREFS = new Set(['/security/account'])

/** A missing set keeps the board specimen fully linked. A set enables only qualified routes. */
const toolEnabled = (href: string, qualified: ReadonlySet<string> | undefined): boolean => {
  if (qualified === undefined) return true
  if (href.startsWith('?')) return true
  return ALWAYS_LIVE_HREFS.has(href) || qualified.has(href)
}

export const navViews = (locale: Locale, idPrefix: string): HomeNavView[] => {
  const t = translator(locale)
  return NAV.map((group, index) => ({
    id: `${idPrefix}${index}`,
    label: t(group.label),
    items: group.items.map(item => ({
      href: item.href,
      label: t(item.label),
      icon: item.icon,
      current: item.href === '/home',
    })),
  }))
}

export const groupViews = (locale: Locale, phone: boolean, hints: (tool: ToolDef) => Hint, qualified?: ReadonlySet<string>): HomeGroupView[] => {
  const t = translator(locale)
  const soon = t(msgctxt('xpanel-home', 'Coming soon'))
  return GROUPS.map(group => {
    const tools = group.tools.map(item => {
      const hint = hints(item)
      const href = item.id === 'prefs.language' ? `?lang=${alternateLocales(locale)[0]!.tag}` : item.href
      const enabled = toolEnabled(href, qualified)
      const name = t(item.name)
      // Search matches the English keywords and the current locale's own keywords.
      const localKeys = t(item.keys)
      return {
        href,
        icon: item.icon,
        name,
        hint: enabled ? hint.text : soon,
        hintFont: enabled && hint.mono ? MONO : 'inherit',
        hintDir: enabled ? hint.dir : localeDirection(locale),
        flip: Boolean(item.flip),
        keys: localKeys === item.keys ? `${name} ${item.keys}` : `${name} ${item.keys} ${localKeys}`,
        enabled,
      }
    })
    return {
      label: t(group.label),
      countText: t(TOOL_COUNT, { count: tools.length }),
      size: tools.length,
      tools,
      open: false,
    }
  })
}

export const totalCount = (groups: HomeGroupView[], locale: Locale, phone: boolean): string => {
  const count = groups.reduce((sum, group) => sum + group.size, 0)
  const t = translator(locale)
  // The approved LTR phone board shortens the count; the RTL phone board keeps the full sentence.
  if (phone && localeDirection(locale) === 'ltr') return t(TOOL_COUNT, { count })
  return t('{count, plural, one {# tool} other {# tools}} in {groups} groups', { count, groups: groups.length })
}

const linkStyle = (current: boolean, rtl: boolean, phone: boolean): string => {
  const base = `display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: ${phone ? 15 : 14}px; text-decoration: none; color: ${themeColor(current ? '#1D5BD6' : '#344054')}; background: ${themeColor(current ? '#E8EFFD' : 'transparent', 'surface')}; font-weight: ${current ? 600 : 500}`
  return rtl ? `${base}; box-shadow: ${current ? 'inset -3px 0 0 light-dark(#1D5BD6,var(--xp-border-focus,#1D5BD6))' : 'none'}` : base
}

const navHtml = (groups: HomeNavView[], locale: Locale, phone: boolean): string => {
  const rtl = localeDirection(locale) === 'rtl'
  const unavailable = translator(locale)('Unavailable')
  const labelStyle = rtl
    ? 'padding: 0 12px; font-size: 12px; font-weight: 600; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))'
    : 'padding: 0 12px; font-size: 11px; font-weight: 600; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); letter-spacing: 0.02em'
  return groups.map(group => {
    const items = group.items.map(item => item.enabled === false
      ? `<li><span aria-disabled="true" style="${linkStyle(false, rtl, phone)}; color: light-dark(#98A2B3,var(--xp-text-muted,#98A2B3)); cursor: not-allowed">${iconSvg(item.icon, 18, ' style="flex: none"')}<span>${escapeHtml(item.label)} · ${unavailable}</span></span></li>`
      : `<li><a href="${escapeHtml(item.href)}" data-nav-route="${escapeHtml(item.route ?? item.href)}" aria-current="${item.current ? 'page' : 'false'}" style="${linkStyle(item.current, rtl, phone)}">${iconSvg(item.icon, 18, ' style="flex: none"')}<span>${escapeHtml(item.label)}</span></a></li>`).join('')
    return `<div style="display: flex; flex-direction: column; gap: ${phone ? 2 : 4}px">
        <span id="${group.id}" style="${labelStyle}">${escapeHtml(group.label)}</span>
        <ul aria-labelledby="${group.id}" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px">${items}</ul>
      </div>`
  }).join('')
}

/** Links to the other registered languages, each named and tagged in its own language. */
const langLinks = (locale: Locale, phone: boolean): string => alternateLocales(locale).map(info => {
  const dir = info.dir === 'ltr' && localeDirection(locale) === 'rtl' ? ' dir="ltr"' : ''
  const font = info.dir === 'rtl' ? 'sans-serif' : "'IBM Plex Sans', sans-serif"
  return `<a href="?lang=${info.tag}" data-lang-switch="${info.tag}" lang="${info.tag}" hreflang="${info.tag}"${dir} style="${phone ? 'align-self: center; ' : ''}min-height: 44px; display: inline-flex; align-items: center; padding: 0 12px; ${phone ? '' : 'border-radius: 8px; '}font-family: ${font}; font-size: 14px; font-weight: 600; text-decoration: none">${escapeHtml(info.nativeName)}</a>`
}).join('')

const metaHtml = (text: string, dir: 'ltr' | 'rtl', font: string, color: string): string => {
  const pieces = metaPieces(text)
  if (pieces.length === 0) return ''
  const body = pieces.map(piece => piece.kind === 'value'
    ? `<bdi data-meta-value dir="ltr" style="flex: none; flex-shrink: 0; white-space: nowrap">${escapeHtml(piece.text)}</bdi>`
    : `<span data-meta-label>${escapeHtml(piece.text)}</span>`).join('')
  return `<span data-meta title="${escapeHtml(text)}" dir="${dir}" style="display: inline-flex; align-items: baseline; gap: 0.35em; flex: 1 1 auto; min-width: 0; font-size: 12px; color: ${themeColor(color)}; font-variant-numeric: tabular-nums; font-family: ${font}">${body}</span>`
}

const toolRow = (item: HomeToolView, rtl: boolean, phone: boolean): string => {
  const svgStyle = rtl ? ` style="transform: ${item.flip ? 'scaleX(-1)' : 'none'}"` : ''
  const hintColor = item.enabled ? '#5D6B7E' : '#98A2B3'
  const hint = rtl
    ? metaHtml(item.hint, item.hintDir, item.hintFont, hintColor)
    : `<span style="flex: none; font-size: 12px; color: ${themeColor(hintColor)}; font-variant-numeric: tabular-nums; font-family: ${item.hintFont}">${escapeHtml(item.hint)}</span>`
  const well = phone ? 'width: 32px; height: 32px' : 'width: 30px; height: 30px'
  const row = phone
    ? 'display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 0 8px; border-radius: 8px; text-decoration: none; color: light-dark(#101828,var(--xp-text-primary,#101828)); font-size: 15px'
    : 'display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 8px; border-radius: 8px; text-decoration: none; color: light-dark(#101828,var(--xp-text-primary,#101828)); font-size: 14px'
  const icon = `<span aria-hidden="true" style="flex: none; ${well}; border-radius: 8px; background: light-dark(#F3F7FE,var(--xp-accent-soft,#F3F7FE)); border: 1px solid light-dark(#E8EFFD,var(--xp-accent-border,#E8EFFD)); color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6)); display: flex; align-items: center; justify-content: center">${bareIcon(item.icon, svgStyle)}</span><span style="flex: 1 1 auto; min-width: 0; font-weight: 500">${escapeHtml(item.name)}</span>${hint}`
  if (!item.enabled) {
    const disabled = `${row}; color: light-dark(#98A2B3,var(--xp-text-muted,#98A2B3)); cursor: not-allowed`
    return `<li data-tool="true" data-tool-wiring="soon" data-tool-keys="${escapeHtml(item.keys)}"><span aria-disabled="true" style="${disabled}">${icon}</span></li>`
  }
  return `<li data-tool="true" data-tool-keys="${escapeHtml(item.keys)}"><a href="${escapeHtml(item.href)}" style="${row}">${icon}</a></li>`
}

const tech = (value: string, rtl: boolean): string => rtl && !/[\u0600-\u06FF]/.test(value) ? `<bdi dir="ltr">${escapeHtml(value)}</bdi>` : escapeHtml(value)

export const monoSpan = (value: string, rtl: boolean): string => rtl
  ? `<bdi dir="ltr" style="font-family: ${MONO}; font-size: 13px">${escapeHtml(value)}</bdi>`
  : `<span style="font-family: ${MONO}; font-size: 13px">${escapeHtml(value)}</span>`

const searchIcon = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))" stroke-width="2" stroke-linecap="round" style="position: absolute; inset-inline-start: 12px; top: 13px"><path d="M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0M20 20l-4-4"></path></svg>`

const warnIcon = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="light-dark(#B54708,var(--xp-status-warn-fg,#B54708))" stroke-width="2" stroke-linecap="round" style="flex: none"><path d="M12 3l9 16H3z"></path><path d="M12 10v4M12 17h.01"></path></svg>`

const DD_MONO = `margin: 0; font-size: 13px; font-family: ${MONO}; text-align: end`
const DD_WRAP = `${DD_MONO}; overflow-wrap: anywhere`
const DD_PLAN = 'margin: 0; font-size: 13px; text-align: end; font-weight: 600'
const DD_STACK = 'margin: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; text-align: end'

export const infoRows = (input: {
  locale: Locale
  username: string
  uid: number
  domain: string
  home: string
  ipv4: string
  plan: string
  php: string
  slice: string
  signInHtml: string
}): HomeInfoRow[] => {
  const t = translator(input.locale)
  const rtl = localeDirection(input.locale) === 'rtl'
  const labels = [
    msgid('Username'), msgid('Primary domain'), msgctxt('xpanel-home', 'Home directory'), msgid('Shared IP'),
    msgid('Plan'), msgid('Default PHP'), msgid('Isolation slice'), msgctxt('xpanel-home', 'Last sign-in'),
  ].map(label => t(label))
  const values: Array<[string, string]> = [
    [tech(`${input.username} · uid ${input.uid}`, rtl), DD_MONO],
    [tech(input.domain, rtl), DD_WRAP],
    [tech(input.home, rtl), DD_MONO],
    [tech(input.ipv4, rtl), DD_MONO],
    [tech(input.plan, rtl), DD_PLAN],
    [tech(input.php, rtl), DD_MONO],
    [tech(input.slice, rtl), DD_WRAP],
    [input.signInHtml, DD_STACK],
  ]
  return labels.map((label, index) => ({ label, valueHtml: values[index]?.[0] ?? '', ddStyle: values[index]?.[1] ?? DD_MONO }))
}

const signInEmpty = (rtl: boolean): string => rtl
  ? `<bdi dir="ltr" style="font-size: 13px; font-variant-numeric: tabular-nums">—</bdi>`
  : `<span style="font-size: 13px; font-variant-numeric: tabular-nums">—</span>`

const finite = (value: number | 'unlimited' | undefined): number | null => typeof value === 'number' ? value : null

const storage = (mb: number): string => mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`

const ratio = (count: number, cap: number | null): string => cap === null ? String(count) : `${count} / ${cap}`

const USER_COUNT = msgid('{count, plural, one {# user} other {# users}}')

const liveHint = (item: ToolDef, facts: LiveFacts, phone: boolean): Hint => {
  const t = translator(facts.locale)
  const dir = localeDirection(facts.locale)
  const dash: Hint = { text: '—', mono: false, dir: 'ltr' }
  const words = (text: string): Hint => ({ text, mono: false, dir })
  switch (item.id) {
    case 'files.manager': return mono(facts.home)
    case 'files.ftp': return words(t(USER_COUNT, { count: facts.ftpUsers }))
    case 'files.disk': {
      const diskLine = resourceLine(facts, 'disk')
      return diskLine === '—' ? dash : num(diskLine)
    }
    case 'files.trash': return words(t('{count, plural, one {# item} other {# items}}', { count: facts.trashFiles }))
    case 'db.list': return num(ratio(facts.databases, facts.databaseCap))
    case 'db.users': return words(t(USER_COUNT, { count: facts.databaseUsers }))
    case 'domains.list': {
      const shown = ratio(facts.addonDomains, facts.addonCap)
      return num(facts.addonCap === null ? shown : t('{ratio} addon', { ratio: shown }))
    }
    case 'domains.site': return words(t('{count, plural, one {# site} other {# sites}}', { count: facts.sites }))
    case 'domains.zone': return words(t('{count, plural, one {# zone} other {# zones}}', { count: facts.zones }))
    case 'email.accounts': return num(ratio(facts.mailboxes, facts.mailboxCap))
    // The approved LTR phone board leaves this hint empty; the RTL phone board shows it.
    case 'email.webmail': return phone && dir === 'ltr' ? plain('') : words(t(msgctxt('xpanel-home', 'Open')))
    case 'software.php': return facts.phpShort ? mono(phone ? facts.phpShort : (facts.phpHint ?? facts.phpShort)) : dash
    case 'software.ini': return mono('.user.ini')
    case 'advanced.processes': return resourceLine(facts, 'processes') === '—' ? dash : num(resourceLine(facts, 'processes'))
    case 'prefs.language': return words(localeInfo(facts.locale).nativeName)
    default: return dash
  }
}

interface LiveFacts {
  locale: Locale
  username: string
  domain: string
  home: string
  uid: number
  ipv4: string
  planLabel: string
  php: string
  phpShort: string | null
  phpHint: string | null
  slice: string
  addonDomains: number
  addonCap: number | null
  databases: number
  databaseCap: number | null
  databaseUsers: number
  mailboxes: number
  mailboxCap: number | null
  ftpUsers: number
  trashFiles: number
  zones: number
  sites: number
  diskLimit: string | null
  bandwidthLimit: string | null
  /** This month's metered traffic; null when not metered. */
  bandwidthBytes: number | null
  bandwidthLimited: boolean
  memoryLimit: string | null
  processLimit: string | null
  ioLimit: string | null
  /** False when the slice has no io.max cap. Null when usage was not sampled. */
  ioEnforced: boolean | null
  sampled: boolean
  diskBytes: number | null
  memoryBytes: number | null
  processCount: number | null
  diskCapBytes: number | null
  memoryCapBytes: number | null
  processCap: number | null
  generationId?: number
  signInHtml?: string
  changes?: HomeChange[]
}

const blankMeter = (label: string, value: string, pct = 0): HomeMeter => ({ label, value, pct, note: '—' })

const ioLine = (facts: LiveFacts): string => {
  if (!facts.sampled) return '—'
  if (facts.ioEnforced === false) return translator(facts.locale)('not enforced')
  if (facts.ioEnforced === true && facts.ioLimit) return facts.ioLimit
  return '—'
}

const resourceLine = (facts: LiveFacts, kind: 'disk' | 'memory' | 'processes' | 'bandwidth'): string => {
  const limit = kind === 'disk' ? facts.diskLimit : kind === 'memory' ? facts.memoryLimit : kind === 'processes' ? facts.processLimit : facts.bandwidthLimit
  if (kind === 'bandwidth') {
    if (!facts.sampled) return limit ? `— / ${limit}` : '—'
    const label = facts.bandwidthBytes === null ? translator(facts.locale)('not measured yet') : formatAsciiBytes(facts.bandwidthBytes)
    const line = limit ? `${label} / ${limit}` : label
    return facts.bandwidthLimited ? `${line} · ${translator(facts.locale)('limit page served')}` : line
  }
  const used = kind === 'disk' ? facts.diskBytes : kind === 'memory' ? facts.memoryBytes : facts.processCount
  if (!facts.sampled || used === null) return limit ? `— / ${limit}` : '—'
  const shown = kind === 'processes' ? String(used) : formatAsciiBytes(used)
  return limit ? `${shown} / ${limit}` : shown
}

const resourcePct = (facts: LiveFacts, kind: 'disk' | 'memory' | 'processes'): number => {
  if (!facts.sampled) return 0
  const used = kind === 'disk' ? facts.diskBytes : kind === 'memory' ? facts.memoryBytes : facts.processCount
  const cap = kind === 'disk' ? facts.diskCapBytes : kind === 'memory' ? facts.memoryCapBytes : facts.processCap
  if (used === null || cap === null || cap <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((used / cap) * 100)))
}

const liveDesktopMeters = (facts: LiveFacts): HomeMeter[] => {
  const t = translator(facts.locale)
  return [
    blankMeter(t('Disk'), resourceLine(facts, 'disk'), resourcePct(facts, 'disk')),
    blankMeter(t('Monthly bandwidth'), resourceLine(facts, 'bandwidth')),
    blankMeter(t('IO write cap'), ioLine(facts)),
    blankMeter(t('Memory'), resourceLine(facts, 'memory'), resourcePct(facts, 'memory')),
    blankMeter(t('Processes'), resourceLine(facts, 'processes'), resourcePct(facts, 'processes')),
    blankMeter(t('Addon domains'), ratio(facts.addonDomains, facts.addonCap)),
    blankMeter(t('Mailboxes'), ratio(facts.mailboxes, facts.mailboxCap)),
    blankMeter(t('Databases'), ratio(facts.databases, facts.databaseCap)),
  ]
}

const livePhoneMeters = (facts: LiveFacts): HomeMeter[] => {
  const t = translator(facts.locale)
  const labels = [
    msgid('Monthly bandwidth'), msgid('Disk'), msgid('Processes'), msgid('Memory'), msgid('Mailboxes'), msgid('Databases'), msgid('Addon domains'),
  ].map(label => t(label))
  const values = [
    resourceLine(facts, 'bandwidth'), resourceLine(facts, 'disk'),
    resourceLine(facts, 'processes'), resourceLine(facts, 'memory'),
    ratio(facts.mailboxes, facts.mailboxCap), ratio(facts.databases, facts.databaseCap), ratio(facts.addonDomains, facts.addonCap),
  ]
  const pcts = [0, resourcePct(facts, 'disk'), resourcePct(facts, 'processes'), resourcePct(facts, 'memory'), 0, 0, 0]
  return labels.map((label, index) => blankMeter(label, values[index] ?? '—', pcts[index] ?? 0))
}

/** The home lede: the primary domain (already marked up) and how many addon domains the account has. */
export const homeLede = (locale: Locale, domainHtml: string, addonDomains: number): string =>
  translator(locale)('Tools for {domain}{count, plural, =0 {} one { and # addon domain} other { and # addon domains}}. Your plan’s feature list decides which tools appear here.', { domain: domainHtml, count: addonDomains })

const liveLede = (facts: LiveFacts): string =>
  homeLede(facts.locale, monoSpan(facts.domain, localeDirection(facts.locale) === 'rtl'), facts.addonDomains)

const livePhoneLede = (facts: LiveFacts): string => {
  const rtl = localeDirection(facts.locale) === 'rtl'
  const plan = facts.planLabel === '—' ? '—' : translator(facts.locale)('{plan} plan', { plan: tech(facts.planLabel, rtl) })
  return `${monoSpan(facts.domain, rtl)} · ${plan} · ${monoSpan(`uid ${facts.uid}`, rtl)}`
}

const liveGeneration = (facts: LiveFacts): { pill: { label: string; bg: string; fg: string }; html: string } => {
  const neutral = { label: '—', bg: '#EEF0F3', fg: '#344054' }
  if (!facts.generationId) return { pill: neutral, html: '<span>—</span>' }
  const t = translator(facts.locale)
  if (localeDirection(facts.locale) === 'rtl') return { pill: neutral, html: `<span>${t('Generation {id}', { id: `<bdi dir="ltr" style="font-variant-numeric: tabular-nums">${facts.generationId}</bdi>` })}</span>` }
  return { pill: neutral, html: `<span style="font-variant-numeric: tabular-nums">${t('Generation {id}', { id: facts.generationId })}</span>` }
}

const desktopFromFacts = (facts: LiveFacts, actionHtml: string, qualified?: ReadonlySet<string>, signOutLabel?: string): HomeDesktopModel => {
  const { locale } = facts
  const t = translator(locale)
  const groups = groupViews(locale, false, item => liveHint(item, facts, false), qualified)
  const generation = liveGeneration(facts)
  return {
    locale, username: facts.username, domain: facts.domain, planLabel: facts.planLabel,
    diskLabel: t('Disk'), diskValue: resourceLine(facts, 'disk'), diskPct: resourcePct(facts, 'disk'),
    procLabel: t('Processes'), procValue: resourceLine(facts, 'processes'), procPct: resourcePct(facts, 'processes'),
    nav: navViews(locale, 'nav-group-'),
    title: t('Home'), ledeHtml: liveLede(facts),
    pill: generation.pill, generationHtml: generation.html,
    bannerHtml: null, bannerHref: '/metrics/traffic', bannerLabel: t('See bandwidth by domain'),
    countText: totalCount(groups, locale, false), groups,
    infoTitle: t('General information'),
    info: infoRows({ locale, username: facts.username, uid: facts.uid, domain: facts.domain, home: facts.home, ipv4: facts.ipv4, plan: facts.planLabel, php: facts.php, slice: facts.slice, signInHtml: facts.signInHtml ?? signInEmpty(localeDirection(locale) === 'rtl') }),
    usageTitle: t('Resource usage'), usageLink: t('Details'),
    meters: liveDesktopMeters(facts),
    changesTitle: t('Recent changes'), changes: facts.changes ?? [],
    emptyChanges: t('No changes are recorded for this account yet.'),
    metricsUnavailable: !facts.sampled, actionHtml,
    ...(signOutLabel ? { signOutLabel } : {}),
  }
}

const phoneFromFacts = (facts: LiveFacts, actionHtml: string, titleTag: 'h1' | 'div', qualified?: ReadonlySet<string>, signOutLabel?: string): HomePhoneModel => {
  const { locale } = facts
  const groups = groupViews(locale, true, item => liveHint(item, facts, true), qualified).map((group, index) => ({ ...group, open: index === 0 }))
  return {
    locale, username: facts.username, domain: facts.domain, planLabel: facts.planLabel,
    title: translator(locale)('Home'), titleTag, ledeHtml: livePhoneLede(facts),
    countText: totalCount(groups, locale, true), groups, meters: livePhoneMeters(facts),
    nav: navViews(locale, 'm-nav-group-'), metricsUnavailable: !facts.sampled, actionHtml,
    ...(signOutLabel ? { signOutLabel } : {}),
  }
}

export interface XpanelHomeProps {
  locale?: Locale
  theme?: 'dark' | 'light'
  realtimeEnabled?: boolean
  account: { username: string; uid: number; home: string; primaryDomain: string; ipv4: string }
  plan?: {
    name: string
    resources?: {
      diskMb: number | 'unlimited'
      bandwidthMbMonth: number | 'unlimited'
      memoryMb: number | 'unlimited'
      maxProcesses: number | 'unlimited'
      ioWriteBps: number | 'unlimited'
    }
    caps?: {
      addonDomains: number | 'unlimited'
      mailboxes: number | 'unlimited'
      databases: number | 'unlimited'
    }
  }
  domains?: Array<{ kind: string; name: string; php?: { version: string; handler: string } }>
  databases?: Array<{ trashedAt: string | null }>
  databaseUsers?: readonly unknown[]
  serviceUsers?: Array<{ services: { email: boolean; ftp: boolean } }>
  files?: Array<{ trashed?: boolean }>
  dnsRecords?: Array<{ zone: string }>
  generationId?: number
  actionHtml?: string
  /** Routes this account may open. Omit it for the board specimen, which links every tool. */
  qualifiedRoutes?: ReadonlySet<string>
  signOutLabel?: string
  lastSignInAt?: string
  recentChanges?: HomeChange[]
  /** A host sample. Absent means the meters stay unknown. */
  usage?: {
    phpVersion: string | null
    diskBytes: number | null
    memoryBytes: number | null
    processCount: number | null
    bandwidth: 'unmeasured'
    ioEnforced?: boolean | null
    bandwidthMonth?: { month: string; totalBytes: number | null; limitBytes: number | null; usedPercent: number | null; enforced: boolean; limited: boolean }
  }
}

const factsFromProps = (props: XpanelHomeProps): LiveFacts => {
  const locale = props.locale ?? SOURCE_LOCALE
  const domains = props.domains ?? []
  const primary = domains.find(domain => domain.kind === 'primary') ?? domains.find(domain => domain.name === props.account.primaryDomain)
  const handler = primary?.php?.handler
  const unitVersion = props.usage?.phpVersion && /^\d+\.\d+$/.test(props.usage.phpVersion) ? props.usage.phpVersion : null
  const version = unitVersion ?? primary?.php?.version ?? null
  const phpName = unitVersion ? 'PHP-FPM' : handler === 'fpm' ? 'PHP-FPM' : handler === 'cgi' ? 'CGI' : handler === 'suphp' ? 'suPHP' : handler === 'lsphp' ? 'lsphp' : null
  const resources = props.plan?.resources
  const caps = props.plan?.caps
  const io = finite(resources?.ioWriteBps)
  const diskMb = finite(resources?.diskMb)
  const memoryMb = finite(resources?.memoryMb)
  return {
    locale,
    username: props.account.username,
    domain: props.account.primaryDomain,
    home: props.account.home,
    uid: props.account.uid,
    ipv4: props.account.ipv4,
    planLabel: props.plan?.name ? formatDisplayName(props.plan.name) : '—',
    php: version && phpName ? `${version} · ${phpName}` : '—',
    phpShort: version,
    phpHint: version ? (unitVersion || handler === 'fpm' ? `${version} · FPM` : version) : null,
    slice: `xpanel-${props.account.uid}.slice`,
    addonDomains: domains.filter(domain => domain.kind === 'addon').length,
    addonCap: finite(caps?.addonDomains),
    databases: (props.databases ?? []).filter(database => !database.trashedAt).length,
    databaseCap: finite(caps?.databases),
    databaseUsers: props.databaseUsers?.length ?? 0,
    mailboxes: (props.serviceUsers ?? []).filter(user => user.services.email).length,
    mailboxCap: finite(caps?.mailboxes),
    ftpUsers: (props.serviceUsers ?? []).filter(user => user.services.ftp).length,
    trashFiles: (props.files ?? []).filter(file => file.trashed).length,
    zones: new Set((props.dnsRecords ?? []).map(record => record.zone)).size,
    sites: domains.length,
    diskLimit: diskMb === null ? null : storage(diskMb),
    bandwidthLimit: finite(resources?.bandwidthMbMonth) === null ? null : storage(finite(resources?.bandwidthMbMonth) ?? 0),
    bandwidthBytes: props.usage?.bandwidthMonth?.totalBytes ?? null,
    bandwidthLimited: props.usage?.bandwidthMonth?.limited === true,
    memoryLimit: memoryMb === null ? null : formatAsciiBytes(memoryMb * 1024 * 1024),
    processLimit: finite(resources?.maxProcesses) === null ? null : String(finite(resources?.maxProcesses)),
    ioLimit: io === null ? null : `${formatAsciiBytes(io)}/s`,
    ioEnforced: typeof props.usage?.ioEnforced === 'boolean' ? props.usage.ioEnforced : null,
    sampled: props.usage !== undefined,
    diskBytes: props.usage?.diskBytes ?? null,
    memoryBytes: props.usage?.memoryBytes ?? null,
    processCount: props.usage?.processCount ?? null,
    diskCapBytes: diskMb === null ? null : diskMb * 1024 * 1024,
    memoryCapBytes: memoryMb === null ? null : memoryMb * 1024 * 1024,
    processCap: finite(resources?.maxProcesses),
    ...(props.lastSignInAt ? { signInHtml: localeDirection(locale) === 'rtl' ? `<bdi dir="ltr">${escapeHtml(formatUtcClock(props.lastSignInAt))}</bdi>` : escapeHtml(formatUtcClock(props.lastSignInAt)) } : {}),
    ...(props.recentChanges ? { changes: props.recentChanges } : {}),
    ...(props.generationId ? { generationId: props.generationId } : {}),
  }
}

export const xpanelHomeFromProps = (props: XpanelHomeProps): { desktop: HomeDesktopModel; phone: HomePhoneModel } => {
  const facts = factsFromProps(props)
  const actionHtml = props.actionHtml ?? ''
  const theme = props.theme ?? 'dark'
  const desktop = desktopFromFacts(facts, actionHtml, props.qualifiedRoutes, props.signOutLabel)
  const phone = phoneFromFacts(facts, actionHtml, 'div', props.qualifiedRoutes, props.signOutLabel)
  return {
    desktop: { ...desktop, theme, realtimeEnabled: props.realtimeEnabled === true },
    phone: { ...phone, theme, realtimeEnabled: props.realtimeEnabled === true },
  }
}

const homeControls = (model: { locale: Locale; theme?: 'dark' | 'light'; realtimeEnabled?: boolean }): string => {
  const { locale } = model
  const nextTheme = model.theme === 'dark' ? 'light' : 'dark'
  const themeLabel = translator(locale)(nextTheme === 'light' ? msgctxt('xpanel-home', 'Light') : msgctxt('xpanel-home', 'Dark'))
  return `${renderPageSearchButton(locale)}${renderLiveUpdatesIndicator(locale, model.realtimeEnabled === true)}<a href="?theme=${nextTheme}" class="xp-btn xp-btn--ghost" data-theme-toggle="${nextTheme}">${themeLabel}</a>`
}

const sideMeter = (label: string, value: string, pct: number, rtl: boolean): string => {
  const shown = rtl ? `<bdi dir="ltr" style="color: light-dark(#344054,var(--xp-text-secondary,#344054)); font-weight: 500; font-variant-numeric: tabular-nums">${escapeHtml(value)}</bdi>` : `<span style="color: light-dark(#344054,var(--xp-text-secondary,#344054)); font-weight: 500; font-variant-numeric: tabular-nums">${escapeHtml(value)}</span>`
  return `<div style="display: flex; flex-direction: column; gap: 5px"><div style="display: flex; justify-content: space-between; gap: 8px; font-size: 12px"><span style="color: light-dark(#475467,var(--xp-text-secondary,#475467))">${escapeHtml(label)}</span>${shown}</div><div aria-hidden="true" style="height: 6px; border-radius: 3px; background: light-dark(#E9ECF1,var(--xp-border,#E9ECF1)); overflow: hidden"><div style="width: ${pct}%; height: 6px; border-radius: 3px; background: #1D5BD6"></div></div></div>`
}

export const renderDesktop = (model: HomeDesktopModel): string => {
  const { locale } = model
  const t = translator(locale)
  const rtl = localeDirection(locale) === 'rtl'
  const brand = rtl
    ? `<bdi dir="ltr" style="font-family: ${MONO}; font-size: 17px; font-weight: 500; color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))">xPanel</bdi>`
    : `<span style="font-family: ${MONO}; font-size: 17px; font-weight: 500; color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))">xPanel</span>`
  const identityAlign = rtl ? ' align-items: flex-start;' : ''
  const planPill = rtl ? `<bdi dir="ltr">${escapeHtml(model.planLabel)}</bdi>` : escapeHtml(model.planLabel)
  const domainPill = rtl ? `<bdi dir="ltr">${escapeHtml(model.domain)}</bdi>` : escapeHtml(model.domain)
  const countStyle = rtl ? 'font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))' : 'font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); font-variant-numeric: tabular-nums'
  const groups = model.groups.map((group, index) => {
    const tools = group.tools.map(item => toolRow(item, rtl, false)).join('')
    return `<section data-tool-group="true" data-show="flex" data-size="${group.size}" data-group-label="${escapeHtml(group.label)}" aria-labelledby="tools-group-${index}" style="display: flex; flex-direction: column; gap: 6px; padding: 16px 12px 10px; border-radius: 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
                <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 0 8px">
                  <h3 id="tools-group-${index}" style="margin: 0; font-size: 15px; font-weight: 600">${escapeHtml(group.label)}</h3>
                  <span data-group-count="true" data-rest="${escapeHtml(group.countText)}" style="${countStyle}">${escapeHtml(group.countText)}</span>
                </div>
                <ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column">${tools}</ul>
              </section>`
  }).join('')
  const info = model.info.map((row, index) => `<div style="display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 9px 0${index ? '; border-top: 1px solid light-dark(#EEF0F3,var(--xp-border,#EEF0F3))' : ''}"><dt style="font-size: 13px; color: light-dark(#475467,var(--xp-text-secondary,#475467))">${escapeHtml(row.label)}</dt><dd style="${row.ddStyle}">${row.valueHtml}</dd></div>`).join('')
  const meters = model.meters.map(meter => {
    const paint = meterPaint(meter.pct)
    const value = rtl
      ? `<bdi dir="ltr" style="color: light-dark(#475467,var(--xp-text-secondary,#475467)); font-variant-numeric: tabular-nums">${escapeHtml(meter.value)}</bdi>`
      : `<span style="color: light-dark(#475467,var(--xp-text-secondary,#475467)); font-variant-numeric: tabular-nums">${escapeHtml(meter.value)}</span>`
    return `<li style="display: flex; flex-direction: column; gap: 6px"><div style="display: flex; justify-content: space-between; gap: 8px; font-size: 13px"><span style="font-weight: 600">${escapeHtml(meter.label)}</span>${value}</div><div aria-hidden="true" style="height: 8px; border-radius: 4px; background: light-dark(#E9ECF1,var(--xp-border,#E9ECF1)); overflow: hidden"><div style="height: 8px; width: ${meter.pct}%; background: ${themeColor(paint.color)}; border-radius: 4px"></div></div><span style="font-size: 12px; color: ${themeColor(paint.noteColor)}">${rtl ? isolateLtrRuns(meter.note) : escapeHtml(meter.note)}</span></li>`
  }).join('')
  const line = rtl ? '1.7' : '1.6'
  const changes = model.changes.length
    ? `<ol style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column">${model.changes.map((change, index) => {
        const last = index === model.changes.length - 1
        const pad = model.changes.length === 1 ? '0' : index === 0 ? '0 0 12px' : last ? '12px 0 0' : '12px 0'
        const border = index === 0 ? '' : '; border-top: 1px solid light-dark(#EEF0F3,var(--xp-border,#EEF0F3))'
        const action = change.actionHref ? `<a href="${escapeHtml(change.actionHref)}" style="align-self: flex-start; min-height: 44px; display: inline-flex; align-items: center; font-size: 13px; font-weight: 600">${escapeHtml(change.actionLabel ?? '')}</a>` : ''
        return `<li style="display: flex; flex-direction: column; gap: 4px; padding: ${pad}${border}"><div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px">${pill(change.pill, change.pillBg, change.pillFg)}<span style="font-size: 14px; font-weight: 600">${change.titleHtml}</span></div>${change.detailHtml ? `<span style="font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); line-height: ${line}">${change.detailHtml}</span>` : ''}${action}</li>`
      }).join('')}</ol>`
    : `<p role="status" style="margin: 0; font-size: 13px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); line-height: ${line}">${escapeHtml(model.emptyChanges)}</p>`
  const banner = model.bannerHtml
    ? `<div role="status" style="display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 0 14px; border-radius: 10px; border: 1px solid light-dark(#F9C9A0,var(--xp-status-warn-border,#F9C9A0)); background: light-dark(#FFF6EE,var(--xp-status-warn-bg,#FFF6EE)); font-size: 13px; line-height: ${line}">${warnIcon}<span style="flex: 1 1 320px; padding: ${rtl ? '10px' : '11px'} 0">${model.bannerHtml}</span><a href="${escapeHtml(model.bannerHref)}" style="min-height: 44px; display: inline-flex; align-items: center; font-weight: 600">${escapeHtml(model.bannerLabel)}</a></div>`
    : ''
  const filterExtra = rtl ? ' dir="auto" style="width: 100%; min-height: 44px; padding-inline-start: 40px; padding-inline-end: 12px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); font-family: inherit; font-size: 14px; color: light-dark(#101828,var(--xp-text-primary,#101828)); text-align: start"' : ' style="width: 100%; min-height: 44px; padding-inline-start: 40px; padding-inline-end: 12px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); font-family: inherit; font-size: 14px; color: light-dark(#101828,var(--xp-text-primary,#101828))"'
  return `<div class="xp-board-port" data-home-desktop="true" data-locale="${locale}"${rtl ? ' dir="rtl"' : ''} style="min-height: 100vh; display: flex; flex-wrap: wrap; background: light-dark(#F5F6F8,var(--xp-bg-canvas,#F5F6F8)); color: light-dark(#101828,var(--xp-text-primary,#101828))">
  <style>${PORT_CSS}</style>
  <nav data-xp-sidebar aria-label="${t('xPanel navigation')}" style="flex: 1 1 248px; max-width: 100%; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border-inline-end: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC)); padding: 20px 14px; display: flex; flex-direction: column; gap: 16px">
    <a href="/home" style="display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 4px; text-decoration: none; color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))">
      <span aria-hidden="true" style="width: 36px; height: 36px; border-radius: 8px; background: #101828; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 18px; font-weight: 600">x</span>
      ${brand}
    </a>
    <div style="display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: 12px; border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC)); background: light-dark(#F8F9FB,var(--xp-bg-elevated,#F8F9FB))">
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px">
        <div style="display: flex; flex-direction: column;${identityAlign} gap: 2px; min-width: 0">
          ${rtl ? `<bdi dir="ltr" style="font-family: ${MONO}; font-size: 14px; font-weight: 600; color: light-dark(#101828,var(--xp-text-primary,#101828))">${escapeHtml(model.username)}</bdi><bdi dir="ltr" style="font-family: ${MONO}; font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); overflow-wrap: anywhere">${escapeHtml(model.domain)}</bdi>` : `<span style="font-family: ${MONO}; font-size: 14px; font-weight: 600; color: light-dark(#101828,var(--xp-text-primary,#101828))">${escapeHtml(model.username)}</span><span style="font-family: ${MONO}; font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); overflow-wrap: anywhere">${escapeHtml(model.domain)}</span>`}
        </div>
        <span style="display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 999px; background: light-dark(#EEF0F3,var(--xp-bg-elevated,#EEF0F3)); color: light-dark(#344054,var(--xp-text-secondary,#344054)); font-size: 12px; font-weight: 600">${planPill}</span>
      </div>
      ${sideMeter(model.diskLabel, model.diskValue, model.diskPct, rtl)}
      ${sideMeter(model.procLabel, model.procValue, model.procPct, rtl)}
    </div>
    ${navHtml(model.nav, locale, false)}
  </nav>
  <main id="main-content" tabindex="-1" data-home-main="desktop" style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column">
    <header style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px clamp(16px, 3vw, 32px); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border-bottom: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
      <div role="search" style="position: relative; flex: 1 1 260px; max-width: 420px">
        ${searchIcon}
        <input id="home-header-search" type="search" aria-describedby="tool-filter-count" aria-label="${t('Find a tool, domain or mailbox')}" placeholder="${t('Find a tool')}" style="width: 100%; min-height: 44px; padding-inline-start: 40px; padding-inline-end: 44px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#F8F9FB,var(--xp-bg-elevated,#F8F9FB)); font-family: inherit; font-size: 14px; color: light-dark(#101828,var(--xp-text-primary,#101828))">
        <kbd aria-hidden="true" style="position: absolute; inset-inline-end: 10px; top: 11px; min-width: 22px; height: 22px; padding: 0 6px; display: flex; align-items: center; justify-content: center; border-radius: 6px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); color: light-dark(#475467,var(--xp-text-secondary,#475467)); font-family: ${MONO}; font-size: 12px">/</kbd>
      </div>
      <span style="flex: 1 1 auto"></span>
      <span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: light-dark(#EEF0F3,var(--xp-bg-elevated,#EEF0F3)); color: light-dark(#344054,var(--xp-text-secondary,#344054)); font-size: 12px; font-weight: 600; font-family: ${MONO}">${domainPill}</span>
      ${homeControls(model)}
      ${langLinks(locale, false)}
      ${model.signOutLabel ? `<button type="button" data-action="logout" style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); color: light-dark(#344054,var(--xp-text-secondary,#344054)); font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${escapeHtml(model.signOutLabel)}</button>` : ''}
      <button type="button" aria-label="${t('User menu, {username}', { username: escapeHtml(model.username) })}" style="width: 44px; height: 44px; border-radius: 50%; border: 1px solid light-dark(#C7D7F8,var(--xp-accent-border,#C7D7F8)); background: light-dark(#E8EFFD,var(--xp-accent-soft,#E8EFFD)); color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6)); font-family: ${MONO}; font-size: 15px; font-weight: 600">${escapeHtml(model.username.slice(0, 1).toLowerCase())}</button>
    </header>
    <div style="width: 100%; max-width: 1180px; margin: 0 auto; padding: 24px clamp(16px, 3vw, 32px) 52px; display: flex; flex-direction: column; gap: 26px">
      ${model.actionHtml}
      <div style="display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 24px">
        <div style="display: flex; flex-direction: column; gap: 6px; min-width: 0; max-width: 68ch">
          <h1 style="margin: 0; font-size: 22px; font-weight: 600">${escapeHtml(model.title)}</h1>
          <p style="margin: 0; font-size: 14px; color: light-dark(#475467,var(--xp-text-secondary,#475467)); line-height: ${line}">${model.ledeHtml}</p>
        </div>
        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; color: light-dark(#475467,var(--xp-text-secondary,#475467))">
          ${model.pill ? pill(model.pill.label, model.pill.bg, model.pill.fg) : ''}
          ${model.generationHtml}
        </div>
      </div>
      ${banner}
      <div style="display: flex; flex-wrap: wrap; align-items: flex-start; gap: 26px">
        <section data-tool-section="true" aria-labelledby="tools-title" style="flex: 1.618 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 16px">
          <div style="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px">
            <h2 id="tools-title" style="margin: 0; font-size: 16px; font-weight: 600">${t('Tools')}</h2>
            <span id="tool-filter-count" role="status" data-rest="${escapeHtml(model.countText)}" style="${countStyle}">${escapeHtml(model.countText)}</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px">
            <label for="tool-filter" style="font-size: 13px; font-weight: 600">${t('Filter tools')}</label>
            <div style="position: relative">
              ${searchIcon}
              <input id="tool-filter" type="search"${filterExtra} autocomplete="off" placeholder="${t('Type part of a name, such as cron or ssl')}" aria-describedby="tool-filter-count">
            </div>
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 16px">${groups}</div>
        </section>
        <aside aria-label="${t('Account summary')}" style="flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 26px">
          <section aria-labelledby="info-title" style="display: flex; flex-direction: column; gap: 10px; padding: 20px; border-radius: 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
            <h2 id="info-title" style="margin: 0; font-size: 16px; font-weight: 600">${escapeHtml(model.infoTitle)}</h2>
            <dl style="margin: 0; display: flex; flex-direction: column">${info}</dl>
          </section>
          <section aria-labelledby="usage-title"${model.metricsUnavailable ? ' data-resource-metrics="unavailable"' : ''} style="display: flex; flex-direction: column; gap: 16px; padding: 20px; border-radius: 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
              <h2 id="usage-title" style="margin: 0; font-size: 16px; font-weight: 600">${escapeHtml(model.usageTitle)}</h2>
              <a data-usage-link="true" href="/resources" style="min-height: 44px; display: inline-flex; align-items: center; font-size: 13px; font-weight: 600">${escapeHtml(model.usageLink)}</a>
            </div>
            <ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px">${meters}</ul>
          </section>
          <section aria-labelledby="changes-title" style="display: flex; flex-direction: column; gap: 4px; padding: 20px; border-radius: 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
            <h2 id="changes-title" style="margin: 0 0 8px; font-size: 16px; font-weight: 600">${escapeHtml(model.changesTitle)}</h2>
            ${changes}
          </section>
        </aside>
      </div>
    </div>
  </main>
</div>`
}

const drawerHtml = (model: HomePhoneModel): string => {
  const { locale } = model
  const t = translator(locale)
  const rtl = localeDirection(locale) === 'rtl'
  const card = rtl
    ? `<bdi dir="ltr" style="font-family: ${MONO}; font-size: 14px; font-weight: 600; text-align: right">${escapeHtml(model.username)}</bdi><bdi dir="ltr" style="font-family: ${MONO}; font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); text-align: right; overflow-wrap: anywhere">${escapeHtml(model.domain)}</bdi>`
    : `<span style="font-family: ${MONO}; font-size: 14px; font-weight: 600">${escapeHtml(model.username)}</span><span style="font-family: ${MONO}; font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); overflow-wrap: anywhere">${escapeHtml(model.domain)}</span>`
  return `<template id="xpanel-home-drawer"><div style="position: absolute; inset: 0; z-index: 10"><button type="button" data-home-action="close-menu" aria-label="${t('Close navigation')}" tabindex="-1" style="position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: none; background: light-dark(#10182866,var(--xp-nav-backdrop,#10182866))"></button><div id="m-drawer" tabindex="-1" role="dialog" aria-modal="true" aria-label="${t('xPanel navigation')}" style="position: absolute; top: 0; bottom: 0; inset-inline-start: 0; width: 304px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border-inline-end: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC)); display: flex; flex-direction: column"><div style="flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))"><span aria-hidden="true" style="width: 28px; height: 28px; border-radius: 7px; background: #101828; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 15px; font-weight: 600">x</span><span style="flex: 1 1 auto; font-family: ${MONO}; font-size: 17px; font-weight: 500; color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))">xPanel</span><button type="button" data-home-action="close-menu" aria-label="${t('Close navigation')}" style="flex: none; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); color: light-dark(#344054,var(--xp-text-secondary,#344054))"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></div><nav data-xp-sidebar aria-label="${t('xPanel navigation')}" style="flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 14px 20px; display: flex; flex-direction: column; gap: 14px"><div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-radius: 12px; border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC)); background: light-dark(#F8F9FB,var(--xp-bg-elevated,#F8F9FB))"><div style="display: flex; flex-direction: column; gap: 2px; min-width: 0">${card}</div><span style="display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 999px; background: light-dark(#EEF0F3,var(--xp-bg-elevated,#EEF0F3)); color: light-dark(#344054,var(--xp-text-secondary,#344054)); font-size: 12px; font-weight: 600">${rtl ? `<bdi dir="ltr">${escapeHtml(model.planLabel)}</bdi>` : escapeHtml(model.planLabel)}</span></div>${navHtml(model.nav, locale, true)}</nav></div></div></template>`
}

export const renderPhone = (model: HomePhoneModel): string => {
  const { locale } = model
  const t = translator(locale)
  const rtl = localeDirection(locale) === 'rtl'
  const title = model.titleTag === 'h1'
    ? `<h1 style="margin: 0; font-size: 22px; font-weight: 600">${escapeHtml(model.title)}</h1>`
    : `<div role="heading" aria-level="1" style="margin: 0; font-size: 22px; font-weight: 600">${escapeHtml(model.title)}</div>`
  const meters = model.meters.map(meter => {
    const paint = meterPaint(meter.pct)
    const value = rtl
      ? `<bdi dir="ltr" style="font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums">${escapeHtml(meter.value)}</bdi>`
      : `<span style="font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums">${escapeHtml(meter.value)}</span>`
    return `<li style="flex: none; width: 150px; scroll-snap-align: start; display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))"><span style="font-size: 12px; color: light-dark(#475467,var(--xp-text-secondary,#475467))">${escapeHtml(meter.label)}</span>${value}<div aria-hidden="true" style="height: 6px; border-radius: 3px; background: light-dark(#E9ECF1,var(--xp-border,#E9ECF1)); overflow: hidden"><div style="height: 6px; width: ${meter.pct}%; background: ${themeColor(paint.color)}; border-radius: 3px"></div></div><span style="font-size: 12px; color: ${themeColor(paint.noteColor)}; font-weight: ${paint.noteWeight}">${rtl ? isolateLtrRuns(meter.note) : escapeHtml(meter.note)}</span></li>`
  }).join('')
  const groups = model.groups.map((group, index) => {
    const tools = group.tools.map(item => toolRow(item, rtl, true)).join('')
    const open = group.open
    return `<section data-tool-group="true" data-show="block" data-size="${group.size}" data-group-label="${escapeHtml(group.label)}" aria-labelledby="m-group-${index}" style="border-radius: 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC)); overflow: hidden">
          <h3 id="m-group-${index}" style="margin: 0; font-size: 15px; font-weight: 600">
            <button type="button" data-home-action="toggle-group" data-user-open="${open ? 'true' : 'false'}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="m-group-tools-${index}" style="width: 100%; min-height: 52px; display: flex; align-items: center; gap: 12px; padding: 0 16px; border: none; background: transparent; font-family: inherit; font-size: 15px; font-weight: 600; color: light-dark(#101828,var(--xp-text-primary,#101828)); text-align: start">
              <span style="flex: 1 1 auto">${escapeHtml(group.label)}</span>
              <span data-group-count="true" data-rest="${escapeHtml(group.countText)}" style="font-size: 12px; font-weight: 500; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); font-variant-numeric: tabular-nums">${escapeHtml(group.countText)}</span>
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="light-dark(#475467,var(--xp-text-secondary,#475467))" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex: none; transform: ${open ? 'rotate(180deg)' : 'none'}"><path d="M6 9l6 6 6-6"></path></svg>
            </button>
          </h3>
          <ul id="m-group-tools-${index}" data-tool-panel="true" style="display: ${open ? 'flex' : 'none'}; flex-direction: column; list-style: none; margin: 0; padding: 4px 8px 8px; border-top: 1px solid light-dark(#EEF0F3,var(--xp-border,#EEF0F3))">${tools}</ul>
        </section>`
  }).join('')
  const brand = rtl
    ? `<bdi dir="ltr" style="font-family: ${MONO}; font-size: 17px; font-weight: 500; color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))">xPanel</bdi>`
    : `<span style="font-family: ${MONO}; font-size: 17px; font-weight: 500; color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))">xPanel</span>`
  const filterStyle = rtl
    ? 'width: 100%; min-height: 44px; padding-inline-start: 40px; padding-inline-end: 12px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); font-family: inherit; font-size: 16px; color: light-dark(#101828,var(--xp-text-primary,#101828)); text-align: start'
    : 'width: 100%; min-height: 44px; padding-inline-start: 40px; padding-inline-end: 12px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); font-family: inherit; font-size: 16px; color: light-dark(#101828,var(--xp-text-primary,#101828))'
  return `<div class="xp-board-port" data-home-phone="true" data-locale="${locale}"${rtl ? ' dir="rtl"' : ''} style="width: 390px; height: 844px; position: relative; overflow: hidden; display: flex; flex-direction: column; background: light-dark(#F5F6F8,var(--xp-bg-canvas,#F5F6F8)); color: light-dark(#101828,var(--xp-text-primary,#101828))">
  <style>${PORT_CSS}</style>
  <header style="flex: none; min-height: 64px; display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border-bottom: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
    <button type="button" id="xpanel-home-menu" data-home-action="open-menu" aria-label="${t('Open navigation')}" aria-expanded="false" aria-controls="m-drawer" style="flex: none; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); color: light-dark(#344054,var(--xp-text-secondary,#344054))"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"></path></svg></button>
    <a href="/home" style="display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 4px; text-decoration: none">${`<span aria-hidden="true" style="width: 28px; height: 28px; border-radius: 7px; background: #101828; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 15px; font-weight: 600">x</span>`}${brand}</a>
    <span style="flex: 1 1 auto"></span>
    ${model.signOutLabel ? `<button type="button" data-action="logout" style="flex: none; min-height: 44px; padding: 0 10px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); color: light-dark(#344054,var(--xp-text-secondary,#344054)); font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer">${escapeHtml(model.signOutLabel)}</button>` : ''}
    <button type="button" aria-label="${t('User menu, {username}', { username: escapeHtml(model.username) })}" style="flex: none; width: 44px; height: 44px; border-radius: 50%; border: 1px solid light-dark(#C7D7F8,var(--xp-accent-border,#C7D7F8)); background: light-dark(#E8EFFD,var(--xp-accent-soft,#E8EFFD)); color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6)); font-family: ${MONO}; font-size: 15px; font-weight: 600">${escapeHtml(model.username.slice(0, 1).toLowerCase())}</button>
  </header>
  <main tabindex="-1" data-home-main="phone" style="flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px 16px 32px; display: flex; flex-direction: column; gap: 16px">
    ${model.actionHtml}
    <div style="display: flex; flex-direction: column; gap: 4px">${title}<p style="margin: 0; font-size: 13px; color: light-dark(#475467,var(--xp-text-secondary,#475467)); line-height: ${rtl ? '1.7' : '1.6'}">${model.ledeHtml}</p></div>
    <div style="position: relative">
      <label for="m-filter" style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap">${t('Filter tools')}</label>
      ${searchIcon}
      <input id="m-filter" type="search"${rtl ? ' dir="auto"' : ''} autocomplete="off" placeholder="${t('Find a tool')}" aria-describedby="m-filter-count" style="${filterStyle}">
    </div>
    <section aria-labelledby="m-usage-title"${model.metricsUnavailable ? ' data-resource-metrics="unavailable"' : ''} style="display: flex; flex-direction: column; gap: 4px">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
        <h2 id="m-usage-title" style="margin: 0; font-size: 15px; font-weight: 600">${t('Usage')}</h2>
        <a data-usage-link="true" href="/resources" style="min-height: 44px; display: inline-flex; align-items: center; font-size: 13px; font-weight: 600">${t('All limits')}</a>
      </div>
      <ul tabindex="0" aria-label="${t('Usage meters, scroll sideways for more')}" style="list-style: none; margin: 0 -16px; padding: 0 16px 6px; display: flex; gap: 8px; overflow-x: auto; scroll-snap-type: x mandatory; scroll-padding-inline: 16px">${meters}</ul>
    </section>
    <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 8px">
      <h2 style="margin: 0; font-size: 15px; font-weight: 600">${t('Tools')}</h2>
      <span id="m-filter-count" role="status" data-rest="${escapeHtml(model.countText)}" style="font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); font-variant-numeric: tabular-nums">${escapeHtml(model.countText)}</span>
    </div>
    <div data-tool-section="true" style="display: flex; flex-direction: column; gap: 8px; margin-top: -8px">${groups}</div>
    <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px">${homeControls(model)}${langLinks(locale, true)}</div>
  </main>
  <div id="xpanel-home-drawer-host" hidden></div>
  ${drawerHtml(model)}
</div>`
}

export const HOME_SCRIPT = `<script>
(function () {
  var wireFilter = function (inputId, countId, rootSel, phone, peerId) {
    var input = document.getElementById(inputId)
    var peer = peerId ? document.getElementById(peerId) : null
    var count = document.getElementById(countId)
    var root = document.querySelector(rootSel)
    if (!input || !root) return
    var rtl = root.getAttribute('dir') === 'rtl'
    var update = function () {
      if (peer) peer.value = input.value
      var raw = input.value.trim()
      var q = raw.toLowerCase()
      var groups = root.querySelectorAll('[data-tool-group]')
      var shown = 0
      var total = 0
      for (var i = 0; i < groups.length; i++) {
        var group = groups[i]
        var size = Number(group.getAttribute('data-size') || '0')
        total += size
        var label = (group.getAttribute('data-group-label') || '').toLowerCase()
        var groupHit = q !== '' && label.indexOf(q) !== -1
        var tools = group.querySelectorAll('[data-tool]')
        var hits = 0
        for (var j = 0; j < tools.length; j++) {
          var tool = tools[j]
          var keys = (tool.getAttribute('data-tool-keys') || '').toLowerCase()
          var hit = q === '' || groupHit || keys.indexOf(q) !== -1
          tool.hidden = !hit
          if (hit) hits += 1
        }
        group.style.display = hits ? (group.getAttribute('data-show') || 'flex') : 'none'
        if (hits) shown += hits
        var badge = group.querySelector('[data-group-count]')
        if (badge) badge.textContent = q === '' ? (badge.getAttribute('data-rest') || '') : xpT('{hits} of {size}', { hits: hits, size: size })
        if (phone) {
          var panel = group.querySelector('[data-tool-panel]')
          var toggle = group.querySelector('[data-home-action="toggle-group"]')
          var remembered = toggle && toggle.getAttribute('data-user-open') === 'true'
          var expand = q !== '' ? hits > 0 : remembered
          if (panel) panel.style.display = expand ? 'flex' : 'none'
          if (toggle) {
            toggle.setAttribute('aria-expanded', expand ? 'true' : 'false')
            var chev = toggle.querySelector('svg')
            if (chev) chev.style.transform = expand ? 'rotate(180deg)' : 'none'
          }
        }
      }
      if (count) {
        if (q === '') count.textContent = count.getAttribute('data-rest') || ''
        // The approved LTR phone board shortens the count; the RTL phone board keeps the full sentence.
        else if (phone && !rtl) count.textContent = xpT('{shown} of {total} match', { shown: shown, total: total })
        else count.textContent = xpT('{shown, plural, one {# of {total} tools matches} other {# of {total} tools match}}', { shown: shown, total: total })
      }
      var empty = root.querySelector('[data-tool-empty]')
      var slot = root.querySelector('[data-tool-section]')
      if (!empty && slot && q && shown === 0) {
        empty = document.createElement('div')
        empty.setAttribute('data-tool-empty', 'true')
        empty.style.cssText = phone
          ? 'display:flex;flex-direction:column;align-items:center;gap:8px;padding:28px 20px;border-radius:12px;background:light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF));border:1px dashed light-dark(#C9CFD8,var(--xp-border-strong,#C9CFD8));text-align:center'
          : 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:40px 24px;border-radius:12px;background:light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF));border:1px dashed light-dark(#C9CFD8,var(--xp-border-strong,#C9CFD8));text-align:center'
        if (!phone) {
          var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          icon.setAttribute('aria-hidden', 'true')
          icon.setAttribute('width', '40')
          icon.setAttribute('height', '40')
          icon.setAttribute('viewBox', '0 0 24 24')
          icon.setAttribute('fill', 'none')
          icon.setAttribute('stroke', 'light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))')
          icon.setAttribute('stroke-width', '1.6')
          icon.setAttribute('stroke-linecap', 'round')
          var path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          path.setAttribute('d', 'M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0M20 20l-4-4')
          icon.appendChild(path)
          empty.appendChild(icon)
        }
        var heading = document.createElement('h3')
        heading.setAttribute('style', 'margin:0;font-size:' + (phone ? '15px' : '16px') + ';font-weight:600')
        var queryNode = rtl ? document.createElement('bdi') : document.createElement('span')
        queryNode.setAttribute('data-empty-query', 'true')
        // The query node replaces a marker, so the translation decides where the query sits.
        var marker = '\\u0001'
        var around = xpT('No tool matches “{query}”', { query: marker }).split(marker)
        heading.appendChild(document.createTextNode(around[0] || ''))
        heading.appendChild(queryNode)
        heading.appendChild(document.createTextNode(around[1] || ''))
        var copy = document.createElement('p')
        copy.setAttribute('style', phone
          ? 'margin:0;font-size:13px;color:light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E));line-height:1.6'
          : 'margin:0;font-size:13px;color:light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E));max-width:46ch;line-height:' + (rtl ? '1.7' : '1.6'))
        empty.appendChild(heading)
        empty.appendChild(copy)
        slot.appendChild(empty)
      }
      if (empty) {
        empty.style.display = q && shown === 0 ? 'flex' : 'none'
        var query = empty.querySelector('[data-empty-query]')
        var body = empty.querySelector('p')
        if (query) query.textContent = raw
        if (body) body.textContent = phone
          ? (xpT('Clear the field or try a shorter word, such as “mail”.'))
          : (xpT('Clear the field or try a shorter word, such as “mail”. Tools that your plan’s feature list hides do not appear here.'))
      }
    }
    input.addEventListener('input', update)
    if (peer) peer.addEventListener('input', function () { input.value = peer.value; update() })
  }
  wireFilter('tool-filter', 'tool-filter-count', '[data-home-desktop]', false, 'home-header-search')
  wireFilter('m-filter', 'm-filter-count', '[data-home-phone]', true)
  var homeOverlay = null
  var lastHomeFocus = null
  var homeFocusSelector = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), details > summary:first-of-type, [tabindex], [contenteditable="true"]'
  var visibleHomeElement = function (element) {
    if (!element || !element.isConnected || element.closest('[hidden], [inert]') || !element.getClientRects().length) return false
    if (typeof element.checkVisibility === 'function' && !element.checkVisibility()) return false
    var visibility = window.getComputedStyle(element).visibility
    return visibility !== 'hidden' && visibility !== 'collapse'
  }
  var homeFocusTargets = function (drawer) {
    return Array.prototype.filter.call(drawer.querySelectorAll(homeFocusSelector), function (element) {
      return element.tabIndex >= 0 && !element.matches(':disabled') && visibleHomeElement(element)
    })
  }
  var otherHomeModal = function () {
    return Array.prototype.find.call(document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]'), function (element) {
      if (homeOverlay && element === homeOverlay.drawer) return false
      return !element.closest('[hidden]') && element.getClientRects().length &&
        window.getComputedStyle(element).visibility !== 'hidden' &&
        (element.matches('dialog[open]') || !element.closest('[inert]'))
    })
  }
  var focusHomeDrawer = function () {
    if (!homeOverlay || otherHomeModal()) return
    var targets = homeFocusTargets(homeOverlay.drawer)
    var link = targets.find(function (element) { return element.tagName === 'A' })
    ;(link || targets[0] || homeOverlay.drawer).focus({ preventScroll: true })
  }
  var closeHomeMenu = function (restoreFocus) {
    var state = homeOverlay
    if (!state) return
    var ownedFocus = state.host.contains(document.activeElement) || document.activeElement === document.body
    homeOverlay = null
    state.host.hidden = true
    state.host.style.display = 'none'
    state.trigger.setAttribute('aria-expanded', 'false')
    state.inert.forEach(function (previous) {
      if (previous.value === null) previous.element.removeAttribute('inert')
      else previous.element.setAttribute('inert', previous.value)
    })
    state.scroll.forEach(function (previous) {
      previous.values.forEach(function (property) { previous.element.style.removeProperty(property.name) })
      previous.values.forEach(function (property) {
        if (property.value) previous.element.style.setProperty(property.name, property.value, property.priority)
      })
    })
    if (restoreFocus && ownedFocus && !otherHomeModal() && visibleHomeElement(state.trigger)) state.trigger.focus({ preventScroll: true })
  }
  var openHomeMenu = function (trigger) {
    if (homeOverlay || window.innerWidth > 800 || !visibleHomeElement(trigger) || otherHomeModal()) return
    var host = document.getElementById('xpanel-home-drawer-host')
    var template = document.getElementById('xpanel-home-drawer')
    if (!host || !template || !template.content) return
    if (!host.firstElementChild) host.appendChild(template.content.cloneNode(true))
    var drawer = host.querySelector('#m-drawer')
    if (!drawer) return
    var state = { host: host, drawer: drawer, trigger: trigger, inert: [], scroll: [] }
    host.hidden = false
    host.style.display = 'contents'
    trigger.setAttribute('aria-expanded', 'true')
    // Save and restore sibling state at each ancestor, as with the shared shell overlays.
    var current = host
    while (current.parentElement) {
      Array.prototype.forEach.call(current.parentElement.children, function (sibling) {
        if (sibling === current) return
        state.inert.push({ element: sibling, value: sibling.getAttribute('inert') })
        sibling.setAttribute('inert', '')
      })
      current = current.parentElement
      if (current === document.body) break
    }
    ;[document.body, document.documentElement, trigger.closest('[data-home-phone]')].forEach(function (element) {
      if (!element) return
      var values = ['overflow', 'overflow-x', 'overflow-y'].map(function (name) {
        return { name: name, value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) }
      })
      state.scroll.push({ element: element, values: values })
      element.style.setProperty('overflow', 'hidden', 'important')
    })
    homeOverlay = state
    focusHomeDrawer()
  }
  var syncHomeMain = function () {
    var desktop = document.querySelector('[data-home-main="desktop"]')
    var phone = document.querySelector('[data-home-main="phone"]')
    var active = window.innerWidth <= 800 ? phone : desktop
    ;[desktop, phone].forEach(function (element) { if (element && element.id === 'main-content') element.removeAttribute('id') })
    if (active) active.id = 'main-content'
  }
  syncHomeMain()
  document.addEventListener('keydown', function (event) {
    if (!homeOverlay || event.isComposing || otherHomeModal()) return
    // Release the home sheet before the shared client opens its command palette.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { closeHomeMenu(true); return }
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); closeHomeMenu(true); return }
    if (event.key !== 'Tab') return
    var targets = homeFocusTargets(homeOverlay.drawer)
    var first = targets[0], last = targets[targets.length - 1], focused = document.activeElement
    if (!first) { event.preventDefault(); homeOverlay.drawer.focus({ preventScroll: true }) }
    else if (event.shiftKey && (focused === first || focused === homeOverlay.drawer || !homeOverlay.drawer.contains(focused))) { event.preventDefault(); last.focus({ preventScroll: true }) }
    else if (!event.shiftKey && (focused === last || !homeOverlay.drawer.contains(focused))) { event.preventDefault(); first.focus({ preventScroll: true }) }
  }, true)
  document.addEventListener('focusin', function (event) {
    if (event.target.closest && event.target.closest('[data-board-port="xpanel-home"]')) lastHomeFocus = event.target
    if (homeOverlay && !homeOverlay.drawer.contains(event.target) && !otherHomeModal()) focusHomeDrawer()
  })
  window.addEventListener('resize', function () {
    var focused = document.activeElement
    if (focused === document.body && lastHomeFocus && !visibleHomeElement(lastHomeFocus)) focused = lastHomeFocus
    var wasHome = focused && focused.closest && focused.closest('[data-board-port="xpanel-home"]')
    syncHomeMain()
    if (window.innerWidth > 800) closeHomeMenu(false)
    if (wasHome && !visibleHomeElement(focused) && !otherHomeModal()) {
      var main = document.getElementById('main-content')
      if (visibleHomeElement(main)) main.focus({ preventScroll: true })
    }
  })
  window.addEventListener('pagehide', function () { closeHomeMenu(false) })
  document.addEventListener('click', function (event) {
    var target = event.target
    if (!target || !target.closest) return
    var navigation = target.closest('a[href]')
    if (homeOverlay && navigation && homeOverlay.drawer.contains(navigation)) closeHomeMenu(false)
    var button = target.closest('[data-home-action]')
    if (!button) return
    var action = button.getAttribute('data-home-action')
    if (action === 'toggle-group') {
      var panel = document.getElementById(button.getAttribute('aria-controls') || '')
      var nextOpen = button.getAttribute('data-user-open') !== 'true'
      button.setAttribute('data-user-open', nextOpen ? 'true' : 'false')
      var phoneRoot = button.closest('[data-home-phone]')
      var phoneInput = phoneRoot ? phoneRoot.querySelector('#m-filter') : null
      var filtering = !!(phoneInput && phoneInput.value.trim())
      var show = filtering ? true : nextOpen
      button.setAttribute('aria-expanded', show ? 'true' : 'false')
      if (panel) panel.style.display = show ? 'flex' : 'none'
      var chevron = button.querySelector('svg')
      if (chevron) chevron.style.transform = show ? 'rotate(180deg)' : 'none'
    }
    if (action === 'open-menu') openHomeMenu(button)
    if (action === 'close-menu') closeHomeMenu(true)
  })
})()
</script>`

const RESPONSIVE_CSS = `.xp-home-phone-only{display:none}.xp-home-phone-only > [data-home-phone]{width:100% !important;min-inline-size:0;max-inline-size:100%}@media (max-width:800px){.xp-home-desk-only{display:none}.xp-home-phone-only{display:block}}`

export const renderXpanelHome = (model: { desktop: HomeDesktopModel; phone: HomePhoneModel }): string =>
  `<div data-board-port="xpanel-home"><style>${RESPONSIVE_CSS}</style><div class="xp-home-desk-only">${renderDesktop(model.desktop)}</div><div class="xp-home-phone-only">${renderPhone(model.phone)}</div>${HOME_SCRIPT}</div>`
