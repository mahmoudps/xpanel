/// <reference path="../../test/gate/pngjs.d.ts" />
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'vitest'
import { PNG } from 'pngjs'
import { qualifyHostTools, tools } from '@xpanel/catalog'
import { defaultPlan } from '@xpanel/core'
import playwright from '../../../../node_modules/@playwright/test/index.js'
import { renderWebApp } from '../app.ts'
import { type PanelSurfaceProps, renderPanelSurface } from '../surfaces/xpanel.ts'
import { PAGE_LIMIT, TILE_LIMIT, gateAccepts, padPort, sameCapture, scoreGate } from '../../test/gate/board-gate.ts'
import { installBoardGateFixture, type BoardGateFixture } from './gate-fixture.ts'
import { xpanelHomeFixture, xpanelHomeFixturePhone } from './xpanel-home.fixture.ts'
import { whmDashboardFixture } from './xwhm-dashboard.ts'
import { inboxBoardModel } from './xmail-inbox.fixture.ts'
import { composeBoardModel } from './xmail-compose.fixture.ts'

const { chromium } = playwright
const chromeExecutable = [process.env.CHROME_PATH, '/opt/google/chrome/chrome'].find(candidate => candidate && existsSync(candidate))
const designRootEnv = process.env.XP_DESIGN_ROOT
const designRoot = designRootEnv && existsSync(designRootEnv)
  ? designRootEnv
  : '/cursor/stores/bot/xpanel-design/claude-export'
const outDir = process.env.XP_FIDELITY_OUT ?? path.join(tmpdir(), 'xpanel-board-gate')

const solid = (width: number, height: number, pixel: [number, number, number, number]): Buffer => {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = pixel[0]
    png.data[i + 1] = pixel[1]
    png.data[i + 2] = pixel[2]
    png.data[i + 3] = pixel[3]
  }
  return PNG.sync.write(png)
}

describe('board gate thresholds', () => {
  it('fails a tile that is more than 1% off even when the page is under 0.5%', () => {
    const width = 1000
    const height = 1000
    const clean = solid(width, height, [255, 255, 255, 255])
    const dirtyPng = PNG.sync.read(clean)
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 200; x++) {
        const i = (y * width + x) * 4
        dirtyPng.data[i] = 0
      }
    }
    const score = scoreGate(clean, PNG.sync.write(dirtyPng))
    assert.ok(score.ratio < PAGE_LIMIT, `page ${score.ratio} should stay under ${PAGE_LIMIT}`)
    assert.ok(score.worstTile.ratio > TILE_LIMIT, `tile ${score.worstTile.ratio} should fail ${TILE_LIMIT}`)
    assert.equal(score.pass, false)
  })

  it('fails a 1px vertical shift of a full page', () => {
    const width = 800
    const height = 600
    const png = new PNG({ width, height })
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const on = (x * 3 + y * 5) % 7 < 3
        png.data[i] = on ? 12 : 240
        png.data[i + 1] = on ? 48 : 236
        png.data[i + 2] = on ? 72 : 232
        png.data[i + 3] = 255
      }
    }
    const original = PNG.sync.write(png)
    const shifted = new PNG({ width, height })
    for (let y = 0; y < height; y++) {
      const srcY = Math.max(0, y - 1)
      png.data.copy(shifted.data, y * width * 4, srcY * width * 4, (srcY + 1) * width * 4)
    }
    const score = scoreGate(original, PNG.sync.write(shifted))
    assert.ok(score.ratio > PAGE_LIMIT, `1px shift was ${(score.ratio * 100).toFixed(2)}%, which must fail ${PAGE_LIMIT}`)
    assert.equal(score.pass, false)
  })

  it('refuses a byte-identical pair even when every pixel matches', () => {
    const png = solid(40, 40, [255, 255, 255, 255])
    const score = scoreGate(png, png)
    assert.equal(score.pass, true)
    assert.equal(sameCapture(png, png), true)
    assert.equal(gateAccepts({ score, board: png, app: png, negativePass: false }), false)
    const near = PNG.sync.read(png)
    near.data[0] = 254
    const other = PNG.sync.write(near)
    const close = scoreGate(png, other)
    assert.equal(close.pass, true)
    assert.equal(sameCapture(png, other), false)
    assert.equal(gateAccepts({ score: close, board: png, app: other, negativePass: false }), true)
    assert.equal(gateAccepts({ score: close, board: png, app: other, negativePass: true }), false)
  })

  it('pads only the named port root', () => {
    const html = '<div class="xp-board-port" data-board-port="xpanel-home" style="min-height:100vh">'
    assert.match(padPort(html, 'xpanel-home'), /style="padding-top:1px;min-height:100vh"/)
    assert.throws(() => padPort(html, 'missing'), /data-board-port="missing"/)
  })

  it('keeps pixelmatch and pngjs out of release source', () => {
    const root = path.resolve(import.meta.dirname, '../../../..')
    assert.equal(existsSync(path.join(root, 'apps/web/src/board-port/board-gate.ts')), false)
    assert.equal(existsSync(path.join(root, 'apps/web/test/gate/board-gate.ts')), true)
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const abs = path.join(dir, entry)
        if (statSync(abs).isDirectory()) {
          walk(abs)
          continue
        }
        if (!abs.endsWith('.ts') || abs.endsWith('.test.ts') || abs.endsWith('.d.ts')) continue
        const text = readFileSync(abs, 'utf8')
        if (/(?:from|import)\s+['"](?:pixelmatch|pngjs)['"]/.test(text)) offenders.push(path.relative(root, abs))
      }
    }
    for (const group of ['apps', 'packages']) {
      for (const name of readdirSync(path.join(root, group))) {
        const src = path.join(root, group, name, 'src')
        if (existsSync(src)) walk(src)
      }
    }
    assert.deepEqual(offenders, [])
  })
})

const plan = defaultPlan({ id: 'fixture-plan', name: 'Business', featureListId: 'fixture-features' })
const account = {
  id: 'fixture-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice',
  primaryDomain: 'alice-shop.com', planId: plan.id, ownerId: null, status: 'active' as const,
  suspendReason: null, contactEmail: 'ops@alice-shop.com', ipv4: '192.0.2.21', shell: 'none' as const,
  createdAt: '2026-10-22T12:00:00Z',
}
const userVisibility = { principal: { kind: 'user' as const, id: 'fixture-user', username: 'alice', accountId: account.id }, disabledFeatures: new Set<string>() }
const rootVisibility = { principal: { kind: 'root' as const, id: 'fixture-root', username: 'root' } }
const homeCatalog = qualifyHostTools(tools, { executor: 'linux', probes: { 'control-plane': 'passed' } })
const dashCatalog = qualifyHostTools(tools, { executor: 'linux', probes: { 'control-plane': 'passed', 'host-info': 'passed' } })
const mailCatalog = qualifyHostTools(tools, { executor: 'linux', probes: { 'control-plane': 'passed', mail: 'passed' } })

const withFixture = (fixture: BoardGateFixture, render: () => string): string => {
  installBoardGateFixture(fixture)
  try {
    return render()
  } finally {
    installBoardGateFixture(undefined)
  }
}
const homeState = {
  surface: 'xpanel' as const, locale: 'en' as const, theme: 'light' as const, activeRoute: '/home', realtimeEnabled: false,
  visibility: userVisibility, catalog: homeCatalog,
  panel: { account, plan },
}
const homeHtml = () => withFixture(
  { homePort: { desktop: xpanelHomeFixture(), phone: xpanelHomeFixturePhone() } },
  () => renderWebApp(homeState),
)
const dashboardHtml = () => withFixture(
  { dashboardPort: whmDashboardFixture() },
  () => renderWebApp({
    surface: 'xwhm', locale: 'en', theme: 'light', activeRoute: '/whm', realtimeEnabled: false,
    visibility: rootVisibility, catalog: dashCatalog,
    whm: { principal: rootVisibility.principal, hostname: 'srv1.xpanel.test', version: '1.4.2', generationId: 142 },
  }),
)
const inboxHtml = () => withFixture(
  { inboxPort: inboxBoardModel() },
  () => renderWebApp({
    surface: 'xmail', locale: 'en', theme: 'light', activeRoute: '/mail/inbox', realtimeEnabled: false,
    visibility: userVisibility, catalog: mailCatalog,
    mail: { mailbox: 'info@alice-shop.com' },
  }),
)
const composeHtml = () => withFixture(
  { composePort: composeBoardModel() },
  () => renderWebApp({
    surface: 'xmail', locale: 'en', theme: 'light', activeRoute: '/mail/compose', realtimeEnabled: false,
    visibility: userVisibility, catalog: mailCatalog,
    mail: { mailbox: 'info@alice-shop.com' },
  }),
)

describe('board fixture injection', () => {
  it('serves the sample only while the test server has installed it', () => {
    assert.match(homeHtml(), /3\.2 \/ 10 GB/)
    assert.equal(renderWebApp(homeState).includes('3.2 / 10 GB'), false)
    const props: PanelSurfaceProps = {
      account, plan, activeRoute: '/home', locale: 'en', theme: 'light', visibility: userVisibility, catalog: homeCatalog,
    }
    Object.assign(props, { homePort: { desktop: xpanelHomeFixture(), phone: xpanelHomeFixturePhone() } })
    assert.equal(renderPanelSurface(props).includes('3.2 / 10 GB'), false)
  })
})

interface GateScreen {
  id: string
  route: string
  port: string
  surface: string
  viewport: { width: number; height: number }
  board: readonly [string, string]
  html: () => string
}

interface GateRow {
  id: string
  route: string
  diff: string
  mismatched: number
  total: number
  worstTile: { x: number; y: number; mismatched: number; total: number; ratio: number; diff: string }
  pass: boolean
  byteIdentical: boolean
  accepted: boolean
  negative: string
  negativePass: boolean
  sha256: { board: string; app: string; diff: string }
}

const screens: readonly GateScreen[] = [
  { id: 'home-ltr', route: '/home?fixture=board', port: 'xpanel-home', surface: 'xpanel', viewport: { width: 1440, height: 1720 }, board: ['General · Home', 'PanelHome.dc.html'], html: homeHtml },
  { id: 'home-phone', route: '/home?fixture=board&viewport=phone', port: 'xpanel-home', surface: 'xpanel', viewport: { width: 390, height: 844 }, board: ['General · Home — phone', 'PanelHomeMobile.dc.html'], html: homeHtml },
  { id: 'dashboard-ltr', route: '/whm?fixture=board', port: 'xwhm-dashboard', surface: 'xwhm', viewport: { width: 1440, height: 1820 }, board: ['Home · Dashboard', 'WhmDashboard.dc.html'], html: dashboardHtml },
  { id: 'inbox-ltr', route: '/mail/inbox?fixture=board', port: 'xmail-inbox', surface: 'xmail', viewport: { width: 1440, height: 1120 }, board: ['Mail · Inbox', 'MailInbox.dc.html'], html: inboxHtml },
  { id: 'compose-ltr', route: '/mail/compose?fixture=board', port: 'xmail-compose', surface: 'xmail', viewport: { width: 1440, height: 1520 }, board: ['Mail · Compose', 'MailCompose.dc.html'], html: composeHtml },
]

interface Browser {
  newPage: (options: { viewport: { width: number; height: number }; deviceScaleFactor: number }) => Promise<Page>
  close: () => Promise<void>
}
interface Page {
  goto: (url: string, options: { waitUntil: 'networkidle' }) => Promise<unknown>
  waitForSelector: (selector: string, options: { timeout: number }) => Promise<unknown>
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>
  waitForTimeout: (ms: number) => Promise<void>
  screenshot: (options: { type: 'png'; clip: { x: number; y: number; width: number; height: number } }) => Promise<Buffer>
  close: () => Promise<void>
}

const serveDir = (dir: string, indexFile: string) => new Promise<{ port: number; close: () => void }>((resolve) => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const file = path.join(dir, decodeURIComponent(url.pathname === '/' ? `/${indexFile}` : url.pathname))
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('missing')
    }
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve({ port: typeof address === 'object' && address ? address.port : 0, close: () => server.close() })
  })
})

const servePages = (pages: Map<string, string>) => new Promise<{ port: number; close: () => void }>((resolve) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const html = pages.get(`${url.pathname}${url.search}`)
    if (!html) { res.writeHead(404); res.end('missing'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve({ port: typeof address === 'object' && address ? address.port : 0, close: () => server.close() })
  })
})

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

describe('product-route board gate', () => {
  it.skipIf(chromeExecutable === undefined || !existsSync(designRoot))('proves the product route, refuses a byte-identical pair, and fails a 1px pad', async () => {
    await mkdir(outDir, { recursive: true })
    const pages = new Map<string, string>()
    for (const screen of screens) {
      const html = screen.html()
      assert.match(html, new RegExp(`data-surface="${screen.surface}"`))
      assert.equal(html.includes('data-dc-tpl'), false)
      assert.doesNotMatch(html, /id="dc-root"/)
      pages.set(screen.route, html)
      pages.set(`${screen.route}&gate=pad`, padPort(html, screen.port))
    }
    const appServer = await servePages(pages)
    const browser = await (chromium as unknown as { launch: (options: { executablePath: string; args: string[] }) => Promise<Browser> }).launch({
      executablePath: chromeExecutable as string,
      args: ['--font-render-hinting=none', '--disable-lcd-text'],
    })
    const report: GateRow[] = []
    try {
      for (const screen of screens) {
        const boardServer = await serveDir(path.join(designRoot, screen.board[0]), screen.board[1])
        const shoot = async (url: string, product: boolean) => {
          const page = await browser.newPage({ viewport: screen.viewport, deviceScaleFactor: 1 })
          await page.goto(url, { waitUntil: 'networkidle' })
          if (!product) await page.waitForSelector('#dc-root', { timeout: 8000 })
          const facts = await page.evaluate(() => ({
            surface: document.documentElement.getAttribute('data-surface'),
            port: document.querySelector('[data-board-port]')?.getAttribute('data-board-port') ?? '',
            dcTpl: document.querySelectorAll('[data-dc-tpl]').length,
            dcRoot: document.getElementById('dc-root') ? 1 : 0,
            xdc: document.querySelector('x-dc') ? 1 : 0,
            scName: document.querySelectorAll('[data-sc-name]').length,
          }))
          await page.evaluate(async () => {
            document.documentElement.style.overflow = 'hidden'
            document.body.style.overflow = 'hidden'
            if (document.fonts) await document.fonts.ready
          })
          await page.waitForTimeout(400)
          const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: screen.viewport.width, height: screen.viewport.height } })
          await page.close()
          return { png, facts }
        }
        const board = await shoot(`http://127.0.0.1:${boardServer.port}/${screen.board[1]}`, false)
        const app = await shoot(`http://127.0.0.1:${appServer.port}${screen.route}`, true)
        const padded = await shoot(`http://127.0.0.1:${appServer.port}${screen.route}&gate=pad`, true)
        boardServer.close()
        assert.equal(app.facts.surface, screen.surface)
        assert.equal(app.facts.port, screen.port)
        assert.equal(app.facts.dcTpl, 0)
        assert.equal(app.facts.dcRoot, 0)
        assert.equal(app.facts.xdc, 0)
        assert.equal(app.facts.scName, 0)
        assert.equal(board.facts.dcRoot, 1)
        const score = scoreGate(board.png, app.png)
        const negative = scoreGate(app.png, padded.png)
        const byteIdentical = sameCapture(board.png, app.png)
        const accepted = gateAccepts({ score, board: board.png, app: app.png, negativePass: negative.pass })
        await writeFile(path.join(outDir, `${screen.id}-board.png`), board.png)
        await writeFile(path.join(outDir, `${screen.id}-app.png`), app.png)
        await writeFile(path.join(outDir, `${screen.id}-diff.png`), score.diff)
        await writeFile(path.join(outDir, `${screen.id}-negative-diff.png`), negative.diff)
        const row = {
          id: screen.id,
          route: screen.route,
          diff: `${(score.ratio * 100).toFixed(2)}%`,
          mismatched: score.mismatched,
          total: score.total,
          worstTile: { ...score.worstTile, diff: `${(score.worstTile.ratio * 100).toFixed(2)}%` },
          pass: score.pass,
          byteIdentical,
          accepted,
          negative: `${(negative.ratio * 100).toFixed(2)}%`,
          negativePass: negative.pass,
          sha256: { board: sha256(board.png), app: sha256(app.png), diff: sha256(score.diff) },
        }
        report.push(row)
        assert.equal(row.negativePass, false, `${screen.id} 1px pad must fail the gate, got ${row.negative}`)
        assert.equal(row.accepted, row.pass && !byteIdentical, `${screen.id} acceptance did not follow the gate`)
      }
      for (const id of ['home-ltr', 'home-phone']) {
        const row = report.find(item => item.id === id)
        if (!row) throw new Error(id)
        assert.equal(row.pass, true, `${id} pixels ${row.diff} tile ${row.worstTile.diff}`)
      }
    } finally {
      await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
      await browser.close()
      appServer.close()
    }
  }, 180_000)
})
