// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DIRECTORY_PRIVACY_CLIENT_BINDING } from './directory-privacy-client.ts'
import { directoryPrivacyClientTemplates } from './board-port/directory-privacy-client-templates.ts'
import { v2DirectoryPrivacyClientTemplates } from './themes/v2/pages/xpanel/files/directory-privacy-client-templates.ts'

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const snapshot = (enabled = true) => ({ config: { rules: [{ path: '/private', authName: '<svg>Private</svg>', enabled, users: [{ username: 'alice' }] }], compiledNginx: 'saved nginx', compiledApache: 'saved apache', updatedAt: '2026-10-30T00:00:00.000Z' } })
const workspace = (templates: string) => `<section data-directory-privacy data-account-username="owner"><table><tbody data-directory-privacy-rows></tbody></table><p data-directory-privacy-status></p><input data-directory-privacy-path><input data-directory-privacy-prompt><input data-directory-privacy-username><input type="password" data-directory-privacy-password><button data-directory-privacy-add disabled>Add</button><button data-directory-privacy-save disabled>Save</button><div data-directory-privacy-preview-wrap hidden><pre data-directory-privacy-preview></pre></div>${templates}</section>`
function boot(html: string, send: ReturnType<typeof vi.fn>) {
  document.body.innerHTML = html
  Object.assign(window, { xpanelSessionRequest: send })
  const binding = new Function('xpT', 'return ' + DIRECTORY_PRIVACY_CLIENT_BINDING)((message: string) => message) as (dialog: unknown) => void
  binding(undefined)
}
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe.each(['classic', 'v2'] as const)('%s saved directory privacy templates', theme => {
  const templates = () => theme === 'classic' ? directoryPrivacyClientTemplates() : v2DirectoryPrivacyClientTemplates()
  it('uses the selected rows and password labels, and preserves the verified saved-rule request', async () => {
    const send = vi.fn(async (method: string) => snapshot(method !== 'PUT'))
    boot(workspace(templates()), send); await tick()
    const row = document.querySelector<HTMLElement>('[data-directory-privacy-rule="/private"]')!
    expect(row).not.toBeNull()
    const name = row.querySelector<HTMLElement>('[data-xp-slot="username"]')!
    expect(name.textContent).toBe('alice'); expect(name.dir).toBe('ltr')
    expect(name.className).toBe(theme === 'classic' ? 'xp-mono' : 'v2-mono')
    expect(row.querySelector('svg')).toBeNull(); expect(row.textContent).toContain('<svg>Private</svg>')
    const password = row.querySelector<HTMLInputElement>('[data-directory-privacy-user-password="alice"]')!
    expect(row.querySelector<HTMLLabelElement>('[data-xp-slot="password-label"]')!.htmlFor).toBe(password.id)
    password.value = 'new correct horse'; password.dispatchEvent(new Event('input', { bubbles: true }))
    const enabled = row.querySelector<HTMLInputElement>('[data-directory-privacy-enabled]')!
    enabled.checked = false; enabled.dispatchEvent(new Event('change', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('[data-directory-privacy-save]')!.click(); await tick(); await tick()
    expect(send.mock.calls).toEqual([
      ['GET', '/api/web-features/owner/directory-privacy'],
      ['GET', '/api/web-features/owner/directory-privacy'],
      ['PUT', '/api/web-features/owner/directory-privacy', { rules: [{ path: '/private', authName: '<svg>Private</svg>', enabled: false, users: [{ username: 'alice', password: 'new correct horse' }] }] }],
    ])
    expect(document.querySelector<HTMLElement>('[data-directory-privacy-status]')!.dataset.state).toBe('saved')
  })
  it.each(['missing', 'duplicate', 'slot'] as const)('refuses %s template contracts before the first GET', async fault => {
    let html = workspace(templates())
    const holder = document.createElement('div'); holder.innerHTML = html
    if (fault === 'missing') holder.querySelector('template[data-xp-template="directory-privacy-user"]')!.remove()
    if (fault === 'duplicate') holder.querySelector('[data-directory-privacy]')!.append(holder.querySelector('template[data-xp-template="directory-privacy-rule"]')!.cloneNode(true))
    if (fault === 'slot') holder.querySelector<HTMLTemplateElement>('template[data-xp-template="directory-privacy-user"]')!.content.querySelector('[data-xp-slot="password-label"]')!.remove()
    html = holder.innerHTML
    const send = vi.fn()
    boot(html, send); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLElement>('[data-directory-privacy-status]')!.dataset.state).toBe('unavailable')
    document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-directory-privacy] input,[data-directory-privacy] button').forEach(control => expect(control.disabled).toBe(true))
  })
  it('keeps templates inert and makes no request under a read-only ancestor', async () => {
    const holder = document.createElement('div'); holder.innerHTML = templates()
    holder.querySelectorAll('template').forEach(template => template.content.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(control => expect(control.disabled).toBe(true)))
    const send = vi.fn()
    boot('<div data-readonly="true">' + workspace(templates()) + '</div>', send); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLElement>('[data-directory-privacy-status]')!.dataset.state).toBe('unavailable')
  })
})
