// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAILBOX_SETTINGS_CLIENT_BINDING } from './mail-mailbox-settings-client.ts'

const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = () => {
  const request = vi.fn(async () => ({ contacts: [{ email: 'friend@example.test', fullName: 'Friend' }] }))
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + MAILBOX_SETTINGS_CLIENT_BINDING)()()
  return request
}
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('compose address suggestions', () => {
  it('reads contacts for the compose recipients and lists them', async () => {
    document.body.innerHTML = '<div data-compose-form="true"><input name="to"><input name="cc"><input name="bcc"></div>'
    const request = boot(); await tick()
    expect(request).toHaveBeenCalledExactlyOnceWith('GET', '/api/webmail/contacts')
    expect(Array.from(document.querySelectorAll('input'), input => input.getAttribute('list'))).toEqual(Array(3).fill('compose-contact-suggestions'))
    expect(document.querySelector<HTMLOptionElement>('#compose-contact-suggestions option')!.value).toBe('friend@example.test')
  })
  it('sends no contacts read for a field named "to" outside the compose form, such as the filter test', async () => {
    document.body.innerHTML = '<section data-account-filters><div data-filter-test><input name="to"></div></section>'
    const request = boot(); await tick()
    expect(request).not.toHaveBeenCalled()
    expect(document.querySelector('input')!.hasAttribute('list')).toBe(false)
  })
})
