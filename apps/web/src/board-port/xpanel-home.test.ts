import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan } from '@xpanel/core'
import { renderPanelSurface } from '../surfaces/xpanel.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { renderXpanelHome, xpanelHomeFromProps } from './xpanel-home.ts'
import { renderFidelityDocument } from './xpanel-home.fixture.ts'

const account = {
  id: 'home-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice-shop.com',
  planId: 'plan', ownerId: null, status: 'active' as const, suspendReason: null, contactEmail: 'owner@alice-shop.com',
  ipv4: '10.0.0.21', ipv6: null, shell: 'none' as const, createdAt: '2026-10-22T14:05:00Z',
}

describe('xPanel home board port', () => {
  it('keeps the English fixture free of bidi markup and on the board chrome', () => {
    const html = renderFidelityDocument('ltr')
    assert.equal(html.includes('<bdi'), false)
    assert.equal(html.includes('dir="rtl"'), false)
    assert.equal(html.includes('box-shadow'), false)
    assert.match(html, /35 tools in 9 groups/)
    assert.match(html, /Generation 142 · 2026-10-22 13:52 UTC/)
    assert.match(html, /aria-label="xPanel navigation"/)
    assert.match(html, /<h1 style="margin: 0; font-size: 22px; font-weight: 600">Home<\/h1>/)
    assert.match(html, /Your plan’s feature list decides which tools appear here\./)
  })

  it('matches the Arabic board’s isolates, active edge, and counted tools', () => {
    const html = renderFidelityDocument('ar')
    for (const marker of [
      'dir="rtl"',
      'تنقل xPanel',
      '<bdi dir="ltr" style="font-family: \'IBM Plex Mono\', monospace; font-size: 17px; font-weight: 500; color: #1D5BD6">xPanel</bdi>',
      '<bdi dir="ltr">alice · uid 20014</bdi>',
      '<bdi dir="ltr" style="color: #344054; font-weight: 500; font-variant-numeric: tabular-nums">3.2 / 10 GB</bdi>',
      'inset -3px 0 0 #1D5BD6',
      '35 أداة في 9 مجموعات',
      'الرئيسية',
      'scaleX(-1)',
      'dir="auto"',
      'font-size: 12px; font-weight: 600; color: #5D6B7E',
    ]) assert.ok(html.includes(marker), marker)
    assert.equal(html.includes('>Home<'), false)
    assert.equal(html.includes('letter-spacing: 0.02em'), false)
  })

  it('keeps the phone fixture closed, with Files expanded and its own meter order', () => {
    const html = renderFidelityDocument('phone')
    assert.match(html, /aria-expanded="false"/)
    assert.match(html, />35 tools</)
    assert.doesNotMatch(html, /35 tools in 9 groups/)
    const bandwidth = html.indexOf('Monthly bandwidth')
    const disk = html.indexOf('>Disk<')
    assert.ok(bandwidth > 0 && bandwidth < disk)
    assert.match(html, /id="m-group-tools-0" data-tool-panel="true" style="display: flex/)
    assert.match(html, /id="m-group-tools-1" data-tool-panel="true" style="display: none/)
    assert.match(html, /<template id="xpanel-home-drawer">/)
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1)
    assert.equal(html.includes('<bdi'), false)
  })

  it('binds the account and leaves unknown usage empty', () => {
    const plan = defaultPlan({ id: 'plan', name: 'Synthetic plan', featureListId: 'features' })
    const html = renderPanelSurface({
      account, plan, activeRoute: '/home',
      domains: [{ id: 'd', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
        php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ipv4: account.ipv4, ipv6: null }],
      databases: [{ id: 'db', accountId: account.id, engine: 'mariadb', name: 'alice_fixture', trashedAt: null }],
      serviceUsers: [{ id: 'u', accountId: account.id, login: 'info@alice-shop.com', services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 1024, ftpDir: 'public_html' }],
      files: [{ name: 'trashed-fixture.txt', path: '/home/alice/.trash/trashed-fixture.txt', kind: 'file', sizeBytes: 64, modeOctal: '0640', modifiedAt: '2026-10-22T14:05:00Z', trashed: true }],
      dnsRecords: [{ id: 'dns', zone: account.primaryDomain, name: '@', type: 'A', ttl: 3600, content: account.ipv4, priority: null }],
    })
    const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(match => match[1]!.replace(/<[^>]*>/g, '').trim())
    assert.deepEqual(headings, ['Home'])
    assert.match(html, /data-board-port="xpanel-home"/)
    assert.match(html, /data-resource-metrics="unavailable"/)
    assert.match(html, /10\.0\.0\.21/)
    assert.match(html, /Synthetic plan/)
    assert.match(html, /8\.3 · PHP-FPM/)
    assert.match(html, /— \/ 5 GB/)
    assert.match(html, /1 \/ 10/)
    assert.doesNotMatch(html, /3\.2 \/ 10 GB|Generation 142|alice-blog\.net|orders@alice-shop\.com|1,431|10\.0\.0\.12|data-generation-chip=/)
    assert.doesNotMatch(html, /[\u0660-\u0669\u06f0-\u06f9]/)
    const emptyHtml = renderXpanelHome(xpanelHomeFromProps({
      locale: 'ar',
      account: { username: 'owner', uid: 1000, home: '/home/owner', primaryDomain: 'example.test', ipv4: '192.0.2.10' },
      actionHtml: '<section data-action-state="conflict" data-preserve-draft="true"><bdi dir="ltr">JOB-000077</bdi></section>',
    }))
    assert.match(emptyHtml, /data-action-state="conflict"/)
    assert.match(emptyHtml, /<bdi dir="ltr">JOB-000077<\/bdi>/)
    assert.match(emptyHtml, /لا تغييرات مسجّلة لهذا الحساب بعد\./)
    assert.equal((emptyHtml.match(/<h1\b/g) ?? []).length, 1)
  })

  it('lists unqualified tools as disabled coming-soon rows and keeps qualified ones linked', () => {
    const qualified = new Set(['/files/manager', '/mail/inbox'])
    const html = renderXpanelHome(xpanelHomeFromProps({
      locale: 'en',
      account: { username: 'owner', uid: 1000, home: '/home/owner', primaryDomain: 'example.test', ipv4: '192.0.2.10' },
      qualifiedRoutes: qualified,
      signOutLabel: 'Sign out',
    }))
    const rows = (source: string) => source.match(/<li data-tool="true"[\s\S]*?<\/li>/g)?.join('\n') ?? ''
    const tools = rows(html)
    assert.match(html, /35 tools in 9 groups/)
    assert.match(tools, /<a href="\/files\/manager"/)
    assert.match(tools, /<a href="\/mail\/inbox"/)
    assert.match(tools, /<a href="\/security\/account"/)
    assert.match(html, /href="\?lang=ar"/)
    assert.match(html, /data-action="logout"/)
    assert.match(tools, /aria-disabled="true"/)
    assert.match(tools, />Coming soon</)
    assert.match(tools, /data-tool-wiring="soon"/)
    assert.doesNotMatch(tools, /<a href="\/files\/backup"/)
    const arabic = renderXpanelHome(xpanelHomeFromProps({
      locale: 'ar',
      account: { username: 'owner', uid: 1000, home: '/home/owner', primaryDomain: 'example.test', ipv4: '192.0.2.10' },
      qualifiedRoutes: new Set(),
    }))
    const arabicTools = rows(arabic)
    assert.match(arabicTools, /قيد التفعيل/)
    assert.match(arabic, /35 أداة في 9 مجموعات/)
    assert.match(arabicTools, /<a href="\/security\/account"/)
    assert.doesNotMatch(arabicTools, /<a href="\/files\/manager"/)
    const specimen = renderFidelityDocument('ltr')
    assert.doesNotMatch(specimen, /aria-disabled="true"|Coming soon/)
  })
  it('keeps board sample data out of product code', () => {
    for (const name of ['./xpanel-home.ts', './xmail-inbox.ts', './xmail-compose.ts', './xwhm-account-create.ts']) {
      const product = readFileSync(new URL(name, import.meta.url), 'utf8')
      for (const sample of ['alice-shop.com', '198.51.100.24', '1,431 today', 'Generation 142']) assert.ok(!product.includes(sample), `${name}: ${sample}`)
    }
    const create = readFileSync(new URL('./xwhm-account-create.ts', import.meta.url), 'utf8')
    for (const sample of ['salma-studio.com', 'salma.haddad@example.org', 'q7Vt-Lm2x-Rk9p-Hd4w', '10.0.0.12', '10.0.0.21', 'xpanel-20017.slice', 'Generation 143', 'Generation 142', 'srv1.xpanel.test', 'v1.4.2', 'reseller1']) {
      assert.ok(!create.includes(sample), sample)
    }
    const scripts = new URL('../../../../scripts/', import.meta.url)
    for (const entry of readdirSync(scripts).filter(entry => entry.startsWith('board-fidelity-'))) {
      const text = readFileSync(new URL(entry, scripts), 'utf8')
      for (const privatePath of ['/cursor/stores', '/opt/cursor']) assert.ok(!text.includes(privatePath), `${entry}: ${privatePath}`)
    }
    const src = new URL('../', import.meta.url)
    const walk = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? walk(new URL(entry.name + '/', dir))
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.fixture.ts') ? [new URL(entry.name, dir).pathname] : [])
    const importers = walk(src).filter(file => /from '[^']*\.fixture\.ts'/.test(readFileSync(decodeURIComponent(file).replace(/^\/([A-Za-z]:)/, '$1'), 'utf8')))
    assert.deepEqual(importers, [])
  })
})
