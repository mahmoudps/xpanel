import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { navigation, registeredDocumentAliases } from '@xpanel/catalog'
import { v2Assets, v2Stylesheet } from './assets.ts'
import { v2RouteStylesheets, v2SharedStylesheets, v2StylesheetsForDocument, v2SupplementalStylesheets, v2ViewStylesheets } from './route-assets.ts'
import { createV2Stylesheet } from './stylesheet.ts'

const css = v2Stylesheet.body
const foundationAssets = [v2Stylesheet, ...v2SharedStylesheets]
const compressedBytes = (assets: readonly { readonly body: string }[]): number => assets.reduce((sum, asset) => sum + gzipSync(asset.body).byteLength, 0)
const rulesFor = (source: string): string[] => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{|@supports[^{]+\{|@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '').split('}').map(rule => rule.trim()).filter(Boolean)

describe('v2 stylesheet asset', () => {
  it('is versioned by content hash and stays well inside the browser budget', () => {
    expect(v2Stylesheet.href).toBe(`/assets/themes/v2/styles.css?v=${createHash('sha256').update(css).digest('hex').slice(0, 16)}`)
    expect(v2Stylesheet.contentType).toBe('text/css; charset=utf-8')
    expect(v2Assets).toEqual([v2Stylesheet, ...v2SharedStylesheets, ...Object.values(v2ViewStylesheets), ...v2RouteStylesheets.map(entry => entry.stylesheet), ...v2SupplementalStylesheets.map(entry => entry.stylesheet)])
    expect(Object.isFrozen(v2Assets)).toBe(true)
    // The shared foundation remains under a fifth of the 60 KB per-route budget.
    expect(compressedBytes(foundationAssets)).toBeLessThan(12 * 1024)
    for (const entry of v2RouteStylesheets) {
      for (const route of entry.routes) {
        for (const viewKind of ['workspace', 'unavailable'] as const) {
          const assets = [...foundationAssets, ...v2StylesheetsForDocument({ surface: entry.surface, route, viewKind })]
          expect(compressedBytes(assets), `${viewKind}: ${route}`).toBeLessThanOrEqual(60 * 1024)
        }
      }
    }
    for (const viewKind of ['login', 'status'] as const) expect(compressedBytes([...foundationAssets, ...v2StylesheetsForDocument({ viewKind })])).toBeLessThanOrEqual(60 * 1024)
  })

  it('scopes every rule to the v2 root or a v2-owned class or id, and never styles classic classes', () => {
    for (const asset of v2Assets) {
      for (const rule of rulesFor(asset.body)) {
        const selectors = rule.slice(0, rule.indexOf('{'))
        if (!selectors.trim()) continue
        for (const selector of selectors.split(/,(?![^(]*\))/)) {
          expect(selector.trim(), `${asset.path}: ${rule}`).toMatch(/^(?::where\(\[data-ui-theme="v2"\]\)|\[data-ui-theme="v2"\]|\.v2-|#xp-toast-region)/)
        }
      }
      expect(asset.body, asset.path).not.toMatch(/\.xp-/)
      expect(asset.body, asset.path).not.toContain('/*')
    }
  })

  it('lays out right to left through logical properties only', () => {
    for (const asset of v2Assets) {
      expect(asset.body, asset.path).not.toMatch(/(?:^|[;{\s])(?:margin|padding|border)-(?:left|right)\b/)
      expect(asset.body, asset.path).not.toMatch(/(?:^|[;{\s])(?:left|right)\s*:/)
      expect(asset.body, asset.path).not.toMatch(/(?:text-align|float|clear)\s*:\s*(?:left|right)/)
      // Four-value margin/padding shorthands are physical on the inline axis unless both sides match.
      for (const [, , , right, , left] of asset.body.matchAll(/(?:^|[;{])(margin|padding):\s*([^;}\s]+)\s+([^;}\s]+)\s+([^;}\s]+)\s+([^;}\s]+)\s*[;}]/g)) expect(right, asset.path).toBe(left)
    }
    expect(css).toContain('.v2-flip:dir(rtl){transform:scaleX(-1)}')
  })

  it('versions every independent page asset by its bytes and retains unique immutable paths', () => {
    expect(new Set(v2Assets.map(asset => asset.path)).size).toBe(v2Assets.length)
    for (const asset of v2Assets) {
      const version = createHash('sha256').update(asset.body).digest('hex').slice(0, 16)
      expect(asset.href).toBe(`${asset.path}?v=${version}`)
      expect(asset.path).toMatch(/^\/assets\/themes\/v2\/[a-z-]+\.css$/)
      expect(asset.contentType).toBe('text/css; charset=utf-8')
      expect(Object.isFrozen(asset)).toBe(true)
    }
    const original = v2RouteStylesheets[0]!.stylesheet
    const changed = createV2Stylesheet('panel-home', [original.body, '.v2-home-changed{color:var(--text)}'])
    expect(changed.path).toBe(original.path)
    expect(changed.href).not.toBe(original.href)
    expect(v2Assets[0]).toBe(v2Stylesheet)
  })

  it('selects the exact implemented route without treating every catalog alias as an implementation', () => {
    const inbox = v2StylesheetsForDocument({ surface: 'xmail', route: '/mail/inbox' })
    expect(inbox).toHaveLength(1)
    for (const route of ['/mail/sent', '/mail/drafts', '/mail/trash', '/mail/compose']) {
      expect(v2StylesheetsForDocument({ surface: 'xmail', route })).toEqual(inbox)
    }
    for (const route of ['/mail/inbox/other', '/mail/inbox?lang=ar', 'https://example.test/mail/inbox']) {
      expect(v2StylesheetsForDocument({ surface: 'xmail', route }), route).toEqual([])
    }
    expect(v2StylesheetsForDocument({ surface: 'xwhm', route: '/mail/inbox' })).toEqual([])
    expect(v2StylesheetsForDocument({ surface: 'login', route: '/mail/inbox' })).toEqual([])
    expect(v2StylesheetsForDocument({ route: '/mail/inbox' })).toEqual([])
    expect(v2StylesheetsForDocument({ surface: 'xmail' })).toEqual([])
  })

  it('uses the new exact mail workspace routes instead of the canonical inbox alias', () => {
    const inbox = v2StylesheetsForDocument({ surface: 'xmail', route: '/mail/inbox' })[0]!
    const search = v2StylesheetsForDocument({ surface: 'xmail', route: '/mail/search' })
    expect(search).toHaveLength(2)
    expect(search[0]).toBe(inbox)
    expect(search[1]!.path).toBe('/assets/themes/v2/mail-tools.css')
    expect(search[1]).not.toBe(inbox)
    expect(search[0]!.body).toContain('.v2-mail-navigation')
    expect(search[1]!.body).toContain('.v2-mail-workspace')
    expect(v2Assets.filter(asset => asset.path === inbox.path)).toEqual([inbox])
    expect(v2StylesheetsForDocument({ surface: 'xmail', route: '/mail/settings/filters' })).toEqual(search)
    expect(v2StylesheetsForDocument({ surface: 'xpanel', route: '/mail/search' })).toEqual([])
  })

  it('maps every registered document to exactly its listener surface without adding alias descendants', () => {
    const canonical = navigation.flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => ({ route: page.route, surface: surface.surface }))))
    const byCanonicalRoute = new Map(canonical.map(document => [document.route, document.surface]))
    const registered = [...canonical, ...registeredDocumentAliases.map(alias => ({ route: alias.route, surface: byCanonicalRoute.get(alias.parentRoute)! }))]
    const actual = v2RouteStylesheets.flatMap(entry => entry.routes.map(route => ({ route, surface: entry.surface })))
    const byRoute = (a: { route: string }, b: { route: string }): number => a.route.localeCompare(b.route)
    expect(registered).toHaveLength(217)
    expect(actual).toHaveLength(217)
    expect(actual.toSorted(byRoute)).toEqual(registered.toSorted(byRoute))
    expect(new Set(actual.map(document => document.route)).size).toBe(actual.length)
    for (const document of actual) {
      expect(v2StylesheetsForDocument({ ...document, surface: document.surface === 'xpanel' ? 'xwhm' : 'xpanel' })).toEqual([])
      expect(v2StylesheetsForDocument({ ...document, route: `${document.route}/not-registered` })).toEqual([])
    }
  })

  it('loads the htaccess extension after the cached settings family without duplicating its base', () => {
    const settings = v2StylesheetsForDocument({ surface: 'xpanel', route: '/preferences' })[0]!
    const editor = v2StylesheetsForDocument({ surface: 'xpanel', route: '/software/htaccess' })
    expect(editor).toHaveLength(2)
    expect(editor[0]).toBe(settings)
    expect(editor[1]!.path).toBe('/assets/themes/v2/panel-htaccess.css')
    expect(editor[1]!.body).toContain('.v2-settings-code-editor')
    expect(settings.body).not.toContain('.v2-settings-code-editor')
    expect(v2StylesheetsForDocument({ surface: 'xpanel', route: '/software/store/install' })).toEqual([settings])
    expect(v2Assets.filter(asset => asset.path === settings.path)).toEqual([settings])
  })

  it('loads the shared diagnostic fragments only for their five exact owning documents', () => {
    const diagnostic = v2SupplementalStylesheets.find(entry => entry.stylesheet.path === '/assets/themes/v2/whm-diagnostics.css')!
    expect(diagnostic.routes).toEqual(['/whm/monitoring/health', '/whm/monitoring/limits', '/whm/monitoring/alerts', '/whm/monitoring/repair', '/whm/accounts/health'])
    expect(v2Assets.filter(asset => asset.path === diagnostic.stylesheet.path)).toEqual([diagnostic.stylesheet])
    expect(diagnostic.stylesheet.body).toContain('.v2-diagnostic__account')
    for (const entry of v2RouteStylesheets) for (const route of entry.routes) {
      const actual = v2StylesheetsForDocument({ surface: entry.surface, route })
      expect(actual.includes(diagnostic.stylesheet), route).toBe(entry.surface === 'xwhm' && diagnostic.routes.includes(route))
    }
    expect(v2StylesheetsForDocument({ surface: 'xpanel', route: '/whm/monitoring/health' })).toEqual([])
    expect(v2StylesheetsForDocument({ surface: 'xwhm', route: '/whm/monitoring/health/other' })).toEqual([])
  })

  it('loads virus scan state tones only after the cached settings base on its exact document', () => {
    const settings = v2StylesheetsForDocument({ surface: 'xpanel', route: '/preferences' })[0]!
    const virus = v2SupplementalStylesheets.find(entry => entry.stylesheet.path === '/assets/themes/v2/panel-virus-scan.css')!
    expect(virus.routes).toEqual(['/security/virus-scanner'])
    expect(virus.stylesheet.body).toContain('.v2-panel-settings [data-utility-row="virus-scan"]')
    expect(v2Assets.filter(asset => asset.path === virus.stylesheet.path)).toEqual([virus.stylesheet])
    for (const entry of v2RouteStylesheets) for (const route of entry.routes) {
      const actual = v2StylesheetsForDocument({ surface: entry.surface, route })
      expect(actual.includes(virus.stylesheet), route).toBe(entry.surface === 'xpanel' && route === '/security/virus-scanner')
    }
    expect(v2StylesheetsForDocument({ surface: 'xpanel', route: '/security/virus-scanner' })).toEqual([settings, virus.stylesheet])
    expect(v2StylesheetsForDocument({ surface: 'xwhm', route: '/security/virus-scanner' })).toEqual([])
    expect(v2StylesheetsForDocument({ surface: 'xpanel', route: '/security/virus-scanner/other' })).toEqual([])
  })

  it('binds each new workspace family to its own actual page selectors', () => {
    const families = [
      ['xpanel', '/databases/phppgadmin', 'panel-databases', '.v2-db-page'],
      ['xpanel', '/domains/dynamic-dns', 'panel-domains', '.v2-domain-page'],
      ['xpanel', '/advanced/terminal', 'panel-operations', '.v2-panel-operations'],
      ['xwhm', '/whm/plans/features', 'whm-plans', '.v2-plan-page'],
      ['xwhm', '/whm/resellers/ips-nameservers', 'whm-resellers', '.v2-resellers'],
      ['xwhm', '/whm/dns/providers', 'whm-network', '.v2-whm-network'],
      ['xwhm', '/whm/email/queue', 'whm-mail', '.v2-whm-mail'],
      ['xmail', '/mail/contacts', 'mail-tools', '.v2-organizer'],
      ['xpanel', '/domains/site-settings', 'panel-settings', '.v2-panel-settings'],
      ['xpanel', '/email/encryption', 'panel-email-observations', '.v2-panel-extra'],
      ['xpanel', '/metrics/logs', 'panel-email-observations', '.v2-panel-extra'],
      ['xwhm', '/whm/security/ssh', 'whm-observations', '.v2-observation'],
      ['xwhm', '/whm/audit', 'whm-observations', '.v2-observation'],
      ['xwhm', '/whm/accounts/health', 'whm-account-recovery', '.v2-account-tools'],
      ['xwhm', '/whm/backups/restore-more', 'whm-account-recovery', '.v2-recovery__steps'],
      ['xwhm', '/whm/databases/redis', 'whm-data', '.v2-whm-data'],
      ['xwhm', '/whm/software/store/extensions', 'whm-data', '.v2-whm-data'],
      ['xwhm', '/whm/services/web', 'whm-data', '.v2-whm-data'],
      ['xwhm', '/whm/server/setup', 'whm-server', '.v2-server-page'],
      ['xwhm', '/whm/panel/api-tokens', 'whm-panel', '.v2-panel-page'],
    ] as const
    for (const [surface, route, name, selector] of families) {
      const assets = v2StylesheetsForDocument({ surface, route, viewKind: 'workspace' })
      const selected = assets.filter(asset => asset.path === `/assets/themes/v2/${name}.css`)
      expect(selected, route).toHaveLength(1)
      expect(selected[0]!.body).toContain(selector)
      expect(new Set(assets.map(asset => asset.path)).size).toBe(assets.length)
    }
    for (const route of ['/domains/site-settings/other', '/databases/mariadb/other', '/whm/plans/new', '/mail/search/other']) {
      expect(v2StylesheetsForDocument({ surface: route.startsWith('/whm/') ? 'xwhm' : route.startsWith('/mail/') ? 'xmail' : 'xpanel', route }), route).toEqual([])
    }
  })

  it('loads explicit login, status and unavailable view styles without inspecting body HTML', () => {
    expect(v2StylesheetsForDocument({ viewKind: 'status', route: '/home', surface: 'xpanel' })).toEqual([v2ViewStylesheets.status])
    expect(v2StylesheetsForDocument({ viewKind: 'login' })).toEqual([v2ViewStylesheets.login])
    expect(v2StylesheetsForDocument({ viewKind: 'unavailable' })).toEqual([v2ViewStylesheets.unavailable])
    expect(v2StylesheetsForDocument({ viewKind: 'unavailable', route: '/files/manager', surface: 'xpanel' }))
      .toEqual([v2ViewStylesheets.unavailable, ...v2StylesheetsForDocument({ route: '/files/manager', surface: 'xpanel' })])
    expect(v2StylesheetsForDocument({})).toEqual([])
  })

  it('covers every current renderer style once without loading unrelated page chunks', () => {
    for (const entry of v2RouteStylesheets) {
      for (const route of entry.routes) {
        const supplements = v2SupplementalStylesheets.filter(extra => extra.surface === entry.surface && extra.routes.includes(route)).map(extra => extra.stylesheet)
        expect(v2StylesheetsForDocument({ surface: entry.surface, route })).toEqual([...entry.dependencies, entry.stylesheet, ...supplements])
        for (const dependency of entry.dependencies) expect(v2Assets).toContain(dependency)
      }
    }
    for (const route of ['/security/ssl/issue/other', '/security/ssl/files/other', '/whm/backups/files/other', '/whm/backups/restore-more/other', '/whm/transfers/convert-addon/other']) {
      expect(v2StylesheetsForDocument({ surface: route.startsWith('/whm/') ? 'xwhm' : 'xpanel', route }), route).toEqual([])
    }
  })

  it('defines light tokens, the dark override and the Arabic font override', () => {
    expect(css).toMatch(/^\[data-ui-theme="v2"\]\{color-scheme:light;/)
    expect(css).toContain('[data-ui-theme="v2"][data-theme="dark"]{color-scheme:dark;')
    expect(css).toContain('[data-ui-theme="v2"]:lang(ar){--font-sans:sans-serif}')
    expect(css).toContain('@media (prefers-reduced-motion:reduce)')
  })
})
