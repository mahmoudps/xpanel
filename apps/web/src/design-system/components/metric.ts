import { escapeHtml } from '../html.ts'
import { isolateTechnical } from '../formatters.ts'

export interface MetricProps {
  readonly label: string
  readonly value: string
  readonly hint?: string
  readonly technical?: boolean
  readonly sparklineHtml?: string
}

export function renderMetric(props: MetricProps): string {
  const valueContent = props.technical ? isolateTechnical(props.value) : escapeHtml(props.value)
  const hintHtml = props.hint ? `<span class="ds-caption">${escapeHtml(props.hint)}</span>` : ''
  return `<article class="ds-metric">` +
    `<span class="ds-metric__label">${escapeHtml(props.label)}</span>` +
    `<div class="ds-metric__value">${valueContent}</div>` +
    hintHtml +
    (props.sparklineHtml ?? '') +
  `</article>`
}
