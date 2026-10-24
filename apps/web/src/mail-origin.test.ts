import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { mailInboxHref } from './mail-origin.ts'

describe('configured sibling mail destination', () => {
  it('preserves a custom hostname and HTTPS port, carrying only UI preferences', () => {
    const context = { locale: 'ar' as const, theme: 'light' as const, accountId: 'another-account', token: 'not-for-mail', username: 'owner' }
    const href = mailInboxHref('https://inbox.example.test:12443', context)
    assert.equal(href, 'https://inbox.example.test:12443/mail/inbox?lang=ar&theme=light')
    assert.deepEqual([...new URL(href!).searchParams.keys()], ['lang', 'theme'])
  })

  it('retains English and dark preferences without inferring a mail subdomain', () => {
    assert.equal(mailInboxHref('https://messages.example.test', { locale: 'en', theme: 'dark' }), 'https://messages.example.test/mail/inbox?lang=en&theme=dark')
  })

  it('keeps explicit configuration authoritative over an environment origin', () => {
    const previous = process.env.XPANEL_MAIL_PUBLIC_ORIGIN
    process.env.XPANEL_MAIL_PUBLIC_ORIGIN = 'https://environment.example.test'
    try {
      assert.equal(mailInboxHref('https://configured.example.test:12443', { locale: 'en', theme: 'dark' }), 'https://configured.example.test:12443/mail/inbox?lang=en&theme=dark')
      assert.equal(mailInboxHref(undefined, { locale: 'en', theme: 'dark' }), undefined)
    } finally {
      if (previous === undefined) delete process.env.XPANEL_MAIL_PUBLIC_ORIGIN
      else process.env.XPANEL_MAIL_PUBLIC_ORIGIN = previous
    }
  })

  for (const origin of [undefined, '', 'not a URL', '/mail', '//messages.example.test', 'http://messages.example.test', 'javascript:alert(1)', 'https://owner:password@messages.example.test', 'https://messages.example.test/', 'https://messages.example.test/path', 'https://messages.example.test?token=secret', 'https://messages.example.test#inbox']) {
    it(`leaves an absent or invalid exact HTTPS origin unavailable (${String(origin)})`, () => {
      assert.equal(mailInboxHref(origin, { locale: 'en', theme: 'dark' }), undefined)
    })
  }
})
