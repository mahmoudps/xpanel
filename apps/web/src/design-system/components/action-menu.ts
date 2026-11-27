import { createDesignTranslator, escapeAttr, escapeHtml, joinClasses, type TextTranslator } from '../html.ts'

export interface ActionMenuItem {
  readonly id: string
  readonly label: string
  readonly action?: string
  readonly href?: string
  readonly danger?: boolean
  readonly disabled?: boolean
}

export interface ActionMenuProps {
  readonly id: string
  readonly triggerLabel?: string
  readonly items: readonly ActionMenuItem[]
  readonly locale?: string
  readonly copy?: TextTranslator
}

export function renderActionMenu(props: ActionMenuProps): string {
  const t = createDesignTranslator(props.copy)
  const triggerText = props.triggerLabel ?? t('Actions')
  const panelId = `${props.id}-panel`

  const itemsHtml = props.items
    .map(item => {
      const cls = joinClasses('ds-menu__item', item.danger && 'ds-menu__item--danger')
      if (item.href) {
        if (item.disabled) {
          return `<a role="menuitem" class="${cls}" data-ds-menu-item="${escapeAttr(item.id)}" aria-disabled="true" tabindex="-1">${escapeHtml(item.label)}</a>`
        }
        return `<a role="menuitem" class="${cls}" data-ds-menu-item="${escapeAttr(item.id)}" href="${escapeAttr(item.href)}">${escapeHtml(item.label)}</a>`
      }
      const actionAttr = item.action ? ` data-action="${escapeAttr(item.action)}"` : ''
      const disabledAttr = item.disabled ? ' disabled' : ''
      return `<button type="button" role="menuitem" class="${cls}" data-ds-menu-item="${escapeAttr(item.id)}"${actionAttr}${disabledAttr}>${escapeHtml(item.label)}</button>`
    })
    .join('')

  return `<div class="ds-menu" id="${escapeAttr(props.id)}" data-ds-menu>` +
    `<button type="button" class="ds-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="${escapeAttr(panelId)}">${escapeHtml(triggerText)} <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M4 6l4 4 4-4"/></svg></button>` +
    `<div class="ds-menu__panel" id="${escapeAttr(panelId)}" role="menu" popover="manual" hidden>${itemsHtml}</div>` +
  `</div>`
}
