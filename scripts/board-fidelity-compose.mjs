import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import playwright from '../node_modules/@playwright/test/index.js'
import { renderFidelityDocument, renderLiveDocument } from '../apps/web/src/board-port/xmail-compose.ts'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const { chromium } = playwright
const outDir = process.env.XP_FIDELITY_OUT ?? '/opt/cursor/artifacts/board-fidelity'
const designRoot = process.env.XP_DESIGN_ROOT ?? '/cursor/stores/bot/xpanel-design/claude-export'
const boardDir = path.join(designRoot, 'Mail · Compose')

const servePages = (pages) => new Promise((resolve) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(pages[url.pathname] ?? pages['/'])
  })
  server.listen(0, '127.0.0.1', () => resolve(server))
})

const serveDir = (dir, indexFile) => new Promise((resolve) => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const file = path.join(dir, decodeURIComponent(url.pathname === '/' ? `/${indexFile}` : url.pathname))
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

const shoot = async (browser, url, viewport) => {
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

const viewport = { width: 1440, height: 1520 }
const main = async () => {
  await mkdir(outDir, { recursive: true })
  const appServer = await servePages({
    '/': renderFidelityDocument(),
    '/live': renderLiveDocument('en'),
    '/live-ar': renderLiveDocument('ar'),
  })
  const boardServer = await serveDir(boardDir, 'MailCompose.dc.html')
  const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--font-render-hinting=none', '--disable-lcd-text'] })
  const boardPng = await shoot(browser, `http://127.0.0.1:${boardServer.address().port}/MailCompose.dc.html`, viewport)
  const appPng = await shoot(browser, `http://127.0.0.1:${appServer.address().port}/`, viewport)
  const result = diffRatio(boardPng, appPng)
  await writeFile(path.join(outDir, 'xmail-compose-ltr-board.png'), boardPng)
  await writeFile(path.join(outDir, 'xmail-compose-ltr-app.png'), appPng)
  await writeFile(path.join(outDir, 'xmail-compose-ltr-diff.png'), result.diff)
  await writeFile(path.join(outDir, 'xmail-compose-live-ltr.png'), await shoot(browser, `http://127.0.0.1:${appServer.address().port}/live`, viewport))
  await writeFile(path.join(outDir, 'xmail-compose-live-ar.png'), await shoot(browser, `http://127.0.0.1:${appServer.address().port}/live-ar`, viewport))
  const phone = await shoot(browser, `http://127.0.0.1:${appServer.address().port}/live`, { width: 390, height: 844 })
  await writeFile(path.join(outDir, 'xmail-compose-live-phone.png'), phone)
  const row = { screen: 'xmail-compose-ltr', diff: `${(result.ratio * 100).toFixed(2)}%`, mismatched: result.mismatched, total: result.total }
  console.log(row.screen, row.diff, result.mismatched, '/', result.total)
  await writeFile(path.join(outDir, 'xmail-compose-report.json'), JSON.stringify([row], null, 2))
  await browser.close()
  appServer.close()
  boardServer.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
