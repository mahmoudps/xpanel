/// <reference path="../../test/gate/pngjs.d.ts" />
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'vitest'
import { defaultPlan } from '@xpanel/core'
import playwright from '../../../../node_modules/@playwright/test/index.js'
import { tools, type CatalogTool } from '@xpanel/catalog'
import { renderWebApp } from '../app.ts'
import { renderPanelSurface } from '../surfaces/xpanel.ts'
import { PAGE_LIMIT, TILE_LIMIT, gateAccepts, padPort, sameCapture, scoreGate } from '../../test/gate/board-gate.ts'
import { installBoardGateFixture } from './gate-fixture.ts'
import { resourcesBoardView } from './xpanel-resources.fixture.ts'
import { renderXpanelResources } from './xpanel-resources.ts'

const { chromium } = playwright
const chromeExecutable = [process.env.CHROME_PATH, '/opt/google/chrome/chrome'].find(candidate => candidate && existsSync(candidate))
const designRootEnv = process.env.XP_DESIGN_ROOT
const designRoot = designRootEnv && existsSync(designRootEnv) ? designRootEnv : '/tmp/xpanel-boards'
const outDir = process.env.XP_FIDELITY_OUT ?? path.join(tmpdir(), 'xpanel-resources-gate')

const account = {
  id: 'resources-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice-shop.com',
  planId: 'plan', ownerId: null, status: 'active' as const, suspendReason: null, contactEmail: 'owner@alice-shop.com',
  ipv4: '192.0.2.21', ipv6: null, shell: 'none' as const, createdAt: '2026-10-22T14:05:00Z',
}
const plan = defaultPlan({ id: 'plan', name: 'Measured plan', featureListId: 'features' })
const visibility = {
  principal: { kind: 'user' as const, id: 'resources-user', username: 'alice', accountId: account.id },
  disabledFeatures: new Set<string>(),
}
const RESOURCES_TOOL_IDS = ['resource-usage', 'account-usage-stats', 'disk-usage']
const resourcesCatalog: CatalogTool[] = tools.map(tool => (
  RESOURCES_TOOL_IDS.includes(tool.id)
    ? { ...tool, status: 'verified', delivery: { ...tool.delivery, status: 'verified', reason: 'Pixel-gate fixture. Not a host qualification.' } }
    : tool
))

const portOf = (html: string): string => {
  const start = html.indexOf('<div data-board-port="xpanel-resources"')
  const end = html.indexOf('</script></div>', start)
  return html.slice(start, end)
}

const productHtml = (locale: 'en' | 'ar' = 'en') => renderWebApp({
  surface: 'xpanel', locale, theme: 'light', activeRoute: '/resources', realtimeEnabled: false,
  visibility, catalog: resourcesCatalog, panel: { account, plan },
})

describe('xPanel resources board port', () => {
  it('binds stored plan limits and leaves unread host facts empty', () => {
    const html = productHtml()
    assert.match(html, /data-surface="xpanel"/)
    assert.match(html, /data-board-port="xpanel-resources"/)
    assert.match(html, /5120 MiB/)
    assert.match(html, /51200 MiB/)
    assert.match(html, /50 MiB\/s/)
    assert.match(html, /25 MiB\/s/)
    assert.match(html, /100%/)
    assert.match(html, /Not read/)
    assert.match(html, /Coming soon/)
    assert.match(html, /Bandwidth is not measured/)
    assert.match(html, /du -s -B1/)
    assert.doesNotMatch(html, /3\.2 GB|86 GB|srv1\.xpanel\.test|4181|shop-api|Enforced|usrquota/)
    assert.equal(portOf(html).includes('<bdi'), false)
    assert.equal(html.includes('data-dc-tpl'), false)
    assert.equal(html.includes('id="dc-root"'), false)
    assert.equal(html.includes('<x-dc'), false)
    assert.equal(html.includes('data-sc-name'), false)
    const fragment = renderXpanelResources(resourcesBoardView())
    assert.deepEqual(fragment.match(/transition:/g), ['transition:'])
    assert.match(fragment, /animation:none !important/)
    const ignored = { account, plan, activeRoute: '/resources' as const, locale: 'en' as const }
    Object.assign(ignored, { resourcesPort: resourcesBoardView() })
    assert.equal(renderPanelSurface(ignored).includes('3.2 / 10 GB'), false)
  })

  it('shows a reading only for numbers the agent returned', () => {
    const html = renderPanelSurface({
      account, plan, activeRoute: '/resources', locale: 'en', generationId: 7,
      usage: { phpVersion: '8.3', diskBytes: 10 * 1024 * 1024, memoryBytes: 64 * 1024 * 1024, processCount: 4, bandwidth: 'unmeasured' },
    })
    assert.match(html, /10 MiB/)
    assert.match(html, /64 MiB/)
    assert.match(html, /4 \/ 100/)
    assert.match(html, /Generation 7/)
    assert.match(html, /PHP 8\.3/)
    assert.match(html, /No timestamp on this reading/)
    assert.doesNotMatch(html, /3\.2|86 GB|0 B\/s|(?<![0-9])0 MiB/)
    assert.match(html, /—/)
  })

  it('keeps the English fixture free of bidi markup and on the board sample', () => {
    installBoardGateFixture({ resourcesPort: resourcesBoardView() })
    try {
      const html = productHtml()
      assert.equal(portOf(html).includes('<bdi'), false)
      assert.match(html, /3\.2 \/ 10 GB/)
      assert.match(html, /Updated 2026-10-22 14:05:12 UTC/)
      assert.match(html, /Cap 20 MB\/s/)
      assert.match(html, /height: 136px/)
      assert.match(html, /bottom: 158px/)
      assert.match(html, /Writes reached the 20 MB\/s cap at 13:35/)
      assert.match(html, /xpanel-20014\.slice/)
      assert.doesNotMatch(html, /Coming soon|5120 MiB/)
    } finally {
      installBoardGateFixture(undefined)
    }
    assert.equal(productHtml().includes('3.2 / 10 GB'), false)
  })

  it('translates the same regions in Arabic and isolates identifiers', () => {
    const html = productHtml('ar')
    assert.match(html, /dir="rtl"/)
    assert.match(html, /الموارد والحصص/)
    assert.match(html, /<bdi dir="ltr"/)
    assert.match(html, /قيد التفعيل/)
    assert.match(html, /لم يُقرأ/)
    assert.doesNotMatch(html, />Resources & quotas<|>Not read<|>Coming soon</)
    assert.doesNotMatch(html, /3\.2 GB|srv1\.xpanel\.test/)
  })
})

interface Page {
  goto: (url: string, options: { waitUntil: 'networkidle' }) => Promise<{ text: () => Promise<string> } | null>
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
      const { readFile } = await import('node:fs/promises')
      const body = await readFile(file)
      const type = file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8'
      res.writeHead(200, { 'content-type': type })
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

describe('resources product-route pixel gate', () => {
  it.skipIf(chromeExecutable === undefined || !existsSync(path.join(designRoot, 'General · Resources & quotas', 'PanelResources.dc.html')))('matches the board at 1440 and 1280, and a 1px pad fails', async () => {
    await mkdir(outDir, { recursive: true })
    const viewports = [
      { id: 'resources-1440', width: 1440, height: 2520 },
      { id: 'resources-1280', width: 1280, height: 2520 },
    ]
    installBoardGateFixture({ resourcesPort: resourcesBoardView() })
    const html = productHtml()
    installBoardGateFixture(undefined)
    assert.match(html, /data-surface="xpanel"/)
    assert.match(html, /data-board-port="xpanel-resources"/)
    assert.equal(html.includes('data-dc-tpl'), false)
    assert.equal(html.includes('id="dc-root"'), false)
    const pages = new Map<string, string>()
    pages.set('/resources?fixture=board', html)
    pages.set('/resources?fixture=board&gate=pad', padPort(html, 'xpanel-resources'))
    const appServer = await servePages(pages)
    const boardServer = await serveDir(path.join(designRoot, 'General · Resources & quotas'), 'PanelResources.dc.html')
    const browser = await (chromium as unknown as { launch: (options: { executablePath: string; args: string[] }) => Promise<Browser> }).launch({
      executablePath: chromeExecutable as string,
      args: ['--font-render-hinting=none', '--disable-lcd-text'],
    })
    const report: Array<Record<string, unknown>> = []
    try {
      for (const viewport of viewports) {
        const shoot = async (url: string, product: boolean) => {
          const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 })
          const response = await page.goto(url, { waitUntil: 'networkidle' })
          const served = await response?.text() ?? ''
          if (!product) await page.waitForSelector('#dc-root', { timeout: 8000 })
          const facts = await page.evaluate(() => ({
            href: location.href,
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
            const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts
            if (fonts) await fonts.ready
          })
          await page.waitForTimeout(400)
          const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: viewport.width, height: viewport.height } })
          await page.close()
          return { png, facts, served }
        }
        const boardUrl = `http://127.0.0.1:${boardServer.port}/PanelResources.dc.html`
        const appUrl = `http://127.0.0.1:${appServer.port}/resources?fixture=board`
        const board = await shoot(boardUrl, false)
        const app = await shoot(appUrl, true)
        const padded = await shoot(`http://127.0.0.1:${appServer.port}/resources?fixture=board&gate=pad`, true)
        assert.notEqual(board.facts.href, app.facts.href)
        assert.equal(board.facts.href.endsWith('/PanelResources.dc.html'), true)
        assert.equal(app.facts.href.includes('/resources?fixture=board'), true)
        assert.equal(app.served.includes('data-surface="xpanel"'), true)
        assert.equal(app.served.includes('data-board-port="xpanel-resources"'), true)
        assert.equal(app.served.includes('id="dc-root"'), false)
        assert.equal(app.served.includes('<x-dc'), false)
        assert.equal(app.served.includes('data-dc-tpl'), false)
        assert.equal(board.served.includes('<x-dc'), true)
        assert.notEqual(createHash('sha256').update(board.served).digest('hex'), createHash('sha256').update(app.served).digest('hex'))
        assert.equal(app.facts.surface, 'xpanel')
        assert.equal(app.facts.port, 'xpanel-resources')
        assert.equal(app.facts.dcTpl, 0)
        assert.equal(app.facts.dcRoot, 0)
        assert.equal(app.facts.xdc, 0)
        assert.equal(app.facts.scName, 0)
        assert.equal(board.facts.dcRoot, 1)
        assert.ok(board.facts.dcTpl > 0)
        const score = scoreGate(board.png, app.png)
        const negative = scoreGate(app.png, padded.png)
        const byteIdentical = sameCapture(board.png, app.png)
        const accepted = gateAccepts({ score, board: board.png, app: app.png, negativePass: negative.pass })
        await writeFile(path.join(outDir, `${viewport.id}-board.png`), board.png)
        await writeFile(path.join(outDir, `${viewport.id}-app.png`), app.png)
        await writeFile(path.join(outDir, `${viewport.id}-diff.png`), score.diff)
        await writeFile(path.join(outDir, `${viewport.id}-negative-diff.png`), negative.diff)
        const row = {
          id: viewport.id,
          route: '/resources',
          page: `${(score.ratio * 100).toFixed(4)}%`,
          worstTile: `${(score.worstTile.ratio * 100).toFixed(4)}% @ ${score.worstTile.x},${score.worstTile.y}`,
          pass: score.pass,
          byteIdentical,
          accepted,
          negative: `${(negative.ratio * 100).toFixed(2)}%`,
          negativePass: negative.pass,
          limits: { page: PAGE_LIMIT, tile: TILE_LIMIT },
          source: {
            board: { url: board.facts.href, htmlSha256: createHash('sha256').update(board.served).digest('hex') },
            app: { url: app.facts.href, htmlSha256: createHash('sha256').update(app.served).digest('hex') },
          },
          sha256: { board: createHash('sha256').update(board.png).digest('hex'), app: createHash('sha256').update(app.png).digest('hex') },
        }
        report.push(row)
        assert.equal(row.negativePass, false, `${viewport.id} 1px pad must fail, got ${row.negative}`)
        assert.equal(row.pass, true, `${viewport.id} page ${row.page} tile ${row.worstTile}`)
        assert.equal(row.byteIdentical, false, `${viewport.id} PNG bytes must differ`)
        assert.notEqual(row.sha256.board, row.sha256.app)
        assert.equal(row.accepted, true, `${viewport.id} page ${row.page} tile ${row.worstTile}`)
      }
    } finally {
      await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
      await browser.close()
      boardServer.close()
      appServer.close()
    }
  }, 180_000)
})
