// Dashboard family (TplDashboard): KPI grid, chart cards and service/status lists, each check graded in words.

import type { Translate } from '../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes, type Tone } from '../html.ts'
import { icon, type IconName } from '../icons.ts'
import { card } from '../components/card.ts'
import { barChart, lineChart, type BarChartProps, type LineChartProps } from '../components/chart.ts'
import { filterBar, type FilterBarProps } from '../components/filter-bar.ts'
import { meter, type MeterProps } from '../components/meter.ts'
import { emptyState, type EmptyStateProps } from '../components/state-block.ts'
import { statePill, stateTones, statusPill, type StatusPillProps } from '../components/status-pill.ts'
import { layoutRoot, stateBlock, xpTemplate, type LayoutState, type PageBaseProps, type StateSlots } from './common.ts'
import { sectionGrid, type GridSection } from './custom-page.ts'

export interface ChartCard {
  title: string
  titleId: string
  description?: string
  actionsHtml?: string
  /** One chart per card: a line chart (series over time) or a bar chart. */
  chart: ({ kind: 'line' } & LineChartProps) | ({ kind: 'bar' } & BarChartProps)
  full?: boolean
  hooks?: HookAttributes
}

export interface StatusItem {
  title: string
  /** Cause and consequence in words, such as "Disk / at 91%, above the 90% problem mark." */
  text?: string
  icon?: IconName
  tone?: Tone
  status: StatusPillProps
  metric?: { label: string; value: string }
  /** A fix link or an evidence toggle, built with the kit. */
  actionsHtml?: string
  hooks?: HookAttributes
}

export interface StatusList {
  title: string
  titleId: string
  description?: string
  /** Segmented filters by state, with counts. */
  filters?: FilterBarProps['segments']
  items: readonly StatusItem[]
  state?: LayoutState
  states?: StateSlots
  /** Shown when the filters exclude every item. */
  noMatch?: EmptyStateProps
  /** Emits the item core clones for live updates (`status-item`): slots name, state, message and item (the
   *  metric), the tone from data-state on the clone root. `actionsHtml` holds its controls, each with a
   *  data-xp-action verb. */
  itemTemplate?: { icon?: IconName; actionsHtml?: string }
  /** Hooks on the <ul> the items are painted into. */
  listHooks?: HookAttributes
  hooks?: HookAttributes
}

export interface MeterCard {
  title: string
  titleId: string
  /** Such as "Values from the read at 14:05 UTC. The ticks mark where a check turns into a warning and a problem." */
  description?: string
  /** Threshold meters (`scale` with warning and problem ticks); a legend names the fill and both ticks. */
  items: readonly MeterProps[]
  hooks?: HookAttributes
}

export interface DashboardPageProps extends PageBaseProps {
  /** Loading and empty replace the charts and lists; an error banner keeps the last read under it. */
  state?: LayoutState
  states?: StateSlots
  /** Measured against thresholds: the card after the KPI grid. */
  meters?: MeterCard
  charts?: readonly ChartCard[]
  lists?: readonly StatusList[]
  /** Further cards in the grid, such as thresholds or related diagnostics. */
  sections?: readonly GridSection[]
}

export const statusItem = (item: StatusItem): string =>
  `<li class="v2-status-item" data-state="${item.status.tone}"${hookAttrs(item.hooks)}>${item.icon ? `<span class="v2-tile v2-tile--${item.tone ?? item.status.tone}" aria-hidden="true">${icon(item.icon)}</span>` : ''}<div class="v2-status-item__main"><div class="v2-status-item__title"><h3>${escapeHtml(item.title)}</h3>${statusPill(item.status)}</div>${item.text ? `<p>${escapeHtml(item.text)}</p>` : ''}</div>${item.metric ? `<p class="v2-status-item__metric"><span>${escapeHtml(item.metric.label)}</span> <span class="v2-num">${escapeHtml(item.metric.value)}</span></p>` : ''}${item.actionsHtml ? `<div class="v2-status-item__actions">${item.actionsHtml}</div>` : ''}</li>`

/** The `status-item` template; its tokens are the kit tones (ok, warn, bad, info, neutral). */
export const statusItemTemplate = (props: NonNullable<StatusList['itemTemplate']>): string => xpTemplate('status-item',
  `<li class="v2-status-item" data-state="neutral">${props.icon ? `<span class="v2-tile v2-tile--state" aria-hidden="true">${icon(props.icon)}</span>` : ''}<div class="v2-status-item__main"><div class="v2-status-item__title"><h3 data-xp-slot="name"></h3>${statePill()}</div><p data-xp-slot="message"></p></div><p class="v2-status-item__metric v2-num" data-xp-slot="item"></p>${props.actionsHtml ? `<div class="v2-status-item__actions">${props.actionsHtml}</div>` : ''}</li>`)

export function statusList(t: Translate, list: StatusList): string {
  const state = list.state ?? 'ready'
  const body = state !== 'ready' ? stateBlock(t, state, list.states)
    : list.items.length ? `<ul class="v2-status-list" aria-live="polite"${hookAttrs(list.listHooks)}>${list.items.map(statusItem).join('')}</ul>`
    : list.noMatch ? emptyState(list.noMatch) : `<ul class="v2-status-list" aria-live="polite"${hookAttrs(list.listHooks)}></ul>`
  return card({
    title: list.title, titleId: list.titleId, description: list.description, hooks: list.hooks,
    actionsHtml: list.filters && state === 'ready' ? filterBar({ segments: list.filters }) : undefined,
    bodyHtml: `${body}${list.itemTemplate ? statusItemTemplate(list.itemTemplate) : ''}`,
  })
}

export const meterCard = (t: Translate, props: MeterCard): string => card({
  title: props.title, titleId: props.titleId, description: props.description, hooks: props.hooks,
  actionsHtml: `<ul class="v2-legend" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Legend')))}"><li><span class="v2-legend__fill" aria-hidden="true"></span>${escapeHtml(t(msgctxt('theme:v2', 'Measured value')))}</li><li><span class="v2-legend__tick v2-meter__tick--warn" aria-hidden="true"></span>${escapeHtml(t(msgctxt('theme:v2', 'Warning tick')))}</li><li><span class="v2-legend__tick v2-meter__tick--bad" aria-hidden="true"></span>${escapeHtml(t(msgctxt('theme:v2', 'Problem tick')))}</li></ul>`,
  bodyHtml: `<ul class="v2-meters">${props.items.map(item => `<li>${meter(item)}</li>`).join('')}</ul>`,
})

export function dashboardPage(t: Translate, props: DashboardPageProps): string {
  const state = props.state ?? 'ready'
  if (state === 'loading' || state === 'empty') return layoutRoot(t, props, stateBlock(t, state, props.states))
  const charts = (props.charts ?? []).map(chart => ({
    title: chart.title, titleId: chart.titleId, description: chart.description, actionsHtml: chart.actionsHtml, full: chart.full, hooks: chart.hooks,
    bodyHtml: chart.chart.kind === 'line' ? lineChart(chart.chart) : barChart(chart.chart),
  }))
  const lists = (props.lists ?? []).map(list => statusList(t, list)).join('')
  return layoutRoot(t, props, `${props.meters ? meterCard(t, props.meters) : ''}${charts.length ? sectionGrid(charts) : ''}${lists}${props.sections?.length ? sectionGrid(props.sections) : ''}`, state === 'error' ? stateBlock(t, 'error', props.states) : '')
}

// Checks sit in a grid of bordered tiles; a tile that needs attention takes its tone on the border.
export const DASHBOARD_LAYOUT_CSS = `.v2-status-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr));gap:var(--space-2)}
.v2-status-item{display:flex;flex-wrap:wrap;align-content:flex-start;gap:12px;padding:20px var(--space-2);border-radius:var(--radius-notice);border:1px solid var(--line)}
.v2-status-item[data-state=warn]{border-color:var(--warn-line)}
.v2-status-item[data-state=bad]{border-color:var(--bad-line)}
${stateTones('.v2-status-item', 'data-state', { ok: 'ok', warn: 'warn', bad: 'bad', info: 'info', neutral: 'neutral' })}
.v2-status-item [data-empty]{display:none}
.v2-status-item__main{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:4px}
.v2-status-item__title{display:flex;flex-wrap:wrap;align-items:center;gap:4px var(--space-1)}
.v2-status-item__main>p{font-size:13px;line-height:1.6;color:var(--text-2)}
.v2-status-item__metric{flex-basis:100%;display:flex;flex-wrap:wrap;justify-content:space-between;gap:var(--space-1);padding:12px var(--space-2);border-radius:var(--radius-chip);background:var(--subtle);font-size:13px;color:var(--muted)}
.v2-status-item__metric>.v2-num{font-weight:600;color:var(--text)}
.v2-card:has(>.v2-card__body>.v2-meters){gap:var(--space-3)}
.v2-card__head:has(>.v2-card__actions>.v2-legend){align-items:flex-end}
.v2-meters{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:var(--space-3) var(--space-4)}
.v2-legend{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:var(--space-1) var(--space-2);font-size:12px;color:var(--text-2)}
.v2-legend>li{display:inline-flex;align-items:center;gap:var(--space-1)}
.v2-legend__fill{width:16px;height:6px;border-radius:3px;background:var(--ok)}
.v2-legend__tick{width:2px;height:14px;border-radius:1px}
.v2-status-item__actions{flex-basis:100%;display:flex;flex-wrap:wrap;gap:var(--space-1)}
`
