import { escapeAttr } from '../html.ts'
import { renderMetric, type MetricProps } from './metric.ts'

export interface StatStripProps {
  readonly items: readonly MetricProps[]
  readonly ariaLabel?: string
}

export function renderStatStrip(props: StatStripProps): string {
  const limited = props.items.slice(0, 4)
  const labelAttr = props.ariaLabel ? ` aria-label="${escapeAttr(props.ariaLabel)}"` : ''
  return `<section class="ds-stat-strip"${labelAttr}>${limited.map(renderMetric).join('')}</section>`
}
