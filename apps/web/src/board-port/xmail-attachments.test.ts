import { describe, expect, it } from 'vitest'
import { renderMailAttachments } from './xmail-attachments.ts'

describe('native message attachment presentation', () => {
  it.each(['en', 'ar'] as const)('retains attachment list, status and read control in %s without invented files', lang => {
    const html = renderMailAttachments({ lang, mailbox: 'owner@example.test', uid: 17, folder: 'INBOX', canRead: true })
    expect(html).toContain('data-mail-attachments')
    expect(html).toContain('data-uid="17"')
    expect(html).toContain('data-attachment-list')
    expect(html).toContain('data-attachment-refresh disabled')
    expect(html).not.toContain('attachment-download/')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('escapes mailbox/folder data and does not invent a message UID', () => {
    const html = renderMailAttachments({ lang: 'en', mailbox: '"><img src=x>', folder: '"><script>', canRead: false })
    expect(html).toContain('data-uid=""')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>')
    expect(html).toContain('data-attachment-can-read="false"')
  })
})
