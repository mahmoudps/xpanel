// Real xMail vacation responder renderer/controller journey in real Chromium with an explicit
// synthetic session transport. Only /api/webmail/vacation GET/PUT is mocked (page.route); every
// other document/asset request is served by the loopback visual fixture. No mailbox authentication,
// mail delivery, native Sieve installation, real automatic replies or service qualification is
// exercised or claimed: the workspace only ever edits saved configuration and activation stays
// unverified. No credentials are printed or stored.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createVisualFixture } from './visual-fixture.mjs'

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.tools/playwright-browsers')
const { chromium } = await import('@playwright/test')

const output = resolve(process.env.XPANEL_MAIL_VACATION_OUTPUT || 'test-results/completion-mail-vacation')
const sourcePaths = [
  'apps/web/src/board-port/xmail-vacation.ts', 'apps/web/src/mail-vacation-workspace-client.ts',
  'apps/web/src/surfaces/xmail.ts', 'apps/web/src/board-port/xmail-compose.ts', 'apps/web/src/ws-client.ts',
  'apps/web/src/board-port/extensions/shared.ts', 'apps/web/src/tokens.ts', 'apps/web/src/app.ts',
  'apps/web/src/shell.ts', 'apps/web/src/mail-layout.ts', 'apps/api/src/mail/vacation-workspace.ts',
  'apps/api/src/extended-routes.ts', 'tests/browser/visual-fixture.mjs', 'tests/browser/completion-mail-vacation.mjs',
]
const sourceSnapshot = () => sourcePaths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
const mailbox = 'info@preview.example.test'
const api = '/api/webmail/vacation'
const rootSelector = '[data-mail-vacation]'
const fieldKeys = ['enabled', 'subject', 'body', 'htmlBody', 'startDate', 'endDate', 'replyIntervalHours']
const xss = '<img src=x onerror=window.__xss=1>'
const clone = value => JSON.parse(JSON.stringify(value))
const isRevision = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

const messages = {
  unread: { en: 'Responder configuration has not been read.', ar: 'لم تُقرأ إعدادات الرد التلقائي.' },
  reading: { en: 'Reading saved responder configuration…', ar: 'جارٍ قراءة إعداد الرد المحفوظ…' },
  read: { en: 'Saved configuration read. Activation remains unverified.', ar: 'تمت قراءة الإعداد المحفوظ. التفعيل غير متحقق منه.' },
  saved: { en: 'Requested configuration saved and read back. Activation remains unverified.', ar: 'حُفظ الإعداد المطلوب وتأكدت قراءته. التفعيل غير متحقق منه.' },
  stale: { en: 'Saved configuration changed. Refresh preserves this draft and lock; explicitly discard and reload before another save.', ar: 'تغيّر الإعداد المحفوظ. التحديث يحفظ المسودة والقفل؛ تجاهلها وأعد التحميل صراحة قبل حفظ آخر.' },
  uncertain: { en: 'The write outcome requires review. Do not retry. Refresh keeps this lock; explicitly reload to continue.', ar: 'نتيجة الكتابة تتطلب مراجعة. لا تكرر الطلب. التحديث يبقي القفل؛ أعد التحميل صراحة للمتابعة.' },
}
const chip = {
  on: { en: 'Requested on; activation unverified', ar: 'طلب التشغيل؛ التفعيل غير متحقق منه' },
  notRead: { en: 'Not read; activation unverified', ar: 'لم تُقرأ البيانات؛ التفعيل غير متحقق منه' },
}
const dialog = {
  title: { en: 'Discard responder draft?', ar: 'تجاهل مسودة الرد التلقائي؟' },
  confirm: { en: 'Discard and continue', ar: 'تجاهل ومتابعة' },
}
const recordText = (lang, updatedAt) => lang === 'ar' ? 'إعداد الرد المحفوظ للصندوق ' + mailbox + ' · ' + updatedAt : 'Saved responder configuration for ' + mailbox + ' · ' + updatedAt

// Mirrors the documented server compiler (apps/api/src/mail/vacation-workspace.ts) so the mocked
// compiledSieve payload is the same source-only shape the real GET/PUT contract returns.
const crlf = value => value.replace(/\r\n|\r|\n/g, '\r\n')
const quote = value => '"' + crlf(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
const base64 = value => Buffer.from(crlf(value), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''
const mimeReason = (body, html) => {
  const boundary = 'xpanel-vacation-alternative'
  const part = (type, value) => ['--' + boundary, 'Content-Type: text/' + type + '; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(value)]
  return ['MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="' + boundary + '"', '',
    ...part('plain', body), ...part('html', html), '--' + boundary + '--', ''].join('\r\n')
}
const compileSieve = value => {
  if (!value.enabled) return '# Vacation responder disabled\n'
  const extensions = ['vacation']
  const interval = value.replyIntervalHours % 24 === 0 ? ':days ' + value.replyIntervalHours / 24 : ':seconds ' + value.replyIntervalHours * 3600
  if (value.replyIntervalHours % 24 !== 0) extensions.push('vacation-seconds')
  const tests = []
  for (const [date, comparison] of [[value.startDate, 'ge'], [value.endDate, 'lt']]) {
    if (date !== null && date !== undefined) tests.push('currentdate :zone "+0000" :comparator "i;octet" :value "' + comparison + '" "iso8601" ' + quote(date.slice(0, 19)))
  }
  if (tests.length) extensions.push('date', 'relational')
  const reason = value.htmlBody ? mimeReason(value.body, value.htmlBody) : value.body
  const action = 'vacation ' + interval + ' :addresses [' + quote(mailbox) + '] :subject ' + quote(value.subject) + (value.htmlBody ? ' :mime' : '') + ' ' + quote(reason) + ';'
  return ['require [' + extensions.map(quote).join(', ') + '];',
    ...(tests.length ? ['if ' + (tests.length === 1 ? tests[0] : 'allof(' + tests.join(', ') + ')') + ' {', '  ' + action, '}'] : [action]), ''].join('\r\n')
}
const project = record => record === null ? null : {
  mailbox: record.mailbox, enabled: record.enabled, subject: record.subject, body: record.body, htmlBody: record.htmlBody,
  startDate: record.startDate, endDate: record.endDate, replyIntervalHours: record.replyIntervalHours,
  compiledSieve: record.compiledSieve, updatedAt: record.updatedAt,
}
const revisionOf = config => createHash('sha256')
  .update(JSON.stringify({ namespace: 'xpanel-vacation-workspace:v1', vacation: project(config) })).digest('hex')
const stored = (value, updatedAt) => ({ mailbox, ...value, compiledSieve: compileSieve(value), updatedAt })
const initialConfig = () => stored({
  enabled: true, subject: 'Planned absence',
  body: 'I am currently away from email.\n' + xss, htmlBody: '',
  startDate: null, endDate: null, replyIntervalHours: 24,
}, '2026-10-20T09:00:00.000Z')

const draft = {
  subject: ' Out of office: autumn ', body: 'I am away until 6 November. Please contact the team.',
  htmlBody: '<p>I am away until 6 November.</p>', startDate: '2026-11-02T08:00', endDate: '2026-11-06T17:30', replyIntervalHours: '168',
}
const draftPut = {
  enabled: true, subject: draft.subject, body: draft.body, htmlBody: draft.htmlBody,
  startDate: '2026-11-02T08:00:00.000Z', endDate: '2026-11-06T17:30:00.000Z', replyIntervalHours: 168,
}
const composeDraft = { subject: ' Compact responder draft ', body: 'Away until Friday.', htmlBody: xss, startDate: '', endDate: '', replyIntervalHours: '48' }

class VacationModel {
  constructor() {
    this.config = initialConfig()
    this.calls = []
    this.errors = []
    this.gates = []
    this.mode = null
    this.conflictNextPut = false
    this.wrongReadbackNext = false
    this.saved = 0
  }
  revision() { return revisionOf(this.config) }
  holdRead() {
    let enter, release
    const gate = {
      started: false,
      entered: new Promise(resolveEnter => { enter = resolveEnter }),
      promise: new Promise(resolveRelease => { release = resolveRelease }),
      enter: () => enter(),
      release: () => release(),
    }
    this.gates.push(gate)
    return gate
  }
  async problem(route, status, code, detail, details) {
    await route.fulfill({
      status,
      headers: { 'content-type': 'application/problem+json; charset=utf-8' },
      json: { type: 'https://xpanel.dev/problems/' + code.toLowerCase().replaceAll('_', '-'), title: code, status, detail, code, instance: api, details },
    })
  }
  async route(route) {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    assert.equal(url.pathname, api, 'Only the vacation workspace GET/PUT transport is mocked')
    assert.equal(url.search, '', 'The vacation workspace never adds mailbox selectors')
    assert.ok(['GET', 'PUT'].includes(method), 'Only GET/PUT vacation transport is mocked')
    const body = method === 'GET' ? null : request.postDataJSON()
    this.calls.push({ method, path: url.pathname, ...(body === null ? {} : { body: clone(body) }) })
    const application = { status: 'configuration_only', nativeApplied: false }
    if (method === 'GET') {
      const gate = this.gates.find(gate => !gate.started)
      if (gate) { gate.started = true; gate.enter(); await gate.promise }
      let config = clone(this.config)
      if (this.wrongReadbackNext) { this.wrongReadbackNext = false; config = { ...config, subject: 'Tampered external readback' } }
      await route.fulfill({ status: 200, json: { context: { mailbox }, vacation: project(config), revision: revisionOf(config), application } })
      return
    }
    assert.deepEqual(Object.keys(body ?? {}).sort(), [...fieldKeys, 'expectedRevision'].sort(), 'PUT body carries exactly seven fields plus expectedRevision')
    assert.equal(typeof body.enabled, 'boolean')
    for (const key of ['subject', 'body', 'htmlBody']) assert.equal(typeof body[key], 'string', 'PUT ' + key + ' is text')
    for (const key of ['startDate', 'endDate']) assert.ok(body[key] === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(body[key]), 'PUT ' + key + ' is null or whole-second UTC')
    assert.ok(Number.isSafeInteger(body.replyIntervalHours) && body.replyIntervalHours >= 1 && body.replyIntervalHours <= 8760, 'PUT interval is an integer hour from 1 to 8760')
    assert.ok(isRevision(body.expectedRevision), 'PUT expectedRevision is a lowercase SHA-256')
    if (body.startDate !== null && body.endDate !== null) assert.ok(Date.parse(body.endDate) > Date.parse(body.startDate), 'PUT schedule order is valid')
    if (this.mode === 'unknown-write') {
      await this.problem(route, 503, 'SERVICE_UNAVAILABLE', 'Synthetic vacation write requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
      return
    }
    if (this.conflictNextPut) {
      this.conflictNextPut = false
      await this.problem(route, 409, 'CONFLICT', 'Synthetic vacation configuration changed', { stateChanged: false })
      return
    }
    if (body.expectedRevision !== this.revision()) {
      await this.problem(route, 409, 'CONFLICT', 'Synthetic vacation configuration changed', { stateChanged: false })
      return
    }
    const fields = {
      enabled: body.enabled, subject: body.subject.trim(), body: body.body, htmlBody: body.htmlBody,
      startDate: body.startDate, endDate: body.endDate, replyIntervalHours: body.replyIntervalHours,
    }
    if (body.enabled && (!fields.subject || !(fields.body.trim() || fields.htmlBody.trim()))) {
      await this.problem(route, 422, 'VALIDATION', 'Synthetic enabled vacation needs subject and message', { stateChanged: false })
      return
    }
    this.saved += 1
    this.config = stored(fields, new Date(Date.parse('2026-10-26T18:40:00.000Z') + this.saved * 60000).toISOString())
    if (this.mode === 'foreign-ack') {
      await route.fulfill({ status: 200, json: { context: { mailbox: 'foreign@example.test' }, vacation: project(this.config), revision: revisionOf(this.config), stateChanged: true, application } })
      return
    }
    if (this.mode === 'wrong-readback') this.wrongReadbackNext = true
    await route.fulfill({ status: 200, json: { context: { mailbox }, vacation: project(this.config), revision: revisionOf(this.config), stateChanged: true, application } })
  }
}

async function mockSession(page, model) {
  await page.addInitScript(() => {
    const transport = async (method, path, body) => {
      const response = await fetch(path, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const value = await response.json()
      if (!response.ok) {
        const problem = value.error || value
        throw Object.assign(new Error(problem.detail || problem.message || 'mock_vacation_error'), { status: response.status, code: problem.code, details: problem.details || {} })
      }
      return value
    }
    Object.defineProperty(window, 'xpanelSessionRequest', { get: () => transport, set: () => {}, configurable: false })
  })
  await page.route('**/api/webmail/vacation**', async route => {
    try { await model.route(route) } catch (error) {
      model.errors.push(String(error?.message ?? error))
      await route.fulfill({ status: 500, json: { type: 'about:blank', status: 500, code: 'mock_contract_failure', details: { stateChanged: true, verificationRequired: true, unknownOutcome: true } } }).catch(() => {})
    }
  })
}

function observe(page) {
  const apiRequests = [], pageErrors = [], consoleErrors = []
  page.on('pageerror', error => pageErrors.push(error.name + ': ' + error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)) })
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) apiRequests.push({ method: request.method(), path: url.pathname, search: url.search })
  })
  return { apiRequests, pageErrors, consoleErrors }
}

const url = (route, lang) => route + '?lang=' + lang + '&theme=light'
const state = (page, wanted) => page.waitForFunction(({ rootSelector, wanted }) => {
  const root = document.querySelector(rootSelector)
  return root?.querySelector('[data-vacation-status]')?.getAttribute('data-state') === wanted && root.getAttribute('aria-busy') !== 'true'
}, { rootSelector, wanted })
const statusText = page => page.locator('[data-vacation-status]').textContent()
const chipText = page => page.locator('[data-vacation-requested]').textContent()
const settle = page => page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-busy') !== 'true', rootSelector)
const control = (page, key) => page.locator('[data-mail-vacation] [name="' + key + '"]')
const getResponse = page => page.waitForResponse(response => new URL(response.url()).pathname === api && response.request().method() === 'GET')
const putRequest = page => page.waitForRequest(request => new URL(request.url()).pathname === api && request.method() === 'PUT')
const prompt = page => page.locator('[data-xp-prompt]')
const countOf = (model, method) => model.calls.filter(call => call.method === method).length
// Chromium logs every intentionally simulated non-2xx fault as a network console entry; these exact
// synthetic fault statuses are expected, any other console error still fails the run.
const expectedFaultConsole = text => /^Failed to load resource: the server responded with a status of (409 \(Conflict\)|503 \(Service Unavailable\))$/.test(text)
const xssFree = async page => {
  const result = await page.evaluate(() => ({
    marker: window.__xss ?? null,
    images: document.querySelectorAll('img[src="x"]').length,
    previewChildren: document.querySelector('[data-vacation-preview]')?.children.length ?? -1,
  }))
  assert.equal(result.marker, null, 'htmlBody/compiledSieve source must never execute as HTML')
  assert.equal(result.images, 0, 'No injected image element may be created')
  assert.equal(result.previewChildren, 0, 'The preview must only contain a text node')
}
async function entered(gate) {
  let timer
  try {
    await Promise.race([gate.entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Held vacation GET did not start')), 10000) })])
  } finally { clearTimeout(timer) }
}
async function openPrompt(page) {
  await prompt(page).waitFor({ state: 'visible' })
  assert.equal(await prompt(page).evaluate(node => node.open), true, 'The explicit reload confirmation dialog is modal')
}
async function closePrompt(page, mode) {
  if (mode === 'escape') await page.keyboard.press('Escape')
  else if (mode === 'confirm') await page.locator('[data-xp-prompt-confirm]').click()
  else await page.locator('[data-xp-prompt-cancel]').click()
  await prompt(page).waitFor({ state: 'hidden' })
  await settle(page)
}
async function reloadConfirmed(page, model, lang, { cancel = null } = {}) {
  const before = countOf(model, 'GET')
  await page.locator('[data-vacation-reload]').click()
  await openPrompt(page)
  assert.equal(await page.locator('[data-xp-prompt-title]').textContent(), dialog.title[lang])
  assert.equal(await page.locator('[data-xp-prompt-confirm]').textContent(), dialog.confirm[lang])
  if (cancel) {
    await closePrompt(page, cancel)
    assert.equal(countOf(model, 'GET'), before, 'Cancelled reload must not read the server')
    return false
  }
  const response = getResponse(page)
  await page.locator('[data-xp-prompt-confirm]').click()
  await (await response).finished()
  await state(page, 'read')
  return true
}

async function geometry(page) {
  return page.locator(rootSelector).evaluate(root => {
    const visible = node => !!node.getClientRects().length && !node.closest('[hidden]')
    const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height } }
    const style = node => getComputedStyle(node)
    const form = root.querySelector('[data-vacation-form]')
    const labelOf = node => [...root.querySelectorAll('label[for]')].find(label => label.htmlFor === node.id)
    const fieldGaps = [...form.querySelectorAll('[name]')].filter(node => node.type !== 'checkbox').map(node => {
      const label = labelOf(node), range = document.createRange()
      range.selectNodeContents(label)
      const labelBox = range.getBoundingClientRect(), box = node.getBoundingClientRect()
      return { name: node.name, gap: box.top - labelBox.bottom, fieldRowGap: parseFloat(style(label.parentElement).rowGap) }
    })
    const group = root.querySelector('[data-vacation-field-group]')
    const groupStyle = style(group)
    const children = [...group.children].filter(visible).map(rect)
    const rtl = style(root).direction === 'rtl'
    const card = root.querySelector('.xp-vacation-card'), cardStyle = style(card)
    const panel = root.querySelector('[data-vacation-panel]')
    const check = root.querySelector('.xp-vacation-check')
    const controlName = node => node.name || (node.hasAttribute('data-vacation-save') ? 'save' : node.hasAttribute('data-vacation-cancel') ? 'cancel'
      : node.hasAttribute('data-vacation-refresh') ? 'refresh' : node.hasAttribute('data-vacation-reload') ? 'reload' : node.hasAttribute('data-vacation-open') ? 'open' : (node.textContent || '').trim().slice(0, 40))
    const controls = [...root.querySelectorAll('input:not([type="checkbox"]),textarea,button')].filter(visible).map(node => {
      const box = rect(node)
      return { name: controlName(node), tag: node.tagName, width: box.width, height: box.height, textAlign: style(node).textAlign, direction: style(node).direction }
    })
    const dates = ['startDate', 'endDate'].map(name => {
      const node = form.querySelector('[name="' + name + '"]')
      return { name, value: node.value, dir: node.getAttribute('dir'), direction: style(node).direction, textAlign: style(node).textAlign }
    })
    const interval = form.querySelector('[name="replyIntervalHours"]')
    const preview = root.querySelector('[data-vacation-preview]')
    return {
      innerWidth, scrollWidth: document.documentElement.scrollWidth, dir: root.getAttribute('dir'), lang: root.getAttribute('lang'),
      direction: style(root).direction, card: { padding: [cardStyle.paddingTop, cardStyle.paddingRight, cardStyle.paddingBottom, cardStyle.paddingLeft].map(parseFloat), gap: parseFloat(cardStyle.rowGap) },
      fieldGaps, fieldGapCount: fieldGaps.length,
      fieldGroup: {
        computedRow: parseFloat(groupStyle.rowGap), computedColumn: parseFloat(groupStyle.columnGap), childCount: children.length,
        actualColumn: children.length > 1 ? (rtl ? children[0].x - children[1].right : children[1].x - children[0].right) : null,
        actualRow: children.length > 1 ? children[1].y - children[0].bottom : null,
      },
      panelGap: parseFloat(style(panel).rowGap), formGap: parseFloat(style(form).rowGap),
      actions: [...root.querySelectorAll('.xp-extension__actions')].filter(visible).map(node => parseFloat(style(node).columnGap)),
      checkbox: { gap: parseFloat(style(check).columnGap), height: rect(check).height, width: rect(check).width },
      controls, dates,
      interval: { value: interval.value, min: interval.min, max: interval.max, step: interval.step },
      preview: { tag: preview.tagName, direction: style(preview).direction, unicodeBidi: style(preview).unicodeBidi, whiteSpace: style(preview).whiteSpace },
      text: root.textContent,
    }
  })
}
function assertGeometry(value, lang, width) {
  const rtl = lang === 'ar'
  assert.equal(value.dir, rtl ? 'rtl' : 'ltr', 'The workspace declares the Arabic RTL direction')
  assert.equal(value.direction, rtl ? 'rtl' : 'ltr')
  assert.equal(value.lang, lang)
  assert.ok(value.scrollWidth <= width + 1, 'The document must not overflow horizontally at ' + width + 'px (got ' + value.scrollWidth + ')')
  const padding = width < 600 ? 16 : 24
  for (const side of value.card.padding) assert.ok(Math.abs(side - padding) <= 1, 'Card padding actual ' + side + ' must be ' + padding + ' at ' + width + 'px')
  assert.ok(Math.abs(value.card.gap - 24) <= 1, 'Card group gap actual ' + value.card.gap + ' must be 24')
  assert.equal(value.fieldGapCount, 6)
  for (const field of value.fieldGaps) {
    assert.ok(Math.abs(field.fieldRowGap - 8) <= 1, 'Field label/control grid gap actual ' + field.fieldRowGap + ' must be 8: ' + field.name)
    assert.ok(Math.abs(field.gap - 8) <= 1, 'Actual label-to-control gap ' + field.gap + ' must be 8: ' + field.name)
  }
  assert.ok(Math.abs(value.fieldGroup.computedRow - 16) <= 1)
  assert.ok(Math.abs(value.fieldGroup.computedColumn - 16) <= 1)
  if (width >= 600) assert.ok(Math.abs(value.fieldGroup.actualColumn - 16) <= 1, 'Sibling field column gap actual ' + value.fieldGroup.actualColumn + ' must be 16')
  else assert.ok(Math.abs(value.fieldGroup.actualRow - 16) <= 1, 'Sibling field row gap actual ' + value.fieldGroup.actualRow + ' must be 16')
  assert.ok(Math.abs(value.panelGap - 24) <= 1)
  assert.ok(Math.abs(value.formGap - 24) <= 1)
  assert.ok(value.actions.length >= 2)
  for (const gap of value.actions) assert.ok(Math.abs(gap - 16) <= 1, 'Action row gap actual ' + gap + ' must be 16')
  assert.ok(Math.abs(value.checkbox.gap - 8) <= 1, 'Checkbox label gap must be 8')
  assert.ok(value.checkbox.height >= 43.5, 'Checkbox label target must be at least 44px tall')
  for (const control of value.controls) {
    assert.ok(control.height >= 43.5, 'Actual control height must be at least 44: ' + control.name)
    if (control.tag !== 'TEXTAREA') assert.ok(control.width >= 43.5, 'Actual control width must be at least 44: ' + control.name)
    if (rtl && (control.tag === 'INPUT' || control.tag === 'TEXTAREA')) assert.equal(control.textAlign, 'right', 'Arabic controls align to the RTL edge: ' + control.name)
  }
  for (const date of value.dates) {
    assert.equal(date.dir, 'ltr', 'Date pickers stay isolated LTR: ' + date.name)
    assert.equal(date.direction, 'ltr')
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(date.value), 'Canonical whole-second picker value is ASCII: ' + date.name + '=' + date.value)
  }
  assert.match(value.interval.value, /^\d+$/, 'The reply interval is ASCII digits')
  assert.equal(value.interval.min, '1')
  assert.equal(value.interval.max, '8760')
  assert.equal(value.interval.step, '1')
  assert.equal(value.preview.tag, 'PRE')
  assert.equal(value.preview.direction, 'ltr')
  assert.ok(value.preview.unicodeBidi.includes('isolate'))
  assert.equal(value.preview.whiteSpace, 'pre-wrap')
  assert.ok(!/[\u0660-\u0669\u06f0-\u06f9]/u.test(value.text), 'Rendered numerals are ASCII, not Arabic-Indic')
}

async function readState(page, model, lang, width) {
  const root = page.locator(rootSelector)
  assert.equal(await root.count(), 1)
  assert.equal(await root.getAttribute('data-vacation-mailbox'), mailbox)
  assert.equal(await root.getAttribute('data-vacation-manage'), 'true')
  assert.equal(await root.getAttribute('data-vacation-compact'), 'false')
  assert.equal(await statusText(page), messages.read[lang])
  assert.equal(await page.locator('[data-vacation-status]').getAttribute('role'), 'status')
  assert.equal(await page.locator('[data-vacation-status]').getAttribute('aria-live'), 'polite')
  assert.equal(await chipText(page), chip.on[lang])
  assert.equal(await page.locator('[data-vacation-record]').textContent(), recordText(lang, model.config.updatedAt))
  const specs = {
    enabled: { tag: 'INPUT', type: 'checkbox' },
    subject: { tag: 'INPUT', type: 'text', dir: 'auto' },
    body: { tag: 'TEXTAREA' },
    htmlBody: { tag: 'TEXTAREA', dir: 'ltr' },
    startDate: { tag: 'INPUT', type: 'datetime-local', dir: 'ltr', step: '1' },
    endDate: { tag: 'INPUT', type: 'datetime-local', dir: 'ltr', step: '1' },
    replyIntervalHours: { tag: 'INPUT', type: 'number', dir: 'ltr', min: '1', max: '8760', step: '1' },
  }
  for (const [key, spec] of Object.entries(specs)) {
    const node = control(page, key)
    assert.equal(await node.isVisible(), true, 'Field is visible: ' + key)
    assert.equal(await node.evaluate(element => element.tagName), spec.tag)
    assert.equal(await node.getAttribute('type'), spec.type ?? null, 'Field type: ' + key)
    for (const attribute of ['dir', 'step', 'min', 'max']) {
      if (spec[attribute] !== undefined) assert.equal(await node.getAttribute(attribute), spec[attribute], key + ' ' + attribute)
    }
    const label = await node.evaluate(element => {
      const wrapping = element.closest('label')
      if (wrapping) return wrapping.textContent
      const linked = element.id ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]') : null
      return linked?.textContent ?? null
    })
    assert.ok(label && label.trim().length > 0, 'Field has a nonempty label: ' + key)
  }
  assert.equal(await control(page, 'enabled').isChecked(), true)
  assert.equal(await control(page, 'subject').inputValue(), 'Planned absence')
  assert.equal(await control(page, 'body').inputValue(), 'I am currently away from email.\n' + xss)
  assert.equal(await control(page, 'htmlBody').inputValue(), '')
  assert.equal(await control(page, 'startDate').inputValue(), '')
  assert.equal(await control(page, 'endDate').inputValue(), '')
  assert.equal(await control(page, 'replyIntervalHours').inputValue(), '24')
  const preview = page.locator('[data-vacation-preview]')
  assert.equal(await preview.textContent(), model.config.compiledSieve, 'Preview shows the GET compiledSieve source verbatim')
  assert.ok((await preview.textContent()).includes(xss), 'Preview keeps the injected source as text')
  await xssFree(page)
  assert.equal(await page.locator('[data-vacation-save]').isDisabled(), true, 'Save is disabled for a clean read')
  assert.equal(await page.locator('[data-vacation-refresh]').isEnabled(), true)
  assert.equal(await page.locator('[data-vacation-reload]').isEnabled(), true)
  assert.equal(await control(page, 'subject').isDisabled(), false, 'Read configuration is editable when admitted')
  const text = await root.textContent()
  assert.ok(!/nativeApplied|native applied/i.test(text), 'Never claims a native application')
  assert.ok(!/(autoresponses?|replies) (are|is) (now )?active/i.test(text), 'Never claims automatic replies run')
  assert.ok(width > 0 && lang)
}

async function saveJourney(page, model, lang, deep) {
  await control(page, 'subject').fill(draft.subject)
  assert.equal(await page.locator('[data-vacation-save]').isEnabled(), true, 'Save enables only after a dirty edit')
  await control(page, 'body').fill(draft.body)
  await control(page, 'htmlBody').fill(draft.htmlBody)
  await control(page, 'startDate').fill(draft.startDate)
  await control(page, 'endDate').fill(draft.endDate)
  await control(page, 'replyIntervalHours').fill(draft.replyIntervalHours)
  assert.equal(await control(page, 'startDate').inputValue(), '2026-11-02T08:00')
  assert.equal(await control(page, 'endDate').inputValue(), '2026-11-06T17:30')
  await xssFree(page)
  if (deep) {
    // Keyboard order reaches every field and action exactly once (datetime segments repeat).
    const order = []
    await page.locator('[data-vacation-refresh]').focus()
    for (let index = 0; index < 45 && !order.includes('save'); index++) {
      await page.keyboard.press('Tab')
      const active = await page.evaluate(() => {
        const element = document.activeElement
        if (!element) return null
        if (element.getAttribute('name')) return 'field:' + element.getAttribute('name')
        for (const action of ['save', 'cancel', 'refresh', 'reload', 'open']) if (element.hasAttribute('data-vacation-' + action)) return action
        return element.tagName + ':' + (element.textContent || '').trim().slice(0, 40)
      })
      if (active && order.at(-1) !== active) order.push(active)
    }
    assert.deepEqual(order, [
      'reload', 'field:enabled', 'field:startDate', 'field:endDate', 'field:subject', 'field:body',
      'field:htmlBody', 'field:replyIntervalHours', 'cancel', 'save',
    ], 'Tab order reaches every field and enabled action')
    const focus = await page.locator('[data-vacation-save]').evaluate(element => {
      const style = getComputedStyle(element)
      return { focused: document.activeElement === element, width: parseFloat(style.outlineWidth), style: style.outlineStyle }
    })
    assert.equal(focus.focused, true)
    assert.ok(focus.width >= 2 && focus.style !== 'none', 'Keyboard focus is visibly outlined')
    // Cancel opens the explicit discard dialog; Escape keeps the draft and the lock state.
    const reads = countOf(model, 'GET')
    await page.locator('[data-vacation-cancel]').click()
    await openPrompt(page)
    assert.equal(await page.locator('[data-xp-prompt-title]').textContent(), dialog.title.en)
    await closePrompt(page, 'escape')
    assert.equal(countOf(model, 'GET'), reads, 'Escape cancels discard without any request')
    assert.equal(await control(page, 'subject').inputValue(), draft.subject)
    assert.equal(await page.locator('[data-vacation-save]').isEnabled(), true)
    // Save requires dirty AND admitted: a non-admitted click cannot dispatch a write.
    const puts = countOf(model, 'PUT')
    await page.locator(rootSelector).evaluate(root => root.setAttribute('data-vacation-manage', 'false'))
    await page.locator('[data-vacation-save]').click()
    await page.waitForTimeout(100)
    assert.equal(countOf(model, 'PUT'), puts, 'Non-admitted save never dispatches')
    await page.locator(rootSelector).evaluate(root => root.setAttribute('data-vacation-manage', 'true'))
  }
  const expectedRevision = model.revision()
  assert.ok(isRevision(expectedRevision))
  const request = putRequest(page)
  await page.locator('[data-vacation-save]').click()
  const submitted = (await request).postDataJSON()
  await state(page, 'saved')
  assert.deepEqual(Object.keys(submitted).sort(), [...fieldKeys, 'expectedRevision'].sort())
  assert.deepEqual(submitted, { ...draftPut, expectedRevision }, 'The exact seven fields and captured revision are shipped')
  assert.equal(submitted.expectedRevision, expectedRevision, 'The PUT captures the revision read before saving')
  assert.equal(await statusText(page), messages.saved[lang])
  assert.equal(await chipText(page), chip.on[lang])
  assert.ok((await statusText(page)).includes(lang === 'ar' ? 'غير متحقق' : 'unverified'))
  assert.equal(await control(page, 'subject').inputValue(), 'Out of office: autumn', 'Canonical readback trims the subject')
  assert.equal(await control(page, 'body').inputValue(), draft.body)
  assert.equal(await control(page, 'htmlBody').inputValue(), draft.htmlBody)
  assert.equal(await control(page, 'startDate').inputValue(), '2026-11-02T08:00', 'The canonical readback fills the picker (native normalization omits zero seconds)')
  assert.equal(await control(page, 'endDate').inputValue(), '2026-11-06T17:30')
  assert.equal(await control(page, 'replyIntervalHours').inputValue(), '168')
  assert.equal(await page.locator('[data-vacation-record]').textContent(), recordText(lang, model.config.updatedAt))
  assert.equal(await page.locator('[data-vacation-preview]').textContent(), model.config.compiledSieve, 'Preview shows the returned compiledSieve')
  assert.ok((await page.locator('[data-vacation-preview]').textContent()).includes(':mime'))
  assert.ok(!(await page.locator('[data-vacation-preview]').textContent()).includes('onerror='), 'HTML source is MIME-encoded server output, never rendered')
  assert.equal(await page.locator('[data-vacation-preview]').evaluate(node => node.children.length), 0)
  await xssFree(page)
  assert.equal(await page.locator('[data-vacation-save]').isDisabled(), true, 'Save disables again when the readback is clean')
  return expectedRevision
}

async function conflictJourney(page, model, lang, savedRevision) {
  await control(page, 'subject').fill('Draft during conflict')
  const puts = countOf(model, 'PUT')
  model.conflictNextPut = true
  const request = putRequest(page)
  await page.locator('[data-vacation-save]').click()
  assert.equal((await request).postDataJSON().expectedRevision, savedRevision, 'The conflict attempt still carries the captured revision')
  await state(page, 'stale')
  assert.equal(await statusText(page), messages.stale[lang])
  assert.equal(countOf(model, 'PUT'), puts + 1, 'A stale save dispatches exactly one PUT')
  assert.equal(await control(page, 'subject').inputValue(), 'Draft during conflict', 'The conflict draft is preserved')
  assert.equal(await page.locator('[data-vacation-save]').isDisabled(), true, 'A stale workspace locks saving')
  await page.locator('[data-vacation-refresh]').click()
  await state(page, 'stale')
  assert.equal(countOf(model, 'PUT'), puts + 1, 'Refresh never retries a stale write')
  assert.equal(await control(page, 'subject').inputValue(), 'Draft during conflict')
  await reloadConfirmed(page, model, lang, { cancel: 'escape' })
  await state(page, 'stale')
  assert.equal(await control(page, 'subject').inputValue(), 'Draft during conflict', 'Cancelled reload keeps the draft')
  assert.equal(await page.locator('[data-vacation-reload]').isEnabled(), true)
  const ok = await reloadConfirmed(page, model, lang)
  assert.equal(ok, true)
  assert.equal(await statusText(page), messages.read[lang])
  assert.equal(await control(page, 'subject').inputValue(), 'Out of office: autumn', 'Confirmed reload discards the draft and reads the saved record')
  assert.equal(await page.locator('[data-vacation-save]').isDisabled(), true)
}

async function uncertainJourney(page, model, lang) {
  await control(page, 'subject').fill('Draft with unknown outcome')
  const puts = countOf(model, 'PUT')
  model.mode = 'unknown-write'
  await page.locator('[data-vacation-save]').click()
  await state(page, 'uncertain')
  assert.equal(await statusText(page), messages.uncertain[lang])
  assert.equal(countOf(model, 'PUT'), puts + 1, 'An unknown outcome dispatches exactly one PUT')
  await page.waitForTimeout(250)
  assert.equal(countOf(model, 'PUT'), puts + 1, 'An unknown outcome is never retried automatically')
  for (const key of fieldKeys) assert.equal(await control(page, key).isDisabled(), true, 'Unknown outcome locks field ' + key)
  assert.equal(await page.locator('[data-vacation-save]').isDisabled(), true)
  const reads = countOf(model, 'GET')
  await page.locator('[data-vacation-refresh]').click()
  await state(page, 'uncertain')
  assert.equal(countOf(model, 'GET'), reads + 1)
  assert.equal(countOf(model, 'PUT'), puts + 1, 'Refresh while locked never retries the write')
  assert.equal(await control(page, 'subject').inputValue(), 'Draft with unknown outcome')
  await reloadConfirmed(page, model, lang, { cancel: 'button' })
  await state(page, 'uncertain')
  assert.equal(await prompt(page).isVisible(), false)
  assert.equal(await page.locator('[data-mail-vacation] .xp-vacation-card').count(), 1)
  const ok = await reloadConfirmed(page, model, lang)
  assert.equal(ok, true)
  assert.equal(await statusText(page), messages.read[lang])
  assert.equal(await control(page, 'subject').inputValue(), 'Out of office: autumn')
  assert.equal(await control(page, 'subject').isDisabled(), false)
  model.mode = null
}

async function faultJourney(page, model, lang, mode) {
  await control(page, 'subject').fill('Draft ' + mode)
  const puts = countOf(model, 'PUT')
  model.mode = mode
  await page.locator('[data-vacation-save]').click()
  await state(page, 'uncertain')
  assert.equal(await page.locator('[data-vacation-status]').getAttribute('data-state'), 'uncertain', mode + ' must never report saved')
  assert.equal(await statusText(page), messages.uncertain[lang])
  assert.equal(countOf(model, 'PUT'), puts + 1)
  await page.waitForTimeout(250)
  assert.equal(countOf(model, 'PUT'), puts + 1, mode + ' is never retried automatically')
  model.mode = null
  const ok = await reloadConfirmed(page, model, lang)
  assert.equal(ok, true)
  assert.equal(await statusText(page), messages.read[lang])
  assert.equal(await control(page, 'subject').inputValue(), 'Draft ' + mode, 'Explicit reload adopts the stored canonical record')
}

async function settingsCase({ browser, fixture, lang, width, height, deep }) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const model = new VacationModel()
  const observed = observe(page)
  const checks = []
  const check = label => checks.push(label)
  const result = { lang, width, height, status: 'running', checks, screenshots: [] }
  let checkpoint = 'startup'
  try {
    await mockSession(page, model)
    checkpoint = 'initial-unread'
    const gate = model.holdRead()
    await page.goto(fixture.baseUrl + url('/mail/settings/autoresponder', lang), { waitUntil: 'load' })
    await page.waitForFunction(selector => document.querySelector(selector)?.querySelector('[data-vacation-status]')?.getAttribute('data-state') === 'reading', rootSelector)
    await entered(gate)
    assert.equal(countOf(model, 'GET'), 1, 'A single held read starts the workspace')
    assert.equal(await page.locator(rootSelector).getAttribute('aria-busy'), 'true')
    assert.equal(await statusText(page), messages.reading[lang])
    assert.equal(await page.locator('[data-vacation-save]').isDisabled(), true, 'Unread fields cannot save')
    for (const key of fieldKeys) assert.equal(await control(page, key).isDisabled(), true, 'Unread field is locked: ' + key)
    const raw = await (await page.request.get(page.url())).text()
    assert.match(raw, /data-vacation-status data-state="unread" role="status" aria-live="polite">/, 'The server-rendered initial status is unread')
    assert.ok(raw.includes(messages.unread[lang]), 'The initial unread copy is rendered before hydration')
    assert.match(raw, /data-vacation-save disabled/)
    check('initial-unread-status-and-disabled-fields')
    gate.release()
    await state(page, 'read')
    checkpoint = 'read'
    await readState(page, model, lang, width)
    check('get-read-all-seven-fields-preview-and-truth-copy')
    await xssFree(page)
    check('no-innerHTML-evaluation-of-sources')
    result.screenshots.push(lang + '-' + width + '-settings-read.png')
    await page.screenshot({ path: output + '/' + result.screenshots.at(-1), fullPage: true })
    checkpoint = 'save'
    await saveJourney(page, model, lang, deep)
    const savedRevision = model.revision()
    check('canonical-put-body-captured-revision-and-saved-readback')
    checkpoint = 'geometry'
    const measured = await geometry(page)
    result.geometry = measured
    writeFileSync(output + '/' + lang + '-' + width + '-geometry.json', JSON.stringify({ lang, width, geometry: measured }, null, 2))
    assertGeometry(measured, lang, width)
    check('actual-8-16-24-spacing-24-16-padding-rtl-ascii-no-overflow')
    result.screenshots.push(lang + '-' + width + '-settings-saved.png')
    await page.screenshot({ path: output + '/' + result.screenshots.at(-1), fullPage: true })
    checkpoint = 'conflict'
    await conflictJourney(page, model, lang, savedRevision)
    check('stale-conflict-preserves-draft-no-retry-and-confirmed-reload')
    checkpoint = 'uncertain'
    await uncertainJourney(page, model, lang)
    check('unknown-outcome-locks-without-retry-refresh-keeps-lock-explicit-reload-clears')
    await page.screenshot({ path: output + '/' + lang + '-' + width + '-uncertain-lock.png', fullPage: true })
    result.screenshots.push(lang + '-' + width + '-uncertain-lock.png')
    checkpoint = 'no-other-transport'
    for (const request of observed.apiRequests) {
      assert.equal(request.path, api, 'Only the vacation endpoint may be called: ' + request.method + ' ' + request.path)
      assert.equal(request.search, '')
    }
    check('only-vacation-get-put-transport')
    if (deep) {
      checkpoint = 'foreign-ack'
      await faultJourney(page, model, lang, 'foreign-ack')
      check('foreign-context-ack-never-saved')
      checkpoint = 'wrong-readback'
      await faultJourney(page, model, lang, 'wrong-readback')
      check('mismatched-readback-never-saved')
    }
    assert.deepEqual(model.errors, [], 'The synthetic contract held for every request')
    assert.deepEqual(observed.pageErrors, [], 'No page errors')
    result.expectedConsole = observed.consoleErrors.filter(expectedFaultConsole)
    assert.deepEqual(observed.consoleErrors.filter(text => !expectedFaultConsole(text)), [], 'No unexpected console errors')
    assert.equal(await page.locator('[data-xp-prompt]').isVisible(), false)
    result.status = 'passed'
    result.calls = model.calls
    result.apiRequests = observed.apiRequests
  } catch (error) {
    result.status = 'failed'
    result.checkpoint = checkpoint
    result.error = String(error)
    try { result.diagnostic = await page.evaluate(selector => {
      const root = document.querySelector(selector)
      return {
        url: location.href, width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        rootCount: document.querySelectorAll(selector).length,
        state: root?.querySelector('[data-vacation-status]')?.getAttribute('data-state'),
        status: root?.querySelector('[data-vacation-status]')?.textContent, busy: root?.getAttribute('aria-busy'),
        chip: root?.querySelector('[data-vacation-requested]')?.textContent,
        subject: root?.querySelector('[name="subject"]')?.value, preview: root?.querySelector('[data-vacation-preview]')?.textContent?.slice(0, 400),
      }
    }, rootSelector) } catch (diagnosticError) { result.diagnostic = { error: String(diagnosticError) } }
    result.screenshot = lang + '-' + width + '-failure.png'
    try { await page.screenshot({ path: output + '/' + result.screenshot, fullPage: true }) } catch (captureError) { result.captureError = String(captureError); delete result.screenshot }
    result.calls = model.calls
    result.checks = checks
    result.mockErrors = model.errors
    result.pageErrors = observed.pageErrors
    result.consoleErrors = observed.consoleErrors
    process.exitCode = 1
  } finally {
    await context.close().catch(() => {})
  }
  return result
}

async function composeCase({ browser, fixture }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const model = new VacationModel()
  const observed = observe(page)
  const checks = []
  const check = label => checks.push(label)
  const result = { lang: 'en', width: 1440, height: 900, screen: 'compose', status: 'running', checks, screenshots: [] }
  let checkpoint = 'startup'
  try {
    await mockSession(page, model)
    checkpoint = 'compose-read'
    await page.goto(fixture.baseUrl + url('/mail/compose', 'en'), { waitUntil: 'load' })
    await state(page, 'read')
    const root = page.locator(rootSelector)
    assert.equal(await root.count(), 1)
    assert.equal(await root.getAttribute('data-vacation-compact'), 'true')
    assert.equal(await root.getAttribute('data-vacation-manage'), 'true')
    assert.equal(await root.getAttribute('dir'), 'ltr')
    assert.equal(await statusText(page), messages.read.en)
    assert.equal(await chipText(page), chip.on.en, 'The collapsed card carries the requested-on unverified chip')
    assert.equal(await page.locator('[data-vacation-panel]').isHidden(), true)
    assert.equal(await page.locator('[data-vacation-open]').isVisible(), true)
    assert.equal(await page.locator('[data-vacation-open]').getAttribute('aria-expanded'), 'false')
    assert.equal(await page.locator('[data-vacation-open]').getAttribute('aria-controls'), await page.locator('[data-vacation-panel]').getAttribute('id'))
    assert.equal(await page.locator('[data-vacation-save]').isDisabled(), true, 'A clean collapsed card cannot save')
    assert.equal(await page.locator('[data-mail-vacation] form').count(), 0, 'The vacation card introduces no native form')
    assert.equal(await page.locator('[data-vacation-form]').evaluate(node => node.tagName + '/' + node.getAttribute('role')), 'DIV/group', 'The card keeps the group boundary instead of a form')
    assert.equal(await page.locator('[data-mail-layout="reference"]').count(), 1, 'The mail layout boundary stays intact')
    assert.equal(await page.locator('[data-compose-form]').count(), 1)
    assert.equal(await page.locator('form').count(), 1, 'The only document form remains the read-only search form')
    assert.equal(await page.locator('[data-vacation-preview]').textContent(), model.config.compiledSieve)
    check('compose-collapsed-card-truthful-chip-and-no-native-form')
    checkpoint = 'compose-open'
    await page.locator('[data-vacation-open]').click()
    assert.equal(await page.locator('[data-vacation-panel]').isHidden(), false)
    assert.equal(await page.locator('[data-vacation-open]').isHidden(), true)
    assert.equal(await page.locator('[data-vacation-open]').getAttribute('aria-expanded'), 'true')
    checkpoint = 'compose-save'
    await control(page, 'subject').fill(composeDraft.subject)
    assert.equal(await page.locator('[data-vacation-save]').isEnabled(), true)
    await control(page, 'body').fill(composeDraft.body)
    await control(page, 'htmlBody').fill(composeDraft.htmlBody)
    await control(page, 'replyIntervalHours').fill(composeDraft.replyIntervalHours)
    await xssFree(page)
    const expectedRevision = model.revision()
    const request = putRequest(page)
    await page.locator('[data-vacation-save]').click()
    const submitted = (await request).postDataJSON()
    await state(page, 'saved')
    assert.deepEqual(Object.keys(submitted).sort(), [...fieldKeys, 'expectedRevision'].sort())
    assert.deepEqual(submitted, {
      enabled: true, subject: composeDraft.subject, body: composeDraft.body, htmlBody: composeDraft.htmlBody,
      startDate: null, endDate: null, replyIntervalHours: 48, expectedRevision,
    }, 'Compose PUT carries the exact fields and captured revision')
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-mail-vacation]')
      const panel = root.querySelector('[data-vacation-panel]'), open = root.querySelector('[data-vacation-open]')
      return panel.hidden && !open.hidden && open.getAttribute('aria-expanded') === 'false'
    })
    assert.equal(await statusText(page), messages.saved.en)
    assert.equal(await chipText(page), chip.on.en, 'After save the chip only requests activation and stays unverified')
    assert.ok((await statusText(page)).includes('unverified'))
    assert.equal(await page.locator('[data-vacation-open]').evaluate(node => document.activeElement === node), true, 'Collapsing returns focus to the collapsed card trigger')
    assert.equal(await control(page, 'subject').inputValue(), 'Compact responder draft', 'The saved readback is canonical')
    assert.equal(await control(page, 'htmlBody').inputValue(), xss, 'HTML source stays literal text')
    assert.equal(await page.locator('[data-vacation-preview]').textContent(), model.config.compiledSieve)
    assert.ok((await page.locator('[data-vacation-preview]').textContent()).includes(':mime'))
    assert.ok(!(await page.locator('[data-vacation-preview]').textContent()).includes('onerror='))
    assert.equal(await page.locator('[data-vacation-preview]').evaluate(node => node.children.length), 0)
    const text = await root.textContent()
    assert.ok(!/nativeApplied|native applied/i.test(text), 'Compose never claims a native application')
    await xssFree(page)
    check('compose-open-save-collapse-truthful-chip-no-native-applied-claim')
    checkpoint = 'compose-cancel'
    await page.locator('[data-vacation-open]').click()
    await control(page, 'subject').fill('Compact cancel draft')
    const reads = countOf(model, 'GET')
    await page.locator('[data-vacation-cancel]').click()
    await openPrompt(page)
    await closePrompt(page, 'escape')
    assert.equal(await page.locator('[data-vacation-panel]').isHidden(), false, 'Escape keeps the compact panel open')
    assert.equal(await control(page, 'subject').inputValue(), 'Compact cancel draft')
    assert.equal(countOf(model, 'GET'), reads, 'Escape cancels without any request')
    await page.locator('[data-vacation-cancel]').click()
    await openPrompt(page)
    await closePrompt(page, 'confirm')
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-mail-vacation]')
      return root.querySelector('[data-vacation-panel]').hidden && !root.querySelector('[data-vacation-open]').hidden
    })
    assert.equal(await statusText(page), messages.read.en)
    assert.equal(await control(page, 'subject').inputValue(), 'Compact responder draft', 'Confirmed cancel discards only the draft')
    check('compose-cancel-escape-and-confirmed-discard-collapse')
    checkpoint = 'compose-layout'
    const card = await page.locator('.xp-mail-vacation .xp-vacation-card').evaluate(node => {
      const style = getComputedStyle(node)
      return { padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat), gap: parseFloat(style.rowGap), scrollWidth: document.documentElement.scrollWidth, innerWidth, direction: getComputedStyle(node).direction }
    })
    for (const side of card.padding) assert.ok(Math.abs(side - 24) <= 1, 'Compose desktop card padding is 24')
    assert.ok(Math.abs(card.gap - 24) <= 1)
    assert.ok(card.scrollWidth <= card.innerWidth + 1)
    assert.equal(card.direction, 'ltr')
    result.geometry = card
    check('compose-desktop-card-padding-and-overflow')
    for (const request of observed.apiRequests) {
      assert.equal(request.path, api, 'Only the vacation endpoint may be called: ' + request.method + ' ' + request.path)
      assert.equal(request.search, '')
    }
    assert.deepEqual(model.errors, [])
    assert.deepEqual(observed.pageErrors, [])
    assert.deepEqual(observed.consoleErrors, [], 'No console errors')
    result.screenshots.push('en-1440-compose-collapsed.png')
    await page.screenshot({ path: output + '/' + result.screenshots.at(-1), fullPage: true })
    result.status = 'passed'
  } catch (error) {
    result.status = 'failed'
    result.checkpoint = checkpoint
    result.error = String(error)
    try { result.diagnostic = await page.evaluate(selector => {
      const root = document.querySelector(selector)
      return { url: location.href, width: innerWidth, state: root?.querySelector('[data-vacation-status]')?.getAttribute('data-state'), status: root?.querySelector('[data-vacation-status]')?.textContent, chip: root?.querySelector('[data-vacation-requested]')?.textContent, panelHidden: root?.querySelector('[data-vacation-panel]')?.hidden, subject: root?.querySelector('[name="subject"]')?.value }
    }, rootSelector) } catch (diagnosticError) { result.diagnostic = { error: String(diagnosticError) } }
    result.screenshot = 'en-1440-compose-failure.png'
    try { await page.screenshot({ path: output + '/' + result.screenshot, fullPage: true }) } catch (captureError) { result.captureError = String(captureError); delete result.screenshot }
    result.mockErrors = model.errors
    result.pageErrors = observed.pageErrors
    result.consoleErrors = observed.consoleErrors
    process.exitCode = 1
  } finally {
    await context.close().catch(() => {})
  }
  return result
}

assert.notEqual(output, resolve('.'), 'The evidence directory must be an explicit test-results target')
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
const before = sourceSnapshot()
const started = performance.now()
const runtime = { node: process.version }
const cases = []
let fixture, browser, active = { lang: 'unknown', width: 0, checkpoint: 'startup' }
try {
  browser = await chromium.launch({ headless: true })
  runtime.chromium = browser.version()
  fixture = await createVisualFixture({ qualifiedCatalog: true })
  const layouts = [['en', 1440, 900], ['ar', 1440, 900], ['en', 390, 844], ['ar', 390, 844]]
  for (const [lang, width, height] of layouts) {
    active = { lang, width, checkpoint: 'layout' }
    cases.push(await settingsCase({ browser, fixture, lang, width, height, deep: lang === 'en' && width === 1440 }))
  }
  active = { lang: 'en', width: 1440, checkpoint: 'compose' }
  cases.push(await composeCase({ browser, fixture }))
} catch (error) {
  let diagnostic = null
  if (cases.some(item => item.status === 'failed')) diagnostic = { error: String(error) }
  else {
    let failure = null
    try { failure = { active, error: String(error) } } catch { failure = { active } }
    cases.push({ ...active, status: 'failed', checkpoint: active.checkpoint, error: String(error), diagnostic })
    process.exitCode = 1
  }
} finally {
  await browser?.close()
  await fixture?.close()
  const after = sourceSnapshot()
  const sourceUnchanged = JSON.stringify(before) === JSON.stringify(after)
  if (!sourceUnchanged) process.exitCode = 1
  const passed = cases.filter(item => item.status === 'passed').length
  const report = {
    at: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    runtime,
    scope: {
      synthetic_only: true,
      transport: 'Explicit synthetic session window.xpanelSessionRequest; only /api/webmail/vacation GET/PUT intercepted with page.route.',
      limitation: 'Real affected xMail vacation responder renderer/controller in real Chromium against the loopback visual fixture. No mailbox authentication, mail delivery, native Sieve installation, automatic replies, service qualification, physical device or production behavior is exercised. The UI only edits saved configuration and activation remains unverified (nativeApplied:false).',
      contexts: ['EN desktop 1440x900', 'AR desktop 1440x900', 'EN phone 390x844', 'AR phone 390x844', 'EN desktop 1440x900 compose compact card'],
    },
    output,
    sourceUnchanged,
    before,
    after,
    totals: { contexts: cases.length, passed, failed: cases.length - passed },
    cases,
  }
  writeFileSync(output + '/results.json', JSON.stringify(report, null, 2))
  writeFileSync(output + '/source-hashes.json', JSON.stringify({ before, after, unchanged: sourceUnchanged }, null, 2))
  console.log(JSON.stringify({
    status: process.exitCode ? 'failed' : 'passed',
    contexts: cases.length,
    passed,
    failed: cases.length - passed,
    durationMs: report.durationMs,
    output,
    syntheticOnly: true,
  }))
}
