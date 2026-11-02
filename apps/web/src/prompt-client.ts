import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'

// Keep local identifiers in emitted function source, as in the existing mail/WHM template kits.
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate

export interface PromptOptions {
  title?: string
  body?: string
  input?: boolean
  label?: string
  value?: string
  secret?: boolean
  preserveWhitespace?: boolean
  danger?: boolean
  cancel?: string
  confirm?: string
}

/** The selected theme supplies the complete dialog. This controller owns only its interaction. */
export function bindPromptDialog(): (options: PromptOptions) => Promise<string | boolean | null> {
  let owned: HTMLDialogElement | undefined
  let finish: ((value: string | boolean | null) => void) | undefined
  let previousFocus: HTMLElement | undefined
  let preserveWhitespace = false
  let result: string | boolean | null = null
  const slots = ['form', 'title', 'body', 'field', 'label', 'input', 'cancel', 'confirm'] as const
  const read = (dialog: HTMLDialogElement) => {
    const form = clientTemplateSlot(dialog, 'form', 'form') as HTMLFormElement
    const title = clientTemplateSlot(dialog, 'title', 'h2')
    const body = clientTemplateSlot(dialog, 'body', 'p')
    const field = clientTemplateSlot(dialog, 'field', 'div')
    const label = clientTemplateSlot(dialog, 'label', 'label') as HTMLLabelElement
    const input = clientTemplateSlot(dialog, 'input', 'input') as HTMLInputElement
    const cancel = clientTemplateSlot(dialog, 'cancel', 'button') as HTMLButtonElement
    const confirm = clientTemplateSlot(dialog, 'confirm', 'button') as HTMLButtonElement
    if (!dialog.hasAttribute('data-xp-prompt') || form.method !== 'dialog' || cancel.type !== 'button' || confirm.type !== 'submit'
      || ![title, body, field, cancel, confirm].every(node => form.contains(node))
      || !field.contains(input) || !field.contains(label) || !input.id || label.htmlFor !== input.id
      || !title.id || !body.id || dialog.getAttribute('aria-labelledby') !== title.id || dialog.getAttribute('aria-describedby') !== body.id
      || cancel.disabled || confirm.disabled || input.disabled || input.readOnly || dialog.hidden
      || dialog.querySelectorAll('form').length !== 1 || form.closest('[inert], fieldset:disabled')) throw new Error('invalid_prompt_template')
    return { form, title, body, field, label, input, cancel, confirm }
  }
  const ensure = (): HTMLDialogElement => {
    if (owned) {
      if (!owned.isConnected || document.querySelectorAll('[data-xp-prompt]').length !== 1) throw new Error('prompt_dialog_unavailable')
      read(owned)
      return owned
    }
    if (document.querySelector('[data-xp-prompt]')) throw new Error('ambiguous_prompt_dialog')
    const template = clientTemplate(document.body, 'prompt-dialog')
    const dialog = cloneClientTemplate(template, 'dialog', slots) as HTMLDialogElement
    const controls = read(dialog)
    const ids = [...dialog.querySelectorAll<HTMLElement>('[id]')].map(node => node.id)
    if (new Set(ids).size !== ids.length || ids.some(id => document.getElementById(id))) throw new Error('ambiguous_prompt_identity')
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close('cancel') })
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close('cancel') })
    controls.cancel.addEventListener('click', () => dialog.close('cancel'))
    controls.form.addEventListener('submit', event => {
      event.preventDefault()
      const current = read(dialog)
      let entered = current.input.value
      if (!preserveWhitespace) entered = entered.trim()
      if (!current.field.hidden && !entered) { current.input.focus(); return }
      result = current.field.hidden ? true : entered
      dialog.close('confirm')
    })
    dialog.addEventListener('close', () => {
      const resolve = finish
      finish = undefined
      const value = dialog.returnValue === 'confirm' ? result : null
      result = null
      controls.input.value = ''
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
      previousFocus = undefined
      resolve?.(value)
    })
    document.body.appendChild(dialog)
    owned = dialog
    return dialog
  }
  return options => {
    if (finish) return Promise.resolve(null)
    let dialog: HTMLDialogElement
    try { dialog = ensure() } catch { return Promise.resolve(null) }
    if (dialog.open) return Promise.resolve(null)
    const controls = read(dialog)
    controls.title.textContent = options.title || ''
    controls.body.textContent = options.body || ''
    controls.field.hidden = !options.input
    controls.label.textContent = options.label || ''
    controls.input.value = options.value || ''
    controls.input.type = options.secret ? 'password' : 'text'
    controls.input.required = false
    controls.cancel.textContent = options.cancel || xpT('Cancel')
    controls.confirm.textContent = options.confirm || xpT('Confirm')
    dialog.setAttribute('data-prompt-tone', options.danger ? 'danger' : 'normal')
    dialog.setAttribute('role', options.danger ? 'alertdialog' : 'dialog')
    preserveWhitespace = options.preserveWhitespace === true
    result = null
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    return new Promise(resolve => {
      finish = value => resolve(options.input ? (typeof value === 'string' && value ? value : null) : value === true)
      try { dialog.showModal() } catch { dialog.setAttribute('open', '') }
      ;(options.input ? controls.input : controls.confirm).focus()
    })
  }
}

/** Canonical helpers are emitted by the ordinary core bootstrap before this function. */
export const PROMPT_CLIENT_BINDING = bindPromptDialog.toString()
