import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import type { PhpSettings, ServerSettings } from '@xpanel/core'
import { aptProfile, parseOsRelease } from '@xpanel/os'
import { edge } from '@xpanel/render'
import type { Body } from '../archive/reader.ts'
import type { ImportSink, SinkItem } from '../archive/sink.ts'
import { buildTar, chunked } from '../testing/tar.ts'
import type { TestEntry } from '../testing/tar.ts'
import { allocateUid, exportAccountArchive, importAccountArchive } from './archive.ts'
import type { AccountExportSource, AccountImportOptions, ExportEntry } from './archive.ts'
import type { AccountArchiveManifest } from './manifest.ts'
import { parseAccountManifest } from './manifest.ts'

class MemorySink implements ImportSink {
  items: { item: SinkItem; data: string }[] = []
  aborted: Error | null = null
  async put(item: SinkItem, body: Body): Promise<string> {
    const parts: Buffer[] = []
    for await (const c of body) parts.push(c)
    this.items.push({ item, data: Buffer.concat(parts).toString() })
    return `ref-${this.items.length}`
  }
  async abort(e: Error): Promise<void> { this.aborted = e }
  data(part: SinkItem['part'], path: string): string | undefined { return this.items.find((i) => i.item.part === part && i.item.path === path)?.data }
  paths(part: SinkItem['part']): string[] { return this.items.filter((i) => i.item.part === part).map((i) => i.item.path) }
}

const manifest: AccountArchiveManifest = {
  format: 'xpanel-account',
  version: 1,
  createdAt: '2026-10-20T10:00:00.000Z',
  source: { hostname: 'old.example.net', panelVersion: '1.4.2' },
  account: { username: 'alice', primaryDomain: 'alice.example', contactEmail: 'alice@gmail.com', plan: 'gold', shell: 'none', ipv4: '203.0.113.10' },
  domains: [
    { name: 'alice.example', kind: 'primary', parent: null, docRoot: 'public_html', siteType: 'php', phpVersion: '8.3', wildcard: true, upstream: null },
    { name: 'shop.example', kind: 'addon', parent: null, docRoot: 'shop.example', siteType: 'php', phpVersion: '5.6', wildcard: false, upstream: null },
    { name: 'www2.shop.example', kind: 'subdomain', parent: 'shop.example', docRoot: 'shop.example/www2', siteType: 'static', phpVersion: '8.3', wildcard: false, upstream: null },
    { name: 'alice.net', kind: 'alias', parent: 'alice.example', docRoot: 'public_html', siteType: 'php', phpVersion: '8.3', wildcard: false, upstream: null },
    { name: 'api.alice.example', kind: 'subdomain', parent: 'alice.example', docRoot: 'api', siteType: 'node', phpVersion: '8.3', wildcard: false, upstream: 'http://127.0.0.1:3000' },
  ],
  databases: ['alice_wp', 'alice_shop'],
  dbUsers: [
    { name: 'alice_wpuser', hosts: ['localhost'], grants: [{ database: 'alice_wp', privileges: ['SELECT', 'INSERT'] }] },
    { name: 'alice', hosts: ['localhost'], grants: [{ database: 'alice_shop', privileges: ['SELECT'] }] },
  ],
  mailboxes: [{ address: 'info@alice.example', quotaMb: 500 }, { address: 'orders@shop.example', quotaMb: 'unlimited' }],
  mail: {
    domains: [
      { domain: 'alice.example', forwarders: [{ local: 'sales', to: ['alice@gmail.com'] }], defaultAddress: { kind: 'reject' } },
      { domain: 'shop.example', forwarders: [], defaultAddress: { kind: 'discard' } },
    ],
    mailboxes: [{ address: 'info@alice.example', filters: [{ name: 'spam', match: 'any', tests: [{ field: 'subject', op: 'contains', value: '[SPAM]' }], actions: [{ kind: 'fileinto', folder: 'Junk' }] }] }],
  },
  zones: ['alice.example', 'shop.example'],
}

const source = (over: Partial<AccountExportSource> = {}): AccountExportSource => ({
  manifest,
  zones: {
    'alice.example': [
      { zone: 'alice.example', name: '@', type: 'A', ttl: 3600, content: '203.0.113.10' },
      { zone: 'alice.example', name: 'www', type: 'CNAME', ttl: 3600, content: 'alice.example.' },
      { zone: 'alice.example', name: '@', type: 'MX', ttl: 3600, content: 'mail.alice.example.', priority: 10 },
      { zone: 'alice.example', name: 'mail', type: 'A', ttl: 3600, content: '203.0.113.10' },
      { zone: 'alice.example', name: '@', type: 'TXT', ttl: 3600, content: 'v=spf1 a mx -all' },
    ],
    'shop.example': [{ zone: 'shop.example', name: '@', type: 'A', ttl: 3600, content: '198.51.100.99' }],
  },
  dumps: {
    alice_wp: Buffer.from('CREATE TABLE wp_posts (id int);\n'),
    alice_shop: { size: 26, open: async function* () { yield Buffer.from('CREATE TABLE '); yield Buffer.from('orders (id);\n') } },
  },
  home: [
    { path: 'public_html', type: 'directory', mode: 0o750 },
    { path: 'public_html/index.php', type: 'file', content: Buffer.from('<?php echo "alice";') },
    { path: 'shop.example', type: 'directory' },
    { path: 'shop.example/index.html', type: 'file', size: 9, content: async function* () { yield Buffer.from('<h1>shop'); yield Buffer.from('\n') } },
    { path: 'www', type: 'symlink', linkTarget: 'public_html' },
    { path: 'escape', type: 'symlink', linkTarget: '../../etc/shadow' },
    { path: '../outside', type: 'file', content: Buffer.from('x') },
    { path: 'mail/alice.example/info/cur/1', type: 'file', content: Buffer.from('dup') },
  ],
  mail: [
    { path: 'alice.example/info/cur/1700000000.M1:2,S', type: 'file', content: Buffer.from('Subject: hi\n\nhello') },
    { path: 'shop.example/orders/new/1', type: 'file', content: Buffer.from('Subject: order') },
    { path: 'victim.example/ceo/cur/1', type: 'file', content: Buffer.from('not ours') },
  ],
  ...over,
})

const collect = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const parts: Buffer[] = []
  for await (const c of stream) parts.push(Buffer.from(c as Buffer))
  return Buffer.concat(parts)
}

const exported = async (over: Partial<AccountExportSource> = {}) => {
  const { stream, done } = exportAccountArchive(source(over))
  const [buf, summary] = await Promise.all([collect(stream), done])
  return { buf, summary }
}

const defaultPhp: PhpSettings = {
  version: '8.3',
  handler: 'fpm',
  fpm: { mode: 'ondemand', maxChildren: 5, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 },
  ini: {},
}

let n = 0
const opts = (over: Partial<AccountImportOptions> = {}): AccountImportOptions => ({
  local: { usernames: ['bob'], domains: ['bob.example'], uids: [1000, 1001], plans: ['gold'] },
  planId: 'plan-gold',
  ownerId: null,
  ipv4: '198.51.100.7',
  now: '2026-10-22T01:35:00.000Z',
  ids: () => `id-${++n}`,
  defaultPhp,
  ...over,
})

describe('exportAccountArchive', () => {
  it('writes manifest first and checksums last, skipping unsafe and escaping entries', async () => {
    const { buf, summary } = await exported()
    expect(summary.skipped).toEqual([
      { path: 'home/escape', reason: 'symlink target ../../etc/shadow leaves home' },
      { path: '../outside', reason: 'unsafe name' },
      { path: 'home/mail/alice.example/info/cur/1', reason: 'mail is exported in mail/' },
      { path: 'mail/victim.example/ceo/cur/1', reason: 'mail for a domain outside the account' },
    ])
    expect(summary.checksums.map((c) => c.path)).toEqual([
      'manifest.json', 'dns/alice.example.json', 'dns/shop.example.json', 'mysql/alice_wp.sql', 'mysql/alice_shop.sql',
      'home/public_html/index.php', 'home/shop.example/index.html', 'home/www',
      'mail/alice.example/info/cur/1700000000.M1:2,S', 'mail/shop.example/orders/new/1',
    ])
    expect(buf.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
  })

  it('refuses inconsistent sources', async () => {
    await expect(exported({ dumps: {} })).rejects.toThrow(/has no dump/)
    await expect(exported({ zones: { ...source().zones, 'alice.example': [{ zone: 'alice.example', name: '@', type: 'SOA', ttl: 1, content: 'ns1.x.example. h.x.example. 1 1 1 1 1' }] } })).rejects.toThrow(/SOA/)
    await expect(exported({ zones: { ...source().zones, 'alice.example': [{ zone: 'victim.example', name: '@', type: 'A', ttl: 1, content: '192.0.2.1' }] } })).rejects.toThrow(XpanelError)
    await expect(exported({ dumps: { ...source().dumps, alice_shop: { size: 3, open: async function* () { yield Buffer.from('too long') } } } })).rejects.toThrow(/larger than its declared/)
    expect(() => exportAccountArchive(source({ manifest: { ...manifest, account: { ...manifest.account, username: 'Alice' } } }))).toThrow(XpanelError)
  })
})

describe('importAccountArchive', () => {
  it('rebuilds a new uid, home, slice and domains from the archive', async () => {
    const { buf } = await exported()
    const sink = new MemorySink()
    const r = await importAccountArchive(chunked(buf, 1024), opts({ sink, targetUsername: 'alice2' }))
    expect(r.account).toMatchObject({ username: 'alice2', uid: 1002, gid: 1002, home: '/home/alice2', primaryDomain: 'alice.example', planId: 'plan-gold', status: 'active', ipv4: '198.51.100.7', contactEmail: 'alice@gmail.com', shell: 'none' })
    expect(r.slice).toBe('xpanel-1002.slice')
    expect(r.domains.map((d) => [d.name, d.kind, d.docRoot, d.php.version, d.siteType, d.wildcard])).toEqual([
      ['alice.example', 'primary', '/home/alice2/public_html', '8.3', 'php', true],
      ['shop.example', 'addon', '/home/alice2/shop.example', '8.3', 'php', false],
      ['www2.shop.example', 'subdomain', '/home/alice2/shop.example/www2', '8.3', 'static', false],
      ['alice.net', 'alias', '/home/alice2/public_html', '8.3', 'php', false],
      ['api.alice.example', 'subdomain', '/home/alice2/api', '8.3', 'node', false],
    ])
    const byName = new Map(r.domains.map((d) => [d.name, d]))
    expect(byName.get('www2.shop.example')?.parentId).toBe(byName.get('shop.example')?.id)
    expect(byName.get('alice.net')?.parentId).toBe(byName.get('alice.example')?.id)
    expect(r.warnings).toContain('shop.example: PHP 5.6 is not available here; using 8.3')

    expect(r.databases.map((d) => d.name)).toEqual(['alice2_wp', 'alice2_shop'])
    expect(r.dbUsers.map((u) => [u.name, u.hosts, u.grants.map((g) => [r.databases.find((d) => d.id === g.databaseId)?.name, g.privileges]), u.passwordResetRequired])).toEqual([
      ['alice2_wpuser', ['localhost'], [['alice2_wp', ['SELECT', 'INSERT']]], true],
      ['alice2', ['localhost'], [['alice2_shop', ['SELECT']]], true],
    ])
    expect(r.sql.map((s) => [s.database, s.file.archivePath, s.file.ref !== null])).toEqual([['alice2_wp', 'mysql/alice_wp.sql', true], ['alice2_shop', 'mysql/alice_shop.sql', true]])

    expect(r.dnsRecords.map((d) => `${d.zone} ${d.name} ${d.type} ${d.content}`)).toEqual([
      'alice.example @ A 198.51.100.7', 'alice.example www CNAME alice.example.', 'alice.example @ MX mail.alice.example.', 'alice.example mail A 198.51.100.7',
      'alice.example @ TXT v=spf1 a mx -all', 'shop.example @ A 198.51.100.99',
    ])
    expect(r.warnings).toContain('2 A record(s) moved from 203.0.113.10 to 198.51.100.7')
    expect(r.serviceUsers.map((u) => [u.login, u.mailboxQuotaMb, u.services.email, u.passwordResetRequired])).toEqual([['info@alice.example', 500, true, true], ['orders@shop.example', 'unlimited', true, true]])
    expect(r.mail).toEqual(manifest.mail)

    expect(sink.data('home', 'public_html/index.php')).toBe('<?php echo "alice";')
    expect(sink.data('home', 'shop.example/index.html')).toBe('<h1>shop\n')
    expect(sink.items.find((i) => i.item.path === 'www')?.item).toMatchObject({ part: 'home', type: 'symlink', linkTarget: 'public_html' })
    expect(sink.data('mail', 'alice.example/info/cur/1700000000.M1:2,S')).toBe('Subject: hi\n\nhello')
    expect(sink.data('sql', 'alice_shop.sql')).toBe('CREATE TABLE orders (id);\n')
    expect(sink.paths('home')).not.toContain('escape')
    expect(r.files).toEqual({ home: 3, mail: 2, bytes: 60 })
    expect(JSON.stringify(r)).not.toMatch(/password"?\s*:/i)
  })

  it('yields desired state the edge renderer turns into vhosts for the new uid and home', async () => {
    const { buf } = await exported()
    const r = await importAccountArchive(chunked(buf), opts({ targetUsername: 'alice2' }))
    const os = aptProfile(parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n'))
    const settings: ServerSettings = {
      hostname: 'host.example.net', nameservers: ['ns1.example.net', 'ns2.example.net'], adminEmail: 'root@example.net', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22,
      nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 4096, multiAccept: true, keepaliveTimeoutSec: 30 },
      apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 4, maxRequestWorkers: 50, maxConnectionsPerChild: 1000, serverLimit: 50 },
      backendPort: 8080, backendTlsPort: 8443,
    }
    const vhosts = edge.renderApacheVhosts(r.account, r.domains, settings, os)
    const primary = vhosts.find((v) => v.content.includes('ServerName alice.example'))
    expect(primary?.content).toContain('AssignUserId alice2 alice2')
    expect(primary?.content).toContain('/home/alice2/public_html')
    expect(vhosts.map((v) => v.content).join('\n')).not.toContain('/home/alice/')
  })

  it('drops domains with their subdomains, zones, mailboxes and mail config', async () => {
    const { buf } = await exported()
    const sink = new MemorySink()
    const r = await importAccountArchive(chunked(buf), opts({ dropDomains: ['shop.example'], sink }))
    // the dropped domain's maildirs are verified but never written into the new home
    expect(sink.paths('mail')).toEqual(['alice.example/info/cur/1700000000.M1:2,S'])
    expect(r.files.mail).toBe(1)
    expect(r.warnings).toContain('mail stored for shop.example was not imported with the dropped domain')
    expect(r.domains.map((d) => d.name)).toEqual(['alice.example', 'alice.net', 'api.alice.example'])
    expect(r.warnings).toContain('www2.shop.example dropped with its parent shop.example')
    expect(r.dnsRecords.every((d) => d.zone === 'alice.example')).toBe(true)
    expect(r.serviceUsers.map((u) => u.login)).toEqual(['info@alice.example'])
    expect(r.mail.domains.map((d) => d.domain)).toEqual(['alice.example'])
    await expect(importAccountArchive(chunked(buf), opts({ dropDomains: ['alice.example'] }))).rejects.toThrow(/primary domain cannot be dropped/)
    await expect(importAccountArchive(chunked(buf), opts({ dropDomains: ['other.example'] }))).rejects.toThrow(/not in the archive/)
  })

  it('refuses name, domain and uid conflicts with this server', async () => {
    const { buf } = await exported()
    // decided from the manifest alone: nothing reaches the sink
    const early = new MemorySink()
    await expect(importAccountArchive(chunked(buf), opts({ targetUsername: 'bob', sink: early }))).rejects.toThrow(/already exists/)
    expect(early.items).toEqual([])
    expect(early.aborted).not.toBeNull()
    await expect(importAccountArchive(chunked(buf), opts({ targetUsername: 'bob' }))).rejects.toThrow(/already exists/)
    await expect(importAccountArchive(chunked(buf), opts({ local: { usernames: [], domains: ['shop.example'], uids: [], plans: [] } }))).rejects.toThrow(/domain shop.example already exists/)
    // the core overlap rule, not only exact names: another tenant's parent, child or www twin
    for (const clash of ['example.alice.net', 'www.alice.net', 'x.api.alice.example']) {
      await expect(importAccountArchive(chunked(buf), opts({ local: { usernames: [], domains: [clash], uids: [], plans: [] } })), clash).rejects.toThrow(/domains conflict with this server/)
    }
    await expect(importAccountArchive(chunked(buf), opts({ local: { usernames: [], domains: ['alice.example.net'], uids: [], plans: [] } }))).resolves.toBeDefined()
    await expect(importAccountArchive(chunked(buf), opts({ local: { usernames: [], domains: [], uids: [-1], plans: [] } }))).rejects.toThrow(/local inventory/)
    await expect(importAccountArchive(chunked(buf), opts({ targetUsername: 'root' }))).rejects.toThrow(XpanelError)
    await expect(importAccountArchive(chunked(buf), opts({ uidRange: { min: 1000, max: 1001 } }))).rejects.toThrow(/no free uid/)
    await expect(importAccountArchive(chunked(buf), opts({ homeRoot: '/etc' }))).rejects.toThrow(XpanelError)
    await expect(importAccountArchive(chunked(buf), opts({ ipv4: '1.2.3' }))).rejects.toThrow(XpanelError)
    await expect(importAccountArchive(chunked(buf), opts({ defaultPhp: { ...defaultPhp, version: '5.6' } }))).rejects.toThrow(/not installed/)
  })

  it('aborts the sink and rejects tampered, truncated or reordered archives', async () => {
    const { buf, summary } = await exported()
    const good = { manifest: JSON.stringify(manifest), checksums: JSON.stringify({ files: summary.checksums }) }
    const archive = (entries: TestEntry[]) => buildTar(entries, { gzip: true })
    const files = (index: string): TestEntry[] => [
      { name: 'manifest.json', content: good.manifest },
      { name: 'dns/alice.example.json', content: JSON.stringify(source().zones['alice.example']) },
      { name: 'home/public_html/index.php', content: index },
      { name: 'checksums.json', content: good.checksums },
    ]
    const cases: [TestEntry[], RegExp][] = [
      [files('<?php system($_GET[1]);'), /integrity check failed/],
      [files('<?php echo "alice";').filter((e) => e.name !== 'checksums.json'), /no checksums.json/],
      [[{ name: 'home/x', content: 'x' }, ...files('')], /manifest.json must be the first member/],
      [[...files(''), { name: 'home/late', content: 'x' }], /follows checksums.json/],
      [[{ name: 'manifest.json', content: good.manifest }, { name: 'home/../../etc/cron.d/x', content: 'x' }], /path traversal/],
      [[{ name: 'manifest.json', content: good.manifest }, { name: 'home/a', type: 'link', linkname: 'home/b' }], /hardlinks/],
      [[{ name: 'manifest.json', content: good.manifest }, { name: 'home/mail/a', content: 'x' }], /under mail\//],
      [[{ name: 'manifest.json', content: good.manifest }, { name: 'mail/victim.example/x', content: 'x' }], /outside the archive/],
      [[{ name: 'manifest.json', content: good.manifest }, { name: 'etc/passwd', content: 'x' }], /unexpected member/],
      [[{ name: 'manifest.json', content: good.manifest }, { name: 'mysql/bob_x.sql', content: 'x' }], /unexpected dump/],
      [[{ name: 'manifest.json', content: '{"format":"cpmove"}' }], /not an xPanel account archive/],
      [[{ name: 'manifest.json', content: 'not json' }], /not JSON/],
    ]
    for (const [entries, re] of cases) {
      const sink = new MemorySink()
      await expect(importAccountArchive(chunked(await archive(entries)), opts({ sink })), re.source).rejects.toThrow(re)
      expect(sink.aborted, re.source).not.toBeNull()
    }
    expect(buf.length).toBeGreaterThan(0)
  })

  it('a symlink that leaves the home is never written', async () => {
    const { summary } = await exported()
    const entries: TestEntry[] = [
      { name: 'manifest.json', content: JSON.stringify(manifest) },
      { name: 'home/pwn', type: 'symlink', linkname: '/root/.ssh' },
      { name: 'checksums.json', content: JSON.stringify({ files: summary.checksums }) },
    ]
    const sink = new MemorySink()
    await expect(importAccountArchive(chunked(await buildTar(entries, { gzip: true })), opts({ sink }))).rejects.toThrow(/integrity/)
    expect(sink.paths('home')).toEqual([])
  })
})

describe('export and import round trip', () => {
  it('every exported archive imports: symlink chains and links through links are left out at export', async () => {
    const home: ExportEntry[] = [
      { path: 'releases', type: 'directory' },
      { path: 'releases/2', type: 'directory' },
      { path: 'releases/2/index.php', type: 'file', content: Buffer.from('<?php echo 2;') },
      { path: 'live', type: 'symlink', linkTarget: 'current' },
      { path: 'current', type: 'symlink', linkTarget: 'releases/2' },
      { path: 'up', type: 'symlink', linkTarget: '..' },
      { path: 'www', type: 'symlink', linkTarget: 'releases/2' },
      { path: 'www/late.php', type: 'file', content: Buffer.from('written through a link') },
    ]
    const { buf, summary } = await exported({ home, mail: [] })
    expect(summary.skipped.map((x) => x.path)).toEqual(['home/current', 'home/up', 'home/www/late.php'])
    const sink = new MemorySink()
    const r = await importAccountArchive(chunked(buf), opts({ sink }))
    expect(sink.paths('home')).toEqual(['releases', 'releases/2', 'releases/2/index.php', 'live', 'www'])
    expect(r.files.home).toBe(3)
  })
})

describe('account manifest', () => {
  it('parses strictly', () => {
    expect(parseAccountManifest(structuredClone(manifest))).toEqual(manifest)
    const mut = (f: (m: Record<string, unknown>) => void): unknown => { const c = structuredClone(manifest) as unknown as Record<string, unknown>; f(c); return c }
    const domains = (m: Record<string, unknown>) => m.domains as Record<string, unknown>[]
    const bad = [
      mut((m) => { m.extra = 1 }),
      mut((m) => { m.version = 2 }),
      mut((m) => { (m.account as Record<string, unknown>).ipv4 = '999.0.0.1' }),
      mut((m) => { (domains(m)[0] as Record<string, unknown>).docRoot = '/etc' }),
      mut((m) => { (domains(m)[0] as Record<string, unknown>).docRoot = '../bob/public_html' }),
      mut((m) => { (domains(m)[0] as Record<string, unknown>).docRoot = 'mail/x' }),
      mut((m) => { (domains(m)[0] as Record<string, unknown>).kind = 'addon' }),
      mut((m) => { (domains(m)[1] as Record<string, unknown>).kind = 'superdomain' }),
      mut((m) => { (domains(m)[2] as Record<string, unknown>).parent = 'alice.example' }),
      mut((m) => { (domains(m)[3] as Record<string, unknown>).parent = 'www2.shop.example' }),
      mut((m) => { (domains(m)[4] as Record<string, unknown>).upstream = 'http://user:pw@127.0.0.1:3000' }),
      mut((m) => { (domains(m)[0] as Record<string, unknown>).upstream = 'http://127.0.0.1:3000' }),
      mut((m) => { domains(m).push({ ...(domains(m)[1] as object) }) }),
      mut((m) => { m.databases = ['bob_wp'] }),
      mut((m) => { (m.dbUsers as Record<string, unknown>[])[0] = { name: 'alice_wpuser', hosts: ['localhost'], grants: [{ database: 'alice_wp', privileges: ['FILE'] }] } }),
      mut((m) => { (m.dbUsers as Record<string, unknown>[])[0] = { name: 'alice_wpuser', hosts: ['%'], grants: [] } }),
      mut((m) => { (m.dbUsers as Record<string, unknown>[])[0] = { name: 'alice_wpuser', hosts: ['localhost'], grants: [{ database: 'mysql', privileges: ['SELECT'] }] } }),
      mut((m) => { m.mailboxes = [{ address: 'ceo@victim.example', quotaMb: 1 }] }),
      mut((m) => { m.mailboxes = [{ address: 'info@alice.example', quotaMb: -1 }] }),
      mut((m) => { m.zones = ['victim.example'] }),
      mut((m) => { (m.source as Record<string, unknown>).panelVersion = 'x' }),
    ]
    for (const b of bad) expect(() => parseAccountManifest(b), JSON.stringify(b).slice(0, 160)).toThrow(XpanelError)
  })

  it('accepts a source account name that is reserved here; the import renames it', () => {
    const m = structuredClone(manifest) as unknown as Record<string, unknown>
    ;(m.account as Record<string, unknown>).username = 'admin'
    m.databases = []
    m.dbUsers = []
    expect(parseAccountManifest(m).account.username).toBe('admin')
  })
})

describe('allocateUid', () => {
  it('takes the lowest free uid in the account range', () => {
    expect(allocateUid([1000, 1001, 1003])).toBe(1002)
    expect(allocateUid([], { min: 5000, max: 5001 })).toBe(5000)
    expect(() => allocateUid([], { min: 0, max: 10 })).toThrow(XpanelError)
    expect(() => allocateUid([], { min: 1000, max: 65534 })).toThrow(XpanelError)
    expect(() => allocateUid([5000], { min: 5000, max: 5000 })).toThrow(/no free uid/)
  })
})

describe('export entries', () => {
  it('needs a declared size for streamed files', async () => {
    const home: ExportEntry[] = [{ path: 'big', type: 'file', content: async function* () { yield Buffer.from('x') } }]
    await expect(exported({ home })).rejects.toThrow(/size is required/)
  })
})
