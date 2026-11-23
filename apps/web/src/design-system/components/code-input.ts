import { escapeAttr, escapeHtml } from '../html.ts'

export interface CodeInputProps {
  readonly id: string
  readonly name: string
  readonly value?: string
  readonly rows?: number
  readonly placeholder?: string
  readonly readonly?: boolean
  readonly disabled?: boolean
  readonly describedBy?: string
}

export function renderCodeInput(props: CodeInputProps): string {
  const attrs = [
    `class="ds-code-input"`,
    `id="${escapeAttr(props.id)}"`,
    `name="${escapeAttr(props.name)}"`,
    `dir="ltr"`,
    `spellcheck="false"`,
    `rows="${escapeAttr(String(props.rows ?? 6))}"`,
  ]
  if (props.placeholder !== undefined) attrs.push(`placeholder="${escapeAttr(props.placeholder)}"`)
  if (props.describedBy) attrs.push(`aria-describedby="${escapeAttr(props.describedBy)}"`)
  if (props.readonly) attrs.push('readonly')
  if (props.disabled) attrs.push('disabled')
  return `<textarea ${attrs.join(' ')}>${escapeHtml(props.value ?? '')}</textarea>`
}
