// Actual xMail folder renderer/controller, explicit synthetic mailbox session/HTTP.
// No IMAP connection, sealed-session authentication, delivery, send or purge proof.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createVisualFixture } from './visual-fixture.mjs'

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.tools/playwright-browsers')
const { chromium } = await import('@playwright/test')
const output = resolve(process.env.XPANEL_MAIL_FOLDER_WORKSPACE_OUTPUT || 'test-results/completion-mail-folder-workspace')
const sourcePaths = ['apps/web/src/mail-folder-workspace-client.ts', 'apps/web/src/board-port/xmail-inbox.ts', 'apps/web/src/surfaces/xmail.ts', 'apps/web/src/ws-client.ts', 'apps/web/src/login-client.ts', 'apps/web/src/mail-layout.ts', 'tests/browser/visual-fixture.mjs', 'tests/browser/completion-mail-folder-workspace.mjs']
const snapshot = () => sourcePaths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
const clone = value => JSON.parse(JSON.stringify(value))
const mailbox = 'info@preview.example.test', api = '/api/webmail/inbox'
const rootSelector = '[data-mail-folder-workspace="true"]'
const row = (page, uid) => page.locator(rootSelector + ' [data-mail-open][data-mail-uid="' + uid + '"]')
const action = (page, name) => page.locator(rootSelector + ' [data-mail-action="' + name + '"]')
const moves = model => model.calls.filter(call => call.method === 'POST')
// Each folder has one observed UIDVALIDITY; moves are bound to the source folder's value.
const UIDVALIDITY = { INBOX: 1001, Sent: 1002, Drafts: 1003, Trash: 1004, Archive: 1005 }
const message = (uid, folder, suffix = '') => ({ uid, uidValidityObserved: true, uidValidity: UIDVALIDITY[folder], from: 'sender@example.test', fromName: 'Synthetic sender', to: mailbox, subject: folder + ' synthetic ' + suffix, receivedAt: '2026-01-01T12:00:00Z', unread: true, sizeBytes: 128, preview: folder + ' preview', attachments: [], body: folder + ' plaintext body ' + suffix + ' <img src="https://invalid.example.test/pixel" onerror="window.mailBodyExecuted=true">' })

class MockFolders {
  constructor() {
    // Identical UIDs in different folders deliberately exercise exact folder binding.
    this.folders = new Map(['INBOX', 'Sent', 'Drafts', 'Trash', 'Archive'].map(folder => [folder, new Map([[101, message(101, folder, 'first')], [102, message(102, folder, 'second')]])]))
    this.nextUid = 1000; this.calls = []; this.errors = []; this.mode = null; this.gates = []; this.canMove = true; this.remoteRequests = []; this.attachmentReads = []
  }
  hold(kind) {
    let entered, release
    const gate = { kind, started: false, enteredPromise: new Promise(resolve => { entered = resolve }), promise: new Promise(resolve => { release = resolve }), entered: () => entered(), release: () => release() }
    this.gates.push(gate); return gate
  }
  async route(route) {
    const request = route.request(), url = new URL(request.url()), method = request.method()
    if (url.pathname === '/api/webmail/attachment-workspace') {
      // The reading pane reads the selected message's attachment manifest; the synthetic messages have none.
      const folder = url.searchParams.get('folder'), uid = Number(url.searchParams.get('uid')), uidValidity = Number(url.searchParams.get('uidValidity'))
      assert.equal(method, 'GET'); assert.ok(this.folders.get(folder)?.has(uid), 'Attachment reads target an existing message'); assert.equal(uidValidity, UIDVALIDITY[folder])
      this.attachmentReads.push({ folder, uid, uidValidity })
      await route.fulfill({ status: 200, json: { context: { mailbox, folder, uid, uidValidity }, attachments: [] } }); return
    }
    const match = /^\/api\/webmail\/inbox(?:\/([0-9]+)(\/move)?)?$/.exec(url.pathname)
    assert.ok(match, 'Only existing scoped folder/list/read/move endpoints are mocked: ' + method + ' ' + url.pathname)
    const uid = match[1] ? Number(match[1]) : null, move = Boolean(match[2]), body = method === 'POST' ? request.postDataJSON() : undefined
    assert.ok(['GET', 'POST'].includes(method), 'Permanent delete/send are outside this harness')
    const folder = move ? body.from : url.searchParams.get('folder')
    assert.ok(this.folders.has(folder)); assert.ok(!move || method === 'POST')
    assert.equal(url.search, move ? '' : '?folder=' + encodeURIComponent(folder))
    this.calls.push({ method, path: url.pathname, folder, ...(body ? { body: clone(body) } : {}) })
    const kind = move ? 'move' : uid ? 'read' : 'list', captured = uid ? clone(this.folders.get(folder).get(uid)) : [...this.folders.get(folder).values()].map(({ body, ...summary }) => clone(summary))
    const gate = this.gates.find(item => item.kind === kind && !item.started)
    if (gate) { gate.started = true; gate.entered(); await gate.promise }
    let status = 200, result
    if (kind === 'list') {
      result = { mailbox, folder, complete: true, messages: captured, capabilities: { move: this.canMove } }
      if (this.mode === 'foreign-mailbox') result.mailbox = 'other@example.test'
      if (this.mode === 'wrong-folder') result.folder = folder === 'Sent' ? 'Drafts' : 'Sent'
      if (this.mode === 'incomplete-list') result.complete = false
      if (this.mode === 'duplicate-uid') result.messages.push(clone(result.messages[0]))
    } else if (kind === 'read') {
      assert.ok(captured, 'Read UID belongs to its explicit selected folder')
      result = { mailbox, folder, message: captured }
      if (this.mode === 'foreign-read') result.mailbox = 'other@example.test'
      if (this.mode === 'wrong-read-uid') result.message.uid = uid + 1
    } else {
      assert.deepEqual(Object.keys(body).sort(), ['folder', 'from', 'uidValidity']); assert.equal(body.uidValidity, UIDVALIDITY[folder]); assert.ok(this.folders.has(body.folder)); assert.ok(this.canMove)
      const original = this.folders.get(folder).get(uid); assert.ok(original)
      if (this.mode === 'explicit-refusal') { status = 412; result = { code: 'synthetic_move_refused', details: { stateChanged: false } } }
      else if (folder === body.folder) result = { ok: true, mailbox, from: folder, sourceUid: uid, sourceUidValidity: body.uidValidity, folder: body.folder, uid, destinationUidKnown: false, stateChanged: false, uidValidityObserved: false }
      else {
        const destinationUid = ++this.nextUid
        this.folders.get(folder).delete(uid); this.folders.get(body.folder).set(destinationUid, { ...original, uid: destinationUid, uidValidity: UIDVALIDITY[body.folder] })
        result = { ok: true, mailbox, from: folder, sourceUid: uid, sourceUidValidity: body.uidValidity, folder: body.folder, uid: destinationUid, destinationUidKnown: true, stateChanged: true, uidValidityObserved: true, uidValidity: UIDVALIDITY[body.folder] }
        if (this.mode === 'unknown-mapping') { result.uid = null; result.destinationUidKnown = false; result.uidValidityObserved = false; delete result.uidValidity }
        if (this.mode === 'wrong-source') result.sourceUid = uid + 1
        if (this.mode === 'wrong-destination') result.folder = 'Archive'
        if (this.mode === 'unknown-write') { status = 503; result = { code: 'synthetic_move_unknown', details: { stateChanged: true, unknownOutcome: true, verificationRequired: true } } }
        if (this.mode === 'unknown-403') { status = 403; result = { code: 'synthetic_move_post_dispatch_refused', details: {} } }
      }
    }
    if (status >= 400) result = { type: 'about:blank', title: 'Synthetic mailbox request refused', status, detail: 'Synthetic mailbox request failure', ...result }
    await route.fulfill({ status, json: result })
  }
}
async function mockSession(page, model) {
  await page.addInitScript(() => {
    const transport = async (method, path, body) => {
      const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const value = await response.json()
      if (!response.ok) { const problem = value.error || value; throw Object.assign(new Error(problem.detail || problem.message || 'mock_mail_error'), { status: response.status, code: problem.code, details: problem.details || {} }) }
      return value
    }
    Object.defineProperty(window, 'xpanelSessionRequest', { get: () => transport, set: () => {}, configurable: false })
  })
  await page.route('**/api/webmail/**', async route => { try { await model.route(route) } catch (error) { model.errors.push(String(error)); await route.fulfill({ status: 500, json: { status: 500, code: 'mock_folder_contract_failure', details: { verificationRequired: true, unknownOutcome: true } } }) } })
  await page.route('https://invalid.example.test/**', route => { model.remoteRequests.push(route.request().url()); return route.abort() })
}
async function state(page, wanted) {
  await page.waitForFunction(({ selector, wanted }) => { const root = document.querySelector(selector); return root?.querySelector('[data-mail-folder-status]')?.getAttribute('data-state') === wanted && root.querySelector('[data-mail-action="refresh"]')?.disabled === false }, { selector: rootSelector, wanted })
}
async function visit(page, fixture, lang, folder) {
  await page.goto(fixture.baseUrl + '/mail/' + folder.toLowerCase() + '?lang=' + lang + '&theme=light', { waitUntil: 'load' })
  await state(page, 'read'); assert.equal(await page.locator(rootSelector).getAttribute('data-mail-folder'), folder)
}
async function open(page, uid, body) {
  await row(page, uid).click()
  await page.waitForFunction(({ selector, body }) => document.querySelector(selector + ' [data-mail-detail-body]')?.textContent.includes(body), { selector: rootSelector, body })
}
async function entered(gate) {
  let timer
  try { await Promise.race([gate.enteredPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected held mailbox request did not start')), 10000) })]) }
  finally { clearTimeout(timer) }
}
async function moveTo(page, folder) {
  await action(page, 'toggle-move').click(); await page.locator(rootSelector + ' [data-mail-action="move"][data-folder="' + folder + '"]').click(); await confirmation(page)
}
async function confirmation(page, accept = true) {
  await page.locator('[data-xp-prompt-confirm]').waitFor({ state: 'visible' })
  await page.locator(accept ? '[data-xp-prompt-confirm]' : '[data-xp-prompt-cancel]').click()
}
async function geometry(page) {
  return page.locator(rootSelector).evaluate(root => {
    const visible = node => !!node.getClientRects().length && !node.closest('[hidden]') && getComputedStyle(node).visibility !== 'hidden'
    const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom } }
    const controls = [...root.querySelectorAll('[data-mail-open],[data-mail-action="toggle-move"],[data-mail-action="move"],[data-mail-action="restore"],[data-mail-folder-review],input[type=search]')].filter(visible).map(node => ({ kind: node.getAttribute('data-mail-action') || (node.hasAttribute('data-mail-open') ? 'message' : node.tagName), box: rect(node), label: node.getAttribute('aria-label') || node.textContent, direction: getComputedStyle(node).direction }))
    const technical = [...root.querySelectorAll('bdi[dir=ltr]')].filter(visible).map(node => ({ text: node.textContent, direction: getComputedStyle(node).direction, isolation: getComputedStyle(node).unicodeBidi, box: rect(node) }))
    const inputs = [...root.querySelectorAll('input,select')].filter(visible).map(node => ({ name: node.name, type: node.type, label: node.getAttribute('aria-label') || (node.id ? root.querySelector('label[for="' + node.id + '"]')?.textContent : ''), box: rect(node) }))
    const reading = root.querySelector('[data-mail-detail-body]')
    return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, direction: getComputedStyle(root).direction, controls, technical, inputs, reading: reading ? rect(reading) : null, activeFolder: root.getAttribute('data-mail-folder') }
  })
}
function assertGeometry(value, lang, width) {
  assert.equal(value.direction, lang === 'ar' ? 'rtl' : 'ltr'); assert.ok(value.pageWidth <= width + 1, 'Affected mail page must contain overflow')
  assert.ok(value.controls.some(control => control.kind === 'message'), 'Actual message list measured')
  assert.ok(value.controls.some(control => control.kind === 'move'), 'Expanded move targets measured within the functional flow')
  for (const control of value.controls) { assert.ok(control.box.width >= 43.5 && control.box.height >= 43.5, 'Mail control target: ' + control.kind); assert.ok(control.box.width <= width + 1, 'Contained mail control') }
  assert.ok(value.inputs.length > 0, 'Actual visible mail search fields measured'); for (const input of value.inputs) { assert.ok(input.label); assert.ok(input.box.height >= 43.5) }
  assert.ok(value.reading && value.reading.width > 0 && value.reading.width <= width + 1, 'Actual selected message body geometry')
  for (const token of value.technical) { assert.equal(token.direction, 'ltr'); assert.ok(token.isolation.includes('isolate')) }
}

mkdirSync(output, { recursive: true })
const before = snapshot(), started = performance.now()
const cases = [], runtime = { node: process.version }
let checkpoint = 'startup', activePage, activeModel, activeContext, activeGeometry, geometryCheckpoint, activeCapture, fixture, browser
try {
  browser = await chromium.launch({ headless: true }); runtime.chromium = browser.version()
  fixture = await createVisualFixture({ qualifiedCatalog: true })
  for (const lang of ['en', 'ar']) for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' }), page = await context.newPage(), model = new MockFolders(), pageErrors = []
    activePage = page; activeModel = model; activeContext = { lang, width }; activeGeometry = null; geometryCheckpoint = null; activeCapture = null; page.setDefaultTimeout(10000); page.on('pageerror', error => pageErrors.push(error.name + ': ' + error.message))
    await mockSession(page, model); checkpoint = lang + '-' + width + ':sent-list-read'
    await visit(page, fixture, lang, 'Sent'); assert.equal(await page.locator(rootSelector).getAttribute('data-mailbox'), mailbox)
    const search = page.locator(rootSelector + ' input[type=search]').first(); await search.fill('synthetic')
    await open(page, 101, model.folders.get('Sent').get(101).body)
    assert.equal(await page.evaluate(() => window.mailBodyExecuted === true), false, 'Read body remains plain text')
    await action(page, 'toggle-move').click(); const measured = await geometry(page); activeGeometry = measured; geometryCheckpoint = checkpoint
    writeFileSync(output + '/' + lang + '-' + width + '-geometry.json', JSON.stringify({ lang, width, checkpoint, geometry: measured }, null, 2))
    const capturePath = output + '/' + lang + '-' + width + '-sent-move.png'
    await page.screenshot({ path: capturePath, fullPage: true }); activeCapture = capturePath
    assertGeometry(measured, lang, width)
    await page.locator(rootSelector + ' [data-mail-action="move"][data-folder="Trash"]').click(); await confirmation(page); await state(page, 'saved')
    const moved = moves(model).at(-1), destinationUid = model.nextUid
    assert.equal(moved.path, api + '/101/move'); assert.deepEqual(moved.body, { from: 'Sent', folder: 'Trash', uidValidity: UIDVALIDITY.Sent }); assert.notEqual(destinationUid, 101)
    checkpoint = lang + '-' + width + ':known-uid-undo'
    await action(page, 'undo').click(); await confirmation(page); await state(page, 'saved')
    const undone = moves(model).at(-1); assert.equal(undone.path, api + '/' + destinationUid + '/move'); assert.deepEqual(undone.body, { from: 'Trash', folder: 'Sent', uidValidity: UIDVALIDITY.Trash })
    assert.equal(await search.inputValue(), 'synthetic', 'Move/readback keeps the current search draft')
    checkpoint = lang + '-' + width + ':drafts-read-reversible-move'
    await visit(page, fixture, lang, 'Drafts'); await open(page, 101, model.folders.get('Drafts').get(101).body); await moveTo(page, 'Sent'); await state(page, 'saved'); await action(page, 'undo').click(); await confirmation(page); await state(page, 'saved')
    assert.deepEqual(moves(model).at(-1).body, { from: 'Sent', folder: 'Drafts', uidValidity: UIDVALIDITY.Sent })
    checkpoint = lang + '-' + width + ':trash-restore'
    await visit(page, fixture, lang, 'Trash'); await open(page, 101, model.folders.get('Trash').get(101).body); await action(page, 'restore').click(); await confirmation(page); await state(page, 'saved')
    assert.deepEqual(moves(model).at(-1).body, { from: 'Trash', folder: 'INBOX', uidValidity: UIDVALIDITY.Trash }); assert.equal(model.calls.some(call => call.method === 'DELETE'), false)
    if (lang === 'en' && width === 1440) {
      checkpoint = 'late-body-selection'
      const first = message(3001, 'Sent', 'delayed body'), second = message(3002, 'Sent', 'newest body'); model.folders.get('Sent').set(first.uid, first); model.folders.get('Sent').set(second.uid, second)
      await visit(page, fixture, lang, 'Sent'); const gate = model.hold('read'); await row(page, first.uid).click(); await entered(gate)
      await open(page, second.uid, second.body)
      const response = page.waitForResponse(response => new URL(response.url()).pathname === api + '/' + first.uid && response.request().method() === 'GET')
      gate.release(); await (await response).finished(); await page.evaluate(() => new Promise(requestAnimationFrame))
      assert.equal(await page.locator(rootSelector + ' [data-mail-open][aria-current=true]').getAttribute('data-mail-uid'), String(second.uid)); assert.ok((await page.locator(rootSelector + ' [data-mail-detail-body]').textContent()).includes(second.body))
      checkpoint = 'cancel-confirmation-pins-selection'
      await open(page, 102, model.folders.get('Sent').get(102).body)
      const beforeCancel = model.calls.length
      await action(page, 'toggle-move').click(); await page.locator(rootSelector + ' [data-mail-action="move"][data-folder="Trash"]').click(); await page.locator('[data-xp-prompt-confirm]').waitFor({ state: 'visible' })
      assert.equal(await row(page, first.uid).isDisabled(), true); await row(page, first.uid).dispatchEvent('click'); await confirmation(page, false); await state(page, 'read')
      assert.equal(model.calls.length, beforeCancel, 'Cancelled move dispatches neither a pre-read nor a mutation'); assert.equal(await row(page, 102).getAttribute('aria-current'), 'true')
      for (const mode of ['foreign-read', 'wrong-read-uid']) {
        checkpoint = mode; model.mode = mode; await row(page, first.uid).click(); await state(page, 'failed'); assert.ok((await page.locator(rootSelector + ' [data-mail-detail-body]').textContent()).includes(model.folders.get('Sent').get(102).body)); model.mode = null
      }
      checkpoint = 'explicit-refusal'; await visit(page, fixture, lang, 'Sent'); await open(page, 102, model.folders.get('Sent').get(102).body); model.mode = 'explicit-refusal'; await moveTo(page, 'Trash'); await state(page, 'failed'); assert.equal(model.folders.get('Sent').has(102), true); assert.equal(await row(page, 102).isVisible(), true); model.mode = null
      for (const mode of ['unknown-mapping', 'unknown-write', 'unknown-403', 'wrong-source', 'wrong-destination']) {
        checkpoint = mode
        const candidate = message(200 + model.nextUid, 'Sent', mode); model.folders.get('Sent').set(candidate.uid, candidate)
        await visit(page, fixture, lang, 'Sent'); await open(page, candidate.uid, candidate.body); model.mode = mode; await moveTo(page, 'Trash'); await state(page, 'uncertain')
        const count = moves(model).length
        assert.equal(await page.locator(rootSelector + ' [data-mail-action="undo"]:visible').count(), 0, 'Unknown mapping/outcome cannot expose an unsafe Undo')
        model.mode = null; await page.locator(rootSelector + ' [data-mail-folder-review]').click(); await state(page, 'read'); assert.equal(moves(model).length, count, 'Review never replays or guesses a destination UID')
      }
      for (const mode of ['foreign-mailbox', 'wrong-folder', 'incomplete-list', 'duplicate-uid']) {
        checkpoint = mode; model.mode = mode; await page.reload({ waitUntil: 'load' }); await state(page, 'failed'); model.mode = null; await action(page, 'refresh').click(); await state(page, 'read')
      }
      checkpoint = 'unsupported-move'; model.canMove = false; await visit(page, fixture, lang, 'Drafts'); await open(page, 102, model.folders.get('Drafts').get(102).body); assert.equal(await action(page, 'toggle-move').isDisabled(), true)
    }
    assert.deepEqual(model.errors, []); assert.ok(model.attachmentReads.length > 0, 'An opened message reads its attachment manifest'); assert.deepEqual(pageErrors, []); assert.deepEqual(model.remoteRequests, [], 'Plain message body must not fetch embedded remote resources')
    cases.push({ lang, width, status: 'passed', geometry: measured, calls: model.calls, pageErrors, remoteRequests: model.remoteRequests, checks: ['Sent/Drafts/Trash actual folder lists and scoped reads', 'plain text body with no remote-resource fetch', 'known destination UID move/readback and reversible undo', 'Trash restore without permanent delete/send', 'visible expanded move/search/detail geometry in same flow', ...(lang === 'en' && width === 1440 ? ['latest body selection wins over late reply', 'cancelled move locks/pins selection without dispatch', 'foreign/wrong-UID read preserves prior body', 'unknown UID/result locks and explicit review without retry', 'foreign/incomplete/duplicate scoped list rejection', 'unsupported move unavailable'] : [])] })
    await context.close()
  }
} catch (error) {
  const hasPage = activePage && !activePage.isClosed()
  const diagnostic = hasPage ? await activePage.evaluate(selector => {
    const root = document.querySelector(selector), visible = node => !!node.getClientRects().length && !node.closest('[hidden]')
    const unavailable = [...document.querySelectorAll('[data-capability-state],[data-page-state],[data-wiring],[role=alert]')].filter(visible).map(node => ({ capability: node.getAttribute('data-capability-state'), page: node.getAttribute('data-page-state'), wiring: node.getAttribute('data-wiring'), text: node.textContent.replace(/\s+/g, ' ').trim().slice(0, 500) }))
    return { url: location.href, title: document.title, readyState: document.readyState, viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth, expectedSelector: selector, rootCount: document.querySelectorAll(selector).length, headings: [...document.querySelectorAll('h1,h2')].filter(visible).map(node => node.textContent.trim()), unavailable, visiblePageText: document.body.innerText.slice(0, 1600), root: root ? { folder: root.getAttribute('data-mail-folder'), state: root.querySelector('[data-mail-folder-status]')?.getAttribute('data-state'), status: root.querySelector('[data-mail-folder-status]')?.textContent } : null }
  }, rootSelector).catch(error => ({ diagnosticError: String(error) })) : null
  let screenshot = geometryCheckpoint === checkpoint ? activeCapture : null, captureError = null
  if (hasPage && !screenshot) {
    screenshot = output + '/' + (activeContext?.lang || 'unknown') + '-' + (activeContext?.width || 'unknown') + '-failure.png'
    try { await activePage.screenshot({ path: screenshot, fullPage: true }) } catch (error) { captureError = String(error); screenshot = null }
  }
  cases.push({ ...activeContext, status: 'failed', checkpoint, error: String(error), diagnostic, geometry: activeGeometry, geometryCheckpoint, screenshot, captureError, calls: activeModel?.calls, mockErrors: activeModel?.errors }); process.exitCode = 1
} finally {
  for (const gate of activeModel?.gates || []) gate.release()
  await browser?.close(); await fixture?.close()
  const after = snapshot(), sourceUnchanged = JSON.stringify(before) === JSON.stringify(after)
  if (!sourceUnchanged) process.exitCode = 1
  writeFileSync(output + '/results.json', JSON.stringify({ at: new Date().toISOString(), durationMs: Math.round(performance.now() - started), runtime, scope: 'Actual existing mail folder renderer/controller with explicit synthetic mailbox session/HTTP. No sealed-session authentication, native IMAP/mail delivery, UIDVALIDITY/CAS, send, permanent purge, recovery or full reference/font-parity proof.', sourceUnchanged, before, after, cases }, null, 2))
  console.log(JSON.stringify({ status: process.exitCode ? 'failed' : 'passed', cases: cases.length, output }))
}
