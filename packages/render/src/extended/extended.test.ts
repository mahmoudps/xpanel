import { describe, expect, it } from 'vitest'
import {
  buildAppInstallManifest,
  buildDatabaseRepairArgv,
  findOrphanDnsZones,
  parseAddressImportCsv,
  provisionBatchDkimSpfDmarc,
  renderAccountMemcachedUnit,
  renderAccountRedisInstance,
  renderCalDavCardDavInclude,
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
  renderRootlessContainerUnit,
  renderSieveFilterScript,
  renderWebDiskConfig,
  renderWebStackProfile,
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

  it('renderHostnameChange rejects invalid hostnames or IPs', () => {
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

  it('renderLogrotateConfig renders /etc/logrotate.d/xpanel', () => {
    const file = renderLogrotateConfig({ rotateDays: 14, maxSizeMb: 100, compress: true })
    expect(file.path).toBe('/etc/logrotate.d/xpanel')
    expect(file.content).toContain('/var/log/nginx/domains/*.log')
    expect(file.content).toContain('/var/log/apache2/domains/*.log')
    expect(file.content).toContain('/var/log/xpanel/*.log')
    expect(file.content).toContain('rotate 14')
    expect(file.content).toContain('maxsize 100M')
    expect(file.content).toContain('compress\n  delaycompress')

    const uncompressed = renderLogrotateConfig({ rotateDays: 7, maxSizeMb: 50, compress: false })
    expect(uncompressed.content).toContain('nocompress')
    expect(() => renderLogrotateConfig({ rotateDays: 0, maxSizeMb: 50, compress: true })).toThrow()
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

  it('renderCalDavCardDavInclude renders Nginx .well-known redirects', () => {
    const snippet = renderCalDavCardDavInclude('example.com')
    expect(snippet).toContain('location = /.well-known/caldav')
    expect(snippet).toContain('location = /.well-known/carddav')
    expect(snippet).toContain('return 301 https://example.com/dav/;')
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
  it('renderDirectoryPrivacy renders htpasswd file, nginxSnippet, and apacheSnippet', () => {
    const res = renderDirectoryPrivacy(sampleAccount, 'public_html/admin', 'Restricted Area', [
      { username: 'admin', passwordHash: '$2y$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234' },
    ])
    expect(res.htpasswdFile.path).toBe('/home/alice/.htpasswds/public_html/admin/passwd')
    expect(res.htpasswdFile.content).toContain('admin:$2y$10$')
    expect(res.nginxSnippet).toContain('auth_basic "Restricted Area";')
    expect(res.apacheSnippet).toContain('AuthType Basic')
    expect(res.apacheSnippet).toContain('Require valid-user')

    expect(() =>
      renderDirectoryPrivacy(sampleAccount, '../etc', 'Bad', [
        { username: 'admin', passwordHash: '$2y$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234' },
      ]),
    ).toThrow()
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

  it('renderWebDiskConfig renders per-account WebDAV config', () => {
    const rw = renderWebDiskConfig(sampleAccount, true, false)
    expect(rw.path).toBe('/etc/xpanel/webdav/alice.conf')
    expect(rw.content).toContain('dav_methods PUT DELETE MKCOL COPY MOVE;')

    const ro = renderWebDiskConfig(sampleAccount, true, true)
    expect(ro.content).toContain('limit_except GET HEAD OPTIONS PROPFIND')
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

  it('buildDatabaseRepairArgv builds argv-only commands for mariadb and postgresql', () => {
    expect(buildDatabaseRepairArgv('mariadb', 'alice_db', 'repair')).toEqual([
      '/usr/bin/mysqlcheck',
      '--repair',
      '--databases',
      'alice_db',
    ])
    expect(buildDatabaseRepairArgv('postgresql', 'alice_db', 'optimize')).toEqual([
      '/usr/bin/vacuumdb',
      '--full',
      '--dbname',
      'alice_db',
    ])
    expect(buildDatabaseRepairArgv('postgresql', 'alice_db', 'repair')).toEqual([
      '/usr/bin/reindexdb',
      '--dbname',
      'alice_db',
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

  it('renderRootlessContainerUnit renders rootless Podman unit in account slice', () => {
    const unit = renderRootlessContainerUnit(sampleAccount, {
      name: 'redis-cache',
      image: 'docker.io/library/redis:7-alpine',
      internalPort: 6379,
      env: { REDIS_AOF: 'yes' },
      memoryMb: 512,
    })
    expect(unit.path).toBe('/etc/systemd/system/xpanel-container-alice-redis-cache.service')
    expect(unit.content).toContain('Slice=xpanel-20001.slice')
    expect(unit.content).toContain('--memory 512m')
    expect(unit.content).toContain('--env REDIS_AOF=yes')
    expect(unit.content).toContain('docker.io/library/redis:7-alpine')
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

  it('renderWebStackProfile renders /etc/xpanel/web-stack.conf', () => {
    const file = renderWebStackProfile({
      engine: 'openlitespeed',
      http3Quic: true,
      brotli: true,
      wafOwaspCrs: true,
      phpVersions: ['8.3', '8.2'],
      maxMemoryPerProcessMb: 512,
    })
    expect(file.path).toBe('/etc/xpanel/web-stack.conf')
    expect(file.content).toContain('engine = openlitespeed')
    expect(file.content).toContain('http3_quic = enabled')
    expect(file.content).toContain('php_versions = 8.2,8.3')
  })
})
