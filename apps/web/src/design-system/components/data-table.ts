import { formatNumber } from '../formatters.ts'
import { createDesignTranslator, escapeAttr, escapeHtml, type TextTranslator } from '../html.ts'
import { renderEmptyState } from './empty-state.ts'
import { renderErrorState } from './error-state.ts'
import { renderPagination } from './pagination.ts'
import { renderSkeleton } from './skeleton.ts'

export interface TableColumn {
  readonly key: string
  readonly label: string
  readonly sortable?: boolean
  readonly sortDirection?: 'ascending' | 'descending' | 'none'
}

export interface TableRow {
  readonly id: string
  readonly cells: Readonly<Record<string, string>>
  readonly actionsHtml?: string
}

export interface DataTableProps {
  readonly id: string
  readonly caption: string
  readonly columns: readonly TableColumn[]
  readonly rows: readonly TableRow[]
  readonly page?: number
  readonly pageSize?: number
  readonly totalItems?: number
  readonly selectable?: boolean
  readonly selectedCount?: number
  readonly bulkActionsHtml?: string
  readonly filterToolbarHtml?: string
  readonly loading?: boolean
  readonly errorMessage?: string
  readonly retryAction?: string
  readonly emptyTitle?: string
  readonly emptyMessage?: string
  readonly emptyActionHtml?: string
  readonly responsiveCards?: boolean
  readonly locale?: string
  readonly copy?: TextTranslator
}

export function renderDataTable(props: DataTableProps): string {
  const t = createDesignTranslator(props.copy)
  const maxPageSize = Math.min(25, Math.max(1, props.pageSize ?? 25))
  const visibleRows = props.rows.slice(0, maxPageSize)
  const selectedCount = props.selectedCount ?? 0
  const hasBulk = Boolean(props.selectable)

  const toolbarHtml = props.filterToolbarHtml
    ? `<div class="ds-table-toolbar">${props.filterToolbarHtml}</div>`
    : ''

  const bulkBarHtml = hasBulk
    ? `<div class="ds-table-toolbar" data-ds-bulk-bar${selectedCount > 0 ? '' : ' hidden'}>` +
        `<span class="ds-caption ds-num">${formatNumber(selectedCount, props.locale)} ${escapeHtml(t('Selected'))}</span>` +
        `<div class="ds-page-head__actions">${props.bulkActionsHtml ?? ''}</div>` +
      `</div>`
    : ''

  let contentHtml = ''
  if (props.loading) {
    contentHtml = `<div class="ds-card">${renderSkeleton({ variant: 'row', count: 5, locale: props.locale, copy: props.copy })}</div>`
  } else if (props.errorMessage) {
    contentHtml = renderErrorState({
      title: t('Validation failed'),
      message: props.errorMessage,
      retryAction: props.retryAction,
      locale: props.locale,
      copy: props.copy,
    })
  } else if (!visibleRows.length) {
    contentHtml = renderEmptyState({
      title: props.emptyTitle,
      message: props.emptyMessage ?? t('No items yet'),
      actionHtml: props.emptyActionHtml,
      locale: props.locale,
      copy: props.copy,
    })
  } else {
    const hasActions = props.rows.some(r => Boolean(r.actionsHtml))
    const selectHeader = hasBulk
      ? `<th><input type="checkbox" data-ds-select-all aria-label="${escapeAttr(t('Select all'))}"></th>`
      : ''
    const colHeaders = props.columns
      .map(col => {
        if (!col.sortable) return `<th>${escapeHtml(col.label)}</th>`
        const ariaSort = col.sortDirection ?? 'none'
        return `<th aria-sort="${escapeAttr(ariaSort)}"><button type="button" class="ds-table__sort" data-ds-sort="${escapeAttr(col.key)}">${escapeHtml(col.label)}</button></th>`
      })
      .join('')
    const actionHeader = hasActions ? `<th>${escapeHtml(t('Actions'))}</th>` : ''

    const bodyRows = visibleRows
      .map(row => {
        const selectCell = hasBulk
          ? `<td data-label="${escapeAttr(t('Select all'))}"><input type="checkbox" data-ds-row-select="${escapeAttr(row.id)}" aria-label="${escapeAttr(row.id)}"></td>`
          : ''
        const cells = props.columns
          .map(col => `<td data-label="${escapeAttr(col.label)}">${row.cells[col.key] ?? '—'}</td>`)
          .join('')
        const actionCell = hasActions ? `<td data-label="${escapeAttr(t('Actions'))}">${row.actionsHtml ?? ''}</td>` : ''
        return `<tr data-ds-row="${escapeAttr(row.id)}">${selectCell}${cells}${actionCell}</tr>`
      })
      .join('')

    const responsiveClass = props.responsiveCards === false ? '' : ' ds-table--responsive'
    contentHtml = `<div class="ds-table-scroll">` +
      `<table class="ds-table${responsiveClass}">` +
        `<caption class="ds-sr-only">${escapeHtml(props.caption)}</caption>` +
        `<thead><tr>${selectHeader}${colHeaders}${actionHeader}</tr></thead>` +
        `<tbody>${bodyRows}</tbody>` +
      `</table>` +
    `</div>`
  }

  const totalItems = props.totalItems ?? props.rows.length
  const totalPages = Math.max(1, Math.ceil(totalItems / maxPageSize))
  const paginationHtml = (!props.loading && !props.errorMessage && totalItems > 0)
    ? renderPagination({
      id: `${props.id}-pagination`,
      page: props.page ?? 1,
      totalPages,
      totalItems,
      locale: props.locale,
      copy: props.copy,
    })
    : ''

  return `<div class="ds-table-card" id="${escapeAttr(props.id)}">${toolbarHtml}${bulkBarHtml}${contentHtml}${paginationHtml}</div>`
}
