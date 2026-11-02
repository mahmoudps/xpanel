/// <reference lib="dom" />

/** Finds a workspace-owned template without accepting missing or ambiguous markup. */
export function clientTemplate(root: HTMLElement, name: string): HTMLTemplateElement {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('invalid_client_template_name')
  const matches = root.querySelectorAll<HTMLTemplateElement>(`template[data-xp-template="${name}"]`)
  if (matches.length !== 1 || !matches[0]?.content) throw new Error('client_template_unavailable')
  return matches[0]
}

/** A slot can be the clone itself (button label), or one unique descendant. */
export function clientTemplateSlot(root: HTMLElement, name: string, tag?: string): HTMLElement {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('invalid_client_slot_name')
  const selector = `[data-xp-slot="${name}"]`
  const matches = [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll<HTMLElement>(selector)]
  if (matches.length !== 1 || (tag && matches[0]!.tagName !== tag.toUpperCase())) throw new Error('client_template_slot_unavailable')
  return matches[0]!
}

/** Themes own markup and styling; controllers may fill only validated semantic slots. */
export function cloneClientTemplate(template: HTMLTemplateElement, tag: string, slots: readonly string[]): HTMLElement {
  const element = template.content.firstElementChild
  if (!element || template.content.childElementCount !== 1 || element.tagName !== tag.toUpperCase()
    || [...template.content.childNodes].some(node => node.nodeType === 3 && node.textContent?.trim())) {
    throw new Error('invalid_client_template_root')
  }
  const clone = element.cloneNode(true) as HTMLElement
  for (const slot of slots) clientTemplateSlot(clone, slot)
  return clone
}
