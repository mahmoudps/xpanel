/// <reference path="../../test/gate/pngjs.d.ts" />
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'vitest'
import { qualifyHostTools, tools } from '@xpanel/catalog'
import playwright from '../../../../node_modules/@playwright/test/index.js'
import { renderWebApp } from '../app.ts'
import { gateAccepts, padPort, sameCapture, scoreGate } from '../../test/gate/board-gate.ts'
import { installBoardGateFixture } from './gate-fixture.ts'
import { whmAccountsFixture } from './xwhm-accounts.fixture.ts'

const { chromium } = playwright
const chromeExecutable = [process.env.CHROME_PATH, '/opt/google/chrome/chrome'].find(candidate => candidate && existsSync(candidate))
const designRootEnv = process.env.XP_DESIGN_ROOT
const designRoot = designRootEnv && existsSync(designRootEnv)
  ? designRootEnv
  : '/cursor/stores/bot/xpanel-design/claude-export'
const outDir = process.env.XP_FIDELITY_OUT ?? path.join(tmpdir(), 'xpanel-accounts-gate')
const boardFolder = 'Accounts · Accounts'
const boardFile = 'WhmAccounts.dc.html'
const route = '/whm/accounts?fixture=board'
const viewport = { width: 1440, height: 1220 }

const catalog = qualifyHostTools(tools, {
  executor: 'linux',
  probes: { 'control-plane': 'passed', 'linux-account': 'passed' },
})
const principal = { kind: 'root' as const, id: 'fixture-root', username: 'root' }

const accountsHtml = (): string => {
  installBoardGateFixture({ accountsPort: whmAccountsFixture() })
  try {
    return renderWebApp({
      surface: 'xwhm',
      locale: 'en',
      theme: 'light',
      activeRoute: '/whm/accounts',
      realtimeEnabled: false,
      visibility: { principal },
      catalog,
      whm: {
        principal,
        hostname: 'panel.example.test',
        version: '0.0.0',
        generationId: 1,
        plans: [],
        resellers: [],
        accounts: [],
      },
    })
  } finally {
    installBoardGateFixture(undefined)
  }
}

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

const gateServer = path.join(import.meta.dirname, '../../test/gate/static-server.mjs')

const serveChild = (args: string[]) => new Promise<{ port: number; pid: number; close: () => void }>((resolve, reject) => {
  const child = spawn(process.execPath, [gateServer, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  let settled = false
  const fail = (message: string) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    child.kill()
    reject(new Error(message))
  }
  const timer = setTimeout(() => fail(`gate server did not listen: ${text}`), 5000)
  child.stdout.on('data', (chunk: Buffer) => {
    text += chunk.toString()
    const match = /PORT (\d+)/.exec(text)
    const port = match?.[1]
    if (port) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ port: Number(port), pid: child.pid ?? 0, close: () => { child.kill() } })
    }
  })
  child.stderr.on('data', (chunk: Buffer) => { text += chunk.toString() })
  child.on('exit', (code) => { if (!/PORT \d+/.test(text)) fail(`gate server exited ${code}: ${text}`) })
})

const fetchBody = (url: string) => new Promise<Buffer>((resolve, reject) => {
  httpGet(url, (res) => {
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.on('end', () => resolve(Buffer.concat(chunks)))
  }).on('error', reject)
})

const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex')

describe('accounts board gate', () => {
  it('shows the board sample only through the gate slot', () => {
    const html = accountsHtml()
    assert.match(html, /data-surface="xwhm"/)
    assert.match(html, /data-board-port="xwhm-accounts"/)
    assert.match(html, /omar-clinic\.net/)
    assert.equal(html.includes('data-dc-tpl'), false)
    assert.equal(html.includes('id="dc-root"'), false)
    const plain = renderWebApp({
      surface: 'xwhm',
      locale: 'en',
      theme: 'light',
      activeRoute: '/whm/accounts',
      realtimeEnabled: false,
      visibility: { principal },
      catalog,
      whm: Object.assign({
        principal,
        hostname: 'panel.example.test',
        version: '0.0.0',
        generationId: 1,
        plans: [],
        resellers: [],
        accounts: [],
      }, { accountsPort: whmAccountsFixture() }),
    })
    assert.equal(plain.includes('omar-clinic.net'), false)
  })

  it.skipIf(chromeExecutable === undefined || !existsSync(path.join(designRoot, boardFolder, boardFile)))('passes the strict gate on the product route', async () => {
    await mkdir(outDir, { recursive: true })
    const html = accountsHtml()
    const pageFile = path.join(outDir, 'pages.json')
    await writeFile(pageFile, JSON.stringify({
      [route]: html,
      [`${route}&gate=pad`]: padPort(html, 'xwhm-accounts'),
    }))
    const appServer = await serveChild(['map', pageFile])
    const boardServer = await serveChild(['dir', path.join(designRoot, boardFolder), boardFile])
    const browser = await (chromium as unknown as { launch: (options: { executablePath: string; args: string[] }) => Promise<Browser> }).launch({
      executablePath: chromeExecutable as string,
      args: ['--font-render-hinting=none', '--disable-lcd-text'],
    })
    try {
      const shoot = async (url: string, product: boolean) => {
        const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
        await page.goto(url, { waitUntil: 'networkidle' })
        if (!product) await page.waitForSelector('#dc-root', { timeout: 8000 })
        await page.waitForSelector('text=omar-clinic.net', { timeout: 8000 }).catch(() => undefined)
        const facts = await page.evaluate(() => ({
          surface: document.documentElement.getAttribute('data-surface'),
          port: document.querySelector('[data-board-port]')?.getAttribute('data-board-port') ?? '',
          dcTpl: document.querySelectorAll('[data-dc-tpl]').length,
          dcRoot: document.getElementById('dc-root') ? 1 : 0,
          xdc: document.querySelector('x-dc') ? 1 : 0,
          scName: document.querySelectorAll('[data-sc-name]').length,
          dom: document.documentElement.outerHTML,
        }))
        await page.evaluate(async () => {
          document.documentElement.style.overflow = 'hidden'
          document.body.style.overflow = 'hidden'
          if (document.fonts) await document.fonts.ready
        })
        await page.waitForTimeout(400)
        const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: viewport.width, height: viewport.height } })
        await page.close()
        return { png, facts }
      }
      const boardUrl = `http://127.0.0.1:${boardServer.port}/${encodeURI(boardFile)}`
      const appUrl = `http://127.0.0.1:${appServer.port}${route}`
      const board = await shoot(boardUrl, false)
      const app = await shoot(appUrl, true)
      const padded = await shoot(`http://127.0.0.1:${appServer.port}${route}&gate=pad`, true)
      const boardResponse = await fetchBody(boardUrl)
      const appResponse = await fetchBody(appUrl)
      assert.equal(app.facts.surface, 'xwhm')
      assert.equal(app.facts.port, 'xwhm-accounts')
      assert.equal(app.facts.dcTpl, 0)
      assert.equal(app.facts.dcRoot, 0)
      assert.equal(app.facts.xdc, 0)
      assert.equal(app.facts.scName, 0)
      assert.equal(board.facts.dcRoot, 1)
      assert.notEqual(boardServer.pid, appServer.pid)
      assert.notEqual(boardServer.port, appServer.port)
      assert.notEqual(sha256(boardResponse), sha256(appResponse))
      assert.notEqual(sha256(board.facts.dom), sha256(app.facts.dom))
      const score = scoreGate(board.png, app.png)
      const negative = scoreGate(app.png, padded.png)
      const accepted = gateAccepts({ score, board: board.png, app: app.png, negativePass: negative.pass })
      await writeFile(path.join(outDir, 'accounts-board.png'), board.png)
      await writeFile(path.join(outDir, 'accounts-app.png'), app.png)
      await writeFile(path.join(outDir, 'accounts-diff.png'), score.diff)
      await writeFile(path.join(outDir, 'report.json'), JSON.stringify({
        diff: `${(score.ratio * 100).toFixed(2)}%`,
        worstTile: { ...score.worstTile, diff: `${(score.worstTile.ratio * 100).toFixed(2)}%` },
        pass: score.pass,
        accepted,
        byteIdentical: sameCapture(board.png, app.png),
        negative: `${(negative.ratio * 100).toFixed(2)}%`,
        negativePass: negative.pass,
        sha256: { board: sha256(board.png), app: sha256(app.png) },
        capture: {
          board: { pid: boardServer.pid, url: boardUrl, responseSha256: sha256(boardResponse), domSha256: sha256(board.facts.dom) },
          app: { pid: appServer.pid, url: appUrl, responseSha256: sha256(appResponse), domSha256: sha256(app.facts.dom) },
        },
      }, null, 2))
      assert.equal(negative.pass, false, `1px pad must fail, got ${(negative.ratio * 100).toFixed(2)}%`)
      assert.equal(score.pass, true, `page ${(score.ratio * 100).toFixed(2)}% tile ${(score.worstTile.ratio * 100).toFixed(2)}% at ${score.worstTile.x},${score.worstTile.y}`)
      assert.equal(sameCapture(board.png, app.png), false)
      assert.equal(accepted, true)
    } finally {
      await browser.close()
      boardServer.close()
      appServer.close()
    }
  }, 180_000)
})
