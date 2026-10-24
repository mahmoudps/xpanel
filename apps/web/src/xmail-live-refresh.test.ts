import { existsSync, statfsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import playwright from '@playwright/test'
import { renderInbox, xmailInboxFromProps, type XmailInboxMessageInput } from './board-port/xmail-inbox.ts'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { DESIGN_TOKENS_CSS } from './tokens.ts'

interface Locator {
  fill(value: string): Promise<void>; click(): Promise<void>; waitFor(): Promise<void>
  count(): Promise<number>; inputValue(): Promise<string>; textContent(): Promise<string | null>; getAttribute(name: string): Promise<string | null>
  evaluate<T>(fn: (element: Element) => T): Promise<T>
}
interface Route {
  request(): { url(): string; method(): string; headers(): Record<string, string>; isNavigationRequest(): boolean }
  abort(): Promise<void>; fulfill(options: { status?: number; contentType: string; body: string }): Promise<void>
}
interface Page {
  locator(selector: string): Locator; close(): Promise<void>; goto(url: string): Promise<unknown>
  evaluate<T, A = void>(fn: (argument: A) => T | Promise<T>, argument?: A): Promise<T>
  addInitScript(fn: () => void): Promise<void>; addScriptTag(options: { content: string }): Promise<unknown>
  route(pattern: string, handler: (route: Route) => Promise<void>): Promise<void>
  on(event: 'pageerror', handler: (error: Error) => void): void
  waitForTimeout(ms: number): Promise<void>; waitForFunction(fn: () => boolean): Promise<unknown>
}
interface Browser { newPage(options: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> }
const chromium = (playwright as unknown as { chromium: { executablePath(): string; launch(options: { executablePath: string; headless: boolean; args: string[] }): Promise<Browser> } }).chromium

type FixtureWindow = Window & { fixtureEmit: (kind: string, mailbox?: string) => void; fixtureRequests: Array<{ method: string; path: string }>; fixtureResolve: (value: unknown) => void; fixtureArticle: Element | null; returnedScriptRan?: boolean }
const mailbox = 'fixture@example.test'
const requireFreeSpace = (minimumMiB: number): void => {
  const space = statfsSync(process.cwd())
  if (space.bavail * space.bsize < minimumMiB * 1024 * 1024) throw new Error(`Current inbox browser proof remains unproved: fewer than ${minimumMiB} MiB are free; no screenshots or cleanup were attempted.`)
}
const message = (uid: number, subject: string): XmailInboxMessageInput => ({ uid, folder: 'Archive', from: 'sender@example.test', to: mailbox, fromName: 'Fixture sender', subject, preview: 'Loaded preview', body: 'Kept body ' + uid, receivedAt: '2026-10-24T11:00:00.000Z', unread: uid === 9, attachments: uid === 8 ? [] : [{ name: 'fixture.txt', sizeBytes: 32 }] })
const documentFor = (locale: 'en' | 'ar', fresh = false, moved = false, empty = false): string => {
  const messages = empty ? [] : fresh ? [message(9, 'New Keep'), ...(moved ? [] : [message(7, 'Keep selected')]), message(8, 'Other')] : [message(7, 'Keep selected'), message(8, 'Other')]
  if (fresh) for (const item of messages) { item.body = ''; item.bodyPending = true }
  const model = xmailInboxFromProps({ locale, mailbox, activeFolder: 'Archive', selectedUid: 7, messages, folderCounts: [{ folder: 'Archive', total: messages.length, unread: fresh ? 1 : 0 }, { folder: 'INBOX', total: fresh ? 2 : 0, unread: fresh ? 2 : 0 }] })
  return `<!doctype html><html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${DESIGN_TOKENS_CSS}</style></head><body>${renderInbox(model)}</body></html>`
}

const emit = (page: Page, kind = 'mail.changed', target = mailbox) => page.evaluate(({ kind, target }) => { (window as unknown as FixtureWindow).fixtureEmit(kind, target) }, { kind, target })

describe('current xMail board live invalidation', () => {
  it('refreshes actual rendered boards without writes and preserves current interaction state', async context => {
    const executablePath = [process.env.CHROME_PATH, chromium.executablePath()].find(path => path && existsSync(path))
    if (!executablePath) {
      if (process.env.XPANEL_REQUIRE_BROWSER_TESTS === '1') throw new Error('Real Chromium is required for this CI inbox contract; browser proof is unproved.')
      return context.skip('Real Chromium is required for the current inbox DOM contract; no browser result is claimed.')
    }
    requireFreeSpace(384)
    const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disk-cache-size=1'] })
    const start = BROWSER_REALTIME_SCRIPT.indexOf('  function handleLiveEvent(event) {')
    const end = BROWSER_REALTIME_SCRIPT.indexOf('  function connectWebSocket()', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const dispatch = BROWSER_REALTIME_SCRIPT.slice(start, end)
    expect(BROWSER_REALTIME_SCRIPT).not.toContain('[data-live-mail-list]')
    try {
      for (const locale of ['en', 'ar'] as const) for (const width of [390, 1280]) {
        requireFreeSpace(256)
        const page = await browser.newPage({ viewport: { width, height: 900 } })
        let calls = 0
        let failed = false
        let moved = false
        let empty = false
        const requests: Array<{ method: string; url: string; hint?: string }> = []
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        await page.addInitScript(() => {
          const fixture = window as unknown as FixtureWindow
          fixture.fixtureRequests = []
          const transport = (method: string, path: string) => {
            fixture.fixtureRequests.push({ method, path })
            if (method === 'POST') return new Promise(resolve => { fixture.fixtureResolve = resolve })
            return Promise.resolve({ message: { body: 'Explicitly opened body' } })
          }
          ;(window as unknown as { xpanelSessionRequest: typeof transport }).xpanelSessionRequest = transport
        })
        await page.route('**/*', async route => {
          const request = route.request()
          const url = new URL(request.url())
          if (url.origin !== 'https://mail.example.test' || url.pathname !== '/mail/inbox') return route.abort()
          if (request.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: documentFor(locale) })
          calls++
          requests.push({ method: request.method(), url: request.url(), hint: request.headers()['x-xpanel-mail-refresh'] })
          if (failed) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'synthetic unavailable' })
          return route.fulfill({ contentType: 'text/html', body: documentFor(locale, true, moved, empty) + '<script>window.returnedScriptRan = true</script>' })
        })
        await page.goto('https://mail.example.test/mail/inbox?folder=Archive&lang=' + locale + '&theme=light&page=2')
        await page.addScriptTag({ content: dispatch + '\nwindow.fixtureEmit = function(kind, mailbox) { handleLiveEvent({kind:kind,scope:{mailboxLogin:mailbox}}) }' })
        await page.locator('#xmail-query').fill('Keep')
        await page.locator('[data-mail-filter="attachments"]').click()
        await page.locator('[data-mail-action="toggle-move"]').click()
        await page.evaluate(() => { (window as unknown as FixtureWindow).fixtureArticle = document.querySelector('[data-mail-article]') })
        await page.evaluate(() => { const f = window as unknown as FixtureWindow; for (const kind of ['mail.changed', 'mail.flags', 'mail.received']) f.fixtureEmit(kind, 'fixture@example.test') })
        await page.locator('[data-mail-open="uid-9"]').waitFor()
        expect(calls).toBe(1)
        expect(await page.locator('#xmail-query').inputValue()).toBe('Keep')
        expect(await page.locator('[data-mail-filter="attachments"]').getAttribute('aria-pressed')).toBe('true')
        expect(await page.locator('[data-mail-open="uid-7"]').getAttribute('aria-current')).toBe('true')
        expect(await page.locator('[data-mail-article]').textContent()).toContain('Kept body 7')
        expect(await page.locator('[data-mail-move]').count()).toBe(1)
        expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixtureArticle === document.querySelector('[data-mail-article]'))).toBe(true)
        expect(await page.locator('[data-mail-count="INBOX"]').textContent()).toBe('2')
        expect(await page.locator('[data-mail-unread]').getAttribute('data-mail-unread')).toBe('0')
        expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixtureRequests)).toEqual([])
        expect(await page.evaluate(() => (window as unknown as FixtureWindow).returnedScriptRan === true)).toBe(false)
        expect(requests.every(request => request.method === 'GET' && request.hint === 'list' && new URL(request.url).searchParams.get('page') === '2' && new URL(request.url).searchParams.get('folder') === 'Archive')).toBe(true)
        failed = true
        await emit(page)
        await page.locator('[data-mail-refresh-status]').waitFor()
        expect(await page.locator('[data-mail-open="uid-9"]').count()).toBe(1)
        expect(await page.locator('[data-mail-article]').textContent()).toContain('Kept body 7')
        const geometry = await page.locator('[data-mail-refresh-status]').evaluate(element => ({ padding: getComputedStyle(element).paddingTop, overflow: element.scrollWidth > element.clientWidth, line: getComputedStyle(element).lineHeight, size: getComputedStyle(element).fontSize }))
        expect(geometry.padding).toBe(width >= 960 ? '24px' : '16px')
        expect(geometry.overflow).toBe(false)
        expect(Number.parseFloat(geometry.line) / Number.parseFloat(geometry.size)).toBeCloseTo(1.75)
        const beforeOther = calls
        await emit(page, 'mail.changed', 'another@example.test')
        await page.waitForTimeout(100)
        expect(calls).toBe(beforeOther)
        if (locale === 'en' && width === 1280) {
          failed = false
          await page.locator('[data-mail-action="toggle-move"]').click()
          await page.locator('#xmail-query').fill('')
          await page.locator('[data-mail-filter="all"]').click()
          await page.locator('[data-mail-action="delete"]').click()
          const beforeAction = calls
          await emit(page)
          await page.waitForTimeout(100)
          expect(calls).toBe(beforeAction)
          moved = true
          await page.evaluate(() => (window as unknown as FixtureWindow).fixtureResolve({ uid: 77 }))
          await page.locator('[data-mail-undo]').waitFor()
          await page.waitForFunction(() => document.querySelector('[data-mail-pager]')?.getAttribute('data-total') === '2')
          expect(await page.locator('[data-mail-undo]').getAttribute('data-undo-uid')).toBe('77')
          expect(await page.locator('[data-mail-open="uid-7"]').count()).toBe(1)
          await page.locator('[data-mail-action="undo"]').click()
          expect((await page.evaluate(() => (window as unknown as FixtureWindow).fixtureRequests)).some(request => request.method === 'POST' && request.path === '/api/webmail/inbox/77/move')).toBe(true)
          await page.evaluate(() => (window as unknown as FixtureWindow).fixtureResolve({ uid: 78 }))
          await page.locator('[data-mail-open="uid-78"]').waitFor()
          expect(await page.locator('[data-mail-open="uid-78"]').getAttribute('aria-current')).toBe('true')
          expect(await page.locator('[data-mail-undo]').count()).toBe(0)
          empty = true
          await emit(page)
          await page.waitForFunction(() => document.querySelector('[data-board-port="xmail-inbox"]')?.getAttribute('data-list-state') === 'empty')
          expect(await page.locator('[data-mail-empty-list]').count()).toBe(1)
          expect(await page.locator('[data-mail-filter-empty]').count()).toBe(0)
          expect(await page.locator('[data-mail-pager]').textContent()).toBe('0 of 0')
        }
        expect(errors).toEqual([])
        await page.close()
        process.stdout.write(JSON.stringify({ scope: 'current-xmail-live-refresh', locale, width, browser: 'Chromium', status: 'passed', screenshots: 0, providerRequests: 0 }) + '\n')
      }
    } finally { await browser.close() }
  })
})
