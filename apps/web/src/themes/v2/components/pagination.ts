import type { Translate } from '../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon } from '../icons.ts'

export interface PageLink {
  /** A link navigates; without href the control is a button bound through hooks. Omit both when unavailable. */
  href?: string
  hooks?: HookAttributes
  disabled?: boolean
}

export interface PaginationProps {
  /** Range summary, such as "1-25 of 44". */
  summary: string
  pageSize?: { id: string; name?: string; options: readonly number[]; selected: number; hooks?: HookAttributes }
  previous: PageLink
  next: PageLink
  hooks?: HookAttributes
}

const control = (link: PageLink, label: string, iconName: 'chevLeft' | 'chevRight'): string => {
  const content = icon(iconName, 16)
  if (link.disabled || (!link.href && !link.hooks)) return `<button type="button" class="v2-btn v2-btn--icon" aria-label="${escapeHtml(label)}" disabled>${content}</button>`
  return link.href
    ? `<a class="v2-btn v2-btn--icon" href="${escapeHtml(link.href)}" aria-label="${escapeHtml(label)}"${hookAttrs(link.hooks)}>${content}</a>`
    : `<button type="button" class="v2-btn v2-btn--icon" aria-label="${escapeHtml(label)}"${hookAttrs(link.hooks)}>${content}</button>`
}

export function pagination(t: Translate, props: PaginationProps): string {
  const size = props.pageSize
    ? `<label for="${escapeHtml(props.pageSize.id)}">${escapeHtml(t(msgctxt('theme:v2', 'Rows')))}</label><span class="v2-select"><select id="${escapeHtml(props.pageSize.id)}"${props.pageSize.name ? ` name="${escapeHtml(props.pageSize.name)}"` : ''}${hookAttrs(props.pageSize.hooks)}>${props.pageSize.options.map(option => `<option value="${option}"${option === props.pageSize!.selected ? ' selected' : ''}>${option}</option>`).join('')}</select>${icon('chevDown', 16)}</span>` : ''
  return `<nav class="v2-pagination" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Pagination')))}"${hookAttrs(props.hooks)}><span class="v2-num">${escapeHtml(props.summary)}</span><span class="v2-pagination__controls">${size}${control(props.previous, t('Previous page'), 'chevLeft')}${control(props.next, t('Next page'), 'chevRight')}</span></nav>`
}

export const PAGINATION_CSS = `.v2-pagination{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-1) var(--space-2);padding:var(--space-1) var(--space-2);padding-inline-start:20px;border-top:1px solid var(--line);font-size:13px;color:var(--text-2)}
.v2-pagination__controls{display:inline-flex;align-items:center;gap:var(--space-1)}
.v2-pagination select{font-size:13px}
`
