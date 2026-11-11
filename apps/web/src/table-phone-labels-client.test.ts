// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { TABLE_PHONE_LABELS_CLIENT_BINDING } from './table-phone-labels-client.ts'

describe('table phone labels', () => {
  it('labels body cells of opted-in tables with their column name, keeps page labels and labels rows added later', async () => {
    document.body.innerHTML = '<table><thead><tr><th>Ignored</th></tr></thead><tbody><tr><td>u</td></tr></tbody></table><table data-phone-labels><thead><tr><th>Name</th><th colspan="2">Size</th><th>Actions</th></tr></thead><tbody><tr><td>a</td><td>1</td><td>2</td><td><span data-phone-label="Own">x</span></td></tr><tr><td colspan="4">Not read</td></tr></tbody></table>'
    ;(new Function(`return ${TABLE_PHONE_LABELS_CLIENT_BINDING}`)() as () => void)()
    const cells = [...document.querySelectorAll('td')]
    expect(cells.map(cell => cell.dataset.phoneLabel ?? null)).toEqual([null, 'Name', 'Size', 'Size', null, null])
    const row = document.createElement('tr'); row.innerHTML = '<td>b</td><td>3</td>'
    document.querySelector('table[data-phone-labels] tbody')!.append(row)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect([...row.cells].map(cell => cell.dataset.phoneLabel)).toEqual(['Name', 'Size'])
    expect(document.body.innerHTML).not.toContain('style=')
  })
})
