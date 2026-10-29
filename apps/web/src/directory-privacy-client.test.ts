// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DIRECTORY_PRIVACY_CLIENT_BINDING, directoryPrivacyConfig, directoryPrivacyDraft, directoryPrivacyDraftMatchesSnapshot,
  directoryPrivacyPassword, directoryPrivacyPath, directoryPrivacyPayload, directoryPrivacyPrompt, directoryPrivacySignature,
  directoryPrivacyUsername, type DirectoryPrivacyRuleDraft,
} from './directory-privacy-client.ts'

const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const username = 'dirpriva'
const snapshot = (patch: Record<string, unknown> = {}) => ({
  config: {
    rules: [{ path: '/private', authName: 'Private area', enabled: true, users: [{ username: 'alice' }] }],
    compiledNginx: 'location ^~ /private {\n  auth_basic "Private area";\n}',
    compiledApache: '<Directory "/home/dirpriva/public_html/private">\n  Require valid-user\n</Directory>',
    updatedAt: '2026-10-26T00:00:00.000Z', ...patch,
  },
})
const root = () => `<section data-directory-privacy data-account-username="${username}">
  <table><tbody data-directory-privacy-rows></tbody></table>
  <p data-directory-privacy-status role="status"></p>
  <input data-directory-privacy-path><input data-directory-privacy-prompt>
  <input data-directory-privacy-username><input type="password" data-directory-privacy-password>
  <button type="button" data-directory-privacy-add>Add</button>
  <button type="button" data-directory-privacy-save>Save</button>
  <div data-directory-privacy-preview-wrap hidden><pre data-directory-privacy-preview></pre></div>
</section>`
const status = () => document.querySelector<HTMLElement>('[data-directory-privacy-status]')!
const rows = () => document.querySelectorAll('[data-directory-privacy-rows] tr')
const save = () => document.querySelector<HTMLButtonElement>('[data-directory-privacy-save]')!
const add = () => document.querySelector<HTMLButtonElement>('[data-directory-privacy-add]')!
const field = (attribute: string, value: string) => { const node = document.querySelector<HTMLInputElement>(`[${attribute}]`)!; node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); return node }

describe('directory privacy boundary helpers', () => {
  it('normalizes canonical folder paths and refuses traversal/control input', () => {
    expect(directoryPrivacyPath('private')).toBe('/private')
    expect(directoryPrivacyPath('/members/area/')).toBe('/members/area')
    expect(directoryPrivacyPath('/a.b-c_d')).toBe('/a.b-c_d')
    for (const value of ['', '/', '../etc', '/a/../b', '/a//b', '/a\nb', '/a; rm', 42, null]) expect(() => directoryPrivacyPath(value as never)).toThrow()
  })
  it('bounds prompt, username and password values', () => {
    expect(directoryPrivacyPrompt('  Private  ')).toBe('Private')
    expect(directoryPrivacyUsername('alice')).toBe('alice')
    expect(directoryPrivacyPassword('correct horse')).toBe('correct horse')
    for (const value of ['', 'x'.repeat(129), 'a\nb']) expect(() => directoryPrivacyPrompt(value)).toThrow()
    for (const value of ['', '../root', 'a b', 'x'.repeat(65)]) expect(() => directoryPrivacyUsername(value)).toThrow()
    for (const value of ['short', 'x'.repeat(1025), 'a\u0000b']) expect(() => directoryPrivacyPassword(value)).toThrow()
  })
  it('validates the public configuration and hides credential material', () => {
    const parsed = directoryPrivacyConfig(snapshot(), username)
    expect(parsed.rules[0]).toEqual({ path: '/private', authName: 'Private area', enabled: true, users: ['alice'] })
    expect(parsed.compiledNginx).toContain('auth_basic')
    const raw = JSON.stringify(parsed)
    expect(raw).not.toMatch(/passwordHash|compiledHtpasswd/)
    for (const bad of [{ config: { rules: 'x' } }, { config: { rules: [{ path: '/a', authName: 'a', enabled: true, users: [{ username: 'a', passwordHash: 'x' }] }] } }, { config: { rules: [{ path: '../a', authName: 'a', enabled: true, users: [] }] } }, null, {}]) expect(() => directoryPrivacyConfig(bad, username)).toThrow()
  })
  it('builds the exact server payload and requires a password for every kept user', () => {
    const draft: DirectoryPrivacyRuleDraft[] = [{ path: 'private', authName: ' Private area ', enabled: true, users: [{ username: 'alice', password: 'correct horse battery', existing: true }] }]
    expect(directoryPrivacyPayload(draft)).toEqual({ rules: [{ path: '/private', authName: 'Private area', enabled: true, users: [{ username: 'alice', password: 'correct horse battery' }] }] })
    expect(() => directoryPrivacyPayload([{ ...draft[0]!, users: [{ username: 'alice', password: '', existing: true }] }])).toThrow('password_required_for_existing_users')
    expect(() => directoryPrivacyPayload([{ path: '/private', authName: 'x', enabled: true, users: [{ username: 'a', password: 'correct horse', existing: false }] }, { path: '/private', authName: 'y', enabled: true, users: [] }])).toThrow('duplicate_directory_path')
    expect(() => directoryPrivacyPayload([{ path: '/private', authName: 'x', enabled: true, users: [{ username: 'a', password: 'correct horse', existing: false }, { username: 'a', password: 'another horse', existing: false }] }])).toThrow('duplicate_directory_user')
  })
  it('uses a current-value signature and draft comparison for stale detection', () => {
    const first = directoryPrivacyConfig(snapshot(), username)
    const second = directoryPrivacyConfig(snapshot({ updatedAt: '2026-10-26T00:00:01.000Z' }), username)
    expect(directoryPrivacySignature(first)).not.toBe(directoryPrivacySignature(second))
    expect(directoryPrivacyDraftMatchesSnapshot(directoryPrivacyDraft(first), first)).toBe(true)
    const changedRules = directoryPrivacyConfig({ config: { ...snapshot().config, rules: [{ path: '/other', authName: 'Other', enabled: true, users: [{ username: 'alice' }] }] } }, username)
    expect(directoryPrivacyDraftMatchesSnapshot(directoryPrivacyDraft(first), changedRules)).toBe(false)
  })
})

describe('directory privacy browser binding', () => {
  beforeEach(() => {
    document.body.innerHTML = root()
    document.documentElement.lang = 'en'
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  })
  const boot = (transport: ReturnType<typeof vi.fn>) => {
    (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
    new Function(`(${DIRECTORY_PRIVACY_CLIENT_BINDING})(undefined);`)()
  }
  const script = (transport: ReturnType<typeof vi.fn>) => {
    const calls: { method: string; path: string; body?: unknown }[] = []
    transport.mockImplementation(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) })
      if (method === 'GET') return snapshot()
      const written = body as { rules: { path: string; authName: string; enabled: boolean; users: { username: string }[] }[] }
      return { config: {
        rules: written.rules.map(rule => ({ path: rule.path, authName: rule.authName, enabled: rule.enabled, users: rule.users.map(user => ({ username: user.username })) })),
        compiledNginx: 'location ^~ /private {\n  auth_basic "Private area";\n}', compiledApache: 'apache', updatedAt: '2026-10-26T00:00:05.000Z',
      } }
    })
    boot(transport)
    return calls
  }

  it('constructs the serialized binding and contains no unavailable transport', () => {
    expect(() => new Function('return ' + DIRECTORY_PRIVACY_CLIENT_BINDING)()).not.toThrow()
    expect(DIRECTORY_PRIVACY_CLIENT_BINDING).toContain('xpanelSessionRequest')
    expect(DIRECTORY_PRIVACY_CLIENT_BINDING).not.toContain('fetch(')
    expect(DIRECTORY_PRIVACY_CLIENT_BINDING).not.toContain('/api/xpanel/')
  })

  it('leaves everything disabled and explicit when there is no transport', () => {
    new Function(`(${DIRECTORY_PRIVACY_CLIENT_BINDING})(undefined);`)()
    expect(status().dataset.state).toBe('unavailable')
    expect(status().textContent).toContain('unavailable')
    for (const node of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) expect(node.disabled).toBe(true)
  })

  it('reads saved rules, then adds and saves the exact validated payload', async () => {
    const transport = vi.fn(); const calls = script(transport)
    await tick()
    expect(calls[0]).toMatchObject({ method: 'GET', path: `/api/web-features/${username}/directory-privacy` })
    expect(rows().length).toBe(1)
    expect(rows()[0]!.textContent).toContain('/private')
    expect(status().dataset.state).toBe('read')
    field('data-directory-privacy-path', 'members')
    field('data-directory-privacy-prompt', 'Members')
    field('data-directory-privacy-username', 'bob')
    field('data-directory-privacy-password', 'another horse battery')
    add().click()
    expect(rows().length).toBe(2)
    save().click()
    await tick()
    expect(status().dataset.state).toBe('failed')
    expect(calls.some(call => call.method === 'PUT')).toBe(false)
    field('data-directory-privacy-user-password="alice"', 'correct horse battery')
    save().click(); await tick(); await tick()
    const put = calls.find(call => call.method === 'PUT')
    expect(put?.body).toEqual({ rules: [
      { path: '/private', authName: 'Private area', enabled: true, users: [{ username: 'alice', password: 'correct horse battery' }] },
      { path: '/members', authName: 'Members', enabled: true, users: [{ username: 'bob', password: 'another horse battery' }] },
    ] })
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelector<HTMLElement>('[data-directory-privacy-preview]')!.textContent).toContain('auth_basic')
  })

  it('keeps the draft and reports stale when the saved rules changed before the write', async () => {
    const transport = vi.fn()
    const calls: { method: string; path: string; body?: unknown }[] = []
    let reads = 0
    transport.mockImplementation(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) })
      if (method === 'GET') { reads++; return reads === 1 ? snapshot() : snapshot({ updatedAt: '2026-10-26T00:00:02.000Z' }) }
      return snapshot()
    })
    boot(transport); await tick()
    field('data-directory-privacy-user-password="alice"', 'correct horse battery')
    save().click(); await tick()
    expect(status().dataset.state).toBe('stale')
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0)
    expect(rows().length).toBe(1)
  })

  it('locks further writes after an uncertain outcome', async () => {
    const transport = vi.fn()
    let reads = 0
    transport.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET') { reads++; return snapshot() }
      throw { status: 503, details: { verificationRequired: true } }
    })
    boot(transport); await tick()
    field('data-directory-privacy-user-password="alice"', 'correct horse battery')
    save().click(); await tick(); await tick()
    expect(status().dataset.state).toBe('uncertain')
    expect(save().disabled).toBe(true)
    save().click(); await tick()
    expect(reads).toBe(2)
  })
})
