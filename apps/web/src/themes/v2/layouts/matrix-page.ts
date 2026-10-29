// Matrix family (TplMatrix): events grouped into sections (one <tbody> each) against channel columns, with
// whole-column and whole-group switches, a side column, the change review and the revision-checked save bar.

import type { Translate } from '../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon, type IconName } from '../icons.ts'
import { card, type CardProps } from '../components/card.ts'
import { changeReview, type ChangeReviewProps } from '../components/change-review.ts'
import { leadCell } from '../components/data-table.ts'
import { dialog, type DialogProps } from '../components/dialog.ts'
import { filterBar, type FilterBarProps } from '../components/filter-bar.ts'
import { statusPill } from '../components/status-pill.ts'
import { cards, commitRegion, layoutRoot, revisionSaveBar, splitWithAside, stateBlock, type LayoutState, type PageBaseProps, type RevisionSaveProps, type StateSlots } from './common.ts'
import { listFooter, type ListFooter } from './list-page.ts'

export interface MatrixSwitch {
  /** Names the switch for assistive technology, such as "Email recipients for Account created". */
  label: string
  checked?: boolean
  disabled?: boolean
  hooks?: HookAttributes
}

export interface MatrixChannel {
  label: string
  /** State of the channel in words, such as "Always on" or "Not connected". */
  note?: string
  /** A note that warns (a channel that is not connected) takes the warning tone. */
  noteTone?: 'warn' | 'bad'
  /** A column that is always on (such as the audit log) shows this text in every row and takes no switch. */
  fixed?: string
  /** Switches the channel for every event shown. */
  all?: MatrixSwitch
}

export interface MatrixEvent {
  label: string
  /** The event key, such as "account.created". */
  key?: string
  icon?: IconName
  /** Cells of the lead columns after the event, built with the kit. */
  cellsHtml?: readonly string[]
  /** One switch per channel that is not fixed, in channel order. */
  switches: readonly MatrixSwitch[]
  /** Marks a draft change, such as "Changed". */
  changed?: string
  hooks?: HookAttributes
}

export interface MatrixGroup {
  label: string
  /** Such as "3 events · 1 selected". */
  countText?: string
  /** One "All in group" switch per channel that is not fixed. */
  switches?: readonly MatrixSwitch[]
  events: readonly MatrixEvent[]
  hooks?: HookAttributes
}

export interface MatrixPageProps extends PageBaseProps {
  /** Loading and error replace the matrix: no choice is assumed before a read succeeds. */
  state?: Exclude<LayoutState, 'empty'>
  states?: StateSlots
  matrix: {
    title: string
    titleId: string
    /** The read summary, announced when it changes. */
    status?: string
    statusHooks?: HookAttributes
    quickFilters?: FilterBarProps['segments']
    caption: string
    /** Header of the event column, then of each further lead column. */
    eventColumn: string
    leadColumns?: readonly string[]
    channels: readonly MatrixChannel[]
    groups: readonly MatrixGroup[]
    footer?: ListFooter
    hooks?: HookAttributes
  }
  aside?: readonly CardProps[]
  asideLabel?: string
  /** The in-review state: current beside proposed, what saving does, and Back and Save. */
  review?: ChangeReviewProps
  save: RevisionSaveProps
  dialogs?: readonly DialogProps[]
}

const toggle = (item: MatrixSwitch, contentHtml = ''): string =>
  `<label class="v2-matrix__switch"><input type="checkbox" role="switch" aria-label="${escapeHtml(item.label)}"${item.checked ? ' checked' : ''}${item.disabled ? ' disabled' : ''}${hookAttrs(item.hooks)}>${contentHtml}</label>`

export function matrixTable(t: Translate, props: MatrixPageProps['matrix']): string {
  const lead = 1 + (props.leadColumns?.length ?? 0)
  const captionId = `${props.titleId}-caption`
  // Switch lists skip fixed channels, so each channel maps to its position among the switchable ones.
  const switchable = props.channels.map((channel, index) => channel.fixed ? -1 : props.channels.slice(0, index).filter(other => !other.fixed).length)
  const cells = (render: (channel: MatrixChannel, position: number) => string): string => props.channels.map((channel, index) => `<td>${render(channel, switchable[index]!)}</td>`).join('')
  const channelHead = (channel: MatrixChannel): string => {
    const labelHtml = `<span class="v2-matrix__channel"><span>${escapeHtml(channel.label)}</span>${channel.note ? `<span${channel.noteTone ? ` class="v2-text--${channel.noteTone}"` : ''}>${escapeHtml(channel.note)}</span>` : ''}</span>`
    return `<th scope="col">${channel.all ? toggle(channel.all, labelHtml) : labelHtml}</th>`
  }
  const head = `<tr><th scope="col">${escapeHtml(props.eventColumn)}</th>${(props.leadColumns ?? []).map(column => `<th scope="col">${escapeHtml(column)}</th>`).join('')}${props.channels.map(channelHead).join('')}</tr>`
  const groupRow = (group: MatrixGroup): string => `<tr class="v2-matrix__group"><th scope="rowgroup" colspan="${lead}">${escapeHtml(group.label)}${group.countText ? ` <span class="v2-num">${escapeHtml(group.countText)}</span>` : ''}</th>${cells((_, position) => {
    const item = position < 0 ? undefined : group.switches?.[position]
    return item ? toggle(item, `<span>${escapeHtml(t(msgctxt('theme:v2', 'All in group')))}</span>`) : ''
  })}</tr>`
  const eventRow = (event: MatrixEvent): string => `<tr${hookAttrs(event.hooks)}><th scope="row"><div class="v2-matrix__event">${leadCell({ iconHtml: event.icon ? icon(event.icon, 16) : undefined, title: event.label, meta: event.key })}${event.changed ? statusPill({ tone: 'info', label: event.changed }) : ''}</div></th>${(event.cellsHtml ?? []).map(cell => `<td>${cell}</td>`).join('')}${cells((channel, position) => {
    if (channel.fixed) return `<span class="v2-matrix__fixed">${icon('check', 16)}${escapeHtml(channel.fixed)}</span>`
    const item = event.switches[position]
    return item ? toggle(item) : ''
  })}</tr>`
  const groups = props.groups.map(group => `<tbody${hookAttrs(group.hooks)}>${groupRow(group)}${group.events.map(eventRow).join('')}</tbody>`).join('')
  return `<div class="v2-table-scroll" role="region" aria-labelledby="${escapeHtml(captionId)}" tabindex="0"><table class="v2-table v2-matrix"><caption id="${escapeHtml(captionId)}" class="v2-sr">${escapeHtml(props.caption)}</caption><thead>${head}</thead>${groups}</table></div>`
}

export function matrixPage(t: Translate, props: MatrixPageProps): string {
  const state = props.state ?? 'ready'
  if (state !== 'ready') return layoutRoot(t, props, stateBlock(t, state, props.states))
  const { matrix } = props
  const matrixCard = card({
    title: matrix.title, titleId: matrix.titleId, description: matrix.status, descriptionLive: true, descriptionHooks: matrix.statusHooks, flush: true, hooks: matrix.hooks,
    actionsHtml: matrix.quickFilters ? filterBar({ segments: matrix.quickFilters }) : undefined,
    bodyHtml: `${matrixTable(t, matrix)}${matrix.footer ? listFooter(matrix.footer) : ''}`,
  })
  const side = cards(props.aside)
  return layoutRoot(t, props, `${splitWithAside(matrixCard, side ? { label: props.asideLabel ?? matrix.title, html: side } : undefined)}${props.review ? changeReview(t, props.review) : ''}${commitRegion(t('Save changes'), revisionSaveBar(t, { controls: props.review?.id, ...props.save }))}${(props.dialogs ?? []).map(item => dialog(t, item)).join('')}`)
}

export const MATRIX_LAYOUT_CSS = `.v2-matrix th[scope=row]{background:var(--surface);color:var(--text);font-size:14px;font-weight:400;white-space:normal}
.v2-matrix tbody tr:hover>th[scope=row]{background:var(--subtle)}
.v2-matrix__group>*{background:var(--subtle)}
.v2-matrix__group>th{font-size:13px;font-weight:600;color:var(--text)}
.v2-matrix__group .v2-num{font-weight:500;color:var(--muted)}
.v2-matrix__channel{display:inline-flex;flex-direction:column}
.v2-matrix__channel>span+span{font-weight:500}
.v2-matrix__switch{display:inline-flex;align-items:center;gap:var(--space-1);min-height:var(--target);font-size:13px;cursor:pointer}
.v2-matrix__event{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) 12px}
.v2-matrix__fixed{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--ok)}
`
