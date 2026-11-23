import { escapeAttr, escapeHtml } from '../html.ts'
import { renderStatusBadge, type BadgeTone } from './status-badge.ts'

export interface FieldProps {
  readonly id: string
  readonly label: string
  readonly controlHtml: string
  readonly help?: string
  readonly error?: string
  readonly hidden?: boolean
  readonly availability?: {
    readonly tone: BadgeTone
    readonly message: string
  }
}

export function renderField(props: FieldProps): string {
  const helpId = props.help ? `${props.id}-help` : undefined
  const errorId = props.error ? `${props.id}-error` : undefined
  const availabilityHtml = props.availability
    ? `<div class="ds-field__status" role="status">${renderStatusBadge({ label: props.availability.message, tone: props.availability.tone })}</div>`
    : ''
  const helpHtml = props.help ? `<p class="ds-field__help" id="${escapeAttr(helpId!)}">${escapeHtml(props.help)}</p>` : ''
  const errorHtml = props.error ? `<p class="ds-field__error" id="${escapeAttr(errorId!)}" role="alert">${escapeHtml(props.error)}</p>` : ''

  return `<div class="ds-field" data-ds-field="${escapeAttr(props.id)}"${props.hidden ? ' hidden' : ''}>` +
    `<label class="ds-field__label" for="${escapeAttr(props.id)}">${escapeHtml(props.label)}</label>` +
    props.controlHtml +
    availabilityHtml +
    helpHtml +
    errorHtml +
  `</div>`
}
