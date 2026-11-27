#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS_JSON_PATH = resolve(ROOT, 'apps/web/src/design-system/tokens.json')
const TOKENS_CSS_PATH = resolve(ROOT, 'apps/web/src/design-system/styles/tokens.css')
const TOKENS_TS_PATH = resolve(ROOT, 'apps/web/src/design-system/tokens.ts')

const COLOR_VAR_MAP = {
  bg: '--bg',
  surface: '--surface',
  subtle: '--subtle',
  sunken: '--sunken',
  line: '--line',
  lineStrong: '--line-strong',
  text: '--text',
  text2: '--text-2',
  muted: '--muted',
  accent: '--accent',
  accentFill: '--accent-fill',
  accentFillHover: '--accent-fill-hover',
  accentSoft: '--accent-soft',
  accentLine: '--accent-line',
  onAccent: '--on-accent',
  ok: '--ok',
  okSoft: '--ok-soft',
  okLine: '--ok-line',
  warn: '--warn',
  warnSoft: '--warn-soft',
  warnLine: '--warn-line',
  bad: '--bad',
  badSoft: '--bad-soft',
  badLine: '--bad-line',
  info: '--info',
  infoSoft: '--info-soft',
  infoLine: '--info-line',
  code: '--code',
  codeText: '--code-text',
  codeMuted: '--code-muted',
  chart2: '--chart-2',
  focus: '--focus',
}

const NAV_VAR_MAP = {
  nav: '--nav',
  nav2: '--nav-2',
  navLine: '--nav-line',
  navText: '--nav-text',
  navMuted: '--nav-muted',
  navStrong: '--nav-strong',
  navOk: '--nav-ok',
  navWarn: '--nav-warn',
  navBad: '--nav-bad',
  navAccent: '--nav-accent',
  navFocus: '--nav-focus',
}

function decls(entries) {
  return entries.map(([k, v]) => `${k}:${v}`).join(';')
}

export function buildTokensCss(tokens) {
  const r = tokens.rootSelector
  const lightEntries = Object.entries(COLOR_VAR_MAP).map(([k, cssVar]) => [cssVar, tokens.colors.light[k]])
  const navWhmEntries = Object.entries(NAV_VAR_MAP).map(([k, cssVar]) => [cssVar, tokens.colors.nav.xwhmLight[k]])
  const lightBlock = `${r}{color-scheme:light;${decls([
    ...lightEntries,
    ...navWhmEntries,
    ['--shadow', tokens.colors.effects.lightShadow],
    ['--scrim', tokens.colors.effects.lightScrim],
    ['--font-sans', tokens.typography.fonts.sansEn],
    ['--font-mono', tokens.typography.fonts.mono],
    ['--lh-body', tokens.typography.lineHeights.bodyRatioEn],
    ['--lh-head', tokens.typography.lineHeights.headRatioEn],
    ['--space-half', tokens.spacing['4']],
    ['--space-1', tokens.spacing['8']],
    ['--space-1-5', tokens.spacing['12']],
    ['--space-2', tokens.spacing['16']],
    ['--space-3', tokens.spacing['24']],
    ['--space-4', tokens.spacing['32']],
    ['--space-6', tokens.spacing['48']],
    ['--space-8', tokens.spacing['64']],
    ['--ds-space-4', tokens.spacing['4']],
    ['--ds-space-8', tokens.spacing['8']],
    ['--ds-space-12', tokens.spacing['12']],
    ['--ds-space-16', tokens.spacing['16']],
    ['--ds-space-24', tokens.spacing['24']],
    ['--ds-space-32', tokens.spacing['32']],
    ['--ds-space-48', tokens.spacing['48']],
    ['--ds-space-64', tokens.spacing['64']],
    ['--radius-card', tokens.radii.card],
    ['--radius-notice', tokens.radii.notice],
    ['--radius-control', tokens.radii.control],
    ['--radius-chip', tokens.radii.chip],
    ['--radius-pill', tokens.radii.pill],
    ['--ds-text-12', tokens.typography.sizes['12']],
    ['--ds-text-13', tokens.typography.sizes['13']],
    ['--ds-text-14', tokens.typography.sizes['14']],
    ['--ds-text-16', tokens.typography.sizes['16']],
    ['--ds-text-20', tokens.typography.sizes['20']],
    ['--ds-text-26', tokens.typography.sizes['26']],
    ['--ds-text-32', tokens.typography.sizes['32']],
    ['--ds-lh-12', tokens.typography.lineHeights.en['12']],
    ['--ds-lh-13', tokens.typography.lineHeights.en['13']],
    ['--ds-lh-14', tokens.typography.lineHeights.en['14']],
    ['--ds-lh-16', tokens.typography.lineHeights.en['16']],
    ['--ds-lh-20', tokens.typography.lineHeights.en['20']],
    ['--ds-lh-26', tokens.typography.lineHeights.en['26']],
    ['--ds-lh-32', tokens.typography.lineHeights.en['32']],
    ['--dur-press', tokens.motion.durations.press],
    ['--dur-menu', tokens.motion.durations.menu],
    ['--dur-overlay', tokens.motion.durations.overlay],
    ['--ease-out', tokens.motion.easing.standard],
    ['--ds-max-width', tokens.layout.maxContentWidth],
    ['--ds-gutter', tokens.layout.gutter],
    ['--ds-gutter-mobile', tokens.layout.gutterMobile],
    ['--ds-topbar-h', tokens.layout.topbarHeight],
    ['--ds-sidebar-w', tokens.layout.sidebarExpanded],
    ['--ds-sidebar-collapsed-w', tokens.layout.sidebarCollapsed],
    ['--target', tokens.layout.touchTargetMin],
    ['--ds-auth-target', tokens.layout.authInputMin],
  ])}}`

  const workspaceLightNavEntries = Object.entries(NAV_VAR_MAP).map(([k, cssVar]) => [cssVar, tokens.colors.nav.workspaceLight[k]])
  const workspaceLightSelectors = [
    `${r}[data-surface="xpanel"]:not([data-theme="dark"]) .v2-side`,
    `${r}[data-surface="xmail"]:not([data-theme="dark"]) .v2-side`,
    `${r}:not([data-theme="dark"]) .v2-shell[data-surface="xpanel"]>.v2-side`,
    `${r}:not([data-theme="dark"]) .v2-shell[data-surface="xmail"]>.v2-side`,
    `${r}:not([data-theme="dark"]) .ds-shell[data-surface="xpanel"]>.ds-sidebar`,
    `${r}:not([data-theme="dark"]) .ds-shell[data-surface="xmail"]>.ds-sidebar`,
  ].join(',')
  const workspaceLightBlock = `${workspaceLightSelectors}{${decls(workspaceLightNavEntries)}}`

  const darkEntries = Object.entries(COLOR_VAR_MAP).map(([k, cssVar]) => [cssVar, tokens.colors.dark[k]])
  const darkNavEntries = Object.entries(NAV_VAR_MAP).map(([k, cssVar]) => [cssVar, tokens.colors.nav.dark[k]])
  const darkBlock = `${r}[data-theme="dark"]{color-scheme:dark;${decls([
    ...darkEntries,
    ...darkNavEntries,
    ['--shadow', tokens.colors.effects.darkShadow],
    ['--scrim', tokens.colors.effects.darkScrim],
  ])}}`

  const arBlock = [
    `${r}:lang(ar){--font-sans:${tokens.typography.fonts.sansAr}}`,
    `${r}:lang(ar){--lh-body:${tokens.typography.lineHeights.bodyRatioAr};--lh-head:${tokens.typography.lineHeights.headRatioAr};--ds-lh-12:${tokens.typography.lineHeights.ar['12']};--ds-lh-13:${tokens.typography.lineHeights.ar['13']};--ds-lh-14:${tokens.typography.lineHeights.ar['14']};--ds-lh-16:${tokens.typography.lineHeights.ar['16']};--ds-lh-20:${tokens.typography.lineHeights.ar['20']};--ds-lh-26:${tokens.typography.lineHeights.ar['26']};--ds-lh-32:${tokens.typography.lineHeights.ar['32']}}`,
    `${r} [lang="ar"]{font-family:${tokens.typography.fonts.sansAr}}`,
  ].join('\n')

  return `${lightBlock}\n${workspaceLightBlock}\n${darkBlock}\n${arBlock}\n`
}

export function buildThemeTokensCss(tokens) {
  const r = tokens.rootSelector
  const lightEntries = Object.entries(COLOR_VAR_MAP)
    .filter(([k]) => !k.startsWith('info'))
    .map(([k, cssVar]) => [cssVar, tokens.colors.light[k]])
  const navWhmEntries = Object.entries(NAV_VAR_MAP).map(([k, cssVar]) => [cssVar, tokens.colors.nav.xwhmLight[k]])
  const lightBlock = `${r}{color-scheme:light;${decls([
    ...lightEntries,
    ...navWhmEntries,
    ['--shadow', tokens.colors.effects.lightShadow],
    ['--scrim', tokens.colors.effects.lightScrim],
    ['--font-sans', tokens.typography.fonts.sansEn],
    ['--font-mono', tokens.typography.fonts.mono],
    ['--lh-body', tokens.typography.lineHeights.bodyRatioEn],
    ['--lh-head', tokens.typography.lineHeights.headRatioEn],
    ['--space-1', tokens.spacing['8']],
    ['--space-2', tokens.spacing['16']],
    ['--space-3', tokens.spacing['24']],
    ['--space-4', tokens.spacing['32']],
    ['--radius-card', tokens.radii.card],
    ['--radius-notice', tokens.radii.notice],
    ['--radius-control', tokens.radii.control],
    ['--radius-chip', tokens.radii.chip],
    ['--radius-pill', tokens.radii.pill],
    ['--target', tokens.layout.touchTargetMin],
  ])}}`

  const darkEntries = Object.entries(COLOR_VAR_MAP)
    .filter(([k]) => !k.startsWith('info'))
    .map(([k, cssVar]) => [cssVar, tokens.colors.dark[k]])
  const darkBlock = `${r}[data-theme="dark"]{color-scheme:dark;${decls([
    ...darkEntries,
    ['--nav', tokens.colors.nav.dark.nav],
    ['--nav-2', tokens.colors.nav.dark.nav2],
    ['--nav-line', tokens.colors.nav.dark.navLine],
    ['--nav-text', tokens.colors.nav.dark.navText],
    ['--nav-muted', tokens.colors.nav.dark.navMuted],
    ['--shadow', tokens.colors.effects.darkShadow],
    ['--scrim', tokens.colors.effects.darkScrim],
  ])}}`

  const arBlock = [
    `${r}:lang(ar){--font-sans:${tokens.typography.fonts.sansAr}}`,
    `${r}:lang(ar){--lh-body:${tokens.typography.lineHeights.bodyRatioAr};--lh-head:${tokens.typography.lineHeights.headRatioAr}}`,
    `${r} [lang="ar"]{font-family:${tokens.typography.fonts.sansAr}}`,
  ].join('\n')

  return `${lightBlock}\n${darkBlock}\n${arBlock}\n`
}

export function buildTokensTs(tokens, css) {
  const themeCss = buildThemeTokensCss(tokens)
  const jsonHash = createHash('sha256').update(JSON.stringify(tokens)).digest('hex').slice(0, 12)
  return `// Generated by scripts/generate-design-tokens.mjs from tokens.json (${jsonHash}).
// Do not edit directly; run: node scripts/generate-design-tokens.mjs --write

export const DESIGN_TOKENS_SOURCE_HASH = '${jsonHash}' as const

export const THEME_ROOT_SELECTOR = ${JSON.stringify(tokens.rootSelector)} as const

export const ALLOWED_SPACING_PX = [${Object.keys(tokens.spacing).join(', ')}] as const
export const ALLOWED_RADII_PX = [8, 12, 999] as const
export const ALLOWED_FONT_SIZES_PX = [${Object.keys(tokens.typography.sizes).join(', ')}] as const

export const DESIGN_TOKENS = ${JSON.stringify(tokens, null, 2)} as const

export type DesignTokens = typeof DESIGN_TOKENS
export type SemanticColorKey = keyof typeof DESIGN_TOKENS.colors.light

export const SEMANTIC_LIGHT_COLORS = DESIGN_TOKENS.colors.light
export const SEMANTIC_DARK_COLORS = DESIGN_TOKENS.colors.dark
export const SIDEBAR_NAV_COLORS = DESIGN_TOKENS.colors.nav

export const DESIGN_TOKENS_CSS = ${JSON.stringify(css)}
export const DESIGN_THEME_TOKENS_CSS = ${JSON.stringify(themeCss)}
`
}

function main() {
  const mode = process.argv.includes('--check') ? 'check' : 'write'
  const rawJson = readFileSync(TOKENS_JSON_PATH, 'utf8')
  const tokens = JSON.parse(rawJson)
  const expectedCss = buildTokensCss(tokens)
  const expectedTs = buildTokensTs(tokens, expectedCss)

  if (mode === 'check') {
    let actualCss = ''
    let actualTs = ''
    try {
      actualCss = readFileSync(TOKENS_CSS_PATH, 'utf8')
      actualTs = readFileSync(TOKENS_TS_PATH, 'utf8')
    } catch {
      console.error('Generated token files are missing. Run: node scripts/generate-design-tokens.mjs --write')
      process.exit(1)
    }
    if (actualCss !== expectedCss || actualTs !== expectedTs) {
      console.error('Generated token files are out of date with tokens.json. Run: node scripts/generate-design-tokens.mjs --write')
      process.exit(1)
    }
    console.log('Design tokens are in sync with tokens.json.')
    return
  }

  mkdirSync(dirname(TOKENS_CSS_PATH), { recursive: true })
  writeFileSync(TOKENS_CSS_PATH, expectedCss, 'utf8')
  writeFileSync(TOKENS_TS_PATH, expectedTs, 'utf8')
  console.log('Generated apps/web/src/design-system/styles/tokens.css and apps/web/src/design-system/tokens.ts')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
