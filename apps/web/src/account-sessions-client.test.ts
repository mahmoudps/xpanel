// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderConnectedPanelSessions } from './board-port/approved-xpanel-bindings.ts'
import type { AuthPersonalView } from './themes/contract.ts'
import {
  ACCOUNT_SESSIONS_CLIENT_BINDING, readSession, readSessions,
} from './account-sessions-client.ts'

const readySessions: AuthPersonalView = Object.freeze({ state: 'ready', canChangePassword: false,
  canReadSessions: true, canRevokeSessions: true, canReadApiTokens: false, canManageApiTokens: false })
const renderSessions = (locale: 'en' | 'ar' = 'en'): string => {
  const html = renderConnectedPanelSessions({ generationId: 0, route: '/security/account', locale, readOnly: false, authPersonal: readySessions })
  if (html === undefined) throw new Error('sessions_fixture_renderer_missing')
  return html
}

const now = '2026-01-01T00:00:00.000Z'
const currentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const record = (patch: Record<string, unknown> = {}) => ({
  id: currentId, current: true, ip: '192.0.2.10', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
  mfaVerified: false, createdAt: now, lastSeenAt: now, expiresAt: '2026-01-02T00:00:00.000Z', ...patch,
})
const list = (sessions: unknown[] = [record(), record({ id: otherId, current: false, ip: '198.51.100.7', userAgent: null, mfaVerified: true })]) => ({ sessions, currentSessionId: currentId })
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const status = () => document.querySelector<HTMLElement>('[data-sessions-status]')!
const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!

describe('session helpers', () => {
  it('validates session rows and single-current invariant', () => {
    expect(readSessions(list(), currentId)).toHaveLength(2)
    for (const bad of [
      list([record(), record()]),
      list([record({ id: 'not-a-uuid' })]),
      list([record({ current: 'yes' })]),
      list([record({ userAgent: 5 })]),
      list([record({ expiresAt: 'tomorrow' })]),
      null,
    ]) expect(() => readSessions(bad, currentId)).toThrow()
    expect(() => readSession(record({ mfaVerified: 'no' }))).toThrow()
  })
})

describe('sessions browser binding', () => {
  beforeEach(() => {
    document.body.innerHTML = renderSessions()
    document.documentElement.lang = 'en'
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  })
  const boot = (transport: ReturnType<typeof vi.fn>, askDialog: (options: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve(true)) => {
    (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
    new Function('askDialog', '(' + ACCOUNT_SESSIONS_CLIENT_BINDING + ')(askDialog);')(askDialog)
  }
  it('renders the section without forms or fetch and constructs the binding', async () => {
    expect(() => new Function('return ' + ACCOUNT_SESSIONS_CLIENT_BINDING)()).not.toThrow()
    expect(ACCOUNT_SESSIONS_CLIENT_BINDING).not.toContain('fetch(')
    expect(document.querySelector('[data-account-sessions]')).not.toBeNull()
    expect(document.querySelectorAll('form')).toHaveLength(0)
    // The controller still supports legacy slot-only callers, not an implicit grant from a missing AuthPersonalView.
    const legacy = document.querySelector<HTMLElement>('[data-account-sessions]')
    if (!legacy) throw new Error('legacy_sessions_fixture_missing')
    legacy.removeAttribute('data-sessions-can-read'); legacy.removeAttribute('data-sessions-can-revoke')
    let current = list()
    const transport = vi.fn(async (method: string) => {
      if (method === 'GET') return current
      if (method === 'POST') { current = list([record()]); return { ok: true, revokedCount: 1 } }
      throw new Error('unexpected_legacy_request')
    })
    boot(transport); await tick()
    expect(transport).toHaveBeenCalledExactlyOnceWith('GET', '/api/auth/sessions', undefined)
    button('[data-sessions-revoke-others]').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('saved'); expect(document.querySelectorAll('[data-session-id]')).toHaveLength(1)
    expect(transport).toHaveBeenCalledTimes(3)
    document.body.innerHTML = renderSessions()
    const denied = document.querySelector<HTMLElement>('[data-account-sessions]')
    if (!denied) throw new Error('legacy_denied_fixture_missing')
    denied.removeAttribute('data-sessions-can-read'); denied.removeAttribute('data-sessions-can-revoke'); denied.dataset.readonly = 'true'
    const noRequest = vi.fn(async () => list()); boot(noRequest); await tick()
    expect(noRequest).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
  })
  it('disables controls with an explicit unavailable state without a transport', () => {
    new Function(`(${ACCOUNT_SESSIONS_CLIENT_BINDING})(undefined);`)()
    expect(status().dataset.state).toBe('unavailable')
    expect(button('[data-sessions-revoke-others]').disabled).toBe(true)
  })
  it.each(['en', 'ar'] as const)('renders human session timestamps in %s without changing raw session data', async locale => {
    document.body.innerHTML = renderSessions(locale)
    document.documentElement.lang = locale
    const lastSeenAt = '2026-10-27T10:11:12.123456Z', expiresAt = '2026-11-01T10:00:00.000Z'
    const session = Object.freeze(record({ lastSeenAt, expiresAt }))
    const payload = Object.freeze({ sessions: Object.freeze([session]), currentSessionId: currentId }), rawBefore = JSON.stringify(payload)
    const transport = vi.fn(async (_method: string, _path: string) => payload)
    boot(transport); await tick()
    const article = document.querySelector<HTMLElement>('[data-session-id="' + currentId + '"]')!
    const time = (label: string) => [...article.querySelectorAll('dt')].find(node => node.textContent === label)?.nextElementSibling?.querySelector('bdi[dir="ltr"]')
    expect(time(locale === 'ar' ? 'آخر نشاط' : 'Last active')?.textContent).toBe('2026-10-27 10:11 UTC')
    expect(time(locale === 'ar' ? 'تنتهي' : 'Expires')?.textContent).toBe('2026-11-01 10:00 UTC')
    expect(article.textContent).not.toContain(lastSeenAt)
    expect(article.textContent).not.toContain(expiresAt)
    expect(readSession(session)).toMatchObject({ lastSeenAt, expiresAt })
    expect(JSON.stringify(payload)).toBe(rawBefore)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledWith('GET', '/api/auth/sessions', undefined)
    expect(article.querySelector('[data-session-action="revoke"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('lists sessions with the current flag, revokes another session after confirmation and verifies absence', async () => {
    let sessions = list()
    const calls: { method: string; path: string }[] = []
    const transport = vi.fn(async (method: string, path: string) => {
      calls.push({ method, path })
      if (method === 'GET') return sessions
      if (method === 'DELETE') {
        sessions = list([record()])
        return { ok: true, currentSessionRevoked: false }
      }
      throw new Error('unexpected_request')
    })
    boot(transport); await tick()
    expect(document.querySelectorAll('[data-session-id]')).toHaveLength(2)
    expect(document.querySelector<HTMLElement>('[data-session-id="' + currentId + '"]')!.textContent).toContain('This device')
    ;[...document.querySelectorAll<HTMLButtonElement>('[data-session-action="revoke"]')][0]!.click(); await tick(); await tick()
    expect(calls.some(call => call.method === 'DELETE' && call.path === '/api/auth/sessions/' + otherId)).toBe(true)
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelectorAll('[data-session-id]')).toHaveLength(1)
  })
  it('signs out other sessions and verifies only the current session remains', async () => {
    let sessions = list([record({ id: otherId, current: false }), record()])
    const transport = vi.fn(async (method: string) => {
      if (method === 'GET') return sessions
      if (method === 'POST') { sessions = list([record()]); return { ok: true, revokedCount: 1 } }
      throw new Error('unexpected_request')
    })
    boot(transport); await tick()
    button('[data-sessions-revoke-others]').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelectorAll('[data-session-id]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-session-action="revoke"]')).toHaveLength(0)
  })
  it('keeps a refused revocation truthful and locks after uncertainty', async () => {
    let mode: 'refused' | 'uncertain' = 'refused'
    const transport = vi.fn(async (method: string) => {
      if (method === 'GET') return list()
      if (mode === 'refused') throw { status: 403, stateChanged: false }
      throw { status: 503, details: { verificationRequired: true } }
    })
    boot(transport); await tick()
    ;[...document.querySelectorAll<HTMLButtonElement>('[data-session-action="revoke"]')][0]!.click(); await tick(); await tick()
    expect(status().dataset.state).toBe('failed')
    mode = 'uncertain'
    button('[data-sessions-revoke-others]').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('uncertain')
    expect(button('[data-sessions-revoke-others]').disabled).toBe(true)
  })

  it('reads explicit personal session authority without enabling revocation', { tags: ['feature'] }, async () => {
    const owner = document.querySelector<HTMLElement>('[data-account-sessions]')
    if (!owner) throw new Error('sessions_fixture_owner_missing')
    owner.dataset.sessionsCanRead = 'true'; owner.dataset.sessionsCanRevoke = 'false'
    const transport = vi.fn(async () => list())
    boot(transport); await tick()
    expect(transport).toHaveBeenCalledExactlyOnceWith('GET', '/api/auth/sessions', undefined)
    expect(document.querySelectorAll('[data-session-id]')).toHaveLength(2)
    expect(document.querySelectorAll('[data-session-action="revoke"]')).toHaveLength(0)
    expect(button('[data-sessions-revoke-others]').disabled).toBe(true)
    button('[data-sessions-revoke-others]').click(); await tick()
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('fails closed for partial personal authority and preserves native readonly ancestry', { tags: ['feature'] }, async () => {
    const cases: readonly (readonly [string | undefined, string | undefined, boolean])[] = [
      [undefined, 'true', false], ['true', undefined, false], ['true', 'unknown', false], ['unknown', 'true', false],
      ['', 'false', false], ['true', '', false], ['false', 'true', false], ['true', 'true', true],
    ]
    for (const [canRead, canRevoke, nativeReadonly] of cases) {
      document.body.innerHTML = renderSessions()
      const owner = document.querySelector<HTMLElement>('[data-account-sessions]')
      if (!owner) throw new Error('sessions_fixture_owner_missing')
      // SSR always emits a complete explicit pair; undefined here must mean an actually absent attribute.
      owner.removeAttribute('data-sessions-can-read'); owner.removeAttribute('data-sessions-can-revoke')
      if (canRead !== undefined) owner.dataset.sessionsCanRead = canRead
      if (canRevoke !== undefined) owner.dataset.sessionsCanRevoke = canRevoke
      if (nativeReadonly) owner.dataset.readonly = 'true'
      const transport = vi.fn(async () => list())
      boot(transport); await tick()
      expect(transport).not.toHaveBeenCalled()
      expect(status().dataset.state).toBe('unavailable')
      expect(button('[data-sessions-revoke-others]').disabled).toBe(true)
    }
  })

  it('rechecks revoke permission after confirmation rather than acting on the old authority', { tags: ['feature'] }, async () => {
    const owner = document.querySelector<HTMLElement>('[data-account-sessions]')
    if (!owner) throw new Error('sessions_fixture_owner_missing')
    owner.dataset.sessionsCanRead = 'true'; owner.dataset.sessionsCanRevoke = 'true'
    let confirm: ((value: boolean) => void) | undefined
    const ask = vi.fn(() => new Promise<boolean>(resolve => { confirm = resolve }))
    const transport = vi.fn(async () => list())
    boot(transport, ask); await tick()
    button('[data-sessions-revoke-others]').click()
    expect(ask).toHaveBeenCalledTimes(1)
    owner.dataset.sessionsCanRevoke = 'false'
    if (!confirm) throw new Error('confirmation_fixture_not_open')
    confirm(true); await tick()
    expect(transport).toHaveBeenCalledTimes(1)
    expect(button('[data-sessions-revoke-others]').disabled).toBe(true)
    expect(document.querySelectorAll('[data-session-id]')).toHaveLength(2)
    expect(status().dataset.state).not.toBe('saved')
  })

  const tableFixture = () => {
    const owner = document.querySelector<HTMLElement>('[data-account-sessions]')
    const target = owner?.querySelector('[data-sessions-rows]')
    const row = owner?.querySelector<HTMLTemplateElement>('template[data-xp-template="account-session-row"]')
    const empty = owner?.querySelector<HTMLTemplateElement>('template[data-xp-template="account-session-empty"]')
    if (!owner || !target || !row || !empty) throw new Error('table_fixture_missing')
    owner.dataset.sessionsLayout = 'table'; owner.dataset.sessionsCanRead = 'true'; owner.dataset.sessionsCanRevoke = 'true'
    const table = document.createElement('table'), rows = document.createElement('tbody')
    rows.setAttribute('data-sessions-rows', ''); table.append(rows); target.replaceWith(table)
    row.innerHTML = '<tr><td><span data-xp-slot="title"></span></td>'
      + '<td><span data-xp-slot="client-label"></span><bdi dir="auto" data-xp-slot="client"></bdi></td>'
      + '<td><span data-xp-slot="network-label"></span><bdi dir="ltr" data-xp-slot="network"></bdi></td>'
      + '<td><span data-xp-slot="last-active-label"></span><time data-xp-slot="last-active"></time><span data-xp-slot="created-label"></span><time data-xp-slot="created"></time></td>'
      + '<td><span data-xp-slot="verification"></span><span data-xp-slot="expires-label"></span><time data-xp-slot="expires"></time></td>'
      + '<td><div data-xp-slot="actions"></div></td></tr>'
    empty.innerHTML = '<tr><td colspan="6" data-xp-slot="message"></td></tr>'
    const count = document.createElement('span'); count.setAttribute('data-sessions-count', ''); count.textContent = 'Not read'; owner.append(count)
    return { owner, rows, row, count }
  }

  it('paints the finite six-column table and count only from validated real session fields', { tags: ['feature'] }, async () => {
    const view = tableFixture(), transport = vi.fn(async () => list())
    expect(view.count.textContent).toBe('Not read')
    boot(transport); await tick()
    expect(view.rows.children).toHaveLength(2)
    expect([...view.rows.children].every(row => row.tagName === 'TR' && row.children.length === 6)).toBe(true)
    expect(view.count.textContent).toBe('2')
    const created = view.rows.querySelector('time[data-xp-slot="created"]')
    expect(created?.getAttribute('datetime')).toBe(now)
    expect(created?.textContent).toBe('2026-01-01 00:00 UTC')
    expect(view.rows.textContent).toContain('192.0.2.10')
    expect(view.rows.textContent).toContain('Mozilla/5.0 (X11; Linux x86_64)')
    expect(view.rows.querySelector('bdi[data-xp-slot="network"]')?.getAttribute('dir')).toBe('ltr')
  })

  it('rejects a malformed table before requests and fills the empty count only after a valid read', { tags: ['feature'] }, async () => {
    const broken = tableFixture()
    broken.row.content.querySelector('[data-xp-slot="created"]')?.remove()
    const denied = vi.fn(async () => list()); boot(denied); await tick()
    expect(denied).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
    document.body.innerHTML = renderSessions()
    const empty = tableFixture(), transport = vi.fn(async () => list([])); boot(transport); await tick()
    expect(empty.rows.children).toHaveLength(1)
    expect(empty.rows.querySelector('td')?.getAttribute('colspan')).toBe('6')
    expect(empty.count.textContent).toBe('0')
    expect(empty.rows.textContent).toContain('No active sessions were returned.')
  })

  it('keeps a confirmed revocation unverified if its readback is refused', { tags: ['feature'] }, async () => {
    let reads = 0
    const transport = vi.fn(async (method: string) => {
      if (method === 'GET') { reads++; if (reads > 1) throw { details: { stateChanged: false } }; return list() }
      return { ok: true, revokedCount: 1 }
    })
    boot(transport); await tick()
    button('[data-sessions-revoke-others]').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('uncertain')
    expect(button('[data-sessions-revoke-others]').disabled).toBe(true)
    expect(transport).toHaveBeenCalledTimes(3)
  })

})
