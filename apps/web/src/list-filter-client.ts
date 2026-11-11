/// <reference lib="dom" />

/**
 * Generic filter of a loaded list. A container marked data-list-filter filters its data-list-row rows by one
 * search field and by any number of keyed chip groups or selects. A page without the marker is untouched.
 *
 * A row states a value as data-list-<key>, or through a descendant marked data-list-field="<key>" (the value of
 * a select or input, else its text), so rows painted from a template need no controller of their own.
 */
function bindListFilters(): void {
  document.querySelectorAll<HTMLElement>('[data-list-filter]').forEach(root => {
    const mine = (node: Element) => node.closest('[data-list-filter]') === root
    const valueOf = (node: Element) => node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement
      ? node.value : (node.textContent ?? '').trim()
    const rowValue = (row: HTMLElement, key: string) => {
      const stated = row.getAttribute('data-list-' + key)
      if (stated !== null) return stated
      const field = Array.from(row.querySelectorAll<HTMLElement>('[data-list-field]')).find(node => node.dataset.listField === key)
      return field ? valueOf(field) : ''
    }
    const rowText = (row: HTMLElement) => row.dataset.listSearch
      ?? [row.textContent ?? '', ...Array.from(row.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="password"]), select, textarea'), valueOf)].join(' ').toLowerCase()
    const chosen = (control: HTMLElement) => {
      if (control instanceof HTMLSelectElement) return control.value
      const radio = control.querySelector<HTMLInputElement>('input[type="radio"]:checked')
      return radio ? radio.value : control.querySelector<HTMLElement>('[data-list-filter-value][aria-pressed="true"]')?.dataset.listFilterValue ?? ''
    }
    const apply = () => {
      const term = (Array.from(root.querySelectorAll<HTMLInputElement>('[data-list-filter-search]')).find(mine)?.value ?? '').trim().toLowerCase()
      const wanted = Array.from(root.querySelectorAll<HTMLElement>('[data-list-filter-key]')).filter(mine)
        .map(control => [control.dataset.listFilterKey ?? '', chosen(control)] as const).filter(([key, value]) => key && value)
      const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-list-row]')).filter(mine)
      let shown = 0
      for (const row of rows) {
        const match = (!term || rowText(row).includes(term)) && wanted.every(([key, value]) => rowValue(row, key) === value)
        // hidden keeps a filtered row out of the tab order. Writes happen only on a change, so the observer settles.
        if (row.hidden === match) row.hidden = !match
        if (match) shown += 1
      }
      for (const count of Array.from(root.querySelectorAll<HTMLElement>('[data-list-filter-count]')).filter(mine))
        if (count.textContent !== String(shown)) count.textContent = String(shown)
      for (const empty of Array.from(root.querySelectorAll<HTMLElement>('[data-list-filter-empty]')).filter(mine)) {
        const none = rows.length > 0 && shown === 0
        if (empty.hidden === none) empty.hidden = !none
      }
    }
    root.addEventListener('click', event => {
      const chip = (event.target as Element).closest<HTMLElement>('button[data-list-filter-value]')
      const group = chip?.closest<HTMLElement>('[data-list-filter-key]')
      if (!chip || !group || !mine(group)) return
      group.querySelectorAll('button[data-list-filter-value]').forEach(item => item.setAttribute('aria-pressed', String(item === chip)))
      apply()
    })
    // An edit inside a row never re-filters: the row being edited must not disappear under the user.
    const changed = (event: Event) => {
      const target = event.target as Element
      if (target.closest('[data-list-filter-search], [data-list-filter-key]') && !target.closest('[data-list-row]')) apply()
    }
    root.addEventListener('input', changed)
    root.addEventListener('change', changed)
    new MutationObserver(apply).observe(root, { childList: true, subtree: true })
    apply()
  })
}

export const LIST_FILTER_CLIENT_SCRIPT = `(${bindListFilters.toString()})();`
