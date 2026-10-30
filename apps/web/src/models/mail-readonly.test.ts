import { describe, expect, it } from 'vitest'
import { tools, type VisibilityContext } from '@xpanel/catalog'
import type { MailSurfaceProps, MailMessageItem } from '../surfaces/xmail.ts'
import { MAIL_WORKSPACE_ROUTES, projectMailSurfaceView, projectReadOnlyMailSurfaceView } from './mail.ts'
import { projectReadOnlyMailSurface } from './theme-surface.ts'

const catalog = tools.map(tool => ({ ...tool, status: 'implemented' as const, delivery: { ...tool.delivery, status: 'implemented' as const } }))
const visibility: VisibilityContext = { principal: { kind: 'user', id: 'mail-user', username: 'owner', accountId: 'owned-account' }, disabledFeatures: new Set() }
const props = (changes: Partial<MailSurfaceProps> = {}): MailSurfaceProps => ({ mailbox: 'owner@example.test', visibility, catalog, activeRoute: '/mail/inbox', ...changes })
const message: MailMessageItem = { uid: 7, folder: 'INBOX', from: 'sender@example.test', to: 'owner@example.test', subject: 'Saved subject', preview: 'Saved preview', body: 'Private saved body', receivedAt: '2026-10-30T00:00:00Z', unread: true, attachments: [{ name: 'saved.txt', sizeBytes: 12 }] }
const readOnly = (input: MailSurfaceProps) => {
  const projected = projectReadOnlyMailSurface(input)
  if (!projected) throw new Error('Expected role-admitted read-only fixture')
  return projectReadOnlyMailSurfaceView(projected.props, projected.authority)
}

describe('stored mailbox read-only presentation authority', () => {
  it.each(['/mail/inbox', '/mail/compose', '/mail/sent', '/mail/drafts', '/mail/trash', ...MAIL_WORKSPACE_ROUTES])('preserves the registered %s layout without native qualification or identity fabrication', route => {
    const input = props({ activeRoute: route, mailbox: undefined })
    expect(projectMailSurfaceView(input)).toBeUndefined()
    const view = readOnly(input)
    expect(view).toMatchObject({ route, mailbox: '', readOnly: true, canReadFacts: false, canRead: false, canManage: false, canCompose: false, quota: { text: '—', percent: null } })
    if (view?.kind === 'inbox') expect(view).toMatchObject({ state: 'unread', total: null, unreadCount: null, messages: [], canReadAttachments: false, moveTargets: [] })
    if (view?.kind === 'compose') expect(view).toMatchObject({ canSend: false, canSaveDraft: false, canUseAttachments: false, canManageVacation: false, vacation: null, rules: null })
  })

  it('preserves supplied observations but never enables native controls even with all tool grants', () => {
    const view = readOnly(props({ messages: [message], selectedUid: 7, quotaUsedMb: 2, quotaLimitMb: 10 }))
    expect(view).toMatchObject({ kind: 'inbox', state: 'messages', total: 1, canRead: false, canManage: false, canReadAttachments: false, quota: { text: '2 / 10 MiB', percent: 20 } })
    if (view?.kind !== 'inbox') throw new Error('Expected inbox')
    expect(view.messages[0]).toMatchObject({ uid: 7, body: message.body, attachments: [{ name: 'saved.txt' }] })
    expect(projectMailSurfaceView(props({ messages: [message] }))).toBeUndefined()
  })

  it('intersects actual team authorization independently for listing, body, attachments and quota', () => {
    const input = props({ visibility: { ...visibility, allowedToolIds: new Set(['webmail-message-list']) }, messages: [message], quotaUsedMb: 2, quotaLimitMb: 10 })
    const view = readOnly(input)
    expect(view).toMatchObject({ kind: 'inbox', state: 'messages', quota: { text: '—', percent: null } })
    if (view?.kind !== 'inbox') throw new Error('Expected inbox')
    expect(view.messages[0]).toMatchObject({ subject: message.subject, body: '', bodyPending: true, attachments: [] })
    expect(view.securityHref).toBeUndefined()
  })

  it('does not let a broad supplied authority override the actual feature or team fence', () => {
    const broad = projectReadOnlyMailSurface(props())!.authority
    const input = props({ messages: [message], folderCounts: [{ folder: 'INBOX', total: 1, unread: 1 }], visibility: { ...visibility, disabledFeatures: new Set(['webmail-message-list']), allowedToolIds: new Set(['webmail-message-list']) } })
    const view = projectReadOnlyMailSurfaceView(input, broad)
    expect(view).toMatchObject({ kind: 'inbox', state: 'unread', messages: [], total: null })
    expect(view?.folders.every(folder => folder.count === undefined)).toBe(true)
  })

  it('keeps unread and observed empty lists distinct and strips all facts when authority denies them', () => {
    expect(readOnly(props())?.kind).toBe('inbox')
    expect(readOnly(props({ messages: [] }))).toMatchObject({ kind: 'inbox', state: 'empty', total: 0 })
    const input = props({ messages: [message], quotaUsedMb: 2, quotaLimitMb: 10 })
    const authority = { ...projectReadOnlyMailSurface(input)!.authority, canReadFacts: false }
    expect(projectReadOnlyMailSurfaceView(input, authority)).toMatchObject({ kind: 'inbox', state: 'unread', messages: [], quota: { text: '—', percent: null } })
  })

  it('separates draft, responder, filter and identity facts while all composition actions stay disabled', () => {
    const input = props({ activeRoute: '/mail/compose', composeDraft: { to: 'to@example.test', cc: '', subject: 'Stored draft', body: 'Draft body' }, vacationEnabled: true, identityDkim: 'Stored selector', sieveRules: [{ id: 'rule-a', name: 'Rule', condition: 'all', action: 'keep', enabled: true }], visibility: { ...visibility, allowedToolIds: new Set(['webmail-compose']) } })
    expect(readOnly(input)).toMatchObject({ kind: 'compose', draft: { subject: 'Stored draft', body: 'Draft body' }, vacation: null, rules: null, identity: {}, canSend: false, canSaveDraft: false, canUseAttachments: false, canManageVacation: false })
  })

  it('rejects live-mode authority, missing/other-surface identities and unregistered routes', () => {
    const authority = projectReadOnlyMailSurface(props())!.authority
    for (const input of [props({ visibility: undefined }), props({ visibility: { principal: { kind: 'root', id: 'root', username: 'root' } } }), props({ activeRoute: '/mail/unregistered' }), props({ activeRoute: '/whm/accounts' })]) expect(projectReadOnlyMailSurfaceView(input, authority)).toBeUndefined()
    expect(projectReadOnlyMailSurfaceView(props(), { ...authority, presentation: 'live' })).toBeUndefined()
  })
})
