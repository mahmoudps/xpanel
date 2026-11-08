import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * IBM Plex Sans and Mono, served unmodified from the panel's own origin; no font CDN sees the visitor's address and
 * hosts without internet render the same type. Source: github.com/IBM/plex release tags @ibm/plex-sans@1.1.0 and
 * @ibm/plex-mono@1.1.0, files fonts/complete/woff2. SIL Open Font License 1.1 with Reserved Font Name "Plex"
 * (vendor/plex/LICENSE and NOTICE): the license reserves that name for unmodified fonts, so they are never subset.
 * A file that does not match its pinned SHA-256 fails its request instead of serving altered bytes.
 * Arabic text keeps the generic sans-serif family.
 */
const FACES = Object.freeze([
  { family: 'IBM Plex Sans', weight: 400, file: 'IBMPlexSans-Regular.woff2', sha256: 'ba711a3085ff9f27440b6b9c4550cfc47c97bf36591d5da958b975bb3add8c1a' },
  { family: 'IBM Plex Sans', weight: 500, file: 'IBMPlexSans-Medium.woff2', sha256: '5660f8a658f8bb50dbc005232f885eadffd2bc1c235c4f6fbb63469d1f9cde6d' },
  { family: 'IBM Plex Sans', weight: 600, file: 'IBMPlexSans-SemiBold.woff2', sha256: 'f78048030eab62e860efa39a0df79e2e5581bf122eb95b9bc42c0b8a4988d205' },
  { family: 'IBM Plex Sans', weight: 700, file: 'IBMPlexSans-Bold.woff2', sha256: 'fa7130d854a660b39a7fc9e6e0f2dc23dba5f1346e2adea3e1fe37b6d884133d' },
  { family: 'IBM Plex Mono', weight: 400, file: 'IBMPlexMono-Regular.woff2', sha256: '49ce58b41a0e1cb921c0f58d9a5b8b96a2cc21437c7066f3ba4f24873076d131' },
  { family: 'IBM Plex Mono', weight: 500, file: 'IBMPlexMono-Medium.woff2', sha256: '8c2c290cbd998fa1f647e4572aca6ebbd72589551b0f3f9f8bb8628fbb8219d5' },
  { family: 'IBM Plex Mono', weight: 600, file: 'IBMPlexMono-SemiBold.woff2', sha256: 'ed5eaca7522336959d6c3810bd9bb78424f0d964082d581bfbea169ee08d14e3' },
] as const)

const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const href = (file: string, digest: string): string => `/assets/fonts/${file}?v=${digest.slice(0, 16)}`
const STYLESHEET_PATH = '/assets/fonts/plex.css'
// Built from the pinned digests alone, so pages render without touching the font files.
const STYLESHEET = FACES.map(face => `@font-face{font-family:'${face.family}';font-style:normal;font-weight:${face.weight};font-display:swap;src:url(${href(face.file, face.sha256)}) format('woff2')}`).join('\n') + '\n'

/** The one same-origin font stylesheet every theme links; its version follows the font URLs it names. */
export const PLEX_FONTS_STYLESHEET_HREF = `${STYLESHEET_PATH}?v=${sha256(STYLESHEET).slice(0, 16)}`

/** Every path this module serves: the stylesheet and one file per face. */
export const PLEX_FONT_PATHS: readonly string[] = Object.freeze([STYLESHEET_PATH, ...FACES.map(face => `/assets/fonts/${face.file}`)])

type FontAsset = { body: string | Uint8Array<ArrayBuffer>; contentType: string }
const files = new Map<string, FontAsset>()

/** The asset at `path`, read once from the server's own release and checked against its pinned SHA-256. */
export function plexFontAsset(path: string): FontAsset | undefined {
  if (path === STYLESHEET_PATH) return { body: STYLESHEET, contentType: 'text/css; charset=utf-8' }
  const face = FACES.find(entry => `/assets/fonts/${entry.file}` === path)
  if (!face) return undefined
  let asset = files.get(path)
  if (!asset) {
    const body = readFileSync(new URL(`./plex/${face.file}`, import.meta.url))
    if (sha256(body) !== face.sha256) throw new Error(`vendored ${face.file} does not match its pinned SHA-256`)
    files.set(path, asset = { body, contentType: 'font/woff2' })
  }
  return asset
}
