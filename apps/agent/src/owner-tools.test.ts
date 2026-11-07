import { describe, expect, it } from 'vitest'
import type { Account } from '@xpanel/core'
import { buildImageCommand, buildPerlCommand, IMAGE_SCRIPT, imageArguments, isOwnerToolCommand, PILLOW_CHECK, readPerlInventory } from './owner-tools.ts'

const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice' } as Account

describe('owner tool commands', () => {
  it('admits exactly the commands it builds', () => {
    const perl = buildPerlCommand(account, 'install', 'JSON::Tiny')
    expect(perl.slice(-4)).toEqual(['--notest', '--local-lib', '/home/alice/perl5', 'JSON::Tiny'])
    expect(isOwnerToolCommand(perl)).toBe(true)
    expect(isOwnerToolCommand(buildPerlCommand(account, 'uninstall', 'JSON::Tiny'))).toBe(true)
    expect(isOwnerToolCommand(perl.map(v => v === 'User=20014' ? 'User=0' : v))).toBe(false)
    expect(isOwnerToolCommand([...perl.slice(0, -1), '--installdeps'])).toBe(false)
    expect(isOwnerToolCommand(perl.map(v => v === '/usr/bin/cpanm' ? '/usr/bin/curl' : v))).toBe(false)
    expect(isOwnerToolCommand([...PILLOW_CHECK])).toBe(true)
    expect(isOwnerToolCommand(['/usr/sbin/nginx', '-t'])).toBe(false)
    const image = buildImageCommand(account, ['thumbnail', 'public_html/pics', '50', '50'])
    expect(image).toContain('MemoryMax=256M')
    expect(isOwnerToolCommand(image)).toBe(true)
    expect(isOwnerToolCommand(image.map(v => v === 'MemoryMax=256M' ? 'MemoryMax=64G' : v))).toBe(false)
    expect(isOwnerToolCommand(image.map(v => v === IMAGE_SCRIPT ? IMAGE_SCRIPT + 'import os' : v))).toBe(false)
  })

  it('refuses a malformed module name before any command', () => {
    for (const bad of ['', 'JSON Tiny', '--help', 'A::', "x'; rm -rf"]) expect(() => buildPerlCommand(account, 'install', bad)).toThrow(/invalid Perl module/)
  })
})

describe('image operations', () => {
  it('bounds every request and keeps paths inside the home', () => {
    expect(imageArguments({ op: 'thumbnail', path: 'public_html', widthPercent: 50, heightPercent: 50 })).toEqual(['thumbnail', 'public_html', '50', '50'])
    expect(imageArguments({ op: 'scale', path: 'a.png', width: 10, height: 10 })).toEqual(['scale', 'a.png', '10', '10', ''])
    expect(() => imageArguments({ op: 'thumbnail', path: 'x', widthPercent: 500, heightPercent: 1 })).toThrow(/out of range/)
    expect(() => imageArguments({ op: 'scale', path: 'a.png', width: 100000, height: 1 })).toThrow(/out of range/)
    expect(() => imageArguments({ op: 'read', path: '../other/a.png' })).toThrow(/inside your home/)
    expect(() => imageArguments({ op: 'read', path: 'notes.txt' })).toThrow(/PNG, JPG/)
    expect(() => imageArguments({ op: 'convert', path: 'a.png', format: 'tiff' })).toThrow(/format must be/)
    expect(() => imageArguments({ op: 'delete' })).toThrow(/unknown image/)
  })
})

describe('Perl inventory', () => {
  it('reads what cpanm recorded and treats a missing library as empty', async () => {
    const files = {
      list: async (path: string) => path.endsWith('/lib/perl5') ? [{ name: 'x86_64-linux', kind: 'directory' }] : [{ name: 'JSON-Tiny-0.58', kind: 'directory' }, { name: 'broken', kind: 'directory' }],
      readText: async (path: string) => { if (path.includes('broken')) throw new Error('unreadable'); return { content: JSON.stringify({ name: 'JSON-Tiny', target: 'JSON::Tiny', version: '0.58' }) } },
    }
    expect(await readPerlInventory(files)).toEqual([{ name: 'JSON::Tiny', version: '0.58' }])
  })
})
