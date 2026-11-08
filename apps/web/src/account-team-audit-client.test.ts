/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEAM_AUDIT_CLIENT_BINDING } from './account-team-audit-client.ts'

const card = `<section data-team-audit="account-id"><input data-team-audit-search disabled><table><tbody data-team-audit-rows></tbody></table><p data-team-audit-status></p><button type="button" data-team-audit-read disabled></button><button type="button" data-team-audit-more hidden disabled></button></section>`
const bind = (html: string) => {
  document.body.innerHTML = html
  const request = vi.fn(async () => ({ rows: [], nextBefore: null }))
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + TEAM_AUDIT_CLIENT_BINDING)()()
  return { request, search: document.querySelector<HTMLInputElement>('[data-team-audit-search]')!, read: document.querySelector<HTMLButtonElement>('[data-team-audit-read]')! }
}
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('team activity admission', () => {
  it('opens the search and read controls on a live page', () => {
    const { search, read } = bind(card)
    expect([search.disabled, read.disabled]).toEqual([false, false])
  })
  it('stays closed and reads nothing inside a read-only document', () => {
    const { request, search, read } = bind(`<div data-readonly="true">${card}</div>`)
    read.click()
    expect([search.disabled, read.disabled]).toEqual([true, true])
    expect(request).not.toHaveBeenCalled()
  })
})
