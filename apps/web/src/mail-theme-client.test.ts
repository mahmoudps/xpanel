/// <reference lib="dom" />
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { msgctxt, msgid } from '@xpanel/core'
import { tools, type VisibilityContext } from '@xpanel/catalog'
import { translator } from './i18n.ts'
import { projectMailView } from './models/mail.ts'
import { MAIL_ATTACHMENTS_CLIENT_BINDING } from './mail-attachments-client.ts'
import { MAIL_FOLDER_WORKSPACE_CLIENT_BINDING } from './mail-folder-workspace-client.ts'
import { MAIL_CALENDAR_VIEW_CLIENT_BINDING } from './mail-calendar-view-client.ts'
import { renderXmailInbox, xmailInboxFromProps } from './board-port/xmail-inbox.ts'
import { renderMailAttachments } from './board-port/xmail-attachments.ts'
import { renderMailCalendarView } from './board-port/xmail-calendar-view.ts'
import { renderV2MailInbox } from './themes/v2/pages/xmail/inbox.ts'
import { renderMailCalendarPage } from './themes/v2/pages/xmail/workspaces/organizer.ts'
import { renderMailSearchPage } from './themes/v2/pages/xmail/workspaces/tools.ts'
import { v2Messages } from './themes/v2/messages.ts'

type TestDom = { window: Window & typeof globalThis }
const harnessRequire = createRequire(createRequire(import.meta.url).resolve('vitest'))
const { JSDOM } = harnessRequire('jsdom') as { JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => TestDom }
const doms: TestDom[] = []
const mailbox = 'owner@example.test', validity = 800
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const input = { locale: 'en' as const, mailbox, route: '/mail/search', canRead: true, canManage: true, searchAvailable: true, attachmentsAvailable: true }
const visibility: VisibilityContext = { principal: { kind: 'user', id: 'mail-owner', username: 'owner', accountId: 'account-mail' }, disabledFeatures: new Set() }
const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
function mount(html: string, binding: string, send: (method: string, path: string, body?: unknown) => Promise<unknown>, prepare?: (document: Document) => void) {
  const dom = new JSDOM(html, { url: 'https://mail.example.test/mail/inbox', runScripts: 'outside-only' }); doms.push(dom)
  Object.assign(dom.window, { msgid, msgctxt, xpT: translator('en'), xpanelSessionRequest: send })
  prepare?.(dom.window.document)
  const boot = dom.window.Function('return ' + binding)() as (confirm: unknown, rtl?: boolean) => void
  boot(async () => true, false)
  return { document: dom.window.document, window: dom.window, boot }
}
afterEach(() => { for (const dom of doms.splice(0)) dom.window.close() })

describe.each(['classic', 'v2'] as const)('%s mailbox dynamic templates', theme => {
  const attachmentHtml = () => theme === 'classic'
    ? renderMailAttachments({ lang: 'en', mailbox, folder: 'INBOX', uid: 17, canRead: true })
    : renderMailSearchPage(input)
  const prepare = (document: Document) => {
    const root = document.querySelector<HTMLElement>('[data-mail-attachments]')!
    root.dataset.uid = '17'; root.dataset.uidValidity = String(validity)
  }
  it('keeps attachment names as text, download scope/expiry guards and its selected theme', async () => {
    const path = '/api/webmail/attachment-download/' + 'a'.repeat(32) + '.' + 'b'.repeat(43)
    const send = vi.fn(async () => ({ context: { mailbox, folder: 'INBOX', uid: 17, uidValidity: validity }, attachments: [
      { filename: '<img>.pdf', contentType: 'application/pdf', sizeBytes: 6, sha256: 'c'.repeat(64), downloadPath: path, expiresAt: new Date(Date.now() + 60000).toISOString() },
    ] }))
    const { document, boot } = mount(attachmentHtml(), MAIL_ATTACHMENTS_CLIENT_BINDING, send, prepare)
    await tick(); boot(undefined); await tick()
    expect(send).toHaveBeenCalledTimes(1)
    const list = document.querySelector('[data-attachment-list]')!, link = list.querySelector<HTMLAnchorElement>('[data-attachment-download]')!
    expect(list.textContent).toContain('<img>.pdf'); expect(list.querySelector('img')).toBeNull()
    expect(link.getAttribute('href')).toBe(path); expect(link.rel).toContain('noopener')
    expect(link.classList.contains(theme === 'v2' ? 'v2-btn' : 'xp-btn')).toBe(true)
    const size = list.querySelector('[data-xp-slot="size"]')!
    expect(size.getAttribute('dir')).toBe('ltr'); expect(size.textContent).toBe('6 B')
  })
  it.each(['missing', 'duplicate'] as const)('refuses %s attachment templates before a request', async disposition => {
    const send = vi.fn(async () => null)
    const { document } = mount(attachmentHtml(), MAIL_ATTACHMENTS_CLIENT_BINDING, send, document => {
      prepare(document)
      const root = document.querySelector('[data-mail-attachments]')!, template = root.querySelector('template[data-xp-template="mail-attachment-row"]')!
      if (disposition === 'missing') template.remove(); else root.append(template.cloneNode(true))
    })
    await tick(); expect(send).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLButtonElement>('[data-attachment-refresh]')!.disabled).toBe(true)
  })
  it('constructs month, week and day grids from its own templates after a real validated calendar read', async () => {
    const html = theme === 'classic' ? renderMailCalendarView({ locale: 'en', mailbox, canManage: true }) : renderMailCalendarPage({ ...input, route: '/mail/calendar' })
    const send = vi.fn(async () => ({ context: { mailbox }, application: { status: 'stored_configuration', nativeApplied: false, syncVerified: false }, revision: 'a'.repeat(64), calendars: [], limits: { calendars: 25, events: 1000, shares: 100, icsBytes: 262144, calendarBytes: 524288 } }))
    const { document } = mount(html, MAIL_CALENDAR_VIEW_CLIENT_BINDING, send)
    await tick()
    const days = () => document.querySelectorAll('[data-calview-day]')
    expect(days().length).toBeGreaterThanOrEqual(28); expect(days().length).toBeLessThanOrEqual(42)
    expect(days()[0]!.classList.contains(theme === 'v2' ? 'v2-mail-calview__day' : 'xp-mail-calview__day')).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-calview-mode="week"]')!.click(); expect(days()).toHaveLength(7)
    document.querySelector<HTMLButtonElement>('[data-calview-mode="day"]')!.click(); expect(days()).toHaveLength(1)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('V2 primary Inbox transport', () => {
  const message = { uid: 17, from: 'sender@example.test', to: mailbox, subject: 'Actual message', receivedAt: '2026-10-29T12:00:00Z', unread: true, sizeBytes: 12, uidValidityObserved: true, uidValidity: validity, preview: 'Saved preview', attachments: [] }
  function html() {
    const view = projectMailView({ mailbox, visibility, catalog, activeRoute: '/mail/inbox', messages: [] })
    if (view?.kind !== 'inbox') throw new Error('Expected admitted Inbox fixture')
    return renderV2MailInbox(v2Messages.translator('en'), view)
  }
  it('opens and filters a message using the actual Inbox API contract and preserves inline technical isolation', async () => {
    const send = vi.fn(async (_method: string, path: string) => path.includes('/17?') ? { mailbox, folder: 'INBOX', message: { ...message, body: '<script>literal message body</script>' } } : { mailbox, folder: 'INBOX', complete: true, capabilities: { move: true }, messages: [message] })
    const { document, boot } = mount(html(), MAIL_FOLDER_WORKSPACE_CLIENT_BINDING, send)
    await tick(); boot(async () => true); await tick()
    expect(send).toHaveBeenCalledTimes(1)
    document.querySelector<HTMLButtonElement>('[data-mail-open="uid-17"]')!.click(); await tick()
    expect(send.mock.calls[1]).toEqual(['GET', '/api/webmail/inbox/17?folder=INBOX', undefined])
    const body = document.querySelector('[data-mail-detail-body]')!
    expect(body.textContent).toBe('<script>literal message body</script>'); expect(body.querySelector('script')).toBeNull()
    expect(document.querySelector('[data-mail-detail-to] bdi[dir="ltr"]')?.textContent).toBe(mailbox)
    expect(document.querySelector<HTMLElement>('[data-mail-open]')!.style.background).toBe('')
    document.querySelector<HTMLButtonElement>('[data-mail-filter="attachments"]')!.click()
    expect(document.querySelector('[data-mail-filter-empty]')?.textContent).toContain('No messages match')
  })
})

describe.each(['classic', 'v2'] as const)('%s mailbox pre-read contract', theme => {
  it.each([['mail-folder-message-row', '[data-mail-open]'], ['mail-folder-message-reading', '[data-mail-detail-body]']] as const)('refuses missing %s required content before GET', async (name, selector) => {
    const view = projectMailView({ mailbox, visibility, catalog, activeRoute: '/mail/inbox', messages: [] })
    if (view?.kind !== 'inbox') throw new Error('Expected admitted Inbox fixture')
    const html = theme === 'v2' ? renderV2MailInbox(v2Messages.translator('en'), view) : renderXmailInbox(xmailInboxFromProps({ locale: 'en', mailbox, activeFolder: 'Sent', folderWorkspace: true, messages: [] }))
    const send = vi.fn(async () => null)
    const { document } = mount(html, MAIL_FOLDER_WORKSPACE_CLIENT_BINDING, send, document => {
      const template = document.querySelector<HTMLTemplateElement>('template[data-xp-template="' + name + '"]')!
      const target = template.content.querySelector(selector)
      expect(target).not.toBeNull(); target!.remove()
    })
    await tick()
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLElement>('[data-mail-folder-status]')!.dataset.state).toBe('unavailable')
  })
})
