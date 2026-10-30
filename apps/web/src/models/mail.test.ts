import { describe, expect, it } from 'vitest'
import { tools, type VisibilityContext } from '@xpanel/catalog'
import { DISPLAY_DATETIME_BINDING, formatAsciiBytes, formatDisplayDateTime } from '../display-format.ts'
import type { MailMessageItem, MailSurfaceProps } from '../surfaces/xmail.ts'
import { addressList, chipOf, formatAttachmentBytes, formatMailboxQuota, formatMailStamp, projectMailView } from './mail.ts'

const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const visibility: VisibilityContext = { principal: { kind: 'user', id: 'owner', username: 'owner', accountId: 'a1' }, disabledFeatures: new Set() }
const props = (input: Partial<MailSurfaceProps> = {}): MailSurfaceProps => ({ mailbox: 'owner@example.test', visibility, catalog, ...input })
const message = (input: Partial<MailMessageItem> = {}): MailMessageItem => ({
  uid: 7, folder: 'INBOX', from: 'sender@example.test', to: 'owner@example.test',
  subject: 'A real subject', preview: 'Observed preview', body: 'Original body',
  receivedAt: '2026-10-29T12:34:56.123456+03:00', unread: true, ...input,
})

describe('neutral mailbox projection', () => {
  it('requires a mailbox and a qualified caller without advertising unsupported pages', () => {
    expect(projectMailView(props({ mailbox: undefined }))).toBeUndefined()
    expect(projectMailView(props({ visibility: undefined }))).toBeUndefined()
    expect(projectMailView(props({ activeRoute: '/mail/calendar' }))).toBeUndefined()
    expect(projectMailView(props({ activeRoute: '/mail/compose', visibility: { ...visibility, disabledFeatures: new Set(['webmail-compose']) } }))).toBeUndefined()
  })

  it('distinguishes an unread observation, a failed read and a measured empty folder', () => {
    const unread = projectMailView(props())
    const failed = projectMailView(props({ mailListFailed: true }))
    const empty = projectMailView(props({ messages: [] }))
    expect(unread).toMatchObject({ kind: 'inbox', state: 'unread', total: null, unreadCount: null, selectedKey: null })
    expect(failed).toMatchObject({ kind: 'inbox', state: 'failed', total: null, unreadCount: null })
    expect(empty).toMatchObject({ kind: 'inbox', state: 'empty', total: 0, unreadCount: 0, messages: [] })
  })

  it('does not use a stale inbox observation as a Sent-folder observation', () => {
    expect(projectMailView(props({ activeRoute: '/mail/sent', activeFolder: 'INBOX', messages: [message()] })))
      .toMatchObject({ kind: 'inbox', folder: 'Sent', state: 'unread', total: null, messages: [] })
    expect(projectMailView(props({ activeRoute: '/mail/sent', activeFolder: 'Sent', messages: [message({ folder: 'Sent' })] })))
      .toMatchObject({ kind: 'inbox', folder: 'Sent', state: 'messages', total: 1 })
  })

  it('filters by folder and valid UID and preserves selected message content as plain data', () => {
    const body = '<script>source stays text</script>\nOriginal source'
    const view = projectMailView(props({ selectedUid: 9, messages: [message(), message({ uid: 9, body }), message({ uid: 0 }), message({ uid: 11, folder: 'Sent' })] }))
    expect(view).toMatchObject({ kind: 'inbox', selectedKey: 'uid-9', total: 2, unreadCount: 2 })
    if (view?.kind !== 'inbox') throw new Error('Expected an inbox projection')
    expect(view.messages.map(row => row.uid)).toEqual([7, 9])
    expect(view.messages[1]).toMatchObject({ body, datetime: '2026-10-29T09:34:56.123Z', fullDate: '2026-10-29 09:34 UTC' })
    expect(view.messages[1]?.authentication).toContain('not checked')
  })

  it('preserves actual unread-body and attachment measurements without inventing authentication', () => {
    const view = projectMailView(props({ messages: [message({ body: '', bodyPending: true, dkimPass: false, attachments: [{ name: 'invoice.txt', sizeBytes: 25 }, { name: ' ', sizeBytes: 5 }] })] }))
    if (view?.kind !== 'inbox') throw new Error('Expected an inbox projection')
    expect(view.messages[0]).toMatchObject({ bodyPending: true, body: '', attachments: [{ name: 'invoice.txt', size: '25 B' }] })
    expect(view.messages[0]?.authentication).toBe('DKIM: fail · SPF: not checked · DMARC: not checked')
  })

  it('uses the catalog authority for search, attachments and compose links independently', () => {
    const view = projectMailView(props({ visibility: { ...visibility, disabledFeatures: new Set(['webmail-search', 'webmail-compose', 'webmail-attachments']) } }))
    expect(view).toMatchObject({ kind: 'inbox', canCompose: false, canReadAttachments: false })
    expect(view?.searchHref).toBeUndefined()
  })

  it('keeps draft, stored settings, action outcome and unknown measurements intact', () => {
    const actionState = { state: 'conflict' as const, preserveDraft: true, retryable: false, errorCode: 'STALE_REVISION', message: 'Saved revision changed.' }
    const view = projectMailView(props({ activeRoute: '/mail/compose', composeDraft: { to: 'recipient@example.test', cc: '', subject: '<subject>', body: '<original body>' }, vacationEnabled: false, sieveRules: [], actionState }))
    expect(view).toMatchObject({ kind: 'compose', draft: { to: 'recipient@example.test', cc: '', bcc: '', subject: '<subject>', body: '<original body>' }, vacation: false, rules: [], quota: { text: '—', percent: null }, identity: {} })
    expect(view?.actionState).toBe(actionState)
  })

  it('keeps unknown quota and saved unlimited policy separate from measured zero usage', () => {
    expect(formatMailboxQuota(undefined, 'unlimited', 'en')).toEqual({ text: '— / unlimited', percent: null })
    expect(formatMailboxQuota(0, 100, 'en')).toEqual({ text: '0 / 100 MiB', percent: 0 })
    expect(formatMailboxQuota(undefined, 100, 'en', 500)).toEqual({ text: '500 B / 100 MiB', percent: 0 })
  })
})

describe('neutral mail formatting and recipients', () => {
  it('retains quoted recipient commas and display names without altering addresses', () => {
    const values = addressList('"Doe, Jane" <jane@example.test>; bob@example.test, ignored')
    expect(values).toEqual(['"Doe, Jane" <jane@example.test>', 'bob@example.test'])
    expect(chipOf('to', values[0]!)).toEqual({ field: 'to', name: 'Doe, Jane', addr: 'jane@example.test', invalid: false })
  })

  it('keeps external date headers verbatim and byte counts consistent', () => {
    expect(formatMailStamp('Original Date header')).toEqual({ time: 'Original Date header', full: 'Original Date header', datetime: 'Original Date header' })
    expect(formatAttachmentBytes(25)).toBe('25 B')
    expect(formatAttachmentBytes(10_000)).toBe(formatAsciiBytes(10_000))
    expect(formatAttachmentBytes(-1)).toBe('—')
  })

  it('runs the same UTC and ASCII display implementation in the browser binding', () => {
    const browserFormat = new Function(`return ${DISPLAY_DATETIME_BINDING}`)() as typeof formatDisplayDateTime
    for (const value of ['2026-10-29T12:34:56.123456+03:00', '2026-02-30T12:00:00Z', 'Original Date header', null, undefined]) {
      expect(browserFormat(value)).toBe(formatDisplayDateTime(value))
    }
    expect(browserFormat('2026-10-29T12:34:56.123456+03:00')).toBe('2026-10-29 09:34 UTC')
  })
})
