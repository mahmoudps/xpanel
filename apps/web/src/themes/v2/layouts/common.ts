// Shared pieces of the v2 page layouts: the page top (header, notices, KPI strip), the state slots, the facts list,
// the revision-checked save bar and the <template> slots core controllers clone.

import type { Translate } from '../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
export { xpTemplate } from '../html.ts'
import { APPLY_DOT } from '../components/change-review.ts'
import { card, type CardProps } from '../components/card.ts'
import { kpiCard, type KpiCardProps } from '../components/kpi-card.ts'
import { notice, type NoticeProps } from '../components/notice.ts'
import { pageHeader, type PageHeaderProps } from '../components/page-header.ts'
import { emptyState, errorState, loadingState, type EmptyStateProps, type ErrorStateProps, type LoadingStateProps } from '../components/state-block.ts'

export interface KpiStripProps {
  /** Names the summary region, such as "Token summary". */
  label: string
  items: readonly KpiCardProps[]
  busy?: boolean
  hooks?: HookAttributes
}

/** What every page layout starts with. */
export interface PageBaseProps {
  header: PageHeaderProps
  /** Banners under the header: page messages, capability notes, errors of the last action. */
  notices?: readonly NoticeProps[]
  kpis?: KpiStripProps
  /** Hooks on the layout root, such as the workspace root a core controller binds to. */
  hooks?: HookAttributes
}

export type LayoutState = 'ready' | 'loading' | 'empty' | 'error'

/** The kit state blocks a layout shows instead of (or above) its content. */
export interface StateSlots {
  loading?: LoadingStateProps
  empty?: EmptyStateProps
  error?: ErrorStateProps
}

export interface Fact {
  label: string
  value: string
  /** Technical values (paths, users, versions) in the monospace face. */
  mono?: boolean
  /** Keep an LTR reference or date isolated within the field's normal alignment edge. */
  ltr?: boolean
}

export const kpiStrip = (props: KpiStripProps): string =>
  `<section class="v2-kpi-row" aria-label="${escapeHtml(props.label)}"${props.busy ? ' aria-busy="true"' : ''}${hookAttrs(props.hooks)}>${props.items.map(item => kpiCard({ headingLevel: 2, ...item })).join('')}</section>`

/** The layout root: header, notices, lead content (a page-state banner, a query form) and the KPI strip, then the
 *  family body, 32px apart like the page sections. */
export const layoutRoot = (t: Translate, base: PageBaseProps, bodyHtml: string, leadHtml = ''): string =>
  `<div class="v2-layout"${hookAttrs(base.hooks)}>${pageHeader(t, base.header)}${(base.notices ?? []).map(item => notice(t, item)).join('')}${leadHtml}${base.kpis ? kpiStrip(base.kpis) : ''}${bodyHtml}</div>`

/** The state block for a state other than ready; '' when ready. */
export function stateBlock(t: Translate, state: LayoutState, slots: StateSlots = {}): string {
  if (state === 'loading') return loadingState(t, slots.loading ?? {})
  if (state === 'empty') return emptyState(slots.empty ?? { icon: 'inbox', title: t(msgctxt('theme:v2', 'Nothing to show yet.')) })
  if (state === 'error') return errorState(t, slots.error ?? { lead: t(msgctxt('theme:v2', 'This page could not be read.')) })
  return ''
}

export const factList = (facts: readonly Fact[], label?: string): string =>
  `<dl class="v2-facts"${label ? ` aria-label="${escapeHtml(label)}"` : ''}>${facts.map(fact => `<div><dt>${escapeHtml(fact.label)}</dt><dd><bdi class="v2-num${fact.mono ? ' v2-mono' : ''}" dir="${fact.ltr || fact.mono ? 'ltr' : 'auto'}">${escapeHtml(fact.value)}</bdi></dd></div>`).join('')}</dl>`

/** Main column beside an aside of cards; the aside stacks under the main column on narrow screens. */
export function splitWithAside(mainHtml: string, aside: { label: string; html: string } | undefined): string {
  if (!aside?.html) return `<div class="v2-stack">${mainHtml}</div>`
  return `<div class="v2-split"><div class="v2-stack">${mainHtml}</div><aside class="v2-aside" aria-label="${escapeHtml(aside.label)}">${aside.html}</aside></div>`
}

export const cards = (items: readonly CardProps[] | undefined): string => (items ?? []).map(card).join('')

export interface RevisionSaveProps {
  pendingCount: number
  /** The stored revision this form was read at; core refuses the save when the stored revision moved on. */
  revision: string
  /** What saving does, such as "nothing is sent and no service reloads". */
  note?: string
  saveLabel?: string
  /** Id of the change review the save button opens (`aria-controls`). */
  controls?: string
  discard: HookAttributes
  save: HookAttributes
  hooks?: HookAttributes
}

/** The save bar of settings that are not configuration generations: a revision-checked save, no tests. */
export const revisionSaveBar = (t: Translate, props: RevisionSaveProps): string =>
  `<div class="v2-apply" data-state="${props.pendingCount ? 'pending' : 'clean'}"${hookAttrs(props.hooks)}><p class="v2-apply__text v2-num" role="status">${APPLY_DOT}<strong>${escapeHtml(t(msgctxt('theme:v2', '{count, plural, one {# pending change} other {# pending changes}}'), { count: props.pendingCount }))}</strong> <span>${escapeHtml(props.note ?? t(msgctxt('theme:v2', 'Saved with a revision check: if the stored settings changed after this page read them, nothing is overwritten.')))}</span></p><input type="hidden" name="revision" value="${escapeHtml(props.revision)}"><span class="v2-apply__actions"><button type="button" class="v2-btn"${hookAttrs(props.discard)}>${escapeHtml(t('Discard'))}</button><button type="button" class="v2-btn v2-btn--primary"${props.controls ? ` aria-controls="${escapeHtml(props.controls)}"` : ''}${hookAttrs(props.save)}>${escapeHtml(props.saveLabel ?? t(msgctxt('theme:v2', 'Review and save')))}</button></span></div>`

/** The labelled region at the end of an editing page that holds its apply or save bar. */
export const commitRegion = (label: string, barHtml: string): string =>
  `<section class="v2-commit" aria-label="${escapeHtml(label)}">${barHtml}</section>`

export const COMMON_LAYOUT_CSS = `.v2-layout{display:flex;flex-direction:column;gap:var(--space-4);min-width:0}
.v2-stack{display:flex;flex-direction:column;gap:var(--space-3);min-width:0}
.v2-stack--tight{gap:var(--space-2)}
.v2-aside{flex:1 1 340px;max-width:440px;min-width:0;display:flex;flex-direction:column;gap:var(--space-3)}
.v2-grid{display:flex;flex-wrap:wrap;align-items:stretch;gap:var(--space-3)}
.v2-grid__cell{flex:1 1 420px;min-width:0;display:flex;flex-direction:column}
.v2-grid__cell>*{flex:1 1 auto}
.v2-grid__cell--full{flex-basis:100%}
.v2-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));align-items:end;gap:var(--space-2)}
.v2-fields>.v2-switch-row{grid-column:1/-1}
.v2-fields--row{display:flex;flex-wrap:wrap}
.v2-fields--row>.v2-field{flex:1 1 160px}
.v2-fields>.v2-switch-row+.v2-switch-row{padding-top:var(--space-2);border-top:1px solid var(--line)}
.v2-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:var(--space-2)}
.v2-facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-width:0;font-size:13px}
.v2-facts dt{color:var(--muted)}
.v2-facts dd{text-align:start;overflow-wrap:anywhere}
.v2-inset{padding:var(--space-2) var(--space-3) var(--space-3)}
.v2-card__actions>.v2-filter{padding:0}
.v2-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:var(--space-1) var(--space-2);padding:var(--space-2) var(--space-3);border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
`
