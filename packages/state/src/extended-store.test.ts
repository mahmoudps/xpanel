import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteJson } from './atomic.ts'
import { ExtendedFeaturesStore } from './extended-store.ts'

describe('ExtendedFeaturesStore', () => {
  let rootDir: string
  let store: ExtendedFeaturesStore

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'xpanel-ext-state-'))
    store = new ExtendedFeaturesStore(rootDir)
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // 1. First-Run Setup Wizard, Hostname & Quota Initialization
  // -------------------------------------------------------------------------
  describe('1. Setup Wizard, Hostname & Quota Initialization', () => {
    it('tracks wizard step progress, completes wizard, changes hostname, and initializes quota', async () => {
      const initial = await store.getSetupWizardState()
      expect(initial.completed).toBe(false)
      expect(initial.currentStep).toBe(1)

      const step2 = await store.saveSetupWizardStep({
        step: 2,
        hostname: 'srv1.example.com',
        engine: 'openlitespeed',
      })
      expect(step2.currentStep).toBe(2)
      expect(step2.hostname).toBe('srv1.example.com')
      expect(step2.engine).toBe('openlitespeed')

      const completed = await store.completeSetupWizard({
        hostname: 'srv1.example.com',
        nameservers: ['ns1.example.com', 'ns2.example.com'],
        contactEmail: 'ops@example.com',
        engine: 'openlitespeed',
        primaryIpv4: '203.0.113.10',
        primaryIpv6: '2001:db8::10',
        quotaFilesystem: '/home',
        quotaInitialized: true,
      })
      expect(completed.completed).toBe(true)
      expect(completed.completedAt).toBeTruthy()
      expect(completed.nameservers).toEqual(['ns1.example.com', 'ns2.example.com'])

      const renamed = await store.changeHostname('srv2.example.com')
      expect(renamed.hostname).toBe('srv2.example.com')

      const quota = await store.initializeFilesystemQuota('/')
      expect(quota.filesystem).toBe('/')
      expect(quota.quotaInitialized).toBe(true)
      expect(quota.status).toBe('enabled')

      const reloaded = await new ExtendedFeaturesStore(rootDir).getSetupWizardState()
      expect(reloaded.hostname).toBe('srv2.example.com')
      expect(reloaded.quotaFilesystem).toBe('/')
      expect(reloaded.quotaInitialized).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // 2. Deep Mail & xMail Webmail State
  // -------------------------------------------------------------------------
  describe('2. Deep Mail & xMail Webmail State', () => {
    const accId = 'acc-mail-01'

    it('manages domain forwarders, email forwarders, and mailing lists', async () => {
      const df = await store.saveDomainForwarder({
        accountId: accId,
        fromDomain: 'alias-brand.com',
        toDomain: 'primary-brand.com',
      })
      expect(df.fromDomain).toBe('alias-brand.com')
      expect(await store.listDomainForwarders(accId)).toHaveLength(1)
      expect(await store.deleteDomainForwarder(df.id)).toBe(true)
      expect(await store.listDomainForwarders(accId)).toHaveLength(0)

      const ef = await store.saveEmailForwarder({
        accountId: accId,
        source: 'sales@primary-brand.com',
        destination: 'founder@primary-brand.com',
      })
      expect(ef.source).toBe('sales@primary-brand.com')
      expect(await store.listEmailForwarders(accId)).toHaveLength(1)
      expect(await store.deleteEmailForwarder(ef.id)).toBe(true)

      const ml = await store.saveMailingList({
        accountId: accId,
        name: 'announce',
        domain: 'primary-brand.com',
        adminEmail: 'owner@primary-brand.com',
        archivePublic: true,
        members: ['b@primary-brand.com', 'a@primary-brand.com', 'a@primary-brand.com'],
      })
      expect(ml.listAddress).toBe('announce@primary-brand.com')
      expect(ml.members).toEqual(['a@primary-brand.com', 'b@primary-brand.com'])
      expect(await store.listMailingLists(accId)).toHaveLength(1)
      expect(await store.deleteMailingList(ml.id)).toBe(true)
    })

    it('manages email filters, spam settings, CSV address import, and delivery tracking', async () => {
      const f1 = await store.saveEmailFilter({
        accountId: accId,
        mailbox: 'alice@example.com',
        name: 'Block Invoice Spam',
        rules: [{ field: 'subject', operator: 'contains', value: 'URGENT WIRE' }],
        action: 'discard',
        priority: 1,
      })
      const f2 = await store.saveEmailFilter({
        accountId: accId,
        mailbox: null,
        name: 'Global Archive',
        rules: [{ field: 'to', operator: 'contains', value: '@example.com' }],
        action: 'folder',
        actionTarget: 'Archive',
        priority: 5,
      })
      expect(await store.listEmailFilters(accId)).toHaveLength(2)
      expect(await store.listEmailFilters(accId, 'alice@example.com')).toHaveLength(1)
      expect(await store.deleteEmailFilter(f1.id)).toBe(true)
      expect(await store.deleteEmailFilter(f2.id)).toBe(true)

      const spam = await store.saveSpamSettings(accId, {
        spamAssassinEnabled: true,
        scoreThreshold: 4.5,
        autoDelete: true,
        autoDeleteScore: 8.0,
        spamBoxEnabled: true,
        whitelist: ['trusted@partner.com'],
        blacklist: ['spammer@bad.org'],
      })
      expect(spam.scoreThreshold).toBe(4.5)
      expect((await store.getSpamSettings(accId)).whitelist).toEqual(['trusted@partner.com'])

      const csv = [
        'email,password,quota',
        'dev1@example.com,Secr3t!,2048',
        'dev2,Secr3t!,1024',
        'support@example.com,helpdesk@example.com',
        'bad@@address,pass,500',
      ].join('\n')
      const imported = await store.importAddressesCsv(accId, csv, 'example.com')
      expect(imported.importedMailboxes).toBe(2)
      expect(imported.importedForwarders).toBe(1)
      expect(imported.errors).toHaveLength(1)
      expect(await store.listEmailForwarders(accId)).toHaveLength(1)

      await store.recordDeliveryEvent({
        accountId: accId,
        sender: 'noreply@example.com',
        recipient: 'client@customer.org',
        status: 'delivered',
      })
      await store.recordDeliveryEvent({
        accountId: accId,
        sender: 'noreply@example.com',
        recipient: 'bounce@invalid.org',
        status: 'bounced',
        smtpCode: 550,
        message: 'User unknown',
      })
      expect(await store.listDeliveryRecords({ accountId: accId })).toHaveLength(2)
      expect(await store.listDeliveryRecords({ accountId: accId, status: 'bounced' })).toHaveLength(1)
    })

    it('supports xMail webmail messages, search, identities, vacation, CalDAV calendars, and CardDAV contacts', async () => {
      const box = 'alice@example.com'
      const sent = await store.sendWebmailMessage({
        mailboxLogin: box,
        from: box,
        to: 'bob@example.com',
        cc: 'team@example.com',
        subject: 'Q4 Infrastructure Budget',
        body: 'Attached is the Q4 server expansion proposal.',
        hasAttachment: true,
      })
      expect(sent.folder).toBe('Sent')
      expect(await store.listWebmailMessages(box, 'Sent')).toHaveLength(1)
      expect(await store.listWebmailMessages('bob@example.com', 'INBOX')).toHaveLength(1)

      const found = await store.searchWebmailMessages(box, {
        q: 'infrastructure',
        hasAttachment: true,
      })
      expect(found).toHaveLength(1)
      expect(found[0]?.id).toBe(sent.id)

      const id1 = await store.saveWebmailIdentity(box, {
        displayName: 'Alice Primary',
        email: box,
        replyTo: box,
        signatureHtml: '<p>Alice</p>',
        isDefault: true,
      })
      const id2 = await store.saveWebmailIdentity(box, {
        displayName: 'Alice Exec',
        email: box,
        replyTo: 'exec@example.com',
        signatureHtml: '<p>Alice Executive</p>',
        isDefault: true,
      })
      const identities = await store.listWebmailIdentities(box)
      expect(identities).toHaveLength(2)
      expect(identities.find((i) => i.id === id1.id)?.isDefault).toBe(false)
      expect(identities.find((i) => i.id === id2.id)?.isDefault).toBe(true)
      expect(await store.deleteWebmailIdentity(box, id1.id)).toBe(true)

      const vac = await store.saveVacationResponder(box, {
        enabled: true,
        subject: 'Out of Office',
        body: 'I am away until Monday.',
        startAt: '2026-10-22T00:00:00Z',
        endAt: '2026-10-26T00:00:00Z',
      })
      expect(vac.enabled).toBe(true)
      expect((await store.getVacationResponder(box)).subject).toBe('Out of Office')

      const cal = await store.saveCalendar(box, {
        name: 'Engineering Releases',
        color: '#2563eb',
        timezone: 'UTC',
        shares: [{ principalEmail: 'bob@example.com', permission: 'read-write' }],
        events: [
          {
            id: 'evt-1',
            title: 'xPanel 2.0 Cutover',
            startAt: '2026-10-25T10:00:00Z',
            endAt: '2026-10-25T11:00:00Z',
            location: 'Control Room',
          },
        ],
      })
      expect(cal.shares).toHaveLength(1)
      expect(await store.listCalendars(box)).toHaveLength(1)

      const contact = await store.saveContact(box, {
        fullName: 'Bob Ops',
        email: 'bob@example.com',
        phone: '+1-555-0100',
        company: 'xPanel Corp',
      })
      expect(await store.listContacts(box)).toHaveLength(1)
      expect(await store.deleteContact(box, contact.id)).toBe(true)
      expect(await store.listContacts(box)).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // 3. Operational DNS
  // -------------------------------------------------------------------------
  describe('3. Operational DNS', () => {
    it('manages DNS zone templates, batch DKIM/SPF/DMARC provisioning, orphan zone cleanup, and external cluster', async () => {
      const defaults = await store.listDnsTemplates()
      expect(defaults.map((t) => t.name)).toEqual(['simple', 'standard', 'virtualftp'])

      await store.saveDnsTemplate({
        name: 'standard',
        records: [
          { type: 'A', name: '@', ttl: 1800, content: '{{ip}}' },
          { type: 'TXT', name: '@', ttl: 1800, content: 'v=spf1 +a +mx ~all' },
        ],
      })
      const updated = (await store.listDnsTemplates()).find((t) => t.name === 'standard')
      expect(updated?.records).toHaveLength(2)

      const authBatch = await store.provisionBatchEmailAuth(
        ['alpha.example.com', 'beta.example.com'],
        '203.0.113.25',
        '2001:db8::25',
      )
      expect(authBatch).toHaveLength(2)
      expect(authBatch[0]?.dkimTxtValue).toContain('v=DKIM1; k=ed25519; p=')
      expect(authBatch[0]?.spfTxtValue).toContain('ip4:203.0.113.25')
      expect(authBatch[0]?.dmarcTxtValue).toContain('v=DMARC1; p=quarantine;')

      await atomicWriteJson(join(rootDir, 'zones', 'keep.example.com.json'), { name: 'keep.example.com' })
      await atomicWriteJson(join(rootDir, 'zones', 'orphan1.example.com.json'), { name: 'orphan1.example.com' })
      await atomicWriteJson(join(rootDir, 'extended', 'dns', 'zones', 'orphan2.example.com.json'), {
        name: 'orphan2.example.com',
      })

      const cleanup = await store.cleanupDnsZones(['keep.example.com'])
      expect(cleanup.removedZones).toEqual(['orphan1.example.com', 'orphan2.example.com'])

      const cluster = await store.saveExternalDnsClusterConfig({
        enabled: true,
        provider: 'cloudflare',
        endpoint: 'https://api.cloudflare.com/client/v4',
        syncRole: 'bidirectional',
        lastSyncedAt: '2026-10-22T06:00:00Z',
      })
      expect(cluster.provider).toBe('cloudflare')
      expect((await store.getExternalDnsClusterConfig()).enabled).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // 4. Complete Backups & Transfers
  // -------------------------------------------------------------------------
  describe('4. Complete Backups & Transfers', () => {
    it('manages remote destinations, backup schedules, snapshots with granular file restore, and live transfer sessions', async () => {
      const dest = await store.saveBackupDestination({
        name: 'Offsite S3 Vault',
        protocol: 's3',
        host: 's3.eu-central-1.amazonaws.com',
        bucketOrPath: 'xpanel-prod-backups',
        enabled: true,
        retentionDays: 30,
      })
      expect(await store.listBackupDestinations()).toHaveLength(1)

      const sched = await store.saveBackupSchedule({
        enabled: true,
        frequency: 'daily',
        retainCount: 14,
        selectedAccountIds: ['acc-1', 'acc-2'],
        destinationIds: [dest.id],
        includeDatabases: true,
        includeMail: true,
      })
      expect(sched.retainCount).toBe(14)
      expect((await store.getBackupSchedule()).destinationIds).toEqual([dest.id])

      const snap = await store.createBackupRecord({
        accountId: 'acc-1',
        username: 'alice',
        kind: 'full',
        sizeBytes: 1048576,
        files: {
          'public_html/index.php': '<?php echo "Hello xPanel"; ?>',
          '.env': 'APP_ENV=production',
        },
        databases: ['alice_wp'],
      })
      expect(await store.listBackups('acc-1')).toHaveLength(1)

      const restored = await store.restoreSingleFileFromBackup(snap.id, '/public_html/index.php')
      expect(restored.relFilePath).toBe('public_html/index.php')
      expect(restored.content).toContain('Hello xPanel')

      const xfer = await store.saveTransferSession({
        sourceHost: 'legacy-cpanel.example.net',
        authMethod: 'ssh-key',
        selectedAccounts: ['alice', 'bob'],
        status: 'transferring',
        progressPercent: 65,
        logs: ['Preflight passed', 'Streaming homedir archive'],
      })
      expect(xfer.progressPercent).toBe(65)
      expect(await store.listTransferSessions()).toHaveLength(1)

      expect(await store.deleteBackupDestination(dest.id)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // 5. Extended File Isolation & Web Features
  // -------------------------------------------------------------------------
  describe('5. Extended File Isolation & Web Features', () => {
    const accId = 'acc-web-01'

    it('manages directory privacy, hotlink protection, WebDisk, Git deploy repos, and web extras', async () => {
      const priv = await store.saveDirectoryPrivacy(accId, {
        relDir: 'public_html/admin',
        authTitle: 'Staff Only',
        enabled: true,
        users: [{ username: 'admin', passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$salt$hash' }],
      })
      expect(priv.enabled).toBe(true)
      expect((await store.getDirectoryPrivacy(accId)).authTitle).toBe('Staff Only')

      const hotlink = await store.saveHotlinkProtection(accId, {
        enabled: true,
        allowedDomains: ['example.com', 'cdn.example.com'],
        extensions: ['.jpg', 'png', 'webp'],
        allowBlankReferrer: false,
        redirectUrl: 'https://example.com/no-hotlink.png',
      })
      expect(hotlink.extensions).toEqual(['jpg', 'png', 'webp'])
      expect((await store.getHotlinkProtection(accId)).enabled).toBe(true)

      const webdisk = await store.saveWebDiskConfig(accId, {
        enabled: true,
        readOnly: false,
        digestAuth: true,
        path: 'public_html/dav',
      })
      expect(webdisk.path).toBe('public_html/dav')

      const repo = await store.saveGitRepo(accId, {
        name: 'marketing-site',
        branch: 'main',
        repoRelPath: 'repos/marketing.git',
        deployRelPath: 'public_html',
        autoDeploy: true,
        lastCommitSha: 'a1b2c3d4',
        releases: [{ id: 'rel-1', commitSha: 'a1b2c3d4', deployedAt: '2026-10-22T05:00:00Z' }],
      })
      expect(await store.listGitRepos(accId)).toHaveLength(1)
      expect(await store.deleteGitRepo(accId, repo.id)).toBe(true)

      const extras = await store.saveWebExtras(accId, {
        errorPages: { '404': '/errors/404.html', '500': '/errors/500.html' },
        redirects: [{ id: 'r1', sourcePath: '/old', targetUrl: 'https://example.com/new', code: 301 }],
        mimeTypes: { '.wasm': 'application/wasm' },
        ipBlocker: ['198.51.100.99', '203.0.113.0/24'],
        directoryIndexes: 'no-indexing',
      })
      expect(extras.directoryIndexes).toBe('no-indexing')
      expect((await store.getWebExtras(accId)).redirects).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // 6. Databases Beyond MariaDB
  // -------------------------------------------------------------------------
  describe('6. Databases Beyond MariaDB', () => {
    const accId = 'acc-db-01'

    it('manages PostgreSQL databases/users, remote DB access hosts, DB maintenance, MongoDB, and Redis/Memcached sockets', async () => {
      const pgDb = await store.createPostgresDatabase(accId, 'alice_analytics')
      expect(pgDb.encoding).toBe('UTF8')
      expect(await store.listPostgresDatabases(accId)).toHaveLength(1)

      const pgUser = await store.createPostgresUser(accId, 'alice_pg', 'scram-sha-256$4096:salt$key')
      expect(pgUser.name).toBe('alice_pg')
      expect(await store.listPostgresUsers(accId)).toHaveLength(1)

      const hosts = await store.saveRemoteDbHosts(accId, ['192.0.2.50', '10.10.0.0/16'])
      expect(hosts).toEqual(['192.0.2.50', '10.10.0.0/16'])
      expect(await store.listRemoteDbHosts(accId)).toHaveLength(2)

      const maint = await store.runDatabaseMaintenance(accId, 'alice_analytics', 'postgresql', 'optimize')
      expect(maint.status).toBe('ok')
      expect(maint.summary).toContain('POSTGRESQL optimize')

      const mongo = await store.saveMongoDatabase(accId, {
        name: 'alice_catalog',
        users: ['alice_mongo_rw'],
      })
      expect(mongo.name).toBe('alice_catalog')
      expect(await store.listMongoDatabases(accId)).toHaveLength(1)

      const cache = await store.saveAccountCacheConfig(accId, {
        redisEnabled: true,
        redisSocketPath: '/run/xpanel-redis/alice.sock',
        redisMemoryMb: 256,
        memcachedEnabled: true,
        memcachedSocketPath: '/run/xpanel-memcached/alice.sock',
        memcachedMemoryMb: 128,
      })
      expect(cache.redisMemoryMb).toBe(256)
      expect((await store.getAccountCacheConfig(accId)).redisEnabled).toBe(true)

      expect(await store.deletePostgresDatabase(accId, pgDb.id)).toBe(true)
      expect(await store.listPostgresDatabases(accId)).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // 7. Fine-Grained Server Settings & Previously Deferred Capabilities
  // -------------------------------------------------------------------------
  describe('7. Fine-Grained Server Settings & Deferred Capabilities', () => {
    const accId = 'acc-ops-01'

    it('manages server fine settings, rootless containers, 1-click apps with staging/live push, cluster nodes, legacy traffic stats, branding, i18n, and WHMCS', async () => {
      const fine = await store.saveServerFineSettings({
        maxMemoryPerProcessMb: 1024,
        maxProcessesPerAccount: 80,
        compilerGroupEnabled: false,
        logRotationDays: 14,
        logCompress: true,
        mtaSmarthost: 'relay.mailgun.org:587',
        mtaMaxMsgSizeMb: 75,
        mtaRateLimitPerHour: 1000,
        mtaRblList: ['zen.spamhaus.org'],
        mtaGreylisting: true,
        webStack: {
          http3Quic: true,
          brotli: true,
          wafOwaspCrs: true,
          installedPhpVersions: ['8.1', '8.2', '8.3', '8.4'],
          installedRuntimes: ['nodejs-22', 'python-3.12', 'go-1.23'],
        },
        installedPackages: ['git', 'redis-tools', 'ffmpeg'],
      })
      expect(fine.maxMemoryPerProcessMb).toBe(1024)
      expect((await store.getServerFineSettings()).mtaSmarthost).toBe('relay.mailgun.org:587')

      const container = await store.saveContainer(accId, {
        name: 'meilisearch-prod',
        image: 'getmeili/meilisearch:v1.10',
        status: 'running',
        internalPort: 7700,
        memoryMb: 512,
        env: { MEILI_ENV: 'production' },
      })
      expect(await store.listContainers(accId)).toHaveLength(1)
      expect(await store.listContainers()).toHaveLength(1)
      expect(await store.deleteContainer(accId, container.id)).toBe(true)

      const app = await store.installApp(accId, {
        kind: 'wordpress',
        domain: 'blog.example.com',
        docRoot: 'public_html/blog',
        version: '6.7.1',
        autoUpdate: true,
      })
      expect(await store.listInstalledApps(accId)).toHaveLength(1)

      const staged = await store.cloneAppToStaging(accId, app.id, 'staging.blog.example.com')
      expect(staged.stagingDomain).toBe('staging.blog.example.com')
      expect(staged.lastStagingSyncAt).toBeTruthy()

      const pushed = await store.pushStagingToLive(accId, app.id)
      expect(pushed.lastStagingSyncAt).toBeTruthy()
      expect(await store.uninstallApp(accId, app.id)).toBe(true)
      expect(await store.listInstalledApps(accId)).toHaveLength(0)

      const node = await store.saveClusterNode({
        name: 'eu-dns-01',
        hostname: 'ns3.example.com',
        ipv4: '198.51.100.53',
        role: 'dns',
        status: 'online',
      })
      expect(await store.listClusterNodes()).toHaveLength(1)
      expect(await store.deleteClusterNode(node.id)).toBe(true)

      const traffic = await store.getLegacyTrafficStats('blog.example.com')
      expect(traffic.generators).toEqual(['awstats', 'webalizer'])
      expect(traffic.monthly.length).toBeGreaterThan(0)
      expect(traffic.daily.length).toBeGreaterThan(0)

      const branding = await store.savePanelBranding({
        companyName: 'Nebula Cloud',
        productName: 'NebulaPanel',
        primaryColorOklch: 'oklch(0.65 0.21 260)',
        logoUrl: 'https://cdn.example.com/logo.svg',
        supportUrl: 'https://help.example.com',
        footerText: '© 2026 Nebula Cloud Ltd.',
      })
      expect(branding.productName).toBe('NebulaPanel')
      expect((await store.getPanelBranding()).companyName).toBe('Nebula Cloud')

      await store.saveLanguageOverrides('ar', { 'nav.dashboard': 'لوحة التحكم المتقدمة' })
      const i18n = await store.getLanguageOverrides()
      expect(i18n.ar['nav.dashboard']).toBe('لوحة التحكم المتقدمة')

      const whmcs = await store.saveWhmcsConfig({
        enabled: true,
        whmcsUrl: 'https://billing.nebulacloud.com',
        apiIdentifier: 'whmcs_key_prod_01',
        allowedServerIps: ['203.0.113.88'],
        autoProvision: true,
        ssoEnabled: true,
        lastWebhookAt: '2026-10-22T06:30:00Z',
      })
      expect(whmcs.enabled).toBe(true)
      expect((await store.getWhmcsConfig()).allowedServerIps).toEqual(['203.0.113.88'])
    })
  })
})
