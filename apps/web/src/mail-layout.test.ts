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
    expect(html).not.toMatch(/data-mail-uid=|data-mail-folder=|xp-mail-count|xp-mail-sidebar-quota/)
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
    expect(html).not.toMatch(/href="[^"]*[?&](?:amp;)?(?:folder|uid)=/)
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
    expect(html).not.toMatch(/<form\b|\/api\/mail\/send|type="submit"/)
    expect(html).toMatch(/<button type="button"[^>]+data-mail-send="true" aria-describedby="mail-send-status"/)
    for (const id of ['compose-from', 'compose-to', 'compose-subject', 'compose-body']) {
      expect(html).toContain(`for="${id}"`)
      expect(html).toContain(`id="${id}"`)
    }
    expect(html).not.toMatch(/data-action="(?:reply-message|forward-message|archive-message)"/)
  })

  it('labels mailbox quota in MiB and does not invent a used amount', () => {
    const measured = renderMailSurface(fixture({ quotaUsedMb: 0, quotaLimitMb: 100 }))
    expect(measured).toContain('0 / 100 MiB')
    expect(measured).toContain('data-quota-ratio="measured"')
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
    expect(html).toContain('DKIM: —')
    expect(html).toContain('SPF: —')
    expect(html).toContain('DMARC: —')
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
