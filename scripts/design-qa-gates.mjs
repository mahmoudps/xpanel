#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectTestScript, recordCspViolations } from '../tests/browser/csp-violations.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS_JSON_PATH = resolve(ROOT, 'apps/web/src/design-system/tokens.json')

const RATCHET_LIMITS = {
  notReadMax: 560,
  notObservedMax: 25,
  importantMax: 456,
  inlineStyleMax: 825,
}

const PHYSICAL_CSS_PROP = /(?:^|[{;])\s*(?:margin|padding|border)-(?:left|right)\s*:|(?:^|[{;])\s*(?:left|right)\s*:|text-align\s*:\s*(?:left|right)\b/i
const HEX_COLOR_RE = /(?<!&)#[0-9a-fA-F]{3,8}\b/g
const FORBIDDEN_PLACEHOLDER_RE = /\bNot (?:read|observed)\b/g
const FORBIDDEN_NAMING_RE = /(?:^|[_-])(smart|legacy|hero|magic|super|v[0-9]+)(?:$|[_-])/i

function walkFiles(dir, predicate) {
  if (!existsSync(dir)) return []
  const results = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) results.push(...walkFiles(full, predicate))
    else if (predicate(full, entry.name)) results.push(full)
  }
  return results
}

export function scanStaticDesignCompliance(options = {}) {
  const root = options.root ? resolve(options.root) : ROOT
  const scope = options.scope ?? 'ratchet'
  const tokens = JSON.parse(readFileSync(resolve(root, 'apps/web/src/design-system/tokens.json'), 'utf8'))

  const findings = {
    scope,
    gates: {},
    metrics: {
      notReadCount: 0,
      notObservedCount: 0,
      importantCount: 0,
      inlineStyleCount: 0,
      rawHexCount: 0,
      physicalCssViolations: 0,
      namingViolations: 0,
      rawSecondsConcatCount: 0,
    },
    violations: [],
  }

  const strictRoots = [
    resolve(root, 'apps/web/src/design-system'),
    resolve(root, 'apps/web/src/data'),
    resolve(root, 'apps/web/src/features'),
  ]
  const webSrcRoot = resolve(root, 'apps/web/src')
  const inspectFiles = scope === 'design-system'
    ? strictRoots.flatMap(dir => walkFiles(dir, (_p, name) => /\.(?:ts|css)$/.test(name) && !name.endsWith('.test.ts')))
    : walkFiles(webSrcRoot, (_p, name) => /\.(?:ts|css)$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('-fixture.ts'))

  for (const file of inspectFiles) {
    const rel = relative(root, file).replaceAll('\\', '/')
    const text = readFileSync(file, 'utf8')
    const inStrictZone = rel.startsWith('apps/web/src/design-system/')
      || rel.startsWith('apps/web/src/data/')
      || rel.startsWith('apps/web/src/features/')
    const inV2SurfaceZone = rel.startsWith('apps/web/src/themes/v2/pages/')
      || rel === 'apps/web/src/themes/v2/tool-card-view.ts'

    const base = rel.split('/').pop().replace(/\.(?:ts|css|json)$/, '')
    if (inStrictZone && FORBIDDEN_NAMING_RE.test(base)) {
      findings.metrics.namingViolations++
      findings.violations.push({ gate: 'G6', file: rel, detail: `Forbidden identifier/filename: ${base}` })
    }

    const notRead = (text.match(/\bNot read\b/g) ?? []).length
    const notObs = (text.match(/\bNot observed\b/g) ?? []).length
    const imp = (text.match(/!important/g) ?? []).length
    const inStyle = (text.match(/\bstyle="/g) ?? []).length
    const rawSec = (text.match(/\$\{[^}]+\}\s+seconds\b/g) ?? []).length
    findings.metrics.notReadCount += notRead
    findings.metrics.notObservedCount += notObs
    findings.metrics.importantCount += imp
    findings.metrics.inlineStyleCount += inStyle
    findings.metrics.rawSecondsConcatCount += rawSec

    if (inV2SurfaceZone) {
      if (notRead > 0 || notObs > 0) {
        findings.violations.push({ gate: 'G4', file: rel, detail: `v2 surface contains Not read (${notRead}) / Not observed (${notObs})` })
      }
      if (inStyle > 0) {
        findings.violations.push({ gate: 'G6', file: rel, detail: `v2 surface contains ${inStyle} inline style= attribute(s)` })
      }
    }

    if (inStrictZone) {
      if (notRead > 0 || notObs > 0) {
        findings.violations.push({ gate: 'G4', file: rel, detail: `Found Not read (${notRead}) / Not observed (${notObs})` })
      }
      if (rawSec > 0) {
        findings.violations.push({ gate: 'G5', file: rel, detail: `Found ${rawSec} interpolated raw seconds string(s)` })
      }
      if (imp > 0) {
        findings.violations.push({ gate: 'G6', file: rel, detail: `Found ${imp} !important declaration(s)` })
      }
      if (inStyle > 0) {
        findings.violations.push({ gate: 'G6', file: rel, detail: `Found ${inStyle} inline style= attribute(s)` })
      }
      if (rel !== 'apps/web/src/design-system/styles/tokens.css' && rel !== 'apps/web/src/design-system/tokens.ts') {
        const hexMatches = text.match(HEX_COLOR_RE) ?? []
        if (hexMatches.length > 0) {
          findings.metrics.rawHexCount += hexMatches.length
          findings.violations.push({ gate: 'G6', file: rel, detail: `Raw hex colors outside tokens.json: ${hexMatches.slice(0, 5).join(', ')}` })
        }
      }
      if (rel.endsWith('.css') && PHYSICAL_CSS_PROP.test(text)) {
        findings.metrics.physicalCssViolations++
        findings.violations.push({ gate: 'G8', file: rel, detail: 'Physical directional CSS property detected' })
      }
    }
  }

  // Gate summaries
  const semanticColorCount = Object.keys(tokens.colors.light).length
  const allowedSpaces = Object.keys(tokens.spacing).map(Number)
  const validScales =
    JSON.stringify(allowedSpaces) === JSON.stringify([4, 8, 12, 16, 24, 32, 48, 64])
    && tokens.radii.control === '8px'
    && tokens.radii.card === '12px'
    && tokens.radii.pill === '999px'
    && semanticColorCount <= 35

  if (!validScales) {
    findings.violations.push({ gate: 'G6', file: 'apps/web/src/design-system/tokens.json', detail: 'Token scales or semantic color cap violated' })
  }

  if (scope === 'strict') {
    if (findings.metrics.notReadCount > 0 || findings.metrics.notObservedCount > 0) {
      findings.violations.push({ gate: 'G4', file: 'apps/web/src', detail: `Repo Not read/Not observed count non-zero (${findings.metrics.notReadCount}/${findings.metrics.notObservedCount})` })
    }
    if (findings.metrics.importantCount > 0) {
      findings.violations.push({ gate: 'G6', file: 'apps/web/src', detail: `Repo !important count non-zero (${findings.metrics.importantCount})` })
    }
    if (findings.metrics.inlineStyleCount > 0) {
      findings.violations.push({ gate: 'G6', file: 'apps/web/src', detail: `Repo inline style= count non-zero (${findings.metrics.inlineStyleCount})` })
    }
  } else if (scope === 'ratchet') {
    if (findings.metrics.notReadCount > RATCHET_LIMITS.notReadMax) {
      findings.violations.push({ gate: 'G4', file: 'apps/web/src', detail: `Not read exceeded ratchet (${findings.metrics.notReadCount} > ${RATCHET_LIMITS.notReadMax})` })
    }
    if (findings.metrics.notObservedCount > RATCHET_LIMITS.notObservedMax) {
      findings.violations.push({ gate: 'G4', file: 'apps/web/src', detail: `Not observed exceeded ratchet (${findings.metrics.notObservedCount} > ${RATCHET_LIMITS.notObservedMax})` })
    }
    if (findings.metrics.importantCount > RATCHET_LIMITS.importantMax) {
      findings.violations.push({ gate: 'G6', file: 'apps/web/src', detail: `!important exceeded ratchet (${findings.metrics.importantCount} > ${RATCHET_LIMITS.importantMax})` })
    }
    if (findings.metrics.inlineStyleCount > RATCHET_LIMITS.inlineStyleMax) {
      findings.violations.push({ gate: 'G6', file: 'apps/web/src', detail: `style= exceeded ratchet (${findings.metrics.inlineStyleCount} > ${RATCHET_LIMITS.inlineStyleMax})` })
    }
  }

  const navDataPath = resolve(root, 'packages/catalog/src/data/navigation.ts')
  const navApiPath = resolve(root, 'packages/catalog/src/navigation.ts')
  if (existsSync(navDataPath) && existsSync(navApiPath)) {
    const rawNav = readFileSync(navDataPath, 'utf8')
    const eq = rawNav.indexOf('= [')
    const parsedNav = eq >= 0 ? JSON.parse(rawNav.slice(eq + 2, rawNav.lastIndexOf(']') + 1)) : []
    const xwhm = parsedNav.find(s => s.surface === 'xwhm')
    const expectedOrder = ['home', 'accounts', 'domains', 'email', 'databases', 'software', 'services', 'security', 'backups', 'monitoring', 'server', 'panel']
    const actualOrder = (xwhm?.sections ?? []).map(s => s.id)
    if (JSON.stringify(actualOrder) !== JSON.stringify(expectedOrder)) {
      findings.violations.push({ gate: 'G1', file: 'packages/catalog/src/data/navigation.ts', detail: `xWHM section order/count mismatch: ${actualOrder.join(',')}` })
    }
    for (const surface of parsedNav) {
      for (const sec of surface.sections) {
        if (sec.pages.length > 12) {
          findings.violations.push({ gate: 'G1', file: 'packages/catalog/src/data/navigation.ts', detail: `${surface.surface}:${sec.id} exceeds 12 pages (${sec.pages.length})` })
        }
        for (const page of sec.pages) {
          if (page.id.endsWith('-more') || page.route.endsWith('/more') || page.route.endsWith('/restore-more')) {
            findings.violations.push({ gate: 'G1', file: 'packages/catalog/src/data/navigation.ts', detail: `Folded -more page still canonical: ${page.route}` })
          }
        }
      }
    }
    const navApiSrc = readFileSync(navApiPath, 'utf8')
    if (!navApiSrc.includes('CATALOG_PAGE_DISPOSITIONS')) {
      findings.violations.push({ gate: 'G1', file: 'packages/catalog/src/navigation.ts', detail: 'Missing CATALOG_PAGE_DISPOSITIONS registry' })
    }
  }

  const pagesRoot = resolve(root, 'apps/web/src/themes/v2/pages')
  if (existsSync(pagesRoot)) {
    const pageFiles = walkFiles(pagesRoot, (_p, name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    for (const file of pageFiles) {
      const rel = relative(root, file).replaceAll('\\', '/')
      const text = readFileSync(file, 'utf8')
      if (rel === 'apps/web/src/themes/v2/pages/xpanel/home.ts' && /route:\s*'\/home'[^}]*Welcome back/.test(text)) {
        findings.violations.push({ gate: 'G2', file: rel, detail: '/home pageHeader title drifts from canonical navName ("Home")' })
      }
      if (rel === 'apps/web/src/themes/v2/pages/xwhm/overview/index.ts' && /breadcrumb:\s*\[\s*\{\s*label:\s*t\('Home'\)\s*\}\s*,\s*\{\s*label:\s*t\('Dashboard'\)\s*\}\s*\]/.test(text)) {
        findings.violations.push({ gate: 'G2', file: rel, detail: '/whm pageHeader breadcrumb drifts from canonical navName ("Server dashboard")' })
      }
    }
  }

  findings.gates = {
    G1: !findings.violations.some(v => v.gate === 'G1'),
    G2: !findings.violations.some(v => v.gate === 'G2'),
    G4: !findings.violations.some(v => v.gate === 'G4'),
    G6: !findings.violations.some(v => v.gate === 'G6'),
    G8: !findings.violations.some(v => v.gate === 'G8'),
  }
  findings.passed = findings.violations.length === 0
  return findings
}

export function classifySpacingScale(pxValues, allowed = [0, 4, 8, 12, 16, 24, 32, 48, 64]) {
  const offScale = pxValues.filter(px => !allowed.includes(Math.round(px)))
  return { valid: offScale.length === 0, offScale }
}

export function pickEffectiveTouchTarget(selfRect, labelRects = []) {
  const candidates = [selfRect, ...labelRects].filter(
    r => r && Number.isFinite(r.width) && Number.isFinite(r.height) && r.width > 0 && r.height > 0,
  )
  if (!candidates.length) return null
  const passing = candidates.find(r => r.width >= 43.5 && r.height >= 43.5)
  if (passing) return passing
  return candidates.reduce((best, r) => (Math.min(r.width, r.height) > Math.min(best.width, best.height) ? r : best))
}

export function evaluateVisualBaseline({
  baselinePath,
  screenshotBuffer,
  updateBaselines = false,
  strictG16 = true,
  pngModule,
  pixelmatchFn,
}) {
  if (!baselinePath) {
    if (updateBaselines) {
      return { passed: false, status: 'missing-baselines-dir' }
    }
    return { passed: !strictG16, status: strictG16 ? 'missing-baselines-dir' : 'skipped' }
  }
  if (updateBaselines) {
    mkdirSync(dirname(baselinePath), { recursive: true })
    writeFileSync(baselinePath, screenshotBuffer)
    return { passed: true, status: 'updated' }
  }
  if (!existsSync(baselinePath)) {
    return { passed: !strictG16, status: 'missing-baseline' }
  }
  if (!strictG16) {
    return { passed: true, status: 'skipped' }
  }
  const imgA = pngModule.sync.read(readFileSync(baselinePath))
  const imgB = pngModule.sync.read(screenshotBuffer)
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    return { passed: false, status: 'size-mismatch', ratio: 1 }
  }
  const diffPixels = pixelmatchFn(imgA.data, imgB.data, null, imgA.width, imgA.height, { threshold: 0.1 })
  const ratio = diffPixels / (imgA.width * imgA.height)
  return { passed: ratio < 0.001, status: ratio < 0.001 ? 'matched' : 'pixel-mismatch', ratio }
}

export function buildAuditUrl(baseUrl, route, locale, theme) {
  const url = new URL(route, baseUrl)
  url.searchParams.set('lang', locale)
  url.searchParams.set('theme', theme)
  return url.toString()
}

export function checkRouteNavigation({ expectedRoute, baseUrl, finalUrl, status }) {
  const expectedPath = new URL(expectedRoute, baseUrl).pathname
  const actualPath = new URL(finalUrl, baseUrl).pathname
  const unexpectedRedirect = actualPath !== expectedPath
  return {
    expectedPath,
    actualPath,
    unexpectedRedirect,
    ok: status === 200 && !unexpectedRedirect,
  }
}

async function authenticateContext(browser, baseUrl, credentials) {
  const authContext = await browser.newContext()
  try {
    const page = await authContext.newPage()
    const loginUrl = new URL(credentials.loginPath ?? '/login', baseUrl).toString()
    await page.goto(loginUrl, { waitUntil: 'networkidle' })
    await page.locator('#login-username').fill(credentials.username)
    await page.locator('#login-password').fill(credentials.password)
    const responsePromise = page.waitForResponse(res => {
      try {
        return new URL(res.url()).pathname === '/api/auth/login' && res.request().method() === 'POST'
      } catch {
        return false
      }
    })
    await page.locator('[data-login-form] button[type="submit"], [data-login-form] [type="submit"]').first().click()
    const loginResponse = await responsePromise
    if (loginResponse.status() !== 200) {
      throw new Error(`Authentication failed for browser design gates (status ${loginResponse.status()})`)
    }
    await page.waitForLoadState('networkidle')
    return await authContext.storageState()
  } finally {
    await authContext.close()
  }
}

export async function runBrowserGates({
  baseUrl,
  routes,
  baselinesDir,
  updateBaselines = false,
  outputDir,
  strictG16 = true,
  storageState,
  credentials,
}) {
  if (updateBaselines && !baselinesDir) {
    throw new Error('--update-baselines requires --baselines=<dir>')
  }
  const { chromium } = await import('@playwright/test')
  const { PNG } = await import('pngjs')
  const { default: pixelmatch } = await import('pixelmatch')
  const axePath = fileURLToPath(import.meta.resolve('axe-core/axe.min.js'))
  const axeSource = readFileSync(axePath, 'utf8')

  if (outputDir) mkdirSync(resolve(outputDir, 'screenshots'), { recursive: true })
  if (baselinesDir) mkdirSync(baselinesDir, { recursive: true })

  const modes = ['en', 'ar'].flatMap(locale =>
    ['light', 'dark'].flatMap(theme =>
      [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'mobile', width: 390, height: 844 },
      ].map(vp => ({ locale, theme, ...vp, key: `${vp.name}-${locale}-${theme}` })),
    ),
  )

  const browser = await chromium.launch({ headless: true })
  const report = { baseUrl, checkedAt: new Date().toISOString(), routes: [], failures: [] }

  try {
    let resolvedStorageState = storageState
    if (!resolvedStorageState && credentials?.username && credentials?.password) {
      resolvedStorageState = await authenticateContext(browser, baseUrl, credentials)
    }

    for (const route of routes) {
      for (const mode of modes) {
        const context = await browser.newContext({
          viewport: { width: mode.width, height: mode.height },
          colorScheme: mode.theme,
          ...(resolvedStorageState ? { storageState: resolvedStorageState } : {}),
        })
        try {
          const page = await context.newPage()
          const consoleErrors = []
          const pageErrors = []
          const cspViolations = []
          const failedRequests = []
          const httpErrors = []
          let authMeRequests = 0

          await recordCspViolations(page, cspViolations)
          await page.addInitScript(() => {
            window.__xpanelCls = 0
            if (typeof PerformanceObserver === 'function') {
              try {
                new PerformanceObserver((list) => {
                  for (const entry of list.getEntries()) {
                    if (!entry.hadRecentInput) window.__xpanelCls += entry.value
                  }
                }).observe({ type: 'layout-shift', buffered: true })
              } catch {}
            }
          })
          page.on('console', msg => {
            if (msg.type() === 'error') consoleErrors.push(msg.text())
          })
          page.on('pageerror', err => pageErrors.push(err.message))
          page.on('request', req => {
            if (new URL(req.url()).pathname === '/api/auth/me') authMeRequests++
          })
          page.on('response', res => {
            if (res.status() >= 400 && new URL(res.url()).pathname.startsWith('/api/')) {
              httpErrors.push(`${res.status()} ${res.url()}`)
            }
          })
          page.on('requestfailed', req => failedRequests.push(`${req.method()} ${req.url()}`))

          const targetUrl = buildAuditUrl(baseUrl, route, mode.locale, mode.theme)
          const t0 = Date.now()
          const response = await page.goto(targetUrl, { waitUntil: 'networkidle' })
          const loadMs = Date.now() - t0
          await page.evaluate(() => document.fonts.ready)

          const navCheck = checkRouteNavigation({
            expectedRoute: route,
            baseUrl,
            finalUrl: page.url(),
            status: response?.status() ?? 0,
          })
          if (navCheck.unexpectedRedirect) {
            const failGates = { G14: false, ...(strictG16 ? { G16: false } : {}) }
            report.routes.push({
              route,
              mode: mode.key,
              status: response?.status() ?? 0,
              loadMs,
              authMeRequests,
              unexpectedRedirect: true,
              expectedPath: navCheck.expectedPath,
              actualPath: navCheck.actualPath,
              visualStatus: 'unexpected-redirect',
              gates: failGates,
              domAudit: null,
            })
            report.failures.push({
              route,
              mode: mode.key,
              failedGates: Object.keys(failGates),
              audit: {
                unexpectedRedirect: true,
                expectedPath: navCheck.expectedPath,
                actualPath: navCheck.actualPath,
                consoleErrors,
                pageErrors,
                cspViolations,
              },
            })
            continue
          }

          await injectTestScript(page, axeSource)
          await page.keyboard.press('Tab').catch(() => {})
          const domAudit = await page.evaluate(async (modeArg) => {
            const bodyText = document.body.innerText ?? ''
            const hasNotRead = /\bNot (?:read|observed)\b|غير مقروء/i.test(bodyText)
            const hasNonAsciiDigits = /[\u0660-\u0669\u06F0-\u06F9]/.test(bodyText)
            const hasRawSeconds = Array.from(document.querySelectorAll('td, dd, [data-ds-metric], [data-ds-duration]'))
              .some(el => /^\d+\s+seconds$/i.test(el.textContent?.trim() ?? ''))
            const hasRawIsoTimestamp = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/.test(bodyText)
            const rawRouteHeader = Array.from(document.querySelectorAll('.ds-page-head, .v2-page-head'))
              .some(h => /(?:^|\s)\/(?:whm|home|mail|domains|files|security|software|databases)\b/.test(h.textContent ?? ''))

            const html = document.documentElement
            const modeMatch = html.lang === modeArg.locale
              && html.dir === (modeArg.locale === 'ar' ? 'rtl' : 'ltr')
              && (html.dataset.theme ? html.dataset.theme === modeArg.theme : true)

            const h1s = Array.from(document.querySelectorAll('h1')).map(el => el.textContent?.trim() ?? '')
            const activeNav = Array.from(document.querySelectorAll('a[aria-current="page"]')).map(el => el.textContent?.trim() ?? '')
            const crumbs = Array.from(document.querySelectorAll('.ds-page-head__breadcrumbs li:last-child > span:last-child, .v2-crumbs [aria-current="page"]'))
              .map(el => el.textContent?.trim() ?? '')

            const isDesktop = window.innerWidth >= 1200
            const theadTop = document.querySelector('table thead')?.getBoundingClientRect().top ?? 0
            const firstRowTop = document.querySelector('table tbody tr:not([hidden])')?.getBoundingClientRect().top ?? 0
            const primaryTop = document.querySelector('[data-ds-wizard], .v2-kpi-row')?.getBoundingClientRect().top ?? 0
            const yBudgetViolation = isDesktop && (
              (theadTop > 0 && theadTop > 290)
              || (firstRowTop > 0 && firstRowTop > 340)
              || (primaryTop > 0 && primaryTop > 260)
            )

            const inlineStylesOutsideCharts = Array.from(document.querySelectorAll('main [style]'))
              .filter(el => !el.closest('.v2-chart, .ds-chart'))
              .length
            const arabicFontOk = modeArg.locale !== 'ar' || (html.dir === 'rtl' && /IBM Plex Sans Arabic/i.test(getComputedStyle(document.body).fontFamily))
            const badTimestampCount = Array.from(document.querySelectorAll('[data-ds-ts]'))
              .filter(el => {
                const txt = el.textContent?.trim() ?? ''
                return !txt || /Invalid Date/i.test(txt)
              }).length
            const contradictoryStateCount = document.querySelectorAll('[data-state="loading"] [data-state="ready"], [data-ds-state="loading"] [data-ds-state="ready"]').length

            const ids = Array.from(document.querySelectorAll('[id]')).map(el => el.id)
            const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i)

            const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => Number(h.tagName.slice(1)))
            let skippedHeading = false
            for (let i = 1; i < headings.length; i++) {
              if (headings[i] > headings[i - 1] + 1) skippedHeading = true
            }

            const unlabeledInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]),select,textarea'))
              .filter(el => {
                const s = getComputedStyle(el)
                if (s.display === 'none' || s.visibility === 'hidden') return false
                const hasLabel = (el.labels?.length ?? 0) > 0 || el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')
                return !hasLabel
              })
              .map(el => el.id || el.name || el.tagName)

            const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1
            const labelRectsOf = (el) => {
              if (el.tagName !== 'INPUT' || (el.type !== 'checkbox' && el.type !== 'radio')) return []
              const seen = new Set()
              for (const lbl of Array.from(el.labels ?? [])) seen.add(lbl)
              const parentLabel = el.closest('label')
              if (parentLabel) seen.add(parentLabel)
              const rects = []
              for (const lbl of seen) {
                const ls = getComputedStyle(lbl)
                const lr = lbl.getBoundingClientRect()
                if (ls.display !== 'none' && ls.visibility === 'visible' && !lbl.closest('[hidden]') && lr.width > 0 && lr.height > 0) {
                  rects.push(lr)
                }
              }
              return rects
            }
            const smallTargets = window.innerWidth <= 500
              ? Array.from(document.querySelectorAll('button,a.ds-btn,a.v2-btn,.ds-nav-link,[role="tab"],[role="button"],summary,input:not([type="hidden"]),select'))
                .map(el => {
                  const s = getComputedStyle(el)
                  const r = el.getBoundingClientRect()
                  const selfVisible = r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility === 'visible' && !el.closest('[hidden]')
                  const labelRects = labelRectsOf(el)
                  if (!selfVisible && labelRects.length === 0) return null
                  const candidates = [selfVisible ? r : null, ...labelRects].filter(Boolean)
                  if (candidates.some(c => c.width >= 43.5 && c.height >= 43.5)) return null
                  const best = candidates.reduce((a, b) => (Math.min(b.width, b.height) > Math.min(a.width, a.height) ? b : a))
                  return `${el.tagName}#${el.id || el.className}:${Math.round(best.width)}x${Math.round(best.height)}`
                })
                .filter(Boolean)
              : []

            const hasTablist = Boolean(document.querySelector('[role="tablist"]'))
            const maxScreens = hasTablist ? 20 : 4
            const tooTall = document.documentElement.scrollHeight > window.innerHeight * maxScreens
            const tableRows = Array.from(document.querySelectorAll('table tbody')).map(tb => tb.querySelectorAll('tr:not([hidden])').length)
            const oversizedTable = tableRows.some(count => count > 25)

            const clsScore = Number(window.__xpanelCls ?? 0)
            const hasFocusTarget = Boolean(document.activeElement && document.activeElement !== document.body)

            const axe = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })
            const axeSerious = axe.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')

            return {
              modeMatch,
              hasNotRead,
              hasNonAsciiDigits,
              hasRawSeconds,
              hasRawIsoTimestamp,
              rawRouteHeader,
              yBudgetViolation,
              inlineStylesOutsideCharts,
              arabicFontOk,
              badTimestampCount,
              contradictoryStateCount,
              hasFocusTarget,
              clsScore,
              h1s,
              activeNav,
              crumbs,
              dupIds,
              skippedHeading,
              unlabeledInputs,
              overflowX,
              smallTargets,
              tooTall,
              oversizedTable,
              axeViolations: axeSerious.map(v => `${v.id}:${v.nodes.length}`),
            }
          }, mode)

          const gates = {
            G1: domAudit.h1s.length === 1 && domAudit.modeMatch,
            G2: domAudit.h1s.length === 1
              && (!domAudit.activeNav.length || domAudit.activeNav.includes(domAudit.h1s[0]))
              && (!domAudit.crumbs.length || domAudit.crumbs.includes(domAudit.h1s[0])),
            G3: domAudit.h1s.length === 1 && !domAudit.rawRouteHeader && !domAudit.yBudgetViolation,
            G4: !domAudit.hasNotRead,
            G5: !domAudit.hasNonAsciiDigits && !domAudit.hasRawSeconds && !domAudit.hasRawIsoTimestamp,
            G6: domAudit.inlineStylesOutsideCharts === 0,
            G7: !domAudit.oversizedTable && !domAudit.tooTall,
            G8: domAudit.arabicFontOk && domAudit.modeMatch,
            G9: domAudit.badTimestampCount === 0,
            G10: domAudit.contradictoryStateCount === 0,
            G11: !domAudit.overflowX && domAudit.smallTargets.length === 0,
            G12: domAudit.axeViolations.length === 0 && domAudit.hasFocusTarget,
            G13: domAudit.dupIds.length === 0 && !domAudit.skippedHeading && domAudit.unlabeledInputs.length === 0,
            G14: navCheck.ok && loadMs < 1500 && consoleErrors.length === 0 && pageErrors.length === 0 && cspViolations.length === 0 && failedRequests.length === 0 && httpErrors.length === 0 && authMeRequests <= 1,
            G15: domAudit.clsScore < 0.05,
            G16: true,
          }

          const slug = route.replaceAll('/', '_').replace(/^_+/, '') || 'root'
          const fileName = `${slug}__${mode.key}.png`
          let shot = null
          if (baselinesDir || outputDir) {
            shot = await page.screenshot({ fullPage: true })
            if (outputDir) writeFileSync(resolve(outputDir, 'screenshots', fileName), shot)
          }
          const visualResult = evaluateVisualBaseline({
            baselinePath: baselinesDir ? resolve(baselinesDir, fileName) : null,
            screenshotBuffer: shot,
            updateBaselines,
            strictG16,
            pngModule: PNG,
            pixelmatchFn: pixelmatch,
          })
          gates.G16 = visualResult.passed

          const failedGates = Object.entries(gates).filter(([, ok]) => !ok).map(([g]) => g)
          report.routes.push({ route, mode: mode.key, status: response?.status() ?? 0, loadMs, authMeRequests, visualStatus: visualResult.status, gates, domAudit })
          if (failedGates.length) {
            report.failures.push({ route, mode: mode.key, failedGates, audit: { ...domAudit, consoleErrors, pageErrors, cspViolations } })
          }
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
  }

  report.passed = report.failures.length === 0
  if (outputDir) {
    const outPath = resolve(outputDir, 'report.json')
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
    const digest = createHash('sha256').update(readFileSync(outPath)).digest('hex')
    writeFileSync(resolve(outputDir, 'report.sha256'), `${digest}  report.json\n`)
  }
  return report
}

async function main() {
  const args = process.argv.slice(2)
  const flag = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)

  if (args.includes('--static')) {
    const scope = flag('scope') ?? 'design-system'
    const result = scanStaticDesignCompliance({ scope })
    console.log(JSON.stringify(result, null, 2))
    if (!result.passed) process.exit(1)
    return
  }

  if (args.includes('--browser')) {
    const baseUrl = flag('url') ?? 'http://127.0.0.1:4100'
    const routesRaw = flag('routes') ?? '/home,/whm'
    const baselinesDir = flag('baselines')
    const outputDir = flag('output')
    const storageState = flag('storage-state')
    const loginPath = flag('login-path')
    const envUser = process.env.XPANEL_AUDIT_USER
    const envPass = process.env.XPANEL_AUDIT_PASS
    const credentials = !storageState && envUser && envPass
      ? { username: envUser, password: envPass, ...(loginPath ? { loginPath } : {}) }
      : undefined
    const updateBaselines = args.includes('--update-baselines')
    const strictG16 = !args.includes('--no-strict-g16')
    const result = await runBrowserGates({
      baseUrl,
      routes: routesRaw.split(',').map(s => s.trim()).filter(Boolean),
      baselinesDir,
      updateBaselines,
      outputDir,
      strictG16,
      storageState,
      credentials,
    })
    console.log(JSON.stringify({ passed: result.passed, failureCount: result.failures.length, failures: result.failures }, null, 2))
    if (!result.passed) process.exit(1)
    return
  }

  console.error('Usage: node scripts/design-qa-gates.mjs --static [--scope=design-system|ratchet|strict] | --browser --url=... --routes=...')
  process.exit(2)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
