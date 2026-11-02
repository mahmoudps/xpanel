// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_CONTACT_CLIENT_BINDING } from './account-contact-client.ts'

const accountId = '10000000-0000-4000-8000-000000000001'
const receipt = { context: { accountId }, revision: 'a'.repeat(64), preferences: { contactEmail: 'Owner@example.test' } }
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => { document.body.replaceChildren(); document.documentElement.dir = 'ltr'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.unstubAllGlobals() })

describe('saved contact value isolation', () => {
  it.each(['dd', 'span'] as const)('keeps the %s value container on the RTL label edge and isolates only the actual email', async tag => {
    document.documentElement.dir = 'rtl'
    vi.stubGlobal('xpT', (message: string) => message.includes('\u0004') ? message.split('\u0004')[1]! : message)
    const request = vi.fn(async () => receipt)
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    const value = `<${tag} data-contact-saved></${tag}>`
    document.body.innerHTML = `<section dir="rtl" data-account-contact data-contact-account="${accountId}" data-contact-manage="false"><dl><div><dt>Saved contact</dt>${tag === 'dd' ? value : `<dd>${value}</dd>`}</div></dl><button data-contact-refresh></button><p data-contact-status></p></section>`
    ;(new Function('return ' + ACCOUNT_CONTACT_CLIENT_BINDING)() as (dialog: unknown, rtl: boolean) => void)(async () => false, true)
    await settle(); await settle()
    const saved = document.querySelector<HTMLElement>('[data-contact-saved]')!
    expect(request).toHaveBeenCalledWith('GET', '/api/account/preferences', undefined)
    expect(saved.getAttribute('dir')).toBeNull()
    expect(saved.getAttribute('style')).toBeNull()
    expect(saved.children).toHaveLength(1)
    expect(saved.firstElementChild?.tagName).toBe('BDI')
    expect(saved.firstElementChild?.getAttribute('dir')).toBe('ltr')
    expect(saved.textContent).toBe('Owner@example.test')
  })
})
