/// <reference lib="dom" />
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'

const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate

/** Workspace-owned presentation is validated before a mailbox controller reads or changes data. */
export function mailTemplate(root: HTMLElement, name: string, tag: string, slots: readonly string[] = []): HTMLElement {
  return cloneClientTemplate(clientTemplate(root, name), tag, slots)
}
export function mailSlot<T extends HTMLElement = HTMLElement>(root: HTMLElement, name: string, tag?: string): T {
  return clientTemplateSlot(root, name, tag) as T
}
type MailPreflightElementRequirement = readonly [slot: string, tag: string, attributes?: Readonly<Record<string, string>>]
type MailPreflightRequirement = readonly [name: string, tag: string, slots?: readonly string[], elements?: readonly MailPreflightElementRequirement[]]

export function mailRequireTemplates(root: HTMLElement, specifications: readonly MailPreflightRequirement[]): void {
  for (const [name, tag, slots, elements] of specifications) {
    const clone = mailTemplate(root, name, tag, slots)
    for (const [slot, elementTag, attributes] of elements ?? []) {
      const element = mailSlot(clone, slot, elementTag)
      for (const [attribute, value] of Object.entries(attributes ?? {})) {
        if (element.getAttribute(attribute) !== value) throw new Error('client_template_slot_unavailable')
      }
    }
  }
}

/** Function declarations retain their local names when the browser binding is serialized. */
export const MAIL_CLIENT_TEMPLATE_KIT = `${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};${mailTemplate.toString()};${mailSlot.toString()};${mailRequireTemplates.toString()};`
