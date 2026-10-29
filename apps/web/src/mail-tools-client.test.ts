// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAIL_TOOLS_CLIENT_BINDING, readMailToolsQuota } from './mail-tools-client.ts'
import { renderMailTools } from './board-port/xmail-tools.ts'
const mailbox = 'alice@example.test', observedAt = '2026-10-27T12:00:00.000Z'
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.restoreAllMocks() })
describe('mail tools real bindings', () => {
  it('reuses actual search/attachment panels and routes without inventing trained-spam success', () => { for (const locale of ['en', 'ar'] as const) { const html = renderMailTools({ locale, mailbox, canManage: true, searchAvailable: true, attachmentsAvailable: true, quotaAvailable: true }); for (const part of ['data-mail-search-workspace', 'data-mail-attachments', '/mail/inbox?lang=' + locale, '/mail/compose?lang=' + locale, '/mail/tools/disk-usage?lang=' + locale]) expect(html).toContain(part); expect(html).not.toMatch(/[٠-٩۰-۹]/) } expect(renderMailTools({ locale: 'en', mailbox, canManage: true })).toContain('Tools for <bdi dir="ltr">' + mailbox + '</bdi></p>'); expect(renderMailTools({ locale: 'ar', mailbox, canManage: true })).toContain('أدوات للصندوق <bdi dir="ltr">' + mailbox + '</bdi></p>') })
  it('reads actual disk-usage quota using sealed response pinning and ASCII values', async () => { const request = vi.fn(async () => ({ mailbox, observedAt, quota: { state: 'read', usedBytes: 1024, limitBytes: 4096 } })); document.body.innerHTML = renderMailTools({ locale: 'en', mailbox, canManage: true, quotaAvailable: true }); (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + MAIL_TOOLS_CLIENT_BINDING)()(undefined); await settle(); await settle(); expect(request).toHaveBeenCalledWith('GET', '/api/webmail/disk-usage'); expect(document.querySelector('[data-tools-used]')!.textContent).toBe('1024'); expect(document.querySelector('[data-tools-limit]')!.textContent).toBe('4096') })
  it('leaves unavailable tools inert and rejects wrong-mailbox or fabricated quota values', async () => { const request = vi.fn(); document.body.innerHTML = renderMailTools({ locale: 'ar', mailbox, canManage: false, quotaAvailable: true }); (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + MAIL_TOOLS_CLIENT_BINDING)()(undefined); await settle(); expect(request).not.toHaveBeenCalled(); expect(() => readMailToolsQuota({ mailbox: 'bob@example.test', observedAt, quota: { state: 'read', usedBytes: 0, limitBytes: 100 } }, mailbox)).toThrow(); expect(() => readMailToolsQuota({ mailbox, observedAt, quota: { state: 'read', usedBytes: -1, limitBytes: 100 } }, mailbox)).toThrow() })
})


describe('reachable metadata datetime', () => {
  it.each(['en', 'ar'] as const)('renders readable quota observation time in %s without rewriting the response', async locale => {
    const instant = '2026-10-27T12:34:56.789Z', raw = { mailbox, observedAt: instant, quota: { state: 'read', usedBytes: 1024, limitBytes: 4096 } }
    const request = vi.fn(async (_method: string, _path: string) => raw)
    document.body.innerHTML = renderMailTools({ locale, mailbox, canManage: true, quotaAvailable: true })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    new Function('return ' + MAIL_TOOLS_CLIENT_BINDING)()(undefined)
    await settle(); await settle()
    const observed = document.querySelector<HTMLElement>('[data-tools-observed]')!
    expect(observed.textContent).toBe('2026-10-27 12:34 UTC')
    expect(observed.dir).toBe('ltr')
    expect(readMailToolsQuota(raw, mailbox).observedAt).toBe(instant)
    expect(raw.observedAt).toBe(instant)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('GET', '/api/webmail/disk-usage')
  })
})
