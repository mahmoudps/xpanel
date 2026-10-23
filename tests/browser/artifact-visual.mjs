// Screenshots of the current pages in English and Arabic, light and dark, desktop and mobile.
// Not part of `pnpm test`. Optional artifact frames come from XPANEL_DESIGN_ROOT (unpacked screen directories).
import { createServer } from 'node:http'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { chromium } from '@playwright/test'
import { serveWebUi } from '../../apps/web/src/index.ts'
import { createVisualFixture } from './visual-fixture.mjs'

const output = process.env.XPANEL_VISUAL_OUTPUT || 'test-results/artifact-visual'
const designRoot = process.env.XPANEL_DESIGN_ROOT || ''
const pages = [
  ['login-xpanel', 'login', 'xpanel'],
  ['login-xwhm', 'login', 'xwhm'],
  ['login-xmail', 'login', 'xmail'],
  ['xpanel-home', '/home'],
  ['xpanel-resources', '/resources'],
  ['xpanel-domains', '/domains'],
  ['xpanel-site-settings', '/domains/site-settings'],
  ['xpanel-metrics', '/metrics/traffic'],
  ['xpanel-files', '/files/manager'],
  ['xpanel-databases', '/databases/mariadb'],
  ['xpanel-email', '/email/accounts'],
  ['xpanel-dns', '/domains/zone-editor'],
  ['xpanel-ssl', '/security/ssl'],
  ['xpanel-security', '/security/account'],
  ['xwhm-dashboard', '/whm'],
  ['xwhm-accounts', '/whm/accounts'],
  ['xwhm-create', '/whm/accounts/new'],
  ['xwhm-plans', '/whm/plans'],
  ['xwhm-security', '/whm/security/sign-in'],
  ['xmail-inbox', '/mail/inbox'],
  ['xmail-compose', '/mail/compose'],
  ['status-403', 'status', 403],
  ['status-404', 'status', 404],
  ['status-421', 'status', 421],
  ['status-500', 'status', 500],
  ['status-503', 'status', 503],
]
const locales = ['en', 'ar']
const themes = ['light', 'dark']
const viewports = [{ id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 390, height: 844 }]
const pairs = [
  ['xPanel home', 'Home — xPanel', 'xpanel-home-en-light-desktop'],
  ['xPanel home, Arabic', 'الرئيسية — xPanel', 'xpanel-home-ar-light-desktop'],
  ['xPanel home, phone', 'Home on phone — xPanel', 'xpanel-home-en-light-mobile'],
  ['Resources', 'Resources & quotas — xPanel', 'xpanel-resources-en-light-desktop'],
  ['Domains', 'Domains — xPanel', 'xpanel-domains-en-light-desktop'],
  ['Site settings', 'Site settings — xPanel', 'xpanel-site-settings-en-light-desktop'],
  ['Metrics', 'Metrics — xPanel', 'xpanel-metrics-en-light-desktop'],
  ['File manager', 'File manager — xPanel', 'xpanel-files-en-light-desktop'],
  ['Databases', 'MariaDB — xPanel', 'xpanel-databases-en-light-desktop'],
  ['Email accounts', 'Email & users — xPanel', 'xpanel-email-en-light-desktop'],
  ['DNS zone', 'Zone editor — xPanel', 'xpanel-dns-en-light-desktop'],
  ['SSL', 'SSL/TLS — xPanel', 'xpanel-ssl-en-light-desktop'],
  ['Account security', 'Security — xPanel', 'xpanel-security-en-light-desktop'],
  ['Sign in', 'Sign in — xPanel', 'login-xpanel-en-light-desktop'],
  ['Server dashboard', 'Server dashboard — xWHM', 'xwhm-dashboard-en-light-desktop'],
  ['Accounts', 'Accounts — xWHM', 'xwhm-accounts-en-light-desktop'],
  ['Create account', 'Create account — xWHM', 'xwhm-create-en-light-desktop'],
  ['Plans', 'Plans — xWHM', 'xwhm-plans-en-light-desktop'],
  ['Sign-in security', 'Panel security — xWHM', 'xwhm-security-en-light-desktop'],
  ['Inbox', 'Inbox — xMail', 'xmail-inbox-en-light-desktop'],
  ['Compose', 'Compose — xMail', 'xmail-compose-en-light-desktop'],
]

const decode = value => value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function createContextServer(documents) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1')
      if (url.pathname.startsWith('/assets/') || url.pathname === '/favicon.ico') {
        const response = await serveWebUi(new Request(url))
        outgoing.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'text/plain', 'cache-control': 'no-store' })
        outgoing.end(Buffer.from(await response.arrayBuffer()))
        return
      }
      if (url.pathname.startsWith('/artifact/')) {
        const html = documents.get(decodeURIComponent(url.pathname.slice('/artifact/'.length)))
        outgoing.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        outgoing.end(html ?? 'Missing artifact frame')
        return
      }
      const locale = url.searchParams.get('lang') === 'ar' ? 'ar' : 'en'
      const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'
      const audience = url.searchParams.get('audience')
      const status = Number(url.pathname.split('/')[2])
      const state = url.pathname.startsWith('/status/')
        ? { surface: 'xpanel', locale, theme, realtimeEnabled: false, activeRoute: '/missing', error: { status } }
        : { surface: 'login', locale, theme, realtimeEnabled: false, login: { audience, targetSurface: audience } }
      const response = await serveWebUi(new Request(url), () => state)
      const body = await response.text()
      outgoing.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      outgoing.end(body)
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      outgoing.end('Visual context server failed')
    }
  })
  return { baseUrl: await listen(server), close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

function artifactDocuments(root) {
  const documents = new Map()
  const titles = new Map()
  const visit = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) visit(path)
      if (name !== 'index.html' || dir === root) continue
      const html = readFileSync(path, 'utf8')
      const title = decode((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim()
      if (!title || titles.has(title)) continue
      const style = [...html.matchAll(/<style>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n')
      const inner = (html.match(/<x-dc>([\s\S]*)<\/x-dc>/i) || [, html])[1].replace(/<helmet>[\s\S]*?<\/helmet>/i, '')
      const id = `frame-${titles.size}`
      titles.set(title, id)
      documents.set(id, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"><style>html,body{margin:0} x-dc{display:block} ${style}</style></head><body>${inner}</body></html>`)
    }
  }
  if (root) visit(root)
  return { documents, titles }
}

async function shoot(page, url, file, viewport) {
  await page.setViewportSize(viewport)
  await page.goto(url, { waitUntil: 'load', timeout: 30000 })
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 2500))]))
  mkdirSync(dirname(file), { recursive: true })
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' })
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome' })
const fixture = await createVisualFixture()
const { documents, titles } = artifactDocuments(designRoot)
const extra = await createContextServer(documents)
const page = await browser.newPage()
const manifest = []
try {
  for (const [id, route, extraValue] of pages) {
    for (const locale of locales) {
      for (const theme of themes) {
        for (const viewport of viewports) {
          const name = `${id}-${locale}-${theme}-${viewport.id}.png`
          const file = join(output, 'implementation', name)
          const query = `lang=${locale}&theme=${theme}`
          const url = route === 'login'
            ? `${extra.baseUrl}/login?audience=${extraValue}&${query}`
            : route === 'status'
              ? `${extra.baseUrl}/status/${extraValue}?${query}`
              : `${fixture.baseUrl}${route}?${query}`
          await shoot(page, url, file, viewport)
          manifest.push({ kind: 'implementation', id, locale, theme, viewport: viewport.id, file })
        }
      }
    }
  }
  if (designRoot) {
    for (const [title, id] of titles) {
      const file = join(output, 'artifact', `${id}.png`)
      await shoot(page, `${extra.baseUrl}/artifact/${encodeURIComponent(id)}`, file, { width: title.includes('phone') ? 390 : 1440, height: 900 })
      manifest.push({ kind: 'artifact', title, id, file })
    }
    for (const [label, artifactTitle, implName] of pairs) {
      const artifactId = titles.get(artifactTitle)
      if (!artifactId) {
        manifest.push({ kind: 'pair-missing', label, artifactTitle })
        continue
      }
      const file = join(output, 'compare', `${implName}.png`)
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#111827;color:#fff;font:14px/1.4 sans-serif} .row{display:flex;gap:12px;padding:12px;align-items:flex-start} figure{margin:0;flex:1;min-width:0} img{width:100%;height:auto;background:#fff} figcaption{margin:0 0 8px}</style></head><body><div class="row"><figure><figcaption>Artifact — ${label}</figcaption><img src="/artifact/${encodeURIComponent(artifactId)}"></figure><figure><figcaption>Implementation — ${label}</figcaption><img src="/impl/${implName}"></figure></div></body></html>`
      documents.set(`compare-${implName}`, html)
    }
  }
  await page.close()
} finally {
  await browser.close()
  await fixture.close()
  await extra.close()
}

if (designRoot) {
  const compareBrowser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome' })
  const comparePage = await compareBrowser.newPage({ viewport: { width: 1600, height: 1000 } })
  const compareServer = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/artifact/')) {
      const file = join(output, 'artifact', `${decodeURIComponent(url.pathname.slice('/artifact/'.length))}.png`)
      outgoing.writeHead(200, { 'content-type': 'image/png' })
      outgoing.end(readFileSync(file))
      return
    }
    if (url.pathname.startsWith('/impl/')) {
      const file = join(output, 'implementation', `${decodeURIComponent(url.pathname.slice('/impl/'.length))}.png`)
      outgoing.writeHead(200, { 'content-type': 'image/png' })
      outgoing.end(readFileSync(file))
      return
    }
    const html = documents.get(decodeURIComponent(url.pathname.slice(1)))
    outgoing.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    outgoing.end(html ?? 'Missing comparison')
  })
  const compareBase = await listen(compareServer)
  try {
    for (const [label, artifactTitle, implName] of pairs) {
      if (!titles.get(artifactTitle)) continue
      const file = join(output, 'compare', `${implName}.png`)
      await comparePage.setViewportSize({ width: 1800, height: 1200 })
      await comparePage.goto(`${compareBase}/compare-${encodeURIComponent(implName)}`, { waitUntil: 'load', timeout: 30000 })
      await comparePage.waitForTimeout(300)
      mkdirSync(dirname(file), { recursive: true })
      await comparePage.screenshot({ path: file, fullPage: true, animations: 'disabled' })
      manifest.push({ kind: 'compare', label, file })
    }
  } finally {
    await comparePage.close()
    await compareBrowser.close()
    await new Promise(resolve => compareServer.close(resolve))
  }
}

mkdirSync(output, { recursive: true })
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify({ output, shots: manifest.length, artifactFrames: titles.size }))
