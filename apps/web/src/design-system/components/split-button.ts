import { escapeAttr, escapeHtml, joinClasses } from '../html.ts'
import { type ActionMenuItem } from './action-menu.ts'
import { renderButton, type ButtonVariant } from './button.ts'

export interface SplitButtonProps {
  readonly id: string
  readonly primaryLabel: string
  readonly primaryAction?: string
  readonly primaryHref?: string
  readonly variant?: ButtonVariant
  readonly menuLabel: string
  readonly menuItems: readonly ActionMenuItem[]
  readonly disabled?: boolean
}

export function renderSplitButton(props: SplitButtonProps): string {
  const primaryHtml = renderButton({
    id: `${props.id}-primary`,
    label: props.primaryLabel,
    variant: props.variant ?? 'primary',
    action: props.primaryAction,
    href: props.primaryHref,
    disabled: props.disabled,
  })
  const menuItemsHtml = props.menuItems
    .map(item => {
      const cls = joinClasses('ds-menu__item', item.danger && 'ds-menu__item--danger')
      if (item.href) {
        if (item.disabled) {
          return `<a role="menuitem" class="${cls}" aria-disabled="true" tabindex="-1">${escapeHtml(item.label)}</a>`
        }
        return `<a role="menuitem" class="${cls}" href="${escapeAttr(item.href)}">${escapeHtml(item.label)}</a>`
      }
      const actionAttr = item.action ? ` data-action="${escapeAttr(item.action)}"` : ''
      const disabledAttr = item.disabled ? ' disabled' : ''
      return `<button type="button" role="menuitem" class="${cls}"${actionAttr}${disabledAttr}>${escapeHtml(item.label)}</button>`
    })
    .join('')

  return `<div class="ds-split-btn" id="${escapeAttr(props.id)}">` +
    primaryHtml +
    `<div class="ds-menu" data-ds-menu>` +
      `<button type="button" class="ds-btn ${props.variant === 'secondary' ? '' : `ds-btn--${props.variant ?? 'primary'}`}" aria-haspopup="menu" aria-expanded="false" aria-controls="${escapeAttr(props.id)}-panel" aria-label="${escapeAttr(props.menuLabel)}"${props.disabled ? ' disabled' : ''}><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M4 6l4 4 4-4"/></svg></button>` +
      `<div class="ds-menu__panel" id="${escapeAttr(props.id)}-panel" role="menu" popover="manual" hidden>${menuItemsHtml}</div>` +
    `</div>` +
  `</div>`
}
