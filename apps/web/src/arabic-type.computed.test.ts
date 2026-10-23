import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { ARABIC_TYPE_CSS } from './arabic-type.ts'
import { renderFidelityDocument as renderDashboard } from './board-port/xwhm-dashboard.ts'
import { renderFidelityDocument as renderHome } from './board-port/xpanel-home.fixture.ts'
import playwright from '../../../node_modules/@playwright/test/index.js'

interface Browser {
  newPage: (options: { viewport: { width: number; height: number }; deviceScaleFactor: number }) => Promise<Page>
  close: () => Promise<void>
}
interface Page {
  setContent: (html: string, options: { waitUntil: 'domcontentloaded' }) => Promise<void>
  evaluate: <T>(fn: () => T) => Promise<T>
  close: () => Promise<void>
}
const chromium = (playwright as unknown as { chromium: { launch: (options: { executablePath: string; args: string[] }) => Promise<Browser> } }).chromium

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

interface DomEl {
  textContent: string | null
  scrollWidth: number
  clientWidth: number
  firstChild: { data: string } | null
  getClientRects: () => ArrayLike<unknown>
  querySelector: (selector: string) => DomEl | null
}
interface DomStyle { fontSize: string; lineHeight: string; fontFamily: string }
interface DomRange {
  setStart: (node: unknown, offset: number) => void
  setEnd: (node: unknown, offset: number) => void
  getBoundingClientRect: () => { left: number }
}
interface Dom {
  document: {
    querySelector: (selector: string) => DomEl | null
    querySelectorAll: (selector: string) => ArrayLike<DomEl>
    createRange: () => DomRange
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
  const name = row?.querySelector('a > span:not([aria-hidden="true"])') ?? null
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

const open = async (browser: Browser, html: string): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'domcontentloaded' })
  return page
}

describe('Arabic computed type', () => {
  it('keeps body and nav at least 14.5px and labels at least 12.5px', async () => {
    const browser = await chromium.launch({
      executablePath: '/opt/google/chrome/chrome',
      args: ['--font-render-hinting=none', '--disable-lcd-text'],
    })
    try {
      const pages = [
        ['home', await open(browser, renderHome('ar'))],
        ['dashboard', await open(browser, renderDashboard('rtl'))],
        ['inbox', await open(browser, inboxDocument())],
      ] as const
      const measured: Sample[] = []
      let home = pages[0][1]
      for (const [screen, page] of pages) {
        if (screen === 'home') home = page
        const box = await page.evaluate(sample)
        box.screen = screen
        measured.push(box)
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
})
