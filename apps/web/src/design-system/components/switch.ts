import { escapeAttr, escapeHtml } from '../html.ts'

export interface SwitchProps {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly description?: string
  readonly checked?: boolean
  readonly disabled?: boolean
}

export function renderSwitch(props: SwitchProps): string {
  const checkedAttr = props.checked ? ' checked' : ''
  const disabledAttr = props.disabled ? ' disabled' : ''
  return `<label class="ds-switch" for="${escapeAttr(props.id)}">` +
    `<div>` +
      `<span>${escapeHtml(props.label)}</span>` +
      (props.description ? `<p class="ds-caption">${escapeHtml(props.description)}</p>` : '') +
    `</div>` +
    `<input class="ds-switch__input" type="checkbox" role="switch" id="${escapeAttr(props.id)}" name="${escapeAttr(props.name)}" aria-checked="${props.checked ? 'true' : 'false'}"${checkedAttr}${disabledAttr}>` +
  `</label>`
}
