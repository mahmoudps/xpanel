// Log family (TplLog): a bounded query form, KPIs of the read, filters and the log stream (role="log") with the
// follow controls. Following itself belongs to the core follow controller; this layout emits only its hooks:
// [data-log-follow] toggle (aria-pressed), [data-log-stream][data-log-follow-state] root, one role="status"
// [data-log-follow-status] element and the [data-log-follow-retry] button, hidden until an error stops following.
// Each entry is a disclosure: the `log-entry` template's first cell is a data-xp-action="expand" button and a
// details row follows whose [data-xp-slot="details"] core unhides.

import type { Translate } from '../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon } from '../icons.ts'
import { card } from '../components/card.ts'
import { dataTable, dataTableRow, type DataTableProps, type DataTableRow } from '../components/data-table.ts'
import { filterBar, type FilterBarProps } from '../components/filter-bar.ts'
import { formField, type FormFieldProps } from '../components/form-field.ts'
import { emptyState, errorState, type EmptyStateProps, type ErrorStateProps } from '../components/state-block.ts'
import { stateTones, statusPill } from '../components/status-pill.ts'
import { layoutRoot, xpTemplate, type PageBaseProps } from './common.ts'
import { listFooter, type ListFooter, type ListState } from './list-page.ts'

export interface LogQuery {
  title: string
  titleId: string
  description?: string
  /** The bounded read: unit, entry count, since, priority. */
  fields: readonly FormFieldProps[]
  submit: { label: string; hooks: HookAttributes }
  hooks?: HookAttributes
}

export interface LogPageProps extends PageBaseProps {
  query?: LogQuery
  stream: {
    title: string
    titleId: string
    /** What was read, such as "nginx.service · 200 entries · any priority". */
    meta?: string
    filters?: FilterBarProps
    /** Header actions besides Follow, such as Download. */
    actionsHtml?: string
    table: Omit<DataTableProps, 'state'>
    state?: ListState
    empty?: EmptyStateProps
    noMatch?: EmptyStateProps
    error?: ErrorStateProps
    follow?: {
      /** Extra hooks on the toggle, such as the read interval. */
      hooks?: HookAttributes
      /** The initial follow status line; core rewrites it as following starts, pauses or stops. */
      status?: string
      retryHooks?: HookAttributes
    }
    /** Hooks on the stream root besides the follow contract. */
    streamHooks?: HookAttributes
    footer?: ListFooter
    /** The entry core clones for each new journal line (`log-entry`): its first cell (the time slot) becomes the
     *  expand toggle, and `detailsActionsHtml` holds the controls of the details row, each with a verb. */
    entryTemplate?: DataTableRow & { detailsActionsHtml?: string }
    hooks?: HookAttributes
  }
}

const FOLLOW_STATES = [['following', 'ok'], ['paused', 'neutral'], ['stopped', 'neutral']] as const

// One known field of an entry (unit, PID, host, request…). Core clones it once per fact into the details slot, with the
// label from the catalog; unknown fields are skipped, so raw keys never show.
const LOG_FACT_TEMPLATE = xpTemplate('log-fact', '<div class="v2-log__fact"><dt data-xp-slot="label"></dt><dd dir="ltr" data-xp-slot="value"></dd></div>')

/** The `log-entry` template: the entry row (data-level on the clone root) and its details row, hidden with the
 *  details slot. Levels are the journald and web server names. */
export function logEntryTemplate(table: LogPageProps['stream']['table'], entry: NonNullable<LogPageProps['stream']['entryTemplate']>): string {
  const [first = '', ...rest] = entry.cellsHtml
  const span = table.columns.length + (table.actions ? 1 : 0) + (table.selectAll ? 1 : 0)
  const toggle = `<button type="button" class="v2-log__toggle" data-xp-action="expand" aria-expanded="false">${icon('chevRight', 14)}${first}</button>`
  const row = dataTableRow(table, { ...entry, cellsHtml: [toggle, ...rest], hooks: { 'data-level': 'info', ...entry.hooks } })
  const details = `<tr class="v2-log__details"><td colspan="${span}"><div class="v2-log__detail"><dl class="v2-log__facts" data-xp-slot="details" hidden></dl>${LOG_FACT_TEMPLATE}${entry.detailsActionsHtml ? `<div class="v2-log__detail-actions">${entry.detailsActionsHtml}</div>` : ''}</div></td></tr>`
  return xpTemplate('log-entry', `${row}${details}`)
}

export function logPage(t: Translate, props: LogPageProps): string {
  const { stream } = props
  const state = stream.state ?? 'ready'
  const follow = stream.follow ?? {}
  // The visible state word follows [data-log-follow-state] through CSS; the status line is what is announced.
  const words = [t(msgctxt('theme:v2', 'Following')), t('Paused'), t('Stopped')]
  const indicator = `<span class="v2-follow" aria-hidden="true">${FOLLOW_STATES.map(([value, tone], index) => `<span class="v2-follow__${value}">${statusPill({ tone, label: words[index]!, hollow: value === 'stopped' })}</span>`).join('')}</span>`
  const toggle = `<button type="button" class="v2-btn" aria-pressed="false"${hookAttrs({ ...follow.hooks, 'data-log-follow': true })}>${icon('activity', 16)}${escapeHtml(t(msgctxt('theme:v2', 'Follow')))}</button>`
  const band = `<div class="v2-log__band"><span class="v2-log__dot" aria-hidden="true"></span><p class="v2-num" role="status" data-log-follow-status>${escapeHtml(follow.status ?? t(msgctxt('theme:v2', 'Not following. The entries below are from one read.')))}</p><button type="button" class="v2-btn"${hookAttrs({ ...follow.retryHooks, 'data-log-follow-retry': true })} hidden>${icon('refresh', 16)}${escapeHtml(t('Retry'))}</button></div>`
  const inset = (html: string): string => `<div class="v2-inset">${html}</div>`
  const entries = state === 'empty' && stream.empty ? inset(emptyState(stream.empty))
    : state === 'no-match' && stream.noMatch ? inset(emptyState(stream.noMatch))
    : dataTable(t, { ...stream.table, state: state === 'loading' ? 'loading' : state === 'ready' || state === 'error' ? undefined : 'empty' })
  const root = `<div class="v2-log__stream" role="log" aria-labelledby="${escapeHtml(stream.titleId)}"${hookAttrs({ ...stream.streamHooks, 'data-log-stream': true, 'data-log-follow-state': 'stopped' })}>${entries}</div>`
  const streamCard = card({
    title: stream.title, titleId: stream.titleId, description: stream.meta, flush: true, hooks: stream.hooks,
    actionsHtml: `${indicator}${toggle}${stream.actionsHtml ?? ''}`,
    bodyHtml: `${stream.filters ? filterBar(stream.filters) : ''}${state === 'error' && stream.error ? inset(errorState(t, stream.error)) : ''}${band}${root}${stream.footer ? listFooter(stream.footer) : ''}${stream.entryTemplate ? logEntryTemplate(stream.table, stream.entryTemplate) : ''}`,
  })
  const query = props.query ? card({
    title: props.query.title, titleId: props.query.titleId, description: props.query.description, hooks: props.query.hooks,
    bodyHtml: `<div class="v2-fields v2-fields--row">${props.query.fields.map(formField).join('')}<button type="button" class="v2-btn v2-btn--primary"${hookAttrs(props.query.submit.hooks)}>${escapeHtml(props.query.submit.label)}</button></div>`,
  }) : ''
  return layoutRoot(t, props, `<div class="v2-log">${streamCard}</div>`, query)
}

const STATE = (value: string): string => `.v2-log:has([data-log-follow-state=${value}])`
const LEVELS = { emerg: 'bad', alert: 'bad', crit: 'bad', err: 'bad', error: 'bad', warning: 'warn', warn: 'warn', notice: 'info', info: 'neutral', debug: 'neutral' } as const
export const LOG_LAYOUT_CSS = `.v2-follow{display:inline-flex}
.v2-follow>span{display:none}
${STATE('following')} .v2-follow__following,${STATE('paused')} .v2-follow__paused,${STATE('stopped')} .v2-follow__stopped{display:inline-flex}
.v2-log .v2-btn[aria-pressed="true"]{border-color:var(--accent-line);background:var(--accent-soft);color:var(--accent)}
.v2-log__band{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:var(--space-1) var(--space-3);border-top:1px solid var(--line);background:var(--subtle);font-size:13px;color:var(--text-2)}
.v2-log__band>p{flex:1 1 320px;min-width:0}
.v2-log__dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
${STATE('following')} .v2-log__band{background:var(--ok-soft)}
${STATE('following')} .v2-log__dot{background:var(--ok)}
.v2-log:has([data-log-follow-retry]:not([hidden])) .v2-log__band{background:var(--bad-soft)}
.v2-log:has([data-log-follow-retry]:not([hidden])) .v2-log__dot{background:var(--bad)}
.v2-log__stream td:has(>.v2-log__toggle){padding:4px var(--space-1);padding-inline-start:var(--space-2)}
.v2-log__toggle{display:inline-flex;align-items:center;gap:6px;min-height:var(--target);padding:0 var(--space-1);border:0;border-radius:var(--radius-chip);background:transparent;color:var(--accent);font:600 13px var(--font-mono);white-space:nowrap;cursor:pointer}
.v2-log__toggle:hover{background:var(--accent-soft)}
.v2-log__toggle[aria-expanded="true"]>.v2-icon{transform:rotate(90deg)}
.v2-log__details:has([data-xp-slot=details][hidden]){display:none}
.v2-log__stream tbody .v2-log__details>td,.v2-log__stream tbody .v2-log__details:hover>td{padding:0 var(--space-3) var(--space-2);border-top:0;background:var(--subtle)}
.v2-log__detail{display:flex;flex-wrap:wrap;align-items:flex-start;gap:var(--space-2) var(--space-3);padding:var(--space-2);border-radius:var(--radius-notice);border:1px solid var(--line);background:var(--surface)}
.v2-log__facts{flex:2 1 420px;min-width:0;margin:0;padding:12px var(--space-2);border-radius:var(--radius-control);background:var(--surface);border:1px solid var(--line);display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px var(--space-2);font-size:12px;line-height:1.6}
.v2-log__fact{display:contents}
.v2-log__facts dt{color:var(--muted)}
.v2-log__facts dd{margin:0;font-family:var(--font-mono);overflow-wrap:anywhere}
.v2-log__detail-actions{flex:1 1 200px;display:flex;flex-wrap:wrap;gap:var(--space-1)}
.v2-log__detail-actions>a:not([href]){display:none}
${stateTones('.v2-log__stream tr', 'data-level', LEVELS)}
`
