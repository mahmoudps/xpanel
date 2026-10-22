import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import { buildTar, chunked } from '../testing/tar.ts'
import type { TestEntry } from '../testing/tar.ts'
import { normalizeEntryName, resolveLinkTarget } from './paths.ts'
import { hashing, readBody, walkTar } from './reader.ts'
import type { SafeEntry } from './guard.ts'

const collect = async (entries: TestEntry[], opts: { gzip?: boolean; scope?: (p: string) => string | null } = {}) => {
  const buf = await buildTar(entries, { gzip: opts.gzip ?? false })
  const seen: { entry: SafeEntry; text: string }[] = []
  const summary = await walkTar(chunked(buf), async (entry, body) => {
    seen.push({ entry, text: (await readBody(body, 1 << 20))?.toString() ?? '' })
  }, opts.scope ? { linkScope: opts.scope } : {})
  return { seen, summary }
}

const rejects = async (entries: TestEntry[], re: RegExp, scope?: (p: string) => string | null) => {
  const p = collect(entries, scope ? { scope } : {})
  await expect(p).rejects.toThrow(XpanelError)
  await expect(p).rejects.toThrow(re)
}

describe('normalizeEntryName', () => {
  it('accepts plain relative names and a leading ./', () => {
    expect(normalizeEntryName('./a/b.txt')).toEqual({ ok: true, path: 'a/b.txt', control: false })
    expect(normalizeEntryName('dir/')).toEqual({ ok: true, path: 'dir', control: false })
    expect(normalizeEntryName('./')).toEqual({ ok: true, path: '', control: false })
    expect(normalizeEntryName('a/\u0007bell')).toMatchObject({ ok: true, control: true })
  })

  it('rejects traversal, absolute and ambiguous names', () => {
    for (const bad of ['../x', 'a/../../x', 'a/./b', '/etc/passwd', 'a//b', 'a\\..\\b', 'C:/x', 'a\u0000b', '', 'a//', `${'x'.repeat(256)}/y`]) {
      expect(normalizeEntryName(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('resolves link targets lexically within a scope', () => {
    expect(resolveLinkTarget('home/www', 'public_html', 'home')?.path).toBe('home/public_html')
    expect(resolveLinkTarget('home/a/b', '../c', 'home')?.path).toBe('home/c')
    expect(resolveLinkTarget('home/a', '../../etc/passwd', 'home')).toBeNull()
    expect(resolveLinkTarget('home/a', '../mysql/x.sql', 'home')).toBeNull()
    expect(resolveLinkTarget('home/a', '/etc/shadow', 'home')).toBeNull()
    expect(resolveLinkTarget('home/a', '', 'home')).toBeNull()
  })
})

describe('walkTar', () => {
  it('streams plain and gzip archives in small chunks', async () => {
    for (const gzip of [false, true]) {
      const { seen, summary } = await collect([
        { name: 'top/', type: 'directory' },
        { name: 'top/a.txt', content: 'hello' },
        { name: 'top/www', type: 'symlink', linkname: 'a.txt' },
        { name: 'top/hard', type: 'link', linkname: 'top/a.txt' },
      ], { gzip })
      expect(seen.map((s) => [s.entry.path, s.entry.type, s.text])).toEqual([
        ['top', 'directory', ''], ['top/a.txt', 'file', 'hello'], ['top/www', 'symlink', ''], ['top/hard', 'hardlink', ''],
      ])
      expect(summary).toMatchObject({ entries: 4, bytes: 5, skippedTotal: 0 })
    }
  })

  it('drains entries the visitor does not read', async () => {
    const buf = await buildTar([{ name: 'a', content: 'x'.repeat(100_000) }, { name: 'b', content: 'y' }])
    const names: string[] = []
    await walkTar(chunked(buf, 4096), async (e) => { names.push(e.path) })
    expect(names).toEqual(['a', 'b'])
  })

  it('rejects the whole archive on traversal or absolute names', async () => {
    await rejects([{ name: 'ok', content: '1' }, { name: '../../etc/cron.d/evil', content: '* * * * * root sh' }], /path traversal/)
    await rejects([{ name: '/etc/passwd', content: 'x' }], /absolute/)
    await rejects([{ name: 'a/../../b', content: 'x' }], /traversal/)
  })

  it('rejects writes through a symlink and symlink/dir swaps', async () => {
    await rejects([{ name: 'h/link', type: 'symlink', linkname: 'sub' }, { name: 'h/link/x', content: 'pwn' }], /through or over a symlink/)
    await rejects([{ name: 'h/d/f', content: '1' }, { name: 'h/d', type: 'symlink', linkname: 'e' }], /replaces a directory/)
    await rejects([{ name: 'h/l', type: 'symlink', linkname: 'x' }, { name: 'h/l', content: 'over' }], /symlink/)
  })

  it('skips escaping symlinks and device nodes but keeps going', async () => {
    const { seen, summary } = await collect([
      { name: 'h/access-logs', type: 'symlink', linkname: '/usr/local/apache/domlogs/bob' },
      { name: 'h/up', type: 'symlink', linkname: '../../../etc' },
      { name: 'h/dev', type: 'character-device' },
      { name: 'h/fifo', type: 'fifo' },
      { name: 'h/bell\u0007', content: 'x' },
      { name: 'h/ok.txt', content: 'fine' },
    ], { scope: () => 'h' })
    expect(seen.map((s) => s.entry.path)).toEqual(['h/ok.txt'])
    expect(summary.skipped.map((s) => s.code)).toEqual(['symlink-escape', 'symlink-escape', 'special-file', 'special-file', 'control-chars'])
  })

  it('skips symlinks that resolve through another symlink, in either order', async () => {
    const { seen, summary } = await collect([
      { name: 'h/a', type: 'symlink', linkname: 'real' },
      { name: 'h/b', type: 'symlink', linkname: 'a/x' },
    ], { scope: () => 'h' })
    expect(seen.map((s) => s.entry.path)).toEqual(['h/a'])
    expect(summary.skipped[0]?.code).toBe('symlink-chain')

    // deploy-style chains (live -> current -> releases/2) are common: the later link is
    // skipped, never the whole archive, because `h/up -> ..` would re-point `h/a` outside h
    const later = await collect([
      { name: 'h/a', type: 'symlink', linkname: 'up/up/etc' },
      { name: 'h/up', type: 'symlink', linkname: '..' },
      { name: 'h/live', type: 'symlink', linkname: 'current' },
      { name: 'h/current', type: 'symlink', linkname: 'releases/2' },
      { name: 'h/ok', content: 'fine' },
    ], { scope: () => 'h' })
    expect(later.seen.map((s) => s.entry.path)).toEqual(['h/a', 'h/live', 'h/ok'])
    expect(later.summary.skipped.map((x) => [x.path, x.code])).toEqual([['h/up', 'symlink-chain'], ['h/current', 'symlink-chain']])
  })

  it('records any symlink target as data when asked, still refusing writes through links', async () => {
    const buf = await buildTar([
      { name: 'www', type: 'symlink', linkname: '/home/alice/public_html' },
      { name: 'live', type: 'symlink', linkname: 'current' },
      { name: 'current', type: 'symlink', linkname: 'releases/2' },
      { name: 'bell', type: 'symlink', linkname: `x${String.fromCharCode(7)}` },
    ])
    const seen: [string, string | null][] = []
    const summary = await walkTar(chunked(buf), async (e) => { seen.push([e.path, e.linkTarget]) }, { symlinks: 'any' })
    expect(seen).toEqual([['www', '/home/alice/public_html'], ['live', 'current'], ['current', 'releases/2']])
    expect(summary.skipped.map((x) => x.code)).toEqual(['control-chars'])
    const through = await buildTar([{ name: 'www', type: 'symlink', linkname: '/etc' }, { name: 'www/passwd', content: 'x' }])
    await expect(walkTar(chunked(through), async () => {}, { symlinks: 'any' })).rejects.toThrow(/through or over a symlink/)
  })

  it('reports every skipped entry to onSkip, beyond the capped summary', async () => {
    const entries = Array.from({ length: 1005 }, (_, i) => ({ name: `d${i}`, type: 'fifo' as const }))
    const buf = await buildTar(entries)
    const all: string[] = []
    const summary = await walkTar(chunked(buf, 8192), async () => {}, { onSkip: (x) => { all.push(x.path) } })
    expect(all).toHaveLength(1005)
    expect(summary.skipped).toHaveLength(1000)
    expect(summary.skippedTotal).toBe(1005)
  })

  it('rejects hardlinks leaving their scope', async () => {
    await rejects([{ name: 'h/x', type: 'link', linkname: '../etc/shadow' }], /hardlink/)
    await rejects([{ name: 'h/x', type: 'link', linkname: 'other/secret' }], /hardlink target outside/, (p) => (p.startsWith('h/') ? 'h' : 'other'))
  })

  it('enforces entry and byte caps', async () => {
    const buf = await buildTar([{ name: 'a', content: '1' }, { name: 'b', content: '2' }, { name: 'c', content: '3' }])
    await expect(walkTar(chunked(buf), async () => {}, { maxEntries: 2 })).rejects.toThrow(/more than 2 entries/)
    await expect(walkTar(chunked(buf), async () => {}, { maxTotalBytes: 2 })).rejects.toThrow(/exceeds 2 bytes/)
  })

  it('reports corrupt, truncated and empty input as validation errors', async () => {
    await expect(walkTar(chunked(Buffer.from('not a tar archive at all'.repeat(40))), async () => {})).rejects.toThrow(/corrupt/)
    const good = await buildTar([{ name: 'a', content: 'x'.repeat(2000) }])
    await expect(walkTar(chunked(good.subarray(0, 1000)), async () => {})).rejects.toThrow(/corrupt/)
    await expect(walkTar(chunked(Buffer.alloc(0)), async () => {})).rejects.toThrow(/empty/)
    await expect(walkTar(chunked(Buffer.from([0x1f, 0x8b, 1, 2, 3, 4])), async () => {})).rejects.toThrow(XpanelError)
  })

  it('propagates visitor errors unchanged', async () => {
    const buf = await buildTar([{ name: 'a', content: '1' }])
    await expect(walkTar(chunked(buf), async () => { throw new Error('sink full') })).rejects.toThrow('sink full')
  })
})

describe('body helpers', () => {
  it('hashes while streaming and caps in-memory reads', async () => {
    async function* src(): AsyncGenerator<Buffer> { yield Buffer.from('ab'); yield Buffer.from('c') }
    const h = hashing(src())
    const it = h.body[Symbol.asyncIterator]()
    await it.next()
    expect(await h.finish()).toEqual({ size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' })
    expect(await readBody(src(), 2)).toBeNull()
    expect((await readBody(src(), 3))?.toString()).toBe('abc')
  })
})
