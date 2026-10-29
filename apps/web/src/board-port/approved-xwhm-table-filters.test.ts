/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Script } from 'node:vm'
import { APPROVED_WHM_TABLE_FILTERS_CLIENT, approvedWhmTableMatches, approvedWhmTablePage, type ApprovedWhmTableRow } from './approved-xwhm-table-filters.ts'

const row = (index: number, attributes = ''): string => `<tr data-test-row="${index}"><td><span data-whm-filter-row data-search="Site${index} Owner${index % 2}" data-kind="${index % 2 ? 'addon' : 'primary'}" data-account="owner${index % 2}" data-ssl="${index % 2 ? 'assigned' : 'unassigned'}" data-php="${index % 2 ? '8.3' : '8.4'}" data-status="${index % 2 ? 'valid' : 'expired'}" ${attributes}>Site${index}</span></td><td>Visible value${index}</td></tr>`
const controls = (): string => `<input name="whm-search"><select name="whm-account"><option value="">All accounts</option><option>owner0</option><option>owner1</option><option>unknown</option></select><select name="whm-ssl"><option value="">All SSL</option><option>assigned</option><option>unassigned</option></select><select name="whm-php"><option value="">All PHP</option><option>8.3</option><option>8.4</option></select><select name="whm-status"><option value="">All statuses</option><option>valid</option><option>expired</option><option>unknown</option></select><button data-whm-kind data-kind="all">All</button><button data-whm-kind data-kind="primary">Primary</button><button data-whm-kind data-kind="addon">Addon</button><button data-whm-clear-filters>Clear</button><select name="whm-page-size"><option>10</option><option selected>20</option><option>50</option></select><button data-whm-page="previous">Previous</button><span data-whm-page-status>Observation not read</span><button data-whm-page="next">Next</button>`
const workspace = (id: string, body: string): string => `<section id="${id}" data-whm-table-workspace data-empty-message="No local matches">${controls()}<table data-whm-filter-table><thead><tr><th>Site</th><th>State</th></tr></thead><tbody>${body}</tbody></table></section>`
const bind = () => new Function(`(${APPROVED_WHM_TABLE_FILTERS_CLIENT})();`)()
const root = (id = 'a') => document.querySelector<HTMLElement>(`#${id}`)!
const control = (name: string, id = 'a') => root(id).querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!
const shown = (id = 'a'): string[] => Array.from(root(id).querySelectorAll<HTMLTableRowElement>('tr[data-test-row]')).filter(item => !item.hidden).map(item => item.dataset.testRow!)
const status = (id = 'a') => root(id).querySelector<HTMLElement>('[data-whm-page-status]')!.textContent
const click = (selector: string, id = 'a') => root(id).querySelector<HTMLButtonElement>(selector)!.click()
const change = (name: string, value: string, id = 'a') => { const item = control(name, id); item.value = value; item.dispatchEvent(new Event(name === 'whm-search' ? 'input' : 'change', { bubbles: true })) }

afterEach(() => { document.body.replaceChildren(); document.documentElement.lang = 'en'; vi.restoreAllMocks() })

describe('pure loaded-row predicates and pagination', () => {
  const observed: ApprovedWhmTableRow = { kind: 'addon', account: 'Owner7', ssl: 'assigned', php: '8.3', status: 'valid', search: 'Store.EXAMPLE.test   Owner7' }
  it('combines exact observed metadata with case-insensitive normalized search', () => {
    expect(approvedWhmTableMatches(observed, { kind: 'addon', account: 'Owner7', ssl: 'assigned', php: '8.3', status: 'valid', search: '  store.example.TEST owner7  ' })).toBe(true)
    expect(approvedWhmTableMatches(observed, { account: 'owner7' })).toBe(false)
    expect(approvedWhmTableMatches(observed, { kind: 'primary' })).toBe(false)
    expect(approvedWhmTableMatches(observed, { search: 'not-loaded.example.test' })).toBe(false)
  })

  it('treats blank choices and all kinds as unfiltered without filling unknown metadata', () => {
    expect(approvedWhmTableMatches({}, { kind: 'all', account: '', ssl: '', php: '', status: '', search: ' ' })).toBe(true)
    for (const key of ['account', 'ssl', 'php', 'status', 'kind'] as const) expect(approvedWhmTableMatches({}, { [key]: 'unknown' })).toBe(false)
    expect(approvedWhmTableMatches({ status: 'unknown' }, { status: 'unknown' })).toBe(true)
  })

  it('preserves order and pages only the supplied rows with bounded sizes and page requests', () => {
    const rows = Array.from({ length: 25 }, (_, index) => index)
    expect(approvedWhmTablePage(rows, 2, 10)).toEqual({ rows: rows.slice(10, 20), page: 2, size: 10, total: 25, totalPages: 3, start: 11, end: 20, previous: true, next: true })
    expect(approvedWhmTablePage(rows, 99, 10).rows).toEqual(rows.slice(20))
    expect(approvedWhmTablePage(rows, -2, 50).page).toBe(1)
    expect(approvedWhmTablePage(rows, 1.5, 1).size).toBe(20)
    expect(approvedWhmTablePage(rows, Number.NaN, 20).page).toBe(1)
    expect(rows[0]).toBe(0)
  })

  it('describes a genuinely filtered empty list without inventing a last page or values', () => {
    expect(approvedWhmTablePage([], 9, 10)).toEqual({ rows: [], page: 1, size: 10, total: 0, totalPages: 0, start: 0, end: 0, previous: false, next: false })
  })
})

describe('scoped authorized DOM row binding', () => {
  it('serializes standalone executable JavaScript and performs no transport calls', () => {
    expect(() => new Script(`(${APPROVED_WHM_TABLE_FILTERS_CLIENT})();`)).not.toThrow()
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    document.body.innerHTML = workspace('a', row(1) + row(2))
    bind(); change('whm-search', 'Site1'); click('[data-whm-clear-filters]')
    expect(fetch).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('supports the filter marker on either the table or its scroll container', () => {
    document.body.innerHTML = workspace('a', row(1) + row(2)).replace('<table data-whm-filter-table>', '<div data-whm-filter-table><table>').replace('</table>', '</table></div>')
    bind(); change('whm-search', 'Site2')
    expect(shown()).toEqual(['2'])
    expect(status()).toContain('1 loaded rows')
  })

  it('searches and combines account, SSL, PHP and certificate status only within observed rows', () => {
    document.body.innerHTML = workspace('a', [row(1), row(2), row(3)].join(''))
    bind(); change('whm-account', 'owner1'); change('whm-ssl', 'assigned'); change('whm-php', '8.3'); change('whm-status', 'valid')
    expect(shown()).toEqual(['1', '3'])
    change('whm-search', '  SITE3 owner1  ')
    expect(shown()).toEqual(['3'])
    expect(status()).toContain('1–1 of 1 loaded rows')
  })

  it('handles kind selection and clear as local filter changes without affecting page-size preference', () => {
    document.body.innerHTML = workspace('a', Array.from({ length: 24 }, (_, i) => row(i)).join(''))
    bind(); change('whm-page-size', '10'); click('[data-whm-page="next"]')
    expect(shown()[0]).toBe('10')
    click('[data-whm-kind][data-kind="addon"]')
    expect(shown()).toEqual(['1', '3', '5', '7', '9', '11', '13', '15', '17', '19'])
    expect(root().querySelector('[data-kind="addon"]')!.getAttribute('aria-pressed')).toBe('true')
    change('whm-account', 'unknown')
    expect(shown()).toEqual([])
    click('[data-whm-clear-filters]')
    expect(control('whm-account').value).toBe('')
    expect(control('whm-page-size').value).toBe('10')
    expect(shown()).toEqual(Array.from({ length: 10 }, (_, i) => String(i)))
    expect(root().querySelector('[data-kind="all"]')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('clamps navigation, resets to page 1 when filters change and never submits a containing form', () => {
    document.body.innerHTML = `<form id="outer">${workspace('a', Array.from({ length: 25 }, (_, i) => row(i)).join(''))}</form>`
    const submit = vi.fn((event: Event) => event.preventDefault()); document.querySelector('form')!.addEventListener('submit', submit)
    bind(); change('whm-page-size', '10'); click('[data-whm-page="next"]'); click('[data-whm-page="next"]')
    expect(shown()).toEqual(['20', '21', '22', '23', '24'])
    expect(root().querySelector<HTMLButtonElement>('[data-whm-page="next"]')!.disabled).toBe(true)
    click('[data-whm-page="next"]'); expect(shown()[0]).toBe('20')
    change('whm-search', 'Site1 owner1')
    expect(shown()).toEqual(['1'])
    expect(status()).toContain('Page 1 of 1')
    expect(submit).not.toHaveBeenCalled()
  })

  it('renders the empty result as plain text and hides it after a clear', () => {
    document.body.innerHTML = workspace('a', row(1))
    root().dataset.emptyMessage = '<img src=x onerror=alert(1)> No local matches'
    bind(); change('whm-account', 'unknown')
    const empty = root().querySelector<HTMLTableRowElement>('[data-whm-filter-empty]')!
    expect(empty.hidden).toBe(false)
    expect(empty.cells[0]!.colSpan).toBe(2)
    expect(empty.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(empty.querySelector('img')).toBeNull()
    expect(status()).toBe('No matching results in the loaded rows.')
    click('[data-whm-clear-filters]')
    expect(empty.hidden).toBe(true)
    expect(shown()).toEqual(['1'])
  })

  it('preserves a missing observation table exactly and creates no fabricated filtered result', () => {
    document.body.innerHTML = workspace('a', '<tr><td colspan="2">The authorized observation has not been read.</td></tr>')
    const tbody = root().querySelector('tbody')!, before = tbody.innerHTML
    bind(); change('whm-search', 'missing'); click('[data-whm-clear-filters]')
    expect(tbody.innerHTML).toBe(before)
    expect(root().querySelector('[data-whm-filter-empty]')).toBeNull()
    expect(status()).toBe('Observation not read')
    expect(root().querySelector<HTMLButtonElement>('[data-whm-page="next"]')!.disabled).toBe(true)
  })

  it('does not unhide rows outside the original authorized first-cell marker snapshot', () => {
    document.body.innerHTML = workspace('a', row(1) + row(2).replace('<tr ', '<tr hidden ') + '<tr data-test-row="3" hidden><td>No marker</td><td><span data-whm-filter-row data-search="Secret">Marker in wrong cell</span></td></tr>') + '<table><tbody><tr id="outside" hidden><td>Outside</td></tr></tbody></table>'
    bind()
    root().querySelector('tbody')!.insertAdjacentHTML('beforeend', row(4).replace('<tr ', '<tr hidden '))
    change('whm-search', 'Site2'); click('[data-whm-clear-filters]')
    expect(shown()).toEqual(['1'])
    expect(document.querySelector<HTMLTableRowElement>('#outside')!.hidden).toBe(true)
    expect(status()).toContain('1 loaded rows')
  })

  it('does not treat absent row metadata as an unknown filter value or honor disabled controls', () => {
    document.body.innerHTML = workspace('a', row(1).replace('data-status="valid"', ''))
    bind(); change('whm-status', 'unknown')
    expect(shown()).toEqual([])
    click('[data-whm-clear-filters]')
    const account = control('whm-account'); account.disabled = true
    change('whm-account', 'unknown')
    expect(shown()).toEqual(['1'])
  })

  it('isolates adjacent and nested workspaces and their paging controls', () => {
    document.body.innerHTML = workspace('a', row(1) + row(2)) + workspace('b', row(3) + row(4))
    root('a').appendChild(root('b'))
    bind(); change('whm-search', 'Site1', 'a')
    expect(shown('a').filter(id => ['1', '2'].includes(id))).toEqual(['1'])
    expect(shown('b')).toEqual(['3', '4'])
    change('whm-search', 'Site4', 'b')
    expect(shown('b')).toEqual(['4'])
    expect(status('a')).toContain('1 loaded rows')
    expect(status('b')).toContain('1 loaded rows')
  })

  it('binds each workspace once without duplicate handlers or including newly inserted rows', () => {
    document.body.innerHTML = workspace('a', Array.from({ length: 25 }, (_, i) => row(i)).join(''))
    bind(); bind(); change('whm-page-size', '10'); click('[data-whm-page="next"]')
    expect(shown()[0]).toBe('10')
    expect(status()).toContain('Page 2 of 3')
  })

  it('uses localized plain text with ASCII counts for Arabic', () => {
    document.documentElement.lang = 'ar'
    document.body.innerHTML = workspace('a', row(1) + row(2))
    bind()
    expect(status()).toContain('1–2 من 2')
    expect(status()).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    change('whm-account', 'unknown')
    expect(status()).toBe('لا توجد نتائج مطابقة في الصفوف المحمّلة.')
  })
})

describe('domain row change recollection', () => {
  const domain = (body: string) => `<main data-whm-detail-route="/whm/domains"><div data-domain-editor></div>${workspace('a', body)}</main>`
  const changed = (source: Element = document.querySelector('[data-domain-editor]')!) => source.dispatchEvent(new Event('xpanel:whm-domain-rows-changed', { bubbles: true }))

  it('preserves current query, kind and page then clamps after actual domain rows are removed', () => {
    document.body.innerHTML = domain(Array.from({ length: 45 }, (_, index) => row(index)).join(''))
    bind(); change('whm-search', 'Owner1'); change('whm-account', 'owner1'); click('[data-kind="addon"]'); change('whm-page-size', '10'); click('[data-whm-page="next"]'); click('[data-whm-page="next"]')
    root().querySelector('tbody')!.insertAdjacentHTML('beforeend', row(45)); changed()
    expect(shown()).toEqual(['41', '43', '45']); expect(status()).toContain('Page 3 of 3')
    root().querySelector('tbody')!.innerHTML = row(1) + row(3); changed()
    expect(shown()).toEqual(['1', '3']); expect(status()).toContain('Page 1 of 1')
    expect(control('whm-search').value).toBe('Owner1'); expect(control('whm-account').value).toBe('owner1')
    expect(root().querySelector('[data-kind="addon"]')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('retains filter-hidden authorized rows while excluding new hidden and unmarked rows', () => {
    document.body.innerHTML = domain(row(1) + row(2) + row(5).replace('<tr ', '<tr hidden '))
    bind(); change('whm-search', 'Site2')
    root().querySelector('tbody')!.insertAdjacentHTML('beforeend', row(3) + row(4).replace('<tr ', '<tr hidden ') + '<tr data-test-row="9"><td>No marker</td></tr>')
    changed(); expect(shown()).toEqual(['2', '9'])
    click('[data-whm-clear-filters]')
    expect(shown().filter(value => value !== '9')).toEqual(['1', '2', '3'])
    expect(status()).toContain('3 loaded rows')
  })

  it('replaces the generated empty state after a verified domain change without stale totals', () => {
    document.body.innerHTML = domain(row(1)); bind(); change('whm-search', 'missing')
    root().querySelector('tbody')!.innerHTML = ''; changed()
    expect(status()).toBe('No matching results in the loaded rows.')
    expect(root().querySelectorAll('[data-whm-filter-empty]')).toHaveLength(1)
    const previousEmpty = root().querySelector('[data-whm-filter-empty]')!
    root().querySelector('tbody')!.insertAdjacentHTML('beforeend', row(2)); changed(); click('[data-whm-clear-filters]')
    expect(shown()).toEqual(['2']); expect(status()).toContain('1 loaded rows')
    expect(previousEmpty.isConnected).toBe(false)
    expect(root().querySelectorAll('[data-whm-filter-empty]')).toHaveLength(1)
    expect(root().querySelector<HTMLTableRowElement>('[data-whm-filter-empty]')!.hidden).toBe(true)
  })

  it('does not recollect on another route or duplicate listeners on repeated binding', () => {
    document.body.innerHTML = domain(row(1)) + workspace('b', row(2))
    const page = document.querySelector('[data-whm-detail-route]')!
    page.insertAdjacentHTML('beforeend', '<div data-whm-detail-route="/whm/ssl" data-foreign-editor></div>')
    bind(); bind()
    root().querySelector('tbody')!.insertAdjacentHTML('beforeend', row(3)); changed(document.querySelector('[data-foreign-editor]')!)
    expect(status()).toContain('1 loaded rows')
    root('b').querySelector('tbody')!.insertAdjacentHTML('beforeend', row(4)); changed(root('b')); click('[data-whm-clear-filters]', 'b')
    expect(status('b')).toContain('1 loaded rows')
    changed(); expect(status()).toContain('2 loaded rows')
    expect(shown()).toEqual(['1', '3'])
  })
})
