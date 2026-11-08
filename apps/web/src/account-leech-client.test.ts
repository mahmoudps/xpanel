// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_LEECH_CLIENT_BINDING, protectedLeechFolders, readLeechView } from './account-leech-client.ts'
import { renderAccountLeechSection } from './board-port/account-leech-workspace.ts'
import { renderV2LeechSection } from './themes/v2/pages/xpanel/files/leech.ts'
import { renderV2DirectoryPrivacyPage } from './themes/v2/pages/xpanel/files/privacy.ts'

const ACCOUNT = '22222222-2222-4222-8222-222222222222'
const FOLDER = { path: 'public_html/members', maxLogins: 4, redirectUrl: 'https://example.test/shared', alertEmail: null, disableUsers: true, state: 'applied', flagged: ['alice'], disabled: ['alice'] }
const view = (folders: unknown[] = [FOLDER], extra: Record<string, unknown> = {}) => ({ context: { accountId: ACCOUNT, username: 'alice' }, state: 'saved', revision: 'a'.repeat(64), limit: 100, updatedAt: null, capabilities: { canSave: true, reason: null }, folders, ...extra })
const privacy = { directories: [{ path: 'public_html/members', enabled: true }, { path: 'public_html/open', enabled: false }, { path: 'public_html/team', enabled: true }] }
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const render = (theme: string, canManage = true): string => theme === 'classic' ? renderAccountLeechSection({ lang: 'en', username: 'alice', canManage })
  : renderV2LeechSection(((message: string) => message) as never, { username: 'alice', canManage })
function boot(html: string, send: ReturnType<typeof vi.fn>, dialog?: (options: Record<string, unknown>) => Promise<unknown>) {
  document.body.innerHTML = html
  Object.assign(window, { xpanelSessionRequest: send })
  ;(new Function('xpT', 'return ' + ACCOUNT_LEECH_CLIENT_BINDING)((message: string, values?: Record<string, unknown>) => message.replace(/\{(\w+)\}/g, (_all, key: string) => String(values?.[key]))) as (askDialog: unknown) => void)(dialog)
}
const reader = (next: unknown = view()) => vi.fn(async (method: string, path: string) => path.includes('directory-privacy') ? privacy : method === 'POST' ? next : view())
const el = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('leech client views', () => {
  it('pins the shape of the reply and lists only protected folders', () => {
    expect(readLeechView(view(), 'alice').folders[0]!.state).toBe('applied')
    for (const bad of [null, view([], { context: { username: 'other' } }), view([{ ...FOLDER, state: 'done' }]), view([{ ...FOLDER, flagged: ['a b'] }]), view([], { capabilities: { canSave: true, reason: 'other' } })]) expect(() => readLeechView(bad, 'alice')).toThrow()
    expect(protectedLeechFolders(privacy)).toEqual(['public_html/members', 'public_html/team'])
    expect(() => protectedLeechFolders({})).toThrow()
  })
})

describe('leech section placement', () => {
  it('stays outside the directory privacy root, whose controller sets disabled on every control inside it', () => {
    document.body.innerHTML = renderV2DirectoryPrivacyPage(((message: string) => message) as never, { surface: { account: { id: ACCOUNT, username: 'alice', uid: 2000, status: 'active' } } as never, canManage: true })
    expect(document.querySelector('[data-leech-protection]')).not.toBeNull()
    expect(document.querySelector('[data-directory-privacy] [data-leech-protection]')).toBeNull()
  })
})

describe.each(['classic', 'v2'])('%s leech protection section', theme => {
  it('keeps every control disabled until the limits are read, and when the tool is not qualified', async () => {
    const send = reader()
    boot(render(theme, false), send); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(el('[data-lp-status]').dataset.state).toBe('unavailable')
    for (const selector of ['[data-lp-folder]', '[data-lp-max]', '[data-lp-url]', '[data-lp-email]', '[data-lp-disable]', '[data-lp-save]', '[data-lp-refresh]']) expect(el<HTMLInputElement>(selector).disabled).toBe(true)
  })

  it('shows the saved folders with their offenders and sends a revision-bound save', async () => {
    const send = reader(view([{ ...FOLDER, state: 'not_protected', maxLogins: 2 }]))
    boot(render(theme), send); await tick()
    expect(send.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/api/account/leech-protection'], ['GET', '/api/web-features/alice/directory-privacy']])
    expect([...el<HTMLSelectElement>('[data-lp-folder]').options].map(option => option.value)).toEqual(['public_html/members', 'public_html/team'])
    const row = el('[data-lp-rows] tr')
    expect(row.textContent).toContain('public_html/members'); expect(row.textContent).toContain('Active'); expect(row.textContent).toContain('alice')
    expect(row.querySelector<HTMLElement>('[data-xp-slot="redirect"]')!.dir).toBe('ltr')
    row.querySelector<HTMLButtonElement>('[data-xp-action="edit"]')!.click()
    expect(el<HTMLInputElement>('[data-lp-url]').value).toBe(FOLDER.redirectUrl); expect(el<HTMLInputElement>('[data-lp-disable]').checked).toBe(true)
    el<HTMLInputElement>('[data-lp-max]').value = '2'
    el<HTMLButtonElement>('[data-lp-save]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/account/leech-protection', { expectedRevision: 'a'.repeat(64), folder: { path: FOLDER.path, maxLogins: 2, redirectUrl: FOLDER.redirectUrl, alertEmail: null, disableUsers: true } })
    expect(el('[data-lp-status]').dataset.state).toBe('warning')
    expect(el('[data-lp-status]').textContent).toContain('The folder is not password protected')
  })

  it('asks before removing and shows a refused field beside the form', async () => {
    const dialog = vi.fn(async () => false), send = reader()
    boot(render(theme), send, dialog); await tick()
    el<HTMLButtonElement>('[data-xp-action="remove"]').click(); await tick()
    expect(dialog).toHaveBeenCalledTimes(1)
    expect(send.mock.calls.some(call => call[0] === 'POST')).toBe(false)
    dialog.mockResolvedValueOnce(true as never)
    el<HTMLButtonElement>('[data-xp-action="remove"]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/account/leech-protection', { expectedRevision: 'a'.repeat(64), remove: FOLDER.path })
    send.mockRejectedValueOnce({ status: 400, details: { stateChanged: false, fields: [{ field: 'redirectUrl', code: 'url' }] } })
    el<HTMLButtonElement>('[data-lp-save]').click(); await tick()
    expect(el('[data-lp-error]').hidden).toBe(false)
    expect(el('[data-lp-error]').textContent).toContain('http or https')
    expect(el<HTMLButtonElement>('[data-lp-save]').disabled).toBe(false)
  })

  it('stops after an uncertain outcome until the list is read again', async () => {
    const send = reader()
    boot(render(theme), send); await tick()
    send.mockRejectedValueOnce({ status: 503, details: { stateChanged: true, verificationRequired: true } })
    el<HTMLButtonElement>('[data-lp-save]').click(); await tick()
    expect(el('[data-lp-status]').dataset.state).toBe('uncertain')
    expect(el<HTMLButtonElement>('[data-lp-save]').disabled).toBe(true)
    el<HTMLButtonElement>('[data-lp-refresh]').click(); await tick()
    expect(el<HTMLButtonElement>('[data-lp-save]').disabled).toBe(false)
  })

  it('says why nothing can be saved on this host', async () => {
    boot(render(theme), vi.fn(async (_method: string, path: string) => path.includes('directory-privacy') ? { directories: [] } : view([], { capabilities: { canSave: false, reason: 'engine' } }))); await tick()
    expect(el('[data-lp-status]').textContent).toContain('Apache')
    expect(el<HTMLButtonElement>('[data-lp-save]').disabled).toBe(true)
  })
})
