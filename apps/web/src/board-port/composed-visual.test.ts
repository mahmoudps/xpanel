import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'vitest'
import { defaultPlan, type Account, type Domain, type ServiceUser } from '@xpanel/core'
import playwright from '../../../../node_modules/@playwright/test/index.js'
import { COMPOSED_ROUTES } from './composed-pages.ts'
import { renderPanelSurface } from '../surfaces/xpanel.ts'
import { renderWebApp } from '../app.ts'
import { DESIGN_TOKENS_CSS } from '../tokens.ts'

const chrome = [process.env.CHROME_PATH, '/opt/google/chrome/chrome'].find(candidate => candidate && existsSync(candidate))
const { chromium } = playwright
const outDir = process.env.XP_COMPOSED_OUT ?? '/tmp/composed-shots'

const plan = defaultPlan({ id: 'shot-plan', name: 'Synthetic plan', featureListId: 'shot-features' })
const account: Account = {
  id: 'shot-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test',
  planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@alice.example.test',
  ipv4: '192.0.2.21', ipv6: null, shell: 'none', createdAt: '2026-10-22T14:05:00Z',
}
const domain: Domain = {
  id: 'shot-domain', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null,
  docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ipv4: account.ipv4, ipv6: null,
}
const mailbox: ServiceUser = {
  id: 'shot-user', accountId: account.id, login: 'info@alice.example.test', services: { email: true, ftp: true, webdisk: false },
  mailboxQuotaMb: 1024, ftpDir: 'public_html',
}

const documentFor = (locale: 'en' | 'ar', route: string): string => {
  const body = renderPanelSurface({
    locale, theme: 'light', activeRoute: route, account, plan, domains: [domain], serviceUsers: [mailbox],
    visibility: { principal: { kind: 'user', id: 'shot-user', username: 'alice', accountId: account.id } },
  })
  return `<!doctype html><html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}" data-theme="light"><head><meta charset="utf-8"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Arabic:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet"><style>${DESIGN_TOKENS_CSS}</style></head><body>${body}</body></html>`
}

const statusDocument = (locale: 'en' | 'ar', status: 403 | 404 | 421 | 500 | 503): string => renderWebApp({
  surface: 'xpanel', locale, theme: 'light',
  error: { status, path: '/missing', surface: 'xpanel' },
})

interface Page {
  setContent: (html: string, options: { waitUntil: 'domcontentloaded' }) => Promise<void>
  setViewportSize: (size: { width: number; height: number }) => Promise<void>
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>
  screenshot: (options: { type: 'png'; fullPage: boolean }) => Promise<Buffer>
  close: () => Promise<void>
}
interface Browser {
  newPage: (options: { viewport: { width: number; height: number }; deviceScaleFactor: number }) => Promise<Page>
  close: () => Promise<void>
}

describe('composed page visual check', () => {
  it.skipIf(chrome === undefined)('fits 1280 and 390 in English and Arabic', async () => {
    await mkdir(outDir, { recursive: true })
    const browser = await (chromium as unknown as { launch: (options: { executablePath: string; args: string[] }) => Promise<Browser> }).launch({
      executablePath: chrome as string,
      args: ['--font-render-hinting=none', '--disable-lcd-text'],
    })
    const pages: Array<[string, string]> = [
      ...COMPOSED_ROUTES.flatMap(route => (['en', 'ar'] as const).map(locale => [`${route.slice(1).replaceAll('/', '-')}-${locale}`, documentFor(locale, route)] as [string, string])),
      ...([403, 404, 421, 500, 503] as const).flatMap(status => (['en', 'ar'] as const).map(locale => [`status-${status}-${locale}`, statusDocument(locale, status)] as [string, string])),
    ]
    const overflows: string[] = []
    try {
      for (const [name, html] of pages) {
        for (const width of [1280, 390] as const) {
          const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 1 })
          await page.setContent(html, { waitUntil: 'domcontentloaded' })
          await page.evaluate(async () => { if (document.fonts) await document.fonts.ready })
          const box = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
          }))
          if (box.scroll > box.client + 1) overflows.push(`${name}@${width} ${box.scroll}>${box.client}`)
          const png = await page.screenshot({ type: 'png', fullPage: true })
          await writeFile(path.join(outDir, `${name}-${width}.png`), png)
          await page.close()
        }
      }
    } finally {
      await browser.close()
    }
    assert.deepEqual(overflows, [])
  }, 180_000)
})
