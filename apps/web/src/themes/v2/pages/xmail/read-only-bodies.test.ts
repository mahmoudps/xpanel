import { describe, expect, it } from 'vitest'
import { parseMarkup } from '../../../markup.ts'
import { v2Messages } from '../../messages.ts'
import { renderV2MailInbox } from './inbox.ts'
import { renderV2MailCompose } from './compose.ts'
import { renderV2MailVacation } from './vacation.ts'
import type { MailInboxView, MailComposeView } from './types.ts'
import { ctx } from './workspaces/common.ts'
import { mailWorkspaceRoutes, renderV2MailWorkspace, type MailWorkspaceInput } from './workspaces/index.ts'

const t = v2Messages.translator('en')
const common = { mailbox: 'owner@example.test', route: '/mail/inbox', title: 'Inbox', quota: { text: '—', percent: null }, folders: [], customFolders: [], canCompose: true } as const
const inbox: MailInboxView = { ...common, kind: 'inbox', folder: 'INBOX', folderWorkspace: true, state: 'unread', messages: [], selectedKey: null, unreadCount: null, countText: '—', pager: '—', loaded: 0, total: null, moveTargets: [], canReadAttachments: true }
const compose: MailComposeView = { ...common, route: '/mail/compose', kind: 'compose', draft: { to: '', cc: '', bcc: '', subject: '', body: '' }, canSend: true, canSaveDraft: true, canUseAttachments: true, canManageVacation: true, identity: {}, vacation: null, rules: null }
const workspace: MailWorkspaceInput = { locale: 'en', mailbox: common.mailbox, route: '/mail/folders', canReadFacts: true, canRead: false, canManage: false, readOnly: true }
const find = (html: string, attribute: string) => parseMarkup(html).find(node => node.attrs.has(attribute))

describe('V2 read-only mailbox body authority', () => {
  it('keeps stored facts independent from native reads and rejects stale native flags in read-only mode', () => {
    expect(ctx({ ...workspace, canRead: true, canManage: true })).toMatchObject({ factsReadable: true, readable: false, editable: false })
    expect(ctx({ ...workspace, canReadFacts: false })).toMatchObject({ factsReadable: false, readable: false, editable: false })
    expect(ctx({ ...workspace, mailbox: '' })).toMatchObject({ factsReadable: false, readable: false, editable: false })
  })

  it('preserves all workspace layouts while blocking native controllers explicitly', () => {
    for (const route of mailWorkspaceRoutes) {
      const html = renderV2MailWorkspace({ ...workspace, route })!
      expect(find(html, 'data-mail-workspace-route')?.attrs.get('data-readonly'), route).toBe('true')
      expect(parseMarkup(html).filter(node => node.tag === 'h1'), route).toHaveLength(1)
    }
    const native = renderV2MailWorkspace({ ...workspace, readOnly: false, canRead: true, canManage: true })!
    expect(find(native, 'data-mail-workspace-route')?.attrs.has('data-readonly')).toBe(false)
  })

  it('shows only supplied quota facts without treating unknown usage as zero', () => {
    const known = renderV2MailWorkspace({ ...workspace, route: '/mail/overview', quotaUsedMb: 2, quotaLimitMb: 10 })!
    expect(known).toContain('2 / 10 MiB')
    expect(known).toContain('value="20"')
    const unknown = renderV2MailWorkspace({ ...workspace, route: '/mail/overview', quotaLimitMb: 10 })!
    expect(unknown).toContain('— / 10 MiB')
    expect(unknown).not.toContain('<meter')
    const denied = renderV2MailWorkspace({ ...workspace, route: '/mail/overview', canReadFacts: false, quotaUsedMb: 2, quotaLimitMb: 10 })!
    expect(denied).not.toContain('2 / 10 MiB')
  })

  it('leaves the trusted account-security slot outside the native read-only blocker', () => {
    const html = renderV2MailWorkspace({ ...workspace, route: '/mail/settings/security', securityHtml: '<section data-trusted-account-security></section>' })!
    expect(find(html, 'data-trusted-account-security')).toBeDefined()
    expect(find(html, 'data-mail-workspace-route')?.attrs.has('data-readonly')).toBe(false)
  })

  it('keeps both inbox panes and dynamic templates without native folder or attachment authority', () => {
    const html = renderV2MailInbox(t, { ...inbox, readOnly: true })
    expect(find(html, 'data-mail-folder-workspace')?.attrs.get('data-readonly')).toBe('true')
    expect(find(html, 'data-mail-unread')?.attrs.get('data-mail-unread')).toBe('')
    expect(parseMarkup(html).filter(node => node.attrs.has('data-mail-pane'))).toHaveLength(2)
    expect(find(html, 'data-mail-folder-row-template')).toBeDefined()
    expect(find(html, 'data-mail-folder-reading-template')).toBeDefined()
    expect(find(html, 'data-mail-attachments')?.attrs.get('data-attachment-can-read')).toBe('false')
    expect(parseMarkup(html).find(node => node.attrs.get('data-mail-action') === 'refresh')?.attrs.has('disabled')).toBe(true)
    expect(renderV2MailInbox(t, inbox)).not.toContain('data-readonly="true"')
  })

  it('preserves composer, sender and responder layouts while neutralizing independently granted capabilities', () => {
    const html = renderV2MailCompose(t, { ...compose, readOnly: true })
    expect(find(html, 'data-board-port')?.attrs.get('data-readonly')).toBe('true')
    const editor = find(html, 'data-compose-form')!
    expect(editor.attrs.get('data-compose-send-enabled')).toBe('false')
    expect(editor.attrs.get('data-compose-draft-enabled')).toBe('false')
    expect(find(html, 'data-compose-attachments')?.attrs.get('data-compose-attachment-enabled')).toBe('false')
    expect(find(html, 'data-mail-vacation')?.attrs.get('data-vacation-manage')).toBe('false')
    expect(parseMarkup(html).find(node => node.attrs.get('id') === 'compose-body')?.attrs.get('contenteditable')).toBe('false')
    expect(html).toContain('Saved record not read.')
    expect(renderV2MailCompose(t, compose)).not.toContain('data-readonly="true"')
    const vacation = renderV2MailVacation(t, { ...compose, readOnly: true })
    expect(find(vacation, 'data-mail-vacation')?.attrs.get('data-readonly')).toBe('true')
    expect(find(vacation, 'data-vacation-refresh')?.attrs.has('disabled')).toBe(true)
  })
})
