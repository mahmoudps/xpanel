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

export type WhmClientTemplateContract = readonly [name: string, rootTag: keyof HTMLElementTagNameMap, slots: Readonly<Record<string, keyof HTMLElementTagNameMap>>]

/** Verify the complete finite contract on detached clones before reading or changing a workspace. */
export function assertWhmClientTemplates(root: HTMLElement, contracts: readonly WhmClientTemplateContract[]): void {
  if (!contracts.length) throw new Error('client_template_contract_unavailable')
  const names = new Set<string>()
  for (const [name, tag, slots] of contracts) {
    if (names.has(name)) throw new Error('client_template_contract_unavailable')
    names.add(name)
    const clone = cloneClientTemplate(clientTemplate(root, name), tag, [])
    const present = [...(clone.hasAttribute('data-xp-slot') ? [clone] : []), ...clone.querySelectorAll<HTMLElement>('[data-xp-slot]')]
    if (present.length !== Object.keys(slots).length || present.some(node => !Object.hasOwn(slots, node.getAttribute('data-xp-slot')!))) throw new Error('client_template_contract_unavailable')
    for (const [slot, slotTag] of Object.entries(slots)) clientTemplateSlot(clone, slot, slotTag)
  }
}

export const WHM_CLIENT_TEMPLATE_BINDING = `const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const whmClientNode=${whmClientNode.toString()};const assertWhmClientTemplates=${assertWhmClientTemplates.toString()};`
