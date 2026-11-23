#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS_JSON_PATH = resolve(ROOT, 'apps/web/src/design-system/tokens.json')

const RATCHET_LIMITS = {
  notReadMax: 1002,
  notObservedMax: 32,
  importantMax: 456,
  inlineStyleMax: 841,
  rawHexFilesMax: 419,
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

    const base = rel.split('/').pop().replace(/\.(?:ts|css|json)$/, '')
    if (inStrictZone && FORBIDDEN_NAMING_RE.test(base)) {
      findings.metrics.namingViolations++
      findings.violations.push({ gate: 'G6', file: rel, detail: `Forbidden identifier/filename: ${base}` })
    }

    const notRead = (text.match(/\bNot read\b/g) ?? []).length
    const notObs = (text.match(/\bNot observed\b/g) ?? []).length
    const imp = (text.match(/!important/g) ?? []).length
    const inStyle = (text.match(/\bstyle="/g) ?? []).length
    findings.metrics.notReadCount += notRead
    findings.metrics.notObservedCount += notObs
    findings.metrics.importantCount += imp
    findings.metrics.inlineStyleCount += inStyle

    if (inStrictZone) {
      if (notRead > 0 || notObs > 0) {
        findings.violations.push({ gate: 'G4', file: rel, detail: `Found Not read (${notRead}) / Not observed (${notObs})` })
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

  findings.gates = {
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

export async function runBrowserGates({
  baseUrl,
  routes,
  baselinesDir,
  updateBaselines = false,
  outputDir,
  strictG16 = true,
}) {
  const { chromium } = await import('@playwright/test')
  const { PNG } = await import('pngjs')
  const { default: pixelmatch } = await import('pixelmatch')
  const axeSource = readFileSync(resolve(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8')

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
    for (const route of routes) {
      for (const mode of modes) {
        const context = await browser.newContext({
          viewport: { width: mode.width, height: mode.height },
          colorScheme: mode.theme,
        })
        const page = await context.newPage()
        const consoleErrors = []
        const pageErrors = []
        const failedRequests = []
        let authMeRequests = 0

        page.on('console', msg => {
          if (msg.type() === 'error') consoleErrors.push(msg.text())
        })
        page.on('pageerror', err => pageErrors.push(err.message))
        page.on('request', req => {
          if (new URL(req.url()).pathname === '/api/auth/me') authMeRequests++
        })
        page.on('requestfailed', req => failedRequests.push(`${req.method()} ${req.url()}`))

        const sep = route.includes('?') ? '&' : '?'
        const targetUrl = `${baseUrl}${route}${sep}lang=${mode.locale}&theme=${mode.theme}`
        const t0 = Date.now()
        const response = await page.goto(targetUrl, { waitUntil: 'networkidle' })
        const loadMs = Date.now() - t0
        await page.evaluate(() => document.fonts.ready)

        await page.addScriptTag({ content: axeSource })
        const domAudit = await page.evaluate(async () => {
          const bodyText = document.body.innerText ?? ''
          const hasNotRead = /\bNot (?:read|observed)\b/i.test(bodyText)
          const hasNonAsciiDigits = /[\u0660-\u0669\u06F0-\u06F9]/.test(bodyText)
          const hasRawSeconds = /\b\d+\s+seconds\b/i.test(bodyText)
          const rawRouteHeader = Array.from(document.querySelectorAll('.ds-page-head, .v2-page-head'))
            .some(h => /(?:^|\s)\/(?:whm|home|mail|domains|files|security|software|databases)\b/.test(h.textContent ?? ''))

          const h1s = Array.from(document.querySelectorAll('h1')).map(el => el.textContent?.trim() ?? '')
          const activeNav = Array.from(document.querySelectorAll('a[aria-current="page"]')).map(el => el.textContent?.trim() ?? '')
          const crumbs = Array.from(document.querySelectorAll('.ds-page-head__breadcrumbs li:last-child, [aria-label="Breadcrumb"] li:last-child'))
            .map(el => el.textContent?.trim() ?? '')

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
          const smallTargets = window.innerWidth <= 500
            ? Array.from(document.querySelectorAll('button,a.ds-btn,a.v2-btn,.ds-nav-link,input:not([type="hidden"]),select'))
              .filter(el => {
                const r = el.getBoundingClientRect()
                const s = getComputedStyle(el)
                return r.width > 0 && r.height > 0 && s.visibility === 'visible' && !el.closest('[hidden]') && (r.width < 43.5 || r.height < 43.5)
              })
              .map(el => `${el.tagName}#${el.id || el.className}:${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`)
            : []

          const hasTablist = Boolean(document.querySelector('[role="tablist"]'))
          const maxScreens = hasTablist ? 20 : 4
          const tooTall = document.documentElement.scrollHeight > window.innerHeight * maxScreens
          const tableRows = Array.from(document.querySelectorAll('table tbody')).map(tb => tb.querySelectorAll('tr').length)
          const oversizedTable = tableRows.some(count => count > 25)

          const axe = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })
          const axeSerious = axe.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')

          return {
            hasNotRead,
            hasNonAsciiDigits,
            hasRawSeconds,
            rawRouteHeader,
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
        })

        const gates = {
          G2: domAudit.h1s.length === 1 && (!domAudit.activeNav.length || domAudit.activeNav.includes(domAudit.h1s[0])),
          G3: domAudit.h1s.length === 1 && !domAudit.rawRouteHeader,
          G4: !domAudit.hasNotRead,
          G5: !domAudit.hasNonAsciiDigits && !domAudit.hasRawSeconds,
          G7: !domAudit.oversizedTable && !domAudit.tooTall,
          G11: !domAudit.overflowX && domAudit.smallTargets.length === 0,
          G12: domAudit.axeViolations.length === 0,
          G13: domAudit.dupIds.length === 0 && !domAudit.skippedHeading && domAudit.unlabeledInputs.length === 0,
          G14: response?.status() === 200 && loadMs < 1500 && consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0 && authMeRequests <= 1,
          G16: true,
        }

        if (baselinesDir) {
          const slug = route.replaceAll('/', '_').replace(/^_+/, '') || 'root'
          const fileName = `${slug}__${mode.key}.png`
          const baselinePath = resolve(baselinesDir, fileName)
          const shot = await page.screenshot({ fullPage: true })
          if (outputDir) writeFileSync(resolve(outputDir, 'screenshots', fileName), shot)
          if (updateBaselines || !existsSync(baselinePath)) {
            writeFileSync(baselinePath, shot)
          } else if (strictG16) {
            const imgA = PNG.sync.read(readFileSync(baselinePath))
            const imgB = PNG.sync.read(shot)
            if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
              gates.G16 = false
            } else {
              const diffPixels = pixelmatch(imgA.data, imgB.data, null, imgA.width, imgA.height, { threshold: 0.1 })
              const ratio = diffPixels / (imgA.width * imgA.height)
              gates.G16 = ratio < 0.001
            }
          }
        }

        const failedGates = Object.entries(gates).filter(([, ok]) => !ok).map(([g]) => g)
        report.routes.push({ route, mode: mode.key, status: response?.status() ?? 0, loadMs, authMeRequests, gates, domAudit })
        if (failedGates.length) {
          report.failures.push({ route, mode: mode.key, failedGates, audit: { ...domAudit, consoleErrors, pageErrors } })
        }
        await context.close()
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
    const updateBaselines = args.includes('--update-baselines')
    const result = await runBrowserGates({
      baseUrl,
      routes: routesRaw.split(',').map(s => s.trim()).filter(Boolean),
      baselinesDir,
      updateBaselines,
      outputDir,
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
