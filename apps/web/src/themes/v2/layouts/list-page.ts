// List family (TplList): a collection of records with KPIs, filters, row menus, bulk actions, pagination and a
// create/detail drawer beside the list.

import type { Translate } from '../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { bulkBar, type BulkBarProps } from '../components/bulk-bar.ts'
import { card } from '../components/card.ts'
import { dataTable, dataTableRow, type DataTableProps, type DataTableRow } from '../components/data-table.ts'
import { drawer, type DrawerProps } from '../components/drawer.ts'
import { filterBar, type FilterBarProps } from '../components/filter-bar.ts'
import { notice, type NoticeProps } from '../components/notice.ts'
import { pagination, type PaginationProps } from '../components/pagination.ts'
import { rowMenu, type RowMenuProps } from '../components/row-menu.ts'
import { emptyState, errorState, type EmptyStateProps, type ErrorStateProps } from '../components/state-block.ts'
import { layoutRoot, xpTemplate, type PageBaseProps } from './common.ts'

/** `no-match`: records exist but the filters exclude all of them. */
export type ListState = 'ready' | 'loading' | 'empty' | 'no-match' | 'error'

export interface ListFooter {
  /** The shown count, announced as filters change, such as "Showing 6 of 9 tokens". */
  count?: string
  /** A fixed note on the list's bounds, such as "Newest first, up to 200 tokens." */
  note?: string
  hooks?: HookAttributes
}

export interface ListPageProps extends PageBaseProps {
  list: {
    title: string
    titleId: string
    /** The read summary under the title, such as "9 tokens · read 14:05 UTC"; announced when it changes. */
    status?: string
    statusHooks?: HookAttributes
    /** Segmented quick filters with counts, shown in the list header. */
    quickFilters?: FilterBarProps['segments']
    /** Search, selects, applied chips, Clear filters and trailing actions such as Export. */
    filters?: Omit<FilterBarProps, 'segments'>
    bulk?: BulkBarProps
    table: Omit<DataTableProps, 'state'>
    state?: ListState
    empty?: EmptyStateProps
    noMatch?: EmptyStateProps
    /** Read failure. Rows of the last successful read may still be shown under it. */
    error?: ErrorStateProps
    pagination?: PaginationProps
    footer?: ListFooter
    hooks?: HookAttributes
  }
  /** Notes that belong to the list, shown above it in the main column, such as how the API accepts a token. */
  listNotices?: readonly NoticeProps[]
  /** The row core clones for inserted or live-updated records (`list-row`): cells carry the text slots it fills,
   *  and controls in its cells carry data-xp-action verbs. */
  rowTemplate?: DataTableRow
  /** The row menu core clones per row (`row-menu`); it sets the id, label and popover target of each copy. Items
   *  carry their verbs in `hooks`, such as `{ 'data-xp-action': 'revoke' }`. */
  rowMenuTemplate?: RowMenuProps
  /** Create and detail drawers: shown beside the list, or emitted as `<template data-xp-template="<id>">` for core
   *  to open into the `data-xp-drawer-host` row. */
  drawers?: readonly (DrawerProps & { template?: boolean })[]
}

export const listFooter = (footer: ListFooter): string =>
  `<div class="v2-foot"${hookAttrs(footer.hooks)}>${footer.count ? `<span class="v2-num" aria-live="polite">${escapeHtml(footer.count)}</span>` : ''}${footer.note ? `<span>${escapeHtml(footer.note)}</span>` : ''}</div>`

export function listPage(t: Translate, props: ListPageProps): string {
  const { list } = props
  const state = list.state ?? 'ready'
  const inset = (html: string): string => `<div class="v2-inset">${html}</div>`
  const content = state === 'empty' && list.empty ? inset(emptyState(list.empty))
    : state === 'no-match' && list.noMatch ? inset(emptyState(list.noMatch))
    : `${state === 'error' && list.error ? inset(errorState(t, list.error)) : ''}${state === 'error' && !list.table.rows.length ? '' : dataTable(t, { ...list.table, state: state === 'loading' ? 'loading' : state === 'error' ? 'ready' : state === 'ready' ? undefined : 'empty' })}`
  // Template controls carry their verbs: core wires `select` and `menu` and sets each copy's id and label.
  const row = props.rowTemplate
  const templates = (row ? xpTemplate('list-row', dataTableRow(list.table, row.select ? { ...row, select: { ...row.select, hooks: { 'data-xp-action': 'select', ...row.select.hooks } } } : row)) : '')
    + (props.rowMenuTemplate ? xpTemplate('row-menu', rowMenu({ ...props.rowMenuTemplate, triggerHooks: { 'data-xp-action': 'menu', ...props.rowMenuTemplate.triggerHooks } })) : '')
  const listCard = card({
    title: list.title, titleId: list.titleId, description: list.status, descriptionLive: true, descriptionHooks: list.statusHooks, flush: true, hooks: list.hooks,
    actionsHtml: list.quickFilters ? filterBar({ segments: list.quickFilters }) : undefined,
    bodyHtml: `${list.filters ? filterBar(list.filters) : ''}${list.bulk ? bulkBar(t, list.bulk) : ''}${content}${list.pagination && state === 'ready' ? pagination(t, list.pagination) : ''}${list.footer ? listFooter(list.footer) : ''}${templates}`,
  })
  const drawers = props.drawers ?? []
  const inline = drawers.filter(item => !item.template).map(item => drawer(t, item)).join('')
  const drawerTemplates = drawers.filter(item => item.template).map(item => xpTemplate(item.id, drawer(t, item))).join('')
  const main = props.listNotices?.length ? `<div class="v2-stack v2-stack--tight">${props.listNotices.map(item => notice(t, item)).join('')}${listCard}</div>` : listCard
  return layoutRoot(t, props, `<div class="v2-split" data-xp-drawer-host>${main}${inline}${drawerTemplates}</div>`)
}
