import { createDesignTranslator, escapeAttr, escapeHtml, type TextTranslator } from '../html.ts'

export interface ComboboxOption {
  readonly value: string
  readonly label: string
  readonly hint?: string
}

export interface ComboboxProps {
  readonly id: string
  readonly name: string
  readonly options: readonly ComboboxOption[]
  readonly value?: string
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly locale?: string
  readonly copy?: TextTranslator
}

export function renderCombobox(props: ComboboxProps): string {
  const t = createDesignTranslator(props.copy)
  const listId = `${props.id}-listbox`
  const selectedOption = props.options.find(opt => opt.value === props.value)
  const displayValue = selectedOption?.label ?? props.value ?? ''

  const listItems = props.options.length
    ? props.options
      .map((opt, index) => {
        const selected = opt.value === props.value ? 'true' : 'false'
        const optId = `${props.id}-opt-${index}`
        const hintHtml = opt.hint ? `<span class="ds-caption">${escapeHtml(opt.hint)}</span>` : ''
        return `<li role="option" class="ds-menu__item" id="${escapeAttr(optId)}" aria-selected="${selected}" data-ds-combobox-value="${escapeAttr(opt.value)}"><span>${escapeHtml(opt.label)}</span>${hintHtml}</li>`
      })
      .join('')
    : `<li class="ds-caption">${escapeHtml(t('No matches found'))}</li>`

  return `<div class="ds-combobox" data-ds-combobox>` +
    `<input type="hidden" name="${escapeAttr(props.name)}" value="${escapeAttr(props.value ?? '')}" data-ds-combobox-hidden>` +
    `<input type="search" class="ds-input" id="${escapeAttr(props.id)}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${escapeAttr(listId)}" value="${escapeAttr(displayValue)}" placeholder="${escapeAttr(props.placeholder ?? t('Search'))}"${props.disabled ? ' disabled' : ''}>` +
    `<ul class="ds-combobox__list" id="${escapeAttr(listId)}" role="listbox" hidden>${listItems}</ul>` +
  `</div>`
}
