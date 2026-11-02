import { canonicalNavigationRoute, visibleRegisteredNavigation } from '@xpanel/catalog'
import { publicContactEmail } from '../../../display-name.ts'
import { alternateLocales, catalogText, type Translate } from '../../../i18n.ts'
import { projectActionState } from '../../../models/action-state.ts'
import type { UiTheme, UnavailableProps } from '../../contract.ts'
import { actionState } from '../components/action-state.ts'
import { escapeHtml } from '../html.ts'
import { v2Messages } from '../messages.ts'
import { renderV2Shell } from '../shell/shell.ts'
import { V2_SECURITY_SLOT } from './slots.ts'

export type V2ReadOnlyPage = (props: UnavailableProps) => string | undefined

function registeredSidebar(t: Translate, props: UnavailableProps): string {
  const current = canonicalNavigationRoute(props.route)
  const nav = visibleRegisteredNavigation(props.visibility).find(item => item.surface === props.surface)
  return `<nav class="v2-nav" aria-label="${escapeHtml(t('navigation'))}"><ul>${(nav?.sections ?? []).map(section => `<li data-nav-section="${escapeHtml(section.id)}"><details${section.pages.some(page => page.route === current) ? ' open' : ''}><summary>${escapeHtml(catalogText(props.locale, `nav.section.${props.surface}.${section.id}.name`, section.name))}</summary><ul>${section.pages.map(page => `<li><a href="${escapeHtml(page.route)}" data-nav-route="${escapeHtml(page.route)}" data-nav-wiring="${props.qualifiedRoutes.has(page.route) ? 'live' : 'soon'}"${page.route === current ? ' aria-current="page"' : ''}>${escapeHtml(catalogText(props.locale, `nav.page.${props.surface}.${page.id}.name`, page.name))}</a></li>`).join('')}</ul></details></li>`).join('')}</ul></nav>`
}

function workspaceSummary(props: UnavailableProps): string {
  const view = props.summary
  if (!view) return ''
  return `<section class="v2-card v2-unavailable__summary" data-workspace-identity="true"${props.surface === 'xpanel' ? ' data-workspace-account-overview="true"' : ''} aria-labelledby="v2-workspace-summary-title"><h2 id="v2-workspace-summary-title">${escapeHtml(view.title)}</h2><dl class="v2-unavailable__facts">${view.fields.map(field => `<div data-workspace-field="${escapeHtml(field.key)}"><dt>${escapeHtml(field.label)}</dt><dd>${field.ltr ? `<bdi dir="ltr">${escapeHtml(field.value)}</bdi>` : escapeHtml(field.value)}</dd></div>`).join('')}</dl>${view.accountEmpty && view.accountEmptyText ? `<p data-workspace-account-empty="true">${escapeHtml(view.accountEmptyText)}</p>` : ''}${view.mfaHref && view.mfaText ? `<p data-mfa-optional-link><a href="${escapeHtml(view.mfaHref)}">${escapeHtml(view.mfaText)}</a></p>` : ''}</section>`
}

/** Missing qualified renderers are an integration error, never silently replaced by an unavailable card. */
export function createV2UnavailableRenderer(readOnlyPage: V2ReadOnlyPage): UiTheme['renderUnavailable'] {
  return props => {
    const t = v2Messages.translator(props.locale)
    const layout = props.admitted ? readOnlyPage(props) : undefined
    if (props.admitted && !layout) throw new Error(`v2_unqualified_layout_missing:${props.surface}:${props.route}`)
    if (props.admitted && props.securityPage && layout!.split(V2_SECURITY_SLOT).length !== 2) throw new Error('v2_unqualified_security_slot_missing_or_duplicated')
    const contact = publicContactEmail(props.supportEmail)
    const path = props.route.startsWith('/') ? props.route : '/'
    const href = (locale = props.locale, theme = props.theme) => `${path}?${new URLSearchParams({ lang: locale, theme, density: props.density })}`
    const content = `<section class="v2-unavailable" data-surface="${props.surface}" data-tool-availability="unverified"${props.securityPage ? ' data-security-page="true"' : ''}${props.surface === 'xpanel' && props.route === '/domains/reverse-proxy' ? ' data-unqualified-route="/domains/reverse-proxy"' : ''}>${layout ?? `<h1>${escapeHtml(props.heading)}</h1>`}${props.securityPage && !layout ? V2_SECURITY_SLOT : ''}${props.actionState ? actionState(projectActionState({ ...props.actionState, locale: props.locale })) : ''}${props.securityPage ? '' : workspaceSummary(props)}${!props.securityPage && contact ? `<p>${escapeHtml(t('Write to'))} <a href="mailto:${escapeHtml(contact)}"><bdi dir="ltr">${escapeHtml(contact)}</bdi></a>.</p>` : ''}<div role="alert" data-auth-error hidden></div><p role="status" data-auth-status></p></section>`
    return renderV2Shell(t, {
      branding: props.branding, surface: props.surface, activeRoute: props.route, visibility: props.visibility,
      homeHref: props.surface === 'xwhm' ? '/whm' : props.surface === 'xmail' ? '/mail/inbox' : '/home',
      sidebarHtml: registeredSidebar(t, props), realtimeEnabled: false,
      searchHtml: `<button type="button" class="v2-search" disabled aria-label="${escapeHtml(t('Search'))}" title="${escapeHtml(t('Unavailable'))}">${escapeHtml(t('Search'))}</button>`,
      languages: alternateLocales(props.locale).map(locale => ({ tag: locale.tag, href: href(locale.tag) })),
      scheme: { current: props.theme, toggleHref: href(props.locale, props.theme === 'dark' ? 'light' : 'dark') },
      account: { signedIn: props.signedIn, username: props.session?.username, roleLabel: props.session?.role, signInHref: '/login', ...(props.signedIn ? { securityHref: props.surface === 'xwhm' ? '/whm/security/sign-in' : props.surface === 'xmail' ? '/mail/settings/security' : '/security/account' } : {}) },
      contentHtml: content,
    })
  }
}

export const V2_UNAVAILABLE_CSS = `.v2-unavailable,.v2-unavailable__panel,.v2-unavailable__summary{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}.v2-unavailable__panel,.v2-unavailable__summary{padding:var(--space-3)}
.v2-unavailable__fields,.v2-unavailable__facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}.v2-unavailable__field,.v2-unavailable__facts>div{display:flex;flex-direction:column;align-items:stretch;gap:var(--space-1);min-inline-size:0;text-align:start}.v2-unavailable__facts dt{color:var(--muted)}.v2-unavailable__facts dd{overflow-wrap:anywhere}.v2-unavailable__facts bdi{display:inline;unicode-bidi:isolate}.v2-unavailable__field>label{padding-inline-start:12px}.v2-unavailable__field>input,.v2-unavailable__field>textarea,.v2-unavailable__field>select{inline-size:100%;text-align:var(--v2-control-align,start)}.v2-unavailable__actions{display:flex;flex-wrap:wrap;gap:var(--space-2)}
@media(max-width:600px){.v2-unavailable__panel,.v2-unavailable__summary{padding:var(--space-2)}.v2-unavailable__fields,.v2-unavailable__facts{grid-template-columns:1fr}}`
