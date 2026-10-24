import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { isXpanelError, type OsProfile } from '@xpanel/core'
import {
  DISCARD_ADDRESS,
  dkimDnsRecord,
  dovecotPasswdFile,
  dovecotPasswdLine,
  mailConfigTests,
  postconfAction,
  postfixClientServices,
  localDeliveryMainBlock,
  localSubmissionMasterBlock,
  postfixMainSettings,
  probeLocalSubmissionAuth,
  mailboxPostmaster,
  renderDovecotAuthConf,
  renderDovecotMailboxConf,
  renderDovecotQuotaConf,
  renderDovecotSpecialUseConf,
  renderDovecotXpanelConf,
  resolveMailboxPostmaster,
  replaceManagedBlock,
  renderFilterSieve,
  renderPostfixMaps,
  renderPostfixMainFragment,
  renderQuotaWarningScript,
  renderSieveScript,
  renderVacationSieve,
  sieveFile,
  type MailDomainInput,
  type MailFilter,
} from './mail.ts'

const rejects = (fn: () => unknown, pattern?: RegExp): void => {
  let err: unknown
  try {
    fn()
  } catch (e) {
    err = e
  }
  expect(isXpanelError(err), `expected VALIDATION, got ${String(err)}`).toBe(true)
  if (isXpanelError(err)) {
    expect(err.code).toBe('VALIDATION')
    if (pattern) expect(err.message).toMatch(pattern)
  }
}

const profile = (family: 'debian' | 'rhel', over: Partial<OsProfile['paths']> = {}): OsProfile =>
  ({
    family,
    id: family === 'debian' ? 'ubuntu' : 'centos',
    versionId: family === 'debian' ? '24.04' : '9',
    packageManager: family === 'debian' ? 'apt' : 'dnf',
    packages: {},
    services: { postfix: family === 'debian' ? 'postfix.service' : 'postfix', dovecot: 'dovecot' },
    phpPackages: () => [],
    phpFpmService: (v: string) => `php${v}-fpm`,
    phpFpmPoolDir: (v: string) => `/etc/php/${v}/fpm/pool.d`,
    phpFpmSocketDir: '/run/php',
    phpBinary: (v: string) => `/usr/bin/php${v}`,
    paths: { postfixDir: '/etc/postfix', dovecotDir: '/etc/dovecot', ...over },
  }) as unknown as OsProfile

const debian = profile('debian')
const rhel = profile('rhel', { dovecotDir: '/opt/test/dovecot', postfixDir: '/opt/test/postfix' })

const account = { username: 'alice', uid: 1001, gid: 1001, home: '/home/alice' }
const ARGON = '{ARGON2ID}$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const SHA512 = `{SHA512-CRYPT}$6$saltsalt$${'a'.repeat(86)}`

describe('dovecotPasswdLine', () => {
  it('renders the account uid/gid and a maildir inside the account home', () => {
    expect(dovecotPasswdLine(account, 'Example.com', { local: 'Info', passwordHash: ARGON, quotaMb: 1024 })).toBe(
      `info@example.com:${ARGON}:1001:1001::/home/alice::userdb_mail=maildir:~/mail/example.com/info userdb_quota_rule=*:storage=1024M`,
    )
  })

  it('writes unlimited explicitly as storage=0 and refuses a 0 MB quota (Dovecot reads 0 as unlimited)', () => {
    expect(dovecotPasswdLine(account, 'example.com', { local: 'a', passwordHash: SHA512, quotaMb: 'unlimited' })).toContain('userdb_quota_rule=*:storage=0')
    rejects(() => dovecotPasswdLine(account, 'example.com', { local: 'a', passwordHash: SHA512, quotaMb: 0 }), /quota/)
    rejects(() => dovecotPasswdLine(account, 'example.com', { local: 'a', passwordHash: SHA512, quotaMb: 1.5 }))
    rejects(() => dovecotPasswdLine(account, 'example.com', { local: 'a', passwordHash: SHA512, quotaMb: 16 * 1024 * 1024 + 1 }))
  })

  it('adds passdb nologin for suspended logins', () => {
    expect(dovecotPasswdLine(account, 'example.com', { local: 'a', passwordHash: ARGON, quotaMb: 10, suspendLogin: true })).toMatch(/ nologin=y reason=suspended$/)
  })

  it('rejects injection through any field', () => {
    const ok = { local: 'a', passwordHash: ARGON, quotaMb: 10 }
    rejects(() => dovecotPasswdLine(account, 'example.com', { ...ok, local: 'evil\nroot' }))
    rejects(() => dovecotPasswdLine(account, 'example.com', { ...ok, local: 'a:b' }))
    rejects(() => dovecotPasswdLine(account, 'example.com', { ...ok, local: '../x' }))
    rejects(() => dovecotPasswdLine(account, 'example.com', { ...ok, local: 'a+b' }))
    rejects(() => dovecotPasswdLine(account, 'example.com', { ...ok, local: 'a..b' }))
    rejects(() => dovecotPasswdLine(account, 'example.com', { ...ok, local: '.a' }))
    rejects(() => dovecotPasswdLine(account, 'exa:mple.com', ok))
    rejects(() => dovecotPasswdLine(account, 'example.com\n', ok))
    rejects(() => dovecotPasswdLine(account, 'example.com', { ...ok, passwordHash: `${ARGON}:0:0` }), /password hash/)
    rejects(() => dovecotPasswdLine(account, 'example.com', { ...ok, passwordHash: `${ARGON}\nroot::0:0` }), /password hash/)
    rejects(() => dovecotPasswdLine(account, 'example.com', { ...ok, passwordHash: '{PLAIN}secret' }), /password hash/)
    rejects(() => dovecotPasswdLine(account, 'example.com', { ...ok, passwordHash: '{SHA512-CRYPT}$6$short' }), /SHA512-CRYPT/)
    rejects(() => dovecotPasswdLine({ ...account, uid: 0 }, 'example.com', ok), /uid/)
    rejects(() => dovecotPasswdLine({ ...account, gid: 999 }, 'example.com', ok), /gid/)
    rejects(() => dovecotPasswdLine({ ...account, home: '/home/../root' }, 'example.com', ok), /home/)
    rejects(() => dovecotPasswdLine({ ...account, home: '/home/al:ice' }, 'example.com', ok), /home/)
    rejects(() => dovecotPasswdLine({ ...account, username: 'Alice' }, 'example.com', ok), /username/)
  })

  it('never lets a hash body carry a separator', () => {
    const line = dovecotPasswdLine(account, 'example.com', { local: 'a', passwordHash: ARGON, quotaMb: 1 })
    expect(line.split(':').slice(0, 7)).toEqual(['a@example.com', ARGON, '1001', '1001', '', '/home/alice', ''])
    expect(line).not.toContain('\n')
  })
})

describe('dovecotPasswdFile', () => {
  const input: MailDomainInput = {
    domain: 'example.com',
    account,
    mailboxes: [
      { local: 'zed', passwordHash: ARGON, quotaMb: 50 },
      { local: 'info', passwordHash: SHA512, quotaMb: 'unlimited' },
    ],
  }

  it('is placed under the profile dovecot dir with a .passwd suffix, root:dovecot 0640, sorted', () => {
    const f = dovecotPasswdFile(rhel, input)
    expect(f.path).toBe('/opt/test/dovecot/xpanel/domains/example.com.passwd')
    expect(f).toMatchObject({ mode: 0o640, owner: 'root', group: 'dovecot' })
    const lines = f.content.trim().split('\n')
    expect(lines[0]).toMatch(/^# managed by xPanel/)
    expect(lines.slice(1).map((l) => l.split(':')[0])).toEqual(['info@example.com', 'zed@example.com'])
    expect(dovecotPasswdFile(debian, input).path).toBe('/etc/dovecot/xpanel/domains/example.com.passwd')
  })

  it('rejects duplicate mailboxes and a bad group', () => {
    rejects(() => dovecotPasswdFile(debian, { ...input, mailboxes: [input.mailboxes[0]!, { ...input.mailboxes[0]!, local: 'ZED' }] }), /twice/)
    rejects(() => dovecotPasswdFile(debian, input, { dovecotGroup: 'root;rm' }))
  })

  it('rejects an OsProfile path with traversal', () => {
    rejects(() => dovecotPasswdFile(profile('debian', { dovecotDir: '/etc/../tmp' }), input))
  })
})

describe('renderPostfixMaps', () => {
  const domains: MailDomainInput[] = [
    {
      domain: 'example.com',
      account,
      mailboxes: [
        { local: 'info', passwordHash: ARGON, quotaMb: 100 },
        { local: 'sales', passwordHash: ARGON, quotaMb: 100, suspendIncoming: true },
      ],
      forwarders: [
        { local: 'team', to: ['info@example.com', 'recipient-4@example.net'] },
        { local: 'info', to: ['archive@example.net'] },
      ],
      defaultAddress: { kind: 'forward', to: ['info@example.com'] },
    },
    { domain: 'shop.test', account, mailboxes: [], defaultAddress: { kind: 'discard' } },
  ]
  const out = renderPostfixMaps(debian, domains)
  const file = (suffix: string): string => out.files.find((f) => f.path.endsWith(suffix))?.content ?? ''

  it('lists domains and mailboxes as lookup tables under the profile postfix dir', () => {
    expect(out.files.map((f) => f.path)).toEqual([
      '/etc/postfix/xpanel/virtual_domains',
      '/etc/postfix/xpanel/virtual_mailboxes',
      '/etc/postfix/xpanel/virtual_aliases',
      '/etc/postfix/xpanel/sender_logins',
      '/etc/postfix/xpanel/transport',
      '/etc/postfix/xpanel/recipient_access',
    ])
    expect(file('virtual_domains')).toContain('example.com\tOK\nshop.test\tOK\n')
    expect(file('virtual_mailboxes')).toContain('info@example.com\tOK\nsales@example.com\tOK\n')
  })

  it('renders forwarders, keeps a copy for forwarded mailboxes and guards mailboxes from the catch-all', () => {
    const aliases = file('virtual_aliases')
    expect(aliases).toContain('team@example.com\tinfo@example.com,recipient-4@example.net\n')
    expect(aliases).toContain('info@example.com\tinfo@example.com,archive@example.net\n')
    expect(aliases).toContain('sales@example.com\tsales@example.com\n')
    expect(aliases).toContain('@example.com\tinfo@example.com\n')
    expect(aliases).toContain(`@shop.test\t${DISCARD_ADDRESS}\n`)
    expect(file('transport')).toContain('xpanel-discard.invalid\tdiscard:default-address\n')
  })

  it('maps sender ownership so one mailbox cannot send as another', () => {
    const s = file('sender_logins')
    expect(s).toContain('info@example.com\tinfo@example.com\n')
    expect(s).toContain('team@example.com\tinfo@example.com,sales@example.com\n')
    expect(s).toContain('@example.com\tinfo@example.com,sales@example.com\n')
    expect(s).toContain('@shop.test\tnobody@xpanel-sender.invalid\n')
  })

  it('rejects suspended recipients at RCPT time', () => {
    expect(file('recipient_access')).toContain('sales@example.com\tREJECT 5.2.1 mailbox is not accepting mail\n')
  })

  it('texthash needs only the private map directory and a reload; lmdb adds postmap argv', () => {
    expect(out.actions).toEqual([
      { kind: 'ensure-dir', path: '/etc/postfix/xpanel', mode: 0o750, owner: 'root', group: 'postfix' },
      { kind: 'systemd', verb: 'reload', unit: 'postfix.service' },
    ])
    const lmdb = renderPostfixMaps(rhel, domains, { mapType: 'lmdb' })
    expect(lmdb.actions[0]).toMatchObject({ kind: 'ensure-dir', path: '/opt/test/postfix/xpanel' })
    expect(lmdb.actions[1]).toEqual({ kind: 'exec', argv: ['postmap', 'lmdb:/opt/test/postfix/xpanel/virtual_domains'] })
    expect(lmdb.actions).toHaveLength(8)
    expect(lmdb.actions.at(-1)).toEqual({ kind: 'systemd', verb: 'reload', unit: 'postfix' })
  })

  it('keeps every table away from accounts: the tables list all hosted addresses', () => {
    for (const f of out.files) expect(f).toMatchObject({ mode: 0o640, owner: 'root', group: 'postfix' })
    expect(renderPostfixMaps(debian, domains, { postfixGroup: 'mailgrp' }).files[0]?.group).toBe('mailgrp')
    rejects(() => renderPostfixMaps(debian, domains, { postfixGroup: 'postfix;x' }))
  })

  it('applies account suspension states: deferral for the whole domain, nologin for every mailbox', () => {
    const terminating: MailDomainInput = { ...domains[0]!, delivery: 'defer', login: 'denied' }
    const maps = renderPostfixMaps(debian, [terminating, domains[1]!])
    const access = maps.files.find((f) => f.path.endsWith('recipient_access'))?.content ?? ''
    expect(access).toContain('example.com\t450 4.2.1 mailbox temporarily unavailable, try again later\n')
    // the per-mailbox REJECT would win over the domain key, so it is left out while deferring
    expect(access).not.toContain('sales@example.com')
    expect(access).not.toContain('shop.test')
    const passwd = dovecotPasswdFile(debian, terminating).content.trim().split('\n').slice(1)
    expect(passwd).toHaveLength(2)
    for (const l of passwd) expect(l).toMatch(/ nologin=y reason=suspended$/)
    expect(dovecotPasswdFile(debian, { ...terminating, login: 'allowed' }).content).not.toContain('nologin')
    rejects(() => renderPostfixMaps(debian, [{ ...domains[0]!, delivery: 'bounce' as 'defer' }]), /delivery state/)
    rejects(() => dovecotPasswdFile(debian, { ...terminating, login: 'maybe' as 'denied' }), /login state/)
  })

  it('rejects hostile forwarders and duplicates', () => {
    const one = (patch: Partial<MailDomainInput>): unknown => renderPostfixMaps(debian, [{ ...domains[0]!, ...patch }])
    rejects(() => one({ forwarders: [{ local: 'x', to: ['a@b.com\n@example.com root'] }] }))
    rejects(() => one({ forwarders: [{ local: 'x', to: ['a@b.com,c@d.com'] }] }))
    rejects(() => one({ forwarders: [{ local: 'x', to: ['a b@b.com'] }] }))
    rejects(() => one({ forwarders: [{ local: 'x', to: ['|/bin/sh@b.com'] }] }))
    rejects(() => one({ forwarders: [{ local: 'x', to: ['"quoted"@b.com'] }] }))
    rejects(() => one({ forwarders: [{ local: 'x', to: [] }] }), /at least one/)
    rejects(() => one({ forwarders: [{ local: 'x', to: Array.from({ length: 51 }, (_, i) => `u${i}@b.com`) }] }), /at most 50/)
    rejects(() => one({ forwarders: [{ local: 'x\ty', to: ['a@b.com'] }] }))
    rejects(() => one({ forwarders: [{ local: 'x', to: ['a@b.com'] }, { local: 'X', to: ['c@d.com'] }] }), /twice/)
    rejects(() => one({ defaultAddress: { kind: 'pipe' } as unknown as MailDomainInput['defaultAddress'] }), /default address/)
    rejects(() => renderPostfixMaps(debian, [domains[1]!, domains[1]!]), /twice/)
  })
})

describe('Postfix main.cf', () => {
  it('points virtual delivery at Dovecot LMTP and SASL, through argv postconf', () => {
    const s = postfixMainSettings(debian, { tls: { certFile: '/etc/xpanel/ssl/host.net/fullchain.pem', keyFile: '/etc/xpanel/ssl/host.net/privkey.pem' } })
    expect(s).toMatchObject({
      virtual_mailbox_domains: 'texthash:/etc/postfix/xpanel/virtual_domains',
      virtual_alias_maps: 'texthash:/etc/postfix/xpanel/virtual_aliases',
      virtual_transport: 'lmtp:unix:private/dovecot-lmtp',
      smtpd_sasl_type: 'dovecot',
      smtpd_sasl_path: 'private/auth',
      smtpd_sender_restrictions: 'reject_authenticated_sender_login_mismatch',
      smtpd_relay_restrictions: 'permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination',
      smtpd_recipient_restrictions: 'check_recipient_access texthash:/etc/postfix/xpanel/recipient_access',
      smtpd_tls_cert_file: '/etc/xpanel/ssl/host.net/fullchain.pem',
      message_size_limit: String(50 * 1024 * 1024),
      smtpd_milters: 'local:opendkim/opendkim.sock',
      non_smtpd_milters: 'local:opendkim/opendkim.sock',
      milter_default_action: 'accept',
    })
    const a = postconfAction(rhel, s)
    expect(a.kind === 'exec' && a.argv.slice(0, 4)).toEqual(['postconf', '-c', '/opt/test/postfix', '-e'])
    expect(a.kind === 'exec' && a.argv).toContain('virtual_transport=lmtp:unix:private/dovecot-lmtp')
    expect(renderPostfixMainFragment(s)).toContain('virtual_transport = lmtp:unix:private/dovecot-lmtp\n')
  })

  it('adds SASL-only client services on 587 (STARTTLS) and 465 (implicit TLS) as argv postconf edits', () => {
    const a = postfixClientServices(rhel)
    const argv = a.map((x) => (x.kind === 'exec' ? x.argv : []))
    expect(argv[0]).toEqual(['postconf', '-c', '/opt/test/postfix', '-e', '-M', '587/inet=587 inet n - n - - smtpd'])
    expect(argv[1]?.slice(0, 5)).toEqual(['postconf', '-c', '/opt/test/postfix', '-e', '-P'])
    expect(argv[1]).toContain('587/inet/smtpd_tls_security_level=encrypt')
    expect(argv[1]).toContain('587/inet/smtpd_client_restrictions=permit_sasl_authenticated,reject')
    expect(argv[1]).toContain('587/inet/smtpd_relay_restrictions=permit_sasl_authenticated,reject')
    expect(argv[2]).toEqual(['postconf', '-c', '/opt/test/postfix', '-e', '-M', '465/inet=465 inet n - n - - smtpd'])
    expect(argv[3]).toContain('465/inet/smtpd_tls_wrappermode=yes')
    expect(argv[3]).not.toContain('587/inet/smtpd_tls_wrappermode=yes')
    for (const v of argv.flat()) expect(v).not.toMatch(/[\n;|&`$]/)
    rejects(() => postfixClientServices(profile('debian', { postfixDir: 'etc/postfix' })))
  })

  it('keeps mailbox_size_limit at or above message_size_limit so local(8) starts on EL too', () => {
    // Postfix's default mailbox_size_limit (51200000) is below a 50 MB message limit
    const s50 = postfixMainSettings(rhel)
    expect(Number(s50.mailbox_size_limit)).toBeGreaterThanOrEqual(Number(s50.message_size_limit))
    expect(postfixMainSettings(rhel, { messageSizeLimitMb: 10 }).mailbox_size_limit).toBe('51200000')
    expect(postfixMainSettings(rhel, { messageSizeLimitMb: 100 }).mailbox_size_limit).toBe(String(100 * 1024 * 1024))
    rejects(() => postfixMainSettings(rhel, { messageSizeLimitMb: 0 }))
  })

  it('refuses values or keys that could inject extra settings', () => {
    rejects(() => postconfAction(debian, { 'bad key': 'x' }))
    rejects(() => postconfAction(debian, { myhostname: 'a\nrelayhost = evil' }))
    rejects(() => postfixMainSettings(debian, { mapType: 'proxy:mysql' as 'lmdb' }))
    rejects(() => postfixMainSettings(debian, { tls: { certFile: 'relative.pem', keyFile: '/k' } }))
  })
})

describe('Dovecot configuration', () => {
  it('disables PAM in 10-auth.conf and leaves passdb/userdb to 11-xpanel-mailboxes.conf', () => {
    const auth = renderDovecotAuthConf(rhel)
    expect(auth.path).toBe('/opt/test/dovecot/conf.d/10-auth.conf')
    expect(auth.content).not.toMatch(/^passdb \{/m)
    expect(auth.content).not.toMatch(/^userdb \{/m)
    expect(auth.content).not.toContain('auth-system')
    expect(auth.content).not.toMatch(/auth_username_chars = .*\//)
    const mailbox = renderDovecotMailboxConf(rhel)
    expect(mailbox.content.match(/^passdb \{/gm)).toHaveLength(1)
    expect(mailbox.content.match(/^userdb \{/gm)).toHaveLength(1)
    expect(mailbox.content).toContain('passdb {\n  driver = passwd-file\n  args = username_format=%Lu /opt/test/dovecot/xpanel/domains/%Ld.passwd\n')
    expect(mailbox.content).toContain('userdb {\n  driver = passwd-file\n  args = username_format=%Lu /opt/test/dovecot/xpanel/domains/%Ld.passwd\n')
  })

  it('wires LMTP/auth sockets, quota warnings and per-mailbox sieve', () => {
    const f = renderDovecotXpanelConf(debian, { postmaster: 'postmaster@host.net' })
    expect(f.path).toBe('/etc/dovecot/conf.d/90-xpanel.conf')
    expect(f.content).toContain('first_valid_uid = 1000\nlast_valid_uid = 60000\nfirst_valid_gid = 1000\nlast_valid_gid = 60000\n')
    expect(f.content).toContain('unix_listener /var/spool/postfix/private/dovecot-lmtp {')
    expect(f.content).toContain('quota_warning = storage=95%% quota-warning 95 %u')
    expect(f.content).toContain('quota_warning2 = storage=80%% quota-warning 80 %u')
    expect(f.content).toContain('executable = script /opt/xpanel/libexec/quota-warning')
    expect(f.content).not.toContain('namespace inbox')
    const folders = renderDovecotSpecialUseConf(debian)
    expect(folders.path).toBe('/etc/dovecot/conf.d/15-mailboxes.conf')
    expect(folders.content).toContain('auto = subscribe')
    expect(folders.content.match(/auto = /g)).toHaveLength(5)
    expect(folders.content).toContain('special_use = \\Sent')
    expect(folders.content).toContain('special_use = \\Junk')
    expect(folders.content).toContain('special_use = \\Archive')
    expect(folders.content.match(/namespace inbox/g)).toHaveLength(1)
    const quota = renderDovecotQuotaConf(debian)
    expect(quota.path).toBe('/etc/dovecot/conf.d/99-xpanel-quota.conf')
    expect(quota.content).toContain('quota = count:User quota')
    expect(quota.content).toContain('quota_vsizes = yes')
    expect(f.content).toContain('sieve = file:~/mail/%Ld/%Ln/sieve;active=~/mail/%Ld/%Ln/.dovecot.sieve')
    expect(f.content).toContain('postmaster_address = postmaster@host.net')
    rejects(() => renderDovecotXpanelConf(debian, { postmaster: 'a@b.net\nmail_location = /' }))
    rejects(() => renderDovecotXpanelConf(debian, { postmaster: 'postmaster@host.net', postfixSpoolDir: '/var/spool/../postfix' }))
  })

  it('exposes argv config tests built from the profile paths', () => {
    expect(mailConfigTests(rhel)).toEqual([
      { name: 'postfix', argv: ['postfix', '-c', '/opt/test/postfix', 'check'] },
      { name: 'dovecot', argv: ['doveconf', '-n', '-c', '/opt/test/dovecot/dovecot.conf'] },
    ])
  })

  it('renders a quota-warning script that validates its arguments', () => {
    const f = renderQuotaWarningScript({ from: 'postmaster@host.net' })
    expect(f).toMatchObject({ path: '/opt/xpanel/libexec/quota-warning', mode: 0o755, owner: 'root' })
    expect(f.content).toContain(`case $rcpt in ''|-*|*[!a-z0-9@._-]*) exit 0 ;; esac`)
    expect(f.content).toContain(`'/usr/sbin/sendmail' -i -f 'postmaster@host.net' -- "$rcpt"`)
    rejects(() => renderQuotaWarningScript({ from: "x'; rm -rf /;'@host.net" }))
  })
})

describe('Sieve', () => {
  it('renders a vacation autoresponder with escaped strings', () => {
    const s = renderVacationSieve({ subject: 'Out "of" office', body: 'Back on Monday.\r\nC:\\ path', days: 3, from: 'info@example.com', addresses: ['sales@example.com'] })
    expect(s).toBe(
      '# managed by xPanel\nrequire ["vacation"];\n\n# autoresponder\nvacation :days 3 :subject "Out \\"of\\" office" :from "info@example.com" :addresses ["sales@example.com"] "Back on Monday.\nC:\\\\ path";\n',
    )
  })

  it('limits the autoresponder to a date range', () => {
    const s = renderVacationSieve({ subject: 'Away', body: 'x', start: '2026-12-20', end: '2027-01-03' })
    expect(s).toContain('require ["date", "relational", "vacation"];')
    expect(s).toContain('if allof(currentdate :value "ge" "date" "2026-12-20", currentdate :value "le" "date" "2027-01-03") {\n  vacation :days 1')
  })

  it('rejects header injection and bad dates in the autoresponder', () => {
    rejects(() => renderVacationSieve({ subject: 'hi\nBcc: victim@example.net', body: 'x' }))
    rejects(() => renderVacationSieve({ subject: 'hi', body: 'x\u0000' }))
    rejects(() => renderVacationSieve({ subject: 'hi', body: 'x', from: 'other@exa mple.com' }))
    rejects(() => renderVacationSieve({ subject: 'hi', body: 'x', start: '2026-02-30' }))
    rejects(() => renderVacationSieve({ subject: 'hi', body: 'x', start: '2026-03-02', end: '2026-03-01' }), /after/)
    rejects(() => renderVacationSieve({ subject: 'hi', body: 'x', days: 0 }))
  })

  const filters: MailFilter[] = [
    {
      name: 'Spam',
      match: 'any',
      tests: [
        { field: 'subject', op: 'begins', value: '[SPAM*]' },
        { field: 'header', header: 'X-Spam-Flag', op: 'is', value: 'YES' },
      ],
      actions: [{ kind: 'fileinto', folder: 'INBOX.Junk' }, { kind: 'stop' }],
    },
    { name: 'Big', match: 'all', tests: [{ field: 'size', op: 'over', bytes: 10485760 }, { field: 'from', op: 'contains', value: 'boss', not: true }], actions: [{ kind: 'discard' }] },
    { name: 'Copy', match: 'all', tests: [{ field: 'body', op: 'contains', value: 'invoice' }], actions: [{ kind: 'redirect', to: 'books@example.net', copy: true }, { kind: 'mark-read' }] },
    { name: 'off', match: 'all', enabled: false, tests: [{ field: 'to', op: 'is', value: 'x' }], actions: [{ kind: 'keep' }] },
  ]

  it('renders filters with escaped match literals and merged requires', () => {
    const s = renderFilterSieve(filters)
    expect(s).toContain('require ["body", "copy", "fileinto", "imap4flags", "mailbox"];')
    expect(s).toContain('if anyof(header :matches "subject" "[SPAM\\\\*]*", header :is "x-spam-flag" "YES") {\n  fileinto :create "INBOX.Junk";\n  stop;\n}')
    expect(s).toContain('if allof(size :over 10485760, not header :contains "from" "boss") {\n  discard;\n  stop;\n}')
    expect(s).toContain('if body :text :contains "invoice" {\n  redirect :copy "books@example.net";')
    expect(s).toContain('redirect :copy "books@example.net";')
    expect(s).toContain('addflag "\\\\Seen";')
    expect(s).not.toContain('# rule: off')
  })

  it('puts every tagged argument before the positional ones (RFC 5228 2.6.2)', () => {
    const ops = ['contains', 'is', 'matches', 'begins', 'ends', 'regex'] as const
    const all: MailFilter[] = ops.map((op, i) => ({
      name: `r${i}`,
      match: 'all',
      tests: [
        { field: 'to', op, value: 'a' },
        { field: 'header', header: 'X-Tag', op, value: 'b' },
        ...(op === 'regex' ? [] : [{ field: 'body' as const, op, value: 'c' }]),
      ],
      actions: [{ kind: 'keep' }],
    }))
    const s = renderFilterSieve(all)
    // a positional string followed by a tag is the broken order
    expect(s).not.toMatch(/(?:header|body)(?: :\w+)* "[^"]*" :/)
    for (const line of s.split('\n').filter((l) => l.startsWith('if '))) {
      for (const t of line.match(/header [^,)]+/g) ?? []) expect(t).toMatch(/^header :(?:contains|is|matches|regex) "[^"]+" "[^"]*"/)
    }
  })

  it('ends the script after discard or reject so the autoresponder stays silent', () => {
    const spam: MailFilter = { name: 'Drop', match: 'all', tests: [{ field: 'subject', op: 'contains', value: 'casino' }], actions: [{ kind: 'discard' }] }
    const bounce: MailFilter = { name: 'Bounce', match: 'all', tests: [{ field: 'from', op: 'is', value: 'ex@example.net' }], actions: [{ kind: 'reject', message: 'Gone' }] }
    const s = renderSieveScript({ filters: [spam, bounce], vacation: { subject: 'Away', body: 'x' } })
    expect(s).toContain('if header :contains "subject" "casino" {\n  discard;\n  stop;\n}')
    expect(s).toContain('if header :is "from" "ex@example.net" {\n  reject "Gone";\n  stop;\n}')
    expect(s.indexOf('reject "Gone";')).toBeLessThan(s.indexOf('vacation :days'))
    // an explicit stop is not doubled
    expect(renderFilterSieve([{ ...spam, actions: [{ kind: 'discard' }, { kind: 'stop' }] }]).match(/stop;/g)).toHaveLength(1)
  })

  it('combines filters before the autoresponder', () => {
    const s = renderSieveScript({ filters: filters.slice(0, 1), vacation: { subject: 'Away', body: 'x' } })
    expect(s.indexOf('# rule: Spam')).toBeLessThan(s.indexOf('# autoresponder'))
    expect(s).toContain('require ["fileinto", "mailbox", "vacation"];')
    expect(renderSieveScript({})).toBe('# managed by xPanel\nkeep;\n')
  })

  it('rejects unsafe or conflicting filters', () => {
    const f = (patch: Partial<MailFilter>): unknown => renderFilterSieve([{ ...filters[0]!, ...patch }])
    rejects(() => f({ name: 'x\nif true { redirect "a@b.com"; }' }))
    rejects(() => f({ tests: [{ field: 'subject', op: 'contains', value: 'a\nb' }] }))
    rejects(() => f({ tests: [{ field: 'header', header: 'X:Bad', op: 'is', value: 'a' }] }))
    rejects(() => f({ tests: [{ field: 'subject', op: 'regex', value: '(' }] }), /compile/)
    rejects(() => f({ tests: [{ field: 'body', op: 'regex' as 'is', value: 'a' }] }), /regex/)
    rejects(() => f({ tests: [] }))
    rejects(() => f({ actions: [{ kind: 'fileinto', folder: '../../etc' }] }), /folder/)
    rejects(() => f({ actions: [{ kind: 'fileinto', folder: 'a..b' }] }), /folder/)
    rejects(() => f({ actions: [{ kind: 'reject', message: 'no' }, { kind: 'keep' }] }), /reject/)
    rejects(() => f({ actions: [{ kind: 'discard' }, { kind: 'redirect', to: 'a@b.com' }] }), /discard/)
    rejects(() => f({ actions: [{ kind: 'stop' }, { kind: 'keep' }] }), /stop/)
    rejects(() => f({ actions: [{ kind: 'redirect', to: 'a@b.com\n' }] }))
    rejects(() => f({ match: 'some' as 'all' }))
    const many = Array.from({ length: 5 }, (_, i) => ({ ...filters[2]!, name: `r${i}` }))
    rejects(() => renderFilterSieve(many), /redirects/)
  })

  it('places the script in the mailbox dir owned by the account', () => {
    expect(sieveFile(account, 'Info@Example.com', 'keep;\n')).toEqual({
      path: '/home/alice/mail/example.com/info/.dovecot.sieve',
      content: 'keep;\n',
      mode: 0o600,
      owner: 'alice',
      group: 'alice',
    })
    rejects(() => sieveFile(account, '../x@example.com', 'keep;'))
  })
})

describe('dkimDnsRecord', () => {
  it('publishes an RSA SPKI key as a chunkable TXT at <selector>._domainkey', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const r = dkimDnsRecord('Example.com', 'default', pem)
    expect(r).toMatchObject({ zone: 'example.com', name: 'default._domainkey', type: 'TXT', content: `v=DKIM1; k=rsa; p=${der}` })
    expect(r.content.length).toBeGreaterThan(255)
  })

  it('publishes the raw 32-byte ed25519 key (RFC 8463), not the SPKI', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const spki = publicKey.export({ type: 'spki', format: 'der' })
    const r = dkimDnsRecord('example.com', 'ed', publicKey.export({ type: 'spki', format: 'pem' }).toString(), { keyType: 'ed25519' })
    expect(r.content).toBe(`v=DKIM1; k=ed25519; p=${spki.subarray(12).toString('base64')}`)
  })

  it('writes the loopback submission service and keeps the managed block idempotent', () => {
    const main = localDeliveryMainBlock(debian)
    expect(main).toContain('virtual_transport = lmtp:unix:private/dovecot-lmtp')
    expect(main).not.toContain('reject_sender_login_mismatch')
    const master = localSubmissionMasterBlock(debian)
    expect(master).toContain('127.0.0.1:587 inet n - n - - smtpd')
    expect(master).toContain('smtpd_sender_restrictions=reject_sender_login_mismatch')
    expect(master).toContain('smtpd_tls_security_level=may')
    expect(master).toContain('smtpd_tls_auth_only=yes')
    expect(master).toContain('smtpd_sasl_auth_enable=yes')
    expect(main).toContain('smtpd_sasl_auth_enable = no')
    expect(main).toContain('smtpd_milters = local:opendkim/opendkim.sock')
    expect(main).toContain('non_smtpd_milters = local:opendkim/opendkim.sock')
    expect(main).toContain('milter_protocol = 6')
    expect(main).toContain('milter_default_action = accept')
    expect(main).not.toContain('message_size_limit')
    expect(main).not.toMatch(/smtpd_sasl_auth_enable\s*=\s*yes/)
    expect(mailboxPostmaster('mail.example.test')).toBe('postmaster@mail.example.test')
    expect(mailboxPostmaster('localhost')).toBe('postmaster@localhost.localdomain')
    expect(resolveMailboxPostmaster(undefined, 'postmaster_address = postmaster@mail.example.test\n')).toBe('postmaster@mail.example.test')
    expect(resolveMailboxPostmaster('other.example.test', 'postmaster_address = postmaster@mail.example.test\n')).toBe('postmaster@other.example.test')
    expect(probeLocalSubmissionAuth(debian)).toEqual({
      port25SaslEnabled: false,
      submissionSaslEnabled: true,
      submissionTlsAuthOnly: true,
      submissionRejectsSenderLoginMismatch: true,
      ok: true,
    })
    const once = replaceManagedBlock('queue_directory = /var/spool/postfix\n', main)
    expect(replaceManagedBlock(once, main)).toBe(once)
    expect(once).toContain('queue_directory = /var/spool/postfix')
    const mailbox = renderDovecotMailboxConf(debian, { postmaster: 'postmaster@host.example' })
    expect(mailbox.path).toBe('/etc/dovecot/conf.d/11-xpanel-mailboxes.conf')
    expect(mailbox.content).toContain('passwd-file')
    expect(mailbox.content).toContain('result_success = return-ok')
    expect(mailbox.content).toContain('/var/spool/postfix/private/auth')
    expect(mailbox.content).toContain('/var/spool/postfix/private/dovecot-lmtp')
    expect(mailbox.content).toContain('postmaster_address = postmaster@host.example')
  })

  it('rejects bad selectors, garbage keys and weak RSA', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 512 })
    rejects(() => dkimDnsRecord('example.com', 'default', publicKey.export({ type: 'spki', format: 'pem' }).toString()), /RSA/)
    rejects(() => dkimDnsRecord('example.com', 'a.b', 'AAAA'))
    rejects(() => dkimDnsRecord('example.com', 'sel', 'not base64!'))
    rejects(() => dkimDnsRecord('example.com', 'sel', 'AAAA', { keyType: 'dsa' as 'rsa' }))
  })
})
