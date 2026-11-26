import { createDesignTranslator, escapeAttr, escapeHtml, type TextTranslator } from '../html.ts'

export interface ErrorStateProps {
  readonly title: string
  readonly message: string
  readonly variant?: 'error' | 'forbidden'
  readonly retryAction?: string
  readonly retryLabel?: string
  readonly enableHref?: string
  readonly enableLabel?: string
  readonly locale?: string
  readonly copy?: TextTranslator
}

export function renderErrorState(props: ErrorStateProps): string {
  const t = createDesignTranslator(props.copy)
  const isForbidden = props.variant === 'forbidden'
  const modifier = isForbidden ? 'ds-state--forbidden' : 'ds-state--error'

  let actionHtml = ''
  if (props.retryAction) {
    actionHtml = `<button type="button" class="ds-btn" data-action="${escapeAttr(props.retryAction)}">${escapeHtml(props.retryLabel ?? t('Retry'))}</button>`
  } else if (props.enableHref) {
    actionHtml = `<a class="ds-btn ds-btn--primary" href="${escapeAttr(props.enableHref)}">${escapeHtml(props.enableLabel ?? t('Enable service'))}</a>`
  }

  return `<div class="ds-state ${modifier}" role="alert">` +
    `<h3 class="ds-card__title">${escapeHtml(props.title)}</h3>` +
    `<p class="ds-prose">${escapeHtml(props.message)}</p>` +
    actionHtml +
  `</div>`
}
