import { describe, expect, it } from 'vitest'
import { renderMailboxPolicySieveScript } from './mail.ts'

describe('plus addressing in the mailbox Sieve policy', () => {
  it('renders nothing without an effect', () => {
    expect(renderMailboxPolicySieveScript({ blockedSenders: [], spamToJunk: false })).toBeNull()
  })

  it('creates the tag folder in create mode', () => {
    const script = renderMailboxPolicySieveScript({ blockedSenders: [], spamToJunk: false, plusFolders: 'create' })!
    expect(script).toContain('"subaddress"')
    expect(script).toContain('fileinto :create "${tag}";')
    expect(script).not.toContain('mailboxexists')
  })

  it('uses an existing folder only in existing mode and falls through to the inbox', () => {
    const script = renderMailboxPolicySieveScript({ blockedSenders: [], spamToJunk: false, plusFolders: 'existing' })!
    expect(script).toContain('if mailboxexists "${tag}" {')
    expect(script).not.toContain(':create')
  })

  it('runs spam rules before the tag, so a tag cannot pass them', () => {
    const script = renderMailboxPolicySieveScript({ blockedSenders: ['bad@example.com'], spamToJunk: true, plusFolders: 'create' })!
    expect(script.indexOf('X-Spam')).toBeLessThan(script.indexOf('envelope :detail'))
    expect(script.indexOf('bad@example.com')).toBeLessThan(script.indexOf('envelope :detail'))
  })

  it('refuses an unknown mode', () => {
    expect(() => renderMailboxPolicySieveScript({ blockedSenders: [], spamToJunk: false, plusFolders: 'always' as never })).toThrow(/plus folders/)
  })
})
