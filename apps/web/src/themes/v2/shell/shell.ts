// The v2 shell: sidebar, top bar, main landmark and the document chrome the realtime runtime binds.
// It emits the classic shell hooks (data-* attributes, data-action values and element ids) so
// ws-client.js works unchanged; layout and styling are v2's own.

import { canonicalNavigationRoute, visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { catalogText, localeInfo, type Locale, type Translate } from '../../../i18n.ts'
import { brandingProductName } from '../../../branding.ts'
import type { ThemeViewProps } from '../../contract.ts'
import { attr, escapeHtml, hookAttrs, type HookAttributes, type Tone } from '../html.ts'
import { catalogIcon, icon } from '../icons.ts'
import { toastRegion } from '../components/toast-region.ts'
import { activityDrawer, commandPalette, reconcileBanner, type ActivityDrawerProps, type CommandPaletteProps, type ReconcileBannerProps, type V2Surface } from './overlays.ts'

const PRODUCT: Readonly<Record<V2Surface, string>> = { xpanel: 'xPanel', xwhm: 'xWHM', xmail: 'xMail' }

/** Account or server summary at the top of the sidebar. */
export interface NavContext {
  /** Landmark name, such as "Account" or "Server". */
  label: string
  title: string
  /** Avatar initial; without it a server tile is shown. */
  initial?: string
  /** Plan name or role beside the title. */
  badge?: string
  /** Second line, such as the primary domain. */
  detail?: string
  status?: { tone: Tone; label: string }
  meters?: readonly { label: string; valueText: string; percent?: number; tone?: Tone }[]
  /** Small facts on one line, such as the panel version and uptime. */
  meta?: readonly string[]
}

export interface V2ShellProps extends ThemeViewProps {
  surface: V2Surface
  /** The canonical current route; registered aliases mark their parent page. */
  activeRoute: string
  /** The signed-in principal's visibility; the sidebar lists only the pages it may open. */
  visibility?: VisibilityContext
  catalog?: readonly CatalogTool[]
  homeHref: string
  context?: NavContext
  /** Theme-owned account/domain controls below the context summary. */
  contextControlHtml?: string
  /** Theme-owned surface navigation, such as mailbox folders. Omit to use the authorized catalog. */
  sidebarHtml?: string
  /** Theme-owned search control, bound to the surface's existing core controller. */
  searchHtml?: string
  /** Links under the navigation, such as "Open xMail". */
  footerLinks?: readonly { label: string; href: string; external?: boolean }[]
  realtimeEnabled: boolean
  /** Server and active generation chip. */
  server?: { name: string; generationId?: number; tone?: Tone }
  /** Alternate locales with the current page's address in each. */
  languages: readonly { tag: Locale; href: string }[]
  /** The current color scheme and the address of the page in the other one. */
  scheme: { current: 'light' | 'dark'; toggleHref: string }
  /** Unread activity count; the bell opens the activity drawer. Requires `activity`. */
  unread?: number
  account: {
    signedIn: boolean
    username?: string
    roleLabel?: string
    securityHref?: string
    signInHref?: string
    links?: readonly { label: string; href: string; hooks?: HookAttributes }[]
  }
  contentHtml: string
  commandPalette?: Pick<CommandPaletteProps, 'entries'>
  activity?: ActivityDrawerProps
  reconcile?: ReconcileBannerProps
  /** Attributes on the shell root, such as data-account or data-uid. */
  hooks?: HookAttributes
}

const SEARCH_LABELS: Readonly<Record<V2Surface, string>> = {
  xpanel: msgid('Find a tool, domain or mailbox'),
  xwhm: msgctxt('theme:v2', 'Search accounts and settings'),
  xmail: msgctxt('shell', 'Find a page'),
}

function sidebarNavigation(t: Translate, props: V2ShellProps): string {
  const locale = t.locale
  const current = canonicalNavigationRoute(props.activeRoute)
  const nav = visibleNavigation(props.visibility, props.catalog).find(item => item.surface === props.surface)
  const sections = (nav?.sections ?? []).map(section => {
    const name = catalogText(locale, `nav.section.${props.surface}.${section.id}.name`, section.name)
    const open = section.pages.some(page => page.route === current)
    const pages = section.pages.map(page => {
      const here = page.route === current
      const label = catalogText(locale, `nav.page.${props.surface}.${page.id}.name`, page.name)
      return `<li><a href="${escapeHtml(page.route)}" data-nav-route="${escapeHtml(page.route)}"${here ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a></li>`
    }).join('')
    return `<li data-nav-section="${escapeHtml(section.id)}"><details${open ? ' open' : ''}><summary>${icon(catalogIcon(section.icon))}<span>${escapeHtml(name)}</span>${icon('chevRight', 16).replace('class="v2-icon', 'class="v2-icon v2-nav__chev')}</summary><ul aria-label="${escapeHtml(name)}">${pages}</ul></details></li>`
  }).join('')
  const empty = sections ? '' : `<p class="v2-nav__empty" data-navigation-empty="true">${escapeHtml(t('These tools are not available on this server yet.'))}</p>`
  return `<nav class="v2-nav" aria-label="${escapeHtml(t('Hosting tools'))}">${empty}<ul>${sections}</ul></nav>`
}

function contextCard(context: NavContext): string {
  const mark = context.initial
    ? `<span class="v2-ctx__avatar" aria-hidden="true">${escapeHtml(context.initial)}</span>`
    : `<span class="v2-ctx__tile" aria-hidden="true">${icon('server')}</span>`
  const status = context.status ? `<span class="v2-ctx__status v2-ctx__status--${context.status.tone}"><span aria-hidden="true"></span>${escapeHtml(context.status.label)}</span>` : ''
  const meters = (context.meters ?? []).map(m => `<div class="v2-ctx__meter"><div><span>${escapeHtml(m.label)}</span><span class="v2-num">${escapeHtml(m.valueText)}</span></div><div class="v2-ctx__bar" aria-hidden="true"><span class="v2-ctx__fill v2-ctx__fill--${m.tone ?? 'info'}" style="inline-size:${Math.min(100, Math.max(0, m.percent ?? 0))}%"></span></div></div>`).join('')
  const meta = context.meta?.length ? `<div class="v2-ctx__meta v2-num">${context.meta.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''
  return `<section class="v2-ctx" aria-label="${escapeHtml(context.label)}"><div class="v2-ctx__id">${mark}<div class="v2-ctx__text"><span class="v2-ctx__title"><span class="v2-mono">${escapeHtml(context.title)}</span>${context.badge ? `<span class="v2-ctx__badge">${escapeHtml(context.badge)}</span>` : ''}</span>${context.detail ? `<span class="v2-ctx__detail v2-mono">${escapeHtml(context.detail)}</span>` : ''}${status}</div></div>${meters}${meta}</section>`
}

function sidebar(t: Translate, props: V2ShellProps): string {
  const product = brandingProductName(props.branding, PRODUCT[props.surface])
  const subtitle = props.surface === 'xwhm' ? `<span class="v2-brand__sub">${escapeHtml(t('Server administration'))}</span>` : ''
  const footer = props.footerLinks?.length
    ? `<div class="v2-side__foot">${props.footerLinks.map(link => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}${link.external ? icon('external', 16) : ''}</a>`).join('')}</div>` : ''
  return `<aside class="v2-side" id="xp-sidebar" data-xp-sidebar tabindex="-1" aria-label="${escapeHtml(`${product} ${t('navigation')}`)}">
<div class="v2-side__top"><a class="v2-brand" href="${escapeHtml(props.homeHref)}"><span class="v2-brand__mark" aria-hidden="true">x</span><span class="v2-brand__text"><span class="v2-brand__name">${escapeHtml(product)}</span>${subtitle}</span></a><button type="button" class="v2-btn v2-btn--icon v2-side__close" data-action="close-mobile-nav" aria-controls="xp-sidebar" aria-label="${escapeHtml(t(msgctxt('shell', 'Close navigation')))}">${icon('x', 16)}</button></div>
${props.context ? contextCard(props.context) : ''}${props.contextControlHtml ?? ''}
${props.sidebarHtml ?? sidebarNavigation(t, props)}
${footer}
</aside>`
}

function liveIndicator(t: Translate, enabled: boolean): string {
  // The runtime sets data-ws-indicator; each label shows for its state, so no markup update is needed.
  const off = t('Live updates off')
  return `<span class="v2-live" data-ws-indicator="${enabled ? 'disconnected' : 'unavailable'}" role="status"${enabled ? '' : ` aria-label="${escapeHtml(off)}" title="${escapeHtml(off)}"`}><span class="v2-live__dot" aria-hidden="true"></span><span class="v2-live__label" data-ws-label="connected">${escapeHtml(t(msgctxt('ws-client', 'Live')))}</span><span class="v2-live__label" data-ws-label="disconnected">${escapeHtml(t('Connecting'))}</span><span class="v2-live__label" data-ws-label="unavailable">${escapeHtml(off)}</span></span>`
}

function accountMenu(t: Translate, props: V2ShellProps): string {
  const { account } = props
  const name = account.signedIn && account.username ? account.username : t('Account')
  const initial = (account.username?.trim().charAt(0) || name.charAt(0)).toLocaleLowerCase('en')
  const links = [
    ...(account.securityHref ? [`<a class="v2-menu__item" href="${escapeHtml(account.securityHref)}" data-security-link="true">${escapeHtml(t('Security'))}</a>`] : []),
    ...(account.links ?? []).map(link => `<a class="v2-menu__item" href="${escapeHtml(link.href)}"${hookAttrs(link.hooks)}>${escapeHtml(link.label)}</a>`),
  ].join('')
  const session = account.signedIn
    ? `<button type="button" class="v2-menu__item v2-menu__item--danger" data-action="logout">${escapeHtml(t('Sign out'))}</button>`
    : account.signInHref ? `<a class="v2-menu__item" href="${escapeHtml(account.signInHref)}">${escapeHtml(t('Sign in'))}</a>` : ''
  const interfaceChoice = !account.signedIn ? '' : `<section class="v2-ui-theme" data-ui-theme-preferences data-ui-theme-can-read="true" hidden><form data-ui-theme-form hidden><label for="v2-ui-theme-choice"><span>${escapeHtml(t(msgctxt('theme:v2', 'Interface theme')))}</span><select id="v2-ui-theme-choice" name="uiTheme" data-ui-theme-choice disabled><option value="classic">${escapeHtml(t('Classic'))}</option><option value="v2">V2</option></select></label><button class="v2-btn" type="submit" data-ui-theme-save disabled>${escapeHtml(t('Save'))}</button></form><p data-ui-theme-status role="status" aria-live="polite" hidden></p><button class="v2-btn v2-btn--ghost" type="button" data-ui-theme-reload disabled hidden>${escapeHtml(t('Reload'))}</button></section>`
  return `<details class="v2-account" data-user-menu><summary class="v2-btn v2-account__summary" aria-label="${escapeHtml(`${t('User menu for')} ${name}${account.roleLabel ? ` ${account.roleLabel}` : ''}`)}"><span class="v2-account__avatar" aria-hidden="true">${escapeHtml(initial)}</span><span class="v2-account__id"><span${account.username ? ' dir="ltr"' : ''}>${escapeHtml(name)}</span>${account.roleLabel ? `<span>${escapeHtml(account.roleLabel)}</span>` : ''}</span></summary><div class="v2-account__panel">${links}${interfaceChoice}${session}</div></details>`
}

function topbar(t: Translate, props: V2ShellProps): string {
  const searchLabel = t(SEARCH_LABELS[props.surface])
  const server = props.server
    ? `<span class="v2-server v2-num"${attr('data-generation-chip', props.server.generationId)}><span class="v2-server__dot v2-server__dot--${props.server.tone ?? 'ok'}" aria-hidden="true"></span><span class="v2-mono">${escapeHtml(props.server.name)}</span>${props.server.generationId === undefined ? '' : `<span class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'gen {generation}'), { generation: props.server.generationId }))}</span>`}</span>` : ''
  const languages = props.languages.map(language => `<a class="v2-btn v2-top__lang" href="${escapeHtml(language.href)}" lang="${language.tag}" hreflang="${language.tag}" data-lang-switch="${language.tag}">${icon('language', 16)}${escapeHtml(localeInfo(language.tag).nativeName)}</a>`).join('')
  const next = props.scheme.current === 'dark' ? 'light' : 'dark'
  const schemeLabel = next === 'dark' ? t('Dark theme') : t('Light theme')
  const scheme = `<a class="v2-btn v2-btn--icon" href="${escapeHtml(props.scheme.toggleHref)}" data-theme-toggle="${next}" aria-label="${escapeHtml(schemeLabel)}" title="${escapeHtml(schemeLabel)}">${icon(next === 'dark' ? 'moon' : 'sun')}</a>`
  const unread = props.unread ?? 0
  const bell = props.activity
    ? `<button type="button" class="v2-btn v2-btn--icon v2-top__bell" data-action="open-activity-drawer" aria-controls="xp-activity-drawer" aria-label="${escapeHtml(t(msgctxt('theme:v2', '{count, plural, =0 {Notifications, none unread} one {Notifications, # unread} other {Notifications, # unread}}'), { count: unread }))}">${icon('bell')}${unread > 0 ? `<span class="v2-top__badge v2-num" aria-hidden="true">${unread > 99 ? '99+' : unread}</span>` : ''}</button>` : ''
  return `<header class="v2-top" role="banner">
<button type="button" class="v2-btn v2-btn--icon v2-top__menu" data-action="toggle-mobile-nav" aria-controls="xp-sidebar" aria-expanded="false" aria-label="${escapeHtml(t('Menu'))}">${icon('menu')}</button>
<a class="v2-top__brand" href="${escapeHtml(props.homeHref)}">${escapeHtml(brandingProductName(props.branding, PRODUCT[props.surface]))}</a>
<details class="v2-tools" open data-xp-toolbar-options><summary class="v2-btn">${escapeHtml(t('Search & account'))}</summary><div class="v2-tools__content">
${props.searchHtml ?? `<button type="button" class="v2-search" data-action="open-cmdk" aria-keyshortcuts="Control+K Meta+K" aria-label="${escapeHtml(`${searchLabel} Ctrl K`)}">${icon('search')}<span>${escapeHtml(searchLabel)}</span><kbd aria-hidden="true">Ctrl K</kbd></button>`}
<span class="v2-top__spacer"></span>${liveIndicator(t, props.realtimeEnabled)}${server}${languages}${scheme}${bell}${accountMenu(t, props)}
</div></details>
</header>`
}

/** The complete v2 shell for one surface; `contentHtml` is the page body (page header, cards, tables).
 *  Like every kit function with built-in text, it takes the page translator first. */
export function renderV2Shell(t: Translate, props: V2ShellProps): string {
  return `<div class="v2-shell" data-surface="${props.surface}"${hookAttrs(props.hooks)}>
<a class="v2-skip" href="#main-content">${escapeHtml(t('Skip to content'))}</a>
${sidebar(t, props)}
<button type="button" class="v2-backdrop" data-action="close-mobile-nav" data-xp-nav-backdrop hidden tabindex="-1" aria-label="${escapeHtml(t(msgctxt('shell', 'Close navigation')))}"></button>
<div class="v2-work" data-xp-shell-content>
${topbar(t, props)}
<main id="main-content" class="v2-main" tabindex="-1"><div class="v2-page">${props.reconcile ? reconcileBanner(t, props.reconcile) : ''}${props.contentHtml}</div></main>
</div>
${toastRegion(t)}
${props.commandPalette ? commandPalette(t, { surface: props.surface, entries: props.commandPalette.entries }) : ''}
${props.activity ? activityDrawer(t, props.activity) : ''}
</div>`
}

const SIDE = '.v2-side'
export const SHELL_CSS = `.v2-shell{display:flex;min-height:100vh;background:var(--bg)}
.v2-skip{position:fixed;inset-inline-start:var(--space-2);top:-100px;z-index:100;padding:12px var(--space-2);border-radius:var(--radius-control);background:var(--accent-fill);color:var(--on-accent);font-weight:600}
.v2-skip:focus{top:var(--space-2);color:var(--on-accent)}
${SIDE}{flex:0 0 264px;position:sticky;top:0;align-self:flex-start;height:100vh;overflow-y:auto;display:flex;flex-direction:column;gap:var(--space-3);padding:20px var(--space-2);background:var(--nav);color:var(--nav-text);border-inline-end:1px solid var(--nav-line)}
${SIDE} :focus-visible{outline-color:var(--nav-focus)}
${SIDE}__top{display:flex;align-items:center;justify-content:space-between;gap:var(--space-1)}
.v2-brand{display:flex;align-items:center;gap:10px;min-height:var(--target);padding:0 var(--space-1);color:var(--nav-strong);text-decoration:none}
.v2-brand:hover{color:var(--nav-strong)}
.v2-brand__mark{flex:none;display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;background:var(--accent-fill);color:var(--nav-strong);font-family:var(--font-mono);font-size:18px;font-weight:600}
.v2-brand__text{display:flex;flex-direction:column;line-height:1.2}
.v2-brand__name{font-size:18px;font-weight:700;letter-spacing:-.01em}
.v2-brand__sub{font-size:11px;color:var(--nav-muted)}
${SIDE}__close{display:none;border-color:var(--nav-line);background:transparent;color:var(--nav-text)}
.v2-ctx{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-2);border-radius:var(--radius-notice);background:var(--nav-2);border:1px solid var(--nav-line)}
.v2-ctx__id{display:flex;align-items:center;gap:12px;min-width:0}
.v2-ctx__avatar,.v2-ctx__tile{flex:none;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:var(--accent-fill);color:var(--nav-strong);font-weight:600}
.v2-ctx__tile{border-radius:var(--radius-control);background:rgba(76,195,138,.16);color:var(--nav-ok)}
.v2-ctx__text{display:flex;flex-direction:column;gap:2px;min-width:0}
.v2-ctx__title{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1);color:var(--nav-strong);font-size:13px;font-weight:600;overflow-wrap:anywhere}
.v2-ctx__badge{padding:1px var(--space-1);border-radius:var(--radius-pill);border:1px solid var(--nav-line);color:var(--nav-text);font-family:var(--font-sans);font-size:11px;font-weight:600}
.v2-ctx__detail{font-size:12px;color:var(--nav-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v2-ctx__status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--nav-ok)}
.v2-ctx__status>span{width:6px;height:6px;border-radius:50%;background:currentColor}
.v2-ctx__status--warn{color:#F7B865}.v2-ctx__status--bad{color:#F47067}.v2-ctx__status--info,.v2-ctx__status--neutral{color:var(--nav-text)}
.v2-ctx__meter{display:flex;flex-direction:column;gap:var(--space-1);font-size:12px}
.v2-ctx__meter>div:first-child{display:flex;justify-content:space-between;gap:var(--space-1)}
.v2-ctx__meter .v2-num{color:var(--nav-strong)}
.v2-ctx__bar{height:6px;border-radius:3px;background:var(--nav-line);overflow:hidden}
.v2-ctx__fill{display:block;height:100%;border-radius:3px;background:#5B8DF6}
.v2-ctx__fill--warn{background:#F2A33A}.v2-ctx__fill--bad{background:#F47067}.v2-ctx__fill--ok{background:#4CC38A}
.v2-ctx__meta{display:flex;justify-content:space-between;gap:var(--space-1);font-size:12px;color:var(--nav-muted)}
.v2-nav ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.v2-nav summary,.v2-nav a{display:flex;align-items:center;gap:12px;min-height:var(--target);padding:0 12px;border-radius:var(--radius-control);color:var(--nav-text);text-decoration:none;cursor:pointer}
.v2-nav summary{list-style:none;font-weight:500}
.v2-nav summary::-webkit-details-marker{display:none}
.v2-nav summary>span{flex:1 1 auto}
.v2-nav__chev{opacity:.7;transition:transform .15s}
.v2-nav details[open]>summary{background:var(--nav-2);color:var(--nav-strong);font-weight:600}
.v2-nav details[open]>summary .v2-nav__chev{transform:rotate(90deg)}
.v2-nav summary:hover,.v2-nav a:hover{background:var(--nav-2);color:var(--nav-strong)}
.v2-nav details>ul{margin-inline-start:20px;padding-block:4px var(--space-1);padding-inline-start:10px;border-inline-start:1px solid var(--nav-line)}
.v2-nav details a{font-size:13px;border-radius:var(--radius-chip)}
.v2-nav a[aria-current="page"]{background:var(--accent-fill);color:var(--nav-strong);font-weight:600}
.v2-nav__empty{padding:0 12px var(--space-1);font-size:12px;color:var(--nav-muted)}
${SIDE}__foot{margin-top:auto;display:flex;flex-direction:column;gap:var(--space-1);padding-top:var(--space-2);border-top:1px solid var(--nav-line)}
${SIDE}__foot a{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:var(--target);padding:0 12px;border-radius:var(--radius-control);color:var(--nav-text);text-decoration:none}
${SIDE}__foot a:hover{background:var(--nav-2);color:var(--nav-strong)}
.v2-backdrop{position:fixed;inset:0;z-index:60;border:0;background:var(--scrim)}
.v2-work{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
.v2-top{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:12px var(--space-2);min-height:68px;padding:12px clamp(16px,3vw,32px);background:var(--surface);border-bottom:1px solid var(--line)}
.v2-top .v2-btn{border-color:var(--line)}
.v2-top__menu,.v2-top__brand{display:none}
.v2-top__brand{align-items:center;min-height:var(--target);color:var(--text);font-size:18px;font-weight:700;text-decoration:none}
.v2-tools{flex:1 1 auto;min-width:0}
.v2-tools>summary{display:none;list-style:none}
.v2-tools>summary::-webkit-details-marker{display:none}
.v2-tools__content{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.v2-top__spacer{flex:1 1 auto}
.v2-search{flex:1 1 280px;max-width:520px;display:flex;align-items:center;gap:12px;min-height:var(--target);padding-inline:14px 10px;border-radius:var(--radius-control);border:1px solid var(--line);background:var(--subtle);color:var(--muted);font-size:14px;text-align:start;cursor:pointer}
.v2-search:hover{border-color:var(--line-strong)}
.v2-search>span{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v2-search>kbd{flex:none;display:flex;align-items:center;height:22px;padding:0 var(--space-1);border-radius:6px;border:1px solid var(--line-strong);background:var(--surface);font-size:11px}
.v2-live{display:inline-flex;align-items:center;gap:6px;min-height:var(--target);padding:0 4px;font-size:12px;font-weight:600;color:var(--muted)}
.v2-live__dot{width:8px;height:8px;border-radius:50%;box-shadow:inset 0 0 0 1.5px currentColor}
.v2-live__label{display:none}
.v2-live[data-ws-indicator=disconnected] [data-ws-label=disconnected],.v2-live[data-ws-indicator=connected] [data-ws-label=connected],.v2-live[data-ws-indicator=unavailable] [data-ws-label=unavailable]{display:inline}
.v2-live[data-ws-indicator=connected]{color:var(--ok)}
.v2-live[data-ws-indicator=connected] .v2-live__dot{background:currentColor}
.v2-server{display:inline-flex;align-items:center;gap:var(--space-1);min-height:var(--target);padding:0 12px;border-radius:var(--radius-control);border:1px solid var(--line);font-size:13px}
.v2-server>.v2-mono{font-weight:500}
.v2-server__dot{width:8px;height:8px;border-radius:50%;background:var(--ok)}
.v2-server__dot--warn{background:var(--warn)}.v2-server__dot--bad{background:var(--bad)}.v2-server__dot--info{background:var(--accent)}.v2-server__dot--neutral{background:var(--muted)}
.v2-top__lang{padding:0 12px;font-size:13px}
.v2-top__lang>.v2-icon{color:var(--muted)}
.v2-top__bell{position:relative}
.v2-top__badge{position:absolute;top:6px;inset-inline-end:6px;min-width:18px;height:18px;padding:0 5px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-pill);background:var(--bad);color:var(--on-accent);font-size:11px;font-weight:700}
.v2-account{position:relative}
.v2-account__summary{gap:10px;padding:0 var(--space-1);padding-inline-end:12px;list-style:none}
.v2-account__summary::-webkit-details-marker{display:none}
.v2-account__avatar{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-weight:600}
.v2-account__id{display:flex;flex-direction:column;align-items:flex-start;line-height:1.25}
.v2-account__id>:first-child{font-size:13px;font-weight:600}
.v2-account__id>:nth-child(2){font-size:12px;font-weight:400;color:var(--muted)}
.v2-account__panel{position:absolute;z-index:40;inset-inline-end:0;top:calc(100% + 4px);min-inline-size:220px;display:flex;flex-direction:column;padding:4px;border-radius:var(--radius-notice);background:var(--surface);border:1px solid var(--line-strong);box-shadow:0 8px 24px rgba(0,0,0,.12)}
.v2-ui-theme{display:grid;gap:var(--space-3);padding:var(--space-3);border-block:1px solid var(--line)}.v2-ui-theme form{display:grid;gap:var(--space-2)}.v2-ui-theme label{display:grid;gap:var(--space-1)}.v2-ui-theme label>span{padding-inline-start:13px}.v2-ui-theme p{overflow-wrap:anywhere}
.v2-main{flex:1 1 auto;outline:none}
.v2-page{inline-size:100%;max-inline-size:1320px;margin:0 auto;padding:var(--space-3) clamp(16px,3vw,32px) 48px;display:flex;flex-direction:column;gap:var(--space-4)}
@media (max-width:959px){
${SIDE}{display:none}
${SIDE}[aria-modal="true"]{display:flex;position:fixed;inset-block:0;inset-inline-start:0;z-index:70;inline-size:min(320px,88vw);height:100dvh}
${SIDE}__close{display:inline-flex}
.v2-top{flex-wrap:wrap}
.v2-top__menu,.v2-top__brand{display:inline-flex}
.v2-tools>summary{display:flex;inline-size:fit-content;margin-inline-start:auto}
.v2-tools[open]{flex-basis:100%}
.v2-tools__content{inline-size:100%;padding-top:12px}
.v2-search{max-width:none}
}
@media(max-width:640px){.v2-ui-theme{padding:var(--space-2)}}
`
