import { escapeAttr, escapeHtml } from '../html.ts'

export interface RadioCardOption {
  readonly id: string
  readonly value: string
  readonly title: string
  readonly description?: string
  readonly meta?: string
  readonly disabled?: boolean
}

export interface RadioCardGroupProps {
  readonly name: string
  readonly ariaLabel: string
  readonly options: readonly RadioCardOption[]
  readonly value?: string
}

export function renderRadioCardGroup(props: RadioCardGroupProps): string {
  const cards = props.options
    .map(opt => {
      const checkedAttr = opt.value === props.value ? ' checked' : ''
      const disabledAttr = opt.disabled ? ' disabled' : ''
      return `<label class="ds-radio-card" for="${escapeAttr(opt.id)}">` +
        `<input type="radio" id="${escapeAttr(opt.id)}" name="${escapeAttr(props.name)}" value="${escapeAttr(opt.value)}"${checkedAttr}${disabledAttr}>` +
        `<div>` +
          `<strong>${escapeHtml(opt.title)}</strong>` +
          (opt.description ? `<p class="ds-caption">${escapeHtml(opt.description)}</p>` : '') +
          (opt.meta ? `<p class="ds-caption ds-num">${escapeHtml(opt.meta)}</p>` : '') +
        `</div>` +
      `</label>`
    })
    .join('')

  return `<div class="ds-radio-group" role="radiogroup" aria-label="${escapeAttr(props.ariaLabel)}">${cards}</div>`
}
