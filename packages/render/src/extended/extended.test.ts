import { describe, expect, it } from 'vitest'
import {
  buildAppInstallManifest,
  findOrphanDnsZones,
  parseAddressImportCsv,
  provisionBatchDkimSpfDmarc,
  renderAccountMemcachedUnit,
  renderAccountRedisInstance,
  parseHtpasswd,
  renderDirectoryPrivacy,
  renderDomainForwardersMap,
  renderGitPostReceiveHook,
  renderHotlinkProtection,
  renderHostnameChange,
  renderLogrotateConfig,
  renderMailingListConfig,
  renderMongoProvisionJson,
  renderMtaAdvancedConfig,
  renderPostgresHbaEntries,
  renderPostgresProvisionSql,
  renderQuotaInitActions,
  renderRemoteMysqlGrantsSql,
  renderSieveFilterScript,
  renderZoneFromTemplate,
} from './index.ts'

const sampleAccount = {
  username: 'alice',
  uid: 20001,
  gid: 20001,
  home: '/home/alice',
}

describe('1. First-Run Setup, Hostname Change & Filesystem Quota Initialization', () => {
  it('renderHostnameChange renders /etc/hostname, /etc/hosts, and hostnamectl action', () => {
    const res = renderHostnameChange('srv1.example.com', '203.0.113.10', '2001:db8::10')
    expect(res.files).toHaveLength(2)
    expect(res.files[0]).toEqual({
      path: '/etc/hostname',
      content: 'srv1.example.com\n',
      mode: 0o644,
      owner: 'root',
      group: 'root',
    })
    expect(res.files[1]?.path).toBe('/etc/hosts')
    expect(res.files[1]?.content).toContain('203.0.113.10 srv1.example.com srv1')
    expect(res.files[1]?.content).toContain('2001:db8::10 srv1.example.com srv1')
    expect(res.actions).toEqual([
      { kind: 'exec', argv: ['/usr/bin/hostnamectl', 'set-hostname', 'srv1.example.com'] },
    ])
  })

  it('renderHostnameChange keeps unrelated /etc/hosts lines and replaces only the host name mapping', () => {
    const debian = '127.0.0.1\tlocalhost\n127.0.1.1\told-vm\n# IPv6 hosts\n::1     localhost ip6-localhost ip6-loopback\nff02::1 ip6-allnodes\n10.0.0.5 db.internal srv1 srv1.example.com\n203.0.113.10 old.example.com old\n'
    const first = renderHostnameChange('srv1.example.com', '203.0.113.10', null, debian).files[1]!.content
    expect(first).toBe('# Managed by xPanel\n127.0.0.1\tlocalhost\n# IPv6 hosts\n::1     localhost ip6-localhost ip6-loopback\nff02::1 ip6-allnodes\n10.0.0.5 db.internal\n203.0.113.10 srv1.example.com srv1\n')
    // The written file is read back on the next reconcile; the result must not change.
    expect(renderHostnameChange('srv1.example.com', '203.0.113.10', null, first).files[1]!.content).toBe(first)
    expect(renderHostnameChange('srv1.example.com', '203.0.113.10', null, '').files[1]!.content).toBe('# Managed by xPanel\n127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n203.0.113.10 srv1.example.com srv1\n')
  })

  it('renderHostnameChange rejects invalid hostnames or IPs', () => {
    expect(() => renderHostnameChange(`${'a'.repeat(60)}.example.com`, '203.0.113.10')).toThrow(/at most 64 characters/)
    expect(() => renderHostnameChange('not-an-fqdn', '203.0.113.10')).toThrow()
    expect(() => renderHostnameChange('srv1.example.com', '999.999.999.999')).toThrow()
    expect(() => renderHostnameChange('srv1.example.com', '203.0.113.10', 'not-ipv6')).toThrow()
  })

  it('renderQuotaInitActions validates mountpoints and emits argv-only actions', () => {
    const rootActions = renderQuotaInitActions('/')
    expect(rootActions).toEqual([
      { kind: 'exec', argv: ['/usr/sbin/quotacheck', '-cugm', '/'] },
      { kind: 'exec', argv: ['/usr/sbin/quotaon', '-vug', '/'] },
    ])

    const homeActions = renderQuotaInitActions('/home')
    expect(homeActions).toEqual([
      { kind: 'exec', argv: ['/usr/sbin/quotacheck', '-cugm', '/home'] },
      { kind: 'exec', argv: ['/usr/sbin/quotaon', '-vug', '/home'] },
    ])

    expect(() => renderQuotaInitActions('/etc')).toThrow()
    expect(() => renderQuotaInitActions('/home; rm -rf /')).toThrow()
  })

  it('renderLogrotateConfig rotates error, backend and PHP-FPM logs but never the metered site access logs', () => {
    const file = renderLogrotateConfig({ rotateDays: 14, apacheService: 'apache2', fpmAccounts: ['bob', 'alice', 'bob'] })
    expect(file.path).toBe('/etc/logrotate.d/xpanel')
    expect(file.content).toContain('/var/log/xpanel/nginx/*.error.log {')
    expect(file.content).not.toContain('access.log')
    expect(file.content).toContain('/var/log/xpanel/apache/*.log {')
    expect(file.content).toContain('/usr/bin/systemctl kill --kill-whom=main --signal=USR1 nginx.service')
    expect(file.content).toContain('/usr/bin/systemctl reload apache2.service')
    expect(file.content).toContain('rotate 14')
    expect(file.content.match(/php-fpm\/\w+\/\*\.log \{\n {2}su \w+ \w+/g)).toEqual(['php-fpm/alice/*.log {\n  su alice alice', 'php-fpm/bob/*.log {\n  su bob bob'])
    expect(renderLogrotateConfig({ rotateDays: 7, apacheService: null, fpmAccounts: [] }).content).not.toContain('apache')
    expect(() => renderLogrotateConfig({ rotateDays: 0, apacheService: null, fpmAccounts: [] })).toThrow()
    expect(() => renderLogrotateConfig({ rotateDays: 7, apacheService: 'x; rm', fpmAccounts: [] })).toThrow()
    expect(() => renderLogrotateConfig({ rotateDays: 7, apacheService: null, fpmAccounts: ['../etc'] })).toThrow()
  })
})

describe('2. Deep Mail (Domain Forwarders, Mailing Lists, Sieve Filters, CSV Import, CalDAV/CardDAV)', () => {
  it('renderDomainForwardersMap renders sorted domain aliases and postmap action', () => {
    const res = renderDomainForwardersMap([
      { fromDomain: 'beta.example.com', toDomain: 'primary.example.com' },
      { fromDomain: 'alpha.example.com', toDomain: 'primary.example.com' },
    ])
    expect(res.file.path).toBe('/etc/postfix/xpanel_domain_aliases')
    expect(res.file.content).toContain('@alpha.example.com @primary.example.com\n@beta.example.com @primary.example.com')
    expect(res.action).toEqual({
      kind: 'exec',
      argv: ['/usr/sbin/postmap', '/etc/postfix/xpanel_domain_aliases'],
    })

    expect(() =>
      renderDomainForwardersMap([{ fromDomain: 'same.example.com', toDomain: 'same.example.com' }]),
    ).toThrow()
    expect(() =>
      renderDomainForwardersMap([
        { fromDomain: 'dup.example.com', toDomain: 'a.example.com' },
        { fromDomain: 'dup.example.com', toDomain: 'b.example.com' },
      ]),
    ).toThrow()
  })

  it('renderMailingListConfig renders list config and Postfix aliases', () => {
    const file = renderMailingListConfig({
      name: 'devs',
      domain: 'example.com',
      adminEmail: 'owner@example.com',
      archivePublic: false,
      members: ['bob@example.com', 'alice@example.com', 'bob@example.com'],
    })
    expect(file.path).toBe('/var/lib/xpanel/mailing-lists/example.com/devs.conf')
    expect(file.mode).toBe(0o640)
    expect(file.group).toBe('postfix')
    expect(file.content).toContain('list_address = devs@example.com')
    expect(file.content).toContain('archive_public = no')
    expect(file.content).toContain('alias_owner = devs-owner@example.com -> owner@example.com')
    expect(file.content).toContain('members = alice@example.com,bob@example.com')
  })

  it('renderSieveFilterScript compiles RFC 5228 Sieve script with rules and vacation', () => {
    const script = renderSieveFilterScript(
      [
        {
          name: 'Spam to Junk',
          enabled: true,
          field: 'spam_score',
          comparator: 'gt',
          value: '5',
          action: 'fileinto',
          target: 'Junk',
        },
        {
          name: 'Forward Invoices',
          enabled: true,
          field: 'subject',
          comparator: 'contains',
          value: 'Invoice',
          action: 'redirect',
          target: 'billing@example.com',
        },
        {
          name: 'Block Bad Sender',
          enabled: true,
          field: 'from',
          comparator: 'equals',
          value: 'spammer@bad.example.com',
          action: 'reject',
          target: 'No spam allowed',
        },
        {
          name: 'Oversize Discard',
          enabled: true,
          field: 'size',
          comparator: 'gt',
          value: '10485760',
          action: 'discard',
        },
      ],
      {
        enabled: true,
        subject: 'Out of Office',
        body: 'I am away until Monday.',
        days: 7,
      },
    )

    expect(script).toContain('require ["fileinto", "reject", "vacation", "relational", "comparator-i;ascii-numeric"];')
    expect(script).toContain('header :value "gt" :comparator "i;ascii-numeric" "X-Spam-Score" "5"')
    expect(script).toContain('fileinto "Junk";')
    expect(script).toContain('redirect "billing@example.com";')
    expect(script).toContain('reject "No spam allowed";')
    expect(script).toContain('size :over 10485760')
    expect(script).toContain('vacation :days 7 :subject "Out of Office" "I am away until Monday.";')
  })

  it('parseAddressImportCsv parses mailboxes, forwarders, and collects line errors', () => {
    const csv = [
      'type,address,target_or_quota',
      'mailbox,alice,2048',
      'mailbox,bob@example.com,1024',
      'forwarder,sales,team@example.com',
      'support@example.com,helpdesk@example.com',
      'carol,512',
      'mailbox,bad_email@@example.com,500',
      'mailbox,dave,-10',
    ].join('\n')

    const parsed = parseAddressImportCsv(csv, 'example.com')
    expect(parsed.mailboxes).toEqual([
      { email: 'alice@example.com', quotaMb: 2048 },
      { email: 'bob@example.com', quotaMb: 1024 },
      { email: 'carol@example.com', quotaMb: 512 },
    ])
    expect(parsed.forwarders).toEqual([
      { source: 'sales@example.com', destination: 'team@example.com' },
      { source: 'support@example.com', destination: 'helpdesk@example.com' },
    ])
    expect(parsed.errors).toHaveLength(2)
    expect(parsed.errors[0]?.line).toBe(7)
    expect(parsed.errors[1]?.line).toBe(8)
  })
})

describe('3. Operational DNS (Zone Templates, Batch DKIM/SPF/DMARC, Zone Cleanup)', () => {
  it('renderZoneFromTemplate produces records for standard, simple, and virtualftp templates', () => {
    const std = renderZoneFromTemplate('standard', {
      domain: 'example.com',
      ipv4: '203.0.113.5',
      ipv6: '2001:db8::5',
      mailIp: '203.0.113.9',
      nameservers: ['ns1.example.com', 'ns2.example.com'],
    })
    expect(std.some((r) => r.type === 'A' && r.name === '@' && r.content === '203.0.113.5')).toBe(true)
    expect(std.some((r) => r.type === 'AAAA' && r.name === '@' && r.content === '2001:db8::5')).toBe(true)
    expect(std.some((r) => r.type === 'A' && r.name === 'mail' && r.content === '203.0.113.9')).toBe(true)
    expect(std.some((r) => r.type === 'MX' && r.priority === 10 && r.content === 'mail.example.com')).toBe(true)
    expect(std.some((r) => r.type === 'CNAME' && r.name === 'www')).toBe(true)
    expect(std.some((r) => r.type === 'CNAME' && r.name === 'webmail')).toBe(true)
    expect(std.some((r) => r.type === 'CNAME' && r.name === 'cpanel')).toBe(true)
    expect(std.some((r) => r.type === 'CNAME' && r.name === 'whm')).toBe(true)
    expect(std.some((r) => r.type === 'TXT' && r.name === '_dmarc')).toBe(true)

    const vftp = renderZoneFromTemplate('virtualftp', {
      domain: 'example.com',
      ipv4: '203.0.113.5',
      nameservers: ['ns1.example.com'],
    })
    expect(vftp.some((r) => r.type === 'A' && r.name === 'ftp' && r.content === '203.0.113.5')).toBe(true)
  })

  it('provisionBatchDkimSpfDmarc builds SPF, DKIM, and DMARC records for batch domains', () => {
    const map = provisionBatchDkimSpfDmarc([
      {
        domain: 'example.com',
        ipv4: '203.0.113.5',
        ipv6: '2001:db8::5',
        dkimPublicKeyB64: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1234567890==',
        spfPolicy: '-all',
        dmarcPolicy: 'reject',
      },
    ])
    const entry = map.get('example.com')
    expect(entry).toBeDefined()
    expect(entry?.spfTxt).toBe('v=spf1 a mx ip4:203.0.113.5 ip6:2001:db8::5 -all')
    expect(entry?.dkimTxt).toContain('v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1234567890==')
    expect(entry?.dmarcTxt).toBe('v=DMARC1; p=reject; rua=mailto:postmaster@example.com')
  })

  it('findOrphanDnsZones returns sorted orphan zones', () => {
    const orphans = findOrphanDnsZones(
      ['active.example.com', 'orphan2.example.com', 'orphan1.example.com'],
      ['active.example.com'],
    )
    expect(orphans).toEqual(['orphan1.example.com', 'orphan2.example.com'])
  })
})

describe('4. Extended File & Web Isolation (Directory Privacy, Hotlink, Web Disk, Git Hook)', () => {
  const SHA512 = '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1'
  const BCRYPT = '$2y$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'
  it('renderDirectoryPrivacy renders the cPanel passwd file and the Basic auth .htaccess block', () => {
    const res = renderDirectoryPrivacy(sampleAccount, 'public_html/admin', { enabled: true, authName: 'Restricted Area', users: [
      { username: 'admin', passwordHash: SHA512 }, { username: 'ops', passwordHash: BCRYPT },
    ] })
    expect(res.passwdPath).toBe('.htpasswds/public_html/admin/passwd')
    expect(res.passwd).toBe(`admin:${SHA512}\nops:${BCRYPT}\n`)
    expect(res.htaccessBody).toEqual(['AuthType Basic', 'AuthName "Restricted Area"', 'AuthUserFile "/home/alice/.htpasswds/public_html/admin/passwd"', 'Require valid-user'])
    const off = renderDirectoryPrivacy(sampleAccount, 'public_html/admin', { enabled: false, authName: '', users: [{ username: 'admin', passwordHash: SHA512 }] })
    expect(off.htaccessBody).toEqual([])
    expect(off.passwd).toBe(`admin:${SHA512}\n`)
    expect(renderDirectoryPrivacy(sampleAccount, 'public_html', { enabled: true, authName: 'Site', users: [] }).passwd).toBe('')
  })

  it.each([
    ['traversal', { rel: '../etc' }], ['absolute', { rel: '/public_html' }], ['trailing slash', { rel: 'public_html/' }], ['hidden top folder', { rel: '.htpasswds/x' }],
    ['quote in name', { authName: 'a"b' }], ['backslash in name', { authName: 'a\b' }], ['newline in name', { authName: 'a\nRequire all granted' }], ['empty name when enabled', { authName: '' }],
    ['untrimmed name', { authName: ' A ' }], ['bad username', { users: [{ username: 'a:b', passwordHash: SHA512 }] }],
    ['duplicate user', { users: [{ username: 'a', passwordHash: SHA512 }, { username: 'a', passwordHash: SHA512 }] }],
    ['argon2 hash Apache cannot verify', { users: [{ username: 'a', passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA' }] }],
    ['plain text password', { users: [{ username: 'a', passwordHash: 'secret password' }] }],
  ])('renderDirectoryPrivacy refuses %s', (_name, patch: { rel?: string; authName?: string; users?: { username: string; passwordHash: string }[] }) => {
    expect(() => renderDirectoryPrivacy(sampleAccount, patch.rel ?? 'public_html/admin', { enabled: true, authName: patch.authName ?? 'Area', users: patch.users ?? [] })).toThrow()
  })

  it('parseHtpasswd keeps Apache hashes and refuses lines it cannot manage', () => {
    expect(parseHtpasswd('')).toEqual([])
    expect(parseHtpasswd(`a:${SHA512}\nb:${BCRYPT}\nc:{SHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=\nd:$apr1$abcdefgh$abcdefghijklmnopqrstuv\n`)!.map(entry => entry.username)).toEqual(['a', 'b', 'c', 'd'])
    for (const bad of ['# comment\n', 'a\n', `a:${SHA512}\na:${SHA512}\n`, 'a:plaintext\n', `\na:${SHA512}\n`, `user@x:${SHA512}\n`]) expect(parseHtpasswd(bad), bad).toBeNull()
  })

  it('renderHotlinkProtection renders Nginx and Apache hotlink rules', () => {
    const res = renderHotlinkProtection({
      enabled: true,
      allowedDomains: ['example.com', 'cdn.example.com'],
      extensions: ['jpg', 'png', 'mp4'],
      allowBlankReferrer: true,
      redirectUrl: 'https://example.com/no-hotlink.png',
    })
    expect(res.nginxSnippet).toContain('valid_referers none blocked server_names example.com cdn.example.com;')
    expect(res.nginxSnippet).toContain('return 302 https://example.com/no-hotlink.png;')
    expect(res.apacheSnippet).toContain('RewriteEngine On')
    expect(res.apacheSnippet).toContain('RewriteRule \\.(jpg|png|mp4)$ https://example.com/no-hotlink.png [R=302,L]')
  })

  it('renderGitPostReceiveHook renders isolated post-receive deployment script', () => {
    const hook = renderGitPostReceiveHook(sampleAccount, 'my-site', 'public_html', 'main')
    expect(hook.path).toBe('/home/alice/repos/my-site.git/hooks/post-receive')
    expect(hook.mode).toBe(0o750)
    expect(hook.owner).toBe('alice')
    expect(hook.content).toContain('TARGET_BRANCH="refs/heads/main"')
    expect(hook.content).toContain('--work-tree="$WORK_TREE" --git-dir="$GIT_DIR" checkout -f "main"')
  })
})

describe('5. Databases Beyond MariaDB (PostgreSQL, Remote Access, Repair, Redis, Memcached, MongoDB)', () => {
  it('renderPostgresProvisionSql generates SCRAM-SHA-256 role and UTF8 database SQL', () => {
    const scram = 'SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVkS2V5:c2VydmVyS2V5'
    const sql = renderPostgresProvisionSql('alice_app', 'alice_user', scram)
    expect(sql).toHaveLength(4)
    expect(sql[0]).toContain('CREATE ROLE "alice_user" WITH LOGIN PASSWORD')
    expect(sql[1]).toBe('CREATE DATABASE "alice_app" OWNER "alice_user" ENCODING \'UTF8\';')
  })

  it('renderPostgresHbaEntries generates scram-sha-256 pg_hba lines', () => {
    const hba = renderPostgresHbaEntries('alice', ['198.51.100.25', '2001:db8::1'])
    expect(hba).toContain('hostssl all +alice 198.51.100.25/32 scram-sha-256')
    expect(hba).toContain('hostssl all +alice 2001:db8::1/128 scram-sha-256')
  })

  it('renderRemoteMysqlGrantsSql escapes database underscores and grants per host', () => {
    const grants = renderRemoteMysqlGrantsSql('alice_shop', 'alice_web', ['198.51.100.10', 'db.example.com'])
    expect(grants).toEqual([
      "GRANT ALL PRIVILEGES ON `alice\\_shop`.* TO 'alice_web'@'198.51.100.10';",
      "GRANT ALL PRIVILEGES ON `alice\\_shop`.* TO 'alice_web'@'db.example.com';",
    ])
  })

  it('renderAccountRedisInstance renders Unix-socket Redis config and slice-bound unit', () => {
    const res = renderAccountRedisInstance(sampleAccount, 256)
    expect(res.conf.path).toBe('/etc/xpanel/redis/alice.conf')
    expect(res.conf.content).toContain('port 0')
    expect(res.conf.content).toContain('unixsocket /home/alice/.run/redis.sock')
    expect(res.conf.content).toContain('maxmemory 256mb')
    expect(res.unit.path).toBe('/etc/systemd/system/xpanel-redis-alice.service')
    expect(res.unit.content).toContain('Slice=xpanel-20001.slice')
  })

  it('renderAccountMemcachedUnit renders Unix-socket Memcached systemd unit', () => {
    const unit = renderAccountMemcachedUnit(sampleAccount, 128)
    expect(unit.path).toBe('/etc/systemd/system/xpanel-memcached-alice.service')
    expect(unit.content).toContain('-s /home/alice/.run/memcached.sock -a 0770 -m 128')
    expect(unit.content).toContain('Slice=xpanel-20001.slice')
  })

  it('renderMongoProvisionJson renders deterministic SCRAM-SHA-256 user creation JSON', () => {
    const json = renderMongoProvisionJson('alice_mongo', 'alice_muser', ['readWrite', 'dbAdmin'])
    const parsed = JSON.parse(json)
    expect(parsed).toEqual({
      createUser: 'alice_muser',
      db: 'alice_mongo',
      roles: [
        { role: 'readWrite', db: 'alice_mongo' },
        { role: 'dbAdmin', db: 'alice_mongo' },
      ],
      mechanisms: ['SCRAM-SHA-256'],
    })
  })
})

describe('6. Server Settings, Rootless Containers, App Store & Web Stack Profile', () => {
  it('renderMtaAdvancedConfig renders Postfix smarthost, rate limits, RBLs, and greylisting', () => {
    const file = renderMtaAdvancedConfig({
      smarthost: 'smtp.relay.example.com:587',
      maxMsgSizeMb: 50,
      rateLimitPerHour: 500,
      rblDomains: ['zen.spamhaus.org', 'bl.spamcop.net'],
      greylistingEnabled: true,
    })
    expect(file.path).toBe('/etc/postfix/xpanel_mta_advanced.cf')
    expect(file.content).toContain('relayhost = [smtp.relay.example.com]:587')
    expect(file.content).toContain('smtpd_client_message_rate_limit = 500')
    expect(file.content).toContain('reject_rbl_client zen.spamhaus.org')
    expect(file.content).toContain('check_policy_service unix:private/postgrey')
  })

  it('buildAppInstallManifest supports all 6 application kinds', () => {
    const kinds = ['wordpress', 'laravel', 'drupal', 'joomla', 'ghost', 'nextcloud'] as const
    for (const kind of kinds) {
      const manifest = buildAppInstallManifest(kind, {
        domain: 'app.example.com',
        docRoot: '/home/alice/public_html',
        dbName: 'alice_app',
        dbUser: 'alice_user',
        adminEmail: 'admin@example.com',
        version: '1.0.0',
      })
      expect(manifest.appKind).toBe(kind)
      expect(manifest.filesToCreate.length).toBeGreaterThan(0)
      expect(manifest.cliSetupArgv.length).toBeGreaterThan(0)
      expect(manifest.envVars.APP_DOMAIN).toBe('app.example.com')
    }
  })
})
