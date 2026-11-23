import { formatNumber } from '../formatters.ts'
import { createDesignTranslator, escapeAttr, escapeHtml, type TextTranslator } from '../html.ts'
import { renderStatusBadge, type BadgeTone } from './status-badge.ts'

export interface WizardStep {
  readonly id: string
  readonly label: string
  readonly bodyHtml: string
}

export interface WizardChangeEntry {
  readonly label: string
  readonly before?: string
  readonly after: string
}

export interface WizardProgressStep {
  readonly id: string
  readonly label: string
  readonly state: 'pending' | 'running' | 'done' | 'failed'
}

export interface WizardProps {
  readonly id: string
  readonly steps: readonly WizardStep[]
  readonly activeStepIndex: number
  readonly preflightState?: {
    readonly tone: BadgeTone
    readonly message: string
  }
  readonly changePlan?: readonly WizardChangeEntry[]
  readonly progressSteps?: readonly WizardProgressStep[]
  readonly receiptHtml?: string
  readonly locale?: string
  readonly copy?: TextTranslator
}

export function renderWizard(props: WizardProps): string {
  const t = createDesignTranslator(props.copy)
  const boundedIndex = Math.min(Math.max(0, props.activeStepIndex), Math.max(0, props.steps.length - 1))

  const stepperHtml = `<ol class="ds-stepper" data-ds-wizard-stepper aria-label="${escapeAttr(t('Step'))}">` +
    props.steps
      .map((step, index) => {
        const state = index < boundedIndex ? 'done' : index === boundedIndex ? 'current' : 'upcoming'
        return `<li class="ds-stepper__item" data-step-state="${state}"${index === boundedIndex ? ' aria-current="step"' : ''}>` +
          `<span class="ds-num">${formatNumber(index + 1, props.locale)}</span>` +
          `<span>${escapeHtml(step.label)}</span>` +
        `</li>`
      })
      .join('') +
  `</ol>`

  const panelsHtml = props.steps
    .map((step, index) => `<div class="ds-card" data-ds-wizard-step="${escapeAttr(step.id)}"${index === boundedIndex ? '' : ' hidden'}>${step.bodyHtml}</div>`)
    .join('')

  const preflightHtml = props.preflightState
    ? `<div class="ds-card ds-card--compact" data-ds-wizard-preflight role="status">` +
        `<div class="ds-page-head__title-row">${renderStatusBadge({ label: props.preflightState.message, tone: props.preflightState.tone })}</div>` +
      `</div>`
    : ''

  const changePlanHtml = props.changePlan?.length
    ? `<section class="ds-card ds-card--compact" data-ds-wizard-diff>` +
        `<h3 class="ds-card__title">${escapeHtml(t('What will change'))}</h3>` +
        `<div class="ds-table-scroll"><table class="ds-table"><thead><tr><th>${escapeHtml(t('Step'))}</th><th>${escapeHtml(t('Before'))}</th><th>${escapeHtml(t('After'))}</th></tr></thead><tbody>` +
        props.changePlan
          .map(entry => `<tr><td>${escapeHtml(entry.label)}</td><td>${escapeHtml(entry.before ?? '—')}</td><td>${escapeHtml(entry.after)}</td></tr>`)
          .join('') +
        `</tbody></table></div>` +
      `</section>`
    : ''

  const progressHtml = props.progressSteps?.length
    ? `<section class="ds-card ds-card--compact" data-ds-wizard-progress>` +
        `<h3 class="ds-card__title">${escapeHtml(t('Execution progress'))}</h3>` +
        `<ol class="ds-stepper">${props.progressSteps
          .map(step => `<li class="ds-stepper__item" data-step-state="${step.state}">${escapeHtml(step.label)}</li>`)
          .join('')}</ol>` +
      `</section>`
    : ''

  const receiptHtml = props.receiptHtml
    ? `<section class="ds-card" data-ds-wizard-receipt><h3 class="ds-card__title">${escapeHtml(t('Result'))}</h3>${props.receiptHtml}</section>`
    : ''

  const isFirst = boundedIndex === 0
  const isLast = boundedIndex >= props.steps.length - 1
  const navHtml = `<div class="ds-page-head__actions">` +
    `<button type="button" class="ds-btn" data-ds-wizard-prev${isFirst ? ' disabled' : ''}>${escapeHtml(t('Previous'))}</button>` +
    `<button type="button" class="ds-btn ds-btn--primary" data-ds-wizard-next${isLast ? ' hidden' : ''}>${escapeHtml(t('Next'))}</button>` +
    `<button type="submit" class="ds-btn ds-btn--primary" data-ds-wizard-submit${isLast ? '' : ' hidden'}>${escapeHtml(t('Finish'))}</button>` +
  `</div>`

  return `<div class="ds-wizard" id="${escapeAttr(props.id)}" data-ds-wizard data-active-step="${boundedIndex}">` +
    stepperHtml +
    panelsHtml +
    preflightHtml +
    changePlanHtml +
    progressHtml +
    receiptHtml +
    navHtml +
  `</div>`
}
