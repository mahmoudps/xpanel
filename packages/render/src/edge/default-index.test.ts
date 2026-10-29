import { describe, expect, it } from 'vitest'
import { renderApacheVhost, renderApacheVhosts } from './apache.ts'
import { renderOlsVhost } from './ols.ts'
import { renderDefaultSite } from './nginx.ts'
import { account, debianOs, domain, php, settings } from './testkit.ts'

describe('per-vhost directory-index render consumption', () => {
  it('preserves byte-identical absent-field Apache and OLS rendering', () => {
    const legacy = domain(), explicitUndefined = { ...legacy, indexFiles: undefined }, a = account(), config = settings()
    expect(renderApacheVhost(a, legacy, config, debianOs)).toEqual(renderApacheVhost(a, explicitUndefined, config, debianOs))
    expect(renderApacheVhost(a, legacy, config, debianOs).content).not.toContain('DirectoryIndex')
    const ols = settings({ engine: 'openlitespeed' }), lsDomain = domain({ php: php({ handler: 'lsphp' }) })
    expect(renderOlsVhost(a, lsDomain, ols, debianOs)).toEqual(renderOlsVhost(a, { ...lsDomain, indexFiles: undefined }, ols, debianOs))
    expect(renderOlsVhost(a, lsDomain, ols, debianOs).vhconf.content).toMatch(/indexFiles\s+index.php, index.html, index.htm/)
  })
  it.each(['php', 'static'] as const)('replaces inherited Apache indexes in the %s document-root directory', type => {
    const d = domain({ siteType: type, indexFiles: ['home.html', 'index.php'] }), content = renderApacheVhost(account(), d, settings(), debianOs).content
    const section = content.slice(content.indexOf('<Directory "' + d.docRoot + '">'), content.indexOf('</Directory>') + 12)
    expect(section).toContain('DirectoryIndex disabled\n        DirectoryIndex home.html index.php')
    expect(content).not.toContain('DirectoryIndex index.php index.html index.htm')
  })
  it('uses ordered OLS filenames with server inheritance explicitly disabled', () => {
    const d = domain({ php: php({ handler: 'lsphp' }), indexFiles: ['home.html', 'index.php'] })
    const content = renderOlsVhost(account(), d, settings({ engine: 'openlitespeed' }), debianOs).vhconf.content
    expect(content).toMatch(/index \{\n\s+useServer\s+0\n\s+indexFiles\s+home.html, index.php\n\}/)
  })
  it('aliases use only the serving vhost index order and do not create another writer', () => {
    const primary = domain({ indexFiles: ['home.html', 'index.php'] }), alias = domain({ id: '22222222-2222-4222-8222-222222222222', name: 'alias.example.test', kind: 'alias', parentId: primary.id, indexFiles: ['ignored.html'] })
    const files = renderApacheVhosts(account(), [primary, alias], settings(), debianOs)
    expect(files).toHaveLength(1); expect(files[0]!.content).toContain('DirectoryIndex home.html index.php')
    expect(files[0]!.content).not.toContain('ignored.html')
  })
  it('keeps suspended, redirect and upstream behavior separate from index overrides', () => {
    for (const patch of [{ suspended: true }, { redirect: { to: 'https://other.example.test/', code: 302 as const } }, { siteType: 'node' as const, upstream: 'http://127.0.0.1:3000' }]) {
      const d = domain({ indexFiles: ['home.html'], ...patch })
      expect(renderApacheVhost(account(), d, settings(), debianOs).content).not.toContain('DirectoryIndex')
    }
  })
  it('revalidates saved basenames at the render boundary before emitting directives', () => {
    const d = domain({ indexFiles: ['home.html\nRequire all granted'] })
    expect(() => renderApacheVhost(account(), d, settings(), debianOs)).toThrow()
    expect(() => renderOlsVhost(account(), { ...d, php: php({ handler: 'lsphp' }) }, settings({ engine: 'openlitespeed' }), debianOs)).toThrow()
  })
  it('leaves catchall reject/redirect output unchanged for any domain index order', () => {
    const saved = settings({ defaultSite: { response: 'redirect', redirectTo: 'https://landing.example.test/', refuseHttps: true } })
    const before = renderDefaultSite({ settings: saved })
    renderApacheVhost(account(), domain({ indexFiles: ['home.html', 'index.php'] }), saved, debianOs)
    expect(renderDefaultSite({ settings: saved })).toBe(before)
    expect(before).toContain('return 302 "https://landing.example.test/";')
  })
})
