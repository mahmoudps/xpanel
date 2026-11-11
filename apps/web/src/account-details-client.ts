/// <reference lib="dom" />

/** Selects an already authorized, server-rendered account panel. No transport or mutation authority. */
export function bindAccountDetails(): () => void {
  const rootSelector = '[data-account-detail-workspace]'
  type DetailRoot = HTMLElement & { __xpAccountDetailsCleanup?: () => void }
  // opener is the first opener of the row and the focus-return target; others open the same panel.
  type Entry = { key: string; opener: HTMLButtonElement; others: HTMLButtonElement[]; row: HTMLElement; panel: HTMLElement }
  const roots = [...document.querySelectorAll<DetailRoot>(rootSelector)]
  if (roots.length !== 1) return () => {}
  const root = roots[0]!
  if (!root.isConnected || root.__xpAccountDetailsCleanup || root.getAttribute('data-account-detail-workspace') !== '/whm/accounts') return () => {}
  const own = (selector: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)].filter(node => node.closest(rootSelector) === root)
  const asides = own('[data-account-detail-panel]')
  if (asides.length !== 1 || asides[0]!.tagName !== 'ASIDE') return () => {}
  const aside = asides[0]!
  const idIsUnique = (): boolean => !!aside.id && [...document.querySelectorAll<HTMLElement>('[id]')].filter(node => node.id === aside.id).length === 1
  const closes = own('[data-account-detail-close]')
  const openers = own('[data-account-detail-open]')
  const panels = own('[data-account-detail-for]')
  const rows = own('[data-account-row]')
  if (!idIsUnique() || !aside.hidden || closes.length !== 1 || !(closes[0] instanceof HTMLButtonElement)
    || closes[0].type !== 'button' || closes[0].disabled || !aside.contains(closes[0])
    || rows.length !== panels.length || typeof MutationObserver !== 'function') return () => {}
  const closeButton = closes[0]
  const entries: Entry[] = []
  for (const candidate of openers) {
    const key = candidate.getAttribute('data-account-detail-open') ?? ''
    const matchingPanels = panels.filter(panel => panel.getAttribute('data-account-detail-for') === key)
    const matchingRows = rows.filter(row => row.getAttribute('data-account-row') === key)
    if (!(candidate instanceof HTMLButtonElement) || candidate.type !== 'button'
      || !/^[a-z][a-z0-9]{0,15}$/.test(key)
      || candidate.getAttribute('aria-controls') !== aside.id || candidate.getAttribute('aria-expanded') !== 'false'
      || candidate.hasAttribute('data-action') || candidate.hasAttribute('data-handoff')
      || matchingPanels.length !== 1 || matchingRows.length !== 1) return () => {}
    const panel = matchingPanels[0]!, row = matchingRows[0]!
    if (panel.tagName !== 'SECTION' || !panel.hidden || !aside.contains(panel)
      || row.tagName !== 'TR' || candidate.closest('[data-account-row]') !== row || aside.contains(row)
      || panels.some(other => other !== panel && other.contains(panel))) return () => {}
    const known = entries.find(entry => entry.key === key)
    if (known) known.others.push(candidate)
    else entries.push({ key, opener: candidate, others: [], row, panel })
  }
  if (entries.length !== panels.length) return () => {}
  let active: Entry | undefined
  let disposed = false
  const visible = (node: HTMLElement): boolean => node.isConnected && !node.closest('[hidden], [inert], [aria-hidden="true"]')
  const owned = (entry: Entry): boolean => root.isConnected && aside.isConnected && root.contains(aside) && idIsUnique()
    && document.querySelectorAll(rootSelector).length === 1
    && closeButton.isConnected && !closeButton.disabled && aside.contains(closeButton) && own('[data-account-detail-close]').length === 1
    && entry.opener.isConnected && entry.panel.isConnected && entry.row.isConnected
    && entry.opener.closest(rootSelector) === root && entry.row.closest(rootSelector) === root && entry.panel.closest(rootSelector) === root
    && entry.opener.closest('[data-account-row]') === entry.row && aside.contains(entry.panel)
    && entry.row.getAttribute('data-account-row') === entry.key
    && entry.opener.getAttribute('data-account-detail-open') === entry.key
    && entry.opener.getAttribute('aria-controls') === aside.id && entry.panel.getAttribute('data-account-detail-for') === entry.key
    && own('[data-account-row]').filter(node => node.getAttribute('data-account-row') === entry.key).length === 1
    && own('[data-account-detail-open]').find(node => node.getAttribute('data-account-detail-open') === entry.key) === entry.opener
    && own('[data-account-detail-for]').filter(node => node.getAttribute('data-account-detail-for') === entry.key).length === 1
  const close = (returnFocus: boolean): void => {
    const previous = active
    active = undefined
    aside.hidden = true
    root.removeAttribute('data-account-detail-selected')
    for (const entry of entries) {
      entry.panel.hidden = true
      for (const opener of [entry.opener, ...entry.others]) opener.setAttribute('aria-expanded', 'false')
    }
    if (!returnFocus || !previous) return
    if (owned(previous) && visible(previous.opener) && !previous.opener.disabled) previous.opener.focus()
    else {
      const fallback = own('[data-list-search-input]').find(visible) ?? entries.find(entry => owned(entry) && visible(entry.opener) && !entry.opener.disabled)?.opener
      if (fallback) fallback.focus()
      else if (root.isConnected) root.focus()
    }
  }
  const handlers = entries.flatMap(entry => [entry.opener, ...entry.others].map(opener => {
    const open = (): void => {
      if (disposed || !owned(entry) || !visible(entry.row) || !visible(entry.opener) || entry.opener.disabled || opener.disabled || !opener.isConnected) return
      for (const item of entries) {
        item.panel.hidden = item !== entry
        for (const other of [item.opener, ...item.others]) other.setAttribute('aria-expanded', item === entry ? 'true' : 'false')
      }
      active = entry
      aside.hidden = false
      root.setAttribute('data-account-detail-selected', entry.key)
      closeButton.focus()
      // An opener may name the part of the panel it is about; that part is brought into view.
      const wanted = opener.getAttribute('data-account-detail-section')
      const part = wanted ? [...entry.panel.querySelectorAll<HTMLElement>('[data-account-detail-section]')].find(node => node.getAttribute('data-account-detail-section') === wanted) : undefined
      // A folded part, or one inside a fold, opens first so the scroll lands on its content.
      for (let node: HTMLElement | null = part ?? null; node && node !== entry.panel; node = node.parentElement) if (node instanceof HTMLDetailsElement) node.open = true
      if (part && typeof part.scrollIntoView === 'function') part.scrollIntoView({ block: 'start' })
    }
    opener.addEventListener('click', open)
    return { opener, open }
  }))
  const dismiss = (): void => { close(true) }
  const leave = (event: PageTransitionEvent): void => { if (!event.persisted) dispose() }
  const escape = (event: KeyboardEvent): void => {
    if (active && event.key === 'Escape' && !event.defaultPrevented && !event.isComposing
      && event.target instanceof Node && aside.contains(event.target)) {
      event.preventDefault()
      close(true)
    }
  }
  // The account list paints row.hidden. Observe only captured rows and their finite parent lists,
  // never the page/root subtree or native form values.
  const observer = new MutationObserver(() => {
    if (disposed) return
    if (!root.isConnected) { dispose(); return }
    if (active && (!owned(active) || !visible(active.row) || !visible(active.opener))) close(aside.contains(document.activeElement))
  })
  const parents = new Set<Node>()
  for (const entry of entries) {
    observer.observe(entry.row, { attributes: true, attributeFilter: ['hidden'] })
    if (entry.row.parentElement) parents.add(entry.row.parentElement)
    if (entry.opener.parentElement) parents.add(entry.opener.parentElement)
    if (entry.panel.parentElement) parents.add(entry.panel.parentElement)
  }
  if (aside.parentElement) parents.add(aside.parentElement)
  if (closeButton.parentElement) parents.add(closeButton.parentElement)
  for (const parent of parents) observer.observe(parent, { childList: true })
  closeButton.addEventListener('click', dismiss)
  root.addEventListener('keydown', escape)
  function dispose(): void {
    if (disposed) return
    disposed = true
    observer.disconnect()
    close(false)
    for (const handler of handlers) handler.opener.removeEventListener('click', handler.open)
    closeButton.removeEventListener('click', dismiss)
    root.removeEventListener('keydown', escape)
    window.removeEventListener('pagehide', leave)
    if (root.__xpAccountDetailsCleanup === dispose) delete root.__xpAccountDetailsCleanup
  }
  root.__xpAccountDetailsCleanup = dispose
  window.addEventListener('pagehide', leave)
  return dispose
}

/** Core mounts this expression once; every dependency is inside the serialized function. */
export const ACCOUNT_DETAILS_CLIENT_BINDING = '(' + bindAccountDetails.toString() + ')()'
