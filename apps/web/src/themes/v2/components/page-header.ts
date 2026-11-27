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
  return `<header class="v2-page-head"${attr('data-route', props.route)}${hookAttrs(props.hooks)}>
<nav class="v2-crumbs" aria-label="${escapeHtml(t('Breadcrumb'))}"><ol>${props.breadcrumb.map((item, index) => crumb(item, index === props.breadcrumb.length - 1)).join('')}</ol></nav>
<div class="v2-page-head__row"><div class="v2-page-head__text">${props.status ? `<div class="v2-page-head__title">${title}${statusPill(props.status)}</div>` : title}${props.description ? `<p>${escapeHtml(props.description)}</p>` : ''}</div>${aside}</div>
</header>`
}

export function subtabs(label: string, items: readonly { label: string; href: string; active?: boolean }[]): string {
  return `<nav class="v2-subtabs" aria-label="${escapeHtml(label)}">${items.map(item => `<a href="${escapeHtml(item.href)}"${item.active ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`).join('')}</nav>`
}

export const SUBTABS_CSS = `.v2-subtabs{display:flex;flex-wrap:wrap;gap:6px;padding-block-end:8px;margin-block-end:4px;border-block-end:1px solid var(--line)}
.v2-subtabs>a{display:inline-flex;align-items:center;min-inline-size:var(--target);min-block-size:var(--target);padding:0 14px;border-radius:var(--radius-control);color:var(--text-2);font-size:14px;font-weight:600;text-decoration:none;transition:background-color .12s ease-out,color .12s ease-out}
.v2-subtabs>a:hover{background:var(--subtle);color:var(--text)}
.v2-subtabs>a[aria-current="page"]{background:var(--accent-soft);color:var(--accent)}`

export const PAGE_HEADER_CSS = `.v2-page-head{display:flex;flex-direction:column;gap:6px}
.v2-crumbs{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-1);min-height:22px}
.v2-crumbs ol{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.v2-crumbs li{display:inline-flex;align-items:center;gap:6px}
.v2-crumbs a{display:inline-flex;align-items:center;min-height:var(--target);min-inline-size:var(--target);margin-block:-11px;color:var(--muted);text-decoration:none}
.v2-crumbs a:hover{color:var(--text)}
.v2-crumbs [aria-current="page"]{color:var(--text-2);font-weight:500}
.v2-page-head__row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px var(--space-3)}
.v2-page-head__text{display:flex;flex-direction:column;gap:var(--space-1);min-width:0;max-width:84ch}
.v2-page-head__title{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) 10px}
.v2-page-head__text p{font-size:13px;color:var(--muted);line-height:1.5}
.v2-page-head__actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.v2-page-head__status{display:flex;flex-direction:column;align-items:flex-end;gap:2px;font-size:12px}
`
