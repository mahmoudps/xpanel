// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientTemplate, clientTemplateSlot, cloneClientTemplate } from './client-templates.ts'
import { PROMPT_CLIENT_BINDING, type PromptOptions } from './prompt-client.ts'
import { CLASSIC_PROMPT_TEMPLATE } from './themes/classic/prompt.ts'
import { V2_PROMPT_TEMPLATE } from './themes/v2/components/prompt.ts'

const mount = (markup: string, locale: 'en' | 'ar' = 'en') => {
  document.documentElement.lang = locale
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = `<button type="button" data-opener>Open</button>${markup}`
  vi.stubGlobal('xpT', (value: string) => locale === 'ar' ? ({ Cancel: 'إلغاء', Confirm: 'تأكيد' } as Record<string, string>)[value] ?? value : value)
  return new Function(`${clientTemplate.toString()}\n${clientTemplateSlot.toString()}\n${cloneClientTemplate.toString()}\nreturn (${PROMPT_CLIENT_BINDING})();`)() as (options: PromptOptions) => Promise<string | boolean | null>
}
const submit = (dialog: HTMLDialogElement) => {
  const event = new Event('submit', { bubbles: true, cancelable: true })
  dialog.querySelector('form')!.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
}

const dialogMethods = ['showModal', 'close'] as const
let originalDialogMethods: (PropertyDescriptor | undefined)[] = []
beforeEach(() => {
  originalDialogMethods = dialogMethods.map(name => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name))
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true, writable: true,
    value: function (this: HTMLDialogElement) { this.open = true },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true, writable: true,
    value: function (this: HTMLDialogElement, value?: string) {
      this.returnValue = value ?? ''; this.open = false; this.dispatchEvent(new Event('close'))
    },
  })
})
afterEach(() => {
  document.body.replaceChildren()
  document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  dialogMethods.forEach((name, index) => {
    const descriptor = originalDialogMethods[index]
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  })
})

describe.each([
  { theme: 'classic', markup: CLASSIC_PROMPT_TEMPLATE, dialogClass: 'xp-dialog' },
  { theme: 'v2', markup: V2_PROMPT_TEMPLATE, dialogClass: 'v2-prompt' },
])('serialized $theme prompt controller', ({ markup, dialogClass }) => {
  it.each(['en', 'ar'] as const)('keeps theme markup, validates names and returns focus in %s', async locale => {
    const ask = mount(markup, locale), opener = document.querySelector<HTMLButtonElement>('[data-opener]')!
    opener.focus()
    expect(document.querySelector('[data-xp-prompt]')).toBeNull()
    const pending = ask({ title: 'New file', body: '<b>Text only</b>', input: true, label: 'Name' })
    const dialog = document.querySelector<HTMLDialogElement>('[data-xp-prompt]')!
    const input = dialog.querySelector<HTMLInputElement>('[data-xp-prompt-input]')!
    expect(dialog.classList.contains(dialogClass)).toBe(true)
    expect(dialog.open).toBe(true); expect(document.activeElement).toBe(input)
    expect(dialog.querySelector('[data-xp-prompt-body]')!.textContent).toBe('<b>Text only</b>')
    expect(dialog.querySelector('[data-xp-prompt-body] b')).toBeNull()
    expect(dialog.querySelector('[data-xp-prompt-cancel]')!.textContent).toBe(locale === 'ar' ? 'إلغاء' : 'Cancel')
    input.value = '   '; submit(dialog)
    expect(dialog.open).toBe(true); expect(document.activeElement).toBe(input)
    input.value = '  notes.txt  '; submit(dialog)
    expect(await pending).toBe('notes.txt')
    expect(dialog.open).toBe(false); expect(input.value).toBe(''); expect(document.activeElement).toBe(opener)
  })

  it('preserves exact secret whitespace without persisting its value in the closed dialog', async () => {
    const ask = mount(markup)
    const pending = ask({ input: true, secret: true, preserveWhitespace: true, value: '  exact value  ' })
    const dialog = document.querySelector<HTMLDialogElement>('[data-xp-prompt]')!
    const input = dialog.querySelector<HTMLInputElement>('[data-xp-prompt-input]')!
    expect(input.type).toBe('password'); expect(input.autocomplete).toBe('off')
    submit(dialog)
    expect(await pending).toBe('  exact value  '); expect(input.value).toBe('')
  })

  it('preserves cancel and Escape, switches semantic danger state and refuses overlapping prompts', async () => {
    const ask = mount(markup)
    const pending = ask({ title: 'Delete', danger: true })
    const dialog = document.querySelector<HTMLDialogElement>('[data-xp-prompt]')!
    expect(dialog.getAttribute('role')).toBe('alertdialog'); expect(dialog.getAttribute('data-prompt-tone')).toBe('danger')
    const originalClass = dialog.querySelector('[data-xp-prompt-confirm]')!.className
    expect(await ask({ title: 'Unrelated' })).toBeNull()
    expect(dialog.querySelector('[data-xp-prompt-title]')!.textContent).toBe('Delete')
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(await pending).toBe(false)
    const next = ask({ title: 'Confirm' })
    expect(dialog.getAttribute('role')).toBe('dialog'); expect(dialog.getAttribute('data-prompt-tone')).toBe('normal')
    expect(dialog.querySelector('[data-xp-prompt-confirm]')!.className).toBe(originalClass)
    dialog.querySelector<HTMLButtonElement>('[data-xp-prompt-cancel]')!.click()
    expect(await next).toBe(false)
    const confirmed = ask({})
    submit(dialog)
    expect(await confirmed).toBe(true); expect(document.querySelectorAll('[data-xp-prompt]')).toHaveLength(1)
  })

  it.each(['missing', 'duplicate', 'wrong-root', 'missing-slot', 'wrong-slot-tag', 'disabled-confirm', 'readonly-input', 'wrong-method', 'identity-collision'] as const)('fails closed for %s selected-theme markup', async fault => {
    const holder = document.createElement('div'); holder.innerHTML = markup
    const template = holder.querySelector('template')!
    if (fault === 'missing') template.remove()
    if (fault === 'duplicate') holder.appendChild(template.cloneNode(true))
    if (fault === 'wrong-root') template.content.firstElementChild!.outerHTML = '<div data-xp-prompt></div>'
    if (fault === 'missing-slot') template.content.querySelector('[data-xp-slot="body"]')!.remove()
    if (fault === 'wrong-slot-tag') template.content.querySelector('[data-xp-slot="label"]')!.outerHTML = '<span data-xp-slot="label"></span>'
    if (fault === 'disabled-confirm') template.content.querySelector<HTMLButtonElement>('[data-xp-slot="confirm"]')!.disabled = true
    if (fault === 'readonly-input') template.content.querySelector<HTMLInputElement>('[data-xp-slot="input"]')!.readOnly = true
    if (fault === 'wrong-method') template.content.querySelector('form')!.method = 'post'
    const ask = mount(holder.innerHTML)
    if (fault === 'identity-collision') {
      const collision = document.createElement('div'); collision.id = template.content.querySelector<HTMLInputElement>('input')!.id; document.body.appendChild(collision)
    }
    const fetch = vi.spyOn(globalThis, 'fetch')
    expect(await ask({ input: true, danger: true })).toBeNull()
    expect(document.querySelector('[data-xp-prompt]')).toBeNull(); expect(fetch).not.toHaveBeenCalled()
  })

  it('does not adopt a pre-existing unowned dialog', async () => {
    const ask = mount(markup)
    const unowned = document.createElement('dialog'); unowned.setAttribute('data-xp-prompt', ''); document.body.appendChild(unowned)
    expect(await ask({ title: 'Changed' })).toBeNull()
    expect(unowned.textContent).toBe(''); expect(unowned.open).toBe(false)
  })
})
