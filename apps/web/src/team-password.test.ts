// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEAM_PASSWORD_CLIENT_BINDING, renderTeamPasswordSection } from './team-password.ts'

const SECRET = 'Ab_-'.repeat(10) + 'xyz'
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = (hash: string, locale: 'en' | 'ar' = 'en') => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = `<form data-login-form><input name="username"></form>${renderTeamPasswordSection(locale)}`
  window.history.replaceState(null, '', '/login?target=xpanel' + hash)
  new Function(TEAM_PASSWORD_CLIENT_BINDING)()
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const fill = (password: string, confirm = password) => { $<HTMLInputElement>('#team-password-new').value = password; $<HTMLInputElement>('#team-password-confirm').value = confirm }
const submit = () => $<HTMLFormElement>('[data-team-password-form]').dispatchEvent(new Event('submit', { cancelable: true }))

afterEach(() => { document.body.innerHTML = ''; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; vi.unstubAllGlobals() })

describe('team password link page', () => {
  it('stays hidden without a team password link', () => {
    boot('')
    expect($('[data-team-password]').hidden).toBe(true)
    expect($('[data-login-form]').hidden).toBe(false)
  })
  it('takes the secret out of the address, checks the passwords locally and saves once', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, login: 'sam@alice.example' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    boot('#team-password=' + SECRET)
    expect(window.location.hash).toBe('')
    expect($('[data-team-password]').hidden).toBe(false)
    expect($('[data-login-form]').hidden).toBe(true)
    fill('NewPassword!2026', 'Different!2026')
    submit()
    expect($('[data-team-password-status]').dataset.state).toBe('failed')
    expect(fetch).not.toHaveBeenCalled()
    fill('NewPassword!2026')
    submit()
    await flush()
    expect(fetch).toHaveBeenCalledWith('/api/auth/team/password', expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: SECRET, password: 'NewPassword!2026' }) }))
    expect($('[data-team-password-status]').textContent).toContain('sam@alice.example')
    expect($('[data-login-form]').hidden).toBe(false)
    expect($<HTMLInputElement>('[name="username"]').value).toBe('sam@alice.example')
    expect($<HTMLInputElement>('#team-password-new').value).toBe('')
  })
  it('reports a used or expired link without claiming success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 })))
    boot('#team-password=' + SECRET, 'ar')
    fill('NewPassword!2026')
    submit()
    await flush()
    expect($('[data-team-password-status]').dataset.state).toBe('failed')
    expect($('[data-team-password-form]').hidden).toBe(false)
    expect($('[data-login-form]').hidden).toBe(true)
  })
})
