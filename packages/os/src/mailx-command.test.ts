import { describe, expect, it } from 'vitest'
import {
  MAILX_MAPS, isMailxAddress, isMailxCommand, isMailxRetentionJobCommand, mailxArchiveExpungeArgv, mailxEngineReloadArgv, mailxEngineShowArgv, mailxPostconfSetArgv, mailxPostconfUnsetArgv,
} from './mailx-command.ts'

describe('mail policy command grammar', () => {
  it('admits only reviewed literal commands and reviewed postconf parameters', () => {
    for (const argv of [['/usr/sbin/postconf', '-n'], ['/usr/sbin/postfix', 'check'], ['/usr/sbin/postfix', 'reload'], ['/usr/bin/rspamadm', 'configtest'], ['/usr/bin/spamassassin', '--lint'],
      mailxPostconfSetArgv({ relayhost: '[smtp.relay.example]:587', smtp_sasl_auth_enable: 'yes', smtp_sasl_password_maps: `texthash:${MAILX_MAPS.relaySasl}` }),
      mailxPostconfSetArgv({ always_bcc: '', default_destination_rate_delay: '5s', anvil_rate_time_unit: '3600s' }), mailxPostconfUnsetArgv(['always_bcc', 'relayhost']),
      mailxEngineShowArgv('rspamd.service'), mailxEngineReloadArgv('spamd.service'), mailxEngineShowArgv('spamass-milter.service')]) expect(isMailxCommand(argv)).toBe(true)
    for (const argv of [['/usr/sbin/postconf', '-e', 'myhostname=evil'], ['/usr/sbin/postconf', '-e', 'relayhost=evil.example'], ['/usr/sbin/postconf', '-e', 'relayhost=[a.example]:0'],
      ['/usr/sbin/postconf', '-e', 'smtp_sasl_password_maps=hash:/etc/shadow'], ['/usr/sbin/postconf', '-e', 'always_bcc=Root@Example.com'], ['/usr/sbin/postconf', '-e'],
      ['/usr/sbin/postconf', '-e', 'relayhost=', 'relayhost=[a.example]:25'], ['/usr/sbin/postconf', '-e', 'relayhost'], ['/usr/sbin/postconf', '-X', 'myhostname'],
      ['/usr/sbin/postconf', '-c', '/tmp', '-n'], ['/usr/sbin/postfix', 'stop'], ['/usr/bin/systemctl', 'reload', '--', 'nginx.service'], ['/usr/bin/systemctl', 'restart', '--', 'rspamd.service'], ['/usr/bin/systemctl', 'reload', '--', 'spamass-milter.service'],
      ['/usr/sbin/postconf', '-e', 'smtpd_recipient_limit=0'], ['/usr/sbin/postconf', '-e', 'anvil_rate_time_unit=59s'], [1, 2]]) expect(isMailxCommand(argv as string[])).toBe(false)
    expect(() => mailxPostconfSetArgv({ message_size_limit: '1' })).toThrow()
    expect(() => mailxPostconfSetArgv({ always_bcc: 'a@b.example\nrelayhost=x' })).toThrow()
  })
  it('names one literal archive mailbox for retention and rejects masks or options', () => {
    const argv = mailxArchiveExpungeArgv('archive@example.com', 30)
    expect(argv).toEqual(['/usr/bin/doveadm', 'expunge', '-u', 'archive@example.com', 'mailbox', 'INBOX', 'savedbefore', '30d'])
    expect(isMailxRetentionJobCommand(argv)).toBe(true)
    for (const bad of [[...argv.slice(0, 7), '0d'], [...argv.slice(0, 3), '*@example.com', ...argv.slice(4)], [...argv.slice(0, 3), '-A', ...argv.slice(4)], [...argv.slice(0, 5), 'Sent', ...argv.slice(6)], [...argv.slice(0, 7), '3651d']])
      expect(isMailxRetentionJobCommand(bad)).toBe(false)
    expect(() => mailxArchiveExpungeArgv('-A@example.com', 1)).toThrow()
    expect(isMailxAddress('a..b@example.com')).toBe(false)
  })
})

describe('mail policy learning grammar', () => {
  it('trains only one mailbox INBOX or Junk folder through the detected filter', async () => {
    const { mailxLearnFolder, mailxLearnArgv, isMailxLearnJobCommand } = await import('./mailx-command.ts')
    const junk = mailxLearnFolder('/home/alice', 'info@shop.example', 'spam'), inbox = mailxLearnFolder('/home/alice', 'info@shop.example', 'ham')
    expect([junk, inbox]).toEqual(['/home/alice/mail/shop.example/info/.Junk/cur', '/home/alice/mail/shop.example/info/cur'])
    for (const argv of [mailxLearnArgv('rspamd', 'spam', junk), mailxLearnArgv('spamassassin', 'ham', inbox)]) expect(isMailxLearnJobCommand(argv)).toBe(true)
    for (const argv of [['/usr/bin/rspamc', 'learn_spam', inbox], ['/usr/bin/rspamc', 'learn_ham', junk], ['/usr/bin/sa-learn', '--spam', '/etc'], ['/usr/bin/rspamc', 'learn_spam', '/home/alice/mail/shop.example/../cur'],
      ['/usr/bin/sa-learn', '--forget', inbox], ['/usr/bin/rspamc', '-h', 'evil', 'learn_spam', junk]]) expect(isMailxLearnJobCommand(argv)).toBe(false)
    expect(() => mailxLearnFolder('/root', 'info@shop.example', 'spam')).toThrow()
  })
})

describe('mail policy render paths', () => {
  it('match the reconciler renders on both package families', async () => {
    const { MAILX_SIEVE_DIR, MAILX_VIRTUAL_ALIASES, MAILX_SPAMASS_MILTERS, MAILX_RSPAMD_MILTER } = await import('./mailx-command.ts')
    const { services } = await import('@xpanel/render')
    const { profileFor } = await import('./detect.ts'), { ALMA_9, UBUNTU_2404 } = await import('./fixtures.ts')
    const ubuntu = profileFor(UBUNTU_2404)
    for (const os of [ubuntu, profileFor(ALMA_9)]) {
      expect(services.postfixMapPaths(os).aliases).toBe(MAILX_VIRTUAL_ALIASES)
      expect(services.mailboxPolicySieveDir(os)).toBe(MAILX_SIEVE_DIR)
      expect(services.postfixMainSettings(os, { spamMilter: MAILX_SPAMASS_MILTERS[os.family] }).smtpd_milters).toContain(MAILX_SPAMASS_MILTERS[os.family])
    }
    expect(services.postfixMainSettings(ubuntu, { spamMilter: MAILX_RSPAMD_MILTER }).smtpd_milters).toBe('local:opendkim/opendkim.sock, inet:localhost:11332')
  })
})
