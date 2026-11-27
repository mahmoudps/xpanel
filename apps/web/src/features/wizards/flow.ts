import { escapeAttr, escapeHtml, formatNumber, type TextTranslator } from '../../design-system/index.ts'
import type { BadgeTone } from '../../design-system/components/status-badge.ts'
import { renderWizard, type WizardChangeEntry, type WizardProgressStep } from '../../design-system/components/wizard.ts'

export interface GuidedWizardStep {
  readonly id: string
  readonly label: string
  readonly bodyHtml: string
}

export interface GuidedWizardOptions {
  readonly id: string
  readonly steps: readonly GuidedWizardStep[]
  readonly activeStepIndex?: number
  readonly disabled?: boolean
  readonly revealAllPanels?: boolean
  readonly preflightState?: { readonly tone: BadgeTone; readonly message: string }
  readonly changePlan?: readonly WizardChangeEntry[]
  readonly progressSteps?: readonly WizardProgressStep[]
  readonly receiptHtml?: string
  readonly submitLabel?: string
  readonly submitTarget?: string
  readonly locale?: string
  readonly copy?: TextTranslator
}

/**
 * Renders one-step-at-a-time design-system wizard chrome while keeping legacy
 * form controls, templates, and ROUTE_HOOKS inside step panels intact.
 */
export function renderGuidedWizard(options: GuidedWizardOptions): string {
  const activeStepIndex = options.activeStepIndex ?? 0
  const base = renderWizard({
    id: options.id,
    steps: options.steps,
    activeStepIndex,
    disabled: Boolean(options.disabled),
    revealAllPanels: options.revealAllPanels ?? true,
    ...(options.preflightState ? { preflightState: options.preflightState } : {}),
    ...(options.changePlan ? { changePlan: options.changePlan } : {}),
    ...(options.progressSteps ? { progressSteps: options.progressSteps } : {}),
    ...(options.receiptHtml ? { receiptHtml: options.receiptHtml } : {}),
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.copy ? { copy: options.copy } : {}),
  })
  if (!options.submitLabel) return base
  const finishText = escapeHtml(options.copy ? options.copy('Finish') : 'Finish')
  const customText = escapeHtml(options.submitLabel)
  const targetAttr = options.submitTarget ? ` data-ds-wizard-submit-target="${escapeAttr(options.submitTarget)}"` : ''
  return base.replace(
    `>${finishText}</button>`,
    ` data-ds-wizard-custom-submit="true"${targetAttr}>${customText}</button>`,
  )
}

export function renderWizardStepCounter(current: number, total: number, locale: string = 'en', copy?: TextTranslator): string {
  const template = copy ? copy('Step {current} of {total}') : 'Step {current} of {total}'
  const text = template
    .replace('{current}', formatNumber(current, locale, 0))
    .replace('{total}', formatNumber(total, locale, 0))
  return `<span class="ds-caption ds-num" data-ds-wizard-counter>${escapeHtml(text)}</span>`
}

export function renderStepLinkList(steps: readonly { readonly id: string; readonly label: string }[], activeIndex: number = 0): string {
  return `<ol class="ds-stepper" data-ds-wizard-stepper>${steps.map((step, index) => {
    const state = index < activeIndex ? 'done' : index === activeIndex ? 'current' : 'upcoming'
    return `<li class="ds-stepper__item" data-step-state="${state}" data-ds-wizard-goto="${escapeAttr(String(index))}"${index === activeIndex ? ' aria-current="step"' : ''}><span class="ds-num">${index + 1}</span><span>${escapeHtml(step.label)}</span></li>`
  }).join('')}</ol>`
}
