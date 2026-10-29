// Wizard family (TplWizard): a stepper with the choices so far, one body panel per step (core shows the current
// one), a review step built from the change review, and Back/Next navigation.

import type { Translate } from '../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { type CardProps } from '../components/card.ts'
import { changeReview, type ChangeReviewProps } from '../components/change-review.ts'
import { stepper, type StepItem } from '../components/stepper.ts'
import { cards, factList, layoutRoot, splitWithAside, stateBlock, type Fact, type LayoutState, type PageBaseProps, type StateSlots } from './common.ts'

export interface WizardStep extends StepItem {
  /** Prefix of the panel's ids: `<id>-title`. */
  id: string
  /** The step heading, such as "Choose the addon domain". */
  title: string
  bodyHtml?: string
  /** The review step: current vs proposed and the gate, from the kit change review. */
  review?: ChangeReviewProps
  /** Hooks on the step's panel, which core shows and hides as the step changes. */
  panelHooks?: HookAttributes
}

export interface WizardPageProps extends PageBaseProps {
  /** Names the steps region, such as "Conversion steps". */
  label: string
  steps: readonly WizardStep[]
  /** The choices made so far, such as the domain and the new username. */
  summary?: readonly Fact[]
  /** Error shows above the steps' panel and locks it; loading replaces the current step's body. */
  state?: Exclude<LayoutState, 'empty'>
  states?: StateSlots
  nav: {
    back?: { label?: string; hooks: HookAttributes }
    /** Without a reason the step can go on; with one, Next is aria-disabled and described by the reason. */
    next: { label: string; hooks: HookAttributes; blockedReason?: string }
    note?: string
    /** Links shown when the flow is done, built with the kit. */
    linksHtml?: string
  }
  aside?: readonly CardProps[]
  asideLabel?: string
  extra?: readonly CardProps[]
}

const NOW = new Set(['current', 'running', 'failed'])

export function wizardPage(t: Translate, props: WizardPageProps): string {
  const state = props.state ?? 'ready'
  const total = props.steps.length
  const current = Math.max(0, props.steps.findIndex(step => NOW.has(step.state)))
  const panels = props.steps.map((step, index) => {
    if (!step.bodyHtml && !step.review) return ''
    const titleId = `${step.id}-title`
    const body = index === current && state === 'loading' ? stateBlock(t, 'loading', props.states)
      : `${step.bodyHtml ?? ''}${step.review ? changeReview(t, step.review) : ''}`
    return `<section class="v2-wizard__panel" aria-labelledby="${escapeHtml(titleId)}"${index === current ? '' : ' hidden'}${hookAttrs(step.panelHooks)}><header class="v2-wizard__head"><p class="v2-wizard__kicker v2-num">${escapeHtml(t(msgctxt('theme:v2', 'Step {current} of {total}'), { current: index + 1, total }))}</p><h2 id="${escapeHtml(titleId)}">${escapeHtml(step.title)}</h2></header><div class="v2-wizard__body">${body}</div></section>`
  }).join('')
  const { nav } = props
  const reasonId = 'v2-wizard-next-reason'
  const next = `<button type="button" class="v2-btn v2-btn--primary"${nav.next.blockedReason ? ` aria-disabled="true" aria-describedby="${reasonId}"` : ''}${hookAttrs(nav.next.hooks)}>${escapeHtml(nav.next.label)}</button>`
  const foot = `<footer class="v2-wizard__foot"><div class="v2-wizard__note">${nav.note ? `<p>${escapeHtml(nav.note)}</p>` : ''}${nav.next.blockedReason ? `<p id="${reasonId}">${escapeHtml(nav.next.blockedReason)}</p>` : ''}</div><span class="v2-wizard__nav">${nav.back ? `<button type="button" class="v2-btn"${hookAttrs(nav.back.hooks)}>${escapeHtml(nav.back.label ?? t('Back'))}</button>` : ''}${nav.linksHtml ?? ''}${next}</span></footer>`
  const steps = `<section class="v2-card v2-wizard__steps" aria-label="${escapeHtml(props.label)}">${stepper({ label: t('Steps'), steps: props.steps, inline: true })}${props.summary?.length ? factList(props.summary, t('Your choices')) : ''}</section>`
  const flow = `<div class="v2-card v2-card--flush v2-wizard">${panels}${foot}</div>`
  const side = cards(props.aside)
  return layoutRoot(t, props, `${steps}${state === 'error' ? stateBlock(t, 'error', props.states) : ''}${splitWithAside(flow, side ? { label: props.asideLabel ?? props.label, html: side } : undefined)}${cards(props.extra)}`)
}

export const WIZARD_LAYOUT_CSS = `.v2-wizard__steps{gap:var(--space-3);padding:20px var(--space-3)}
.v2-wizard__steps>.v2-facts{display:flex;flex-wrap:wrap;gap:var(--space-1);padding-top:var(--space-2);border-top:1px solid var(--line)}
.v2-wizard__steps>.v2-facts>div{align-items:center;gap:var(--space-1);padding:4px 12px;border:1px solid var(--line);border-radius:var(--radius-pill);font-size:12px}
.v2-wizard__steps>.v2-facts dd{font-weight:600}
.v2-wizard__head{display:flex;flex-direction:column;gap:4px;padding:20px var(--space-3);border-bottom:1px solid var(--line)}
.v2-wizard__kicker{font-size:12px;font-weight:600;color:var(--accent)}
.v2-wizard__body{display:flex;flex-direction:column;gap:var(--space-3);padding:var(--space-3)}
.v2-wizard__body>.v2-review{padding:0;border:0;box-shadow:none}
.v2-wizard__foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px var(--space-2);margin-top:auto;padding:var(--space-2) var(--space-3);border-top:1px solid var(--line)}
.v2-wizard__note{flex:1 1 280px;font-size:13px;color:var(--muted)}
.v2-wizard__nav{display:flex;flex-wrap:wrap;gap:var(--space-1);margin-inline-start:auto}
`
