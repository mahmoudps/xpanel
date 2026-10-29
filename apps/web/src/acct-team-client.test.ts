// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderAccountTeamWorkspace } from './board-port/acct-team-workspace.ts'
import { ACCOUNT_TEAM_CLIENT_BINDING, readAccountTeamView } from './acct-team-client.ts'

const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64)
const A = '77777777-7777-4777-8777-000000000001', B = '77777777-7777-4777-8777-000000000002'
const member = (overrides: Record<string, unknown> = {}) => ({ id: A, username: 'sam', roles: ['email'], contactEmail: 'sam@alice.example', notes: '', expiresAt: null, expiryReason: null, status: 'active', suspendReason: null, phase: 'active', toolCount: 24, signIn: { password: 'not-set', linkExpiresAt: null, lastLoginAt: null }, ...overrides })
const view = (overrides: Record<string, unknown> = {}) => ({ state: 'saved', revision: R1, account: { username: 'alice', primaryDomain: 'alice.example' }, limits: { roleHolders: 7, members: 100, roleHoldersUsed: 1 }, members: [member()], signIn: { available: false }, ...overrides })
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = (send?: Send, locale: 'en' | 'ar' = 'en', canManage = true, ask?: (options: Record<string, unknown>) => Promise<unknown>) => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = renderAccountTeamWorkspace({ lang: locale, accountId: 'acc', canManage })
  if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  new Function('return ' + ACCOUNT_TEAM_CLIENT_BINDING)()(ask, locale === 'ar')
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const set = (name: string, value: string) => { $<HTMLInputElement>(`[data-acct-team-input="${name}"]`).value = value }

beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
afterEach(() => { document.body.innerHTML = ''; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('account team parser', () => {
  it('accepts consistent views and refuses inconsistent ones', () => {
    expect(readAccountTeamView(view()).members[0]!.username).toBe('sam')
    expect(readAccountTeamView(view({ signIn: { available: true }, members: [member({ signIn: { password: 'set', linkExpiresAt: null, lastLoginAt: '2026-10-28T09:00:00.000Z' } })] })).signIn.available).toBe(true)
    const linked = view({ signIn: { available: true }, changed: A, passwordLink: { path: '/login?target=xpanel#team-password=' + 'x'.repeat(43), expiresAt: '2026-10-31T12:00:00.000Z' } })
    expect(readAccountTeamView(linked).passwordLink?.path).toContain('#team-password=')
    for (const bad of [view({ signIn: { available: 'yes' } }), view({ signIn: { available: false, login: 'x' } }), view({ members: [member({ signIn: { password: 'set', linkExpiresAt: null, lastLoginAt: null } })] }),
      view({ signIn: { available: true }, members: [member({ signIn: { password: 'maybe', linkExpiresAt: null, lastLoginAt: null } })] }), { ...linked, changed: undefined },
      view({ signIn: { available: true }, changed: A, passwordLink: { path: 'https://evil.example/login#team-password=' + 'x'.repeat(43), expiresAt: '2026-10-31T12:00:00.000Z' } }), view({ state: 'default' }), view({ limits: { roleHolders: 7, members: 100, roleHoldersUsed: 2 } }), view({ members: [member({ status: 'suspended' })] }), view({ members: [member({ roles: ['owner'] })] }), view({ members: [member(), member()] })])
      expect(() => readAccountTeamView(bad)).toThrow()
  })
})

describe('account team client', () => {
  it('reads and paints members with the honest sign-in state', async () => {
    const send = vi.fn(async () => view())
    boot(send)
    await flush()
    expect(send).toHaveBeenCalledWith('GET', '/api/account/team')
    expect($('[data-acct-team-rows]').textContent).toContain('sam@alice.example')
    expect($('[data-acct-team-usage]').textContent).toBe('1 / 7')
    expect($('[data-acct-team-signin]').textContent).toContain('cannot sign in')
    expect($('[data-acct-team-empty]').hidden).toBe(true)
  })
  it('creates a member with the observed revision and verifies the reply', async () => {
    const send = vi.fn(async (method: string) => method === 'GET' ? view({ members: [], limits: { roleHolders: 7, members: 100, roleHoldersUsed: 0 } }) : view({ revision: R2, members: [member({ id: B, username: 'dev', roles: ['database'], contactEmail: 'dev@alice.example' })], changed: B }))
    boot(send)
    await flush()
    set('username', 'dev'); set('contactEmail', 'dev@alice.example'); set('expiresAt', '2026-12-31T00:00')
    $<HTMLInputElement>('#acct-team-role-database').checked = true
    $<HTMLFormElement>('[data-acct-team-form]').dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/account/team', { roles: ['database'], contactEmail: 'dev@alice.example', notes: '', expiresAt: '2026-12-31T00:00:00.000Z', expiryReason: null, username: 'dev', expectedRevision: R1 })
    expect($('[data-acct-team-save-status]').dataset.state).toBe('ok')
  })
  it('suspends through the dialog and reports conflicts without assuming success', async () => {
    const send = vi.fn(async (method: string) => { if (method === 'GET') return view(); throw Object.assign(new Error('conflict'), { status: 409 }) })
    boot(send, 'en', true, async () => 'On leave')
    await flush()
    $<HTMLButtonElement>('[data-action="suspend"]').click()
    await flush()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/account/team/' + A + '/suspend', { reason: 'On leave', expectedRevision: R1 })
    expect($('[data-acct-team-list-status]').dataset.state).toBe('failed')
    expect($('[data-acct-team-list-status]').textContent).toContain('changed since it was read')
  })
  it('does not delete when the typed username differs', async () => {
    const send = vi.fn(async () => view())
    boot(send, 'en', true, async () => 'other')
    await flush()
    $<HTMLButtonElement>('[data-action="delete"]').click()
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect($('[data-acct-team-list-status]').textContent).toContain('did not match')
  })
  it('shows available team sign-in and hands the owner a one-time password link', async () => {
    const available = view({ signIn: { available: true } })
    const secret = 'Ab_-'.repeat(10) + 'xyz'
    const send = vi.fn(async (method: string) => method === 'GET' ? available
      : { ...available, revision: R2, changed: A, members: [member({ signIn: { password: 'not-set', linkExpiresAt: '2026-10-31T12:00:00.000Z', lastLoginAt: null } })], passwordLink: { path: '/login?target=xpanel#team-password=' + secret, expiresAt: '2026-10-31T12:00:00.000Z' } })
    const ask = vi.fn(async () => true)
    boot(send, 'en', true, ask)
    await flush()
    expect($('[data-acct-team-signin-state]').dataset.stateChip).toBe('ok')
    expect($('[data-acct-team-signin]').textContent).toContain('Username column')
    expect($('[data-acct-team-rows]').textContent).toContain('No password yet')
    $<HTMLButtonElement>('[data-action="link"]').click()
    await flush()
    expect(ask).toHaveBeenCalledOnce()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/account/team/' + A + '/password-link', { expectedRevision: R1 })
    expect($('[data-acct-team-link]').hidden).toBe(false)
    expect($<HTMLInputElement>('[data-acct-team-link-url]').value).toBe(window.location.origin + '/login?target=xpanel#team-password=' + secret)
    expect($('[data-acct-team-rows]').textContent).toContain('Link valid until')
    $<HTMLButtonElement>('[data-acct-team-link-done]').click()
    expect($('[data-acct-team-link]').hidden).toBe(true)
    expect($<HTMLInputElement>('[data-acct-team-link-url]').value).toBe('')
  })
  it('keeps the password link button disabled for a suspended member', async () => {
    const send = vi.fn(async () => view({ signIn: { available: true }, members: [member({ status: 'suspended', suspendReason: 'Leave', phase: 'suspended' })] }))
    boot(send, 'en', true, async () => true)
    await flush()
    expect($<HTMLButtonElement>('[data-action="link"]').disabled).toBe(true)
  })
  it('stays read-only without management authority', async () => {
    const send = vi.fn(async () => view())
    boot(send, 'ar', false)
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect($('[data-acct-team-status]').dataset.state).toBe('unavailable')
    expect($('[data-acct-team-workspace]').getAttribute('dir')).toBe('rtl')
    expect($<HTMLButtonElement>('[data-acct-team-save]').disabled).toBe(true)
  })
})
