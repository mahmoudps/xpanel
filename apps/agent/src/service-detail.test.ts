import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { services } from '@xpanel/render'
import {
  checkDnsZone, listHostDirectory, listPinnedDirectory, listenerTlsPaths, parseServiceCertificate, readCertificatesServiceDetail, readDnsServiceDetail,
  readFtpServiceDetail, statHostPath, zoneFileSerial,
} from './service-detail.ts'
import type { DirectoryListing, HostPathInfo, ServiceDetailCommandResult, ServiceDetailHost, ServiceDetailState } from './service-detail.ts'
import { isServiceDetailCommand } from '../../../packages/os/src/service-detail-command.ts'

const now = () => new Date('2026-10-27T10:00:00Z')
const ok = (stdout: string): ServiceDetailCommandResult => ({ ok: true, code: 0, stdout, stderr: '' })

// Minimal DER encoder for a self-signed Ed25519 X.509 v3 test certificate (RFC 5280 §4.1, RFC 8410).
const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts), n = body.length
  return Buffer.concat([Buffer.from([tag]), n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]), body])
}
const seq = (...parts: Buffer[]): Buffer => der(0x30, ...parts)
const name = (cn: string): Buffer => seq(der(0x31, seq(der(0x06, Buffer.from([0x55, 0x04, 0x03])), der(0x0c, Buffer.from(cn)))))
const utcTime = (date: Date): Buffer => der(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'))
const testCertificate = (input: { cn: string; dns: string[]; notBefore: string; notAfter: string; issuer?: string }): string => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), algorithm = seq(der(0x06, Buffer.from([0x2b, 0x65, 0x70])))
  const san = seq(der(0x06, Buffer.from([0x55, 0x1d, 0x11])), der(0x04, seq(...input.dns.map(item => der(0x82, Buffer.from(item))))))
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), algorithm, name(input.issuer ?? input.cn), seq(utcTime(new Date(input.notBefore)), utcTime(new Date(input.notAfter))),
    name(input.cn), publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, seq(san)))
  const body = seq(tbs, algorithm, der(0x03, Buffer.from([0]), sign(null, tbs, privateKey))).toString('base64')
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`
}
const generation = 'a'.repeat(64), certPath = `/etc/xpanel/management-certificates/${generation}/fullchain.pem`, keyPath = `/etc/xpanel/management-certificates/${generation}/privkey.pem`
const ingress = (cert = certPath, key = keyPath, other = cert) => [2083, 2087, 2096].map(port => `server {\n    listen 203.0.113.10:443 ssl;\n    server_name x;\n    ssl_certificate ${cert};\n    ssl_certificate_key ${key};\n    return 308 https://x:${port};\n}\nserver {\n    listen 203.0.113.10:${port} ssl;\n    server_name x;\n    ssl_certificate ${port === 2096 ? other : cert};\n    ssl_certificate_key ${key};\n    location / { proxy_pass http://127.0.0.1:1${port}; }\n}\n`).join('')
const validPem = testCertificate({ cn: 'panel.example.test', dns: ['panel.example.test', 'whm.panel.example.test', 'mail.panel.example.test'], notBefore: '2026-10-01T00:00:00Z', notAfter: '2026-12-30T00:00:00Z', issuer: 'Test CA' })

const state = (overrides: Partial<ServiceDetailState> = {}): ServiceDetailState => ({ zones: [{ name: 'example.com', serial: 2026102701 }, { name: 'missing.org', serial: 7 }],
  serviceUsers: [{ services: { ftp: true } }, { services: { ftp: false } }, { services: { ftp: true } }], server: { settings: { hostname: 'panel.example.test' } }, ...overrides })
const zone = (zoneName: string, serial: number) => services.renderBindZone([
  { zone: zoneName, name: '@', type: 'SOA', ttl: 3600, content: `ns1.${zoneName}. hostmaster.${zoneName}. ${serial} 3600 1800 1209600 3600`, priority: null },
  { zone: zoneName, name: '@', type: 'NS', ttl: 3600, content: `ns1.${zoneName}.`, priority: null },
  { zone: zoneName, name: 'www', type: 'A', ttl: 3600, content: '192.0.2.10', priority: null },
])
const fakeHost = (input: { files?: Record<string, string | Error>; listing?: DirectoryListing | Error; stats?: Record<string, HostPathInfo>; run?: (argv: string[]) => ServiceDetailCommandResult | Error } = {}) => {
  const reads: string[] = [], commands: string[][] = []
  const host: ServiceDetailHost = {
    run: vi.fn(async (argv: string[]) => {
      commands.push(argv)
      const scripted = input.run?.(argv)
      if (scripted instanceof Error) throw scripted
      if (scripted) return scripted
      if (argv[0] === '/usr/bin/systemctl') return ok(['pdns.service', 'pure-ftpd.service'].includes(argv.at(-1)!) ? 'loaded\nactive\n' : 'not-found\ninactive\n')
      if (argv.join(' ') === '/usr/bin/pdns_control rping') return ok('PONG\n')
      if (argv.join(' ') === '/usr/bin/pdns_control version') return ok('4.8.3\n')
      return { ok: false, code: 1, stdout: '', stderr: 'unexpected' }
    }),
    readFile: vi.fn(async (path: string) => {
      reads.push(path)
      const value = input.files?.[path]
      if (value instanceof Error) throw value
      return value ?? null
    }),
    stat: vi.fn(async (path: string): Promise<HostPathInfo> => input.stats?.[path] ?? { kind: 'missing', sizeBytes: 0 }),
    listDirectory: vi.fn(async (): Promise<DirectoryListing> => { if (input.listing instanceof Error) throw input.listing; return input.listing ?? { state: 'read', entries: [], truncated: false } }),
  }
  return { host, reads, commands }
}

describe('zone file SOA serials', () => {
  it('reads the serial of an xPanel-rendered zone', () => {
    expect(zoneFileSerial(zone('example.com', 2026102701), 'example.com')).toBe(2026102701)
    expect(zoneFileSerial('$ORIGIN example.com.\n$TTL 300\n@ IN SOA ns1.example.com. hostmaster.example.com. ( 42 3600 1800 1209600 300 )\n@ IN NS ns1.example.com.\n', 'example.com')).toBe(42)
  })
  it('returns null for malformed, partial or out-of-range SOA data', () => {
    for (const content of ['', 'not a zone file', '$ORIGIN example.com.\n@ 3600 IN NS ns1.example.com.\n', '$ORIGIN example.com.\n@ 3600 IN SOA ns1.example.com. hostmaster.example.com. 42 3600 1800\n',
      '$ORIGIN example.com.\n@ 3600 IN SOA ns1.example.com. hostmaster.example.com. 4294967296 3600 1800 1209600 300\n', '$INCLUDE /etc/passwd\n', '$ORIGIN example.com.\n@ 3600 IN SOA ns1.example.com. hostmaster.example.com. ( 42 3600\n']) {
      expect(zoneFileSerial(content, 'example.com')).toBeNull()
    }
  })
})

describe('DNS service detail', () => {
  const listing: DirectoryListing = { state: 'read', truncated: false, entries: [
    { name: 'example.com.zone', kind: 'file', sizeBytes: 300 }, { name: 'other.net.zone', kind: 'file', sizeBytes: 200 }, { name: 'broken.org.zone', kind: 'file', sizeBytes: 20 },
    { name: 'link.org.zone', kind: 'symlink', sizeBytes: 10 }, { name: 'huge.org.zone', kind: 'file', sizeBytes: 2 * 1024 * 1024 }, { name: 'locked.org.zone', kind: 'file', sizeBytes: 10 },
    { name: 'README', kind: 'file', sizeBytes: 5 }, { name: 'Upper.com.zone', kind: 'file', sizeBytes: 5 },
  ] }
  const files = { '/var/lib/powerdns/zones/example.com.zone': zone('example.com', 2026102701), '/var/lib/powerdns/zones/other.net.zone': zone('other.net', 5),
    '/var/lib/powerdns/zones/broken.org.zone': 'garbage', '/var/lib/powerdns/zones/locked.org.zone': new Error('hard link refused') }
  it('compares saved-state zones with the zone directory and parses each file serial', async () => {
    const { host, reads, commands } = fakeHost({ listing, files })
    const view = await readDnsServiceDetail({ host, readState: async () => state(), now })
    expect(view).toMatchObject({ kind: 'dns', observedAt: '2026-10-27T10:00:00.000Z', service: { id: 'pdns', unit: 'pdns.service', state: 'active' }, control: { state: 'reachable', version: '4.8.3' },
      zoneDir: '/var/lib/powerdns/zones', directory: 'read', savedState: 'read', otherEntries: 2, truncated: false })
    expect(Object.fromEntries(view.zones.map(row => [row.zone, [row.desired, row.file, row.stateSerial, row.fileSerial]]))).toEqual({
      'broken.org': [false, 'malformed', null, null], 'example.com': [true, 'parsed', 2026102701, 2026102701], 'huge.org': [false, 'too-large', null, null],
      'link.org': [false, 'not-regular', null, null], 'locked.org': [false, 'unreadable', null, null], 'missing.org': [true, 'missing', 7, null], 'other.net': [false, 'parsed', null, 5],
    })
    expect(reads).not.toContain('/var/lib/powerdns/zones/link.org.zone')
    expect(reads).not.toContain('/var/lib/powerdns/zones/huge.org.zone')
    expect(commands.filter(argv => argv[0] !== '/usr/bin/systemctl').every(isServiceDetailCommand)).toBe(true)
  })
  it('reports unreachable, malformed control output, missing directories and unread state truthfully', async () => {
    const down = fakeHost({ run: argv => argv[0] === '/usr/bin/pdns_control' ? { ok: false, code: 1, stdout: '', stderr: 'Unable to connect' } : undefined as never })
    expect((await readDnsServiceDetail({ host: down.host, readState: async () => state(), now })).control).toEqual({ state: 'unreachable', version: null })
    const odd = fakeHost({ run: argv => argv[1] === 'rping' ? ok('pong?') : undefined as never })
    expect((await readDnsServiceDetail({ host: odd.host, readState: async () => state(), now })).control).toEqual({ state: 'unavailable', version: null })
    const garbled = fakeHost({ run: argv => argv[1] === 'version' ? ok('<html>') : undefined as never })
    expect((await readDnsServiceDetail({ host: garbled.host, readState: async () => state(), now })).control).toEqual({ state: 'reachable', version: null })
    const absent = await readDnsServiceDetail({ host: fakeHost({ listing: { state: 'missing', entries: [], truncated: false } }).host, readState: async () => state(), now })
    expect(absent).toMatchObject({ directory: 'missing', zones: [{ zone: 'example.com', file: 'missing' }, { zone: 'missing.org', file: 'missing' }] })
    const failed = await readDnsServiceDetail({ host: fakeHost({ listing: new Error('EACCES') }).host, readState: async () => { throw new Error('locked') }, now })
    expect(failed).toMatchObject({ directory: 'unavailable', savedState: 'unavailable', zones: [] })
    const unknown = await readDnsServiceDetail({ host: fakeHost({ listing: new Error('EACCES') }).host, readState: async () => state(), now })
    expect(unknown.zones.map(row => row.file)).toEqual(['not-read', 'not-read'])
    const noState = await readDnsServiceDetail({ host: fakeHost({ listing, files }).host, readState: async () => { throw new Error('locked') }, now })
    expect(noState.zones.find(row => row.zone === 'example.com')).toMatchObject({ desired: null, stateSerial: null, file: 'parsed' })
  })
  it('bounds rows and flags truncation', async () => {
    const many: DirectoryListing = { state: 'read', truncated: true, entries: Array.from({ length: 2100 }, (_, index) => ({ name: `z${index}.example.zone`, kind: 'directory' as const, sizeBytes: 0 })) }
    const view = await readDnsServiceDetail({ host: fakeHost({ listing: many }).host, readState: async () => state({ zones: [] }), now })
    expect(view.zones).toHaveLength(2000)
    expect(view.truncated).toBe(true)
  })
})

describe('pdnsutil check-zone', () => {
  it('passes only on exit 0 with a zero-error summary for the requested zone', async () => {
    const { host, commands } = fakeHost({ run: argv => argv[0] === '/usr/bin/pdnsutil' ? ok("[Warning] www.example.com: TTL is low\nChecked 12 records of 'example.com', 0 errors, 1 warnings.\n") : undefined as never })
    expect(await checkDnsZone({ run: host.run, zone: 'example.com', now })).toEqual({ zone: 'example.com', observedAt: '2026-10-27T10:00:00.000Z', state: 'passed', records: 12, errors: 0, warnings: 1, messages: ['[Warning] www.example.com: TTL is low'] })
    expect(commands).toEqual([['/usr/bin/pdnsutil', 'check-zone', 'example.com']])
  })
  it('reports failures with bounded messages and everything else as unavailable', async () => {
    const failed = await checkDnsZone({ run: async () => ({ ok: false, code: 1, stdout: "[Error] CNAME at apex\u202e\nChecked 3 records of 'example.com.', 1 errors, 0 warnings.\n", stderr: '' }), zone: 'example.com', now })
    expect(failed).toMatchObject({ state: 'failed', errors: 1, messages: ['[Error] CNAME at apex'] })
    for (const result of [{ ok: false, code: 1, stdout: "Zone 'example.com' not found!\n", stderr: '' }, ok("Checked 3 records of 'other.net', 0 errors, 0 warnings.\n"),
      ok("Checked 3 records of 'example.com', 2 errors, 0 warnings.\n"), { ok: false, code: 1, stdout: "Checked 3 records of 'example.com', 0 errors, 0 warnings.\n", stderr: '' }, ok('')]) {
      expect(await checkDnsZone({ run: async () => result, zone: 'example.com', now })).toMatchObject({ state: 'unavailable', records: null, errors: null, warnings: null })
    }
    expect(await checkDnsZone({ run: async () => { throw new Error('spawn') }, zone: 'example.com', now })).toMatchObject({ state: 'unavailable' })
    expect(await checkDnsZone({ run: async () => ok(''), zone: '--help', now })).toMatchObject({ state: 'unavailable' })
  })
})

describe('FTP service detail', () => {
  it('compares the rendered pure-ftpd policy with the host conf files and counts saved FTP users', async () => {
    const { host } = fakeHost({ files: { '/etc/pure-ftpd/conf/TLS': '2\n', '/etc/pure-ftpd/conf/PassivePortRange': '30000 35000\n', '/etc/pure-ftpd/conf/NoAnonymous': 'no\n', '/etc/pure-ftpd/conf/PureDB': new Error('EACCES') } })
    const view = await readFtpServiceDetail({ host, readState: async () => state(), now })
    expect(view).toMatchObject({ kind: 'ftp', service: { id: 'pure-ftpd', state: 'active' }, confDir: '/etc/pure-ftpd/conf', ftpAccounts: 2 })
    const rows = Object.fromEntries(view.settings.map(row => [row.name, row]))
    expect(rows.TLS).toEqual({ name: 'TLS', desired: '2', observed: '2', state: 'match' })
    expect(rows.PassivePortRange).toEqual({ name: 'PassivePortRange', desired: '30000 35000', observed: '30000 35000', state: 'match' })
    expect(rows.NoAnonymous).toMatchObject({ desired: 'yes', observed: 'no', state: 'drift' })
    expect(rows.PureDB).toMatchObject({ observed: null, state: 'unreadable' })
    expect(rows.ChrootEveryone).toMatchObject({ observed: null, state: 'missing' })
    expect((await readFtpServiceDetail({ host, readState: async () => { throw new Error('locked') }, now })).ftpAccounts).toBeNull()
  })
})

describe('service certificates', () => {
  it('parses a generated certificate without returning key material or the PEM', async () => {
    const certificate = parseServiceCertificate(validPem, 'panel.example.test', now())!
    expect(certificate).toMatchObject({ subject: 'CN=panel.example.test', issuer: 'CN=Test CA', names: ['panel.example.test', 'whm.panel.example.test', 'mail.panel.example.test'],
      notBefore: '2026-10-01T00:00:00.000Z', notAfter: '2026-12-30T00:00:00.000Z', daysLeft: 63, chainLength: 1, coversHostname: true })
    expect(certificate.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(parseServiceCertificate(validPem, 'other.example.test', now())!.coversHostname).toBe(false)
    expect(parseServiceCertificate(validPem, null, now())!.coversHostname).toBeNull()
    for (const bad of ['', 'garbage', validPem.replace('MI', '!!'), '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n', validPem + 'trailing']) expect(parseServiceCertificate(bad, null, now())).toBeNull()
  })
  it('reads the panel certificate from the rendered management ingress and only stats the key', async () => {
    const { host, reads } = fakeHost({ files: { '/etc/nginx/conf.d/xpanel-management.conf': ingress(), [certPath]: validPem }, stats: { [certPath]: { kind: 'file', sizeBytes: validPem.length }, [keyPath]: { kind: 'file', sizeBytes: 120 } } })
    const view = await readCertificatesServiceDetail({ host, readState: async () => state(), now })
    expect(view).toMatchObject({ kind: 'certificates', hostname: 'panel.example.test' })
    expect(view.endpoints.map(endpoint => [endpoint.id, endpoint.state])).toEqual([['panel', 'observed'], ['postfix', 'not-rendered'], ['dovecot', 'not-rendered'], ['pure-ftpd', 'not-rendered']])
    expect(view.endpoints[0]).toMatchObject({ ports: [443, 2083, 2087, 2096], configPath: '/etc/nginx/conf.d/xpanel-management.conf', certPath, keyPath, keyPresent: true, reason: null, warnings: [], certificate: { coversHostname: true, daysLeft: 63 } })
    expect(reads).toEqual(['/etc/nginx/conf.d/xpanel-management.conf', certPath])
    const body = JSON.stringify(view)
    expect(body).not.toMatch(/PRIVATE|BEGIN CERTIFICATE/)
    expect(body).not.toContain(validPem.split('\n')[1])
  })
  it('warns on expiry, uncovered hostnames and a missing key', async () => {
    const expired = testCertificate({ cn: 'old.example.test', dns: ['old.example.test'], notBefore: '2025-01-01T00:00:00Z', notAfter: '2026-10-01T00:00:00Z' })
    const soon = testCertificate({ cn: 'panel.example.test', dns: ['*.example.test'], notBefore: '2026-10-01T00:00:00Z', notAfter: '2026-11-10T00:00:00Z' })
    const future = testCertificate({ cn: 'panel.example.test', dns: ['panel.example.test'], notBefore: '2026-11-01T00:00:00Z', notAfter: '2027-11-01T00:00:00Z' })
    const run = async (pem: string, key: HostPathInfo['kind'] = 'file') => (await readCertificatesServiceDetail({ host: fakeHost({ files: { '/etc/nginx/conf.d/xpanel-management.conf': ingress(), [certPath]: pem }, stats: { [certPath]: { kind: 'file', sizeBytes: pem.length }, [keyPath]: { kind: key, sizeBytes: 1 } } }).host, readState: async () => state(), now })).endpoints[0]!
    expect((await run(expired, 'missing'))).toMatchObject({ keyPresent: false, warnings: ['expired', 'hostname-not-covered', 'key-missing'] })
    expect((await run(soon)).warnings).toEqual(['expiring'])
    expect((await run(future)).warnings).toEqual(['not-yet-valid'])
    expect((await run(validPem, 'symlink')).keyPresent).toBeNull()
  })
  it('refuses missing, inconsistent, unexpected, oversized and key-bearing inputs without reading certificates', async () => {
    const endpoint = async (files: Record<string, string | Error>, stats: Record<string, HostPathInfo> = { [certPath]: { kind: 'file', sizeBytes: 100 }, [keyPath]: { kind: 'file', sizeBytes: 1 } }) => {
      const fake = fakeHost({ files, stats })
      return { panel: (await readCertificatesServiceDetail({ host: fake.host, readState: async () => state(), now })).endpoints[0]!, reads: fake.reads }
    }
    const conf = '/etc/nginx/conf.d/xpanel-management.conf'
    expect((await endpoint({})).panel).toMatchObject({ state: 'missing', reason: 'config_missing', certPath: null })
    expect((await endpoint({ [conf]: new Error('EACCES') })).panel).toMatchObject({ state: 'unavailable', reason: 'unreadable' })
    expect((await endpoint({ [conf]: 'server { listen 80; }' })).panel).toMatchObject({ state: 'unavailable', reason: 'listener_not_found' })
    const other = `/etc/xpanel/management-certificates/${'b'.repeat(64)}/fullchain.pem`
    const inconsistent = await endpoint({ [conf]: ingress(certPath, keyPath, other) })
    expect(inconsistent.panel).toMatchObject({ state: 'unavailable', reason: 'inconsistent_render' }); expect(inconsistent.reads).toEqual([conf])
    for (const [cert, key] of [['/etc/ssl/private/pure-ftpd.pem', keyPath], [certPath, '/etc/xpanel/management-certificates/' + 'b'.repeat(64) + '/privkey.pem'], ['/etc/xpanel/management-certificates/../../shadow/fullchain.pem', keyPath]]) {
      const unexpected = await endpoint({ [conf]: ingress(cert, key) })
      expect(unexpected.panel).toMatchObject({ state: 'unavailable', reason: 'unexpected_path', certPath: null }); expect(unexpected.reads).toEqual([conf])
    }
    expect((await endpoint({ [conf]: ingress() }, { [certPath]: { kind: 'missing', sizeBytes: 0 }, [keyPath]: { kind: 'missing', sizeBytes: 0 } })).panel).toMatchObject({ state: 'missing', reason: 'certificate_missing', keyPresent: false, warnings: ['key-missing'] })
    const large = await endpoint({ [conf]: ingress() }, { [certPath]: { kind: 'file', sizeBytes: 64 * 1024 + 1 }, [keyPath]: { kind: 'file', sizeBytes: 1 } })
    expect(large.panel).toMatchObject({ state: 'unavailable', reason: 'too_large' }); expect(large.reads).toEqual([conf])
    expect((await endpoint({ [conf]: ingress() }, { [certPath]: { kind: 'symlink', sizeBytes: 10 }, [keyPath]: { kind: 'file', sizeBytes: 1 } })).panel).toMatchObject({ state: 'unavailable', reason: 'unreadable' })
    const combined = validPem + '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n'
    const keyed = await endpoint({ [conf]: ingress(), [certPath]: combined })
    expect(keyed.panel).toMatchObject({ state: 'unavailable', reason: 'not_pem', certificate: null })
    expect(JSON.stringify(keyed.panel)).not.toMatch(/PRIVATE|MC4CAQ/)
    expect((await endpoint({ [conf]: ingress(), [certPath]: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n' })).panel).toMatchObject({ reason: 'unparsable' })
    expect((await endpoint({ [conf]: ingress(), [certPath]: 'x'.repeat(64 * 1024 + 1) })).panel).toMatchObject({ reason: 'too_large' })
  })
  it('extracts listener certificate and key paths per port', () => {
    expect(listenerTlsPaths(ingress(), 2087)).toEqual([{ cert: certPath, key: keyPath }])
    expect(listenerTlsPaths(ingress(), 12087)).toEqual([])
    expect(listenerTlsPaths('server { listen 8443 ssl; ssl_certificate "/etc/x/a.pem"; }', 8443)).toEqual([{ cert: '/etc/x/a.pem', key: null }])
  })
})

describe('host listing and stat helpers', () => {
  const root = mkdtempSync(join(tmpdir(), 'xp-service-detail-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  it('lists a pinned directory with lstat kinds and sizes, bounded', async () => {
    writeFileSync(join(root, 'b.example.zone'), 'abc'); mkdirSync(join(root, 'a.example.zone'))
    expect(await listPinnedDirectory(root, 10)).toEqual({ state: 'read', truncated: false, entries: [{ name: 'a.example.zone', kind: 'directory', sizeBytes: expect.any(Number) }, { name: 'b.example.zone', kind: 'file', sizeBytes: 3 }] })
    expect(await listPinnedDirectory(root, 1)).toMatchObject({ truncated: true, entries: [{ name: 'a.example.zone' }] })
    expect(await listPinnedDirectory(join(root, 'absent'), 10)).toEqual({ state: 'missing', entries: [], truncated: false })
  })
  it('refuses every listing and stat path except the reviewed constants', async () => {
    await expect(listHostDirectory('/etc', 10)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(listHostDirectory('/var/lib/powerdns/zones/../..', 10)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    for (const path of ['/etc/shadow', '/etc/ssl/private/pure-ftpd.pem', `/etc/xpanel/management-certificates/${generation}/../x/fullchain.pem`, `/etc/xpanel/management-certificates/${generation}/cert.pem`]) {
      await expect(statHostPath(path)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
  })
})
