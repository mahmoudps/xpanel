import { describe, expect, it } from 'vitest'
import { MAILX_DEFAULTS, MAILX_MARKER, mailxMailboxEffects, readMailxMailboxSpam, renderMailxMailboxSettings, mailxCompositeRevision, mailxRevision, parseMailxArchive, parseMailxBcc, parseMailxRelay, parseMailxSpam, readMailxStored, renderMailxPostfix, renderMailxSpam } from './mailx-policy.ts'
import type { MailxSaved } from './mailx-policy.ts'

const at = '2026-10-28T10:00:00.000Z'
const empty = (): MailxSaved => ({ sections: { spam: null, relay: null, bcc: null, marketing: null }, archives: [] })

describe('mail policy grammar', () => {
  it('accepts exact policies and rejects unknown, unordered or unsafe values', () => {
    expect(parseMailxSpam(MAILX_DEFAULTS.spam)).toEqual(MAILX_DEFAULTS.spam)
    for (const bad of [{ ...MAILX_DEFAULTS.spam, extra: 1 }, { ...MAILX_DEFAULTS.spam, headerScore: 20 }, { ...MAILX_DEFAULTS.spam, greylistScore: 6 }, { ...MAILX_DEFAULTS.spam, rejectScore: 15.3 },
      { ...MAILX_DEFAULTS.spam, blockedDomains: ['a.example', 'a.example'] }, { ...MAILX_DEFAULTS.spam, blockedDomains: ['*.example'] }]) expect(() => parseMailxSpam(bad)).toThrow()
    expect(parseMailxRelay({ enabled: true, host: 'smtp.relay.example', port: 587, username: 'user@relay.example' }).port).toBe(587)
    for (const bad of [{ enabled: true, host: null, port: 587, username: null }, { enabled: false, host: 'a.example', port: 465, username: null }, { enabled: false, host: 'a.example', port: 587, username: 'a b' }])
      expect(() => parseMailxRelay(bad)).toThrow()
    expect(() => parseMailxBcc({ alwaysBcc: null, recipient: [{ match: 'a@example.com', copyTo: 'a@example.com' }], sender: [] })).toThrow()
    expect(() => parseMailxBcc({ alwaysBcc: null, recipient: [{ match: '@example.com', copyTo: 'x@y.example' }, { match: '@example.com', copyTo: 'z@y.example' }], sender: [] })).toThrow()
    expect(() => parseMailxArchive({ domains: [{ domain: 'example.com', mailbox: 'archive@other.example', incoming: true, outgoing: true, retentionDays: 30 }] })).toThrow()
  })
  it('never hashes the relay password into a revision', () => {
    const stored = { section: 'relay', policy: { enabled: true, host: 'smtp.relay.example', port: 587, username: 'u' }, secret: { password: 'S3cret pass', version: '00000000-0000-4000-8000-000000000001' }, updatedAt: at, updatedBy: 'root' }
    const changed = { ...stored, secret: { ...stored.secret, password: 'Other' } }
    expect(mailxRevision('relay', readMailxStored('relay', stored))).toBe(mailxRevision('relay', readMailxStored('relay', changed)))
    expect(() => readMailxStored('relay', { ...stored, secret: null })).toThrow()
    expect(() => readMailxStored('relay', { ...stored, secret: { ...stored.secret, password: 'bad\npass' } })).toThrow()
  })
})

describe('mail policy rendering', () => {
  it('renders relay, BCC, archive and limits without touching unsaved sections', () => {
    expect(renderMailxPostfix(empty())).toEqual({ settings: {}, files: [], conflicts: [] })
    const saved = empty()
    saved.sections.relay = readMailxStored('relay', { section: 'relay', policy: { enabled: true, host: 'smtp.relay.example', port: 587, username: 'u' }, secret: { password: 'p:w', version: '00000000-0000-4000-8000-000000000001' }, updatedAt: at, updatedBy: 'root' })
    saved.sections.bcc = { section: 'bcc', policy: { alwaysBcc: null, recipient: [{ match: '@shop.example', copyTo: 'audit@corp.example' }], sender: [] }, updatedAt: at, updatedBy: 'root' }
    saved.sections.marketing = { section: 'marketing', policy: { ...MAILX_DEFAULTS.marketing, messageRateLimit: 100, rateWindow: 3600 }, updatedAt: at, updatedBy: 'root' }
    saved.archives = [{ accountId: '00000000-0000-4000-8000-000000000002', policy: { domains: [
      { domain: 'shop.example', mailbox: 'archive@shop.example', incoming: true, outgoing: true, retentionDays: 30 }] }, updatedAt: at, updatedBy: 'alice' }]
    const plan = renderMailxPostfix(saved)
    expect(plan.settings).toMatchObject({ relayhost: '[smtp.relay.example]:587', smtp_sasl_auth_enable: 'yes', always_bcc: '', smtpd_client_message_rate_limit: '100', anvil_rate_time_unit: '3600s' })
    expect(plan.files.find(file => file.path.endsWith('relay_sasl'))).toMatchObject({ mode: 0o600, group: 'root', content: `${MAILX_MARKER}\n[smtp.relay.example]:587 u:p:w\n` })
    expect(plan.files.find(file => file.path.endsWith('recipient_bcc'))!.content).toContain('@shop.example audit@corp.example')
    expect(plan.files.find(file => file.path.endsWith('sender_bcc'))!.content).toContain('@shop.example archive@shop.example')
    expect(plan.conflicts).toEqual([{ accountId: '00000000-0000-4000-8000-000000000002', domain: 'shop.example', direction: 'incoming' }])
    const disabled = renderMailxPostfix({ ...saved, sections: { ...saved.sections, relay: { ...saved.sections.relay!, policy: { ...saved.sections.relay!.policy, enabled: false } } } })
    expect(disabled.settings).toMatchObject({ relayhost: '', smtp_sasl_auth_enable: 'no', smtp_sasl_password_maps: '', smtp_tls_policy_maps: '' })
    expect(mailxCompositeRevision(saved)).not.toBe(mailxCompositeRevision(empty()))
  })
  it('renders rspamd actions and SpamAssassin site rules from the same policy', () => {
    const files = renderMailxSpam({ ...MAILX_DEFAULTS.spam, blockedDomains: ['spam.example'] }, 'rspamd')
    expect(files.find(file => file.path.endsWith('actions.conf'))!.content).toContain('reject = 15.0;\nadd_header = 6.0;\ngreylist = 4.0;\n')
    expect(files.find(file => file.path.endsWith('xpanel_blocked_domains.map'))!.content).toContain('spam.example\n')
    expect(renderMailxSpam({ ...MAILX_DEFAULTS.spam, enabled: false }, 'rspamd').find(file => file.path.endsWith('actions.conf'))!.content).toContain('reject = null;')
    expect(renderMailxSpam({ ...MAILX_DEFAULTS.spam, headerScore: 5.5, blockedDomains: ['spam.example'] }, 'spamassassin', '/etc/spamassassin')[0]).toMatchObject({ path: '/etc/spamassassin/90-xpanel.cf', content: `${MAILX_MARKER}\nrequired_score 5.5\nblacklist_from *@spam.example\n` })
    expect(() => renderMailxSpam(MAILX_DEFAULTS.spam, 'spamassassin', '/tmp')).toThrow()
  })
})

describe('mailbox spam preference effects', () => {
  const pref = { inherit: true, enabled: true, addHeaderScore: 5.3, spamBoxEnabled: true, allowlist: [], blocklist: ['bad@spam.example'], mailbox: 'a@shop.example',
    ownerAuthority: { accountId: 'acc', serviceUserId: 'su', mailbox: 'a@shop.example' }, updatedAt: '2026-10-28T09:00:00.000Z' }
  it('parses strictly; an inherited preference keeps only its sender lists natively', () => {
    const row = readMailxMailboxSpam(pref)
    expect(mailxMailboxEffects(row)).toEqual({ allowlist: false, filtering: false, score: false, blocklist: true, spamBox: false })
    expect(mailxMailboxEffects({ ...row, inherit: false })).toEqual({ allowlist: false, filtering: false, score: false, blocklist: true, spamBox: true })
    expect(mailxMailboxEffects({ ...row, inherit: false, enabled: false, blocklist: [] })).toEqual({ allowlist: false, filtering: true, score: false, blocklist: false, spamBox: false })
    expect(renderMailxMailboxSettings([row]).content).toBe(MAILX_MARKER + String.fromCharCode(10))
    expect(renderMailxMailboxSettings([{ ...row, inherit: false, enabled: false }]).content).toContain('want_spam = yes;')
    for (const bad of [{ ...pref, extra: 1 }, { ...pref, allowlist: ['x"@y.example'] }, { ...pref, ownerAuthority: { ...pref.ownerAuthority, mailbox: 'b@shop.example' } }, { ...pref, addHeaderScore: 101 }])
      expect(() => readMailxMailboxSpam(bad)).toThrow()
  })
})
