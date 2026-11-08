import { describe, expect, it } from 'vitest'
import type { OsProfile } from '@xpanel/core'
import { renderDovecotFtsConf, renderMailboxPolicySieveScript } from './mail.ts'

describe('mailbox spam auto-delete', () => {
  it('discards before filing to Junk, with one star per whole score point', () => {
    const script = renderMailboxPolicySieveScript({ blockedSenders: [], spamToJunk: true, autoDeleteScore: 3 })!
    expect(script).toContain('if header :contains "X-Spam-Level" "***" {\n  discard;\n  stop;\n}')
    expect(script.indexOf('discard;')).toBeLessThan(script.indexOf('fileinto :create "Junk";'))
  })
  it('renders a script for the threshold alone and none without any effect', () => {
    expect(renderMailboxPolicySieveScript({ blockedSenders: [], spamToJunk: false, autoDeleteScore: 15 })).toContain('discard;')
    expect(renderMailboxPolicySieveScript({ blockedSenders: [], spamToJunk: false, autoDeleteScore: null })).toBeNull()
    expect(renderMailboxPolicySieveScript({ blockedSenders: [], spamToJunk: false })).toBeNull()
  })
  it('refuses a threshold outside 1 to 50', () => {
    for (const score of [0, 51, 1.5]) expect(() => renderMailboxPolicySieveScript({ blockedSenders: [], spamToJunk: false, autoDeleteScore: score })).toThrow()
  })
})

describe('full text search configuration', () => {
  it('adds the plugin and leaves delivery free of indexing', () => {
    const file = renderDovecotFtsConf({ paths: { dovecotDir: '/etc/dovecot' } } as unknown as OsProfile)
    expect(file.path).toBe('/etc/dovecot/conf.d/96-xpanel-fts.conf')
    expect(file.content).toContain('mail_plugins = $mail_plugins fts fts_xapian')
    expect(file.content).toContain('fts_autoindex = no')
  })
})
