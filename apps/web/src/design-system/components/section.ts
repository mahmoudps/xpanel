import { escapeAttr, escapeHtml, joinClasses } from '../html.ts'

export interface SectionProps {
  readonly id?: string
  readonly title: string
  readonly description?: string
  readonly actionHtml?: string
  readonly bodyHtml: string
  readonly className?: string
}

export function renderSection(props: SectionProps): string {
  const idAttr = props.id ? ` id="${escapeAttr(props.id)}"` : ''
  const headingId = props.id ? `${props.id}-heading` : undefined
  const labelledBy = headingId ? ` aria-labelledby="${escapeAttr(headingId)}"` : ''
  return `<section class="${joinClasses('ds-section', props.className)}"${idAttr}${labelledBy}>` +
    `<div class="ds-card__head">` +
      `<div>` +
        `<h2 class="ds-section__title"${headingId ? ` id="${escapeAttr(headingId)}"` : ''}>${escapeHtml(props.title)}</h2>` +
        (props.description ? `<p class="ds-caption">${escapeHtml(props.description)}</p>` : '') +
      `</div>` +
      (props.actionHtml ?? '') +
    `</div>` +
    props.bodyHtml +
  `</section>`
}
