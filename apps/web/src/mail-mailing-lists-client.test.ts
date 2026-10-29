// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAIL_MAILING_LISTS_CLIENT_BINDING, readMailMailingLists } from './mail-mailing-lists-client.ts'
import { renderMailMailingLists } from './board-port/xmail-mailing-lists.ts'
const mailbox = 'alice@example.test', id = '33333333-3333-4333-8333-333333333333'
const row = (subscribed = false) => ({ id, address: 'news@example.test', name: 'News', revision: (subscribed ? 'b' : 'a').repeat(64), subscriptionPolicy: 'open', postingPolicy: 'members', membership: subscribed ? 'subscribed' : 'not_subscribed', canSubscribe: !subscribed, canUnsubscribe: subscribed })
const view = (subscribed = false) => ({ context: { mailbox }, revision: (subscribed ? 'b' : 'a').repeat(64), lists: [row(subscribed)], metadataReview: { status: 'review_required', reason: 'mailbox_metadata_binding_unverified' }, capabilities: { moderation: false, archive: false, delivery: 'unverified' }, application: { status: 'configuration_only', nativeApplied: false } })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
async function bind(canManage: boolean, request: (method: string, path: string, body?: unknown) => Promise<unknown>, confirm: unknown = async () => true) { document.body.innerHTML = renderMailMailingLists({ locale: 'en', mailbox, canManage }); (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + MAIL_MAILING_LISTS_CLIENT_BINDING)()(confirm); await settle(); await settle() }
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.restoreAllMocks() })
describe('own mailing-list membership client', () => {
  it('keeps table/admin components bilingual and rejects foreign, member-leaking or native-applied replies', () => {
    for (const locale of ['en', 'ar'] as const) { const html = renderMailMailingLists({ locale, mailbox, canManage: true }); expect(html).toContain('colspan="7"'); expect(html).toContain('data-lists-rows'); expect(html).toContain('dir="' + (locale === 'ar' ? 'rtl' : 'ltr') + '"'); expect(html).not.toMatch(/[٠-٩۰-۹]/) }
    expect(renderMailMailingLists({ locale: 'en', mailbox, canManage: true })).toContain('Subscriptions for <bdi dir="ltr">' + mailbox + '</bdi>. Only public lists'); expect(renderMailMailingLists({ locale: 'ar', mailbox, canManage: true })).toContain('اشتراكات الصندوق <bdi dir="ltr">' + mailbox + '</bdi>. تُعرض')
    expect(() => readMailMailingLists({ ...view(), context: { mailbox: 'bob@example.test' } }, mailbox)).toThrow(); expect(() => readMailMailingLists({ ...view(), lists: [{ ...row(), members: ['bob@example.test'] }] }, mailbox)).toThrow(); expect(() => readMailMailingLists({ ...view(), application: { status: 'configuration_only', nativeApplied: true } }, mailbox)).toThrow()
  })
  it('leaves unavailable pages inert and never renders internal list identifiers as visible text', async () => { const request = vi.fn(async () => view()); await bind(false, request); expect(request).not.toHaveBeenCalled(); await bind(true, request); expect($('[data-lists-rows]').textContent).not.toContain(id); expect($('[data-lists-rows]').textContent).toContain('news@example.test') })
  it('requires confirmation and sends only own-state plus captured revision, then reads back', async () => {
    let current = view(); const confirm = vi.fn(async () => true)
    const request = vi.fn(async (method: string, path: string, body?: unknown) => { if (method === 'PUT') { expect(path).toBe('/api/webmail/mailing-lists/' + id + '/subscription'); expect(body).toEqual({ subscribed: true, expectedRevision: 'a'.repeat(64) }); current = view(true); return { ...current, stateChanged: true } } expect(path).toBe('/api/webmail/mailing-lists'); return current })
    await bind(true, request, confirm); $<HTMLButtonElement>('button[data-list-action]').click(); await settle(); await settle(); await settle(); expect(confirm).toHaveBeenCalledTimes(1); expect($('[data-lists-status]').getAttribute('data-state')).toBe('saved'); expect(request.mock.calls.map(call => call[0])).toEqual(['GET', 'PUT', 'GET'])
  })
  it('locks retries on an unverifiable subscription acknowledgement', async () => { const request = vi.fn(async (method: string) => method === 'PUT' ? { ...view(true), application: { status: 'configuration_only', nativeApplied: true } } : view()); await bind(true, request); $<HTMLButtonElement>('button[data-list-action]').click(); await settle(); await settle(); expect($('[data-lists-status]').getAttribute('data-state')).toBe('uncertain'); expect($<HTMLButtonElement>('button[data-list-action]').disabled).toBe(true); expect(request.mock.calls).toHaveLength(2) })
})
