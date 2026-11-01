/** Local view selection only. This binder has no transport or persistence authority. */
export function bindPresentationTabs(): void {
  const rootSelector = '[data-presentation-tabs]'
  const keyPattern = /^[a-z][a-z0-9-]{0,31}$/
  type TabRoot = HTMLElement & { __xpPresentationTabsBound?: boolean }
  type Model = { mode: 'panels' | 'sections'; tabs: HTMLButtonElement[]; panels: HTMLElement[]; sections: HTMLElement[]; links: HTMLAnchorElement[]; selected: HTMLButtonElement }
  const usable = (tab: HTMLButtonElement): boolean => {
    if (!tab.isConnected || tab.disabled || tab.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"], fieldset:disabled')) return false
    for (let node: HTMLElement | null = tab; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    }
    return true
  }
  for (const root of document.querySelectorAll<TabRoot>(rootSelector)) {
    if (root.__xpPresentationTabsBound || !root.isConnected) continue
    const own = (selector: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)].filter(node => node.closest(rootSelector) === root)
    const read = (): Model | undefined => {
      if (!root.isConnected) return
      const mode = root.getAttribute('data-presentation-tabs')
      if (mode !== 'panels' && mode !== 'sections') return
      const lists = own('[role="tablist"]')
      if (lists.length !== 1 || !lists[0]!.getAttribute('aria-label')?.trim()) return
      const list = lists[0]!
      const candidates = own('[data-presentation-tab]')
      if (candidates.length < 2 || candidates.length > 32 || own('[role="tab"]').length !== candidates.length) return
      if (candidates.some(node => !(node instanceof HTMLButtonElement) || node.type !== 'button' || node.getAttribute('role') !== 'tab' || !list.contains(node)
        || !node.textContent?.trim() || node.hasAttribute('data-action') || node.hasAttribute('data-filter-chip') || node.hasAttribute('data-api-url'))) return
      const tabs = candidates as HTMLButtonElement[]
      const keys = tabs.map(tab => tab.getAttribute('data-presentation-tab') ?? '')
      if (keys.some(key => !keyPattern.test(key)) || new Set(keys).size !== keys.length) return
      const selectedTabs = tabs.filter(tab => tab.getAttribute('aria-selected') === 'true')
      if (selectedTabs.length !== 1 || tabs.some(tab => !['true', 'false'].includes(tab.getAttribute('aria-selected') ?? ''))) return
      const selected = selectedTabs[0]!
      const panels = own('[role="tabpanel"]')
      const sections = own('[data-presentation-tab-visible]')
      const linkCandidates = own('[data-presentation-tab-link]')
      const idCounts = new Map<string, number>()
      for (const node of document.querySelectorAll<HTMLElement>('[id]')) idCounts.set(node.id, (idCounts.get(node.id) ?? 0) + 1)
      if ([...tabs, ...panels].some(node => !node.id || idCounts.get(node.id) !== 1)) return
      if (mode === 'panels') {
        if (panels.length !== tabs.length || sections.length !== 0 || linkCandidates.length !== 0) return
        const targets = tabs.map(tab => panels.find(panel => panel.id === tab.getAttribute('aria-controls')))
        if (targets.some((panel, index) => !panel || panel.getAttribute('aria-labelledby') !== tabs[index]!.id) || new Set(targets).size !== tabs.length) return
      } else {
        if (panels.length !== 1 || sections.length === 0) return
        const panel = panels[0]!
        if (tabs.some(tab => tab.getAttribute('aria-controls') !== panel.id) || panel.getAttribute('aria-labelledby') !== selected.id) return
        const visibleKeys = new Set<string>()
        for (const section of sections) {
          if (!panel.contains(section) || section.parentElement?.closest('[data-presentation-tab-visible]')?.closest(rootSelector) === root) return
          const membership = (section.getAttribute('data-presentation-tab-visible') ?? '').trim().split(/\s+/)
          if (membership.some(key => !keys.includes(key)) || new Set(membership).size !== membership.length) return
          for (const key of membership) visibleKeys.add(key)
        }
        if (keys.some(key => !visibleKeys.has(key))) return
        for (const node of linkCandidates) {
          if (!(node instanceof HTMLAnchorElement) || node.hasAttribute('data-action') || node.hasAttribute('data-api-url')) return
          const key = node.getAttribute('data-presentation-tab-link') ?? ''
          const href = node.getAttribute('href') ?? ''
          const target = [...panel.querySelectorAll<HTMLElement>('[id]')].find(item => `#${item.id}` === href && item.closest(rootSelector) === root)
          const section = target?.closest<HTMLElement>('[data-presentation-tab-visible]')
          if (!keys.includes(key) || !target || idCounts.get(target.id) !== 1 || !section || !sections.includes(section)
            || !(section.getAttribute('data-presentation-tab-visible') ?? '').split(/\s+/).includes(key)) return
        }
      }
      return { mode, tabs, panels, sections, links: linkCandidates as HTMLAnchorElement[], selected }
    }
    const initial = read()
    if (!initial || !usable(initial.selected)) continue
    const same = (a: readonly HTMLElement[], b: readonly HTMLElement[]): boolean => a.length === b.length && a.every((node, index) => node === b[index])
    const select = (tab: HTMLButtonElement, keyboard = false): boolean => {
      const model = read()
      if (!model || model.mode !== initial.mode || !same(model.tabs, initial.tabs) || !same(model.panels, initial.panels) || !same(model.sections, initial.sections) || !same(model.links, initial.links) || !model.tabs.includes(tab) || !usable(tab)) return false
      const key = tab.getAttribute('data-presentation-tab')!
      const hidden = model.mode === 'panels'
        ? model.panels.filter(panel => panel.id !== tab.getAttribute('aria-controls'))
        : model.sections.filter(section => !(section.getAttribute('data-presentation-tab-visible') ?? '').split(/\s+/).includes(key))
      const moveFocus = keyboard || hidden.some(node => node.contains(document.activeElement))
      for (const item of model.tabs) { item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1 }
      if (model.mode === 'panels') for (const panel of model.panels) panel.hidden = hidden.includes(panel)
      else {
        model.panels[0]!.setAttribute('aria-labelledby', tab.id)
        for (const section of model.sections) section.hidden = hidden.includes(section)
      }
      if (moveFocus) tab.focus({ preventScroll: true })
      return true
    }
    const fragmentLink = initial.links.find(link => link.getAttribute('href') === window.location.hash)
    const fragmentTab = fragmentLink && initial.tabs.find(tab => tab.getAttribute('data-presentation-tab') === fragmentLink.getAttribute('data-presentation-tab-link'))
    if (!select(fragmentTab && usable(fragmentTab) ? fragmentTab : initial.selected)) continue
    root.__xpPresentationTabsBound = true
    for (const link of initial.links) link.addEventListener('click', event => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0 || link.closest('[hidden], [inert], [aria-disabled="true"]')) return
      const tab = initial.tabs.find(item => item.getAttribute('data-presentation-tab') === link.getAttribute('data-presentation-tab-link'))
      if (tab && select(tab, true)) event.preventDefault()
    })
    for (const tab of initial.tabs) {
      tab.addEventListener('click', event => { if (!event.defaultPrevented) select(tab) })
      tab.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        const model = read()
        if (!model) return
        const available = model.tabs.filter(usable), index = available.indexOf(tab)
        if (index < 0) return
        const direction = getComputedStyle(tab).direction
        const rtl = direction === 'rtl' || direction !== 'ltr' && tab.closest('[dir]')?.getAttribute('dir') === 'rtl'
        const step = event.key === 'ArrowRight' ? rtl ? -1 : 1 : event.key === 'ArrowLeft' ? rtl ? 1 : -1 : 0
        const next = event.key === 'Home' ? available[0] : event.key === 'End' ? available.at(-1)
          : step ? available[(index + step + available.length) % available.length] : undefined
        if (next && select(next, true)) event.preventDefault()
      })
    }
  }
}

/** Self-contained function source for the ordinary core client bootstrap. */
export const PRESENTATION_TABS_CLIENT_BINDING = bindPresentationTabs.toString()
