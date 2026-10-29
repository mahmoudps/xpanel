/// <reference lib="dom" />
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { tools, navigation, registeredDocumentAliases, canonicalNavigationRoute, canOpenRegisteredRoute, visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { serveWebUi } from './app.ts'
import { resolveWebDocumentRoute } from './document-routes.ts'
import { renderMailSurface, type MailSurfaceProps } from './surfaces/xmail.ts'

const mailbox = 'reader@example.test'
const visibility: VisibilityContext = { principal: { kind: 'user', id: 'synthetic-owner', username: 'owner', accountId: 'synthetic-account' }, disabledFeatures: new Set() }
// Qualification exists only in this synthetic renderer fixture; it is no release/native evidence.
const qualified: CatalogTool[] = tools.map(tool => tool.status === 'out-of-scope' ? tool : { ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Synthetic functional-surface test only.', evidence: [] } })
const routes = ['/mail/search', '/mail/settings/calendars', '/mail/compose']
const features = ['webmail-message-read', 'webmail-attachments', 'webmail-search', 'webmail-compose', 'webmail-dav-collections', 'webmail-dav-sharing', 'webmail-dav-config']
const unqualified: CatalogTool[] = qualified.map(tool => features.includes(tool.id) ? { ...tool, status: 'implemented', delivery: { status: 'implemented', reason: 'Deliberately unqualified test capability.', evidence: [] } } : tool)
const page = (route: string, locale: 'en' | 'ar', extra: Partial<MailSurfaceProps> = {}) => new DOMParser().parseFromString(renderMailSurface({ activeRoute: route, locale, mailbox, catalog: qualified, visibility, ...extra }), 'text/html')
const shell = (document: Document) => {
  expect(document.querySelectorAll('main')).toHaveLength(1); expect(document.querySelectorAll('h1')).toHaveLength(1)
  expect(document.querySelectorAll('[data-mail-pane="folders"]')).toHaveLength(1)
  expect(document.querySelector('[data-xp-sidebar]')).not.toBeNull(); expect(document.querySelector('[data-xp-shell-content]')).not.toBeNull()
  expect(document.querySelector('[data-surface="xmail"]')).not.toBeNull()
}
const gate = (document: Document, route: string, expected: boolean) => {
  if (route === '/mail/search') expect(document.querySelector<HTMLElement>('[data-mail-search-workspace]')!.dataset.searchEnabled).toBe(String(expected))
  else if (route === '/mail/settings/calendars') expect(document.querySelector<HTMLElement>('[data-mail-calendar]')!.dataset.calendarManage).toBe(String(expected))
  else {
    const group = document.querySelector<HTMLElement>('[data-compose-identities]')!
    expect(group.dataset.composeSendEnabled).toBe(String(expected)); expect(group.dataset.composeDraftEnabled).toBe(String(expected))
    expect(group.querySelector<HTMLElement>('[data-compose-attachments]')!.dataset.composeAttachmentEnabled).toBe(String(expected))
  }
}

describe.each(['en', 'ar'] as const)('functional mail surface in %s', locale => {
  it('mounts qualified search with one mailbox-pinned empty attachment widget and preserved shell', () => {
    const document = page('/mail/search', locale)
    shell(document); gate(document, '/mail/search', true)
    const root = document.querySelector<HTMLElement>('[data-mail-search-workspace]')!
    expect(root.dataset.searchMailbox).toBe(mailbox)
    for (const hook of ['data-mail-search-form', 'data-mail-search-query', 'data-mail-search-folder', 'data-mail-search-submit', 'data-mail-search-clear', 'data-mail-search-next', 'data-mail-search-message']) expect(root.querySelectorAll('[' + hook + ']')).toHaveLength(1)
    const attachments = root.querySelector<HTMLElement>('[data-mail-attachments]')!
    expect(attachments.dataset.mailbox).toBe(mailbox); expect(attachments.dataset.uid).toBe(''); expect(attachments.dataset.uidValidity).toBe('')
    expect(attachments.dataset.attachmentCanRead).toBe('true'); expect(attachments.querySelector('[data-attachment-download]')).toBeNull()
  })

  it('mounts the qualified calendar editor and every stored-record action within the existing mail shell', () => {
    const document = page('/mail/settings/calendars', locale)
    shell(document); gate(document, '/mail/settings/calendars', true)
    const root = document.querySelector<HTMLElement>('[data-mail-calendar]')!
    expect(root.dataset.calendarMailbox).toBe(mailbox)
    for (const key of ['refresh', 'new', 'save', 'delete', 'event-new', 'event-save', 'event-delete', 'share', 'import', 'export', 'download']) expect(root.querySelectorAll('[data-calendar-' + key + ']')).toHaveLength(1)
    expect(root.querySelector('[data-calendar-authority-guidance]')).not.toBeNull()
    expect(document.querySelector('[data-nav-route="/mail/settings/calendars"][aria-current="page"]')).not.toBeNull()
  })

  it('derives compose Send/Draft/file capability from trusted qualified navigation and preserves the native submission boundary', () => {
    const document = page('/mail/compose', locale)
    shell(document); gate(document, '/mail/compose', true)
    const group = document.querySelector<HTMLElement>('[data-compose-form="true"]')!
    expect(group.dataset.composeMailbox).toBe(mailbox); expect(group.tagName).toBe('DIV'); expect(group.closest('form')).toBeNull()
    for (const selector of ['[data-mail-send]', '[data-mail-action="save-draft"]']) {
      const button = group.querySelector<HTMLButtonElement>(selector)!
      expect(button.type).toBe('button'); expect(button.form).toBeNull(); expect(button.disabled).toBe(true)
    }
    expect(group.querySelector<HTMLInputElement>('[data-compose-attachment-input]')!.type).toBe('file')
    for (const id of ['compose-to', 'compose-cc', 'compose-bcc', 'compose-subject', 'compose-body']) expect(group.querySelector('#' + id)).not.toBeNull()
  })

  it('keeps direct routes visible while unqualified capabilities remain unavailable', () => {
    for (const route of routes) {
      const document = page(route, locale, { catalog: unqualified })
      shell(document); gate(document, route, false)
      if (route === '/mail/search') { expect(document.querySelector<HTMLInputElement>('[data-mail-search-query]')!.disabled).toBe(true); expect(document.querySelector<HTMLElement>('[data-mail-attachments]')!.dataset.attachmentCanRead).toBe('false') }
      if (route === '/mail/settings/calendars') expect(document.querySelector<HTMLButtonElement>('[data-calendar-save]')!.disabled).toBe(true)
    }
  })

  it('does not let route presence or unrelated qualified tools bypass missing feature context', () => {
    for (const route of routes) for (const context of [undefined, { ...visibility, disabledFeatures: undefined }, { ...visibility, disabledFeatures: new Set(features) }]) gate(page(route, locale, { visibility: context }), route, false)
  })

  it('escapes and pins the actual mailbox consistently without rendering an editable authority selector', () => {
    for (const owner of ['other+tag@example.test', '"><img src=x onerror=alert(1)>']) for (const route of routes) {
      const document = page(route, locale, { mailbox: owner })
      expect(document.querySelector('img[src="x"]')).toBeNull()
      const root = document.querySelector<HTMLElement>(route === '/mail/search' ? '[data-mail-search-workspace]' : route === '/mail/settings/calendars' ? '[data-mail-calendar]' : '[data-compose-identities]')!
      expect(root.dataset[route === '/mail/search' ? 'searchMailbox' : route === '/mail/settings/calendars' ? 'calendarMailbox' : 'composeMailbox']).toBe(owner)
      expect(root.querySelector('input[name="mailbox"],select[name="mailbox"]')).toBeNull()
    }
  })

  it('does not treat Inbox summary UID or attachment names as an observed attachment identity', () => {
    const document = page('/mail/inbox', locale, { selectedUid: 17, messages: [{ uid: 17, folder: 'INBOX', from: 'sender@example.test', to: mailbox, subject: 'Observed summary', preview: '', body: '', bodyPending: true, receivedAt: '2026-10-26T00:00:00Z', unread: false, attachments: [{ name: 'summary-only.pdf', sizeBytes: 17 }] }] })
    shell(document)
    const root = document.querySelector<HTMLElement>('[data-mail-attachments]')!
    expect(root).not.toBeNull(); expect(root.dataset.mailbox).toBe(mailbox); expect(root.dataset.uid).toBe(''); expect(root.dataset.uidValidity).toBe('')
    expect(root.querySelector('[data-attachment-download]')).toBeNull(); expect(root.querySelector('[data-attachment-list]')!.childElementCount).toBe(0)
  })

  it('withholds private payloads and all functional widgets without a mailbox context', () => {
    for (const route of routes) {
      const document = page(route, locale, { mailbox: undefined, messages: [{ uid: 17, folder: 'INBOX', from: 'sender@example.test', to: 'private-marker@example.test', subject: 'private-subject-marker', preview: '', body: 'private-body-marker', receivedAt: '2026-10-26T00:00:00Z', unread: false }] })
      expect(document.querySelector('[data-mail-search-workspace],[data-mail-calendar],[data-compose-identities]')).toBeNull()
      expect(document.body.textContent).not.toContain('private-subject-marker'); expect(document.body.textContent).not.toContain('private-body-marker')
    }
  })
})


describe('registered mail app documents and qualified attachment reads', () => {
  const parseResponse = async (route: string, locale: 'en' | 'ar', options: { visibility?: VisibilityContext; catalog?: readonly CatalogTool[]; mailbox?: string } = {}) => {
    const response = await serveWebUi(new Request('http://localhost' + route + '?lang=' + locale + '&mailbox=foreign-query%40example.test&uid=1&uidValidity=1&attachmentReadEnabled=true'), () => ({
      surface: 'xmail', visibility, catalog: qualified, ...options,
      mail: { mailbox: options.mailbox ?? mailbox, messages: [] },
    }))
    return { response, document: new DOMParser().parseFromString(await response.text(), 'text/html') }
  }
  const readSummary = { uid: 17, folder: 'INBOX', from: 'sender@example.test', to: mailbox, subject: 'Summary cannot authorize downloads', preview: '', body: '', bodyPending: true, receivedAt: '2026-10-26T00:00:00Z', unread: false }

  it('registers exactly one search alias with Inbox roles while preserving navigation and tool qualification', () => {
    const before = JSON.stringify({ navigation, tools })
    expect(registeredDocumentAliases.filter(row => row.route === '/mail/search')).toEqual([{ route: '/mail/search', parentRoute: '/mail/inbox' }])
    expect(canonicalNavigationRoute('/mail/search')).toBe('/mail/inbox')
    expect(resolveWebDocumentRoute('/mail/search')).toEqual({ surface: 'xmail', activeRoute: '/mail/search' })
    expect(canOpenRegisteredRoute('/mail/search', visibility)).toBe(true)
    for (const context of [undefined, { principal: { kind: 'root' as const, id: 'root', username: 'owner' } }, { principal: { kind: 'reseller' as const, id: 'reseller', username: 'owner' }, reseller: { acl: [] } }]) expect(canOpenRegisteredRoute('/mail/search', context)).toBe(false)
    expect(visibleNavigation(visibility, tools).some(surface => surface.sections.some(section => section.pages.some(item => item.route === '/mail/search')))).toBe(false)
    expect(JSON.stringify({ navigation, tools })).toBe(before)
  })

  it.each(['en', 'ar'] as const)('serves the actual qualified Search document in %s with sealed mailbox and no UID defaults', async locale => {
    const { response, document } = await parseResponse('/mail/search', locale)
    expect(response.status).toBe(200); shell(document)
    expect(document.querySelector('h1')!.textContent).toBe(locale === 'ar' ? 'البحث في البريد' : 'Search mail')
    expect(document.title).toBe((locale === 'ar' ? 'البحث في البريد' : 'Search mail') + ' — xMail')
    const root = document.querySelector<HTMLElement>('[data-mail-search-workspace]')!
    expect(root.dataset.searchEnabled).toBe('true'); expect(root.dataset.searchMailbox).toBe(mailbox)
    const attachments = root.querySelector<HTMLElement>('[data-mail-attachments]')!
    expect(attachments.dataset.attachmentCanRead).toBe('true'); expect(attachments.dataset.mailbox).toBe(mailbox)
    expect(attachments.dataset.uid).toBe(''); expect(attachments.dataset.uidValidity).toBe('')
  })

  it.each(['en', 'ar'] as const)('serves the actual Calendar document in %s with the retained mailbox shell', async locale => {
    const { response, document } = await parseResponse('/mail/settings/calendars', locale)
    expect(response.status).toBe(200); shell(document)
    expect(document.querySelector('h1')!.textContent).toBe(locale === 'ar' ? 'التقويمات والأحداث' : 'Calendars and events')
    expect(document.title).toBe((locale === 'ar' ? 'التقويمات والأحداث' : 'Calendars and events') + ' — xMail')
    expect(document.querySelector<HTMLElement>('[data-mail-calendar]')!.dataset.calendarMailbox).toBe(mailbox)
    expect(document.querySelector<HTMLElement>('[data-mail-calendar]')!.dataset.calendarManage).toBe('true')
  })

  it.each([
    { label: 'both features permitted', disabled: [] as string[], enabled: true },
    { label: 'message-read feature denied', disabled: ['webmail-message-read'], enabled: false },
    { label: 'attachment feature denied', disabled: ['webmail-attachments'], enabled: false },
    { label: 'both features denied', disabled: ['webmail-message-read', 'webmail-attachments'], enabled: false },
  ])('requires both qualified/visible read capabilities: $label', ({ disabled, enabled }) => {
    for (const locale of ['en', 'ar'] as const) {
      const context = { ...visibility, disabledFeatures: new Set(disabled) }
      const inbox = page('/mail/inbox', locale, { visibility: context, messages: [readSummary], selectedUid: 17 })
      const widget = inbox.querySelector<HTMLElement>('[data-mail-attachments]')!
      expect(widget.dataset.attachmentCanRead).toBe(String(enabled)); expect(widget.dataset.uid).toBe(''); expect(widget.dataset.uidValidity).toBe('')
      const search = page('/mail/search', locale, { visibility: context })
      expect(search.querySelector<HTMLElement>('[data-mail-search-workspace]')!.dataset.searchEnabled).toBe('true')
      expect(search.querySelector<HTMLElement>('[data-mail-attachments]')!.dataset.attachmentCanRead).toBe(String(enabled))
    }
  })

  it('does not substitute an enabled feature or unrelated verified tool for actual read qualification', () => {
    for (const missing of ['webmail-message-read', 'webmail-attachments']) {
      const catalog = qualified.map(tool => tool.id === missing ? { ...tool, status: 'implemented' as const, delivery: { ...tool.delivery, status: 'implemented' as const } } : tool)
      const document = page('/mail/inbox', 'en', { catalog, messages: [readSummary] })
      expect(document.querySelector<HTMLElement>('[data-mail-attachments]')!.dataset.attachmentCanRead).toBe('false')
    }
  })

  it.each(['en', 'ar'] as const)('enforces independent search denial and the app provider-data boundary in %s', async locale => {
    const searchDenied = await parseResponse('/mail/search', locale, { visibility: { ...visibility, disabledFeatures: new Set(['webmail-search']) } })
    expect(searchDenied.response.status).toBe(200)
    expect(searchDenied.document.querySelector<HTMLElement>('[data-mail-search-workspace]')!.dataset.searchEnabled).toBe('false')
    expect(searchDenied.document.querySelector<HTMLInputElement>('[data-mail-search-query]')!.disabled).toBe(true)
    expect(searchDenied.document.querySelector<HTMLElement>('[data-mail-attachments]')!.dataset.attachmentCanRead).toBe('false')
    const readDenied = await parseResponse('/mail/search', locale, { visibility: { ...visibility, disabledFeatures: new Set(['webmail-message-read']) }, mailbox: 'private-app-mailbox-marker@example.test' })
    expect(readDenied.response.status).toBe(200)
    expect(readDenied.document.querySelector('[data-mail-unavailable="search"]')).not.toBeNull()
    expect(readDenied.document.querySelector<HTMLElement>('[data-mail-search-workspace]')!.dataset.searchMailbox).toBe('')
    expect(readDenied.document.body.textContent).not.toContain('private-app-mailbox-marker')
    const attachmentDenied = await parseResponse('/mail/search', locale, { visibility: { ...visibility, disabledFeatures: new Set(['webmail-attachments']) } })
    expect(attachmentDenied.document.querySelector<HTMLElement>('[data-mail-search-workspace]')!.dataset.searchEnabled).toBe('true')
    expect(attachmentDenied.document.querySelector<HTMLElement>('[data-mail-attachments]')!.dataset.attachmentCanRead).toBe('false')
  })

  it.each(['en', 'ar'] as const)('does not expose provider mailbox data to absent/root/reseller document roles in %s', async locale => {
    for (const context of [undefined, { principal: { kind: 'root' as const, id: 'root', username: 'owner' } }, { principal: { kind: 'reseller' as const, id: 'reseller', username: 'owner' }, reseller: { acl: [] } }]) {
      const { document } = await parseResponse('/mail/search', locale, { visibility: context, mailbox: 'private-role-mailbox-marker@example.test' })
      expect(document.body.textContent).not.toContain('private-role-mailbox-marker')
      expect(document.querySelector('[data-mail-search-workspace][data-search-enabled="true"]')).toBeNull()
      expect(document.querySelector('[data-mail-attachments][data-attachment-can-read="true"]')).toBeNull()
    }
  })

  it.each(['en', 'ar'] as const)('does not promote Inbox qualification merely by registering its Search subdocument in %s', async locale => {
    const catalog = tools.map(tool => tool.id === 'webmail-search' ? qualified.find(item => item.id === tool.id)! : tool)
    const { document } = await parseResponse('/mail/search', locale, { catalog, mailbox: 'private-unqualified-mailbox-marker@example.test' })
    expect(document.querySelector('[data-tool-availability="unverified"]')).not.toBeNull()
    expect(document.querySelector('[data-mail-unavailable="search"]')).not.toBeNull()
    expect(document.querySelector<HTMLElement>('[data-mail-search-workspace]')!.dataset.searchEnabled).toBe('false')
    expect(document.body.textContent).not.toContain('private-unqualified-mailbox-marker')
    for (const tag of document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) if (tag.closest('[data-mail-unavailable="search"]')) expect(tag.disabled).toBe(true)
  })

  it('mounts the calendar view only when /mail/calendar is qualified', () => {
    const on = page('/mail/calendar', 'en'); shell(on)
    expect(on.querySelector<HTMLElement>('[data-mail-calendar-view]')!.dataset.calendarViewManage).toBe('true')
    const off = page('/mail/calendar', 'en', { catalog: qualified.map(tool => tool.id === 'webmail-calendar' ? { ...tool, status: 'implemented', delivery: { status: 'implemented', reason: 'unqualified', evidence: [] } } : tool) })
    expect(off.querySelector<HTMLElement>('[data-mail-calendar-view]')!.dataset.calendarViewManage).toBe('false')
  })
})
