// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmDetailPage } from './board-port/approved-xwhm.ts'
import { renderClassicIdentityCards } from './board-port/identity-workspaces.ts'
import { renderV2IdentityCards } from './themes/v2/pages/identity.ts'
import { renderV2WhmSsh } from './themes/v2/pages/xwhm/security/ssh.ts'
import { AUTHORITATIVE_CONTROLLER_DECLARATIONS } from './themes/controller-hooks.ts'
import { checkControllerDeclarations } from './themes/controller-conformance.ts'
import { parseMarkup } from './themes/markup.ts'
import { generatePassword, IDENTITY_CLIENT_BINDING, passwordScore } from './identity-client.ts'
import { renderLoginSurface } from './surfaces/login.ts'
import { renderV2Login } from './themes/v2/surfaces/login.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
type Theme = 'classic' | 'v2'
const ROOT = { kind: 'root' as const, id: 'synthetic-root', username: 'synthetic-root' }
const VERIFIED = [{ id: 'server-settings-edit', status: 'verified' }] as never
const tick = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const within = (page: string) => <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(`[data-sec-page="${page}"] ${selector}`)!
const ssh = (theme: Theme, canRead = true) => theme === 'classic'
  ? renderWhmDetailPage({ activeRoute: '/whm/security/ssh', principal: ROOT, locale: 'en', ...(canRead ? { catalog: VERIFIED } : {}) })!
  : renderV2WhmSsh({ activeRoute: '/whm/security/ssh', principal: ROOT, locale: 'en', observationAuthority: { canRead, canManage: canRead } })
const cards = (theme: Theme, surface: 'xwhm' | 'xpanel' = 'xwhm', principalKind = 'root') =>
  (theme === 'classic' ? renderClassicIdentityCards : renderV2IdentityCards)({ locale: 'en', principalKind, surface, identityToolsAvailable: true })
const boot = (html: string, send?: Send, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => true) => {
  delete (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest
  document.body.innerHTML = html
  if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + IDENTITY_CLIENT_BINDING)()(ask)
}
const type = (page: string, key: string, value: string) => { const node = within(page)<HTMLInputElement>(`[data-sec-input="${key}"]`); node.value = value; node.dispatchEvent(new Event('input')) }
const click = (page: string, action: string) => within(page)<HTMLButtonElement>(`[data-sec-action="${action}"]`).click()
const group = { observedAt: '2026-11-07T09:00:00.000Z', family: 'rhel', group: 'wheel', state: 'read', members: [{ username: 'alice', account: true }, { username: 'rocky', account: false }], accounts: [{ username: 'alice', member: true }, { username: 'bob', member: false }] }
afterEach(() => { document.body.innerHTML = ''; history.replaceState(null, '', '/') })

describe('identity workspaces markup', () => {
  it.each(['classic', 'v2'] as const)('%s renders every declared identity control', theme => {
    const declarations = AUTHORITATIVE_CONTROLLER_DECLARATIONS.filter(item => item.id.startsWith('identity-'))
    expect(declarations).toHaveLength(6)
    expect(checkControllerDeclarations(parseMarkup(ssh(theme)), declarations.filter(item => item.applicableRoutes?.includes('/whm/security/ssh')), { route: '/whm/security/ssh', surface: 'xwhm', qualified: true })).toEqual([])
    expect(checkControllerDeclarations(parseMarkup(cards(theme)), declarations.filter(item => item.applicableRoutes?.includes('/whm/security/sign-in')), { route: '/whm/security/sign-in', surface: 'xwhm', qualified: true })).toEqual([])
    const owner = cards(theme, 'xpanel', 'user')
    expect(checkControllerDeclarations(parseMarkup(owner), declarations.filter(item => item.applicableRoutes?.includes('/security/account')), { route: '/security/account', surface: 'xpanel', qualified: true })).toEqual([])
    expect(owner).not.toContain('data-sec-page="external-providers"')
    expect(owner).not.toContain('data-sec-page="security-policy"')
    expect((theme === 'classic' ? renderClassicIdentityCards : renderV2IdentityCards)({ locale: 'en', principalKind: 'user', surface: 'xmail' })).toBe('')
  })

  it.each(['classic', 'v2'] as const)('%s sign-in page offers only accepted providers and asks questions in its own step', theme => {
    const render = theme === 'classic' ? renderLoginSurface : renderV2Login
    const providers = [{ id: 'corp', label: 'Corporate <SSO>' }, { id: 'Bad Id', label: 'x' }]
    const html = render({ audience: 'xwhm', locale: 'en', externalProviders: providers })
    document.body.innerHTML = html
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-login-external] a')]
    expect(links.map(link => [link.getAttribute('href'), link.textContent])).toEqual([['/api/auth/oidc/start?provider=corp', 'Continue with Corporate <SSO>']])
    expect(document.querySelector('[data-auth-security-questions]')!.hasAttribute('hidden')).toBe(true)
    expect(document.querySelector('template[data-auth-security-question-template]')).not.toBeNull()
    expect(render({ audience: 'xmail', locale: 'en', externalProviders: providers })).not.toContain('data-login-external')
    expect(render({ audience: 'xwhm', locale: 'en' })).not.toContain('data-login-external')
  })

  it('scores a password like the server rule: repeats add nothing and the score stops at 100', () => {
    expect(passwordScore('')).toBe(0)
    expect(passwordScore('aaaaaaaa')).toBe(4)
    expect(passwordScore('abcdefgh')).toBe(37)
    expect(passwordScore('Abcdef1!')).toBe(52)
    expect(passwordScore('Abcdef1!'.repeat(4))).toBe(100)
  })

  it.each(['classic', 'v2'] as const)('%s drops the security questions card when the account plan withdraws the feature', theme => {
    const render = theme === 'classic' ? renderClassicIdentityCards : renderV2IdentityCards
    const props = { locale: 'en', principalKind: 'user', surface: 'xpanel', identityToolsAvailable: true } as const
    expect(render(props)).toContain('data-sec-page="security-questions"')
    const withdrawn = render({ ...props, securityPolicyDisabled: true })
    expect(withdrawn).not.toContain('data-sec-page="security-questions"')
    expect(withdrawn).toContain('data-sec-page="external-identities"')
  })

  it('generates passwords from the full alphabet without bias toward early characters', () => {
    const value = generatePassword(20)
    expect(value).toHaveLength(20)
    expect(value).toMatch(/^[A-Za-z0-9!#%+\-=?@_~]+$/)
  })
})

describe('identity client', () => {
  it.each(['classic', 'v2'] as const)('%s keeps the identity cards closed without authority and read-only in an unqualified document', async theme => {
    const send = vi.fn(async () => ({}))
    boot(ssh(theme, false), send)
    await tick()
    // An unqualified document may read saved values; it never sends an unsafe method, and its controls stay disabled.
    expect(send.mock.calls.every(call => (call as unknown[])[0] === 'GET')).toBe(true)
    expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, select, textarea, button')].every(node => node.disabled)).toBe(true)
    const unread = vi.fn(async () => ({}))
    boot((theme === 'classic' ? renderClassicIdentityCards : renderV2IdentityCards)({ locale: 'en', principalKind: 'root', surface: 'xwhm' }), unread)
    await tick()
    // Without qualified identity tools the cards still read saved values inside a read-only frame; nothing is written.
    expect(unread.mock.calls.every(call => (call as unknown[])[0] === 'GET')).toBe(true)
    expect([...document.querySelectorAll<HTMLElement>('[data-sec-workspace]')].map(node => node.dataset.secCanRead + '/' + node.dataset.secCanManage)).toEqual(['true/false', 'true/false', 'true/false', 'true/false'])
    expect([...document.querySelectorAll<HTMLElement>('[data-sec-workspace]')].every(node => node.closest('[data-readonly="true"]') !== null)).toBe(true)
    expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')].every(node => node.disabled)).toBe(true)
  })

  it.each(['classic', 'v2'] as const)('%s adds a hosting account to the administrator group only after confirmation', async theme => {
    const ask = vi.fn(async () => true)
    const send = vi.fn(async (method: string, path: string, body?: unknown) =>
      path === '/api/server/root-password' ? { capability: { secondFactor: 'not_enrolled' }, host: 'connected' }
        : method === 'POST' ? { outcome: 'applied', observation: { ...group, members: [...group.members, { username: 'bob', account: true }], accounts: [{ username: 'alice', member: true }, { username: 'bob', member: true }] }, body } : { observation: group, reason: null })
    boot(ssh(theme), send, ask)
    await tick()
    const rows = [...document.querySelectorAll('[data-sec-rows="members"] tr')].map(row => row.textContent)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('managed outside the panel')
    within('admin-group')<HTMLSelectElement>('[data-sec-input="account"]').value = 'bob'
    click('admin-group', 'add')
    await tick()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Give bob administrator rights?' }))
    expect(send).toHaveBeenCalledWith('POST', '/api/server/sec/admin-group', { action: 'add', username: 'bob' })
    expect(within('admin-group')('[data-sec-result]').textContent).toContain('bob was added')
  })

  it.each(['classic', 'v2'] as const)('%s changes the root password with re-authentication and clears every secret', async theme => {
    const send = vi.fn(async (method: string, path: string) => path === '/api/server/root-password' ? (method === 'GET' ? { capability: { secondFactor: 'required' }, host: 'connected' } : { outcome: 'applied', scheme: 'y' }) : { observation: group, reason: null })
    boot(ssh(theme), send)
    await tick()
    expect(within('root-password')('[data-identity-totp]').hidden).toBe(false)
    expect(within('root-password')('[data-sec-field="strength"]').textContent).toBe('Nothing entered')
    type('root-password', 'password', 'Correct-Horse-9'); within('root-password')('[data-sec-input="password"]').dispatchEvent(new Event('input'))
    expect(within('root-password')('[data-sec-field="strength"]').textContent).toBe(`${passwordScore('Correct-Horse-9')} of 100`)
    type('root-password', 'confirmation', 'Other-Horse-9'); type('root-password', 'current-password', 'current'); type('root-password', 'totp', '123456')
    click('root-password', 'change')
    await tick()
    expect(send).not.toHaveBeenCalledWith('POST', '/api/server/root-password', expect.anything())
    type('root-password', 'confirmation', 'Correct-Horse-9')
    click('root-password', 'change')
    await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/root-password', { currentPassword: 'current', password: 'Correct-Horse-9', confirmation: 'Correct-Horse-9', totpCode: '123456' })
    for (const key of ['password', 'confirmation', 'current-password', 'totp']) expect(within('root-password')<HTMLInputElement>(`[data-sec-input="${key}"]`).value).toBe('')
    expect(within('root-password')('[data-sec-field="strength"]').textContent).toBe('Nothing entered')
  })

  it.each(['classic', 'v2'] as const)('%s saves the filled security questions and finishes a provider link on return', async theme => {
    history.replaceState(null, '', '/whm/security/sign-in?lang=en&external=verified')
    const own = { policy: { verifiedIpSignIn: true }, questions: [], addresses: [], client: { address: '203.0.113.7', verified: false }, limits: {} }
    const send = vi.fn(async (method: string, path: string) =>
      path === '/api/auth/security-questions' ? own
        : path === '/api/server/sec/security-questions/reset' ? { username: 'alice', removed: 2 }
        : path === '/api/server/sec/security-questions' ? { state: 'default', policy: { verifiedIpSignIn: false }, updatedAt: null, revision: 'a'.repeat(64) }
          : path === '/api/server/sec/external-auth' ? { state: 'default', revision: 'b'.repeat(64), providers: [], redirectUris: { xwhm: 'https://whm.example.test:2087/api/auth/oidc/callback' }, identities: [] }
            : { available: true, reason: null, providers: [{ id: 'corp', label: 'Corporate' }], identities: method === 'POST' ? [] : [{ id: 'i1', providerId: 'corp', providerLabel: 'Corporate', label: 'admin@example.test', createdAt: '2026-11-07T09:00:00.000Z', lastUsedAt: null }] })
    boot(cards(theme), send)
    await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/auth/external-identities', {})
    expect(window.location.search).toBe('?lang=en')
    expect(within('external-identities')('[data-sec-result]').textContent).toContain('The identity was linked')
    expect(document.querySelector('[data-sec-rows="identities"]')!.textContent).toContain('admin@example.test')
    type('security-questions', 'question-1', 'First pet name?'); type('security-questions', 'answer-1', 'Rex')
    type('security-questions', 'question-2', 'City of birth?'); type('security-questions', 'answer-2', 'Amman'); type('security-questions', 'current-password', 'current')
    click('security-questions', 'save')
    await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/auth/security-questions', { currentPassword: 'current', questions: [{ question: 'First pet name?', answer: 'Rex' }, { question: 'City of birth?', answer: 'Amman' }] })
    expect(within('security-questions')<HTMLInputElement>('[data-sec-input="answer-1"]').value).toBe('')
    expect(within('external-providers')('[data-sec-field="redirect-uris"]').textContent).toBe('https://whm.example.test:2087/api/auth/oidc/callback')
    expect(document.querySelectorAll(`#${theme === 'classic' ? 'xp' : 'v2'}-identity-question-suggestions option`)).toHaveLength(6)
    type('security-policy', 'reset-username', ' Alice '); click('security-policy', 'reset-user')
    await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/sec/security-questions/reset', { username: 'Alice' })
    expect(within('security-policy')('[data-sec-result]').textContent).toContain('The security questions of alice were removed.')
  })
})
