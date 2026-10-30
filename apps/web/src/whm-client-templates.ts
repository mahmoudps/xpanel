/// <reference lib="dom" />
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
export { clientTemplate, clientTemplateSlot, cloneClientTemplate } from './client-templates.ts'
// Keep serialized function references local when a test or bundle loader rewrites imports.
const clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot, cloneClientTemplate = canonicalCloneClientTemplate

/** A presentation primitive from this workspace's selected theme, with one named text slot. */
export function whmClientNode<K extends keyof HTMLElementTagNameMap>(root: HTMLElement, name: string, tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = cloneClientTemplate(clientTemplate(root, name), tag, ['content']) as HTMLElementTagNameMap[K]
  if (text !== undefined) clientTemplateSlot(node, 'content').textContent = text
  return node
}

export const WHM_CLIENT_TEMPLATE_BINDING = `const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const whmClientNode=${whmClientNode.toString()};`
