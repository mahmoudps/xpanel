import { directoryPrivacyClientTemplates } from './board-port/directory-privacy-client-templates.ts'
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DIRECTORY_PRIVACY_CLIENT_BINDING, directoryPrivacyChanges, directoryPrivacyConfig, directoryPrivacyDraft,
  directoryPrivacyPassword, directoryPrivacyPath, directoryPrivacyPreview, directoryPrivacyPrompt, directoryPrivacySignature,
  directoryPrivacyUsername, type DirectoryPrivacyRuleDraft,
} from './directory-privacy-client.ts'

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const username = 'dirpriva'
const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64), R3 = 'c'.repeat(64)
const directives = ['AuthType Basic', 'AuthName "Private area"', 'AuthUserFile "/home/dirpriva/.htpasswds/public_html/private/passwd"', 'Require valid-user']
const folder = (patch: Record<string, unknown> = {}) => ({ path: 'public_html/private', enabled: true, authName: 'Private area', users: ['alice'], revision: R1, conflict: null, directives, url: { domain: 'dirpriva.example.test', path: '/private/' }, ...patch })
const view = (directories: unknown[] = [folder()], application: Record<string, unknown> = { status: 'read', httpStatus: null, protectionVerified: null }) => ({
  context: { accountId: '11111111-1111-4111-8111-111111111111', username }, roots: [{ domain: 'dirpriva.example.test', path: 'public_html' }],
  capabilities: { canSave: true, reason: null }, directories, application: { nativeQualified: false, ...application },
})
const root = () => `<section data-directory-privacy data-account-username="${username}">
  <table><tbody data-directory-privacy-rows></tbody></table>
  <p data-directory-privacy-status role="status"></p>
  <input data-directory-privacy-path><input data-directory-privacy-prompt>
  <input data-directory-privacy-username><input type="password" data-directory-privacy-password>
  <button type="button" data-directory-privacy-add>Add</button>
  <button type="button" data-directory-privacy-save>Save</button>
  <div data-directory-privacy-preview-wrap hidden><pre data-directory-privacy-preview></pre></div>
${directoryPrivacyClientTemplates()}</section>`
const status = () => document.querySelector<HTMLElement>('[data-directory-privacy-status]')!
const rows = () => document.querySelectorAll('[data-directory-privacy-rows] tr')
const save = () => document.querySelector<HTMLButtonElement>('[data-directory-privacy-save]')!
const add = () => document.querySelector<HTMLButtonElement>('[data-directory-privacy-add]')!
const field = (attribute: string, value: string) => { const node = document.querySelector<HTMLInputElement>(`[${attribute}]`)!; node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); return node }

describe('directory privacy boundary helpers', () => {
  it('normalizes account-relative folder paths and refuses traversal, hidden roots and control input', () => {
    expect(directoryPrivacyPath('public_html/private')).toBe('public_html/private')
    expect(directoryPrivacyPath('/public_html/members/area/')).toBe('public_html/members/area')
    expect(directoryPrivacyPath('public_html/.private')).toBe('public_html/.private')
    for (const value of ['', '/', '../etc', 'a/../b', 'a//b', 'a\nb', 'a; rm', '.htpasswds/x', '.ssh', 42, null]) expect(() => directoryPrivacyPath(value as never)).toThrow()
  })
  it('bounds prompt, username and password values', () => {
    expect(directoryPrivacyPrompt('  Private  ')).toBe('Private')
    expect(directoryPrivacyUsername('alice')).toBe('alice')
    expect(directoryPrivacyPassword('correct horse')).toBe('correct horse')
    for (const value of ['', 'x'.repeat(129), 'a\nb', 'a"b', 'a\\b']) expect(() => directoryPrivacyPrompt(value)).toThrow()
    for (const value of ['', '../root', 'a b', 'x'.repeat(65)]) expect(() => directoryPrivacyUsername(value)).toThrow()
    for (const value of ['short', 'x'.repeat(1025), 'a\u0000b']) expect(() => directoryPrivacyPassword(value)).toThrow()
  })
  it('validates the agent-backed reply and never accepts credential material', () => {
    const parsed = directoryPrivacyConfig(view(), username)
    expect(parsed.folders[0]).toMatchObject({ path: 'public_html/private', authName: 'Private area', enabled: true, users: ['alice'], revision: R1, conflict: null })
    expect(directoryPrivacyPreview(parsed)).toBe('# public_html/private/.htaccess\n' + directives.join('\n'))
    for (const bad of [view([folder({ users: [{ username: 'a', passwordHash: 'x' }] })]), view([folder({ path: '../a' })]), view([folder({ revision: 'x' })]), { ...view(), context: { username: 'other' } }, null, {}]) expect(() => directoryPrivacyConfig(bad, username)).toThrow()
  })
  it('sends one change per changed folder; existing users without a new password keep theirs', () => {
    const snapshot = directoryPrivacyConfig(view([folder(), folder({ path: 'public_html/old', revision: R2, users: ['carol'] })]), username)
    const draft: DirectoryPrivacyRuleDraft[] = [
      { path: 'public_html/private', authName: 'Private area', enabled: true, users: [{ username: 'alice', password: '', existing: true }, { username: 'bob', password: 'another horse', existing: false }] },
      { path: 'public_html/new', authName: 'New', enabled: true, users: [{ username: 'dave', password: 'correct horse', existing: false }] },
    ]
    expect(directoryPrivacyChanges(draft, snapshot)).toEqual([
      { path: 'public_html/private', revision: R1, body: { path: 'public_html/private', enabled: true, authName: 'Private area', users: [{ username: 'alice' }, { username: 'bob', password: 'another horse' }] } },
      { path: 'public_html/new', revision: null, body: { path: 'public_html/new', enabled: true, authName: 'New', users: [{ username: 'dave', password: 'correct horse' }] } },
      { path: 'public_html/old', revision: R2, body: { path: 'public_html/old', enabled: false, authName: '', users: [] } },
    ])
    expect(directoryPrivacyChanges(directoryPrivacyDraft(snapshot), snapshot)).toEqual([])
    expect(() => directoryPrivacyChanges([{ ...draft[1]!, users: [{ username: 'dave', password: '', existing: false }] }], snapshot)).toThrow('password_required_for_new_users')
    expect(() => directoryPrivacyChanges([draft[1]!, draft[1]!], snapshot)).toThrow('duplicate_directory_path')
    expect(() => directoryPrivacyChanges([{ ...draft[1]!, users: [...draft[1]!.users, ...draft[1]!.users] }], snapshot)).toThrow('duplicate_directory_user')
  })
  it('uses folder revisions for stale detection', () => {
    expect(directoryPrivacySignature(directoryPrivacyConfig(view(), username))).not.toBe(directoryPrivacySignature(directoryPrivacyConfig(view([folder({ revision: R3 })]), username)))
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

  it('constructs the serialized binding and contains no unavailable transport', () => {
    expect(() => new Function('return ' + DIRECTORY_PRIVACY_CLIENT_BINDING)()).not.toThrow()
    expect(DIRECTORY_PRIVACY_CLIENT_BINDING).toContain('xpanelSessionRequest')
    expect(DIRECTORY_PRIVACY_CLIENT_BINDING).not.toContain('fetch(')
  })

  it('leaves everything disabled and explicit when there is no transport', () => {
    new Function(`(${DIRECTORY_PRIVACY_CLIENT_BINDING})(undefined);`)()
    expect(status().dataset.state).toBe('unavailable')
    for (const node of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) expect(node.disabled).toBe(true)
  })

  it('reads folders, adds a new one with its own revision and reports the verified 401', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = []
    let saved = false
    const transport = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) })
      if (method === 'GET' && path.endsWith('?path=public_html%2Fmembers')) return view([folder({ path: 'public_html/members', enabled: false, authName: '', users: [], revision: R2, directives: [] })])
      if (method === 'GET') return view(saved ? [folder(), folder({ path: 'public_html/members', authName: 'Members', users: ['bob'], revision: R3 })] : [folder()])
      saved = true
      return view([folder({ path: 'public_html/members', authName: 'Members', users: ['bob'], revision: R3 })], { status: 'saved', httpStatus: 401, protectionVerified: true })
    })
    boot(transport); await tick()
    expect(calls[0]).toMatchObject({ method: 'GET', path: `/api/web-features/${username}/directory-privacy` })
    expect(rows().length).toBe(1)
    expect(status().dataset.state).toBe('read')
    expect(document.querySelector<HTMLElement>('[data-directory-privacy-preview]')!.textContent).toContain('Require valid-user')
    field('data-directory-privacy-path', 'public_html/members')
    field('data-directory-privacy-prompt', 'Members')
    field('data-directory-privacy-username', 'bob')
    field('data-directory-privacy-password', 'another horse battery')
    add().click()
    expect(rows().length).toBe(2)
    save().click(); await tick()
    const put = calls.filter(call => call.method === 'PUT')
    expect(put).toEqual([{ method: 'PUT', path: `/api/web-features/${username}/directory-privacy`, body: { path: 'public_html/members', enabled: true, authName: 'Members', users: [{ username: 'bob', password: 'another horse battery' }], expectedRevision: R2 } }])
    expect(status().dataset.state).toBe('saved')
    expect(status().textContent).toContain('asks for a password')
    expect(rows().length).toBe(2)
  })

  it('reports a save the web server did not enforce instead of claiming protection', async () => {
    const transport = vi.fn(async (method: string) => method === 'GET' ? view() : view([folder({ authName: 'Renamed' })], { status: 'saved', httpStatus: 200, protectionVerified: false }))
    boot(transport); await tick()
    field('data-directory-privacy-user-password="alice"', 'fresh correct horse')
    save().click(); await tick()
    expect(status().dataset.state).toBe('saved')
    expect(status().textContent).toContain('did not ask for a password')
  })

  it('keeps the draft and reports stale when a folder changed before the write', async () => {
    let reads = 0
    const transport = vi.fn(async (method: string) => { if (method === 'GET') { reads++; return reads === 1 ? view() : view([folder({ revision: R3 })]) } return view() })
    boot(transport); await tick()
    field('data-directory-privacy-user-password="alice"', 'correct horse battery')
    save().click(); await tick()
    expect(status().dataset.state).toBe('stale')
    expect(transport.mock.calls.filter(call => call[0] === 'PUT')).toHaveLength(0)
  })

  it('locks further writes after an uncertain outcome', async () => {
    let reads = 0
    const transport = vi.fn(async (method: string) => { if (method === 'GET') { reads++; return view() } throw { status: 503, details: { verificationRequired: true } } })
    boot(transport); await tick()
    field('data-directory-privacy-user-password="alice"', 'correct horse battery')
    save().click(); await tick()
    expect(status().dataset.state).toBe('uncertain')
    expect(save().disabled).toBe(true)
    save().click(); await tick()
    expect(reads).toBe(2)
  })

  it('keeps conflicting folders read-only', async () => {
    boot(vi.fn(async () => view([folder({ conflict: { code: 'access_rules_present', line: 3 }, enabled: false, directives: [] })]))); await tick()
    expect(status().textContent).toContain('Review their .htaccess')
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-directory-privacy-rule] input,[data-directory-privacy-rule] button')) expect(control.disabled).toBe(true)
    expect(save().disabled).toBe(false)
  })
})
