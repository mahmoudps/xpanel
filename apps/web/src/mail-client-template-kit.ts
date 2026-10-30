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
export function mailRequireTemplates(root: HTMLElement, specifications: readonly (readonly [name: string, tag: string, slots?: readonly string[]])[]): void {
  for (const [name, tag, slots] of specifications) mailTemplate(root, name, tag, slots)
}

/** Function declarations retain their local names when the browser binding is serialized. */
export const MAIL_CLIENT_TEMPLATE_KIT = `${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};${mailTemplate.toString()};${mailSlot.toString()};${mailRequireTemplates.toString()};`
