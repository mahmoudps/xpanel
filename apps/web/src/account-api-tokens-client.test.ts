// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApprovedXpanelWorkspace } from './board-port/approved-xpanel-workspaces.ts'
import { renderV2AccountSecurityPage } from './themes/v2/pages/xpanel/security/account.ts'
import { ACCOUNT_API_TOKENS_CLIENT_BINDING } from './account-api-tokens-client.ts'
import type { AccountApiTokenView } from './account-api-tokens-client.ts'

const BASE = '/api/auth/api-tokens'
const firstId = '00000000-0000-4000-8000-000000000001', secondId = '00000000-0000-4000-8000-000000000002'
const authPersonal = { state: 'ready' as const, canChangePassword: true, canReadSessions: true, canRevokeSessions: true, canReadApiTokens: true, canManageApiTokens: true }
const states = [['classic', 'en'], ['classic', 'ar'], ['v2', 'en'], ['v2', 'ar']] as const
type Theme = 'classic' | 'v2'
type Locale = 'en' | 'ar'
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
const token = (id = firstId, name = 'owner_sync'): AccountApiTokenView => ({ id, name, scopes: ['files:read'], allowedIps: [], createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', lastUsedAt: null, lastUsedIp: null, revokedAt: null, state: 'active' })
const list = (tokens: AccountApiTokenView[]) => ({ tokens: structuredClone(tokens), usageRecorded: true })
const renderedMarkupCache = new Map<string, HTMLDivElement>()
const runAccountApiTokensBinding = new Function('window', 'document', 'xpT', 'askDialog', '(' + ACCOUNT_API_TOKENS_CLIENT_BINDING + ')(askDialog);') as (
  win: Window & typeof globalThis,
  doc: Document,
  xpT: (message: string) => string,
  ask: (options: Record<string, unknown>) => Promise<unknown>,
) => void
function markup(theme: Theme, locale: Locale): HTMLElement {
  const key = `${theme}:${locale}`
  let holder = renderedMarkupCache.get(key)
  if (!holder) {
    const html = theme === 'classic'
      ? renderApprovedXpanelWorkspace({ route: '/security/account', locale, readOnly: true, authPersonal })
      : renderV2AccountSecurityPage({ locale, activeRoute: '/security/account', authPersonal }, { presentation: 'read-only', canRead: false, canManage: false })
    if (typeof html !== 'string') throw new Error('actual_theme_security_page_missing')
    holder = document.createElement('div')
    holder.innerHTML = html
    renderedMarkupCache.set(key, holder)
  }
  document.body.replaceChildren(...Array.from(holder.childNodes, node => node.cloneNode(true)))
  const roots = document.querySelectorAll<HTMLElement>('[data-account-api-tokens]')
  if (roots.length !== 1 || !roots[0]) throw new Error('actual_theme_token_root_missing_or_ambiguous')
  return roots[0]
}
function field(root: HTMLElement, name: string): HTMLElement {
  const node = root.querySelector<HTMLElement>('[data-account-tokens-' + name + ']')
  if (!node) throw new Error('actual_theme_token_field_missing:' + name)
  return node
}
function input(root: HTMLElement, name: string): HTMLInputElement { const node = field(root, name); if (!(node instanceof HTMLInputElement)) throw new Error('actual_theme_input_type'); return node }
function click(root: HTMLElement, name: string): void { const node = field(root, name); if (!(node instanceof HTMLButtonElement)) throw new Error('actual_theme_button_type'); node.click() }
function begin(transport: Transport, askDialog: (options: Record<string, unknown>) => Promise<unknown> = async () => true, translate: (message: string) => string = message => message) {
  const request = vi.fn(transport)
  const ask = vi.fn(askDialog)
  Reflect.set(window, 'xpanelSessionRequest', request)
  // Exercise the same serialized binding installed by the shared host assembly, not a direct imported binder.
  runAccountApiTokensBinding(window, document, translate, ask)
  return { request, ask }
}
const read = async (root: HTMLElement): Promise<void> => { await vi.waitFor(() => expect(field(root, 'status').dataset.state).toBe('read'), { timeout: 2000, interval: 5 }) }
const settled = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function fill(root: HTMLElement): void {
  input(root, 'name').value = 'owner_sync'
  const expiry = field(root, 'expiry'); if (!(expiry instanceof HTMLSelectElement)) throw new Error('actual_theme_expiry_type'); expiry.value = '90'
  const scope = root.querySelector('[data-account-tokens-scope][value="files:read"]')
  if (!(scope instanceof HTMLInputElement)) throw new Error('actual_theme_scope_type')
  scope.checked = true
}
function submit(root: HTMLElement): void { const form = field(root, 'create'); if (!(form instanceof HTMLFormElement)) throw new Error('actual_theme_form_type'); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }
function prototype(root: HTMLElement, name: string): HTMLTemplateElement { const node = root.querySelector('template[data-xp-template="' + name + '"]'); if (!(node instanceof HTMLTemplateElement)) throw new Error('actual_theme_prototype_missing'); return node }
function corrupt(root: HTMLElement, kind: string): void {
  const row = prototype(root, 'account-token-row')
  if (kind === 'missing') row.remove()
  else if (kind === 'duplicate') root.append(row.cloneNode(true))
  else if (kind === 'wrong-root') row.innerHTML = '<div></div>'
  else if (kind === 'wrong-slot-tag') { const slot = row.content.querySelector('[data-xp-slot="name"]'); if (!slot) throw new Error('row_name_missing'); slot.replaceWith(document.createElement('span')) }
  else if (kind === 'wrong-button') { const button = prototype(root, 'account-token-revoke').content.querySelector('button'); if (!(button instanceof HTMLButtonElement)) throw new Error('revoke_button_missing'); button.type = 'submit' }
  else if (kind === 'foreign-owner') { const foreign = document.createElement('section'); foreign.setAttribute('data-account-api-tokens', ''); root.append(foreign); foreign.append(row) }
  else if (kind === 'missing-control') field(root, 'status').remove()
  else throw new Error('unknown_fixture_corruption')
}

afterEach(() => { vi.restoreAllMocks(); Reflect.deleteProperty(window, 'xpanelSessionRequest'); document.body.replaceChildren() })

describe.each(states)('owner API tokens serialized %s %s', (theme, locale) => {
  it('reads actual theme metadata in a native-unavailable document without issuing a token', async () => {
    const root = markup(theme, locale), observed = token()
    const { request } = begin(async (method, path) => { if (method !== 'GET' || path !== BASE) throw new Error('unexpected_effect'); return list([observed]) })
    await read(root)
    expect(request.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', BASE]])
    expect(field(root, 'rows').textContent?.includes(observed.name)).toBe(true)
    expect(field(root, 'reveal').hidden).toBe(true)
    const rename = field(root, 'rows').querySelector('[data-xp-action="rename"]')
    expect(rename instanceof HTMLButtonElement && !rename.disabled).toBe(true)
  })
  it('does not turn an unread list into zero before the actual GET completes', async () => {
    const root = markup(theme, locale)
    let finish: ((reply: unknown) => void) | undefined
    begin(async () => new Promise(resolve => { finish = resolve }))
    const count = root.querySelector('[data-account-tokens-count]')
    expect(count?.textContent?.trim() === '0').toBe(false)
    if (!finish) throw new Error('metadata_read_not_started')
    finish(list([])); await read(root)
    expect(field(root, 'empty').hidden).toBe(false)
  })
  it('shows existing owned SDK metadata without offering its legacy scopes for issuance', async () => {
    const root = markup(theme, locale), legacy = { ...token(), name: 'Existing owner automation', scopes: ['accounts:read'] }
    begin(async () => list([legacy])); await read(root)
    expect(field(root, 'rows').textContent?.includes(legacy.name)).toBe(true)
    expect(field(root, 'rows').textContent?.includes('accounts:read')).toBe(true)
    expect(root.querySelector('[data-account-tokens-scope][value="accounts:read"]')).toBeNull()
  })
  it.each(['denied', 'unavailable', 'missing'])('makes zero requests for %s personal authority', async state => {
    const root = markup(theme, locale)
    if (state === 'missing') root.removeAttribute('data-auth-personal-state'); else root.dataset.authPersonalState = state
    const { request } = begin(async () => { throw new Error('must_not_request') })
    fill(root); submit(root); await settled()
    expect(request.mock.calls.length).toBe(0)
    expect([...root.querySelectorAll('input,select,textarea,button')].filter(node => node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement || node instanceof HTMLButtonElement).every(node => node.disabled)).toBe(true)
  })
  it.each(['missing', 'duplicate', 'wrong-root', 'wrong-slot-tag', 'wrong-button', 'foreign-owner', 'missing-control'])('refuses %s before its first transport', async kind => {
    const root = markup(theme, locale); corrupt(root, kind)
    const { request } = begin(async () => { throw new Error('must_not_request') })
    await settled(); expect(request.mock.calls.length).toBe(0)
    expect(root.textContent?.includes('owner_sync')).toBe(false)
  })
  it('rechecks authority and template integrity after a delayed read', async () => {
    const root = markup(theme, locale)
    let finish: ((reply: unknown) => void) | undefined
    const { request } = begin(async () => new Promise(resolve => { finish = resolve }))
    root.dataset.tokensCanRead = 'false'; corrupt(root, 'duplicate')
    if (!finish) throw new Error('metadata_read_not_started')
    finish(list([token()])); await settled()
    expect(field(root, 'rows').textContent?.includes('owner_sync')).toBe(false)
    expect(request.mock.calls.length).toBe(1)
  })
  it.each(['done', 'pagehide', 'visibility-hidden'] as const)('creates only after current admission, verifies readback and erases its one-time secret on %s', async boundary => {
    const root = markup(theme, locale), created = token(), secret = 'xp_' + 'Q'.repeat(43), snapshot: AccountApiTokenView[] = []
    const storage = vi.spyOn(Storage.prototype, 'setItem'), log = vi.spyOn(console, 'log')
    const { request } = begin(async (method, path, body) => {
      if (method === 'GET' && path === BASE) return list(snapshot)
      if (method === 'POST' && path === BASE) { expect(body).toEqual({ name: 'owner_sync', scopes: ['files:read'], expiresInDays: 90, allowedIps: [], readOnly: false }); snapshot.push(created); return { token: structuredClone(created), secret } }
      throw new Error('unexpected_effect')
    })
    await read(root); fill(root)
    const readOnly = input(root, 'read-only')
    expect(readOnly.disabled).toBe(false)
    if (readOnly.checked) readOnly.click()
    expect(readOnly.checked).toBe(false)
    submit(root)
    await vi.waitFor(() => expect(field(root, 'reveal').hidden).toBe(false), { timeout: 2000, interval: 5 })
    expect(field(root, 'secret').textContent === secret).toBe(true)
    expect(storage.mock.calls.length === 0 && log.mock.calls.length === 0).toBe(true)
    expect(request.mock.calls.filter(call => call[0] === 'POST').length).toBe(1)
    if (boundary === 'done') click(root, 'done')
    else if (boundary === 'pagehide') window.dispatchEvent(new Event('pagehide'))
    else { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) }
    expect(field(root, 'secret').textContent).toBe('')
    click(root, 'refresh'); await read(root)
    expect(field(root, 'secret').textContent).toBe('')
    expect(field(root, 'rows').textContent?.includes(secret)).toBe(false)
  })
  it('retains unknown-outcome truth and never shows an unverified creation secret', async () => {
    const root = markup(theme, locale), created = token(), secret = 'xp_' + 'R'.repeat(43), snapshot: AccountApiTokenView[] = []
    let reads = 0
    const { request } = begin(async (method, path) => {
      if (method === 'GET') { reads++; return reads === 2 || reads === 3 ? { tokens: 'invalid', usageRecorded: true } : list(snapshot) }
      if (method === 'POST' && path === BASE) { snapshot.push(created); return { token: structuredClone(created), secret } }
      if (method === 'POST' && path === BASE + '/' + created.id + '/revoke') { created.state = 'revoked'; created.revokedAt = '2026-10-31T00:00:00.000Z'; return { token: structuredClone(created) } }
      throw new Error('unexpected_effect')
    })
    await read(root); fill(root); submit(root)
    await vi.waitFor(() => expect(field(root, 'mutation-status').dataset.state).toBe('failed'), { timeout: 2000, interval: 5 })
    expect(field(root, 'secret').textContent).toBe('')
    expect(field(root, 'mutation-status').textContent?.includes('may be saved')).toBe(true)
    expect(request.mock.calls.filter(call => call[0] === 'POST').length).toBe(1)
    const submitButton = field(root, 'submit'), refreshButton = field(root, 'refresh')
    if (!(submitButton instanceof HTMLButtonElement) || !(refreshButton instanceof HTMLButtonElement)) throw new Error('actual_theme_button_type')
    expect(submitButton.disabled).toBe(true); expect(refreshButton.disabled).toBe(false)
    fill(root); submit(root); await settled()
    expect(request.mock.calls.filter(call => call[0] === 'POST').length).toBe(1)
    click(root, 'refresh')
    await vi.waitFor(() => expect(field(root, 'status').dataset.state).toBe('failed'), { timeout: 2000, interval: 5 })
    expect(reads).toBe(3); expect(submitButton.disabled).toBe(true)
    click(root, 'refresh'); await read(root)
    expect(reads).toBe(4); expect(submitButton.disabled).toBe(false)
    expect(field(root, 'secret').textContent).toBe('')
    const revoke = field(root, 'rows').querySelector('[data-xp-action="revoke"]')
    if (!(revoke instanceof HTMLButtonElement)) throw new Error('reconciled_revoke_action_missing')
    revoke.click()
    await vi.waitFor(() => expect(field(root, 'mutation-status').dataset.state).toBe('read'), { timeout: 2000, interval: 5 })
    expect(request.mock.calls.filter(call => call[0] === 'POST' && call[1] === BASE).length).toBe(1)
    expect(created.state).toBe('revoked')
  })
  it('does not mutate when management or templates change during confirmation', async () => {
    const root = markup(theme, locale)
    let confirm: ((answer: unknown) => void) | undefined
    const ask = vi.fn(async () => new Promise(resolve => { confirm = resolve }))
    const { request } = begin(async () => list([token()]), ask)
    await read(root)
    const revoke = field(root, 'rows').querySelector('[data-xp-action="revoke"]'); if (!(revoke instanceof HTMLButtonElement)) throw new Error('revoke_action_missing')
    revoke.click(); root.dataset.tokensCanManage = 'false'
    if (!confirm) throw new Error('confirmation_not_started')
    confirm(true); await settled()
    expect(request.mock.calls.filter(call => call[0] !== 'GET').length).toBe(0)
  })
  it('renames through the existing prompt and verifies the same record in the fresh list', async () => {
    const root = markup(theme, locale), observed = token()
    const { request, ask } = begin(async (method, path, body) => {
      if (method === 'GET') return list([observed])
      expect(method).toBe('PATCH'); expect(path).toBe(BASE + '/' + observed.id); expect(body).toEqual({ name: 'renamed_owner' })
      observed.name = 'renamed_owner'; return { token: structuredClone(observed) }
    }, vi.fn(async () => 'renamed_owner'))
    await read(root)
    const rename = field(root, 'rows').querySelector('[data-xp-action="rename"]'); if (!(rename instanceof HTMLButtonElement)) throw new Error('rename_action_missing')
    rename.click()
    await vi.waitFor(() => expect(field(root, 'mutation-status').dataset.state).toBe('read'), { timeout: 2000, interval: 5 })
    expect(ask.mock.calls.length).toBe(1)
    expect(request.mock.calls.filter(call => call[0] === 'PATCH').length).toBe(1)
    expect(field(root, 'rows').textContent?.includes('renamed_owner')).toBe(true)
  })
  it('revokes selected owned rows only after confirmation and fresh readback', async () => {
    const root = markup(theme, locale), snapshot = [token(), token(secondId, 'other_owner_token')]
    const { request } = begin(async (method, path, body) => {
      if (method === 'GET') return list(snapshot)
      expect(method).toBe('POST'); expect(path).toBe(BASE + '/revoke'); expect(body).toEqual({ ids: [firstId, secondId] })
      for (const observed of snapshot) { observed.state = 'revoked'; observed.revokedAt = '2026-10-31T00:00:00.000Z' }
      return { tokens: structuredClone(snapshot) }
    })
    await read(root); input(root, 'select-all').click(); click(root, 'bulk-revoke')
    await vi.waitFor(() => expect(field(root, 'mutation-status').dataset.state).toBe('read'), { timeout: 2000, interval: 5 })
    expect(request.mock.calls.filter(call => call[0] === 'POST').length).toBe(1)
    expect(field(root, 'secret').textContent).toBe('')
  })
  it('caps bulk selection at 50 expired records without hiding the remaining metadata', { tags: ['slow'] }, async () => {
    const root = markup(theme, locale), snapshot: AccountApiTokenView[] = Array.from({ length: 51 }, (_, index) => ({ ...token('00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'), 'old_' + index), createdAt: '2025-10-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z', state: 'expired' }))
    const { request } = begin(async (method, path, body) => {
      if (method === 'GET') return list(snapshot)
      if (!body || typeof body !== 'object' || !('ids' in body) || !Array.isArray(body.ids)) throw new Error('invalid_bulk_fixture')
      const ids = body.ids
      expect(path).toBe(BASE + '/revoke'); expect(ids.length).toBe(50)
      const changed = snapshot.filter(row => ids.includes(row.id))
      for (const row of changed) { row.state = 'revoked'; row.revokedAt = '2026-10-31T00:00:00.000Z' }
      return { tokens: structuredClone(changed) }
    })
    await read(root); input(root, 'select-all').click()
    const selected = [...field(root, 'rows').querySelectorAll('[data-xp-slot="select"]')].filter((node): node is HTMLInputElement => node instanceof HTMLInputElement)
    expect(selected.length).toBe(51); expect(selected.filter(node => node.checked).length).toBe(50)
    click(root, 'bulk-revoke')
    await vi.waitFor(() => expect(field(root, 'mutation-status').dataset.state).toBe('read'), { timeout: 2000, interval: 5 })
    expect(request.mock.calls.filter(call => call[0] === 'POST').length).toBe(1)
    expect(snapshot.filter(row => row.state === 'expired').length).toBe(1)
  })
  it('refuses read authority revoked while building token metadata before attaching rows', async () => {
    const root = markup(theme, locale)
    const observed: AccountApiTokenView = { ...token(), createdAt: '2025-10-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z', state: 'expired' }
    const { request } = begin(async (method, path) => {
      if (method !== 'GET' || path !== BASE) throw new Error('unexpected_effect')
      return list([observed])
    }, async () => true, message => {
      if (message === 'Expired') root.dataset.authPersonalState = 'denied'
      return message
    })
    await vi.waitFor(() => expect(field(root, 'status').dataset.state).toBe('failed'), { timeout: 2000, interval: 5 })
    expect(field(root, 'rows').children).toHaveLength(0)
    expect(request.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', BASE]])
    expect(input(root, 'select-all').disabled).toBe(true)
    const bulk = field(root, 'bulk-revoke')
    expect(bulk instanceof HTMLButtonElement && bulk.disabled).toBe(true)
    expect(field(root, 'secret').textContent).toBe('')
    expect(field(root, 'reveal').hidden).toBe(true)
  })
  it('refuses a revoked management context after the create reply and before showing its secret', async () => {
    const root = markup(theme, locale), secret = 'xp_' + 'S'.repeat(43)
    let finish: ((reply: unknown) => void) | undefined
    const { request } = begin(async method => method === 'GET' ? list([]) : new Promise(resolve => { finish = resolve }))
    await read(root); fill(root); submit(root)
    if (!finish) throw new Error('creation_not_started')
    root.dataset.authPersonalState = 'denied'; finish({ token: token(), secret }); await settled()
    expect(field(root, 'secret').textContent).toBe('')
    expect(field(root, 'reveal').hidden).toBe(true)
    expect(request.mock.calls.filter(call => call[0] === 'POST').length).toBe(1)
  })
})
