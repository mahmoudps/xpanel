import { escapeAttr, escapeHtml, joinClasses } from '../html.ts'

export interface CardProps {
  readonly id?: string
  readonly title?: string
  readonly description?: string
  readonly headerActionHtml?: string
  readonly bodyHtml: string
  readonly footerHtml?: string
  readonly compact?: boolean
  readonly className?: string
}

export function renderCard(props: CardProps): string {
  const idAttr = props.id ? ` id="${escapeAttr(props.id)}"` : ''
  const headHtml = (props.title || props.description || props.headerActionHtml)
    ? `<div class="ds-card__head">` +
        `<div>` +
          (props.title ? `<h2 class="ds-card__title">${escapeHtml(props.title)}</h2>` : '') +
          (props.description ? `<p class="ds-caption">${escapeHtml(props.description)}</p>` : '') +
        `</div>` +
        (props.headerActionHtml ?? '') +
      `</div>`
    : ''
  const footerHtml = props.footerHtml ? `<div class="ds-card__foot">${props.footerHtml}</div>` : ''
  return `<section class="${joinClasses('ds-card', props.compact && 'ds-card--compact', props.className)}"${idAttr}>${headHtml}<div class="ds-card__body">${props.bodyHtml}</div>${footerHtml}</section>`
}
