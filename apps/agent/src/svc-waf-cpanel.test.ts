import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { fetchVendorMetadata, installVendor, recordInstalledVendor, vendorUnchanged } from './svc-waf.ts'
import { parseCpanelVendorMetadata, zipEntries } from './svc-waf-cpanel.ts'

interface ZipFile { name: string; body?: string; stored?: boolean; mode?: number; flags?: number }
/** A small zip writer for the reader's tests. */
const zipOf = (files: ZipFile[]): Buffer => {
  const locals: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const { name, body = '', stored = false, mode = 0o100644, flags = 0 } of files) {
    const raw = Buffer.from(body), data = stored ? raw : deflateRawSync(raw), path = Buffer.from(name)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(flags, 6); local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(path.length, 26)
    const head = Buffer.alloc(46); head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(flags, 8); head.writeUInt16LE(stored ? 0 : 8, 10); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(raw.length, 24); head.writeUInt16LE(path.length, 28); head.writeUInt32LE(mode * 65536, 38); head.writeUInt32LE(offset, 42)
    locals.push(local, path, data); central.push(head, path)
    offset += local.length + path.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
const rule = 'SecRule ARGS "@rx evil" "id:1000,phase:2,deny"\n'
const metadata = (digest: string, url = 'https://rules.test/acme.zip'): string => `---
'2.8.0':
  MD5: abc
  SHA512: ${'1'.repeat(128)}
  distribution: ACME_old
  url: https://rules.test/old.zip
2.9.2:
  MD5: def
  SHA512: ${digest}
  distribution: ACME_2.9
  url: ${url}
attributes:
  description: Rules of Acme
  name: Acme rules
  report_url: https://rules.test/report
  vendor_url: https://rules.test/
`
const META = 'https://rules.test/meta_ACME.yaml'
const fetcher = (files: Record<string, Buffer | string>) => async (url: string): Promise<Buffer> => Buffer.from(files[url] ?? (() => { throw new Error('unexpected ' + url) })())
const stopped = (zip: Buffer, max = 1024 * 1024): string => { try { [...zipEntries(zip, max, reason => { throw new Error(reason) })]; return 'read' } catch (error) { return (error as Error).message } }

describe('cPanel ModSecurity vendor metadata', { tags: ['unit'] }, () => {
  it('reads attributes and the newest listed release, with the vendor id from the file name', () => {
    expect(parseCpanelVendorMetadata(metadata('A'.repeat(128)), META)).toEqual({ id: 'acme', name: 'Acme rules', description: 'Rules of Acme', docsUrl: 'https://rules.test/', version: 'ACME_2.9', archiveUrl: 'https://rules.test/acme.zip',
      archiveSha256: null, archiveSha512: 'a'.repeat(128), archiveDirectory: 'ACME' })
  })

  it.each([
    ['vendor_metadata_name', metadata('a'.repeat(128)), 'https://rules.test/acme.yaml'],
    ['vendor_metadata_yaml', 'a: [', META],
    ['vendor_metadata_format', 'attributes: {name: x}', META],
    ['vendor_metadata_format', metadata('a'.repeat(128), 'https://rules.test/acme.tgz'), META],
    ['vendor_metadata_format', metadata('a'.repeat(128), 'http://rules.test/acme.zip'), META],
    ['vendor_digest_missing', metadata('abc'), META],
  ])('refuses with %s', (reason, text, url) => {
    expect(() => parseCpanelVendorMetadata(text, url)).toThrowError(expect.objectContaining({ code: 'VALIDATION', detail: expect.objectContaining({ reason }) }))
  })

  it('fetches YAML and JSON by the metadata path', async () => {
    await expect(fetchVendorMetadata(META, fetcher({ [META]: metadata('b'.repeat(128)) }))).resolves.toMatchObject({ id: 'acme' })
  })

  it('installs a zip pinned by SHA-512, writes only rule and data files, and detects a new release', async () => {
    const zip = zipOf([{ name: 'ACME/', mode: 0o40755 }, { name: 'ACME/rules/a.conf', body: rule }, { name: 'ACME/a.data', body: 'word', stored: true }, { name: 'ACME/link.conf', mode: 0o120777, body: '/etc/shadow' }, { name: 'ACME/readme.txt', body: 'x' }])
    const digest = createHash('sha512').update(zip).digest('hex'), written: string[] = []
    const host = { writeFile: async (file: { path: string }) => { written.push(file.path.split('/').slice(-2).join('/')) }, removePath: async () => undefined }
    const get = fetcher({ [META]: metadata(digest), 'https://rules.test/acme.zip': zip })
    const installed = await installVendor(META, host, get)
    expect(written.sort()).toEqual(['acme/a.conf', 'acme/a.data'])
    expect(installed).toMatchObject({ vendor: { id: 'acme', version: 'ACME_2.9', metadataUrl: META, archiveSha256: createHash('sha256').update(zip).digest('hex') }, archiveSha512: digest, files: ['a.conf'] })
    let record: Record<string, { version: string; archiveSha256: string; archiveSha512?: string }> = {}
    await recordInstalledVendor(installed, { read: async () => record, write: async value => { record = value } })
    const fresh = await fetchVendorMetadata(META, get)
    expect(vendorUnchanged(fresh, record.acme!)).toBe(true)
    expect(vendorUnchanged({ ...fresh, archiveSha512: 'c'.repeat(128) }, record.acme!)).toBe(false)
    expect(vendorUnchanged({ ...fresh, archiveSha256: 'c'.repeat(64), archiveSha512: null }, record.acme!)).toBe(false)
  })

  it('refuses a wrong digest and an archive outside the vendor directory before writing', async () => {
    const zip = zipOf([{ name: 'other/a.conf', body: rule }]), written: string[] = []
    const host = { writeFile: async (file: { path: string }) => { written.push(file.path) }, removePath: async () => undefined }
    await expect(installVendor(META, host, fetcher({ [META]: metadata('d'.repeat(128)), 'https://rules.test/acme.zip': zip }))).rejects.toMatchObject({ detail: { reason: 'archive_digest_mismatch' } })
    await expect(installVendor(META, host, fetcher({ [META]: metadata(createHash('sha512').update(zip).digest('hex')), 'https://rules.test/acme.zip': zip }))).rejects.toMatchObject({ detail: { reason: 'archive_layout' } })
    expect(written).toEqual([])
  })
})

describe('zip reader', { tags: ['unit'] }, () => {
  it('reads stored and deflated files and labels directories and links', () => {
    const entries = [...zipEntries(zipOf([{ name: 'd/', mode: 0o40755 }, { name: 'd/a', body: 'one' }, { name: 'd/b', body: 'two', stored: true }, { name: 'd/l', mode: 0o120777, body: 'x' }]), 1024, reason => { throw new Error(reason) })]
    expect(entries.map(entry => [entry.path, entry.type, entry.data.toString()])).toEqual([['d/', '5', ''], ['d/a', '0', 'one'], ['d/b', '0', 'two'], ['d/l', '2', '']])
  })

  it.each([
    ['archive_path_refused', () => zipOf([{ name: '../a' }])],
    ['archive_path_refused', () => zipOf([{ name: 'a\\..\\b' }])],
    ['archive_path_refused', () => zipOf([{ name: '/etc/a' }])],
    ['archive_encrypted', () => zipOf([{ name: 'a', flags: 1 }])],
    ['archive_unreadable', () => Buffer.alloc(64)],
    ['archive_unreadable', () => Buffer.from('PK')],
  ])('refuses with %s', (reason, build) => {
    expect(stopped(build())).toBe(reason)
  })

  it('stops at the unpacked bound before inflating', () => {
    expect(stopped(zipOf([{ name: 'a', body: 'x'.repeat(2048) }]), 1024)).toBe('archive_too_large')
  })
})
