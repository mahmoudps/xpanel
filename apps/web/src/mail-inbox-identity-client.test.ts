// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderInbox, xmailInboxFromProps } from './board-port/xmail-inbox.ts'
import { MAIL_ATTACHMENTS_STYLE } from './board-port/xmail-attachments.ts'
import { MAIL_FOLDER_WORKSPACE_CLIENT_BINDING } from './mail-folder-workspace-client.ts'

// DOM/request-fake checks only. No real mailbox, browser acceptance or native-service claim.
const mailbox = 'owner@tenant.test'
const stamp = '2026-10-26T12:00:00Z'
const packet = (uid = 1, folder = 'INBOX', uidValidity = 800, patch: Record<string, unknown> = {}) => ({ mailbox, folder, message: { uid, from: 'sender@example.test', to: mailbox, subject: 'Actual subject ' + uid, receivedAt: stamp, unread: false, sizeBytes: 32, body: 'Actual body ' + uid, uidValidityObserved: true, uidValidity, ...patch } })
const summary = (uid = 1, folder = 'INBOX') => ({ uid, folder, from: 'sender@example.test', to: mailbox, subject: 'Summary ' + uid, preview: 'Summary preview', receivedAt: stamp, unread: true, body: '', bodyPending: true, attachments: [{ name: 'metadata-only.bin', sizeBytes: 12 }] })
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const events: CustomEvent[] = []
const capture = (event: Event) => events.push(event as CustomEvent)
const root = () => document.querySelector<HTMLElement>('[data-board-port="xmail-inbox"]')!
const article = () => root().querySelector<HTMLElement>('[data-mail-article]')!
const open = (uid: number) => root().querySelector<HTMLButtonElement>('[data-mail-open="uid-' + uid + '"]')!.click()
const transport = (send: ReturnType<typeof vi.fn>) => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send }
const mount = (folder = 'INBOX', workspace = false, enabled = true) => {
  document.body.innerHTML = renderInbox(xmailInboxFromProps({ mailbox, activeFolder: folder, folderWorkspace: workspace, attachmentReadEnabled: enabled, messages: [summary(1, folder), summary(2, folder)] }))
}
const bootInline = () => new Function(document.querySelector('#xmail-inbox-client')!.textContent!)()
const bootFolder = () => new Function('return ' + MAIL_FOLDER_WORKSPACE_CLIENT_BINDING)()(async () => true, false)
beforeEach(() => { events.length = 0; document.addEventListener('xpanel:mail-message-read', capture); window.history.replaceState({}, '', '/mail/inbox') })
afterEach(() => { document.removeEventListener('xpanel:mail-message-read', capture); document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.restoreAllMocks() })

describe('existing inline Inbox actual-read producer', () => {
  it('starts without UID/UV authority and uses actual read proof, never summary filenames', async () => {
    mount(); const widget = article().querySelector<HTMLElement>('[data-mail-attachments]')!
    expect(widget.dataset.uid).toBe(''); expect(widget.dataset.uidValidity).toBe('')
    expect(widget.querySelector('[data-attachment-list]')!.children).toHaveLength(0)
    expect(article().textContent).not.toContain('metadata-only.bin')
    const send = vi.fn(async (_method: string, path: string) => packet(path.includes('/2?') ? 2 : 1))
    transport(send); bootInline(); await tick(); events.length = 0; send.mockClear()
    open(1); await tick()
    expect(events).toHaveLength(1)
    expect(events[0]!.target).toBe(article())
    expect(events[0]!.detail).toEqual({ mailbox, folder: 'INBOX', uid: 1, uidValidity: 800, uidValidityObserved: true })
    expect(article().querySelector('[data-mail-detail-body]')!.textContent).toBe('Actual body 1')
    expect(article().querySelector('[data-mail-detail-subject]')!.textContent).toBe('Actual subject 1')
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
  it.each([false, undefined])('does not infer an observed namespace from numeric default 1 (%j)', async observed => {
    mount(); transport(vi.fn(async () => packet(1, 'INBOX', 1, { uidValidityObserved: observed }))); bootInline(); await tick(); events.length = 0
    open(1); await tick()
    expect(events).toHaveLength(0)
    expect(root().querySelector<HTMLButtonElement>('[data-mail-action="delete"]')!.disabled).toBe(true)
    expect(root().querySelector('[data-mail-open="uid-1"]')!.getAttribute('data-mail-uid-validity')).toBeNull()
  })
  it('accepts a genuinely observed UIDVALIDITY of 1 without treating every 1 as a default', async () => {
    mount(); transport(vi.fn(async () => packet(1, 'INBOX', 1))); bootInline(); await tick(); events.length = 0; open(1); await tick()
    expect(events[0]!.detail.uidValidity).toBe(1)
  })
  it.each([{ mailbox: 'other@tenant.test' }, { folder: 'Trash' }, { message: { ...packet().message, uid: 2 } }])('refuses an actual read from another captured context %j', async extra => {
    mount(); transport(vi.fn(async () => ({ ...packet(), ...extra }))); bootInline(); await tick(); events.length = 0; open(1); await tick()
    expect(events).toHaveLength(0); expect(article().textContent).not.toContain('Actual body 1')
    expect(article().textContent).toContain('could not be read')
  })
  it('ignores a late prior selection before rendering or emitting its namespace', async () => {
    mount(); let finish!: (value: unknown) => void; const first = new Promise(resolve => { finish = resolve })
    transport(vi.fn(async (_method: string, path: string) => path.includes('/1?') ? first : packet(2)))
    bootInline(); open(1); open(2); await tick(); finish(packet()); await tick()
    expect(events).toHaveLength(1); expect(events[0]!.detail.uid).toBe(2)
    expect(article().textContent).toContain('Actual body 2'); expect(article().textContent).not.toContain('Actual body 1')
  })
  it('does not mark unread UI as read from a summary click before the actual server state', async () => {
    mount(); transport(vi.fn(async () => packet(1, 'INBOX', 800, { unread: true }))); bootInline(); open(1); await tick()
    expect(root().querySelector('[data-mail-open="uid-1"]')!.getAttribute('data-unread')).toBe('true')
  })
  it('fills actual message headers and body with text nodes while preserving the reading controls', async () => {
    mount(); transport(vi.fn(async () => packet(1, 'INBOX', 800, { subject: '<img src=x onerror=alert(1)>', fromName: '<script>sender</script>', body: '<script>body</script>', cc: 'copy@example.test' }))); bootInline(); open(1); await tick()
    expect(article().querySelector('img,script')).toBeNull()
    expect(article().querySelector('[data-mail-detail-subject]')!.textContent).toContain('<img')
    expect(article().querySelector('[data-mail-detail-body]')!.textContent).toBe('<script>body</script>')
    expect(article().querySelector<HTMLElement>('[data-mail-detail-cc]')!.parentElement!.style.display).toBe('grid')
    expect(article().querySelectorAll('[data-mail-reply]')).toHaveLength(3)
  })
  it('sends source validity and keeps Undo tied to mapped destination validity', async () => {
    mount(); const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET') return packet(Number(path.match(/inbox\/(\d+)/)![1]))
      const move = body as { from: string; folder: string; uidValidity: number }
      return { ok: true, mailbox, from: move.from, sourceUid: move.from === 'Trash' ? 11 : 1, sourceUidValidity: move.uidValidity, folder: move.folder, uid: move.from === 'Trash' ? 21 : 11, destinationUidKnown: true, stateChanged: true, uidValidityObserved: true, uidValidity: move.from === 'Trash' ? 800 : 900 }
    })
    transport(send); bootInline(); open(1); await tick(); root().querySelector<HTMLButtonElement>('[data-mail-action="delete"]')!.click(); await tick()
    const undo = root().querySelector<HTMLButtonElement>('[data-mail-action="undo"]')!
    expect(undo.hidden).toBe(false); expect(root().querySelector('[data-mail-undo]')!.getAttribute('data-undo-uid-validity')).toBe('900')
    undo.click(); await tick()
    expect(send.mock.calls.filter(call => call[0] === 'POST').map(call => [call[1], call[2]])).toEqual([
      ['/api/webmail/inbox/1/move', { from: 'INBOX', folder: 'Trash', uidValidity: 800 }],
      ['/api/webmail/inbox/11/move', { from: 'Trash', folder: 'INBOX', uidValidity: 900 }],
    ])
    expect(root().querySelector('[data-mail-open="uid-21"]')).not.toBeNull()
    expect(article().querySelector<HTMLAnchorElement>('[data-mail-reply]')!.getAttribute('href')).toContain('uid=21')
  })
  it('keeps the last row and locks an unmapped outcome without another write or fake Undo', async () => {
    mount(); const send = vi.fn(async (method: string) => method === 'GET' ? packet() : { ok: true, mailbox, from: 'INBOX', sourceUid: 1, sourceUidValidity: 800, folder: 'Trash', uid: null, destinationUidKnown: false, uidValidityObserved: false, stateChanged: true, unknownOutcome: true, verificationRequired: true })
    transport(send); bootInline(); open(1); await tick(); const remove = root().querySelector<HTMLButtonElement>('[data-mail-action="delete"]')!
    remove.click(); await tick(); expect(remove.disabled).toBe(true)
    expect(root().querySelector('[data-mail-open="uid-1"]')!.parentElement!.getAttribute('data-removed')).not.toBe('true')
    expect(root().querySelector('[data-mail-undo]')).toBeNull(); expect(root().textContent).toContain('outcome is unverified')
    remove.dispatchEvent(new Event('click', { bubbles: true })); await tick(); expect(send.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(1)
  })
  it('uses a source-only permanent DELETE receipt without manufacturing Undo or attachment authority', async () => {
    mount('Trash'); vi.spyOn(window, 'confirm').mockReturnValue(true)
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? packet(Number(path.match(/inbox\/(\d+)/)![1]), 'Trash', 900) : { ok: true, uid: 1, folder: 'Trash', sourceUidValidity: 900, permanent: true, stateChanged: true })
    transport(send); bootInline(); open(1); await tick(); root().querySelector<HTMLButtonElement>('[data-mail-action="delete"]')!.click(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'DELETE')).toEqual(['DELETE', '/api/webmail/inbox/1?folder=Trash&confirm=delete', { uidValidity: 900 }])
    const bar = root().querySelector('[data-mail-undo]')!
    expect(bar.getAttribute('data-undo-uid')).toBeNull(); expect(bar.querySelector<HTMLButtonElement>('[data-mail-action="undo"]')!.hidden).toBe(true)
  })
  it('keeps the authoritative component CSS outside replaceable reading templates', () => {
    mount(); const stable = root().querySelector(':scope > style')!
    article().querySelectorAll('style').forEach(style => style.remove())
    expect(stable.textContent).toContain(MAIL_ATTACHMENTS_STYLE)
  })
})

describe('existing folder-workspace actual-read producer', () => {
  const start = async (detail: (uid: number) => unknown | Promise<unknown> = uid => packet(uid, 'Sent')) => {
    mount('Sent', true)
    const send = vi.fn(async (_method: string, path: string) => path.includes('/inbox?') ? { mailbox, folder: 'Sent', complete: true, capabilities: { move: true }, messages: [packet(1, 'Sent').message, packet(2, 'Sent').message] } : detail(Number(path.match(/inbox\/(\d+)/)![1])))
    transport(send); bootFolder(); await tick(); return send
  }
  it('does not emit from list summaries, then emits from the connected actual reading article', async () => {
    await start(); expect(events).toHaveLength(0); open(1); await tick()
    expect(events).toHaveLength(1); expect(events[0]!.target).toBe(article())
    expect(events[0]!.detail).toEqual({ mailbox, folder: 'Sent', uid: 1, uidValidity: 800, uidValidityObserved: true })
    expect(article().querySelector('[data-mail-attachments]')).not.toBeNull()
    expect(article().querySelector('[data-attachment-list]')!.children).toHaveLength(0)
    expect(article().textContent).not.toContain('metadata-only.bin')
  })
  it('preserves observed=false as a readable message without a byte or mutation identity', async () => {
    const send = await start(uid => packet(uid, 'Sent', 1, { uidValidityObserved: false })); open(1); await tick()
    expect(article().textContent).toContain('Actual body 1'); expect(events).toHaveLength(0)
    const remove = root().querySelector<HTMLButtonElement>('[data-mail-action="delete"]')!
    expect(remove.disabled).toBe(true); remove.dispatchEvent(new Event('click', { bubbles: true })); await tick()
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
  it('suppresses a reply after the pinned folder changed', async () => {
    let finish!: (value: unknown) => void; const pending = new Promise(resolve => { finish = resolve })
    await start(() => pending); open(1); root().dataset.mailFolder = 'Trash'; finish(packet(1, 'Sent')); await tick()
    expect(events).toHaveLength(0)
  })
  it('suppresses a late prior detail reply and renders the verified current subject', async () => {
    let finish!: (value: unknown) => void; const pending = new Promise(resolve => { finish = resolve })
    await start(uid => uid === 1 ? pending : packet(uid, 'Sent', 801)); open(1); open(2); await tick(); finish(packet(1, 'Sent')); await tick()
    expect(events).toHaveLength(1); expect(events[0]!.detail).toMatchObject({ uid: 2, uidValidity: 801 })
    expect(article().querySelector('[data-mail-detail-subject]')!.textContent).toBe('Actual subject 2')
  })
})
