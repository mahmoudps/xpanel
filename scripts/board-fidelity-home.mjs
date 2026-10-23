import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import playwright from '../node_modules/@playwright/test/index.js'
import { renderFidelityDocument, renderLiveDocument } from '../apps/web/src/board-port/xpanel-home.fixture.ts'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const { chromium } = playwright
const root = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(root, '..')
const outDir = process.env.XP_FIDELITY_OUT ?? path.join(repo, '.artifacts', 'board-fidelity')
// The board exports are private and never committed; point XP_DESIGN_ROOT at your local copy.
const designRoot = process.env.XP_DESIGN_ROOT
if (!designRoot) throw new Error('Set XP_DESIGN_ROOT to the folder that holds the exported Home boards')

const shots = [
  { id: 'xpanel-home-ltr', kind: 'ltr', dir: path.join(designRoot, 'General · Home'), file: 'PanelHome.dc.html', width: 1440, height: 1720 },
  { id: 'xpanel-home-ar', kind: 'ar', dir: path.join(designRoot, 'General · Home — Arabic (RTL)'), file: 'PanelHomeAr.dc.html', width: 1440, height: 1800 },
  { id: 'xpanel-home-phone', kind: 'phone', dir: path.join(designRoot, 'General · Home — phone'), file: 'PanelHomeMobile.dc.html', width: 390, height: 844 },
]

const servePages = (pages) => new Promise((resolve) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const html = pages[url.pathname] ?? pages['/']
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
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
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 })
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
  const appServer = await servePages({
    '/ltr': renderFidelityDocument('ltr'),
    '/ar': renderFidelityDocument('ar'),
    '/phone': renderFidelityDocument('phone'),
    '/live': renderLiveDocument('ltr'),
    '/live-ar': renderLiveDocument('ar'),
    '/live-phone': renderLiveDocument('phone'),
  })
  const appPort = appServer.address().port
  const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--font-render-hinting=none', '--disable-lcd-text'] })
  const rows = []
  for (const shot of shots) {
    const boardServer = await serveDir(shot.dir, shot.file)
    const boardPort = boardServer.address().port
    const viewport = { width: shot.width, height: shot.height }
    const boardPng = await shoot(browser, `http://127.0.0.1:${boardPort}/${shot.file}`, viewport)
    const appPng = await shoot(browser, `http://127.0.0.1:${appPort}/${shot.kind}`, viewport)
    const result = diffRatio(boardPng, appPng)
    await writeFile(path.join(outDir, `${shot.id}-board.png`), boardPng)
    await writeFile(path.join(outDir, `${shot.id}-app.png`), appPng)
    await writeFile(path.join(outDir, `${shot.id}-diff.png`), result.diff)
    const row = { screen: shot.id, diff: `${(result.ratio * 100).toFixed(2)}%`, mismatched: result.mismatched, total: result.total }
    rows.push(row)
    console.log(shot.id, row.diff, result.mismatched, '/', result.total)
    boardServer.close()
  }
  for (const [name, route] of [['xpanel-home-live-ltr.png', 'live'], ['xpanel-home-live-ar.png', 'live-ar'], ['xpanel-home-live-phone.png', 'live-phone']]) {
    const viewport = route === 'live-phone' ? { width: 390, height: 844 } : { width: 1440, height: route === 'live-ar' ? 1800 : 1720 }
    const png = await shoot(browser, `http://127.0.0.1:${appPort}/${route}`, viewport)
    await writeFile(path.join(outDir, name), png)
    console.log(name)
  }
  await browser.close()
  appServer.close()
  await writeFile(path.join(outDir, 'xpanel-home-report.json'), JSON.stringify(rows, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
