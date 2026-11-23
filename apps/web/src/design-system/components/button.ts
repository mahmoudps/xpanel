import { escapeAttr, escapeHtml, joinClasses } from '../html.ts'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps {
  readonly label: string
  readonly variant?: ButtonVariant
  readonly href?: string
  readonly type?: 'button' | 'submit' | 'reset'
  readonly action?: string
  readonly disabled?: boolean
  readonly id?: string
  readonly className?: string
  readonly iconHtml?: string
}

export function renderButton(props: ButtonProps): string {
  const variantClass = props.variant && props.variant !== 'secondary' ? `ds-btn--${props.variant}` : undefined
  const cls = joinClasses('ds-btn', variantClass, props.className)
  const idAttr = props.id ? ` id="${escapeAttr(props.id)}"` : ''
  const actionAttr = props.action ? ` data-action="${escapeAttr(props.action)}"` : ''
  const labelHtml = `${props.iconHtml ?? ''}${escapeHtml(props.label)}`

  if (props.href) {
    if (props.disabled) {
      return `<a class="${cls}" role="link" aria-disabled="true" tabindex="-1"${idAttr}${actionAttr}>${labelHtml}</a>`
    }
    return `<a class="${cls}" href="${escapeAttr(props.href)}"${idAttr}${actionAttr}>${labelHtml}</a>`
  }

  const typeAttr = props.type ?? 'button'
  const disabledAttr = props.disabled ? ' disabled' : ''
  return `<button type="${typeAttr}" class="${cls}"${idAttr}${actionAttr}${disabledAttr}>${labelHtml}</button>`
}
