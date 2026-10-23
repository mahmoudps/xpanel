import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import playwright from '../node_modules/@playwright/test/index.js'
import { renderFidelityDocument } from '../apps/web/src/board-port/xwhm-dashboard.ts'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const { chromium } = playwright
const root = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(root, '..')
const outDir = '/opt/cursor/artifacts/board-fidelity'
const boardFile = '/cursor/stores/bot/xpanel-design/claude-export/Home · Dashboard/WhmDashboard.dc.html'
const viewport = { width: 1440, height: 1820 }

const serveHtml = (html) => new Promise((resolve) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  server.listen(0, '127.0.0.1', () => resolve(server))
})

const serveDir = (dir) => new Promise((resolve) => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const file = path.join(dir, decodeURIComponent(url.pathname === '/' ? '/WhmDashboard.dc.html' : url.pathname))
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

const shoot = async (browser, url, dir) => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
  await page.goto(url, { waitUntil: 'networkidle' })
  if (dir === 'rtl') await page.evaluate(() => { document.documentElement.dir = 'rtl' })
  await page.evaluate(async () => {
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    document.body.style.webkitFontSmoothing = 'antialiased'
    if (document.fonts) await document.fonts.ready
  })
  await page.waitForTimeout(400)
  const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: viewport.width, height: viewport.height } })
  await page.close()
  return png
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

const main = async () => {
  await mkdir(outDir, { recursive: true })
  const boardServer = await serveDir(path.dirname(boardFile))
  const appServer = await serveHtml(renderFidelityDocument('ltr'))
  const boardPort = boardServer.address().port
  const appPort = appServer.address().port
  const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--font-render-hinting=none'] })
  const rows = []
  for (const dir of ['ltr', 'rtl']) {
    const boardPng = await shoot(browser, `http://127.0.0.1:${boardPort}/WhmDashboard.dc.html`, dir)
    const appPng = await shoot(browser, `http://127.0.0.1:${appPort}/`, dir)
    const result = diffRatio(boardPng, appPng)
    const id = `xwhm-dashboard-${dir}`
    await writeFile(path.join(outDir, `${id}-board.png`), boardPng)
    await writeFile(path.join(outDir, `${id}-app.png`), appPng)
    await writeFile(path.join(outDir, `${id}-diff.png`), result.diff)
    rows.push({ screen: 'xWHM Dashboard', dir, diff: `${(result.ratio * 100).toFixed(2)}%`, mismatched: result.mismatched, total: result.total })
    console.log(id, rows.at(-1).diff, result.mismatched, '/', result.total)
  }
  await browser.close()
  boardServer.close()
  appServer.close()
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(rows, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
