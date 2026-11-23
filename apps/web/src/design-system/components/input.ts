import { escapeAttr, joinClasses } from '../html.ts'

export interface InputProps {
  readonly id: string
  readonly name: string
  readonly type?: 'text' | 'email' | 'password' | 'number' | 'search' | 'url' | 'tel'
  readonly value?: string
  readonly placeholder?: string
  readonly required?: boolean
  readonly disabled?: boolean
  readonly readonly?: boolean
  readonly dir?: 'ltr' | 'rtl' | 'auto'
  readonly min?: string | number
  readonly max?: string | number
  readonly step?: string | number
  readonly autocomplete?: string
  readonly describedBy?: string
  readonly className?: string
}

export function renderInput(props: InputProps): string {
  const attrs = [
    `class="${joinClasses('ds-input', props.className)}"`,
    `id="${escapeAttr(props.id)}"`,
    `name="${escapeAttr(props.name)}"`,
    `type="${escapeAttr(props.type ?? 'text')}"`,
  ]
  if (props.value !== undefined) attrs.push(`value="${escapeAttr(props.value)}"`)
  if (props.placeholder !== undefined) attrs.push(`placeholder="${escapeAttr(props.placeholder)}"`)
  if (props.dir) attrs.push(`dir="${escapeAttr(props.dir)}"`)
  if (props.min !== undefined) attrs.push(`min="${escapeAttr(String(props.min))}"`)
  if (props.max !== undefined) attrs.push(`max="${escapeAttr(String(props.max))}"`)
  if (props.step !== undefined) attrs.push(`step="${escapeAttr(String(props.step))}"`)
  if (props.autocomplete) attrs.push(`autocomplete="${escapeAttr(props.autocomplete)}"`)
  if (props.describedBy) attrs.push(`aria-describedby="${escapeAttr(props.describedBy)}"`)
  if (props.required) attrs.push('required')
  if (props.disabled) attrs.push('disabled')
  if (props.readonly) attrs.push('readonly')
  return `<input ${attrs.join(' ')}>`
}
