import { createDesignTranslator, escapeHtml, type TextTranslator } from '../html.ts'

export interface EmptyStateProps {
  readonly title?: string
  readonly message: string
  readonly actionHtml?: string
  readonly locale?: string
  readonly copy?: TextTranslator
}

export function renderEmptyState(props: EmptyStateProps): string {
  const t = createDesignTranslator(props.copy)
  const heading = props.title ?? t('No items yet')
  return `<div class="ds-state ds-state--empty" role="status">` +
    `<h3 class="ds-card__title">${escapeHtml(heading)}</h3>` +
    `<p class="ds-prose">${escapeHtml(props.message)}</p>` +
    (props.actionHtml ?? '') +
  `</div>`
}
