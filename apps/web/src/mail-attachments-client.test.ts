// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMailAttachments } from './board-port/xmail-attachments.ts'
import { MAIL_ATTACHMENTS_CLIENT_BINDING, readAttachmentManifest } from './mail-attachments-client.ts'

const expected = { mailbox: 'owner@example.test', folder: 'INBOX', uid: 17 }
const reference = '/api/webmail/attachment-download/' + 'a'.repeat(32) + '.' + 'b'.repeat(43)
const manifest = (patch: Record<string, unknown> = {}) => ({ context: { ...expected, uidValidity: 800 }, attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 6, sha256: 'c'.repeat(64), downloadPath: reference, expiresAt: new Date(Date.now() + 60000).toISOString() }], ...patch })
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const root = () => document.querySelector<HTMLElement>('[data-mail-attachments]')!
const status = () => document.querySelector<HTMLElement>('[data-attachment-status]')!
const refresh = () => document.querySelector<HTMLButtonElement>('[data-attachment-refresh]')!
beforeEach(() => { document.body.innerHTML = renderMailAttachments({ lang: 'en', ...expected, canRead: true }); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })
const boot = (send?: ReturnType<typeof vi.fn>) => {
  if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  new Function('return ' + MAIL_ATTACHMENTS_CLIENT_BINDING)()(undefined)
}

describe('attachment response validation', () => {
  it('pins identity and accepts only bounded signed same-origin download paths', () => {
    expect(readAttachmentManifest(manifest(), expected).attachments[0]!.filename).toBe('invoice.pdf')
    for (const bad of [manifest({ context: { ...expected, uid: 18, uidValidity: 800 } }), manifest({ context: { ...expected, mailbox: 'other@example.test', uidValidity: 800 } }),
      manifest({ attachments: [{ ...manifest().attachments[0], downloadPath: 'https://other.example.test/file' }] }),
      manifest({ attachments: [{ ...manifest().attachments[0], sizeBytes: 10 * 1024 * 1024 + 1 }] }),
      manifest({ attachments: [{ ...manifest().attachments[0], filename: 'bad\r\nname' }] })]) expect(() => readAttachmentManifest(bad, expected)).toThrow()
  })
})
describe('attachment browser binding', () => {
  it('constructs a self-contained binding without HTML injection or arbitrary fetch', () => {
    expect(() => new Function('return ' + MAIL_ATTACHMENTS_CLIENT_BINDING)()).not.toThrow()
    expect(MAIL_ATTACHMENTS_CLIENT_BINDING).not.toContain('innerHTML')
    expect(MAIL_ATTACHMENTS_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('does not read without the transport or capability admission', async () => {
    boot(); expect(status().dataset.state).toBe('unavailable'); expect(refresh().disabled).toBe(true)
    root().removeAttribute('data-attachments-bound'); root().dataset.attachmentCanRead = 'false'
    const send = vi.fn(); boot(send); await tick(); expect(send).not.toHaveBeenCalled()
  })
  it('loads real manifest metadata and exposes an authenticated native download link', async () => {
    const send = vi.fn(async () => manifest()); boot(send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/webmail/attachment-workspace?uid=17&folder=INBOX')
    const link = root().querySelector<HTMLAnchorElement>('[data-attachment-download]')!
    expect(link.getAttribute('href')).toBe(reference); expect(link.getAttribute('aria-label')).toBe('Download invoice.pdf'); expect(link.target).toBe('_blank'); expect(link.rel).toContain('noopener')
    expect(status().dataset.state).toBe('read'); expect(root().textContent).toContain('invoice.pdf'); expect(root().textContent).toContain('6 B')
  })
  it('passes an observed selected-message validity and refuses a different readback', async () => {
    root().dataset.uidValidity = '800'
    const send = vi.fn(async () => manifest()); boot(send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/webmail/attachment-workspace?uid=17&folder=INBOX&uidValidity=800')
    expect(() => readAttachmentManifest(manifest(), { ...expected, uidValidity: 801 })).toThrow()
  })
  it('shows a read empty state and a failure without fabricating attachment buttons', async () => {
    let bad = false
    const send = vi.fn(async () => { if (bad) throw new Error('unavailable'); return manifest({ attachments: [] }) })
    boot(send); await tick(); expect(status().dataset.state).toBe('empty'); expect(root().querySelector('a')).toBeNull()
    bad = true; refresh().click(); await tick(); expect(status().dataset.state).toBe('failed'); expect(root().querySelector('a')).toBeNull()
  })
  it('reacts to message selection and ignores a late response for the previous UID', async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    const first = new Promise(resolve => { resolveFirst = resolve })
    const send = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(manifest({ context: { ...expected, uid: 18, uidValidity: 800 }, attachments: [] }))
    boot(send); root().dataset.uid = '18'; await tick()
    expect(status().dataset.state).toBe('empty')
    resolveFirst(manifest()); await tick()
    expect(status().dataset.state).toBe('empty'); expect(root().querySelector('a')).toBeNull()
  })
  it('clears an old selection without retaining a busy or stale attachment state', async () => {
    const send = vi.fn(async () => manifest()); boot(send); await tick(); root().dataset.uid = ''; await tick()
    expect(status().dataset.state).toBe('unread'); expect(root().getAttribute('aria-busy')).toBe('false'); expect(root().querySelector('a')).toBeNull()
  })
  it('renders hostile filenames as text and blocks expired links without claiming a download', async () => {
    const send = vi.fn(async () => manifest({ attachments: [{ ...manifest().attachments[0], filename: '<img src=x>\u0661.pdf', expiresAt: '2000-01-01T00:00:00Z' }] }))
    boot(send); await tick()
    expect(root().querySelector('img')).toBeNull(); expect(root().textContent).toContain('<img src=x>1.pdf')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true }); root().querySelector('a')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true); expect(status().dataset.state).toBe('failed')
  })
})
