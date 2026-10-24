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
const outDir = process.env.XP_FIDELITY_OUT ?? path.join(repo, '.artifacts', 'board-fidelity-email')
const boardFile = process.env.XP_BOARD_FILE
if (!boardFile) throw new Error('Set XP_BOARD_FILE to the exported PanelEmail.dc.html')
const viewport = { width: 1440, height: 2240 }
const route = '/email/accounts'
const fixtureUrl = `${route}?fixture=board`

/** Harness-only account. These values are not product defaults. */
const account = {
  id: 'fixture-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice-shop.com',
  planId: 'fixture-plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@alice-shop.com',
  ipv4: '192.0.2.21', shell: 'none', createdAt: '2026-10-22T14:05:00Z',
}
const plan = defaultPlan({ id: 'fixture-plan', name: 'Business', featureListId: 'fixture-features' })
const catalog = qualifyHostTools(tools, { executor: 'linux', probes: { 'control-plane': 'passed', mail: 'passed' } })
const productHtml = (pad) => {
  let html = renderWebApp({
    surface: 'xpanel',
    locale: 'en',
    theme: 'light',
    activeRoute: route,
    realtimeEnabled: false,
    visibility: {
      principal: { kind: 'user', id: 'fixture-user', username: 'alice', accountId: account.id },
      disabledFeatures: new Set(),
    },
    catalog,
    panel: {
      account,
      plan,
      domains: [{
        id: 'fixture-domain', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null,
        docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
        php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} },
        wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
      }],
      serviceUsers: [{
        id: 'fixture-user', accountId: account.id, login: 'info@alice-shop.com',
        services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 1024, ftpDir: 'public_html',
      }],
    },
  })
  if (pad) {
    const needle = 'data-board-port="xpanel-email" dir="ltr" style="min-height:100vh;'
    if (!html.includes(needle)) throw new Error('negative-control target is missing from the product document')
    html = html.replace(needle, 'data-board-port="xpanel-email" dir="ltr" style="padding-top:1px;min-height:100vh;')
  }
  return html
}

const servePages = (pages) => new Promise((resolve) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const key = `${url.pathname}${url.search}`
    const html = pages[key]
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
    const file = path.join(dir, decodeURIComponent(url.pathname === '/' ? '/PanelEmail.dc.html' : url.pathname))
    try {
      const body = await readFile(file)
      const type = file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8'
      res.writeHead(200, { 'content-type': type })
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
    port: document.querySelector('[data-board-port]')?.getAttribute('data-board-port') ?? '',
    dcTpl: document.querySelectorAll('[data-dc-tpl]').length,
    dcRoot: document.getElementById('dc-root') ? 1 : 0,
    scName: document.querySelectorAll('[data-sc-name]').length,
  }))
  if (facts.surface !== 'xpanel' || facts.port !== 'xpanel-email' || facts.dcTpl !== 0 || facts.dcRoot !== 0 || facts.scName !== 0) {
    throw new Error(`product DOM assertion failed: ${JSON.stringify(facts)}`)
  }
  return facts
}

const shoot = async (browser, url, { product }) => {
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

const diffRatio = (boardBuf, appBuf) => {
  const board = PNG.sync.read(boardBuf)
  const app = PNG.sync.read(appBuf)
  const width = Math.min(board.width, app.width)
  const height = Math.min(board.height, app.height)
  const diff = new PNG({ width, height })
  const mismatched = pixelmatch(board.data, app.data, diff.data, width, height, { threshold: 0.1, includeAA: false })
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
  const boardPort = boardServer.address().port
  const appPort = appServer.address().port
  const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--font-render-hinting=none', '--disable-lcd-text'] })
  const boardUrl = `http://127.0.0.1:${boardPort}/PanelEmail.dc.html`
  const appUrl = `http://127.0.0.1:${appPort}${fixtureUrl}`
  const padUrl = `http://127.0.0.1:${appPort}${route}?fixture=board&gate=pad`
  const boardShot = await shoot(browser, boardUrl, { product: false })
  const appShot = await shoot(browser, appUrl, { product: true })
  const padShot = await shoot(browser, padUrl, { product: true })
  const result = diffRatio(boardShot.png, appShot.png)
  const negative = diffRatio(appShot.png, padShot.png)
  await writeFile(path.join(outDir, 'xpanel-email-ltr-board.png'), boardShot.png)
  await writeFile(path.join(outDir, 'xpanel-email-ltr-app.png'), appShot.png)
  await writeFile(path.join(outDir, 'xpanel-email-ltr-diff.png'), result.diff)
  await writeFile(path.join(outDir, 'xpanel-email-ltr-negative-diff.png'), negative.diff)
  await browser.close()
  boardServer.close()
  appServer.close()
  const boardSha = sha256(boardShot.png)
  const appSha = sha256(appShot.png)
  if (boardSha === appSha) throw new Error('app PNG is byte-identical to the board PNG')
  if (negative.ratio <= 0) throw new Error('negative control did not change a pixel')
  const row = {
    screen: 'xPanel Email accounts',
    dir: 'ltr',
    diff: `${(result.ratio * 100).toFixed(2)}%`,
    mismatched: result.mismatched,
    total: result.total,
    within3pct: result.ratio <= 0.03,
    appUrl: fixtureUrl,
    appDocument: 'renderWebApp({ surface: "xpanel", activeRoute: "/email/accounts", theme: "light" })',
    boardUrl: 'PanelEmail.dc.html served from XP_BOARD_FILE',
    dom: appShot.facts,
    sha256: { board: boardSha, app: appSha, diff: sha256(result.diff) },
    negativeControl: {
      change: 'padding-top:1px on [data-board-port="xpanel-email"] via ?gate=pad, then reverted (not the published app capture)',
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
