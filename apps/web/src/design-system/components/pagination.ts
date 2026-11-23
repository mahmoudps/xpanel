import { formatNumber } from '../formatters.ts'
import { createDesignTranslator, escapeAttr, escapeHtml, type TextTranslator } from '../html.ts'

export interface PaginationProps {
  readonly id: string
  readonly page: number
  readonly totalPages: number
  readonly totalItems?: number
  readonly locale?: string
  readonly copy?: TextTranslator
}

export function renderPagination(props: PaginationProps): string {
  const t = createDesignTranslator(props.copy)
  const totalPages = Math.max(1, props.totalPages)
  const page = Math.min(Math.max(1, props.page), totalPages)
  const prevDisabled = page <= 1 ? ' disabled' : ''
  const nextDisabled = page >= totalPages ? ' disabled' : ''
  const totalSuffix = props.totalItems !== undefined ? ` (${formatNumber(props.totalItems, props.locale)})` : ''

  return `<nav class="ds-pagination" id="${escapeAttr(props.id)}" aria-label="${escapeAttr(t('Page'))}">` +
    `<span class="ds-caption ds-num">${escapeHtml(t('Page'))} ${formatNumber(page, props.locale)} ${escapeHtml(t('of'))} ${formatNumber(totalPages, props.locale)}${escapeHtml(totalSuffix)}</span>` +
    `<div class="ds-page-head__actions">` +
      `<button type="button" class="ds-btn" data-ds-page="${page - 1}"${prevDisabled}><span class="ds-icon--dir" aria-hidden="true">&lsaquo;</span> ${escapeHtml(t('Previous'))}</button>` +
      `<button type="button" class="ds-btn" data-ds-page="${page + 1}"${nextDisabled}>${escapeHtml(t('Next'))} <span class="ds-icon--dir" aria-hidden="true">&rsaquo;</span></button>` +
    `</div>` +
  `</nav>`
}
