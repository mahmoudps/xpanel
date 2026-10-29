import { describe, expect, it } from 'vitest'
import { isXpanelError, type OsProfile } from '@xpanel/core'
import {
  MAX_LIST_MEMBERS,
  admitMailingLists,
  localDeliveryMainBlock,
  postfixMainSettings,
  renderDovecotSieveConf,
  renderMailboxPolicySieve,
  renderMailboxPolicySieveScript,
  renderPostfixMaps,
  type MailDomainInput,
} from './mail.ts'

const os = { family: 'debian', paths: { postfixDir: '/etc/postfix', dovecotDir: '/etc/dovecot' }, services: { postfix: 'postfix', dovecot: 'dovecot' } } as unknown as OsProfile
const account = { username: 'alice', uid: 1001, gid: 1001, home: '/home/alice' }
const ARGON = '{ARGON2ID}$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const domain = (extra: Partial<MailDomainInput> = {}): MailDomainInput => ({ domain: 'shop.example', account, mailboxes: [{ local: 'info', passwordHash: ARGON, quotaMb: 100 }], ...extra })
const rejects = (fn: () => unknown, pattern: RegExp): void => {
  let error: unknown
  try { fn() } catch (caught) { error = caught }
  expect(isXpanelError(error) && error.code === 'VALIDATION' && pattern.test(error.message), String(error)).toBe(true)
}

describe('spam filter milter', () => {
  it('lists the filter after OpenDKIM in both milter lists and keeps accept as the default action', () => {
    const settings = postfixMainSettings(os, { spamMilter: 'inet:localhost:11332' })
    expect(settings.smtpd_milters).toBe('local:opendkim/opendkim.sock, inet:localhost:11332')
    expect(settings.non_smtpd_milters).toBe(settings.smtpd_milters)
    expect(settings.milter_default_action).toBe('accept')
    expect(localDeliveryMainBlock(os, { spamMilter: 'local:spamass/spamass.sock' })).toContain('\nsmtpd_milters = local:opendkim/opendkim.sock, local:spamass/spamass.sock\n')
    expect(postfixMainSettings(os, { spamMilter: 'unix:/run/spamass-milter/postfix/sock' }).smtpd_milters).toBe('local:opendkim/opendkim.sock, unix:/run/spamass-milter/postfix/sock')
    expect(postfixMainSettings(os).smtpd_milters).toBe('local:opendkim/opendkim.sock')
  })
  it('refuses any other milter grammar', () => {
    for (const bad of ['inet:10.0.0.1:11332', 'inet:localhost:0', 'local:../x/sock', 'unix:relative', 'unix:/a/../b', 'local:a b', 'inet:localhost:11332, inet:evil:1']) rejects(() => postfixMainSettings(os, { spamMilter: bad }), /spam milter/)
  })
})

describe('mailing list delivery', () => {
  it('renders a list into the alias map with normalized, de-duplicated members and owner-only sending', () => {
    const maps = renderPostfixMaps(os, [domain({ lists: [{ local: 'team', members: ['Info@Shop.example', 'info@shop.example', 'partner@remote.example'] }] })])
    expect(maps.files.find(file => file.path.endsWith('/virtual_aliases'))!.content).toBe('# managed by xPanel: forwarders and default addresses\nteam@shop.example\tinfo@shop.example,partner@remote.example\n')
    expect(maps.files.find(file => file.path.endsWith('/sender_logins'))!.content).toContain('team@shop.example\tinfo@shop.example\n')
  })
  it('makes a list-only domain an alias domain', () => {
    const maps = renderPostfixMaps(os, [domain({ mailboxes: [], lists: [{ local: 'all', members: ['a@remote.example'] }] })])
    expect(maps.files.find(file => file.path.endsWith('/virtual_alias_domains'))!.content).toContain('shop.example\tOK')
  })
  it('refuses a list on a used address, without members or over the member limit', () => {
    rejects(() => renderPostfixMaps(os, [domain({ lists: [{ local: 'info', members: ['a@remote.example'] }] })]), /already a mailbox or forwarder/)
    rejects(() => renderPostfixMaps(os, [domain({ forwarders: [{ local: 'team', to: ['a@remote.example'] }], lists: [{ local: 'team', members: ['b@remote.example'] }] })]), /already a mailbox or forwarder/)
    rejects(() => renderPostfixMaps(os, [domain({ lists: [{ local: 'team', members: [] }] })]), /at least one/)
    rejects(() => renderPostfixMaps(os, [domain({ lists: [{ local: 'team', members: Array.from({ length: MAX_LIST_MEMBERS + 1 }, (_, i) => `m${i}@remote.example`) }] })]), /at most 1000/)
    expect(() => renderPostfixMaps(os, [domain({ lists: [{ local: 'team', members: Array.from({ length: MAX_LIST_MEMBERS }, (_, i) => `m${i}@remote.example`) }] })])).not.toThrow()
  })
  it('admits lists in order and refuses invalid, used and looping ones without failing the others', () => {
    const base = [domain({ forwarders: [{ local: 'sales', to: ['team@shop.example'] }] })]
    const outcomes = admitMailingLists(base, [
      { domain: 'shop.example', local: 'news', members: ['info@shop.example'] },
      { domain: 'shop.example', local: 'info', members: ['a@remote.example'] },
      { domain: 'shop.example', local: 'team', members: ['sales@shop.example'] },
      { domain: 'shop.example', local: 'self', members: ['self+x@shop.example'] },
      { domain: 'other.example', local: 'x', members: ['a@remote.example'] },
      { domain: 'shop.example', local: 'bad', members: ['not an address'] },
      { domain: 'shop.example', local: 'news', members: ['b@remote.example'] },
    ])
    expect(outcomes).toEqual(['admitted', 'address-in-use', 'loop', 'loop', 'invalid', 'invalid', 'address-in-use'])
    expect(() => renderPostfixMaps(os, [{ ...base[0]!, lists: [{ local: 'news', members: ['info@shop.example'] }] }])).not.toThrow()
  })
})

describe('mailbox spam policy Sieve', () => {
  it('renders the exact before-script and nothing when no effect is saved', () => {
    expect(renderMailboxPolicySieveScript({ blockedSenders: ['Bad@Spam.example', 'x"y@q.example'], spamToJunk: true })).toBe([
      "# managed by xPanel: mailbox spam policy; the mailbox's own filters run after it",
      'require ["fileinto", "mailbox"];',
      'if address :all :is "from" ["bad@spam.example", "x\\"y@q.example"] {',
      '  fileinto :create "Junk";',
      '  stop;',
      '}',
      'if header :is ["X-Spam", "X-Spam-Flag"] "yes" {',
      '  fileinto :create "Junk";',
      '  stop;',
      '}',
      '',
    ].join('\n'))
    expect(renderMailboxPolicySieveScript({ blockedSenders: [], spamToJunk: false })).toBeNull()
    rejects(() => renderMailboxPolicySieveScript({ blockedSenders: ['no-at-sign'], spamToJunk: false }), /blocked sender/)
    rejects(() => renderMailboxPolicySieveScript({ blockedSenders: ['a@b.example\nkeep;'], spamToJunk: false }), /blocked sender/)
  })
  it('places scripts in account-readable directories and compiles each one with sievec', () => {
    const plan = renderMailboxPolicySieve(os, [
      { address: 'info@shop.example', account, blockedSenders: [], spamToJunk: true },
      { address: 'sales@shop.example', account, blockedSenders: [], spamToJunk: false },
    ])
    expect(plan.files).toEqual([{ path: '/etc/dovecot/xpanel/sieve/shop.example/info.sieve', content: expect.stringContaining('X-Spam'), mode: 0o640, owner: 'root', group: 'alice' }])
    expect(plan.preActions).toEqual([
      { kind: 'ensure-dir', path: '/etc/dovecot/xpanel/sieve', mode: 0o755, owner: 'root', group: 'root' },
      { kind: 'ensure-dir', path: '/etc/dovecot/xpanel/sieve/shop.example', mode: 0o750, owner: 'root', group: 'alice' },
    ])
    expect(plan.postActions).toEqual([
      { kind: 'exec', argv: ['/usr/bin/sievec', '/etc/dovecot/xpanel/sieve/shop.example/info.sieve'] },
      { kind: 'exec', argv: ['/usr/bin/chown', 'root:alice', '/etc/dovecot/xpanel/sieve/shop.example/info.svbin'] },
      { kind: 'exec', argv: ['/usr/bin/chmod', '0640', '/etc/dovecot/xpanel/sieve/shop.example/info.svbin'] },
    ])
    rejects(() => renderMailboxPolicySieve(os, [
      { address: 'info@shop.example', account, blockedSenders: [], spamToJunk: true },
      { address: 'sales@shop.example', account: { ...account, username: 'bob' }, blockedSenders: [], spamToJunk: true },
    ]), /another account/)
  })
  it('enables Sieve for LMTP with the per-mailbox personal script after the policy script', () => {
    expect(renderDovecotSieveConf(os)).toEqual({ path: '/etc/dovecot/conf.d/95-xpanel-sieve.conf', mode: 0o644, owner: 'root', group: 'root', content: `# managed by xPanel: Sieve during delivery, mailbox spam policy before the mailbox's own filters
protocol lmtp {
  mail_plugins = $mail_plugins sieve
}

plugin {
  sieve = file:~/mail/%Ld/%Ln/sieve;active=~/mail/%Ld/%Ln/.dovecot.sieve
  sieve_before = /etc/dovecot/xpanel/sieve/%Ld/%Ln.sieve
  sieve_extensions = +vacation-seconds
  sieve_max_script_size = 1M
  sieve_max_actions = 32
  sieve_max_redirects = 4
  sieve_vacation_min_period = 1h
}
` })
  })
})
