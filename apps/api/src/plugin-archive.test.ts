import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PLUGIN_ARCHIVE_LIMITS, pluginPackageFromArchive } from './plugin-archive.ts'
import { parsePluginPackage } from './plugin-packages.ts'

const octal = (value: number, width: number): string => value.toString(8).padStart(width - 1, '0') + '\0'
const entry = (path: string, body: string | Buffer = '', type = '0'): Buffer => {
  const data = Buffer.from(body), header = Buffer.alloc(512)
  header.write(path, 0); header.write(octal(0o644, 8), 100); header.write(octal(0, 8), 108); header.write(octal(0, 8), 116); header.write(octal(data.length, 12), 124); header.write(octal(0, 12), 136)
  header.write(type, 156); header.write('ustar\0' + '00', 257)
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)])
}
const archive = (...entries: Buffer[]): Buffer => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
const png = (): Buffer => {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'latin1'); bytes.writeUInt32BE(48, 16); bytes.writeUInt32BE(48, 20)
  return bytes
}
const link = (overrides: Record<string, unknown> = {}) => ({ type: 'link', id: 'Plugin_One', name: 'Plugin one', group_id: 'my_plugins', order: 2, uri: 'https://example.test/one', icon: 'one.png', ...overrides })
const group = { type: 'group', id: 'my_plugins', name: 'My group', order: 11, icon: 'group.svg' }
const refusal = (reason: string) => ({ code: 'VALIDATION', detail: { reason, stateChanged: false } })

describe('cPanel plugin archives', { tags: ['unit'] }, () => {
  it('reads install.json and icons in one directory into a valid package, in cPanel order', () => {
    const raw = pluginPackageFromArchive(archive(entry('acme/', '', '5'), entry('acme/install.json', JSON.stringify([group, link(), link({ id: 'two', name: 'Two', order: 1, feature: 'second_key', group_id: 'files' })])), entry('acme/one.png', png()), entry('acme/meta.json', '{}'), entry('acme/index.live.php', '<?php')), 'acme')
    const parsed = parsePluginPackage(raw)
    expect(parsed.items.map(item => [item.id, item.group, item.priority, item.feature])).toEqual([['two', 'Files', 1, 'plugin:second_key'], ['plugin_one', 'My group', 2, 'plugin:Plugin_One']])
    expect(parsed.items[0]!.icon).toEqual({ type: 'image/png', data: png().toString('base64') })
  })

  it('reads a root layout with ./ names and keeps a link out of the Feature Manager when featuremanager is 0', () => {
    const parsed = parsePluginPackage(pluginPackageFromArchive(archive(entry('./install.json', JSON.stringify([group, link({ featuremanager: 0 })])), entry('./one.png', png())), 'acme'))
    expect(parsed.items[0]!.feature).toBeNull()
  })

  it.each([
    ['plugin_archive_format', () => Buffer.from('not gzip')],
    ['plugin_archive_format', () => archive(entry('meta.json', '{}'))],
    ['plugin_archive_format', () => archive(entry('install.json', 'not json'))],
    ['plugin_archive_format', () => archive(entry('a/install.json', '[]'), entry('b/install.json', '[]'))],
    ['plugin_archive_format', () => archive(entry('../install.json', '[]'))],
    ['plugin_archive_entry', () => archive(entry('install.json', '[]'), entry('link', '', '2'))],
    ['plugin_archive_item', () => archive(entry('install.json', JSON.stringify([{ type: 'account_enhancement', id: 'x', name: 'X' }])))],
    ['plugin_archive_code', () => archive(entry('install.json', JSON.stringify([link({ uri: 'my_plugin/index.live.php' })])), entry('one.png', png()))],
    ['plugin_icon_format', () => archive(entry('install.json', JSON.stringify([link()])))],
  ])('refuses with %s', (reason, build) => {
    expect(() => pluginPackageFromArchive(build(), 'acme')).toThrowError(expect.objectContaining(refusal(reason)))
  })

  it('stops at the unpacked bound', () => {
    expect(() => pluginPackageFromArchive(gzipSync(Buffer.alloc(PLUGIN_ARCHIVE_LIMITS.unpacked + 1)), 'acme')).toThrowError(expect.objectContaining(refusal('plugin_archive_format')))
  })
})
