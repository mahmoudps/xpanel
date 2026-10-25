/// <reference lib="dom" />
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import { renderWebApp } from './app.ts'
import { renderMailSurface, type MailMessageItem, type MailSurfaceProps } from './surfaces/xmail.ts'

const message = (overrides: Partial<MailMessageItem> = {}): MailMessageItem => ({
  uid: 1, folder: 'INBOX', from: 'sender@example.test', to: 'owner@example.test',
  subject: 'Synthetic mail sample', preview: 'Synthetic preview', body: 'Synthetic body',
  receivedAt: '2026-10-23T00:00:00Z', sizeKb: 2, unread: true,
  dkimPass: false, spfPass: true, dmarcPass: false, ...overrides,
})
const fixture = (overrides: MailSurfaceProps = {}): MailSurfaceProps => ({
  mailbox: 'owner@example.test', messages: [message()],
  visibility: { principal: { kind: 'user', id: 'synthetic-owner', username: 'owner', accountId: 'synthetic-account' }, disabledFeatures: new Set() },
  // Qualification is deliberately local to this synthetic layout fixture.
  catalog: tools.map(tool => tool.status === 'out-of-scope' ? tool : ({ ...tool, status: 'verified' as const, delivery: { status: 'verified' as const, reason: 'Synthetic layout test only.', evidence: [] } })),
  activeRoute: '/mail/inbox', ...overrides,
})


// Parse real elements so script/CSS text cannot masquerade as a native form.
// The sole allowed form is read-only inbox search; sending stays client-mediated.
function expectLocalComposerSendBoundary(html: string, locale: 'en' | 'ar'): void {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const forms = [...document.forms]
  expect(forms).toHaveLength(1)
  const search = forms[0]!
  expect(search.getAttribute('role')).toBe('search')
  expect(search.getAttribute('action')).toBe('/mail/inbox')
  expect(search.getAttribute('method')).toBe('get')
  expect([...search.elements].map(control => ({
    tag: control.tagName, name: control.getAttribute('name'), type: (control as HTMLInputElement).type,
  }))).toEqual([
    { tag: 'INPUT', name: 'lang', type: 'hidden' },
    { tag: 'INPUT', name: 'theme', type: 'hidden' },
    { tag: 'INPUT', name: 'q', type: 'search' },
  ])
  expect(search.querySelector<HTMLInputElement>('[name="lang"]')?.value).toBe(locale)
  expect(search.querySelector('[data-compose-form], [data-mail-send], [id^="compose-"]')).toBeNull()
  expect([...document.querySelectorAll('[action]')]).toEqual([search])
  expect(document.querySelector('[form], [formaction], [formmethod], [onsubmit]')).toBeNull()
  const composer = document.querySelector('[data-compose-form="true"]')
  expect(composer?.tagName).toBe('DIV')
  expect(composer?.getAttribute('role')).toBe('group')
  expect(composer?.closest('form')).toBeNull()
  const send = document.querySelector<HTMLButtonElement>('[data-mail-send="true"]')
  expect(send?.tagName).toBe('BUTTON')
  expect(send?.type).toBe('button')
  expect(send?.form).toBeNull()
  const submitControls = [...document.querySelectorAll('button, input')].filter(control =>
    ['submit', 'image'].includes((control as HTMLInputElement).type))
  expect(submitControls).toHaveLength(0)
  expect(html).not.toContain('/api/mail/send')
}

describe('bounded mail reference layout', () => {
  it.each(['/mail/inbox', '/mail/compose', '/mail/settings/filters', '/mail/settings/autoresponder'])('keeps one active authorized navigation link on %s', activeRoute => {
    const html = renderMailSurface(fixture({ activeRoute }))
    const active = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)]
    expect(active).toHaveLength(1)
    expect(active[0]![0]).toContain(`data-nav-route="${activeRoute}"`)
    expect(html.match(/data-mail-pane="folders"/g)).toHaveLength(1)
    expect(html.match(/<main\b/g)).toHaveLength(1)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).toContain('data-xp-sidebar')
    expect(html).toContain('data-xp-shell-content')
  })

  it('preserves the production qualification boundary when given a private mailbox payload', () => {
    const html = renderWebApp({ surface: 'xmail', mail: fixture({ mailbox: 'private-mail-marker@example.test' }) })
    expect(html).toContain('data-tool-availability="unverified"')
    expect(html).not.toContain('private-mail-marker')
    expect(html).not.toMatch(/<div[^>]*data-mail-layout=/)
  })

  it.each(['en', 'ar'].flatMap(locale => [
    { locale, state: 'omitted', enabled: undefined, indicator: 'unavailable' },
    { locale, state: 'disabled', enabled: false, indicator: 'unavailable' },
    { locale, state: 'enabled', enabled: true, indicator: 'disconnected' },
  ]))('reports $state transport honestly in $locale on both mail screens', ({ locale, enabled, indicator }) => {
    for (const activeRoute of ['/mail/inbox', '/mail/compose']) {
      const html = renderMailSurface(fixture({ activeRoute, locale: locale as 'en' | 'ar', ...(enabled === undefined ? {} : { realtimeEnabled: enabled }) }))
      expect(html.match(new RegExp('data-ws-indicator="' + indicator + '"', 'g'))).toHaveLength(1)
      expect(html).not.toContain('data-ws-indicator="connected"')
      expect(html).toContain(enabled
        ? (locale === 'ar' ? 'جار الاتصال' : 'Connecting')
        : (locale === 'ar' ? 'التحديثات المباشرة غير متاحة' : 'Live updates unavailable'))
      expect(html).not.toContain(enabled ? 'data-ws-indicator="unavailable"' : 'data-ws-indicator="disconnected"')
    }
  })

  it('does not manufacture folders, unread counts, mailbox quotas or connection successes', () => {
    const html = renderMailSurface(fixture({ messages: [], quotaUsedMb: undefined, quotaLimitMb: undefined }))
    expect(html).toContain('No messages in this folder.')
    expect(html).toContain('data-mail-pane="empty"')
    expect(html).not.toMatch(/data-mail-uid=|class="xp-mail-count|xp-mail-sidebar-quota/)
    expect(html).toContain('href="/mail/inbox?folder=Sent"')
    expect(html).toContain('href="/mail/inbox?folder=Drafts"')
    expect(html).not.toMatch(/TLS:|DKIM: pass|SPF: pass|DMARC: pass|Live stream connected/)
    expect(html).not.toContain('Billing')
    expect(html).not.toContain('Starred')
  })

  it('keeps message selection within the provided folder observations and rejects invalid message UIDs', () => {
    const html = renderMailSurface(fixture({ activeFolder: 'Sent', selectedUid: 1, messages: [message({ body: 'inbox-body-must-stay-out' }), message({ uid: 2, folder: 'Sent', body: 'sent-body-observed' }), message({ uid: Number.NaN, folder: 'Sent', body: 'invalid-message' })] }))
    expect(html).toContain('sent-body-observed')
    expect(html).not.toContain('inbox-body-must-stay-out')
    expect(html).not.toContain('invalid-message')
    expect(html.match(/data-mail-uid=/g)).toHaveLength(1)
    // Read-only folder observations have no route that the production adapter cannot honor.
    expect(html).toContain('<li data-mail-folder="Sent">')
    expect(html).toContain('href="/mail/inbox?folder=Sent"')
    expect(html).not.toMatch(/href="\/mail\/inbox[^"]*[?&](?:amp;)?uid=/)
  })

  it('escapes all mailbox, folder, subject, sender and message body observations', () => {
    const attack = '<img src=x onerror="alert(1)">'
    const html = renderMailSurface(fixture({ mailbox: attack, activeFolder: attack, messages: [message({ folder: attack, from: attack, to: attack, subject: attack, preview: attack, body: attack })] }))
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror="')
    expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script id="xmail-inbox-client">'])
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(html).toContain('data-mailbox="&lt;img')
  })

  it.each(['en', 'ar'] as const)('keeps the %s composer on the local mail server without a raw form', locale => {
    const html = renderMailSurface(fixture({ activeRoute: '/mail/compose', locale }))
    expect(html).toContain('data-compose-form="true"')
    expect(html).toContain('data-mail-send-availability="available"')
    expect(html).toContain('data-mail-send="true"')
    expectLocalComposerSendBoundary(html, locale)
    expect(html).toMatch(/<button type="button"[^>]+data-mail-send="true" aria-describedby="mail-send-status"/)
    for (const id of ['compose-from', 'compose-to', 'compose-subject', 'compose-body']) {
      expect(html).toContain(`for="${id}"`)
      expect(html).toContain(`id="${id}"`)
    }
    expect(html).not.toMatch(/data-action="(?:reply-message|forward-message|archive-message)"/)
  })


  it.each([
    { name: 'API search action', mutate: (html: string) => html.replace('action="/mail/inbox"', 'action="/api/webmail/send"') },
    { name: 'POST search', mutate: (html: string) => html.replace('method="get"', 'method="post"') },
    { name: 'compose recipient in search', mutate: (html: string) => html.replace('</form>', '<input name="to" type="text"></form>') },
    { name: 'extra native send form', mutate: (html: string) => html + '<form action="/api/webmail/send" method="post"><button type="submit">Send</button></form>' },
    { name: 'submit send button', mutate: (html: string) => html.replace(/type="button"([^>]*data-mail-send="true")/, 'type="submit"$1') },
    { name: 'send form association', mutate: (html: string) => html.replace('<form role="search"', '<form id="search-owner" role="search"').replace('data-mail-send="true"', 'data-mail-send="true" form="search-owner"') },
    { name: 'send API formaction', mutate: (html: string) => html.replace('data-mail-send="true"', 'data-mail-send="true" formaction="/api/webmail/send"') },
  ])('rejects $name at the native send boundary', ({ mutate }) => {
    const html = renderMailSurface(fixture({ activeRoute: '/mail/compose', locale: 'en' }))
    expect(() => expectLocalComposerSendBoundary(mutate(html), 'en')).toThrow()
  })

  it('shows stored compose identity and every filter, and does not invent a quota or a zero', () => {
    const html = renderMailSurface(fixture({
      activeRoute: '/mail/compose',
      quotaLimitMb: 100,
      identityDkim: 'Selector default is stored for example.test',
      identitySpf: 'SPF record stored · DMARC record not stored',
      identitySize: '25 MiB per message',
      sieveRules: [
        { id: 'keep', name: 'Keep invoices', condition: 'Subject contains invoice', action: 'File into Orders', enabled: true },
        { id: 'drop', name: 'Drop noise', condition: 'From equals spam@example.test', action: 'Discard', enabled: false },
      ],
    }))
    expect(html).toContain('— / 100 MiB')
    expect(html).toContain('data-quota-ratio="unknown"')
    expect(html).not.toContain('0 / 100')
    expect(html).toContain('Selector default is stored for example.test')
    expect(html).toContain('SPF record stored · DMARC record not stored')
    expect(html).toContain('25 MiB per message')
    expect(html).toContain('1 active')
    expect(html).toContain('2 Sieve rules')
    expect(html).toContain('Drop noise · paused')
    expect(html).toContain('Keep invoices')
    const attack = '<img src=x onerror="alert(1)">'
    const escaped = renderMailSurface(fixture({ activeRoute: '/mail/compose', identityDkim: attack, identitySpf: attack, identitySize: attack }))
    expect(escaped).not.toContain('<img')
    expect(escaped).not.toContain('onerror="')
    const omitted = renderMailSurface(fixture({ activeRoute: '/mail/compose' }))
    expect(omitted).not.toContain('0 active')
    expect(omitted).not.toContain('Selector default')
    expect(omitted).toContain('data-quota-ratio="unknown"')
  })

  it('labels mailbox quota in MiB and does not invent a used amount', () => {
    const measured = renderMailSurface(fixture({ quotaUsedMb: 0, quotaLimitMb: 100 }))
    expect(measured).toContain('0 / 100 MiB')
    expect(measured).toContain('data-quota-ratio="measured"')
    const bytes = renderMailSurface(fixture({ quotaUsedMb: 0, quotaUsedBytes: 3300, quotaLimitMb: 256 }))
    expect(bytes).toContain('3.3 KB / 256 MiB')
    const limitOnly = renderMailSurface(fixture({ quotaLimitMb: 100 }))
    expect(limitOnly).toContain('— / 100 MiB')
    expect(limitOnly).toContain('data-quota-ratio="unknown"')
    expect(limitOnly).not.toContain('0 / 100')
    const unknown = renderMailSurface(fixture())
    expect(unknown).toContain('data-quota-ratio="unknown"')
    expect(unknown).not.toContain('0 MiB')
  })

  it('labels parsed mail times as UTC and leaves an unparsed date unlabelled', () => {
    const html = renderMailSurface(fixture({ messages: [message({ receivedAt: '2026-10-22T14:30:00+03:00' })] }))
    expect(html).toContain('11:30 UTC')
    expect(html).toContain('2026-10-22 11:30 UTC')
    const raw = renderMailSurface(fixture({ messages: [message({ receivedAt: 'not a date' })] }))
    expect(raw).toContain('not a date')
    expect(raw).not.toContain('not a date UTC')
  })

  it('does not report an unread inbox as an empty folder', () => {
    const unread = renderMailSurface(fixture({ messages: undefined }))
    expect(unread).toContain('The inbox has not been read from the mail server.')
    expect(unread).toContain('data-list-state="unread"')
    expect(unread).not.toContain('No messages in this folder.')
    expect(unread).not.toContain('0 messages')
    const failed = renderMailSurface(fixture({ messages: undefined, mailListFailed: true }))
    expect(failed).toContain('The mail server could not be read.')
    expect(failed).not.toContain('0 messages')
  })

  it('does not turn a missing authentication result into a failure', () => {
    const html = renderMailSurface(fixture({ messages: [message({ dkimPass: undefined, spfPass: undefined, dmarcPass: undefined })] }))
    expect(html).toContain('DKIM: not checked')
    expect(html).toContain('SPF: not checked')
    expect(html).toContain('DMARC: not checked')
    expect(html).not.toContain('DKIM: fail')
    expect(html).not.toContain('SPF: fail')
  })

  it('renders authentication outcomes only from the selected message observation', () => {
    const html = renderMailSurface(fixture())
    expect(html).toContain('DKIM: fail')
    expect(html).toContain('SPF: pass')
    expect(html).toContain('DMARC: fail')
    expect(html).not.toContain('DKIM: pass')
    expect(html).not.toContain('DMARC: pass')
  })

  it('keeps an unknown document unavailable instead of falling back to a composer', () => {
    const html = renderMailSurface(fixture({ activeRoute: '/mail/not-implemented' }))
    expect(html).toContain('data-screen="unavailable"')
    expect(html).not.toMatch(/data-compose-form=|data-mail-pane="message-list"/)
  })
})
