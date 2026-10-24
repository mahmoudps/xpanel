import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import playwright from '../node_modules/@playwright/test/index.js'
import { renderFidelityDocument } from '../apps/web/src/board-port/xwhm-account-create.fixture.ts'
import { renderLiveDocument } from '../apps/web/src/board-port/xwhm-account-create.ts'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const { chromium } = playwright
const root = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(root, '..')
const outDir = process.env.XP_FIDELITY_OUT ?? path.join(repo, '.artifacts', 'board-fidelity-create')
const boardFile = process.env.XP_BOARD_FILE
if (!boardFile) throw new Error('Set XP_BOARD_FILE to the exported WhmAccountCreate.dc.html')
const viewport = { width: 1440, height: 2440 }

const servePages = (pages) => new Promise((resolve) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const html = pages[url.pathname] ?? pages['/']
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  server.listen(0, '127.0.0.1', () => resolve(server))
})

const serveDir = (dir) => new Promise((resolve) => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const file = path.join(dir, decodeURIComponent(url.pathname === '/' ? '/WhmAccountCreate.dc.html' : url.pathname))
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

const shoot = async (browser, url) => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
  await page.goto(url, { waitUntil: 'networkidle' })
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
  const appServer = await servePages({
    '/': renderFidelityDocument(),
    '/live': renderLiveDocument('ltr'),
    '/live-rtl': renderLiveDocument('rtl'),
  })
  const boardPort = boardServer.address().port
  const appPort = appServer.address().port
  const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--font-render-hinting=none', '--disable-lcd-text'] })
  const boardPng = await shoot(browser, `http://127.0.0.1:${boardPort}/WhmAccountCreate.dc.html`)
  const appPng = await shoot(browser, `http://127.0.0.1:${appPort}/`)
  const result = diffRatio(boardPng, appPng)
  await writeFile(path.join(outDir, 'xwhm-account-create-ltr-board.png'), boardPng)
  await writeFile(path.join(outDir, 'xwhm-account-create-ltr-app.png'), appPng)
  await writeFile(path.join(outDir, 'xwhm-account-create-ltr-diff.png'), result.diff)
  const live = await shoot(browser, `http://127.0.0.1:${appPort}/live`)
  const liveRtl = await shoot(browser, `http://127.0.0.1:${appPort}/live-rtl`)
  await writeFile(path.join(outDir, 'xwhm-account-create-live-ltr.png'), live)
  await writeFile(path.join(outDir, 'xwhm-account-create-live-rtl.png'), liveRtl)
  await browser.close()
  boardServer.close()
  appServer.close()
  const row = { screen: 'xWHM Create account', dir: 'ltr', diff: `${(result.ratio * 100).toFixed(2)}%`, mismatched: result.mismatched, total: result.total }
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(row, null, 2))
  console.log('xwhm-account-create-ltr', row.diff, result.mismatched, '/', result.total)
  if (result.ratio > 0.03) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
