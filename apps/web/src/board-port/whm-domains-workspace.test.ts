// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderWhmDomainsWorkspace } from './whm-domains-workspace.ts'

describe('WHM domain editor renderer', () => {
  it.each(['en', 'ar'] as const)('keeps labels, controls and truthful limits in %s', locale => {
    const html = renderWhmDomainsWorkspace({ locale, accounts: [{ id: 'private-account-key', username: '<img src=x>', home: '/home/test', status: 'active' }], canManage: true })
    document.body.innerHTML = html
    expect(document.querySelector('[data-whm-domains-workspace]')!.getAttribute('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr')
    expect(document.querySelector('h1')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('[data-whm-domain-account]')!.textContent).toBe('<img src=x>')
    expect(document.body.textContent).not.toContain('private-account-key')
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')) expect(document.querySelector('label[for="' + control.id + '"]')).not.toBeNull()
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    for (const name of ['create', 'settings', 'refresh', 'reload', 'remove']) expect(document.querySelector('[data-whm-domain-' + name + ']')).not.toBeNull()
    for (const runtime of ['proxy', 'node', 'python']) expect(document.querySelector<HTMLOptionElement>('option[value="' + runtime + '"]')!.disabled).toBe(true)
  })
  it.each(['en', 'ar'] as const)('preserves disabled read-only controls without live forms in %s', locale => {
    document.body.innerHTML = renderWhmDomainsWorkspace({ locale, accounts: [{ id: 'private-account-key', username: 'account-one', home: '/home/test', status: 'active' }], canManage: false })
    expect(document.querySelector('form')).toBeNull()
    for (const marker of ['create', 'settings']) expect(document.querySelector('[data-whm-domain-' + marker + ']')?.tagName).toBe('DIV')
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) expect(control.disabled).toBe(true)
    expect(document.querySelector('[data-whm-domain-account]')!.textContent).toBe('account-one')
    expect(document.querySelector('[data-whm-domain-permission]')!.hasAttribute('hidden')).toBe(false)
  })
})
