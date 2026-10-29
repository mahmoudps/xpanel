// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderConnectedPanelSessions } from './board-port/approved-xpanel-bindings.ts'
import {
  ACCOUNT_SESSIONS_CLIENT_BINDING, readSession, readSessions,
} from './account-sessions-client.ts'

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
    document.body.innerHTML = renderConnectedPanelSessions({ route: '/security/account', locale: 'en', readOnly: false } as never)!
    document.documentElement.lang = 'en'
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  })
  const boot = (transport: ReturnType<typeof vi.fn>) => {
    (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
    new Function(`(${ACCOUNT_SESSIONS_CLIENT_BINDING})((options) => Promise.resolve(true));`)()
  }
  it('renders the section without forms or fetch and constructs the binding', () => {
    expect(() => new Function('return ' + ACCOUNT_SESSIONS_CLIENT_BINDING)()).not.toThrow()
    expect(ACCOUNT_SESSIONS_CLIENT_BINDING).not.toContain('fetch(')
    expect(document.querySelector('[data-account-sessions]')).not.toBeNull()
    expect(document.querySelectorAll('form')).toHaveLength(0)
  })
  it('disables controls with an explicit unavailable state without a transport', () => {
    new Function(`(${ACCOUNT_SESSIONS_CLIENT_BINDING})(undefined);`)()
    expect(status().dataset.state).toBe('unavailable')
    expect(button('[data-sessions-revoke-others]').disabled).toBe(true)
  })
  it.each(['en', 'ar'] as const)('renders human session timestamps in %s without changing raw session data', async locale => {
    document.body.innerHTML = renderConnectedPanelSessions({ route: '/security/account', locale, readOnly: false } as never)!
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
})
