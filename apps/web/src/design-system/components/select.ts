import { escapeAttr, escapeHtml, joinClasses } from '../html.ts'

export interface SelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

export interface SelectProps {
  readonly id: string
  readonly name: string
  readonly options: readonly SelectOption[]
  readonly value?: string
  readonly disabled?: boolean
  readonly required?: boolean
  readonly describedBy?: string
  readonly className?: string
}

export function renderSelect(props: SelectProps): string {
  const optionsHtml = props.options
    .map(opt => {
      const selected = props.value !== undefined && opt.value === props.value ? ' selected' : ''
      const disabled = opt.disabled ? ' disabled' : ''
      return `<option value="${escapeAttr(opt.value)}"${selected}${disabled}>${escapeHtml(opt.label)}</option>`
    })
    .join('')

  const attrs = [
    `class="${joinClasses('ds-select', props.className)}"`,
    `id="${escapeAttr(props.id)}"`,
    `name="${escapeAttr(props.name)}"`,
  ]
  if (props.describedBy) attrs.push(`aria-describedby="${escapeAttr(props.describedBy)}"`)
  if (props.required) attrs.push('required')
  if (props.disabled) attrs.push('disabled')
  return `<select ${attrs.join(' ')}>${optionsHtml}</select>`
}
