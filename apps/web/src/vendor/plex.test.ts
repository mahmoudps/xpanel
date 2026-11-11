import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { renderWebApp, serveStaticAsset } from '../app.ts'
import { PLEX_FONT_PATHS, PLEX_FONTS_STYLESHEET_HREF, plexFontAsset } from './plex.ts'

const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const stylesheet = plexFontAsset('/assets/fonts/plex.css')!.body as string

describe('self-hosted IBM Plex fonts', () => {
  it('declares one swap face per shipped weight, each from the panel origin and versioned by its bytes', () => {
    expect(PLEX_FONTS_STYLESHEET_HREF).toBe(`/assets/fonts/plex.css?v=${sha256(stylesheet).slice(0, 16)}`)
    const faces = [...stylesheet.matchAll(/@font-face\{([^}]*)\}/g)].map(match => match[1]!)
    expect(faces.map(face => `${/font-family:'([^']+)'/.exec(face)?.[1]} ${/font-weight:(\d+)/.exec(face)?.[1]}`)).toEqual([
      'IBM Plex Sans 400', 'IBM Plex Sans 500', 'IBM Plex Sans 600', 'IBM Plex Sans 700',
      'IBM Plex Sans Arabic 400', 'IBM Plex Sans Arabic 500', 'IBM Plex Sans Arabic 600', 'IBM Plex Sans Arabic 700',
      'IBM Plex Mono 400', 'IBM Plex Mono 500', 'IBM Plex Mono 600',
    ])
    for (const face of faces) {
      expect(face).toContain('font-style:normal;')
      expect(face).toContain('font-display:swap;')
      const href = /src:url\(([^)]+)\) format\('woff2'\)$/.exec(face)?.[1] ?? ''
      expect(href).toMatch(/^\/assets\/fonts\/IBMPlex(?:Sans(?:Arabic)?|Mono)-(?:Regular|Medium|SemiBold|Bold)\.woff2\?v=[a-f0-9]{16}$/)
      const [path, version] = href.split('?v=') as [string, string]
      expect(version).toBe(sha256(plexFontAsset(path)!.body).slice(0, 16))
    }
    expect(stylesheet).not.toMatch(/https?:|\/\/|local\(|@import|unicode-range/)
    expect(PLEX_FONT_PATHS).toHaveLength(12)
    expect(plexFontAsset('/assets/fonts/IBMPlexMono-Bold.woff2')).toBeUndefined()
  })

  it('serves the unmodified font files and the stylesheet with an immutable cache', async () => {
    for (const path of PLEX_FONT_PATHS) {
      const asset = plexFontAsset(path)!
      const response = serveStaticAsset(path)!
      expect(response.status, path).toBe(200)
      expect(response.headers.get('content-type')).toBe(path.endsWith('.woff2') ? 'font/woff2' : 'text/css; charset=utf-8')
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      const bytes = new Uint8Array(await response.arrayBuffer())
      expect(sha256(bytes), path).toBe(sha256(asset.body))
      if (path.endsWith('.woff2')) expect(Buffer.from(bytes.subarray(0, 4)).toString('latin1')).toBe('wOF2')
    }
    expect(serveStaticAsset('/assets/fonts/IBMPlexMono-Bold.woff2')!.status).toBe(404)
  })

  it('links only the same-origin font stylesheet from both themes, with no font CDN or preconnect', () => {
    for (const uiTheme of ['classic', 'v2']) {
      for (const html of [
        renderWebApp({ surface: 'login', locale: 'en', uiTheme, login: { audience: 'xpanel' } }),
        renderWebApp({ surface: 'xwhm', locale: 'ar', uiTheme, activeRoute: '/whm' }),
      ]) {
        const head = html.slice(0, html.indexOf('</head>'))
        expect(head.split(PLEX_FONTS_STYLESHEET_HREF), uiTheme).toHaveLength(2)
        expect(html, uiTheme).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|rel="preconnect"/)
        expect(head, uiTheme).not.toMatch(/<(?:link|script)\b[^>]*\b(?:href|src)="(?:https?:)?\/\//)
      }
    }
  })
})
