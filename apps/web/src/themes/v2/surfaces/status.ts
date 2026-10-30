import { brandingProductName } from '../../../branding.ts'
import { publicContactEmail } from '../../../display-name.ts'
import { alternateLocales } from '../../../i18n.ts'
import { statusPageCopy } from '../../../models/status-page.ts'
import type { StatusPageModel, ThemeViewProps } from '../../contract.ts'
import { escapeHtml } from '../html.ts'
import { v2Messages } from '../messages.ts'
import { renderV2Shell } from '../shell/shell.ts'

const PRODUCTS = { xpanel: 'xPanel', xwhm: 'xWHM', xmail: 'xMail' } as const
const HOMES = { xpanel: '/home', xwhm: '/whm', xmail: '/mail/inbox' } as const

/** Keeps appearance and account routing context on same-listener navigation only. */
function statusHref(href: string | undefined, model: StatusPageModel): string | undefined {
  if (!href?.startsWith('/') || href.startsWith('//')) return undefined
  const url = new URL(href, 'https://status.invalid')
  if (!url.searchParams.has('lang')) url.searchParams.set('lang', model.locale)
  if (!url.searchParams.has('theme')) url.searchParams.set('theme', model.theme)
  if (!url.searchParams.has('density')) url.searchParams.set('density', model.density)
  if (model.accountId && url.pathname !== '/login' && !url.searchParams.has('accountId')) url.searchParams.set('accountId', model.accountId)
  return url.pathname + '?' + url.searchParams.toString()
}

export function renderV2Status(props: StatusPageModel & ThemeViewProps): string {
  const t = v2Messages.translator(props.locale)
  const copy = statusPageCopy(props.status, props.locale)
  const workspace = statusHref(props.workspaceHref, props)
  const retry = (props.status === 500 || props.status === 503) ? statusHref(props.retryHref, props) : undefined
  const contact = (props.status === 403 || props.status === 404) ? publicContactEmail(props.supportEmail) : undefined
  const actions = `${workspace ? `<a class="v2-btn v2-btn--primary" href="${escapeHtml(workspace)}">${escapeHtml(t('Back to workspace'))}</a>` : ''}${retry ? `<a class="v2-btn" href="${escapeHtml(retry)}">${escapeHtml(t('Try again'))}</a>` : ''}${!props.signedIn && props.status !== 421 && !workspace ? `<a class="v2-btn v2-btn--primary" href="${escapeHtml(statusHref('/login', props)!)}">${escapeHtml(t('Sign in'))}</a>` : ''}`
  const body = `<section class="v2-status-card v2-card" data-status-page="${props.status}" role="alert" aria-labelledby="v2-status-title"><p class="v2-status-code v2-num"><bdi dir="ltr">${props.status}</bdi></p><h1 id="v2-status-title">${escapeHtml(copy.title)}</h1><p>${escapeHtml(copy.explanation)}</p>${props.notice ? `<p data-status-notice>${escapeHtml(props.notice)}</p>` : ''}${contact ? `<p>${escapeHtml(t('Write to'))} <a href="mailto:${escapeHtml(contact)}"><bdi dir="ltr">${escapeHtml(contact)}</bdi></a>.</p>` : ''}<div class="v2-status-actions">${actions}</div></section>`
  if (!props.visibility) {
    return `<div class="v2-status-standalone" data-surface="${props.surface}"><header class="v2-status-header"><strong dir="ltr">${escapeHtml(brandingProductName(props.branding, PRODUCTS[props.surface]))}</strong>${props.hostname ? `<bdi dir="ltr" class="v2-mono">${escapeHtml(props.hostname)}</bdi>` : ''}</header><main id="main-content" class="v2-status-main" tabindex="-1">${body}</main></div>`
  }
  return renderV2Shell(t, {
    branding: props.branding, surface: props.surface, activeRoute: props.path,
    visibility: props.visibility, catalog: props.catalog, homeHref: HOMES[props.surface],
    realtimeEnabled: false,
    searchHtml: `<button type="button" class="v2-search" disabled aria-label="${escapeHtml(t('Search'))}" title="${escapeHtml(t('Unavailable'))}">${escapeHtml(t('Search'))}</button>`,
    languages: alternateLocales(props.locale).map(locale => ({ tag: locale.tag, href: statusHref(props.path, { ...props, locale: locale.tag }) ?? '/login' })),
    scheme: { current: props.theme, toggleHref: statusHref(props.path, { ...props, theme: props.theme === 'dark' ? 'light' : 'dark' }) ?? '/login' },
    ...(props.hostname ? { server: { name: props.hostname } } : {}),
    account: { signedIn: props.signedIn === true, ...(props.username ? { username: props.username } : {}), ...(props.role ? { roleLabel: props.role } : {}), signInHref: '/login', ...(props.signedIn ? { securityHref: props.surface === 'xwhm' ? '/whm/security/sign-in' : props.surface === 'xmail' ? '/mail/settings/security' : '/security/account' } : {}) },
    contentHtml: body,
  })
}

export const V2_STATUS_CSS = `.v2-status-card{display:flex;flex-direction:column;gap:var(--space-3);inline-size:min(100%,720px);margin-inline:auto;padding:var(--space-3)}
.v2-status-code{font:600 40px var(--font-mono);color:var(--muted)}.v2-status-actions{display:flex;flex-wrap:wrap;gap:var(--space-2)}
.v2-status-standalone{display:flex;flex-direction:column;min-block-size:100dvh}.v2-status-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-2);padding:var(--space-3);background:var(--surface);border-block-end:1px solid var(--line)}.v2-status-main{flex:1;display:grid;align-content:center;padding:var(--space-4) var(--space-3)}
@media(max-width:600px){.v2-status-card,.v2-status-header{padding:var(--space-2)}.v2-status-main{padding:var(--space-4) var(--space-2)}}`
