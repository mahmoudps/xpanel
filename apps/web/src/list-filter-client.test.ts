/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { LIST_FILTER_CLIENT_SCRIPT } from './list-filter-client.ts'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'

afterEach(() => { document.body.replaceChildren() })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const row = (name: string, type: string, state: string) => `<tr data-list-row data-list-search="${name.toLowerCase()}" data-list-type="${type}" data-list-state="${state}"><td><a href="#${name}">${name}</a></td></tr>`
const boot = (rows: string, controls = '') => {
  document.body.innerHTML = `<section data-list-filter>
    <input type="search" data-list-filter-search>
    <div role="group" data-list-filter-key="type"><button type="button" data-list-filter-value="" aria-pressed="true">All</button><button type="button" data-list-filter-value="A" aria-pressed="false">A</button><button type="button" data-list-filter-value="MX" aria-pressed="false">MX</button></div>
    ${controls}
    <p><span data-list-filter-count></span> shown</p><p data-list-filter-empty hidden>Nothing matches.</p>
    <table><tbody data-rows>${rows}</tbody></table>
  </section>`
  new Function(LIST_FILTER_CLIENT_SCRIPT)()
}
const shown = () => Array.from(document.querySelectorAll<HTMLElement>('[data-list-row]')).filter(item => !item.hidden).map(item => item.querySelector('a, [data-name]')?.textContent)
const count = () => document.querySelector('[data-list-filter-count]')!.textContent
const empty = () => document.querySelector<HTMLElement>('[data-list-filter-empty]')!
const type = (value: string) => { const input = document.querySelector<HTMLInputElement>('[data-list-filter-search]')!; input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) }
const chip = (value: string) => document.querySelector<HTMLButtonElement>(`button[data-list-filter-value="${value}"]`)!
const rows = row('Alpha', 'A', 'active') + row('Beta', 'MX', 'active') + row('Gamma', 'A', 'suspended')

describe('generic list filter', () => {
  it('is part of the shared script and leaves an unmarked page alone', () => {
    expect(BROWSER_REALTIME_SCRIPT).toContain(LIST_FILTER_CLIENT_SCRIPT)
    document.body.innerHTML = '<table><tbody><tr data-list-row data-list-search="x"><td>x</td></tr></tbody></table>'
    new Function(LIST_FILTER_CLIENT_SCRIPT)()
    expect(document.querySelector<HTMLElement>('[data-list-row]')!.hidden).toBe(false)
  })

  it('filters by lower-cased search text, counts the visible rows and shows the empty block', () => {
    boot(rows)
    expect(shown()).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(count()).toBe('3')
    type('  ALP ')
    expect(shown()).toEqual(['Alpha'])
    expect(count()).toBe('1')
    expect(empty().hidden).toBe(true)
    type('nothing')
    expect(shown()).toEqual([])
    expect(count()).toBe('0')
    expect(empty().hidden).toBe(false)
    type('')
    expect(shown()).toHaveLength(3)
    expect(empty().hidden).toBe(true)
  })

  it('filters by a chip group and mirrors aria-pressed', () => {
    boot(rows)
    chip('A').click()
    expect(shown()).toEqual(['Alpha', 'Gamma'])
    expect(chip('A').getAttribute('aria-pressed')).toBe('true')
    expect(chip('').getAttribute('aria-pressed')).toBe('false')
    type('gam')
    expect(shown()).toEqual(['Gamma'])
    chip('').click()
    type('')
    expect(shown()).toHaveLength(3)
    expect(chip('').getAttribute('aria-pressed')).toBe('true')
  })

  it('combines a select and a radio group with the chips', () => {
    boot(rows, `<select data-list-filter-key="state"><option value="">All</option><option value="suspended">Suspended</option></select>`)
    const select = document.querySelector<HTMLSelectElement>('select[data-list-filter-key]')!
    select.value = 'suspended'; select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(shown()).toEqual(['Gamma'])
    chip('MX').click()
    expect(shown()).toEqual([])
    expect(empty().hidden).toBe(false)

    boot(rows, `<fieldset data-list-filter-key="state"><input type="radio" name="s" value="" checked><input type="radio" name="s" value="active"></fieldset>`)
    const radio = document.querySelector<HTMLInputElement>('input[type="radio"][value="active"]')!
    radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true }))
    expect(shown()).toEqual(['Alpha', 'Beta'])
  })

  it('applies the current filter to repainted rows and keeps the empty block for a real empty list closed', async () => {
    boot(rows)
    chip('MX').click()
    const body = document.querySelector('[data-rows]')!
    body.innerHTML = row('Delta', 'MX', 'active') + row('Epsilon', 'A', 'active')
    await settle()
    expect(shown()).toEqual(['Delta'])
    expect(count()).toBe('1')
    body.replaceChildren()
    await settle()
    expect(count()).toBe('0')
    expect(empty().hidden).toBe(true)
  })

  it('reads template-painted rows through data-list-field and never re-filters on an edit inside a row', async () => {
    boot('')
    const painted = (name: string, value: string) => `<tr data-list-row><td><input data-name value="${name}"></td><td><select data-list-field="type"><option${value === 'A' ? ' selected' : ''}>A</option><option${value === 'MX' ? ' selected' : ''}>MX</option></select></td><td><span data-list-field="state">Active</span></td></tr>`
    document.querySelector('[data-rows]')!.innerHTML = painted('www', 'A') + painted('mail', 'MX')
    await settle()
    const visible = () => Array.from(document.querySelectorAll<HTMLElement>('[data-list-row]')).filter(item => !item.hidden).map(item => item.querySelector<HTMLInputElement>('[data-name]')!.value)
    chip('A').click()
    expect(visible()).toEqual(['www'])
    type('WW')
    expect(visible()).toEqual(['www'])
    const select = document.querySelector<HTMLSelectElement>('[data-list-row] select')!
    select.value = 'MX'; select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(visible()).toEqual(['www'])
  })

  it('keeps a nested filter and its rows separate', () => {
    document.body.innerHTML = `<div data-list-filter><input data-list-filter-search><ul><li data-list-row data-list-search="outer"><a>outer</a></li></ul>
      <div data-list-filter><input data-list-filter-search><ul><li data-list-row data-list-search="inner"><a>inner</a></li></ul></div></div>`
    new Function(LIST_FILTER_CLIENT_SCRIPT)()
    const input = document.querySelector<HTMLInputElement>('[data-list-filter-search]')!
    input.value = 'zzz'; input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(shown()).toEqual(['inner'])
  })
})
