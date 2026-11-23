import { escapeHtml } from '../html.ts'
import { isolateTechnical } from '../formatters.ts'

export interface KeyValueItem {
  readonly label: string
  readonly value?: string
  readonly valueHtml?: string
  readonly technical?: boolean
}

export interface KeyValueProps {
  readonly items: readonly KeyValueItem[]
}

export function renderKeyValue(props: KeyValueProps): string {
  const rows = props.items
    .map(item => {
      const content = item.valueHtml !== undefined
        ? item.valueHtml
        : item.technical
          ? isolateTechnical(item.value ?? '—')
          : escapeHtml(item.value ?? '—')
      return `<div class="ds-kv__row"><dt class="ds-kv__key">${escapeHtml(item.label)}</dt><dd class="ds-kv__val">${content}</dd></div>`
    })
    .join('')
  return `<dl class="ds-kv">${rows}</dl>`
}
