/// <reference lib="dom" />
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
// Local names survive function serialization under the server's module transform.
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate

/** A theme chooses its semantic columns; core supplies values without constructing presentation markup. */
export function cloneViewRecord(root: HTMLElement, name: string, tag: string, values: Readonly<Record<string, string | number>>): HTMLElement {
  const clone = cloneClientTemplate(clientTemplate(root, name), tag, [])
  const slots = [...(clone.hasAttribute('data-xp-slot') ? [clone] : []), ...clone.querySelectorAll<HTMLElement>('[data-xp-slot]')]
  if (!slots.length) throw new Error('view_record_slots_unavailable')
  const names = new Set<string>()
  for (const slot of slots) {
    const key = slot.getAttribute('data-xp-slot')!
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) || names.has(key) || !Object.hasOwn(values, key)
      || !['string', 'number'].includes(typeof values[key])) throw new Error('view_record_slot_unavailable')
    names.add(key)
    clientTemplateSlot(clone, key).textContent = String(values[key])
  }
  if (names.size !== Object.keys(values).length) throw new Error('view_record_slot_unavailable')
  return clone
}

/** An action belongs to this clone and is never selected by class or column position. */
export function viewAction<T extends HTMLElement = HTMLButtonElement>(root: HTMLElement, name: string, tag = 'button'): T {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('invalid_view_action_name')
  const selector = `[data-xp-action="${name}"]`
  const matches = [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll<HTMLElement>(selector)]
  if (matches.length !== 1 || matches[0]!.tagName !== tag.toUpperCase()) throw new Error('view_action_unavailable')
  return matches[0] as T
}

/** Prefix inside a serialized controller's IIFE; source and direct bindings share the same strict implementation. */
export const VIEW_RECORD_HELPERS = `const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const cloneViewRecord=${cloneViewRecord.toString()};const viewAction=${viewAction.toString()};`
