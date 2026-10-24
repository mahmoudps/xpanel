import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import playwright from '../node_modules/@playwright/test/index.js'
import { qualifyHostTools, tools } from '../packages/catalog/src/index.ts'
import { defaultPlan } from '../packages/core/src/rules/plans.ts'
import { renderWebApp } from '../apps/web/src/app.ts'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const { chromium } = playwright
const root = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(root, '..')
const outDir = process.env.XP_FIDELITY_OUT ?? path.join(repo, '.artifacts', 'board-fidelity-accounts')
const boardFile = process.env.XP_BOARD_FILE
if (!boardFile) throw new Error('Set XP_BOARD_FILE to the exported WhmAccounts.dc.html')
const viewport = { width: 1440, height: 1220 }
const route = '/whm/accounts'
const fixtureUrl = `${route}?fixture=board`
const boardName = path.basename(boardFile)

const plan = defaultPlan({ id: 'fixture-plan', name: 'Business', featureListId: 'fixture-features' })
const account = (id, username, uid, domain, createdAt, status) => ({
  id, username, uid, gid: uid, home: `/home/${username}`, primaryDomain: domain,
  planId: plan.id, ownerId: null, status, suspendReason: status === 'suspended' ? 'billing' : null,
  contactEmail: `ops@${domain}`, ipv4: '192.0.2.21', shell: 'none', createdAt,
})
const catalog = qualifyHostTools(tools, {
  executor: 'linux',
  probes: { 'control-plane': 'passed', 'linux-account': 'passed' },
})
const principal = { kind: 'root', id: 'fixture-root', username: 'root' }
const productHtml = (pad) => {
  let html = renderWebApp({
    surface: 'xwhm',
    locale: 'en',
    theme: 'light',
    activeRoute: route,
    realtimeEnabled: false,
    visibility: { principal },
    catalog,
    whm: {
      principal,
      hostname: 'srv1.xpanel.test',
      version: '1.4.2',
      generationId: 142,
      plans: [plan],
      resellers: [],
      accounts: [
        account('11111111-1111-4111-8111-111111111111', 'lina', 20012, 'lina-bakery.com', '2026-10-22T12:00:00Z', 'active'),
        account('22222222-2222-4222-8222-222222222222', 'nour', 20015, 'nour.dev', '2026-10-21T12:00:00Z', 'suspended'),
      ],
    },
  })
  if (pad) {
    const next = html.replace(
      /(<div class="xp-board-port" data-board-port="xwhm-accounts"[^>]*style=")/,
      '$1padding-top:1px;',
    )
    if (next === html) throw new Error('negative-control target is missing from the product document')
    html = next
  }
  return html
}

const servePages = (pages) => new Promise((resolve) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const html = pages[`${url.pathname}${url.search}`]
    if (!html) {
      res.writeHead(404)
      res.end('missing')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  server.listen(0, '127.0.0.1', () => resolve(server))
})

const serveDir = (dir) => new Promise((resolve) => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const file = path.join(dir, decodeURIComponent(url.pathname === '/' ? `/${boardName}` : url.pathname))
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('missing')
    }
  })
  server.listen(0, '127.0.0.1', () => resolve(server))
})

const assertProduct = async (page) => {
  const facts = await page.evaluate(() => ({
    surface: document.documentElement.getAttribute('data-surface'),
    port: document.querySelector('[data-board-port="xwhm-accounts"][data-product="true"]') ? 'xwhm-accounts' : '',
    dcTpl: document.querySelectorAll('[data-dc-tpl]').length,
    dcRoot: document.getElementById('dc-root') ? 1 : 0,
    scName: document.querySelectorAll('[data-sc-name]').length,
  }))
  if (facts.surface !== 'xwhm' || facts.port !== 'xwhm-accounts' || facts.dcTpl !== 0 || facts.dcRoot !== 0 || facts.scName !== 0) {
    throw new Error(`product DOM assertion failed: ${JSON.stringify(facts)}`)
  }
  return facts
}

const shoot = async (browser, url, product) => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
  await page.goto(url, { waitUntil: 'networkidle' })
  const facts = product ? await assertProduct(page) : null
  await page.evaluate(async () => {
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    document.body.style.webkitFontSmoothing = 'antialiased'
    if (document.fonts) await document.fonts.ready
  })
  await page.waitForTimeout(400)
  const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: viewport.width, height: viewport.height } })
  await page.close()
  return { png, facts }
}

const diffRatio = (left, right) => {
  const a = PNG.sync.read(left)
  const b = PNG.sync.read(right)
  const width = Math.min(a.width, b.width)
  const height = Math.min(a.height, b.height)
  const diff = new PNG({ width, height })
  const mismatched = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1, includeAA: false })
  return { mismatched, total: width * height, ratio: mismatched / (width * height), diff: PNG.sync.write(diff) }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const main = async () => {
  await mkdir(outDir, { recursive: true })
  const boardServer = await serveDir(path.dirname(boardFile))
  const appServer = await servePages({
    [fixtureUrl]: productHtml(false),
    [`${route}?fixture=board&gate=pad`]: productHtml(true),
  })
  const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--font-render-hinting=none', '--disable-lcd-text'] })
  const boardUrl = `http://127.0.0.1:${boardServer.address().port}/${encodeURIComponent(boardName)}`
  const appUrl = `http://127.0.0.1:${appServer.address().port}${fixtureUrl}`
  const padUrl = `http://127.0.0.1:${appServer.address().port}${route}?fixture=board&gate=pad`
  const boardShot = await shoot(browser, boardUrl, false)
  const appShot = await shoot(browser, appUrl, true)
  const padShot = await shoot(browser, padUrl, true)
  const result = diffRatio(boardShot.png, appShot.png)
  const negative = diffRatio(appShot.png, padShot.png)
  await writeFile(path.join(outDir, 'xwhm-accounts-ltr-board.png'), boardShot.png)
  await writeFile(path.join(outDir, 'xwhm-accounts-ltr-app.png'), appShot.png)
  await writeFile(path.join(outDir, 'xwhm-accounts-ltr-diff.png'), result.diff)
  await writeFile(path.join(outDir, 'xwhm-accounts-ltr-negative-diff.png'), negative.diff)
  await browser.close()
  boardServer.close()
  appServer.close()
  const boardSha = sha256(boardShot.png)
  const appSha = sha256(appShot.png)
  if (boardSha === appSha) throw new Error('app PNG is byte-identical to the board PNG')
  if (negative.ratio <= 0) throw new Error('negative control did not change a pixel')
  const row = {
    screen: 'xWHM Accounts',
    dir: 'ltr',
    diff: `${(result.ratio * 100).toFixed(2)}%`,
    mismatched: result.mismatched,
    total: result.total,
    within3pct: result.ratio <= 0.03,
    appUrl: fixtureUrl,
    appDocument: 'renderWebApp({ surface: "xwhm", activeRoute: "/whm/accounts", theme: "light" })',
    boardUrl: `${boardName} served from XP_BOARD_FILE`,
    dom: appShot.facts,
    sha256: { board: boardSha, app: appSha, diff: sha256(result.diff), negativeDiff: sha256(negative.diff) },
    negativeControl: {
      change: 'padding-top:1px on [data-board-port="xwhm-accounts"] via ?gate=pad, then reverted',
      comparedWith: 'the unmutated product capture',
      diff: `${(negative.ratio * 100).toFixed(2)}%`,
      mismatched: negative.mismatched,
      total: negative.total,
    },
  }
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(row, null, 2))
  console.log(JSON.stringify(row, null, 2))
  if (result.ratio > 0.03) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
