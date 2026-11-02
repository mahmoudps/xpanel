import type { Translate } from '../../../i18n.ts'
import { attr, escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon } from '../icons.ts'
import { statusPill, type StatusPillProps } from './status-pill.ts'

export interface Crumb {
  label: string
  /** Omitted on the current page, which is marked aria-current="page". */
  href?: string
}

export interface PageHeaderProps {
  breadcrumb: readonly Crumb[]
  /** The page route, shown as code beside the breadcrumb. */
  route?: string
  title: string
  titleId?: string
  description?: string
  /** The page state pill beside the title, such as "Unsaved changes" or "3 active". */
  status?: StatusPillProps
  /** The applied-generation stamp at the head of the actions, such as "Applied · generation 142" over its UTC time. */
  stamp?: StatusPillProps & { meta?: string }
  /** Buttons or links built with the kit: secondary first, then the one primary action. */
  actionsHtml?: string
  hooks?: HookAttributes
}

const crumb = (item: Crumb, last: boolean): string =>
  `<li>${last ? `<span aria-current="page">${escapeHtml(item.label)}</span>`
    : `${item.href ? `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>` : `<span>${escapeHtml(item.label)}</span>`}${icon('chevRight', 14)}`}</li>`

export function pageHeader(t: Translate, props: PageHeaderProps): string {
  const stamp = props.stamp
    ? `<div class="v2-page-head__status">${statusPill(props.stamp)}${props.stamp.meta ? `<span class="v2-num v2-muted">${escapeHtml(props.stamp.meta)}</span>` : ''}</div>`
    : ''
  const aside = stamp || props.actionsHtml ? `<div class="v2-page-head__actions">${stamp}${props.actionsHtml ?? ''}</div>` : ''
  const title = `<h1${attr('id', props.titleId)}>${escapeHtml(props.title)}</h1>`
  return `<header class="v2-page-head"${hookAttrs(props.hooks)}>
<nav class="v2-crumbs" aria-label="${escapeHtml(t('Breadcrumb'))}"><ol>${props.breadcrumb.map((item, index) => crumb(item, index === props.breadcrumb.length - 1)).join('')}</ol>${props.route ? `<code dir="ltr">${escapeHtml(props.route)}</code>` : ''}</nav>
<div class="v2-page-head__row"><div class="v2-page-head__text">${props.status ? `<div class="v2-page-head__title">${title}${statusPill(props.status)}</div>` : title}${props.description ? `<p>${escapeHtml(props.description)}</p>` : ''}</div>${aside}</div>
</header>`
}

export const PAGE_HEADER_CSS = `.v2-page-head{display:flex;flex-direction:column;gap:var(--space-2)}
.v2-crumbs{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-1)}
.v2-crumbs ol{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1);font-size:13px;color:var(--muted)}
.v2-crumbs li{display:inline-flex;align-items:center;gap:var(--space-1)}
.v2-crumbs a{color:var(--muted);text-decoration:none}
.v2-crumbs a:hover{color:var(--text);text-decoration:underline}
.v2-crumbs [aria-current="page"]{color:var(--text-2);font-weight:500}
.v2-crumbs code{font-size:12px;color:var(--muted)}
.v2-page-head__row{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:var(--space-2) var(--space-3)}
.v2-page-head__text{display:flex;flex-direction:column;gap:var(--space-1);min-width:0;max-width:72ch}
.v2-page-head__title{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) 12px}
.v2-page-head__text p{color:var(--muted);line-height:1.6}
.v2-page-head__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-page-head__status{display:flex;flex-direction:column;align-items:flex-end;gap:4px;font-size:12px}
`
