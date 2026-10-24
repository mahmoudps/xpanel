import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { describe, it } from 'vitest'
import { ARABIC_TYPE_CSS } from './arabic-type.ts'
import { renderFidelityDocument as renderDashboard, renderWhmDashboard, whmDashboardFromProps } from './board-port/xwhm-dashboard.ts'
import { renderFidelityDocument as renderHome, renderLiveDocument as renderHomeLive } from './board-port/xpanel-home.fixture.ts'
import { renderFidelityDocument as renderInboxFidelity, renderLiveDocument as renderInboxLive } from './board-port/xmail-inbox.fixture.ts'
import { renderFidelityDocument as renderComposeFidelity, renderLiveDocument as renderComposeLive } from './board-port/xmail-compose.fixture.ts'
import { defaultPlan, type Account } from '@xpanel/core'
import { renderAccountsDocument, whmAccountsFromProps } from './board-port/xwhm-accounts.ts'
import { renderMailSurface } from './surfaces/xmail.ts'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { DESIGN_TOKENS_CSS } from './tokens.ts'
import playwright from '../../../node_modules/@playwright/test/index.js'

interface Browser {
  newPage: (options: { viewport: { width: number; height: number }; deviceScaleFactor: number }) => Promise<Page>
  close: () => Promise<void>
}
interface Page {
  setContent: (html: string, options: { waitUntil: 'domcontentloaded' }) => Promise<void>
  setViewportSize: (size: { width: number; height: number }) => Promise<void>
  evaluate: <T>(fn: () => T) => Promise<T>
  close: () => Promise<void>
}
const chromium = (playwright as unknown as { chromium: { executablePath: () => string; launch: (options: { executablePath: string; args: string[] }) => Promise<Browser> } }).chromium

/** CHROME_PATH first, then a system Chrome, then the Playwright build. The test skips only when none is installed. */
const chromeExecutable = (): string | undefined => {
  const bundled = (() => { try { return chromium.executablePath() } catch { return '' } })()
  return [process.env.CHROME_PATH, '/opt/google/chrome/chrome', bundled].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string))
}
const executable = chromeExecutable()

const inboxDocument = (): string => `<!doctype html>
<html lang="en" dir="ltr">
<head><meta charset="utf-8"></head>
<body>
<div class="xp-board-port" dir="rtl">
<style>${ARABIC_TYPE_CSS}</style>
<nav aria-label="مجلدات البريد">
  <a href="/mail/compose" style="min-height: 44px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 16px; border-radius: 8px; border: 1px solid #1D5BD6; background: #1D5BD6; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none">إنشاء رسالة</a>
  <ul style="list-style: none; margin: 0; padding: 0">
    <li><a href="/mail/inbox" aria-current="page" style="display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; font-size: 14px; font-weight: 600; color: #1D5BD6; background: #E8EFFD; text-decoration: none"><span>الوارد</span></a></li>
  </ul>
  <span id="my-folders" style="font-size: 11px; font-weight: 600; color: #5D6B7E; padding: 0 12px 4px">مجلداتك</span>
  <span id="mbx-settings" style="font-size: 11px; font-weight: 600; color: #5D6B7E; padding: 0 12px 4px">إعدادات الصندوق</span>
</nav>
<p style="margin: 0; font-size: 14px; font-weight: 600">لم تُقرأ الرسائل من خادم البريد بعد.</p>
<p style="margin: 0; font-size: 13px; color: #475467">نص الرسالة يظهر هنا عندما يصل من الخادم.</p>
<ul style="width: 280px; list-style: none; margin: 16px 0 0; padding: 0">
  <li data-tool="true"><a style="display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 8px; font-size: 14px; text-decoration: none; color: #101828"><span style="flex: 1 1 auto; min-width: 0; font-weight: 500">معالج النسخ الاحتياطي</span><span data-meta title="آخر نسخة 2026-10-21" dir="rtl" style="display: inline-flex; align-items: baseline; gap: 0.35em; flex: 1 1 auto; min-width: 0; font-size: 12px; color: #5D6B7E"><span data-meta-label>آخر نسخة</span><bdi data-meta-value dir="ltr" style="flex: none; flex-shrink: 0; white-space: nowrap">2026-10-21</bdi></span></a></li>
</ul>
<p style="margin: 8px 0 0; font-size: 12px; color: #5D6B7E"><bdi dir="ltr">13:48 UTC</bdi></p>
<pre style="font-family: 'IBM Plex Mono', monospace">سجل داخلي</pre>
</div>
</body>
</html>`

interface Sample {
  screen: string
  nav: number
  navLine: number
  label: number
  labelText: string
  body: number
  bodyLine: number
  face: string
}

interface DomBox { left: number; right: number; width: number; height: number }
interface DomNode { nodeType: number; nodeValue: string | null; textContent: string | null }
interface DomEl {
  textContent: string | null
  nodeType: number
  nodeValue: string | null
  scrollWidth: number
  clientWidth: number
  childNodes: ArrayLike<DomNode | DomEl>
  parentElement: DomEl | null
  firstChild: { data: string } | null
  getClientRects: () => ArrayLike<unknown>
  getBoundingClientRect: () => DomBox
  getAttribute: (name: string) => string | null
  querySelector: (selector: string) => DomEl | null
  querySelectorAll: (selector: string) => ArrayLike<DomEl>
}
interface DomStyle { fontSize: string; lineHeight: string; fontFamily: string; overflow: string; overflowX: string }
interface DomRange {
  setStart: (node: unknown, offset: number) => void
  setEnd: (node: unknown, offset: number) => void
  getBoundingClientRect: () => { left: number; right: number }
}
interface DomWalker { nextNode: () => { nodeValue: string | null } | null }
interface Dom {
  innerWidth: number
  document: {
    body: DomEl
    documentElement: { clientWidth: number; scrollWidth: number }
    querySelector: (selector: string) => DomEl | null
    querySelectorAll: (selector: string) => ArrayLike<DomEl>
    createRange: () => DomRange
    createTreeWalker: (root: DomEl, whatToShow: number) => DomWalker
    createElement: (tag: string) => DomEl & { style: { fontFamily: string; fontSize: string }; textContent: string }
  }
  getComputedStyle: (el: DomEl) => DomStyle
}

const sample = (): Sample => {
  const root = globalThis as unknown as Dom
  const nav = root.document.querySelector('nav a[aria-current="page"], nav a[aria-current="true"]')
  const label = root.document.querySelector('nav span[id]')
  const body = root.document.querySelector('main p, .xp-board-port > p, p')
  const read = (el: DomEl | null): { size: number; line: number } => {
    if (!el) return { size: 0, line: 0 }
    const style = root.getComputedStyle(el)
    const size = Number.parseFloat(style.fontSize)
    const line = Number.parseFloat(style.lineHeight)
    return { size, line: size > 0 ? line / size : 0 }
  }
  const navBox = read(nav)
  const bodyBox = read(body)
  const labelStyle = label ? root.getComputedStyle(label) : null
  return {
    screen: '',
    nav: navBox.size,
    navLine: navBox.line,
    label: labelStyle ? Number.parseFloat(labelStyle.fontSize) : 0,
    labelText: label?.textContent?.trim() ?? '',
    body: bodyBox.size,
    bodyLine: bodyBox.line,
    face: nav ? root.getComputedStyle(nav).fontFamily : '',
  }
}

const toolName = (): { lines: number; full: boolean; date: string; ltr: boolean } => {
  const root = globalThis as unknown as Dom
  const rows = Array.from(root.document.querySelectorAll('[data-tool="true"]'))
  const row = rows.find(item => item.textContent?.includes('معالج النسخ الاحتياطي'))
  const name = row?.querySelector('a > span:not([aria-hidden="true"]):not([data-meta])') ?? null
  const date = row?.querySelector('bdi[dir="ltr"]') ?? null
  const text = date?.firstChild
  if (!name || !date || !text) return { lines: 0, full: false, date: '', ltr: false }
  const range = root.document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 1)
  const first = range.getBoundingClientRect().left
  range.setStart(text, Math.max(0, text.data.length - 1))
  range.setEnd(text, text.data.length)
  const last = range.getBoundingClientRect().left
  return {
    lines: name.getClientRects().length,
    full: name.scrollWidth <= name.clientWidth + 1,
    date: date.textContent ?? '',
    ltr: first < last,
  }
}

const backupDate = (): { text: string; title: string; clipped: boolean; inside: boolean } => {
  const root = globalThis as unknown as Dom
  const row = Array.from(root.document.querySelectorAll('[data-tool="true"]')).find(item => item.textContent?.includes('معالج النسخ الاحتياطي'))
  const meta = row?.querySelector('[data-meta]') ?? null
  const date = row?.querySelector('[data-meta-value]') ?? null
  const anchor = row?.querySelector('a') ?? null
  if (!meta || !date || !anchor) return { text: '', title: '', clipped: true, inside: false }
  const dateBox = date.getBoundingClientRect()
  const rowBox = anchor.getBoundingClientRect()
  return {
    text: (date.textContent ?? '').trim(),
    title: meta.getAttribute('title') ?? '',
    clipped: date.scrollWidth > date.clientWidth + 1,
    inside: dateBox.width > 40 && dateBox.left >= rowBox.left - 1 && dateBox.right <= rowBox.right + 1,
  }
}

const valueClip = (): { count: number; clipped: string[] } => {
  const root = globalThis as unknown as Dom
  const nodes = Array.from(root.document.querySelectorAll('bdi[dir="ltr"], [data-meta-value]'))
  const clipped: string[] = []
  for (const node of nodes) {
    const box = node.getBoundingClientRect()
    let hidden = node.scrollWidth > node.clientWidth + 1
    let parent = node.parentElement
    while (!hidden && parent) {
      const style = root.getComputedStyle(parent)
      if (/auto|scroll|hidden|clip/.test(`${style.overflowX} ${style.overflow}`)) {
        const host = parent.getBoundingClientRect()
        hidden = box.width > 0 && (box.left < host.left - 1 || box.right > host.right + 1)
      }
      parent = parent.parentElement
    }
    if (hidden) clipped.push((node.textContent ?? '').trim())
  }
  return { count: nodes.length, clipped }
}

const headers = (): { count: number; hidden: string[] } => {
  const root = globalThis as unknown as Dom
  const view = root.document.documentElement.clientWidth
  const hidden: string[] = []
  const nodes = Array.from(root.document.querySelectorAll('th'))
  for (const th of nodes) {
    const box = th.getBoundingClientRect()
    const visible = box.width > 8 && box.height > 8 && box.left >= -1 && box.right <= view + 1
    if (!visible) hidden.push((th.textContent ?? '').trim())
  }
  return { count: nodes.length, hidden }
}

const auditShape = (): { rows: number[]; cells: number[]; pills: number[] } => {
  const root = globalThis as unknown as Dom
  const rows = Array.from(root.document.querySelectorAll('#audit-title'))
  const section = rows[0]?.parentElement?.parentElement
  const trs = section ? Array.from(section.querySelectorAll('tbody tr')) : []
  const tds = section ? Array.from(section.querySelectorAll('td')) : []
  const pills = section ? Array.from(section.querySelectorAll('tbody [style*="999px"]')) : []
  return {
    rows: trs.map(row => Math.round(row.getBoundingClientRect().height)),
    cells: tds.map(cell => Math.round(cell.getBoundingClientRect().height)),
    pills: pills.map(pill => Math.round(pill.getBoundingClientRect().height)),
  }
}

const monoArabic = (): string[] => {
  const root = globalThis as unknown as Dom
  const bad: string[] = []
  const walk = (el: DomEl): void => {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3 && /[\u0600-\u06FF]/.test(node.nodeValue ?? '')) {
        const font = root.getComputedStyle(el).fontFamily
        const arabicFace = font.includes('Plex Sans Arabic') || font.includes('XP Arabic In Mono')
        if (font.includes('Plex Mono') && !arabicFace) bad.push((node.nodeValue ?? '').trim().slice(0, 40))
      } else if (node.nodeType === 1) walk(node as DomEl)
    }
  }
  walk(root.document.body)
  return bad
}

const liveDashboard = (locale: 'ar' | 'en' = 'ar'): string => {
  const ar = locale === 'ar'
  const body = renderWhmDashboard(whmDashboardFromProps({
    locale,
    principal: { username: 'root' },
    nearLimits: [],
    hostSample: { engine: 'nginx 1.24.0 → Apache 2.4.58' },
    auditEntries: [
      { id: '1', at: '2026-10-22T13:48:00Z', actor: 'root', action: 'auth.login', target: 'principal:11111111-1111-4111-8111-111111111111', detail: {}, outcome: 'ok' },
      { id: '2', at: '2026-10-22T13:31:00Z', actor: 'root', action: 'mailbox.created', target: 'service-user:mbxabc', detail: {}, outcome: 'ok' },
      { id: '3', at: '2026-10-22T13:02:00Z', actor: 'alice', action: 'account.created', target: 'omar-clinic.net', detail: {}, outcome: 'ok' },
      { id: '4', at: '2026-10-22T12:40:00Z', actor: 'alice', action: 'file.write', target: `/home/omar/public_html/${'invoice-'.repeat(12)}final.pdf`, detail: {}, outcome: 'ok' },
    ],
  }))
  return `<!doctype html><html lang="${ar ? 'ar' : 'en'}" dir="${ar ? 'rtl' : 'ltr'}"><head><style>body{margin:0}*{box-sizing:border-box}</style></head><body>${body}</body></html>`
}

const productDocument = (body: string, locale: 'ar' | 'en' = 'ar'): string => {
  const ar = locale === 'ar'
  return `<!doctype html><html lang="${ar ? 'ar' : 'en'}" dir="${ar ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${DESIGN_TOKENS_CSS}</style></head><body>${body}</body></html>`
}

const pageScroll = (): { scroll: number; inner: number } => {
  const root = globalThis as unknown as Dom
  return { scroll: root.document.documentElement.scrollWidth, inner: root.innerWidth }
}

const engineBox = (): { left: number; right: number; inner: number } | null => {
  const root = globalThis as unknown as Dom
  const walker = root.document.createTreeWalker(root.document.body, 4)
  let node = walker.nextNode()
  while (node) {
    const text = node.nodeValue ?? ''
    if (text.includes('nginx 1.24.0')) {
      const range = root.document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, text.length)
      const box = range.getBoundingClientRect()
      return { left: box.left, right: box.right, inner: root.innerWidth }
    }
    node = walker.nextNode()
  }
  return null
}

const longTarget = `/home/omar/public_html/${'invoice-'.repeat(12)}final.pdf`

const auditLog = (locale: 'ar' | 'en' = 'ar'): string => productDocument(renderWhmSurface({
  locale,
  principal: { kind: 'root', id: 'root', username: 'root' },
  activeRoute: '/whm/audit',
  auditEntries: [
    { id: '1', at: '2026-10-22T13:48:00Z', actor: 'root', action: 'auth.login', target: 'principal:11111111-1111-4111-8111-111111111111', detail: {}, outcome: 'ok' },
    { id: '2', at: '2026-10-22T13:31:00Z', actor: 'root', action: 'mailbox.created', target: 'service-user:mbxabc', detail: {}, outcome: 'ok' },
    { id: '3', at: '2026-10-22T13:02:00Z', actor: 'alice', action: 'file.write', target: longTarget, detail: {}, outcome: 'ok' },
  ],
}), locale)

const mailFilters = (locale: 'ar' | 'en' = 'ar'): string => productDocument(renderMailSurface({
  locale,
  mailbox: 'info@alice-shop.com',
  activeRoute: '/mail/settings/filters',
  sieveRules: [{ id: '1', name: 'أرشيف الفواتير', condition: `header :contains "Subject" "${'invoice-'.repeat(8)}"`, action: 'fileinto INBOX.Archive', enabled: true }],
}), locale)

const shapedAccount = (): Account => ({
  id: 'shaped-account',
  username: 'department.with.a.very.long.name',
  uid: 24001,
  gid: 24001,
  home: '/home/department.with.a.very.long.name',
  primaryDomain: 'department.with.a.very.long.name.alice-shop.example.test',
  planId: 'shaped-plan',
  ownerId: null,
  status: 'active',
  suspendReason: null,
  contactEmail: 'owner@department.with.a.very.long.name.alice-shop.example.test',
  ipv4: '192.0.2.10',
  extraIps: ['192.0.2.11'],
  shell: 'jailed',
  createdAt: '2026-10-22T14:05:00Z',
})

const shapedPlan = () => defaultPlan({ id: 'shaped-plan', name: 'Synthetic plan', featureListId: 'features' })

const shapedAccounts = (locale: 'ar' | 'en'): string => renderAccountsDocument(whmAccountsFromProps({
  locale,
  principal: { kind: 'root', username: 'operator' },
  isRoot: true,
  hostname: locale === 'ar' ? 'الخادم' : 'panel.example.test',
  generationId: 7,
  version: '1.0.0',
  accounts: [shapedAccount()],
  plans: [shapedPlan()],
}))

const shapedSurface = (locale: 'ar' | 'en'): string => productDocument(renderWhmSurface({
  locale,
  principal: { kind: 'root', id: 'shaped-root', username: 'operator' },
  activeRoute: '/whm/accounts',
  hostname: locale === 'ar' ? 'الخادم' : 'panel.example.test',
  generationId: 7,
  version: '1.0.0',
  accounts: [shapedAccount()],
  plans: [shapedPlan()],
}), locale)

const sentenceMono = (): string[] => {
  const root = globalThis as unknown as Dom
  const bad: string[] = []
  const walk = (el: DomEl): void => {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3 && /[\u0600-\u06FF]/.test(node.nodeValue ?? '') && !/[A-Za-z@/\\]/.test(node.nodeValue ?? '')) {
        const font = root.getComputedStyle(el).fontFamily
        const first = font.split(',')[0] ?? ''
        if (first.includes('Mono') || first.includes('monospace')) bad.push((node.nodeValue ?? '').trim().slice(0, 40))
      } else if (node.nodeType === 1) walk(node as DomEl)
    }
  }
  walk(root.document.body)
  return bad
}

const open = async (browser: Browser, html: string): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'domcontentloaded' })
  return page
}

describe('Arabic computed type', () => {
  it.skipIf(executable === undefined)('keeps body and nav at least 14.5px and labels at least 12.5px', async () => {
    const browser = await chromium.launch({
      executablePath: executable as string,
      args: ['--font-render-hinting=none', '--disable-lcd-text'],
    })
    try {
      const pages = [
        ['home', await open(browser, renderHome('ar'))],
        ['dashboard', await open(browser, renderDashboard('rtl'))],
        ['inbox', await open(browser, inboxDocument())],
        ['whm', await open(browser, liveDashboard())],
        ['audit-log', await open(browser, auditLog())],
        ['mail-filters', await open(browser, mailFilters())],
      ] as const
      const measured: Sample[] = []
      let home = pages[0][1]
      for (const [screen, page] of pages) {
        if (screen === 'home') home = page
        const box = await page.evaluate(sample)
        box.screen = screen
        measured.push(box)
        if (screen === 'audit-log' || screen === 'mail-filters') continue
        assert.ok(box.nav >= 14.5, `${screen} nav ${box.nav}px`)
        assert.ok(box.label >= 12.5, `${screen} label ${box.labelText} ${box.label}px`)
        assert.ok(box.body >= 14.5, `${screen} body ${box.body}px`)
        assert.ok(box.navLine >= 1.7, `${screen} nav line ${box.navLine}`)
        assert.ok(box.bodyLine >= 1.7, `${screen} body line ${box.bodyLine}`)
        assert.match(box.face, /IBM Plex Sans Arabic/)
      }
      const tool = await home.evaluate(toolName)
      assert.equal(tool.lines, 1)
      assert.equal(tool.full, true)
      assert.equal(tool.date, '2026-10-21')
      assert.equal(tool.ltr, true)
      const widths = [1440, 390]
      const clips: Array<{ screen: string; width: number; count: number; clipped: string[] }> = []
      for (const width of widths) {
        for (const [screen, page] of pages) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
          const clip = await page.evaluate(valueClip)
          clips.push({ screen, width, count: clip.count, clipped: clip.clipped })
          assert.ok(clip.count > 0, `${screen} at ${width} has no value node`)
          assert.deepEqual(clip.clipped, [], `${screen} at ${width} clips ${clip.clipped.join(' | ')}`)
          const head = await page.evaluate(headers)
          if (head.count > 0) assert.deepEqual(head.hidden, [], `${screen} at ${width} hides ${head.hidden.join(' | ')}`)
          const faces = await page.evaluate(monoArabic)
          assert.deepEqual(faces, [], `${screen} at ${width} paints Arabic in mono: ${faces.join(' | ')}`)
          if (screen === 'dashboard' || screen === 'whm') {
            const shape = await page.evaluate(auditShape)
            assert.ok(shape.rows.length > 0, `${screen} audit rows`)
            assert.ok(shape.pills.length > 0 && shape.pills.every(height => height >= 20 && height <= 40), `${screen} at ${width} result pills ${shape.pills.join(',')}`)
            const shortRows = shape.rows.slice(0, screen === 'whm' ? 3 : shape.rows.length)
            if (width === 1440) assert.ok(shortRows.every(height => height >= 32 && height <= 96), `${screen} at 1440 row heights ${shape.rows.join(',')}`)
            if (width === 390) {
              const ceiling = screen === 'whm' ? 160 : 96
              assert.ok(shape.cells.every(height => height >= 32 && height <= ceiling), `${screen} at 390 cell heights ${shape.cells.join(',')}`)
            }
            if (screen === 'whm' && width === 1440) {
              const wrapped = shape.rows[3] ?? 0
              assert.ok(wrapped > 48 && wrapped <= 160, `wrapped target row ${wrapped}`)
            }
          }
          if (screen === 'home' || screen === 'inbox') {
            const backup = await page.evaluate(backupDate)
            assert.equal(backup.text, '2026-10-21')
            assert.equal(backup.title, 'آخر نسخة 2026-10-21')
            assert.equal(backup.clipped, false)
            assert.equal(backup.inside, true, `${screen} at ${width} date leaves the row`)
          }
        }
      }
      console.log(JSON.stringify({ clips }))
      const ltr = await open(browser, renderHome('ltr'))
      const ltrNav = await ltr.evaluate(() => {
        const root = globalThis as unknown as Dom
        const link = root.document.querySelector('nav a[aria-current="page"]')
        return link ? Number.parseFloat(root.getComputedStyle(link).fontSize) : 0
      })
      assert.equal(ltrNav, 14)
      console.log(JSON.stringify({ measured, tool, ltrNav }))
      await ltr.close()
      for (const [, page] of pages) await page.close()
    } finally {
      await browser.close()
    }
  }, 60_000)

  it.skipIf(executable === undefined)('does not scroll sideways at 390', async () => {
    const browser = await chromium.launch({
      executablePath: executable as string,
      args: ['--font-render-hinting=none', '--disable-lcd-text'],
    })
    const screens: Array<[string, string]> = [
      ['home-ar', renderHome('ar')],
      ['home-en', renderHome('ltr')],
      ['home-phone', renderHome('phone')],
      ['home-live-ar', renderHomeLive('ar')],
      ['home-live-en', renderHomeLive('ltr')],
      ['home-live-phone', renderHomeLive('phone')],
      ['dashboard-ar', renderDashboard('rtl')],
      ['dashboard-en', renderDashboard('ltr')],
      ['whm-live-ar', liveDashboard('ar')],
      ['whm-live-en', liveDashboard('en')],
      ['inbox-ar', renderInboxLive('ar')],
      ['inbox-en', renderInboxLive('en')],
      ['inbox-fixture', renderInboxFidelity()],
      ['compose-ar', renderComposeLive('ar')],
      ['compose-en', renderComposeLive('en')],
      ['compose-fixture', renderComposeFidelity()],
      ['audit-ar', auditLog('ar')],
      ['audit-en', auditLog('en')],
      ['filters-ar', mailFilters('ar')],
      ['filters-en', mailFilters('en')],
      ['accounts-shaped-ar', shapedAccounts('ar')],
      ['accounts-shaped-en', shapedAccounts('en')],
      ['accounts-surface-ar', shapedSurface('ar')],
      ['accounts-surface-en', shapedSurface('en')],
    ]
    try {
      for (const [screen, html] of screens) {
        const page = await open(browser, html)
        await page.setViewportSize({ width: 390, height: 844 })
        const box = await page.evaluate(pageScroll)
        assert.ok(box.scroll <= box.inner, `${screen} scrolls sideways ${box.scroll} > ${box.inner}`)
        const engine = await page.evaluate(engineBox)
        if (engine) {
          assert.ok(engine.left >= -1 && engine.right <= engine.inner + 1, `${screen} engine ${engine.left}..${engine.right} in ${engine.inner}`)
        }
        if (screen.endsWith('-ar') && screen.startsWith('accounts-')) {
          const mono = await page.evaluate(sentenceMono)
          assert.deepEqual(mono, [], `${screen} Arabic sentence in mono: ${mono.join(' | ')}`)
        }
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 120_000)
})
