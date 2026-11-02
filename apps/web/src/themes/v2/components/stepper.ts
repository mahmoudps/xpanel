import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon } from '../icons.ts'

/** `passed` and `pending` are the reconcile pipeline names of done and upcoming. */
export type StepState = 'done' | 'passed' | 'current' | 'running' | 'failed' | 'upcoming' | 'pending'

export interface StepItem {
  label: string
  /** Short state line under the label, such as "Done" or "nginx -t". */
  sub?: string
  state: StepState
  hooks?: HookAttributes
}

export interface StepperProps {
  label: string
  /** Labels beside the markers (flow steps, TplWizard); otherwise under them (the reconcile pipeline). */
  inline?: boolean
  steps: readonly StepItem[]
  hooks?: HookAttributes
}

// Every marker is present and CSS shows the one for the current data-step-status, so a live status change
// needs no markup from the controller.
const marker = (index: number): string =>
  `<span class="v2-step__m v2-step__m--done">${icon('check', 14)}</span><span class="v2-step__m v2-step__m--fail">${icon('x', 14)}</span><span class="v2-step__m v2-step__m--run" aria-hidden="true"></span><span class="v2-step__m v2-step__m--num v2-num">${index + 1}</span>`

/** Steps of a flow; the current step carries aria-current="step". Inline steps put marker, label and rail side by
 *  side and wrap onto further rows (one per row at phone width). Styles key on data-step-status so a live
 *  controller that updates that attribute restyles the step. */
export const stepper = (props: StepperProps): string =>
  `<ol class="v2-steps${props.inline ? ' v2-steps--inline' : ''}" aria-label="${escapeHtml(props.label)}"${hookAttrs(props.hooks)}>${props.steps.map((step, index) =>
    `<li class="v2-step" data-step-status="${step.state}"${step.state === 'current' || step.state === 'running' ? ' aria-current="step"' : ''}${hookAttrs(step.hooks)}><span class="v2-step__dot">${marker(index)}</span><span class="v2-step__text"><span class="v2-step__label">${escapeHtml(step.label)}</span>${step.sub ? `<span class="v2-step__sub v2-num">${escapeHtml(step.sub)}</span>` : ''}</span><span class="v2-step__rail" aria-hidden="true"></span></li>`).join('')}</ol>`

const DONE = ':is([data-step-status=done],[data-step-status=passed])'
const NOW = ':is([data-step-status=current],[data-step-status=running])'
// Stacked: marker and rail on one grid row, the text under them. Inline: one flex row per step.
const IN = '.v2-steps--inline>.v2-step'
export const STEPPER_CSS = `.v2-steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(140px,100%),1fr));gap:var(--space-2) 0}
.v2-step{min-width:0;display:grid;grid-template-columns:28px 1fr;align-items:center;gap:var(--space-1)}
.v2-step__dot{flex:none;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;box-shadow:inset 0 0 0 1px var(--line-strong);color:var(--muted);font-size:13px;font-weight:600}
.v2-step__text{grid-row:2;grid-column:1/-1;display:flex;flex-direction:column;min-width:0;padding-inline-end:12px}
.v2-step__label{font-size:13px;font-weight:600;color:var(--muted)}
.v2-step__sub{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.v2-step__rail{grid-row:1;grid-column:2;height:2px;border-radius:1px;background:var(--line)}
.v2-step:last-child>.v2-step__rail{visibility:hidden}
.v2-steps--inline{display:flex;flex-wrap:wrap}
${IN}{flex:1 1 200px;display:flex;gap:12px}
${IN}>.v2-step__text{gap:2px;padding:0}
${IN} .v2-step__label{font-size:14px;font-weight:500}
${IN}>.v2-step__rail{flex:1 1 auto;min-width:var(--space-2);margin-inline-end:var(--space-2);background:var(--line-strong)}
${IN}:last-child>.v2-step__rail{display:none}
.v2-step${DONE} .v2-step__dot{box-shadow:inset 0 0 0 1px var(--ok-line);background:var(--ok-soft);color:var(--ok)}
${IN}${DONE} .v2-step__dot,${IN}[data-step-status=failed] .v2-step__dot{box-shadow:none}
.v2-step${DONE} .v2-step__label{color:var(--text)}
.v2-step${DONE}>.v2-step__rail{background:var(--ok)}
${IN}${DONE} .v2-step__sub{color:var(--ok)}
.v2-step${NOW} .v2-step__dot{box-shadow:none;background:var(--accent-fill);color:var(--on-accent)}
.v2-step${NOW} .v2-step__label{color:var(--accent)}
${IN}${NOW} .v2-step__label{font-weight:600;color:var(--text)}
${IN}${NOW} .v2-step__sub{color:var(--accent)}
.v2-step[data-step-status=failed] .v2-step__dot{box-shadow:inset 0 0 0 1px var(--bad-line);background:var(--bad-soft);color:var(--bad)}
.v2-step[data-step-status=failed] :is(.v2-step__label,.v2-step__sub){color:var(--bad)}
.v2-step__m{display:none}
.v2-step__m--run{width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-inline-end-color:transparent;animation:v2-spin .9s linear infinite}
.v2-step:is([data-step-status=current],[data-step-status=upcoming],[data-step-status=pending]) .v2-step__m--num,.v2-step${DONE} .v2-step__m--done,.v2-step[data-step-status=running] .v2-step__m--run,.v2-step[data-step-status=failed] .v2-step__m--fail{display:flex}
`
