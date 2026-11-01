// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { MAIL_CLIENT_TEMPLATE_KIT, mailRequireTemplates, mailTemplate } from './mail-client-template-kit.ts'
import { classicMailClientTemplates } from './board-port/mail-client-templates.ts'
import { v2MailClientTemplates } from './themes/v2/pages/xmail/client-templates.ts'

type Specifications = Parameters<typeof mailRequireTemplates>[1]
const forwarders = [['mail-forwarder-row', 'tr', ['address', 'remove'], [['address', 'bdi'], ['remove', 'button', { type: 'button' }]]]] as const
const themes = [['classic', classicMailClientTemplates], ['v2', v2MailClientTemplates]] as const
function root(html: string): HTMLElement {
  document.body.innerHTML = '<section></section>'
  const element = document.querySelector('section')!
  element.innerHTML = html
  return element
}
function serialized(element: HTMLElement, specifications: Specifications): void {
  new Function('root', 'specifications', `${MAIL_CLIENT_TEMPLATE_KIT};mailRequireTemplates(root, specifications)`)(element, specifications)
}
function replaceTag(element: Element, tag: string): void {
  const replacement = document.createElement(tag)
  for (const attribute of element.attributes) replacement.setAttribute(attribute.name, attribute.value)
  replacement.append(...Array.from(element.childNodes))
  element.replaceWith(replacement)
}
afterEach(() => document.body.replaceChildren())

describe.each(themes)('%s MAIL template admission', (_theme, templates) => {
  it('retains legacy two/three-item specifications and leaves theme-owned source unchanged', () => {
    const element = root(templates('forwarders'))
    const before = element.innerHTML
    mailRequireTemplates(element, [['mail-forwarder-row', 'tr'], ['mail-forwarder-empty', 'tr', ['message']]])
    serialized(element, forwarders)
    const clone = mailTemplate(element, 'mail-forwarder-row', 'tr', ['address', 'remove'])
    expect(clone.querySelector('button')?.classList.contains(_theme === 'v2' ? 'v2-btn' : 'xp-btn')).toBe(true)
    expect(element.innerHTML).toBe(before)
  })
  it('keeps legacy name-only behavior while typed specifications reject the same wrong tag', () => {
    const element = root(templates('forwarders'))
    const template = element.querySelector('template')!
    replaceTag(template.content.querySelector('[data-xp-slot="remove"]')!, 'span')
    expect(() => mailRequireTemplates(element, [['mail-forwarder-row', 'tr', ['address', 'remove']]])).not.toThrow()
    expect(() => serialized(element, forwarders)).toThrow('client_template_slot_unavailable')
  })
  it('validates the root-as-slot button and its explicit native type in the emitted helper', () => {
    const element = root(templates('identities'))
    const specification = [['mail-identity-action', 'button', ['label'], [['label', 'button', { type: 'button' }]]]] as const
    expect(() => serialized(element, specification)).not.toThrow()
    const action = element.querySelector<HTMLTemplateElement>('template[data-xp-template="mail-identity-action"]')!
    action.content.firstElementChild!.removeAttribute('type')
    expect(() => serialized(element, specification)).toThrow('client_template_slot_unavailable')
  })
  const malformed: readonly [string, (element: HTMLElement, template: HTMLTemplateElement) => void][] = [
    ['missing template', (_element, template) => template.remove()],
    ['duplicate template', (element, template) => element.append(template.cloneNode(true))],
    ['wrong root', (_element, template) => replaceTag(template.content.firstElementChild!, 'div')],
    ['missing slot', (_element, template) => template.content.querySelector('[data-xp-slot="address"]')!.remove()],
    ['duplicate slot', (_element, template) => { const slot = template.content.querySelector('[data-xp-slot="address"]')!; slot.after(slot.cloneNode(true)) }],
    ['wrong native slot tag', (_element, template) => replaceTag(template.content.querySelector('[data-xp-slot="remove"]')!, 'span')],
    ['missing button type', (_element, template) => template.content.querySelector('[data-xp-slot="remove"]')!.removeAttribute('type')],
    ['submit button type', (_element, template) => template.content.querySelector('[data-xp-slot="remove"]')!.setAttribute('type', 'submit')],
  ]
  it.each(malformed)('rejects %s before a typed clone can be used', (_name, mutate) => {
    const element = root(templates('forwarders'))
    mutate(element, element.querySelector('template')!)
    expect(() => serialized(element, forwarders)).toThrow()
  })
})