import { formatNumber } from '../formatters.ts'
import { createDesignTranslator, escapeAttr, escapeHtml, type TextTranslator } from '../html.ts'

export interface PaginationProps {
  readonly id: string
  readonly page: number
  readonly totalPages: number
  readonly totalItems?: number
  readonly pageHref?: (page: number) => string
  readonly locale?: string
  readonly copy?: TextTranslator
}

export function renderPagination(props: PaginationProps): string {
  const t = createDesignTranslator(props.copy)
  const totalPages = Math.max(1, props.totalPages)
  const page = Math.min(Math.max(1, props.page), totalPages)
  const prevPage = Math.max(1, page - 1)
  const nextPage = Math.min(totalPages, page + 1)
  const totalSuffix = props.totalItems !== undefined ? ` (${formatNumber(props.totalItems, props.locale)})` : ''
  const prevInner = `<span class="ds-icon--dir" aria-hidden="true">&lsaquo;</span> ${escapeHtml(t('Previous'))}`
  const nextInner = `${escapeHtml(t('Next'))} <span class="ds-icon--dir" aria-hidden="true">&rsaquo;</span>`

  const prevControl = props.pageHref
    ? (page <= 1
      ? `<a class="ds-btn" data-ds-page-prev data-ds-page="${prevPage}" role="link" aria-disabled="true" tabindex="-1">${prevInner}</a>`
      : `<a class="ds-btn" href="${escapeAttr(props.pageHref(prevPage))}" data-ds-page-prev data-ds-page="${prevPage}">${prevInner}</a>`)
    : `<button type="button" class="ds-btn" data-ds-page-prev data-ds-page="${prevPage}"${page <= 1 ? ' disabled' : ''}>${prevInner}</button>`

  const nextControl = props.pageHref
    ? (page >= totalPages
      ? `<a class="ds-btn" data-ds-page-next data-ds-page="${nextPage}" role="link" aria-disabled="true" tabindex="-1">${nextInner}</a>`
      : `<a class="ds-btn" href="${escapeAttr(props.pageHref(nextPage))}" data-ds-page-next data-ds-page="${nextPage}">${nextInner}</a>`)
    : `<button type="button" class="ds-btn" data-ds-page-next data-ds-page="${nextPage}"${page >= totalPages ? ' disabled' : ''}>${nextInner}</button>`

  return `<nav class="ds-pagination" id="${escapeAttr(props.id)}" aria-label="${escapeAttr(t('Page'))}">` +
    `<span class="ds-caption ds-num">${escapeHtml(t('Page'))} <span data-ds-page-current>${formatNumber(page, props.locale)}</span> ${escapeHtml(t('of'))} <span data-ds-page-total>${formatNumber(totalPages, props.locale)}</span>${escapeHtml(totalSuffix)}</span>` +
    `<div class="ds-page-head__actions">${prevControl}${nextControl}</div>` +
  `</nav>`
}
