import { describe, expect, it } from 'vitest'
import { mailInboxHref } from './mail-origin.ts'

describe('mail inbox href', () => {
  it('uses the public mail origin when it is an exact https origin', () => {
    expect(mailInboxHref()).toBe('/mail/inbox')
    expect(mailInboxHref('https://mail.example.test:2096')).toBe('https://mail.example.test:2096/mail/inbox')
  })

  it('keeps the panel path when the origin is not an exact https origin', () => {
    expect(mailInboxHref('http://mail.example.test:2096')).toBe('/mail/inbox')
    expect(mailInboxHref('https://mail.example.test:2096/mail')).toBe('/mail/inbox')
    expect(mailInboxHref('https://user:secret@mail.example.test:2096')).toBe('/mail/inbox')
    expect(mailInboxHref('not a url')).toBe('/mail/inbox')
  })
})
