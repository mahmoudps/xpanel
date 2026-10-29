import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { describe, it } from 'vitest'
import { renderCompose, xmailComposeFromProps } from './xmail-compose.ts'
import { renderInbox, xmailInboxFromProps } from './xmail-inbox.ts'
import { renderUnavailableMailBody } from '../surfaces/xmail.ts'

const scriptOf = (html: string, name: string): string => {
  const script = html.match(new RegExp('<script id="' + name + '">([\\s\\S]*?)</script>'))?.[1]
  assert.ok(script, `${name} is present`)
  return script
}

describe('mail component fidelity and truthful actions', () => {
  it.each(['en', 'ar'] as const)('retains the complete responder editor without claiming a persisted change in %s', locale => {
    const html = renderCompose(xmailComposeFromProps({ locale, mailbox: 'owner@example.test', vacationEnabled: false, vacationCanManage: true }))
    for (const [id, type] of [['vac-startDate', 'datetime-local'], ['vac-endDate', 'datetime-local'], ['vac-subject', 'text']]) {
      assert.match(html, new RegExp('<label[^>]*for="' + id + '"'))
      assert.match(html, new RegExp('<input[^>]*id="' + id + '"[^>]*type="' + type + '"'))
    }
    assert.match(html, /data-vacation-preview/)
    assert.match(html, /data-vacation-save disabled/)
    assert.match(html, /data-vacation-manage="true"/)
    assert.match(html, locale === 'en' ? /[Aa]ctivation (?:remains )?unverified/ : /التفعيل غير متحقق منه/)
    assert.doesNotMatch(html, /value="2026-12-24"|Away until 2 January|Orders ship on/)
  })

  it('keeps responder saving in the verified session client instead of faking success in the page script', () => {
    const html = renderCompose(xmailComposeFromProps({ mailbox: 'owner@example.test', vacationEnabled: false, vacationCanManage: true }))
    const script = scriptOf(html, 'xmail-compose-client')
    assert.doesNotMatch(script, /vacation/i)
    assert.doesNotMatch(html, /data-mail-action="vacation-save"/)
    assert.match(html, /data-vacation-save disabled/)
    assert.match(html, /data-vacation-manage="true"/)
  })

  it('carries compose search to the inbox and initializes the same local filter there', () => {
    const compose = renderCompose(xmailComposeFromProps({ locale: 'ar', theme: 'dark', mailbox: 'owner@example.test' }))
    assert.match(compose, /<form[^>]*role="search"[^>]*action="\/mail\/inbox"[^>]*method="get"/)
    assert.match(compose, /name="q"/)
    assert.match(compose, /name="lang" value="ar"/)
    assert.match(compose, /name="theme" value="dark"/)
    const inbox = renderInbox(xmailInboxFromProps({ mailbox: 'owner@example.test', messages: [] }))
    const query = { value: '', addEventListener() {} }
    const list = { querySelectorAll() { return [] }, querySelector() { return null } }
    const root = {
      isConnected: true,
      getAttribute(name: string) { return name === 'data-product' ? 'true' : name === 'data-list-state' ? 'empty' : '' },
      querySelector(selector: string) { return selector === '#xmail-query' ? query : selector === '[data-mail-list]' ? list : null },
      querySelectorAll() { return [] },
      addEventListener() {},
    }
    runInNewContext(scriptOf(inbox, 'xmail-inbox-client'), { document: { querySelector() { return root }, addEventListener() {} }, window: { location: { href: 'https://mail.example.test:2096/mail/inbox?q=invoice%20number' } }, URL })
    assert.equal(query.value, 'invoice number')
  })

  it('connects the refresh control to the existing coalesced read path', () => {
    const html = renderInbox(xmailInboxFromProps({ mailbox: 'owner@example.test', messages: [] }))
    assert.match(html, /data-mail-action="refresh"/)
    let click: ((event: unknown) => void) | undefined
    const timers: Array<() => void> = []
    const root = {
      getAttribute(name: string) { return name === 'data-product' ? 'true' : '' },
      querySelector() { return null },
      querySelectorAll() { return [] },
      addEventListener(name: string, handler: (event: unknown) => void) { if (name === 'click') click = handler },
    }
    runInNewContext(scriptOf(html, 'xmail-inbox-client'), { document: { querySelector() { return root }, addEventListener() {} }, window: { location: { href: 'https://mail.example.test:2096/mail/inbox' }, setTimeout(handler: () => void) { timers.push(handler); return timers.length } }, URL })
    assert.ok(click)
    const action = { getAttribute() { return 'refresh' } }
    const event = { target: { closest(selector: string) { return selector === '[data-mail-action]' ? action : null } } }
    click(event)
    click(event)
    assert.equal(timers.length, 1)
  })

  it('keeps unsupported inbox controls visible with explicit availability instead of inert active buttons', () => {
    const html = renderInbox(xmailInboxFromProps({ mailbox: 'owner@example.test', messages: [{ uid: 3, folder: 'INBOX', from: 'sender@example.test', to: 'owner@example.test', subject: 'Document', preview: '', body: '', receivedAt: '2026-10-25T00:00:00Z', unread: false, attachments: [{ name: 'report.pdf', sizeBytes: 2000 }] }] }))
    assert.match(html, /data-mail-new-folder[^>]*disabled/)
    assert.match(html, /data-mail-older[^>]*disabled/)
    // Attachments come from a native MIME read: the read control starts disabled with an explicit status.
    assert.match(html, /data-attachment-refresh disabled/)
    assert.match(html, /data-attachment-can-read="false"/)
    assert.equal(html.includes('data-mail-attachment-download'), false)
    assert.match(html, /mail-folder-availability/)
    assert.match(html, /mail-pagination-availability/)
    assert.match(html, /data-attachment-status data-state="unread" role="status"/)
  })
})


describe('unqualified mailbox layout', () => {
  it.each(['/mail/inbox', '/mail/compose'])('retains the %s components without mailbox state or executable controls', route => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderUnavailableMailBody({ route, locale, theme: 'dark' })
      assert.ok(html)
      assert.match(html, /data-mail-read-only="true"/)
      assert.match(html, /data-mail-pane="folders"/)
      assert.match(html, /data-quota-ratio="unknown"/)
      const tags = [...html.matchAll(/<[^>]+>/g)].map(match => match[0]).join(' ' )
      assert.doesNotMatch(tags, /<main\b|<form\b|<script\b|href=|data-mail-action=|data-mail-send=|data-nav-route=|contenteditable="true"/)
      for (const control of html.matchAll(/<(button|input|select|textarea)\b[^>]*>/g)) assert.match(control[0], /\bdisabled\b/)
      assert.doesNotMatch(html, /owner@example|alice|nour\.dev|synthetic|data-mail-uid=|DKIM: pass|SPF: pass/)
      if (route === '/mail/inbox') {
        assert.match(html, /data-mail-pane="message-list"/)
        assert.match(html, /data-mail-pane="reading-pane"/)
      } else {
        for (const id of ['compose-to', 'compose-cc', 'compose-bcc', 'compose-body', 'att-title', 'identity-title', 'vac-title', 'filters-title', 'vac-startDate', 'vac-endDate', 'vac-subject', 'vac-replyIntervalHours']) assert.ok(html.includes(`id="${id}"`), id)
      }
    }
  })

  it('does not pretend another mail route has an inbox implementation', () => {
    assert.equal(renderUnavailableMailBody({ route: '/mail/calendar', locale: 'en' }), undefined)
  })
})


const formattingHarness = (link: string | null = 'https://example.test/') => {
  const html = renderCompose(xmailComposeFromProps({ mailbox: 'owner@example.test' }))
  const handlers: Record<string, (event: any) => void> = {}
  const editorHandlers: Record<string, (event: any) => void> = {}
  const calls: Array<{ command: string; value: unknown; focused: boolean; scoped: boolean }> = []
  const inserted: any[] = []
  const inside = { nodeType: 3, parentElement: { closest() { return null } } }
  let focused = false
  let selectionRange: any
  const makeRange = (): any => ({
    startContainer: inside, endContainer: inside,
    cloneRange() { return makeRange() }, selectNodeContents() {}, collapse() {}, deleteContents() {},
    insertNode(fragment: unknown) { inserted.push(fragment) }, setStartAfter() {},
  })
  selectionRange = makeRange()
  const selection = { rangeCount: 1, anchorNode: inside, getRangeAt() { return selectionRange }, removeAllRanges() {}, addRange(range: unknown) { selectionRange = range } }
  const buttons = ['bold', 'italic', 'underline', 'bullets', 'numbers', 'quote', 'link', 'clear'].map(key => ({
    style: {},
    attributes: { 'data-mail-format': key, 'data-mail-format-action': key === 'link' || key === 'clear' ? 'true' : 'false', 'aria-pressed': 'false' } as Record<string, string>,
    getAttribute(name: string) { return this.attributes[name] },
    setAttribute(name: string, value: string) { this.attributes[name] = value },
  }))
  const feedback = { textContent: '', hidden: true, style: {}, setAttribute() {} }
  const editor = { contains(node: unknown) { return node === inside || node === editor }, focus() { focused = true }, addEventListener(name: string, handler: (event: unknown) => void) { editorHandlers[name] = handler } }
  const root = {
    getAttribute(name: string) { return name === 'data-product' ? 'true' : name === 'data-format-link-invalid' ? 'Unsafe link rejected.' : name === 'data-format-unavailable' ? 'Formatting unavailable.' : '' },
    querySelector(selector: string) { return selector === '#compose-body' ? editor : selector === '[data-mail-feedback]' ? feedback : null },
    querySelectorAll(selector: string) { return selector === '[data-mail-format]' ? buttons : [] },
    addEventListener(name: string, handler: (event: unknown) => void) { handlers[name] = handler },
  }
  const document = {
    querySelector() { return root }, addEventListener() {}, createRange: makeRange,
    queryCommandState(command: string) { return calls.some(call => call.command === command) },
    execCommand(command: string, _unused: boolean, value: unknown) { calls.push({ command, value, focused, scoped: editor.contains(selectionRange.startContainer) && editor.contains(selectionRange.endContainer) }); return true },
    createDocumentFragment() { return { childNodes: [] as unknown[], lastChild: null as unknown, appendChild(child: unknown) { this.childNodes.push(child); this.lastChild = child } } },
    createTextNode(text: string) { return { kind: 'text', text } },
    createElement(tag: string) { return { kind: 'element', tag } },
  }
  runInNewContext(scriptOf(html, 'xmail-compose-client'), { document, window: { getSelection() { return selection }, prompt() { return link } }, URL })
  const click = (key: string): void => {
    const button = buttons.find(item => item.getAttribute('data-mail-format') === key) ?? { getAttribute() { return key } }
    handlers.click!({ preventDefault() {}, target: { closest(selector: string) { return selector === '[data-mail-format]' ? button : null } } })
  }
  return { click, calls, buttons, feedback, editorHandlers, inserted }
}

describe('compose formatting applies to the editor', () => {
  it('restores focus and a scoped selection before applying all supported formatting commands', () => {
    const harness = formattingHarness()
    for (const key of ['bold', 'italic', 'underline', 'bullets', 'numbers', 'quote', 'clear']) harness.click(key)
    assert.deepEqual(harness.calls.map(call => call.command), ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList', 'formatBlock', 'removeFormat'])
    assert.ok(harness.calls.every(call => call.focused && call.scoped))
    assert.equal(harness.calls.find(call => call.command === 'formatBlock')?.value, 'blockquote')
    assert.equal(harness.buttons.find(button => button.getAttribute('data-mail-format') === 'bold')?.getAttribute('aria-pressed'), 'true')
    harness.click('insertHTML')
    harness.click('__proto__')
    assert.equal(harness.calls.length, 7)
  })

  it.each(['javascript:alert(1)', 'data:text/html,unsafe', 'https://name:secret@example.test/'])('rejects an unsafe editor link %s without changing content', url => {
    const harness = formattingHarness(url)
    harness.click('link')
    assert.equal(harness.calls.length, 0)
    assert.equal(harness.feedback.textContent, 'Unsafe link rejected.')
  })

  it.each(['https://example.test/path', 'http://example.test/', 'mailto:contact@example.test'])('applies an allowed link %s to the preserved selection', url => {
    const harness = formattingHarness(url)
    harness.click('link')
    assert.equal(harness.calls[0]?.command, 'createLink')
    assert.equal(harness.calls[0]?.value, url)
    assert.equal(harness.calls[0]?.scoped, true)
  })

  it('pastes literal text and line breaks, never clipboard HTML or remote image nodes', () => {
    const harness = formattingHarness()
    let prevented = false
    const formats: string[] = []
    harness.editorHandlers.paste!({ preventDefault() { prevented = true }, clipboardData: { getData(format: string) { formats.push(format); return '<img src="https://example.test/tracker" onerror="unsafe()">\nNext line' } } })
    assert.equal(prevented, true)
    assert.deepEqual(formats, ['text/plain'])
    const inserted = JSON.parse(JSON.stringify(harness.inserted[0].childNodes))
    assert.deepEqual(inserted, [{ kind: 'text', text: '<img src="https://example.test/tracker" onerror="unsafe()">' }, { kind: 'element', tag: 'br' }, { kind: 'text', text: 'Next line' }])
  })
})
