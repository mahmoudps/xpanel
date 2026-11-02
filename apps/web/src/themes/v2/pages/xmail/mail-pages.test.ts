import { describe, expect, it } from 'vitest'
import type { MailInboxView, MailComposeView } from './types.ts'
import { v2Messages } from '../../messages.ts'
import { renderV2MailInbox } from './inbox.ts'
import { renderV2MailCompose } from './compose.ts'
import { renderV2MailSidebar } from './navigation.ts'
import { createV2MailSurface } from '../../surfaces/xmail.ts'

const common = {
  mailbox: 'owner@example.test', route: '/mail/inbox', title: 'Inbox',
  quota: { text: '—', percent: null }, folders: [{ id: 'INBOX', label: 'Inbox', href: '/mail/inbox', current: true }],
  customFolders: [], canCompose: true,
} as const
const inbox = (changes: Partial<MailInboxView> = {}): MailInboxView => ({
  ...common, kind: 'inbox', folder: 'INBOX', folderWorkspace: true, state: 'unread', messages: [],
  selectedKey: null, unreadCount: null, countText: '—', pager: '—', loaded: 0, total: null,
  moveTargets: [], canReadAttachments: false, ...changes,
})
const compose = (changes: Partial<MailComposeView> = {}): MailComposeView => ({
  ...common, route: '/mail/compose', title: 'New message', kind: 'compose',
  draft: { to: '', cc: '', bcc: '', subject: '', body: '' },
  canSend: false, canSaveDraft: false, canUseAttachments: false, canManageVacation: false, identity: {}, vacation: null, rules: null,
  ...changes,
})
const t = v2Messages.translator('en')

describe('v2 mailbox pages', () => {
  it('distinguishes an unread folder, a failed read and an observed empty folder', () => {
    expect(renderV2MailInbox(t, inbox())).toContain('The inbox has not been read from the mail server.')
    expect(renderV2MailInbox(t, inbox({ state: 'failed' }))).toContain('The mail server could not be read.')
    const empty = renderV2MailInbox(t, inbox({ state: 'empty', total: 0, countText: '0 messages' }))
    expect(empty).toContain('No messages in this folder.')
    expect(empty).not.toContain('The inbox has not been read from the mail server.')
  })

  it('keeps provider content as text in rows, reading panes and hidden reading templates', () => {
    const unsafe = '<img src=x onerror="alert(1)">'
    const html = renderV2MailInbox(t, inbox({ state: 'messages', selectedKey: 'uid-8', messages: [{
      key: 'uid-8', uid: 8, fromName: unsafe, from: 'sender@example.test', to: common.mailbox,
      subject: unsafe, preview: unsafe, datetime: '2026-10-29T12:00:00Z', time: '12:00 UTC',
      fullDate: '2026-10-29 12:00 UTC', unread: true, authentication: 'Not checked',
      body: unsafe, bodyPending: false, attachments: [],
    }] }))
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(html).toContain('data-reading-id="uid-8"')
    expect(html).not.toContain('<script')
  })

  it('supplies the existing folder controller with live row and reading templates', () => {
    const html = renderV2MailInbox(t, inbox())
    expect(html).toContain('data-mail-folder-workspace="true"')
    expect(html).toMatch(/<template\b[^>]*data-mail-folder-row-template[^>]*>[\s\S]*data-mail-open=/)
    expect(html).toMatch(/<template\b[^>]*data-mail-folder-reading-template[^>]*>[\s\S]*data-mail-detail-body/)
    expect(html).toContain('data-mail-detail-cc')
    expect(html).toContain('data-mail-uid-validity-observed="false"')
    expect(html).not.toContain('data-total="0"')
  })

  it('never grants a folder link or compose action from a bare observed label', () => {
    const html = renderV2MailSidebar(t, { ...common, canCompose: false, folders: [], customFolders: [{ id: 'Orders', label: 'Orders', current: false }] }, {})
    expect(html).not.toContain('href="/mail/compose"')
    expect(html).not.toContain('href="/mail/inbox?folder=Orders"')
    expect(html).toContain('data-mail-folder="Orders"')
    expect(html).not.toContain('role="meter"')
  })

  it('keeps mailbox quota unknown without inventing an empty usage meter', () => {
    const html = renderV2MailSidebar(t, common, {})
    expect(html).toContain('data-mail-quota-value>—')
    expect(html).not.toContain('aria-valuenow="0"')
  })

  it('preserves authored draft fields and escapes rich-looking draft text', () => {
    const html = renderV2MailCompose(t, compose({ draft: { to: 'one@example.test', cc: 'two@example.test', bcc: 'hidden@example.test', subject: 'Draft <subject>', body: '<script>alert(1)</script>' } }))
    expect(html).toContain('id="compose-bcc"')
    expect(html).toContain('value="hidden@example.test"')
    expect(html).toContain('value="Draft &lt;subject&gt;"')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script')
  })

  it('keeps send, identity, attachment and draft controls disabled until actual readiness checks', () => {
    const html = renderV2MailCompose(t, compose({ canSend: true, canSaveDraft: true }))
    expect(html).toContain('data-compose-send-enabled="true"')
    expect(html).toContain('data-compose-identities-state="unread"')
    expect(html).toMatch(/data-mail-send="true" disabled/)
    expect(html).toMatch(/data-mail-action="save-draft" disabled/)
    expect(html).toContain('Draft saving has not been checked.')
    expect(html).not.toContain('The mail server accepted the message.')
    expect(html).not.toContain('Draft saved and read back')
  })

  it('preserves the whole-second vacation controls and source-only HTML editor', () => {
    const html = renderV2MailCompose(t, compose())
    expect(html).toMatch(/name="startDate" type="datetime-local" dir="ltr" step="1" disabled/)
    expect(html).toMatch(/name="endDate" type="datetime-local" dir="ltr" step="1" disabled/)
    expect(html).toMatch(/name="replyIntervalHours" type="number" dir="ltr" min="1" max="8760" step="1" required disabled/)
    expect(html).toContain('HTML is edited as source only and is never rendered here.')
    expect(html).toContain('data-vacation-preview')
  })

  it('displays saved identity data as plain text, with explicit unread values when absent', () => {
    const html = renderV2MailCompose(t, compose({ identity: { dkim: '<b>stored</b>' } }))
    expect(html).toContain('&lt;b&gt;stored&lt;/b&gt;')
    expect(html).not.toContain('<b>stored</b>')
    expect(html).toContain('data-compose-reply-to')
    expect(html).toContain('Not read')
  })

  it('renders Arabic core labels while preserving ASCII digits and isolated mailbox addresses', () => {
    const html = renderV2MailCompose(v2Messages.translator('ar'), compose())
    expect(html).toContain('<bdi dir="ltr">owner@example.test</bdi>')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it('passes props to the authoritative projector and emits one shell without a second controller', () => {
    const props = { mailbox: common.mailbox, locale: 'en' as const, activeRoute: '/mail/inbox' }
    let projected: unknown
    const render = createV2MailSurface(input => { projected = input; return inbox() }, () => '<p>Unavailable</p>')
    const html = render(props)
    expect(projected).toBe(props)
    expect(html.match(/id="main-content"/g)).toHaveLength(1)
    expect(html.match(/id="xp-sidebar"/g)).toHaveLength(1)
    expect(html).not.toContain('xmail-compose-client')
    expect(html).not.toContain('xp-board-port')
  })

  it('delegates missing or unsupported mailbox projections to core without rendering private mailbox data', () => {
    const props = { mailbox: common.mailbox, messages: [] }
    let forwarded: unknown
    const html = createV2MailSurface(() => undefined, input => { forwarded = input; return '<section data-core-unavailable>Unavailable</section>' })(props)
    expect(forwarded).toBe(props)
    expect(html).toBe('<section data-core-unavailable>Unavailable</section>')
    expect(html).not.toContain(common.mailbox)
    expect(html).not.toContain('No messages in this folder.')
  })

  it('renders async feedback exactly once without displaying a private job identity', () => {
    const html = createV2MailSurface(() => inbox({ actionState: { state: 'conflict', preserveDraft: true, jobId: 'private-routing-identity' } }), () => '')({})
    expect(html.match(/data-action-state="conflict"/g)).toHaveLength(1)
    expect(html).toContain('data-preserve-draft="true"')
    expect(html).toContain('Unnumbered')
    expect(html).not.toContain('private-routing-identity')
  })

  it('opens the supported search workspace without a form that would discard a submitted query', () => {
    const html = createV2MailSurface(() => inbox({ searchHref: '/mail/search' }), () => '')({})
    expect(html).toContain('class="v2-btn v2-mail-search" href="/mail/search?lang=en&amp;theme=light"')
    expect(html).not.toContain('action="/mail/search"')
  })
})
