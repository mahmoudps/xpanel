import { describe, expect, it } from 'vitest'
import { navigation, registeredDocumentAliases } from '@xpanel/catalog'
import { parseMarkup, matchesHook } from '../../../../markup.ts'
import { renderV2MailWorkspace, mailWorkspaceRoutes, MAIL_WORKSPACES_CSS, type MailWorkspaceInput } from './index.ts'

const base: MailWorkspaceInput = { locale: 'en', mailbox: 'owner@example.test', route: '/mail/folders', canRead: true, canManage: true, searchAvailable: true }
const render = (route: string, overrides: Partial<MailWorkspaceInput> = {}) => renderV2MailWorkspace({ ...base, route, ...overrides })!
const nodes = (html: string) => parseMarkup(html)
const booleanAttributes = new Set(['hidden', 'disabled', 'required', 'checked', 'readonly', 'multiple', 'download'])
const find = (html: string, hook: Parameters<typeof matchesHook>[1]) => {
  const node = nodes(html).find(candidate => matchesHook(candidate, hook))
  return node && { ...node, attributes: Object.fromEntries([...node.attrs].map(([name, value]) => [name, booleanAttributes.has(name) ? true : value])) }
}

describe('v2 sealed mailbox workspace pages', () => {
  it('covers every remaining registered mail document without taking over inbox, compose or unrelated routes', () => {
    const existing = new Set(['/mail/inbox', '/mail/compose', '/mail/sent', '/mail/drafts', '/mail/trash'])
    const registered = navigation.find(surface => surface.surface === 'xmail')!.sections.flatMap(group => group.pages.map(row => row.route))
    const aliases = registeredDocumentAliases.filter(row => row.route.startsWith('/mail/')).map(row => row.route)
    expect([...mailWorkspaceRoutes].sort()).toEqual([...registered, ...aliases].filter(route => !existing.has(route)).sort())
    for (const route of existing) expect(renderV2MailWorkspace({ ...base, route })).toBeUndefined()
    expect(renderV2MailWorkspace({ ...base, route: '/whm/accounts' })).toBeUndefined()
  })

  it('defaults every controller authority to unavailable instead of inferring permissions from mailbox text', () => {
    expect(render('/mail/folders', { canRead: undefined, canManage: true })).toContain('data-folders-can-manage="false"')
    expect(render('/mail/settings/identities', { canRead: true, canManage: undefined })).toContain('data-identities-manage="false"')
    expect(render('/mail/search', { canRead: false })).toContain('data-search-enabled="false"')
    expect(render('/mail/tools/track-delivery', { canRead: undefined })).toContain('data-track-can-read="false"')
    expect(render('/mail/folders', { mailbox: '' })).toContain('data-folders-can-manage="false"')
  })

  it('retains the folder create/rename/destructive confirmation contract and an unread table', () => {
    const html = render('/mail/folders')
    expect(find(html, '[data-mail-folders-create]')?.tag).toBe('form')
    expect(find(html, '[name="name"]')?.attributes).toMatchObject({ maxlength: '64', required: true, disabled: true })
    expect(find(html, '[name="parent"]')?.tag).toBe('select')
    expect(find(html, '[data-mail-folders-editor]')?.attributes.hidden).toBe(true)
    expect(find(html, '[name="confirm"]')?.attributes.type).toBe('checkbox')
    expect(find(html, '[data-mail-folders-rows]')?.tag).toBe('tbody')
    expect(html).toContain('Folders have not been read.')
  })

  it('never fabricates quota samples or populated cleanup results and retains preview/purge separation', () => {
    const html = render('/mail/tools/disk-usage')
    expect(find(html, '[data-mail-usage-meter]')?.attributes.hidden).toBe(true)
    expect(find(html, '[data-mail-usage-preview]')?.attributes.hidden).toBe(true)
    expect(find(html, '[data-mail-usage-purge-field]')?.attributes.hidden).toBe(true)
    expect(find(html, '[data-mail-usage-rows]')?.tag).toBe('tbody')
    expect(find(html, '[name="olderThanDays"]')?.attributes).toMatchObject({ min: '1', max: '36500', step: '1' })
    expect(find(html, '[name="largerThanMb"]')?.attributes).toMatchObject({ min: '1', max: '10240', step: '1' })
    expect(html).not.toContain('Cleanup completed')
  })

  it('keeps native search controls and an unbound attachment UID until message-read identity is available', () => {
    const html = render('/mail/search', { attachmentsAvailable: true, activeFolder: 'Archive' })
    expect(find(html, '[data-mail-search-form]')?.tag).toBe('form')
    expect(find(html, '[data-mail-search-query]')?.attributes).toMatchObject({ type: 'search', maxlength: '512' })
    expect(find(html, '[data-mail-search-results]')?.tag).toBe('ul')
    expect(find(html, '[data-mail-search-message]')?.attributes.hidden).toBe(true)
    expect(find(html, '[data-mail-attachments]')?.attributes).toMatchObject({ 'data-uid': '', 'data-uid-validity': '', 'data-folder': 'Archive', 'data-attachment-can-read': 'true' })
    expect(html).toContain('value="Archive" selected')
  })

  it('keeps search, quota and target-link permissions independent on More tools', () => {
    const html = render('/mail/later', { searchAvailable: false, quotaAvailable: false, authorizedRoutes: new Set(['/mail/inbox']) })
    expect(find(html, '[data-mail-tools-quota]')?.attributes['data-tools-available']).toBe('false')
    expect(find(html, '[data-mail-search-workspace]')?.attributes['data-search-enabled']).toBe('false')
    expect(html).toContain('href="/mail/inbox?lang=en"')
    expect(html).not.toContain('href="/mail/settings/forwarders?')
    expect(html.match(/<h1\b/g)).toHaveLength(1)
  })

  it('requires search capability explicitly on the search document and before enabling its attachment panel', () => {
    for (const searchAvailable of [false, undefined]) {
      const html = render('/mail/search', { searchAvailable, attachmentsAvailable: true })
      expect(find(html, '[data-mail-search-workspace]')?.attributes['data-search-enabled']).toBe('false')
      expect(find(html, '[data-mail-attachments]')?.attributes['data-attachment-can-read']).toBe('false')
      expect(find(html, '[data-mail-search-query]')?.attributes.disabled).toBe(true)
    }
  })

  it('preserves only mailbox scoped forwarding and its unsupported keep-copy-off state', () => {
    const html = render('/mail/settings/forwarders')
    expect(find(html, '[data-mail-forwarders]')?.attributes['data-forwarders-mailbox']).toBe(base.mailbox)
    expect(find(html, '[name="destination"]')?.attributes).toMatchObject({ type: 'email', maxlength: '254', dir: 'ltr', disabled: true })
    expect(find(html, '[name="keepCopy"]')?.attributes).toMatchObject({ checked: true, disabled: true, 'aria-describedby': 'mail-forwarders-copy' })
    expect(html).toContain('Forwarding without a copy is not supported.')
  })

  it('keeps Sieve rules, saved compilation and dry-run message testing as distinct operations', () => {
    const html = render('/mail/settings/filters')
    expect(find(html, '[data-filter-workspace]')?.attributes).toMatchObject({ 'data-filter-mailbox': base.mailbox, 'data-filter-account': '', 'data-filter-manage': 'true' })
    for (const hook of ['[data-filter-list]', '[data-filter-editor]', '[data-filter-conditions]', '[data-filter-actions]', '[data-filter-test]', '[data-filter-trace]', '[data-filter-preview]'] as const) expect(find(html, hook), hook).toBeDefined()
    expect(html).not.toContain('id="filter-scope"')
    expect(html).toContain('Nothing is delivered or sent.')
    expect(find(html, '[name="matchAll"]')?.tag).toBe('select')
  })

  it('retains whole-second UTC vacation bounds and source-only HTML editing without claiming application', () => {
    const html = render('/mail/settings/autoresponder')
    for (const name of ['startDate', 'endDate']) expect(find(html, `[name="${name}"]`)?.attributes).toMatchObject({ type: 'datetime-local', step: '1', disabled: true })
    expect(find(html, '[name="replyIntervalHours"]')?.attributes).toMatchObject({ min: '1', max: '8760', step: '1' })
    expect(find(html, '[data-vacation-preview]')?.attributes.hidden).toBe(true)
    expect(html).toContain('HTML is edited as source only and is never rendered here.')
    expect(html).not.toContain('Responder active')
  })

  it('retains identity ownership and signature source controls without rendering HTML from a record', () => {
    const html = render('/mail/settings/identities', { canManage: false })
    expect(find(html, '[data-identities-html-signature]')?.attributes).toMatchObject({ maxlength: '20000', spellcheck: 'false', disabled: true })
    expect(find(html, '[data-identities-save]')?.attributes.disabled).toBe(true)
    expect(html).toContain('older metadata may need review')
    expect(html).toContain('HTML is stored as source and is not rendered on this page.')
  })

  it('does not imply persisted mailbox preferences already change inbox or compose behavior', () => {
    const html = render('/mail/settings/preferences')
    expect(find(html, '[name="messagesPerPage"]')?.tag).toBe('select')
    expect(find(html, '[name="replyIdentityId"]')?.tag).toBe('select')
    expect(find(html, '[data-preferences-application]')).toBeDefined()
    expect(html).toContain('The inbox and compose pages do not apply them yet.')
  })

  it('preserves tracking privacy, cursor controls and independent selected message evidence', () => {
    const html = render('/mail/tools/track-delivery')
    expect(html).toContain('value="24" selected')
    expect(find(html, '[data-mail-track-rows]')?.tag).toBe('tbody')
    expect(find(html, '[data-mail-track-detail]')?.attributes.hidden).toBe(true)
    expect(find(html, '[data-mail-track-detail-recipients]')?.tag).toBe('tbody')
    expect(find(html, '[data-mail-track-detail-events]')?.tag).toBe('ol')
    expect(html).toContain('Other recipients of a message are shown only as a count.')
  })

  it('keeps device settings and setup downloads unread without a password or invented host', () => {
    const html = render('/mail/tools/connect-devices')
    expect(find(html, '[data-mail-devices-rows]')?.tag).toBe('tbody')
    expect(find(html, '[data-mail-devices-download="apple"]')?.attributes).toMatchObject({ hidden: true, 'aria-disabled': 'true', download: true })
    expect(html).not.toContain('smtp.example.test')
    expect(html).toContain('it is never shown here or included in setup files')
  })

  it('shows only explicitly supplied mailbox quota and never invents an unknown ratio', () => {
    expect(render('/mail/overview', { quotaLimitMb: 'unlimited' })).not.toContain('<meter')
    expect(render('/mail/overview', { quotaUsedMb: 0, quotaLimitMb: 100 })).toContain('value="0"')
    expect(render('/mail/overview', { canRead: false, quotaUsedMb: 50, quotaLimitMb: 100 })).not.toContain('<meter')
  })

  it('requires the core security slot rather than inventing an authentication editor', () => {
    expect(render('/mail/settings/security')).toContain('data-mail-security-unread')
    expect(render('/mail/settings/security', { securityHtml: '<section data-test-security>Verified slot</section>' })).toContain('data-test-security')
    expect(render('/mail/settings/security', { canRead: false, securityHtml: '<section data-test-security>Secret</section>' })).not.toContain('data-test-security')
  })

  it('escapes mailbox and folder facts, preserves technical isolation and emits no classic style aliases', () => {
    const html = render('/mail/search', { mailbox: '<img src=x onerror=alert(1)>', activeFolder: '<script>alert(1)</script>' })
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;img')
    expect(html).toContain('<bdi dir="ltr"')
    expect(html).not.toContain('class="xp-')
    expect(html).not.toContain('<style>')
  })

  it('keeps Arabic output in ASCII digits and stylesheet rules within the owned namespace', () => {
    const html = render('/mail/tools/disk-usage', { locale: 'ar' })
    expect(html).toMatch(/[\u0600-\u06ff]/u)
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/u)
    expect(MAIL_WORKSPACES_CSS).not.toContain('.xp-')
    expect(MAIL_WORKSPACES_CSS).not.toMatch(/text-align:(?:left|right)/u)
    expect(find(render('/mail/calendar', { locale: 'ar' }), '[data-mail-calendar-view]')?.attributes).toMatchObject({ lang: 'ar', dir: 'rtl' })
  })
})
