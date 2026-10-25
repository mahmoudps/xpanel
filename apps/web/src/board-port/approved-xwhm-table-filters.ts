/// <reference lib="dom" />

export interface ApprovedWhmTableRow {
  kind?: string
  account?: string
  ssl?: string
  php?: string
  status?: string
  search?: string
}

export interface ApprovedWhmTableFilters {
  kind?: string
  account?: string
  ssl?: string
  php?: string
  status?: string
  search?: string
}

/** Matches only attributes actually present in an authorized, already-rendered row. */
export function approvedWhmTableMatches(row: ApprovedWhmTableRow, filters: ApprovedWhmTableFilters): boolean {
  const needle = (filters.search ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  if (needle && !(row.search ?? '').replace(/\s+/g, ' ').toLowerCase().includes(needle)) return false
  if (filters.kind && filters.kind !== 'all' && row.kind !== filters.kind) return false
  for (const key of ['account', 'ssl', 'php', 'status'] as const) {
    const expected = filters[key]
    if (expected && row[key] !== expected) return false
  }
  return true
}

/** Pure paging over the supplied loaded rows; it never estimates a server-side total. */
export function approvedWhmTablePage<T>(rows: readonly T[], requestedPage = 1, requestedSize = 20): {
  rows: readonly T[]; page: number; size: number; total: number; totalPages: number; start: number; end: number; previous: boolean; next: boolean
} {
  const size = [10, 20, 50].includes(requestedSize) ? requestedSize : 20
  const total = rows.length
  const totalPages = Math.ceil(total / size)
  const integerPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const page = Math.min(integerPage, Math.max(1, totalPages))
  const offset = (page - 1) * size
  return { rows: rows.slice(offset, offset + size), page, size, total, totalPages, start: total ? offset + 1 : 0, end: Math.min(offset + size, total), previous: page > 1, next: page < totalPages }
}

function bindApprovedWhmTableFilters(): void {
  if (typeof document === 'undefined') return
  const ar = document.documentElement.lang === 'ar'
  document.querySelectorAll<HTMLElement>('[data-whm-table-workspace]').forEach(scope => {
    if (scope.dataset.whmFiltersBound === 'true') return
    const own = <T extends Element>(selector: string): T[] => Array.from(scope.querySelectorAll<T>(selector)).filter(element => element.closest('[data-whm-table-workspace]') === scope)
    const tableRoot = own<HTMLElement>('[data-whm-filter-table]')[0]
    const table = tableRoot?.tagName === 'TABLE' ? tableRoot as HTMLTableElement : tableRoot?.querySelector<HTMLTableElement>('table')
    if (!table || table.closest('[data-whm-table-workspace]') !== scope) return
    scope.dataset.whmFiltersBound = 'true'
    const records = Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody > tr')).flatMap(row => {
      if (row.closest('table') !== table || row.closest('[data-whm-table-workspace]') !== scope || row.closest('[hidden],[aria-hidden="true"]')) return []
      const marker = row.cells[0]?.querySelector<HTMLElement>('span[data-whm-filter-row]')
      if (!marker || marker.closest('tr') !== row || marker.closest('[hidden],[aria-hidden="true"]')) return []
      return [{ element: row, value: { kind: marker.dataset.kind, account: marker.dataset.account, ssl: marker.dataset.ssl, php: marker.dataset.php, status: marker.dataset.status, search: marker.dataset.search } }]
    })
    const search = own<HTMLInputElement>('[name="whm-search"]')[0]
    const account = own<HTMLSelectElement>('[name="whm-account"]')[0]
    const ssl = own<HTMLSelectElement>('[name="whm-ssl"]')[0]
    const php = own<HTMLSelectElement>('[name="whm-php"]')[0]
    const status = own<HTMLSelectElement>('[name="whm-status"]')[0]
    const size = own<HTMLSelectElement>('[name="whm-page-size"]')[0]
    const previous = own<HTMLButtonElement>('[data-whm-page="previous"]')
    const next = own<HTMLButtonElement>('[data-whm-page="next"]')
    const pageStatus = own<HTMLElement>('[data-whm-page-status]')[0]
    const kinds = own<HTMLButtonElement>('button[data-whm-kind]')
    const allowedKinds = ['all', 'primary', 'addon', 'subdomain', 'alias']
    let kind = kinds.find(button => button.getAttribute('aria-pressed') === 'true' && allowedKinds.includes(button.dataset.kind ?? ''))?.dataset.kind ?? 'all'
    let currentPage = 1
    let emptyRow: HTMLTableRowElement | undefined
    const selected = (control: HTMLInputElement | HTMLSelectElement | undefined): string => control && !control.disabled ? control.value : ''
    const apply = (): void => {
      // A missing observed list is distinct from a filtered empty result: preserve its original empty state.
      if (records.length === 0) {
        previous.forEach(button => { button.disabled = true })
        next.forEach(button => { button.disabled = true })
        return
      }
      const filters = { kind, search: selected(search), account: selected(account), ssl: selected(ssl), php: selected(php), status: selected(status) }
      const matched = records.filter(record => approvedWhmTableMatches(record.value, filters))
      const page = approvedWhmTablePage(matched, currentPage, Number(selected(size)) || 20)
      currentPage = page.page
      const shown = new Set(page.rows)
      records.forEach(record => { record.element.hidden = !shown.has(record) })
      if (page.total === 0 && !emptyRow) {
        emptyRow = table.ownerDocument.createElement('tr')
        emptyRow.dataset.whmFilterEmpty = 'true'
        const cell = table.ownerDocument.createElement('td')
        cell.colSpan = Math.max(1, records[0]!.element.cells.length)
        cell.textContent = scope.dataset.emptyMessage || (ar ? 'لا توجد صفوف مطابقة للتصفية.' : 'No loaded rows match these filters.')
        emptyRow.appendChild(cell)
        records[0]!.element.parentElement!.appendChild(emptyRow)
      }
      if (emptyRow) emptyRow.hidden = page.total !== 0
      previous.forEach(button => { button.disabled = !page.previous })
      next.forEach(button => { button.disabled = !page.next })
      kinds.forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.kind === kind)) })
      if (pageStatus) {
        pageStatus.setAttribute('role', 'status')
        pageStatus.setAttribute('aria-live', 'polite')
        pageStatus.textContent = page.total === 0
          ? (ar ? 'لا توجد نتائج مطابقة في الصفوف المحمّلة.' : 'No matching results in the loaded rows.')
          : ar ? `${page.start}–${page.end} من ${page.total} صفًا محمّلًا · الصفحة ${page.page} من ${page.totalPages}` : `${page.start}–${page.end} of ${page.total} loaded rows · Page ${page.page} of ${page.totalPages}`
      }
    }
    const resetPage = (): void => { currentPage = 1; apply() }
    search?.addEventListener('input', () => { if (!search.disabled) resetPage() })
    for (const control of [account, ssl, php, status, size]) control?.addEventListener('change', () => { if (!control.disabled) resetPage() })
    kinds.forEach(button => button.addEventListener('click', event => {
      event.preventDefault()
      if (button.disabled || !allowedKinds.includes(button.dataset.kind ?? '')) return
      kind = button.dataset.kind!
      resetPage()
    }))
    own<HTMLButtonElement>('[data-whm-clear-filters]').forEach(button => button.addEventListener('click', event => {
      event.preventDefault()
      if (button.disabled) return
      for (const control of [search, account, ssl, php, status]) if (control) control.value = ''
      kind = 'all'
      resetPage()
    }))
    previous.forEach(button => button.addEventListener('click', event => {
      event.preventDefault()
      if (button.disabled) return
      currentPage -= 1
      apply()
    }))
    next.forEach(button => button.addEventListener('click', event => {
      event.preventDefault()
      if (button.disabled) return
      currentPage += 1
      apply()
    }))
    apply()
  })
}

/** Function expression, invoked once by the existing client; contains no transport or mutation hooks. */
export const APPROVED_WHM_TABLE_FILTERS_CLIENT = `function approvedWhmTableFiltersClient() { const approvedWhmTableMatches = ${approvedWhmTableMatches.toString()}; const approvedWhmTablePage = ${approvedWhmTablePage.toString()}; (${bindApprovedWhmTableFilters.toString()})(); }`
