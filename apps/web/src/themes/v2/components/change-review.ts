import type { Translate } from '../../../i18n.ts'
import { attr, escapeHtml, hookAttrs, xpTemplate, type HookAttributes } from '../html.ts'
import { icon, type IconName } from '../icons.ts'
import { statusPill, type StatusPillProps } from './status-pill.ts'

export interface ReviewRow {
  label: string
  current: string
  proposed: string
  /** Technical values (paths, limits as written to config) in the monospace face. */
  mono?: boolean
  /** Per-field review: the form field the row's Undo restores (`data-xp-field`). */
  field?: string
  /** Per-field review: the list edits in words, such as "+ spam@example.com  - old.example". */
  detail?: string
  /** The proposed value does not validate; it shows in the problem tone. */
  invalid?: boolean
}

/** One check that runs before the switch: the command and what it proves, such as "parses the whole rspamd configuration". */
export interface ReviewTest {
  command: string
  purpose?: string
}

export interface ReviewStep {
  icon: IconName
  text: string
}

export interface ChangeReviewProps {
  title: string
  titleId: string
  /** Id of the section, for the save bar control that opens the review (`aria-controls`). */
  id?: string
  description?: string
  status?: StatusPillProps
  /** Text beside the title, such as "2 pending changes". */
  meta?: string
  /** `fields` (TplSettings): one row per changed field, current beside proposed, each with Undo. `sides` (TplMatrix,
   *  TplWizard): all current values beside all proposed values. */
  layout?: 'sides' | 'fields'
  /** Heading of the current values, such as "Current · gen 142" or "Current · saved 2026-10-22 14:05 UTC". */
  currentLabel?: string
  rows: readonly ReviewRow[]
  /** Per-field review: shown while no row is pending, such as "No pending changes. The form matches generation 142." */
  emptyText?: string
  /** Hooks on the per-field row list, which core repaints from the `review-row` template. */
  rowsHooks?: HookAttributes
  /** Checks that run before the switch, such as "nginx -t" or "apachectl configtest". Settings saved with a
   *  revision check instead of a generation pass none, and the gate is left out. */
  tests: readonly ReviewTest[]
  /** The active generation, kept on disk as the rollback target. */
  rollbackGeneration?: number
  /** Exactly what the change affects and what it keeps. */
  impact?: { lead: string; text: string }
  /** What saving does, step by step: the file it writes, what it does not reload, where it is recorded. */
  steps?: { label: string; items: readonly ReviewStep[] }
  /** The in-review actions: back to the form, and the save itself. */
  actions?: { back: { label?: string; hooks: HookAttributes }; save: { label?: string; hooks: HookAttributes } }
  /** The apply bar of this change, built with {@link applyBar}. */
  applyBarHtml?: string
  hooks?: HookAttributes
}

const facts = (rows: readonly ReviewRow[], side: 'current' | 'proposed'): string =>
  `<dl>${rows.map(row => {
    const changed = side === 'proposed' && row.current !== row.proposed
    return `<div><dt>${escapeHtml(row.label)}</dt><dd class="v2-num${row.mono ? ' v2-mono' : ''}${changed ? ' v2-review__changed' : ''}">${escapeHtml(row[side])}</dd></div>`
  }).join('')}</dl>`

// One per-field row. Without a row it is the `review-row` template: core fills its text slots, sets data-xp-field and
// the aria-label of Undo, and data-state (changed or invalid) on the clone root.
function fieldRow(t: Translate, currentLabel: string, row?: ReviewRow): string {
  const slot = (name: string, value: string | undefined, cls: string): string =>
    `<span class="${cls}" data-xp-slot="${name}"${row && !value ? ' data-empty' : ''}>${escapeHtml(value ?? '')}</span>`
  const value = 'v2-num v2-mono'
  const undo = row && !row.field ? ''
    : `<button type="button" class="v2-btn v2-btn--ghost v2-review__undo" data-xp-action="undo"${row ? ` data-xp-field="${escapeHtml(row.field!)}" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Undo the change to {field}'), { field: row.label }))}"` : ''}>${escapeHtml(t('Undo'))}</button>`
  return `<li class="v2-review__row" data-state="${row?.invalid ? 'invalid' : 'changed'}"><div class="v2-review__row-head">${slot('name', row?.label, 'v2-review__name')}${undo}</div><div class="v2-review__pair"><div class="v2-review__box"><span>${escapeHtml(currentLabel)}</span>${slot('current', row?.current, value)}</div>${icon('arrow', 16)}<div class="v2-review__box v2-review__box--proposed"><span>${escapeHtml(t('Proposed'))}</span>${slot('proposed', row?.proposed, value)}</div></div>${slot('details', row?.detail, 'v2-review__detail v2-mono')}</li>`
}

export function changeReview(t: Translate, props: ChangeReviewProps): string {
  const currentLabel = props.currentLabel ?? t('Current')
  const rollback = props.rollbackGeneration === undefined ? ''
    : `<p class="v2-review__note">${escapeHtml(t(msgctxt('theme:v2', 'Generation {generation} stays on disk as the rollback target. If a test fails, generation {generation} stays live and nothing is reloaded.'), { generation: props.rollbackGeneration }))}</p>`
  const impact = props.impact
    ? `<div class="v2-notice v2-notice--warn v2-review__impact" role="note">${icon('alert')}<p><strong>${escapeHtml(props.impact.lead)}</strong> ${escapeHtml(props.impact.text)}</p></div>` : ''
  const head = `${props.meta ? `<span class="v2-review__meta v2-num">${escapeHtml(props.meta)}</span>` : ''}${props.status ? statusPill({ ...props.status, live: true }) : ''}`
  const compare = props.layout === 'fields'
    ? `<ul class="v2-review__rows"${hookAttrs(props.rowsHooks)}>${props.rows.map(row => fieldRow(t, currentLabel, row)).join('')}</ul>${props.emptyText ? `<p class="v2-review__empty v2-num">${escapeHtml(props.emptyText)}</p>` : ''}${xpTemplate('review-row', fieldRow(t, currentLabel))}`
    : `<div class="v2-review__compare"><div class="v2-review__side"><h3>${escapeHtml(currentLabel)}</h3>${facts(props.rows, 'current')}</div>${icon('arrow', 20)}<div class="v2-review__side v2-review__side--proposed"><h3>${escapeHtml(t('Proposed'))}</h3>${facts(props.rows, 'proposed')}</div></div>`
  const gate = props.tests.length || rollback || impact
    ? `<div class="v2-review__gate">${props.tests.length || rollback ? `<div class="v2-review__tests">${props.tests.length ? `<h3>${escapeHtml(t(msgctxt('theme:v2', 'Before the switch')))}</h3><ol>${props.tests.map(test => `<li><code>${escapeHtml(test.command)}</code>${test.purpose ? ` ${escapeHtml(test.purpose)}` : ''}</li>`).join('')}</ol>` : ''}${rollback}</div>` : ''}${impact}</div>` : ''
  const steps = props.steps ? `<ul class="v2-review__steps" aria-label="${escapeHtml(props.steps.label)}">${props.steps.items.map(step => `<li>${icon(step.icon, 16)}<span>${escapeHtml(step.text)}</span></li>`).join('')}</ul>` : ''
  const actions = props.actions
    ? `<div class="v2-review__actions"><button type="button" class="v2-btn"${hookAttrs(props.actions.back.hooks)}>${escapeHtml(props.actions.back.label ?? t(msgctxt('theme:v2', 'Back to editing')))}</button><button type="button" class="v2-btn v2-btn--primary"${hookAttrs(props.actions.save.hooks)}>${escapeHtml(props.actions.save.label ?? t('Save settings'))}</button></div>` : ''
  return `<section class="v2-card v2-review"${attr('id', props.id)} aria-labelledby="${escapeHtml(props.titleId)}"${hookAttrs(props.hooks)}>
<div class="v2-card__head"><div class="v2-card__title"><h2 id="${escapeHtml(props.titleId)}">${escapeHtml(props.title)}</h2>${props.description ? `<p>${escapeHtml(props.description)}</p>` : ''}</div>${head}</div>
${compare}
${gate}${steps}${actions}${props.applyBarHtml ?? ''}
</section>`
}

// The bar's state dot follows data-state on the bar root ("pending" or "clean"), which core updates with the count.
export const APPLY_DOT = '<span class="v2-apply__dot" aria-hidden="true"></span>'

export interface ApplyBarProps {
  pendingCount: number
  /** Tests that run first; shown so the person knows nothing switches before they pass. */
  tests?: readonly string[]
  /** The generation this apply writes, and the active one kept as the rollback target. */
  nextGeneration?: number
  rollbackGeneration?: number
  discard: HookAttributes
  apply: HookAttributes
  hooks?: HookAttributes
}

export function applyBar(t: Translate, props: ApplyBarProps): string {
  const tests = props.tests?.length ? ` <span class="v2-apply__tests">${props.tests.map(test => `<code>${escapeHtml(test)}</code>`).join(' ')}</span>` : ''
  const generation = props.nextGeneration !== undefined && props.rollbackGeneration !== undefined
    ? `<span>${escapeHtml(t(msgctxt('theme:v2', 'Applies as generation {next}; generation {current} stays as the rollback target'), { next: props.nextGeneration, current: props.rollbackGeneration }))}</span>` : ''
  return `<div class="v2-apply" data-state="${props.pendingCount ? 'pending' : 'clean'}"${hookAttrs(props.hooks)}><p class="v2-apply__text v2-num" role="status">${APPLY_DOT}<strong>${escapeHtml(t(msgctxt('theme:v2', '{count, plural, one {# pending change} other {# pending changes}}'), { count: props.pendingCount }))}</strong> <span>${escapeHtml(t(msgctxt('theme:v2', 'Tests run before the switch')))}${tests ? ':' : ''}</span>${tests}${generation}</p><span class="v2-apply__actions"><button type="button" class="v2-btn"${hookAttrs(props.discard)}>${escapeHtml(t('Discard'))}</button><button type="button" class="v2-btn v2-btn--primary"${hookAttrs(props.apply)}>${escapeHtml(t(msgctxt('theme:v2', 'Review and apply')))}</button></span></div>`
}

// The review takes the accent line while it holds pending rows or its in-review actions, as on the boards.
export const CHANGE_REVIEW_CSS = `.v2-review:has(.v2-review__rows>li,>.v2-review__actions){border-color:var(--accent-line)}
.v2-review>.v2-card__head{align-items:baseline}
.v2-review__meta{font-size:13px;color:var(--muted)}
.v2-review__compare{display:flex;flex-wrap:wrap;align-items:stretch;gap:var(--space-1) 12px}
.v2-review__compare>.v2-icon{flex:none;align-self:center;color:var(--muted)}
.v2-review__side{flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:var(--space-1);padding:var(--space-2);border-radius:var(--radius-notice);background:var(--subtle);border:1px solid var(--line)}
.v2-review__side h3{font-size:12px;font-weight:600;color:var(--muted)}
.v2-review__side--proposed{background:var(--accent-soft);border-color:var(--accent-line)}
.v2-review__side--proposed h3{color:var(--accent)}
.v2-review__side dl{display:flex;flex-direction:column;gap:var(--space-1)}
.v2-review__side dl>div{display:flex;flex-direction:column;gap:2px;min-width:0}
.v2-review__side dt{font-size:12px;color:var(--muted)}
.v2-review__side dd{font-size:13px;overflow-wrap:anywhere}
.v2-review__changed{font-weight:600}
.v2-review__rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--space-2)}
.v2-review__rows:not(:empty)+.v2-review__empty{display:none}
.v2-review__empty{font-size:13px;line-height:1.6;color:var(--muted)}
.v2-review__row{display:flex;flex-direction:column;gap:var(--space-1)}
.v2-review__row-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-1)}
.v2-review__name{font-size:13px;font-weight:600}
.v2-review__undo{padding:0 var(--space-1);font-size:13px}
.v2-review__pair{display:flex;align-items:stretch;gap:var(--space-1)}
.v2-review__pair>.v2-icon{flex:none;align-self:center;color:var(--muted)}
.v2-review__box{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:var(--radius-control);background:var(--subtle);border:1px solid var(--line)}
.v2-review__box>:first-child{font-size:12px;color:var(--muted)}
.v2-review__box>:last-child{font-size:13px;overflow-wrap:anywhere}
.v2-review__box--proposed{background:var(--accent-soft);border-color:var(--accent-line)}
.v2-review__box--proposed>:last-child{font-weight:600}
.v2-review__row[data-state=invalid] .v2-review__box--proposed>:last-child{color:var(--bad)}
.v2-review__detail{font-size:12px;color:var(--text-2);overflow-wrap:anywhere}
.v2-review__detail[data-empty]{display:none}
.v2-review__gate{display:flex;flex-wrap:wrap;align-items:flex-start;gap:var(--space-2) var(--space-3)}
.v2-review__tests{flex:1 1 420px;min-width:0;display:flex;flex-direction:column;gap:var(--space-1)}
.v2-review__tests ol{margin:0;padding-inline-start:20px;display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:1.55;color:var(--text-2)}
.v2-review__tests code{font-family:var(--font-mono);font-size:12px;color:var(--text)}
.v2-review__note{font-size:12px;color:var(--muted);line-height:1.6}
.v2-review__impact{flex:1 1 360px;min-width:0}
.v2-review__steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:12px}
.v2-review__steps>li{display:flex;gap:10px;padding:12px 14px;border-radius:var(--radius-control);border:1px solid var(--line);background:var(--subtle);font-size:13px;line-height:1.6}
.v2-review__steps .v2-icon{flex:none;margin-top:3px;color:var(--accent)}
.v2-review__steps span{min-width:0;overflow-wrap:anywhere}
.v2-review__actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:12px}
.v2-apply{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-2);padding:12px;padding-inline-start:20px;border-radius:var(--radius-notice);background:var(--subtle);border:1px solid var(--line)}
.v2-apply__text{display:flex;flex-wrap:wrap;align-items:center;gap:4px var(--space-1);font-size:13px;color:var(--text-2)}
.v2-apply__text strong{color:var(--text);font-weight:600}
.v2-apply__dot{display:inline-block;width:8px;height:8px;margin-inline-end:8px;border-radius:50%;background:var(--muted);vertical-align:middle}
.v2-apply[data-state="pending"] .v2-apply__dot{background:var(--warn)}
.v2-apply__tests{display:inline-flex;flex-wrap:wrap;gap:4px}
.v2-apply__tests code{padding:0 6px;border-radius:6px;background:var(--sunken);font-size:12px}
.v2-apply__actions{display:inline-flex;flex-wrap:wrap;gap:var(--space-1);margin-inline-start:auto}
`
