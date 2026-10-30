/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

/** Preserve the existing tool search's exact whitespace and Unicode case handling. */
export function normalizeHomeToolQuery(value: string): string {
  return value.trim().toLowerCase()
}

export function homeToolMatches(query: string, groupLabel: string, keywords: string): boolean {
  const normalized = normalizeHomeToolQuery(query)
  return normalized === '' || groupLabel.toLowerCase().includes(normalized) || keywords.toLowerCase().includes(normalized)
}

export const HOME_TOOL_MATCHING_FUNCTIONS = `${normalizeHomeToolQuery.toString()};${homeToolMatches.toString()};`

/** One responsive tool list; its theme owns every element, icon and presentation state. */
function bindHomeTools(): void {
  document.querySelectorAll<HTMLElement>('[data-panel-home]').forEach(root => {
    if (root.dataset.homeToolsBound === 'true') return
    const owned = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)].filter(node => node.closest('[data-panel-home]') === root)
    const inputs = owned('input[data-home-filter]'), counts = owned('#tool-filter-count')
    const sections = owned('[data-tool-section]'), emptyStates = owned('[data-tool-empty]')
    if ([inputs, counts, sections, emptyStates].some(nodes => nodes.length !== 1)) return
    const input = inputs[0] as HTMLInputElement
    const count = counts[0], section = sections[0], empty = emptyStates[0]
    if (!input || !count || !section || !empty) return
    root.dataset.homeToolsBound = 'true'
    const copy = (message: string, values?: MessageValues) => xpT(message, values)
    const groups = [...root.querySelectorAll<HTMLElement>('[data-tool-group]')]
      .filter(group => group.closest('[data-panel-home]') === root)
    const tools = new Map(groups.map(group => [group, [...group.querySelectorAll<HTMLElement>('[data-tool]')]
      .filter(tool => tool.closest('[data-tool-group]') === group && tool.closest('[data-panel-home]') === root)]))
    const initialHidden = new Set([...groups, ...[...tools.values()].flat()].filter(node => node.hidden))
    const remembered = new Map<HTMLDetailsElement, boolean>()
    const media = new Map<number, boolean>()
    let query = ''

    for (const group of groups) {
      if (group.tagName !== 'DETAILS' || !group.hasAttribute('data-home-accordion')) continue
      const details = group as HTMLDetailsElement
      const rawThreshold = details.dataset.homeCollapseBelow ?? ''
      const threshold = Number(rawThreshold)
      if (/^[1-9][0-9]{0,3}$/.test(rawThreshold) && typeof window.matchMedia === 'function') {
        if (!media.has(threshold)) media.set(threshold, window.matchMedia(`(max-width: ${threshold - 1}px)`).matches)
        if (media.get(threshold)) details.open = false
      }
      remembered.set(details, details.open)
      details.addEventListener('toggle', () => {
        if (query === '') remembered.set(details, details.open)
      })
      details.querySelector('summary')?.addEventListener('click', event => {
        queueMicrotask(() => {
          if (!event.defaultPrevented && root.isConnected) remembered.set(details, details.open)
        })
      })
    }

    const update = () => {
      if (!root.isConnected) return
      const raw = input.value.trim()
      query = normalizeHomeToolQuery(raw)
      let shown = 0
      let total = 0
      for (const group of groups) {
        const entries = tools.get(group)!
        const label = group.dataset.groupLabel ?? ''
        let hits = 0
        let size = 0
        for (const tool of entries) {
          const available = !initialHidden.has(group) && !initialHidden.has(tool)
          const hit = available && homeToolMatches(query, label, tool.dataset.toolKeys ?? '')
          tool.hidden = !hit
          if (available) size++
          if (hit) hits++
        }
        total += size
        shown += hits
        group.hidden = initialHidden.has(group) || hits === 0
        const badge = group.querySelector<HTMLElement>('[data-group-count]')
        if (badge) badge.textContent = query === '' ? badge.dataset.rest ?? '' : copy('{hits} of {size}', { hits, size })
        if (remembered.has(group as HTMLDetailsElement)) {
          const details = group as HTMLDetailsElement
          details.open = query !== '' ? hits > 0 : remembered.get(details)!
        }
      }
      count.textContent = query === '' ? count.dataset.rest ?? ''
        : copy('{shown, plural, one {# of {total} tools matches} other {# of {total} tools match}}', { shown, total })
      const noMatch = query !== '' && shown === 0
      section.hidden = noMatch
      empty.hidden = !noMatch
      const title = empty.querySelector<HTMLElement>('[data-home-empty-title]')
      if (title) title.textContent = copy('No tool matches “{query}”', { query: raw })
    }
    const clear = () => {
      input.value = ''
      update()
      input.focus({ preventScroll: true })
    }
    input.addEventListener('input', update)
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape' && input.value !== '') {
        event.preventDefault()
        event.stopPropagation()
        clear()
      }
    })
    empty.querySelector<HTMLButtonElement>('[data-home-filter-clear]')?.addEventListener('click', clear)
    update()
  })
}

export const HOME_TOOLS_CLIENT_BINDING = `(function(){${HOME_TOOL_MATCHING_FUNCTIONS}(${bindHomeTools.toString()})();})`
