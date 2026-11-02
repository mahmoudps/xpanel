import { describe, expect, it } from 'vitest'
import { navigation, registeredDocumentAliases, tools, type VisibilityContext } from '@xpanel/catalog'
import type { MailSurfaceProps } from '../surfaces/xmail.ts'
import { MAIL_WORKSPACE_ROUTES, projectMailSurfaceView, projectMailView } from './mail.ts'

const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const visibility: VisibilityContext = { principal: { kind: 'user', id: 'mail-owner', username: 'owner', accountId: 'account-mail' }, disabledFeatures: new Set() }
const props = (changes: Partial<MailSurfaceProps> = {}): MailSurfaceProps => ({ mailbox: 'owner@example.test', visibility, catalog, ...changes })
const documents = [
  ...navigation.find(surface => surface.surface === 'xmail')!.sections.flatMap(section => section.pages.map(page => page.route)),
  ...registeredDocumentAliases.filter(alias => alias.route.startsWith('/mail/')).map(alias => alias.route),
]

describe('complete neutral mailbox surface projection', () => {
  it.each(documents)('projects the registered document %s without provider reads', route => {
    const view = projectMailSurfaceView(props({ activeRoute: route }))
    expect(view?.route).toBe(route)
    expect(view?.mailbox).toBe('owner@example.test')
    expect(view?.quota).toEqual({ text: '—', percent: null })
    if (view?.kind === 'workspace') {
      expect(view.canRead).toBe(true)
      expect(view.authorizedRoutes.has(route)).toBe(true)
      expect(view.folders.every(folder => !folder.current && folder.count === undefined)).toBe(true)
      expect(view).not.toHaveProperty('messages')
    }
  })

  it('keeps the dedicated inbox/compose projection unchanged and covers exactly the remaining documents', () => {
    const dedicated = new Set(['/mail/inbox', '/mail/compose', '/mail/sent', '/mail/drafts', '/mail/trash'])
    expect([...MAIL_WORKSPACE_ROUTES].sort()).toEqual(documents.filter(route => !dedicated.has(route)).sort())
    for (const route of dedicated) expect(projectMailSurfaceView(props({ activeRoute: route }))).toEqual(projectMailView(props({ activeRoute: route })))
    expect(projectMailView(props({ activeRoute: '/mail/calendar' }))).toBeUndefined()
    expect(projectMailSurfaceView(props({ activeRoute: '/mail' }))?.route).toBe('/mail/inbox')
  })

  it('never grants a workspace from mailbox text alone, another surface role or an unknown document', () => {
    for (const input of [
      props({ mailbox: undefined, activeRoute: '/mail/folders' }),
      props({ visibility: undefined, activeRoute: '/mail/folders' }),
      props({ visibility: { principal: { kind: 'root', id: 'root', username: 'root' } }, activeRoute: '/mail/folders' }),
      props({ activeRoute: '/mail/private-unregistered' }),
      props({ activeRoute: '/whm/accounts' }),
    ]) expect(projectMailSurfaceView(input)).toBeUndefined()
  })

  it('keeps the search alias capability independent from its Inbox document parent', () => {
    const disabled = { ...visibility, disabledFeatures: new Set(['webmail-search']) }
    expect(projectMailSurfaceView(props({ activeRoute: '/mail/inbox', visibility: disabled }))?.kind).toBe('inbox')
    expect(projectMailSurfaceView(props({ activeRoute: '/mail/search', visibility: disabled }))).toBeUndefined()
    const unqualified = catalog.map(tool => tool.id === 'webmail-search' ? { ...tool, delivery: { ...tool.delivery, status: 'implemented' as const } } : tool)
    expect(projectMailSurfaceView(props({ activeRoute: '/mail/search', catalog: unqualified }))).toBeUndefined()
  })

  it('respects the team allowlist and does not turn a route shortcut into unrelated tool authority', () => {
    const narrow: VisibilityContext = { ...visibility, allowedToolIds: new Set(['webmail-search']) }
    const view = projectMailSurfaceView(props({ activeRoute: '/mail/later', visibility: narrow }))
    expect(view).toMatchObject({ kind: 'workspace', searchAvailable: true, attachmentsAvailable: false, quotaAvailable: false, canCompose: false })
    if (view?.kind !== 'workspace') throw new Error('Expected the scoped search workspace')
    expect(view.authorizedRoutes.has('/mail/compose')).toBe(false)
    expect(view.authorizedRoutes.has('/mail/tools/disk-usage')).toBe(false)
    expect(view.searchHref).toBeUndefined()
    expect(projectMailSurfaceView(props({ activeRoute: '/mail/folders', visibility: narrow }))).toBeUndefined()
  })

  it('preserves actual quota/folder observations and action outcomes without synthesizing workspace records', () => {
    const actionState = { state: 'conflict' as const, preserveDraft: true, errorCode: 'STALE_REVISION' }
    const view = projectMailSurfaceView(props({ activeRoute: '/mail/overview', activeFolder: 'Orders', quotaUsedMb: 0, quotaLimitMb: 100, folderCounts: [{ folder: 'INBOX', total: 5, unread: 0 }], actionState }))
    expect(view).toMatchObject({ kind: 'workspace', activeFolder: 'Orders', quota: { text: '0 / 100 MiB', percent: 0 }, quotaUsedMb: 0, quotaLimitMb: 100 })
    expect(view?.actionState).toBe(actionState)
    expect(view?.folders.find(folder => folder.id === 'INBOX')).toMatchObject({ count: 0, current: false })
    expect(view?.customFolders).toEqual([{ id: 'Orders', label: 'Orders', current: false, href: '/mail/inbox?folder=Orders' }])
    expect(view).not.toHaveProperty('contacts')
    expect(view).not.toHaveProperty('securityHtml')
  })
})
