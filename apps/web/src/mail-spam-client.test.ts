// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAIL_SPAM_CLIENT_BINDING, readMailSpam } from './mail-spam-client.ts'
import type { MailSpamFields } from './mail-spam-client.ts'
import { renderMailSpam } from './board-port/xmail-spam.ts'
const mailbox = 'alice@example.test'
const view = (preferences: (MailSpamFields & { updatedAt: string }) | null = null, revision = 'a') => ({ context: { mailbox }, revision: revision.repeat(64), inherited: { source: 'account', enabled: true, addHeaderScore: 5, spamBoxEnabled: true }, preferences, effective: { enabled: preferences && !preferences.inherit ? preferences.enabled : true, addHeaderScore: preferences && !preferences.inherit ? preferences.addHeaderScore : 5, spamBoxEnabled: preferences && !preferences.inherit ? preferences.spamBoxEnabled : true, source: preferences && !preferences.inherit ? 'mailbox' : 'account' }, review: null, capabilities: { canSave: true, mta: 'unverified', sieve: 'unverified', boxTrapper: false }, application: { status: 'saved_only', applied: false } })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
async function bind(canManage: boolean, request: (method: string, path: string, body?: unknown) => Promise<unknown>) { document.body.innerHTML = renderMailSpam({ locale: 'en', mailbox, canManage }); (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + MAIL_SPAM_CLIENT_BINDING)()(async () => true); await settle(); await settle() }
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.restoreAllMocks() })
describe('mailbox spam preference client', () => {
  it('preserves bilingual controls and keeps delivery-only unavailable actions disabled', () => { for (const locale of ['en', 'ar'] as const) { const html = renderMailSpam({ locale, mailbox, canManage: true }); expect(html).toContain('class="xp-textarea"'); expect(html).toContain('BoxTrapper'); expect(html).toContain('name="inherit"'); expect(html).toContain('dir="' + (locale === 'ar' ? 'rtl' : 'ltr') + '"'); expect(html).not.toMatch(/[٠-٩۰-۹]/) } expect(renderMailSpam({ locale: 'en', mailbox, canManage: true })).toContain('Preferences for <bdi dir="ltr">' + mailbox + '</bdi> only. Account-wide'); expect(renderMailSpam({ locale: 'ar', mailbox, canManage: true })).toContain('تفضيلات الصندوق <bdi dir="ltr">' + mailbox + '</bdi> فقط.'); expect(MAIL_SPAM_CLIENT_BINDING).not.toContain('innerHTML') })
  it('leaves a read-only page inert and refuses foreign or applied replies', async () => { const request = vi.fn(async () => view()); await bind(false, request); expect(request).not.toHaveBeenCalled(); expect($<HTMLButtonElement>('[data-spam-save]').disabled).toBe(true); expect(() => readMailSpam({ ...view(), context: { mailbox: 'bob@example.test' } }, mailbox)).toThrow(); expect(() => readMailSpam({ ...view(), application: { status: 'saved_only', applied: true } }, mailbox)).toThrow() })
  it('saves only own fields with captured revision and requires matching readback', async () => {
    let current = view()
    const request = vi.fn(async (method: string, path: string, body?: unknown) => { expect(path).toBe('/api/webmail/spam-preferences'); if (method === 'PUT') { const value = body as MailSpamFields & { expectedRevision: string }; expect(value.expectedRevision).toBe('a'.repeat(64)); expect(Object.keys(value).sort()).toEqual(['addHeaderScore', 'allowlist', 'blocklist', 'enabled', 'expectedRevision', 'inherit', 'spamBoxEnabled'].sort()); current = view({ inherit: value.inherit, enabled: value.enabled, addHeaderScore: value.addHeaderScore, spamBoxEnabled: value.spamBoxEnabled, allowlist: value.allowlist, blocklist: value.blocklist, updatedAt: '2026-10-27T12:00:00.000Z' }, 'b'); return { ...current, stateChanged: true } } return current })
    await bind(true, request); const inherit = $<HTMLInputElement>('[name="inherit"]'); inherit.checked = false; inherit.dispatchEvent(new Event('change')); const score = $<HTMLInputElement>('[name="addHeaderScore"]'); score.value = '9'; score.dispatchEvent(new Event('input')); $<HTMLButtonElement>('[data-spam-save]').click(); await settle(); await settle(); await settle()
    expect($('[data-spam-status]').getAttribute('data-state')).toBe('saved'); expect(score.value).toBe('9'); expect(request.mock.calls.map(call => call[0])).toEqual(['GET', 'PUT', 'GET'])
  })
  it('retains draft edits and locks another save after a stale response', async () => {
    const request = vi.fn(async (method: string) => { if (method === 'PUT') throw { code: 'CONFLICT', stateChanged: false }; return view() })
    await bind(true, request); const inherit = $<HTMLInputElement>('[name="inherit"]'); inherit.checked = false; inherit.dispatchEvent(new Event('change')); const score = $<HTMLInputElement>('[name="addHeaderScore"]'); score.value = '11'; score.dispatchEvent(new Event('input')); $<HTMLButtonElement>('[data-spam-save]').click(); await settle(); await settle()
    expect(score.value).toBe('11'); expect($('[data-spam-status]').getAttribute('data-state')).toBe('stale'); expect($<HTMLButtonElement>('[data-spam-save]').disabled).toBe(true); expect(request.mock.calls).toHaveLength(2)
  })
})


describe('reachable metadata datetime', () => {
  it.each(['en', 'ar'] as const)('renders readable saved metadata in %s and keeps the captured revision payload raw', async locale => {
    const initialAt = '2026-10-27T12:34:56.789Z', savedAt = '2026-10-27T12:34:56.120Z'
    let current = view({ inherit: false, enabled: true, addHeaderScore: 5, spamBoxEnabled: true, allowlist: [], blocklist: [], updatedAt: initialAt })
    const request = vi.fn(async (method: string, _path: string, body?: unknown) => {
      if (method === 'PUT') { const fields = body as MailSpamFields & { expectedRevision: string }; const { expectedRevision: _revision, ...preferences } = fields; current = view({ ...preferences, updatedAt: savedAt }, 'b'); return { ...current, stateChanged: true } }
      return current
    })
    document.body.innerHTML = renderMailSpam({ locale, mailbox, canManage: true })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    new Function('return ' + MAIL_SPAM_CLIENT_BINDING)()(async () => false)
    await settle(); await settle()
    expect(document.querySelector('[data-spam-saved]')!.textContent).toBe('2026-10-27 12:34 UTC')
    const score = $<HTMLInputElement>('[name="addHeaderScore"]'); score.value = '9'; score.dispatchEvent(new Event('input'))
    $<HTMLButtonElement>('[data-spam-save]').click()
    await settle(); await settle(); await settle()
    expect(document.querySelector('[data-spam-saved]')!.textContent).toBe('2026-10-27 12:34 UTC')
    const put = request.mock.calls.find(call => call[0] === 'PUT')!
    expect(put[2]).toEqual({ inherit: false, enabled: true, addHeaderScore: 9, spamBoxEnabled: true, allowlist: [], blocklist: [], expectedRevision: 'a'.repeat(64) })
    expect(readMailSpam(current, mailbox).preferences!.updatedAt).toBe(savedAt)
    expect(request.mock.calls.map(call => call[0])).toEqual(['GET', 'PUT', 'GET'])
  })
})
