// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderAccountQuarantine } from './board-port/extensions/account-quarantine.ts'
import { renderAccountPagesExtension } from './board-port/extensions/account-pages.ts'
import { ACCOUNT_QUARANTINE_CLIENT_BINDING } from './account-quarantine-client.ts'
import type { QuarantineMessage } from '../../../packages/core/src/mail-quarantine.ts'

const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', mailbox = 'held@alpha.example.test'
const locator = { mailboxGuid: 'b'.repeat(32), uidValidity: 7, uid: 10, messageGuid: 'd'.repeat(32) }
const message = (): QuarantineMessage => ({ locator: { ...locator }, revision: 'a'.repeat(64), from: 'sender@example.test', to: mailbox, subject: '<img src=x onerror=window.__xss=1>', receivedAt: '2026-08-01T00:00:00.000Z', heldAt: '2026-08-01T00:00:00.000Z', sizeBytes: 100, score: 8.5, reason: 'score=8.5', headers: 'Subject: <img src=x>\nX-Spam-Score: 8.5', releaseEligible: true })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const button = (name: string) => document.querySelector<HTMLButtonElement>('[data-quarantine-' + name + ']')!
const status = () => document.querySelector<HTMLElement>('[data-quarantine-status]')!
beforeEach(() => {
  document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'
  document.body.innerHTML = renderAccountQuarantine({ lang: 'en', expectedAccountId: accountId, canManage: true, mailboxes: [mailbox] })
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
describe('quarantine account page mount', () => {
  const pageInput = () => ({
    locale: 'en' as const, route: '/email/spam-quarantine', mutationsQualified: true,
    account: { id: accountId, planId: 'synthetic-plan', status: 'active' as const, contactEmail: 'owner@example.test' },
    principal: { kind: 'user' as const, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', username: 'synthetic-owner', accountId },
    users: { state: 'read' as const, items: [
      { accountId, login: mailbox, services: { email: true, ftp: false, webdisk: false } },
      { accountId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', login: 'foreign@example.test', services: { email: true, ftp: false, webdisk: false } },
      { accountId, login: 'ftp-only', services: { email: false, ftp: true, webdisk: false } },
    ] },
  })
  it.each(['en', 'ar'] as const)('mounts the account-pinned %s workspace using owned email metadata only', locale => {
    document.body.innerHTML = renderAccountPagesExtension({ ...pageInput(), locale })
    const root = document.querySelector<HTMLElement>('[data-account-quarantine]')!
    expect(root.dataset.account).toBe(accountId)
    expect(root.getAttribute('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr')
    expect(Array.from(root.querySelectorAll<HTMLOptionElement>('[data-quarantine-mailbox] option')).map(option => option.value)).toEqual([mailbox])
    expect(button('refresh').disabled).toBe(false)
    expect(button('allow').disabled).toBe(true)
    expect(root.querySelector<HTMLSelectElement>('#quarantine-digest')!.disabled).toBe(true)
  })
  it('keeps unqualified controls disabled and unread metadata free of invented mailbox rows', () => {
    document.body.innerHTML = renderAccountPagesExtension({ ...pageInput(), mutationsQualified: false })
    expect(button('refresh').disabled).toBe(true)
    const { users: _users, ...unread } = pageInput()
    document.body.innerHTML = renderAccountPagesExtension(unread)
    expect(document.querySelectorAll('[data-quarantine-mailbox] option')).toHaveLength(0)
    expect(document.querySelector('[data-quarantine-total]')!.textContent).toBe('Not read')
  })
  it('refuses a foreign account principal before rendering the workspace', () => {
    const input = pageInput()
    expect(renderAccountPagesExtension({ ...input, principal: { ...input.principal, accountId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } })).toBe('')
  })
})

const model = () => {
  let rows = [message()], mode = 'normal'
  const context = () => ({ accountId, mailbox, mailboxes: [mailbox] })
  const page = () => ({ context: context(), quarantine: { state: 'available', scope: { accountId, mailbox }, source: { kind: 'dovecot', folder: 'Spam', observedAt: '2026-10-26T12:00:00.000Z' }, revision: 'b'.repeat(64), messages: clone(rows), totalMessages: rows.length, nextBeforeUid: null, policy: { retentionDays: 30, retentionMode: 'manual_expiry', senderAllowAvailable: false, digestAvailable: false } } })
  const send = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === 'GET') {
      if (mode === 'unavailable') return { context: context(), quarantine: { state: 'unavailable', reason: 'native_profile_unavailable' } }
      if (mode === 'foreign') return { ...page(), context: { ...context(), accountId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } }
      return page()
    }
    if (mode === 'refused') throw { status: 422, details: { stateChanged: false } }
    const input = body as Record<string, unknown>, deleting = path.endsWith('/delete'), expiry = path.endsWith('/expire')
    const target = rows[0]!
    const result = { state: deleting ? 'deleted' : 'released', scope: { accountId, mailbox }, locator: { ...target.locator }, sourceRevision: target.revision, correction: deleting ? 'not_attempted' : 'applied', deliveredToInbox: !deleting, deleted: deleting, sourcePresent: false, stateChanged: true, verificationRequired: false, observedAt: '2026-10-26T12:00:01.000Z' }
    if (mode === 'unknown') return { context: context(), result: { ...result, state: 'unknown', deliveredToInbox: null, sourcePresent: null, verificationRequired: true } }
    if (mode === 'wrong-ack') return { context: context(), result: { ...result, sourceRevision: 'f'.repeat(64) } }
    rows = []
    if (expiry) return { context: context(), result: { state: 'expired', scope: { accountId, mailbox }, removed: 1, considered: 1, results: [{ ...result, state: 'deleted', correction: 'not_attempted', deliveredToInbox: false, deleted: true }] } }
    expect(input.expectedRevision).toBe(target.revision)
    return { context: context(), result }
  })
  const ask = vi.fn(async () => true)
  const boot = (ar = false) => { document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'; (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + ACCOUNT_QUARANTINE_CLIENT_BINDING)()(ask) }
  return { send, ask, boot, setMode: (value: string) => { mode = value }, setRows: (value: ReturnType<typeof message>[]) => { rows = value }, writes: () => send.mock.calls.filter(call => call[0] === 'POST') }
}
const inspect = async () => { document.querySelector<HTMLButtonElement>('[data-quarantine-inspect]')!.click(); await tick() }

describe('account native quarantine browser binding', () => {
  it('constructs an isolated binding without raw fetch or HTML insertion', () => {
    expect(() => new Function('return ' + ACCOUNT_QUARANTINE_CLIENT_BINDING)()).not.toThrow()
    expect(ACCOUNT_QUARANTINE_CLIENT_BINDING).not.toContain('innerHTML')
    expect(ACCOUNT_QUARANTINE_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('makes no requests with missing session transport or unavailable capability', async () => {
    new Function('return ' + ACCOUNT_QUARANTINE_CLIENT_BINDING)()(undefined)
    expect(status().dataset.state).toBe('unavailable'); expect(button('release').disabled).toBe(true)
    document.querySelector<HTMLElement>('[data-account-quarantine]')!.removeAttribute('data-quarantine-bound')
    document.querySelector<HTMLElement>('[data-account-quarantine]')!.dataset.capabilityUnavailable = 'true'
    const f = model(); f.boot(); await tick(); expect(f.send).not.toHaveBeenCalled()
  })
  it('renders authorized metadata as text, shows public labels and keeps unsupported controls disabled', async () => {
    const f = model(); f.boot(); await tick(); await inspect()
    expect(status().dataset.state).toBe('read'); expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('[data-quarantine-subject]')!.textContent).toContain('<img')
    expect(document.querySelector('[data-quarantine-total]')!.textContent).toBe('1')
    expect(document.querySelector('[data-account-quarantine]')!.textContent).not.toContain(locator.messageGuid)
    expect(button('allow').disabled).toBe(true); expect(document.querySelector<HTMLSelectElement>('#quarantine-digest')!.disabled).toBe(true)
  })
  it('does not turn unavailable source into an empty collection or a zero count', async () => {
    const f = model(); f.setMode('unavailable'); f.boot(); await tick()
    expect(status().dataset.state).toBe('unavailable')
    expect(document.querySelector('[data-quarantine-total]')!.textContent).toBe('Not read')
    expect(button('expire').disabled).toBe(true)
  })
  it('cancels all consequential actions without transmitting a mutation', async () => {
    const f = model(); f.ask.mockResolvedValue(false); f.boot(); await tick(); await inspect()
    for (const key of ['release', 'delete', 'expire']) { button(key).click(); await tick() }
    expect(f.ask).toHaveBeenCalledTimes(3); expect(f.writes()).toHaveLength(0)
  })
  it.each(['release', 'delete'])('confirms %s against the exact identity and verifies absence', async action => {
    const f = model(); f.boot(); await tick(); await inspect(); button(action).click(); await tick(); await tick()
    expect(f.writes()).toHaveLength(1)
    expect(f.writes()[0]![2]).toEqual({ mailbox, locator, expectedRevision: 'a'.repeat(64) })
    expect(status().dataset.state).toBe(action === 'release' ? 'released' : 'deleted')
    expect(document.querySelector('[data-quarantine-total]')!.textContent).toBe('0')
    expect(f.send.mock.calls.filter(call => call[0] === 'GET')).toHaveLength(2)
  })
  it.each(['unknown', 'wrong-ack'])('locks after %s without reading over or retrying an uncertain action', async mode => {
    const f = model(); f.boot(); await tick(); await inspect(); f.setMode(mode); button('release').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('unknown' === mode ? 'unknown' : 'uncertain')
    expect(f.writes()).toHaveLength(1); expect(button('release').disabled).toBe(true)
    expect(f.send.mock.calls.filter(call => call[0] === 'GET')).toHaveLength(1)
  })
  it('leaves a definitely refused action available for explicit review without retrying', async () => {
    const f = model(); f.boot(); await tick(); await inspect(); f.setMode('refused'); button('delete').click(); await tick()
    expect(status().dataset.state).toBe('failed'); expect(button('delete').disabled).toBe(false); expect(f.writes()).toHaveLength(1)
  })
  it('requires a successful source read before a foreign response can expose or mutate data', async () => {
    const f = model(); f.setMode('foreign'); f.boot(); await tick()
    expect(status().dataset.state).toBe('failed'); expect(document.querySelector('[data-quarantine-inspect]')).toBeNull(); expect(button('expire').disabled).toBe(true)
  })
  it('confirms bounded expiry against the page revision and reads back its exact deleted targets', async () => {
    const f = model(); f.boot(); await tick(); button('expire').click(); await tick(); await tick()
    expect(f.writes()[0]![2]).toEqual({ mailbox, expectedRevision: 'b'.repeat(64) })
    expect(status().dataset.state).toBe('expired'); expect(document.querySelector('[data-quarantine-total]')!.textContent).toBe('0')
  })
})

describe('quarantine readable metadata preserves canonical content', () => {
  const receivedAt = '2026-09-01T09:10:11.123456Z'
  const heldAt = '2026-09-01T09:12:13.654321Z'
  const headers = 'Date: Tue, 27 Oct 2026 10:00:00 +0000\r\nX-Original-Time: 2026-10-27T10:00:00.000Z\r\nSubject: <img src=x>'
  it.each(['en', 'ar'] as const)('shows readable ASCII UTC metadata in %s while preserving raw headers and DTO timestamps', async lang => {
    document.body.innerHTML = renderAccountQuarantine({ lang, expectedAccountId: accountId, canManage: true, mailboxes: [mailbox] })
    const f = model()
    f.setRows([{ ...message(), receivedAt, heldAt, headers }])
    f.boot(lang === 'ar'); await tick(); await inspect()
    expect(document.querySelector('[data-quarantine-received]')!.textContent).toBe('2026-09-01 09:10 UTC')
    expect(document.querySelector('[data-quarantine-held]')!.textContent).toBe('2026-09-01 09:12 UTC')
    expect(document.querySelector('[data-quarantine-observed]')!.textContent).toBe('2026-10-26 12:00 UTC')
    for (const field of ['received', 'held', 'observed']) expect(document.querySelector('[data-quarantine-' + field + '] bdi')!.getAttribute('dir')).toBe('ltr')
    expect(document.querySelector('[data-quarantine-headers]')!.textContent).toBe(headers)
    expect(document.querySelector('img')).toBeNull()
    expect(await f.send.mock.results[0]!.value).toMatchObject({ quarantine: { source: { observedAt: '2026-10-26T12:00:00.000Z' }, messages: [{ receivedAt, heldAt, headers, locator, revision: 'a'.repeat(64) }] } })
    expect(f.writes()).toHaveLength(0)
  })
  it.each(['en', 'ar'] as const)('preserves the localized absent-time state in %s', async lang => {
    document.body.innerHTML = renderAccountQuarantine({ lang, expectedAccountId: accountId, canManage: true, mailboxes: [mailbox] })
    const f = model()
    f.setRows([{ ...message(), receivedAt: null, heldAt: null }])
    f.boot(lang === 'ar'); await tick(); await inspect()
    const absent = lang === 'ar' ? 'لم يُزوّد' : 'Not supplied'
    expect(document.querySelector('[data-quarantine-received]')!.textContent).toBe(absent)
    expect(document.querySelector('[data-quarantine-held]')!.textContent).toBe(absent)
    expect(document.querySelector('[data-quarantine-inspect]')!.getAttribute('aria-label')).toBe((lang === 'ar' ? 'مراجعة الرسالة: ' : 'Review message: ') + message().subject)
    expect(status().dataset.state).toBe('read')
    expect(f.writes()).toHaveLength(0)
  })
  it('still rejects a display-formatted timestamp in the canonical API response before exposing a message', async () => {
    const f = model()
    f.setRows([{ ...message(), receivedAt: '2026-09-01 09:10 UTC' }])
    f.boot(); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(document.querySelector('[data-quarantine-inspect]')).toBeNull()
    expect(button('expire').disabled).toBe(true)
    expect(f.writes()).toHaveLength(0)
  })
})
