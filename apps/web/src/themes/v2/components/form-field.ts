import { attr, escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon } from '../icons.ts'

interface ControlBase {
  name?: string
  required?: boolean
  disabled?: boolean
  /** Technical values (domains, paths, keys) in the monospace face. */
  mono?: boolean
  hooks?: HookAttributes
}

export type FieldControl =
  | (ControlBase & { kind: 'input'; type?: 'text' | 'email' | 'password' | 'number' | 'url' | 'search' | 'tel'; value?: string; placeholder?: string; autocomplete?: string; inputmode?: string; unit?: string })
  | (ControlBase & { kind: 'select'; options: readonly { value: string; label: string; selected?: boolean }[] })
  | (ControlBase & { kind: 'textarea'; value?: string; rows?: number; placeholder?: string })

export interface FormFieldProps {
  id: string
  label: string
  help?: string
  /** Validation message; marks the control aria-invalid and is read with it. */
  error?: string
  control: FieldControl
  hooks?: HookAttributes
}

export function formField(props: FormFieldProps): string {
  const { id, control } = props
  const helpId = props.help ? `${id}-help` : undefined
  const errorId = props.error ? `${id}-error` : undefined
  const described = [errorId, helpId].filter(Boolean).join(' ')
  const common = `id="${escapeHtml(id)}"${attr('name', control.name)}${control.required ? ' required' : ''}${control.disabled ? ' disabled' : ''}${control.mono ? ' class="v2-mono"' : ''}${attr('aria-describedby', described)}${props.error ? ' aria-invalid="true"' : ''}${hookAttrs(control.hooks)}`
  let field: string
  if (control.kind === 'select') {
    field = `<span class="v2-select"><select ${common}>${control.options.map(option => `<option value="${escapeHtml(option.value)}"${option.selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>${icon('chevDown', 16)}</span>`
  } else if (control.kind === 'textarea') {
    field = `<textarea ${common}${attr('rows', control.rows)}${attr('placeholder', control.placeholder)}>${escapeHtml(control.value ?? '')}</textarea>`
  } else {
    const input = `<input ${common} type="${control.type ?? 'text'}"${attr('value', control.value)}${attr('placeholder', control.placeholder)}${attr('autocomplete', control.autocomplete)}${attr('inputmode', control.inputmode)}>`
    field = control.unit ? `<span class="v2-field__unit">${input}<span>${escapeHtml(control.unit)}</span></span>` : input
  }
  return `<div class="v2-field"${hookAttrs(props.hooks)}><label for="${escapeHtml(id)}">${escapeHtml(props.label)}</label>${field}${props.error ? `<span class="v2-field__error" id="${escapeHtml(errorId!)}">${icon('alert', 14)}${escapeHtml(props.error)}</span>` : ''}${props.help ? `<span class="v2-field__help" id="${escapeHtml(helpId!)}">${escapeHtml(props.help)}</span>` : ''}</div>`
}

export interface SwitchRowProps {
  id: string
  label: string
  help?: string
  name?: string
  checked?: boolean
  disabled?: boolean
  hooks?: HookAttributes
}

/** A 44px label row with a switch (checkbox role="switch"). */
export const switchRow = (props: SwitchRowProps): string =>
  `<label class="v2-switch-row" for="${escapeHtml(props.id)}"><span class="v2-switch-row__text"><span>${escapeHtml(props.label)}</span>${props.help ? `<span id="${escapeHtml(props.id)}-help">${escapeHtml(props.help)}</span>` : ''}</span><input type="checkbox" role="switch" id="${escapeHtml(props.id)}"${attr('name', props.name)}${props.checked ? ' checked' : ''}${props.disabled ? ' disabled' : ''}${props.help ? ` aria-describedby="${escapeHtml(props.id)}-help"` : ''}${hookAttrs(props.hooks)}></label>`

export const FORM_FIELD_CSS = `.v2-form{display:flex;flex-direction:column;gap:var(--space-2)}
.v2-field{display:flex;flex-direction:column;gap:var(--space-1);min-width:0}
.v2-field>label{font-size:13px;font-weight:600}
.v2-field :is(input,select,textarea):not([type=checkbox],[type=radio]){inline-size:100%}
.v2-field__unit{display:flex;align-items:center;gap:var(--space-1)}
.v2-field__unit>input{flex:1 1 auto;min-width:0}
.v2-field__unit>span{flex:none;min-inline-size:48px;font-size:13px;color:var(--text-2)}
.v2-field__help{font-size:12px;color:var(--muted)}
.v2-field__error{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--bad)}
.v2-switch-row{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);min-height:var(--target);cursor:pointer}
.v2-switch-row__text{display:flex;flex-direction:column}
.v2-switch-row__text>:first-child{font-weight:600}
.v2-switch-row__text>:nth-child(2){font-size:12px;color:var(--muted)}
`
