import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'vitest'
import { qualifyHostTools, tools } from '@xpanel/catalog'
import { defaultPlan } from '@xpanel/core'
import playwright from '../../../../node_modules/@playwright/test/index.js'
import { renderWebApp } from '../app.ts'
import { gateAccepts, padPort, sameCapture, scoreGate } from './board-gate.ts'
import { whmPlansFixtureScope } from './xwhm-plans.ts'

const { chromium } = playwright
const chromeExecutable = [process.env.CHROME_PATH, '/opt/google/chrome/chrome'].find(candidate => candidate && existsSync(candidate))
const designRootEnv = process.env.XP_DESIGN_ROOT
const designRoot = designRootEnv && existsSync(designRootEnv)
  ? designRootEnv
  : '/cursor/stores/bot/xpanel-design/claude-export'
const outDir = process.env.XP_FIDELITY_OUT ?? path.join(tmpdir(), 'xpanel-plans-gate')
const viewport = { width: 1280, height: 3105 }

const catalog = qualifyHostTools(tools, { executor: 'linux', probes: { 'control-plane': 'passed', 'host-info': 'passed' } })
const rootVisibility = { principal: { kind: 'root' as const, id: 'fixture-root', username: 'root' } }

const plansHtml = () => renderWebApp({
  surface: 'xwhm', locale: 'en', theme: 'light', activeRoute: '/whm/plans', realtimeEnabled: false,
  visibility: rootVisibility, catalog,
  whm: {
    principal: rootVisibility.principal,
    hostname: 'srv1.xpanel.test',
    version: '1.4.2',
    generationId: 142,
    plansPort: whmPlansFixtureScope(),
  },
})

const liveHtml = () => renderWebApp({
  surface: 'xwhm', locale: 'en', theme: 'light', activeRoute: '/whm/plans', realtimeEnabled: false,
  visibility: rootVisibility, catalog,
  whm: {
    principal: rootVisibility.principal,
    hostname: 'srv1.xpanel.test',
    plans: [defaultPlan({ id: 'observed-plan', name: 'Observed plan', featureListId: 'observed-features' })],
    accounts: [],
  },
})

const arabicHtml = () => renderWebApp({
  surface: 'xwhm', locale: 'ar', theme: 'light', activeRoute: '/whm/plans', realtimeEnabled: false,
  visibility: rootVisibility, catalog,
  whm: {
    principal: rootVisibility.principal,
    plans: [defaultPlan({ id: 'observed-plan', name: 'Observed plan', featureListId: 'observed-features' })],
    accounts: [],
  },
})

interface Page {
  goto: (url: string, options: { waitUntil: 'networkidle' }) => Promise<unknown>
  waitForSelector: (selector: string, options: { timeout: number }) => Promise<unknown>
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>
  waitForTimeout: (ms: number) => Promise<void>
  screenshot: (options: { type: 'png'; clip: { x: number; y: number; width: number; height: number } }) => Promise<Buffer>
  close: () => Promise<void>
}
interface Browser {
  newPage: (options: { viewport: { width: number; height: number }; deviceScaleFactor: number }) => Promise<Page>
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
    const html = pages.get(url.pathname)
    if (!html) { res.writeHead(404); res.end('missing'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve({ port: typeof address === 'object' && address ? address.port : 0, close: () => server.close() })
  })
})

describe('plans product-route board gate', () => {
  it.skipIf(chromeExecutable === undefined || !existsSync(path.join(designRoot, 'Plans · Plans')))('scores /whm/plans at 1280 and fails a 1px pad', async () => {
    await mkdir(outDir, { recursive: true })
    const html = plansHtml()
    assert.match(html, /data-surface="xwhm"/)
    assert.match(html, /data-board-port="xwhm-plans"/)
    assert.equal(html.includes('data-dc-tpl'), false)
    assert.doesNotMatch(html, /id="dc-root"|<x-dc|data-sc-name/)
    const pages = new Map<string, string>([
      ['/whm/plans', html],
      ['/pad', padPort(html, 'xwhm-plans')],
      ['/live', liveHtml()],
      ['/ar', arabicHtml()],
    ])
    const appServer = await servePages(pages)
    const boardServer = await serveDir(path.join(designRoot, 'Plans · Plans'), 'WhmPlans.dc.html')
    const browser = await (chromium as unknown as { launch: (options: { executablePath: string; args: string[] }) => Promise<Browser> }).launch({
      executablePath: chromeExecutable as string,
      args: ['--font-render-hinting=none', '--disable-lcd-text'],
    })
    const shoot = async (url: string, product: boolean) => {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
      await page.goto(url, { waitUntil: 'networkidle' })
      if (!product) await page.waitForSelector('#dc-root', { timeout: 8000 })
      const facts = await page.evaluate(async () => {
        document.documentElement.style.overflow = 'hidden'
        document.body.style.overflow = 'hidden'
        if (document.fonts) await document.fonts.ready
        return {
          surface: document.documentElement.getAttribute('data-surface'),
          port: document.querySelector('[data-board-port]')?.getAttribute('data-board-port') ?? '',
          dcTpl: document.querySelectorAll('[data-dc-tpl]').length,
          dcRoot: document.getElementById('dc-root') ? 1 : 0,
          xdc: document.querySelector('x-dc') ? 1 : 0,
          scName: document.querySelectorAll('[data-sc-name]').length,
        }
      })
      await page.waitForTimeout(400)
      const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: viewport.width, height: viewport.height } })
      await page.close()
      return { png, facts }
    }
    try {
      const board = await shoot(`http://127.0.0.1:${boardServer.port}/WhmPlans.dc.html`, false)
      const app = await shoot(`http://127.0.0.1:${appServer.port}/whm/plans`, true)
      const padded = await shoot(`http://127.0.0.1:${appServer.port}/pad`, true)
      const live = await shoot(`http://127.0.0.1:${appServer.port}/live`, true)
      const arabic = await shoot(`http://127.0.0.1:${appServer.port}/ar`, true)
      assert.equal(app.facts.surface, 'xwhm')
      assert.equal(app.facts.port, 'xwhm-plans')
      assert.equal(app.facts.dcTpl, 0)
      assert.equal(app.facts.dcRoot, 0)
      assert.equal(app.facts.xdc, 0)
      assert.equal(app.facts.scName, 0)
      assert.equal(board.facts.dcRoot, 1)
      const score = scoreGate(board.png, app.png)
      const negative = scoreGate(app.png, padded.png)
      const byteIdentical = sameCapture(board.png, app.png)
      const accepted = gateAccepts({ score, board: board.png, app: app.png, negativePass: negative.pass })
      await writeFile(path.join(outDir, 'plans-board.png'), board.png)
      await writeFile(path.join(outDir, 'plans-app.png'), app.png)
      await writeFile(path.join(outDir, 'plans-diff.png'), score.diff)
      await writeFile(path.join(outDir, 'plans-live.png'), live.png)
      await writeFile(path.join(outDir, 'plans-ar.png'), arabic.png)
      const report = {
        route: '/whm/plans',
        viewport,
        page: `${(score.ratio * 100).toFixed(4)}%`,
        mismatched: score.mismatched,
        total: score.total,
        worstTile: { x: score.worstTile.x, y: score.worstTile.y, diff: `${(score.worstTile.ratio * 100).toFixed(4)}%` },
        pass: score.pass,
        byteIdentical,
        accepted,
        negative: `${(negative.ratio * 100).toFixed(4)}%`,
        negativePass: negative.pass,
        sha256: {
          board: createHash('sha256').update(board.png).digest('hex'),
          app: createHash('sha256').update(app.png).digest('hex'),
        },
      }
      await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
      assert.equal(score.pass, true, `page ${report.page} tile ${report.worstTile.diff}`)
      assert.equal(negative.pass, false, `1px pad must fail, got ${report.negative}`)
      assert.equal(accepted, score.pass && !byteIdentical, 'acceptance did not follow the gate')
      assert.equal(live.facts.port, 'xwhm-plans')
      assert.equal(arabic.facts.port, 'xwhm-plans')
    } finally {
      await browser.close()
      appServer.close()
      boardServer.close()
    }
  }, 120_000)
})
