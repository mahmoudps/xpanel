// Actual account database renderer/controller with synthetic session and HTTP only.
// No MariaDB connection, authentication, credential provisioning or native grant proof.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createVisualFixture } from './visual-fixture.mjs'

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.tools/playwright-browsers')
const { chromium } = await import('@playwright/test')
const output = resolve(process.env.XPANEL_DATABASE_WORKSPACE_OUTPUT || 'test-results/completion-database-workspace')
const sourcePaths = ['apps/web/src/database-workspace-client.ts', 'apps/web/src/board-port/extensions/account-databases.ts', 'apps/web/src/board-port/approved-xpanel-workspaces.ts', 'apps/web/src/board-port/approved-xpanel-pages.ts', 'apps/web/src/surfaces/xpanel.ts', 'apps/web/src/ws-client.ts', 'apps/web/src/login-client.ts', 'apps/web/src/password-generate-client.ts', 'apps/web/src/board-port/extensions/shared.ts', 'tests/browser/visual-fixture.mjs', 'tests/browser/completion-database-workspace.mjs']
const snapshot = () => sourcePaths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
const clone = value => JSON.parse(JSON.stringify(value))
const accountId = 'visual-account', username = 'preview', api = '/api/databases'
const rootSelector = '[data-database-workspace]'
const form = (page, user = false) => page.locator(user ? '[data-dbu-create]' : '[data-db-create]')
const field = (page, name, user = false) => form(page, user).locator('[name="' + name + '"]')
const action = (page, name) => page.locator(rootSelector + ' [data-db-' + name + ']')
const mutationCount = model => model.calls.filter(call => call.method === 'POST').length
const uuid = number => '00000000-0000-4000-8000-' + String(number).padStart(12, '0')
const canonicalPrivileges = values => values.includes('ALL PRIVILEGES') ? ['ALL PRIVILEGES'] : [...new Set(values)].sort()
const grantForm = page => page.locator('[data-db-grant-form]')
const grantField = (page, name) => grantForm(page).locator('[name="' + name + '"]')
const grantSaves = model => model.calls.filter(call => call.method === 'POST' && call.path.endsWith('/grants'))
const lifecycleSaves = model => model.calls.filter(call => call.method === 'POST' && /\/(trash|restore)$/.test(call.path))
const lifecycleAction = (page, kind, id) => page.locator('[data-db-' + kind + '-action="' + id + '"]')

class MockDatabases {
  constructor() {
    this.databases = [{ id: uuid(1), accountId, engine: 'mariadb', name: 'preview_existing', trashedAt: null }, { id: uuid(2), accountId, engine: 'mariadb', name: 'preview_retired', trashedAt: '2026-01-01T00:00:00.000Z' }]
    this.users = [{ id: uuid(3), name: 'preview_existing', grants: [{ databaseId: uuid(1), privileges: ['SELECT'] }] }]
    this.nextId = 10; this.calls = []; this.errors = []; this.gates = []; this.mode = null; this.hideNext = null; this.grantRace = null; this.lifecycleRace = null
  }
  hold(path) {
    let entered, release
    const gate = { path, started: false, enteredPromise: new Promise(resolve => { entered = resolve }), promise: new Promise(resolve => { release = resolve }), entered: () => entered(), release: () => release() }
    this.gates.push(gate); return gate
  }
  async route(route) {
    const request = route.request(), url = new URL(request.url()), method = request.method(), user = url.pathname === api + '/users'
    const grant = /^\/api\/databases\/users\/([0-9a-f-]{36})\/grants$/.exec(url.pathname)
    const lifecycle = /^\/api\/databases\/([0-9a-f-]{36})\/(trash|restore)$/.exec(url.pathname)
    assert.ok(url.pathname === api || user || grant || lifecycle); assert.ok(['GET', 'POST'].includes(method)); if (grant || lifecycle) assert.equal(method, 'POST')
    assert.equal(url.search, method === 'GET' && !user ? '?includeTrashed=true' : '')
    const body = method === 'POST' ? request.postDataJSON() : undefined
    // Passwords are intentionally absent even from synthetic execution receipts.
    this.calls.push({ method, path: url.pathname, search: url.search, ...(body ? { body: { ...clone(body), ...(Object.hasOwn(body, 'password') ? { password: '[redacted synthetic input]' } : {}) } } : {}) })
    const captured = clone(user ? this.users : this.databases)
    const gate = this.gates.find(item => item.path === url.pathname && !item.started)
    if (gate) { gate.started = true; gate.entered(); await gate.promise }
    let status = 200, result
    if (method === 'GET') {
      let rows = captured
      if (this.hideNext && this.hideNext.user === user) { rows = rows.filter(row => row.id !== this.hideNext.id); this.hideNext = null }
      result = { context: { accountId }, [user ? 'users' : 'databases']: rows }
      if (this.mode === 'foreign-context') result.context.accountId = 'foreign-account'
      if (this.mode === 'foreign-row' && !user) result.databases[0].accountId = 'foreign-account'
      if (this.mode === 'foreign-name' && user) result.users[0].name = 'foreign_existing'
    } else {
      assert.equal(Object.hasOwn(body, 'accountId'), false); assert.equal(Object.hasOwn(body, 'expectedRevision'), false, 'No global workspace revision is part of this wire')
      if (lifecycle) {
        assert.deepEqual(Object.keys(body).sort(), ['confirmation', 'expectedTrashedAt'])
        const target = this.databases.find(row => row.id === lifecycle[1]); assert.ok(target)
        assert.equal(typeof body.confirmation, 'string'); assert.ok(body.expectedTrashedAt === null || new Date(body.expectedTrashedAt).toISOString() === body.expectedTrashedAt)
        if (this.lifecycleRace) { assert.equal(this.lifecycleRace.id, target.id); target.trashedAt = this.lifecycleRace.trashedAt; this.lifecycleRace = null }
        if (body.confirmation !== target.name || body.expectedTrashedAt !== target.trashedAt) { status = 409; result = { code: 'synthetic_database_lifecycle_conflict', details: { stateChanged: false } } }
        else {
          assert.equal(target.trashedAt === null, lifecycle[2] === 'trash')
          target.trashedAt = lifecycle[2] === 'trash' ? '2026-10-26T12:00:00.000Z' : null
          result = { database: clone(target), context: { accountId }, application: { status: 'not_requested', targetVerified: false }, stateChanged: true, reconcile: { status: 'not_requested' } }
          if (this.mode === 'unknown-lifecycle') { status = 503; result = { code: 'synthetic_database_lifecycle_unknown', details: { stateChanged: true, unknownOutcome: true, verificationRequired: true } } }
          if (this.mode === 'wrong-lifecycle-ack') result.database = clone(this.databases.find(row => row.id !== target.id))
        }
      }
      else if (grant) {
        assert.deepEqual(Object.keys(body).sort(), ['databaseId', 'expectedPrivileges', 'privileges'])
        const selectedUser = this.users.find(row => row.id === grant[1]), selectedDatabase = this.databases.find(row => row.id === body.databaseId)
        assert.ok(selectedUser && selectedDatabase && selectedDatabase.trashedAt === null)
        assert.ok(Array.isArray(body.privileges) && body.privileges.length)
        assert.ok(body.privileges.every(value => ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL PRIVILEGES'].includes(value)))
        assert.ok(body.expectedPrivileges === null || Array.isArray(body.expectedPrivileges) && body.expectedPrivileges.length > 0)
        if (this.grantRace) {
          assert.equal(this.grantRace.userId, selectedUser.id); assert.equal(this.grantRace.databaseId, selectedDatabase.id)
          const existing = selectedUser.grants.find(item => item.databaseId === selectedDatabase.id)
          assert.ok(existing); existing.privileges = canonicalPrivileges(this.grantRace.privileges); this.grantRace = null
        }
        const existing = selectedUser.grants.find(item => item.databaseId === selectedDatabase.id), current = existing ? canonicalPrivileges(existing.privileges) : null
        const expected = body.expectedPrivileges === null ? null : canonicalPrivileges(body.expectedPrivileges), requested = canonicalPrivileges(body.privileges)
        if (JSON.stringify(expected) !== JSON.stringify(current)) { status = 409; result = { code: 'synthetic_grant_conflict', details: { stateChanged: false } } }
        else {
          const stateChanged = JSON.stringify(current) !== JSON.stringify(requested)
          if (existing) existing.privileges = requested
          else selectedUser.grants.push({ databaseId: selectedDatabase.id, privileges: requested })
          result = { context: { accountId }, user: clone(selectedUser), application: { status: 'not_requested', targetVerified: false }, stateChanged }
          if (this.mode === 'unknown-grant') { status = 503; result = { code: 'synthetic_grant_unknown', details: { stateChanged: true, unknownOutcome: true, verificationRequired: true } } }
          if (this.mode === 'wrong-grant-user') result.user = clone(this.users.find(row => row.id !== selectedUser.id))
        }
      }
      else if (this.mode === 'explicit-refusal') { status = 422; result = { code: 'synthetic_refusal', details: { stateChanged: false } } }
      else {
        let record
        if (user) {
          assert.ok(Object.keys(body).every(key => ['name', 'password', 'databaseId', 'privileges'].includes(key)))
          assert.equal(typeof body.name, 'string'); assert.equal(typeof body.password, 'string'); assert.ok(body.password.length >= 8)
          const name = body.name.trim().toLowerCase(), canonical = name.startsWith(username + '_') ? name : username + '_' + name
          assert.match(canonical, /^preview_[a-z0-9_]+$/)
          const grants = []
          if (body.databaseId) {
            const database = this.databases.find(row => row.id === body.databaseId)
            assert.ok(database && !database.trashedAt); assert.ok(Array.isArray(body.privileges) && body.privileges.length)
            assert.ok(body.privileges.every(value => ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL PRIVILEGES'].includes(value)))
            grants.push({ databaseId: database.id, privileges: [...new Set(body.privileges)].sort() })
          } else assert.equal(Object.hasOwn(body, 'privileges'), false)
          record = { id: uuid(this.nextId++), name: canonical, grants }; this.users.push(record)
        } else {
          assert.deepEqual(Object.keys(body), ['name']); assert.match(body.name, /^preview_[a-z0-9_]+$/)
          assert.ok(!this.databases.some(row => row.name === body.name))
          record = { id: uuid(this.nextId++), accountId, engine: 'mariadb', name: body.name, trashedAt: null }; this.databases.push(record)
        }
        result = { [user ? 'user' : 'database']: clone(record), application: { status: 'not_requested', targetVerified: false } }; status = 201
        if (this.mode === 'unknown-write') { status = 503; result = { code: 'synthetic_unknown', details: { stateChanged: true, verificationRequired: true, unknownOutcome: true } } }
        if (this.mode === 'unknown-403') { status = 403; result = { code: 'synthetic_post_dispatch_refusal', details: {} } }
        if (this.mode === 'foreign-ack') { if (user) result.user.name = 'foreign_wrong'; else result.database.accountId = 'foreign-account' }
        if (this.mode === 'missing-readback') this.hideNext = { user, id: record.id }
        if (this.mode === 'false-native-proof') result.application.targetVerified = true
      }
    }
    if (status >= 400) result = { type: 'about:blank', title: 'Synthetic database request refused', status, detail: 'Synthetic request failure', ...result }
    await route.fulfill({ status, json: result })
  }
}

async function mockSession(page, model) {
  await page.addInitScript(() => {
    const transport = async (method, path, body) => {
      const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const value = await response.json()
      if (!response.ok) { const problem = value.error || value; throw Object.assign(new Error(problem.detail || problem.message || 'mock_database_error'), { status: response.status, code: problem.code, details: problem.details || {} }) }
      return value
    }
    Object.defineProperty(window, 'xpanelSessionRequest', { get: () => transport, set: () => {}, configurable: false })
  })
  await page.route('**/api/databases**', async route => {
    try { await model.route(route) }
    catch (error) { model.errors.push(String(error)); await route.fulfill({ status: 500, json: { status: 500, code: 'mock_contract_failure', details: { unknownOutcome: true, verificationRequired: true } } }) }
  })
}
async function state(page, wanted) {
  await page.waitForFunction(({ selector, wanted }) => {
    const root = document.querySelector(selector), status = root?.querySelector('[data-db-status]')
    return status?.getAttribute('data-state') === wanted && root.getAttribute('aria-busy') !== 'true'
  }, { selector: rootSelector, wanted })
}
async function settle(page) { await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-busy') !== 'true', rootSelector) }
async function entered(gate) {
  let timer
  try { await Promise.race([gate.enteredPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected held database request did not start')), 10000) })]) }
  finally { clearTimeout(timer) }
}
async function reload(page) {
  await action(page, 'reload').click()
  const confirm = page.locator('[data-xp-prompt-confirm]')
  if (await confirm.isVisible()) await confirm.click()
  await state(page, 'read')
}
async function confirmLifecycle(page, kind, id, name, accept = true) {
  await lifecycleAction(page, kind, id).click()
  const confirm = page.locator('[data-xp-prompt-confirm]'); await confirm.waitFor({ state: 'visible' })
  assert.ok((await page.locator('[data-xp-prompt-body]').textContent()).includes(name), 'Named confirmation identifies the captured database')
  await page.locator(accept ? '[data-xp-prompt-confirm]' : '[data-xp-prompt-cancel]').click()
  await settle(page)
}
async function selectGrant(page, userId, databaseId) {
  await grantField(page, 'userId').selectOption(userId)
  await grantField(page, 'databaseId').selectOption(databaseId)
}
async function editGrant(page, privileges) {
  const advanced = grantForm(page).locator('[data-db-grant-advanced]')
  if (!await advanced.isVisible()) await grantForm(page).locator('[data-db-grant-advanced-toggle]').click()
  for (const control of await grantField(page, 'privileges').all()) await control.uncheck()
  for (const privilege of privileges) await grantForm(page).locator('[name=privileges][value="' + privilege + '"]').check()
}
const currentGrant = (model, userId, databaseId) => model.users.find(user => user.id === userId)?.grants.find(grant => grant.databaseId === databaseId)?.privileges ?? null
async function geometry(page) {
  return page.locator(rootSelector).evaluate(root => {
    const visible = node => !!node.getClientRects().length && !node.closest('[hidden]') && getComputedStyle(node).visibility !== 'hidden'
    const rect = node => { const value = node.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom } }
    const fields = [...root.querySelectorAll('input:not([type=checkbox]):not([type=radio]),select')].filter(visible).map(control => {
      const label = control.closest('label') || [...root.querySelectorAll('label[for]')].find(label => label.htmlFor === control.id)
      const box = rect(control), style = getComputedStyle(control)
      let gap = null, alignment = null
      if (label) {
        const range = document.createRange(); range.selectNodeContents(label); const textBox = range.getBoundingClientRect(); gap = box.y - textBox.bottom
        const rtl = getComputedStyle(root).direction === 'rtl', valueAnchor = rtl ? box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight) : box.x + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
        alignment = Math.abs(valueAnchor - (rtl ? textBox.right : textBox.x))
      }
      return { name: control.name || control.id, box, label: label?.textContent.replace(/\s+/g, ' ').trim(), gap, alignment, textAlign: style.textAlign, direction: style.direction }
    })
    const controls = [...root.querySelectorAll('button,summary,input,select')].filter(visible).map(node => ({ type: node.type || node.tagName, box: rect(node), label: node.getAttribute('aria-label') || (node.tagName === 'BUTTON' ? node.textContent : '') }))
    const technical = [...root.querySelectorAll('tbody bdi')].filter(visible).map(node => { const range = document.createRange(); range.selectNodeContents(node); const style = getComputedStyle(node); return { text: node.textContent, lines: new Set([...range.getClientRects()].map(value => Math.round(value.top))).size, direction: style.direction, isolation: style.unicodeBidi } })
    const tables = [...root.querySelectorAll('table')].map(table => { const wrap = table.closest('[role=region]'); return { columns: table.querySelectorAll('thead th').length, width: rect(table).width, wrap: wrap ? { box: rect(wrap), tabIndex: wrap.tabIndex, label: wrap.getAttribute('aria-label') || wrap.getAttribute('aria-labelledby') } : null } })
    const choices = [...root.querySelectorAll('input[type=checkbox],input[type=radio]')].filter(visible).map(control => { const label = control.closest('label'); return { label: label ? rect(label) : null, control: rect(control) } })
    const cards = [...root.querySelectorAll('.xp-extension__card')].filter(visible).map(card => { const style = getComputedStyle(card); return { top: parseFloat(style.paddingTop), right: parseFloat(style.paddingRight), bottom: parseFloat(style.paddingBottom), left: parseFloat(style.paddingLeft) } })
    const groups = [...root.querySelectorAll('.xp-db-form')].filter(visible).map(node => parseFloat(getComputedStyle(node).rowGap))
    const siblings = [...root.querySelectorAll('.xp-db-fields')].filter(visible).map(node => ({ row: parseFloat(getComputedStyle(node).rowGap), column: parseFloat(getComputedStyle(node).columnGap) }))
    return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, direction: getComputedStyle(root).direction, sectionGap: parseFloat(getComputedStyle(root).rowGap), fields, controls, technical, tables, choices, cards, groups, siblings }
  })
}
function assertGeometry(value, lang, width) {
  assert.equal(value.direction, lang === 'ar' ? 'rtl' : 'ltr'); assert.ok(value.pageWidth <= width + 1, 'Affected page must contain overflow')
  assert.ok(value.fields.length >= 4, 'Actual expanded database and initial-grant controls measured')
  for (const field of value.fields) { assert.ok(field.box.height >= 43.5, 'Field target: ' + field.name); assert.ok(field.label, 'Associated field label: ' + field.name); if (field.gap !== null) assert.ok(Math.abs(field.gap - 8) <= 1, 'Label/control gap: ' + field.name); if (field.alignment !== null) assert.ok(field.alignment <= 1, 'Field value anchor: ' + field.name) }
  for (const control of value.controls) if (!['checkbox', 'radio'].includes(control.type)) assert.ok(control.box.width >= 43.5 && control.box.height >= 43.5, 'Visible control target: ' + control.label)
  assert.equal(value.tables.length, 3, 'Rich database, user and trash tables retained')
  for (const table of value.tables) { assert.ok(table.columns >= 3); assert.ok(table.wrap?.tabIndex >= 0 && table.wrap.label, 'Labelled keyboard-reachable table overflow'); assert.ok(table.wrap.box.width <= width + 1) }
  assert.ok(value.technical.length > 0, 'Actual technical table values measured')
  for (const token of value.technical) { assert.equal(token.direction, 'ltr'); assert.ok(token.isolation.includes('isolate')); assert.ok(token.lines <= 1, 'Intact technical value: ' + token.text) }
  assert.ok(value.choices.length >= 5, 'Expanded initial-grant choices measured'); for (const choice of value.choices) assert.ok(choice.label && choice.label.width >= 43.5 && choice.label.height >= 43.5, 'Actual associated choice target')
  assert.ok(value.cards.length > 0); for (const card of value.cards) for (const padding of Object.values(card)) assert.ok(Math.abs(padding - (width < 600 ? 16 : 24)) <= 1, 'Affected card content padding')
  for (const gap of value.groups) assert.ok(Math.abs(gap - 24) <= 1, 'Actual form group gap')
  for (const gap of value.siblings) { assert.ok(Math.abs(gap.row - 16) <= 1); assert.ok(Math.abs(gap.column - 16) <= 1) }
  assert.ok(Math.abs(value.sectionGap - 32) <= 1, 'Workspace section hierarchy')
}

mkdirSync(output, { recursive: true })
const before = snapshot(), started = performance.now()
const cases = [], runtime = { node: process.version }
let checkpoint = 'startup', activePage, activeModel, activeContext, activeGeometry, geometryCheckpoint, activeCapture, fixture, browser
try {
  browser = await chromium.launch({ headless: true }); runtime.chromium = browser.version()
  fixture = await createVisualFixture({ qualifiedCatalog: true })
  for (const lang of ['en', 'ar']) for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' }), page = await context.newPage(), model = new MockDatabases(), pageErrors = []
    activePage = page; activeModel = model; activeContext = { lang, width }; activeGeometry = null; geometryCheckpoint = null; activeCapture = null; page.setDefaultTimeout(10000); page.on('pageerror', error => pageErrors.push(error.name + ': ' + error.message))
    await mockSession(page, model); checkpoint = lang + '-' + width + ':read'
    await page.goto(fixture.baseUrl + '/databases/mariadb?lang=' + lang + '&theme=light', { waitUntil: 'load' }); await state(page, 'read')
    assert.equal(await page.locator(rootSelector).getAttribute('data-db-account'), accountId)
    assert.equal(await page.locator('[data-db-rows] tr').count(), 1); assert.equal(await page.locator('[data-dbu-rows] tr').count(), 1); assert.equal(await page.locator('[data-db-trash-rows] tr').count(), 1)
    checkpoint = lang + '-' + width + ':create-database'
    await field(page, 'name').fill('shop'); await form(page).locator('button[type=submit]').click(); await state(page, 'saved')
    const created = model.databases.find(row => row.name === 'preview_shop'); assert.ok(created)
    assert.equal(model.calls.filter(call => call.method === 'POST')[0].body.name, 'preview_shop')
    checkpoint = lang + '-' + width + ':initial-grant-expanded'
    await field(page, 'name', true).fill('Reader'); assert.equal(await field(page, 'password', true).getAttribute('type'), 'password'); await field(page, 'password', true).fill('Synthetic-browser-only-42!')
    await field(page, 'databaseId', true).selectOption(created.id)
    const privileges = form(page, true).locator('[name=privileges]'); for (const control of await privileges.all()) await control.uncheck(); await form(page, true).locator('[name=privileges][value=SELECT]').check(); await form(page, true).locator('[name=privileges][value=INSERT]').check()
    const measured = await geometry(page); activeGeometry = measured; geometryCheckpoint = checkpoint
    writeFileSync(output + '/' + lang + '-' + width + '-geometry.json', JSON.stringify({ lang, width, checkpoint, geometry: measured }, null, 2))
    const capturePath = output + '/' + lang + '-' + width + '-initial-grant.png'
    await page.screenshot({ path: capturePath, fullPage: true }); activeCapture = capturePath
    assertGeometry(measured, lang, width)
    await form(page, true).locator('button[type=submit]').click(); await state(page, 'saved')
    const createdUser = model.users.find(row => row.name === 'preview_reader'); assert.ok(createdUser); assert.deepEqual(createdUser.grants, [{ databaseId: created.id, privileges: ['INSERT', 'SELECT'] }])
    assert.equal(await field(page, 'password', true).inputValue(), '', 'Password cleared after dispatch')
    assert.ok((await page.locator('[data-dbu-rows]').textContent()).includes(createdUser.name))
    assert.equal(mutationCount(model), 2, 'Create and initial grant use exactly two existing mutations')
    checkpoint = lang + '-' + width + ':grant-add'
    const neighborBefore = clone(model.users.find(user => user.id === uuid(3)))
    await selectGrant(page, createdUser.id, uuid(1)); await editGrant(page, ['SELECT'])
    await grantForm(page).locator('[data-db-grant-save]').click(); await state(page, 'saved')
    const added = grantSaves(model).at(-1)
    assert.equal(added.path, api + '/users/' + createdUser.id + '/grants')
    assert.deepEqual(added.body, { databaseId: uuid(1), privileges: ['SELECT'], expectedPrivileges: null })
    assert.deepEqual(currentGrant(model, createdUser.id, uuid(1)), ['SELECT'])
    assert.deepEqual(currentGrant(model, createdUser.id, created.id), ['INSERT', 'SELECT'], 'ADD preserves the separate initial grant')
    checkpoint = lang + '-' + width + ':grant-edit-expanded'
    await selectGrant(page, createdUser.id, created.id); await editGrant(page, ['SELECT', 'UPDATE'])
    const grantMeasured = await geometry(page); activeGeometry = grantMeasured; geometryCheckpoint = checkpoint
    writeFileSync(output + '/' + lang + '-' + width + '-grant-geometry.json', JSON.stringify({ lang, width, checkpoint, geometry: grantMeasured }, null, 2))
    const grantCapture = output + '/' + lang + '-' + width + '-grant-edit.png'
    await page.screenshot({ path: grantCapture, fullPage: true }); activeCapture = grantCapture
    assertGeometry(grantMeasured, lang, width)
    await grantForm(page).locator('[data-db-grant-save]').click(); await state(page, 'saved')
    const edited = grantSaves(model).at(-1)
    assert.equal(edited.path, api + '/users/' + createdUser.id + '/grants')
    assert.deepEqual(edited.body, { databaseId: created.id, privileges: ['SELECT', 'UPDATE'], expectedPrivileges: ['INSERT', 'SELECT'] })
    assert.deepEqual(currentGrant(model, createdUser.id, created.id), ['SELECT', 'UPDATE'])
    assert.deepEqual(currentGrant(model, createdUser.id, uuid(1)), ['SELECT'], 'EDIT preserves a sibling grant')
    assert.deepEqual(model.users.find(user => user.id === uuid(3)), neighborBefore, 'Other users remain unchanged')
    checkpoint = lang + '-' + width + ':trash-confirmed'
    const usersBeforeLifecycle = clone(model.users), countBeforeLifecycle = lifecycleSaves(model).length
    if (lang === 'en' && width === 1440) {
      await confirmLifecycle(page, 'trash', created.id, created.name, false)
      assert.equal(lifecycleSaves(model).length, countBeforeLifecycle, 'Cancel sends no lifecycle mutation')
      assert.equal(model.databases.find(row => row.id === created.id).trashedAt, null)
    }
    await confirmLifecycle(page, 'trash', created.id, created.name); await state(page, 'saved')
    const trashed = clone(model.databases.find(row => row.id === created.id))
    assert.equal(trashed.trashedAt, '2026-10-26T12:00:00.000Z')
    assert.deepEqual(lifecycleSaves(model).at(-1).body, { expectedTrashedAt: null, confirmation: created.name })
    assert.equal(await lifecycleAction(page, 'trash', created.id).count(), 0)
    assert.equal(await lifecycleAction(page, 'restore', created.id).count(), 1)
    assert.equal(await field(page, 'databaseId', true).locator('option[value="' + created.id + '"]').count(), 0, 'Trashed databases cannot receive an initial grant')
    assert.deepEqual(model.users, usersBeforeLifecycle, 'Soft trash preserves all saved users and grants')
    const lifecycleMeasured = await geometry(page); activeGeometry = lifecycleMeasured; geometryCheckpoint = checkpoint
    writeFileSync(output + '/' + lang + '-' + width + '-trash-geometry.json', JSON.stringify({ lang, width, checkpoint, geometry: lifecycleMeasured }, null, 2))
    const lifecycleCapture = output + '/' + lang + '-' + width + '-trash.png'
    await page.screenshot({ path: lifecycleCapture, fullPage: true }); activeCapture = lifecycleCapture
    assertGeometry(lifecycleMeasured, lang, width)
    checkpoint = lang + '-' + width + ':restore-confirmed'
    await confirmLifecycle(page, 'restore', created.id, created.name); await state(page, 'saved')
    assert.deepEqual(lifecycleSaves(model).at(-1).body, { expectedTrashedAt: trashed.trashedAt, confirmation: created.name })
    assert.equal(model.databases.find(row => row.id === created.id).trashedAt, null)
    assert.equal(await lifecycleAction(page, 'trash', created.id).count(), 1)
    assert.equal(await lifecycleAction(page, 'restore', created.id).count(), 0)
    assert.deepEqual(model.users, usersBeforeLifecycle, 'Restore preserves existing grants and other users')
    if (lang === 'en' && width === 1440) {
      checkpoint = 'lifecycle-CAS-conflict'
      await field(page, 'name').fill('preserved_lifecycle_draft')
      model.lifecycleRace = { id: created.id, trashedAt: '2026-10-26T11:00:00.000Z' }
      await confirmLifecycle(page, 'trash', created.id, created.name); await state(page, 'stale')
      const lifecycleConflicts = lifecycleSaves(model).length
      assert.equal(await field(page, 'name').inputValue(), 'preserved_lifecycle_draft')
      await action(page, 'refresh').click(); await state(page, 'stale')
      assert.equal(await field(page, 'name').inputValue(), 'preserved_lifecycle_draft')
      assert.equal(await form(page).locator('button[type=submit]').isDisabled(), true, 'Lifecycle conflict requires explicit review before any write')
      assert.equal(await lifecycleAction(page, 'restore', created.id).isDisabled(), true)
      assert.equal(lifecycleSaves(model).length, lifecycleConflicts)
      await reload(page); assert.equal(await field(page, 'name').inputValue(), '')
      await confirmLifecycle(page, 'restore', created.id, created.name); await state(page, 'saved')
      assert.equal(lifecycleSaves(model).at(-1).body.expectedTrashedAt, '2026-10-26T11:00:00.000Z', 'Explicit review captures the current timestamp')
      for (const mode of ['unknown-lifecycle', 'wrong-lifecycle-ack']) {
        checkpoint = mode; model.mode = mode
        await confirmLifecycle(page, 'trash', created.id, created.name); await state(page, 'uncertain')
        const lifecycleCount = lifecycleSaves(model).length; model.mode = null
        await action(page, 'refresh').click(); await state(page, 'uncertain')
        assert.equal(lifecycleSaves(model).length, lifecycleCount, 'Unknown or wrong-target acknowledgement never retries')
        assert.equal(await lifecycleAction(page, 'restore', created.id).isDisabled(), true)
        assert.deepEqual(model.users, usersBeforeLifecycle)
        await reload(page)
        await confirmLifecycle(page, 'restore', created.id, created.name); await state(page, 'saved')
      }
      checkpoint = 'grant-dispatch-CAS-conflict'
      await selectGrant(page, createdUser.id, created.id); await editGrant(page, ['DELETE'])
      model.grantRace = { userId: createdUser.id, databaseId: created.id, privileges: ['INSERT'] }
      await grantForm(page).locator('[data-db-grant-save]').click(); await state(page, 'stale')
      assert.equal(await grantForm(page).locator('[name=privileges][value=DELETE]').isChecked(), true)
      assert.deepEqual(currentGrant(model, createdUser.id, created.id), ['INSERT'], 'CAS refusal preserves the concurrent writer')
      const conflicted = grantSaves(model).length
      await action(page, 'refresh').click(); await state(page, 'stale')
      assert.equal(await grantForm(page).locator('[name=privileges][value=DELETE]').isChecked(), true)
      assert.equal(await grantForm(page).locator('[data-db-grant-save]').isDisabled(), true, 'Refresh never upgrades the expected baseline')
      assert.equal(grantSaves(model).length, conflicted)
      await reload(page); assert.equal(await grantField(page, 'userId').inputValue(), ''); assert.equal(await grantField(page, 'databaseId').inputValue(), '')
      await selectGrant(page, createdUser.id, created.id); await editGrant(page, ['SELECT'])
      await grantForm(page).locator('[data-db-grant-save]').click(); await state(page, 'saved')
      assert.deepEqual(grantSaves(model).at(-1).body.expectedPrivileges, ['INSERT'], 'Explicit reload/reselection binds the observed current value')
      for (const mode of ['unknown-grant', 'wrong-grant-user']) {
        checkpoint = mode; await selectGrant(page, createdUser.id, uuid(1)); await editGrant(page, mode === 'unknown-grant' ? ['SELECT', 'UPDATE'] : ['DELETE']); model.mode = mode
        await grantForm(page).locator('[data-db-grant-save]').click(); await state(page, 'uncertain')
        assert.equal(await grantField(page, 'userId').inputValue(), createdUser.id); assert.equal(await grantField(page, 'databaseId').inputValue(), uuid(1)); assert.equal(await grantForm(page).locator('[data-db-grant-save]').isDisabled(), true)
        const count = grantSaves(model).length; model.mode = null; await action(page, 'refresh').click(); await state(page, 'uncertain'); assert.equal(grantSaves(model).length, count, 'Uncertain grant review never retries or rebinds the target')
        assert.deepEqual(model.users.find(user => user.id === uuid(3)), neighborBefore)
        await reload(page)
      }
      checkpoint = 'pending-refresh-draft'
      const refresh = model.hold(api); await action(page, 'refresh').click(); await entered(refresh)
      await field(page, 'name').fill('typed_during_read'); refresh.release(); await state(page, 'read'); assert.equal(await field(page, 'name').inputValue(), 'typed_during_read'); await reload(page)
      checkpoint = 'raw-invalid-database-name'
      const rawCount = mutationCount(model); await field(page, 'name').fill(' invalid'); await form(page).locator('button[type=submit]').click(); await state(page, 'failed'); assert.equal(mutationCount(model), rawCount); assert.equal(await field(page, 'name').inputValue(), ' invalid'); await reload(page)
      checkpoint = 'known-refusal'; model.mode = 'explicit-refusal'; await field(page, 'name').fill('refused'); await form(page).locator('button[type=submit]').click(); await state(page, 'failed'); assert.equal(await field(page, 'name').inputValue(), 'refused'); assert.equal(model.databases.some(row => row.name === 'preview_refused'), false); model.mode = null; await reload(page)
      for (const mode of ['unknown-write', 'unknown-403', 'foreign-ack', 'missing-readback', 'false-native-proof']) {
        checkpoint = mode; model.mode = mode; const suffix = mode.replaceAll('-', '_'); await field(page, 'name').fill(suffix); await form(page).locator('button[type=submit]').click(); await state(page, 'uncertain')
        assert.equal(await form(page).locator('button[type=submit]').isDisabled(), true); const count = mutationCount(model); model.mode = null; await action(page, 'refresh').click(); await settle(page); await state(page, 'uncertain'); assert.equal(mutationCount(model), count, 'Review never retries an uncertain creation'); await reload(page)
      }
      checkpoint = 'unknown-user-password-disposal'; model.mode = 'unknown-write'
      await field(page, 'name', true).fill('unknown_user'); await field(page, 'password', true).fill('Synthetic-browser-only-42!'); await field(page, 'databaseId', true).selectOption(created.id)
      await form(page, true).locator('button[type=submit]').click(); await state(page, 'uncertain')
      assert.equal(await field(page, 'password', true).inputValue(), ''); assert.equal(await field(page, 'name', true).inputValue(), 'unknown_user'); assert.equal(await form(page, true).locator('button[type=submit]').isDisabled(), true)
      model.mode = null; await reload(page)
      for (const mode of ['foreign-context', 'foreign-row', 'foreign-name']) { checkpoint = mode; model.mode = mode; const count = mutationCount(model); await action(page, 'refresh').click(); await state(page, 'failed'); assert.equal(mutationCount(model), count); model.mode = null; await action(page, 'refresh').click(); await state(page, 'read') }
      checkpoint = 'dispatch-time-qualification'
      await field(page, 'name').fill('qualification_draft'); const gate = model.hold(api), count = mutationCount(model)
      await form(page).locator('button[type=submit]').click(); await entered(gate)
      await page.locator(rootSelector).evaluate(root => root.setAttribute('data-capability-unavailable', 'true')); gate.release(); await state(page, 'failed')
      assert.equal(mutationCount(model), count); assert.equal(await field(page, 'name').inputValue(), 'qualification_draft'); assert.equal(await form(page).locator('button[type=submit]').isDisabled(), true)
    }
    assert.deepEqual(model.errors, []); assert.deepEqual(pageErrors, [])
    cases.push({ lang, width, status: 'passed', geometry: measured, grantGeometry: grantMeasured, lifecycleGeometry: lifecycleMeasured, calls: model.calls, pageErrors, checks: ['trusted account pin and full lists', 'prefixed database create/readback', 'new user with selected initial grant', 'password removed after dispatch and redacted from evidence', 'visible expanded field/technical/table geometry', 'grant ADD with explicit absent baseline', 'grant EDIT with exact current-value baseline and sibling preservation', 'expanded grant editor geometry in the same context', 'named soft trash and restore with exact state readback', 'trash preserves users and grants and excludes initial-grant targets', 'trash state geometry in the same locale and viewport', ...(lang === 'en' && width === 1440 ? ['cancelled named lifecycle confirmation sends zero POST', 'lifecycle CAS409 preserves draft and Refresh lock until explicit reload', 'unknown or wrong-target lifecycle acknowledgement never retries', 'POST-time grant CAS409 preserves draft through refresh', 'explicit reload/reselection admits a new grant baseline', 'unknown or wrong-user acknowledgement locks without retry', 'late refresh preserves draft', 'raw invalid input and known refusal preserve draft', 'unknown outcome locks and explicit review without retry', 'strict malformed/foreign acknowledgement and list rejection', 'dispatch-time qualification suppression'] : [])] })
    await context.close()
  }
} catch (error) {
  const hasPage = activePage && !activePage.isClosed()
  const diagnostic = hasPage ? await activePage.evaluate(selector => {
    const root = document.querySelector(selector)
    return { url: location.href, title: document.title, viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth, expectedSelector: selector, rootCount: document.querySelectorAll(selector).length, root: root ? { status: root.querySelector('[data-db-status]')?.textContent, state: root.querySelector('[data-db-status]')?.getAttribute('data-state'), busy: root.getAttribute('aria-busy') } : null }
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
  writeFileSync(output + '/results.json', JSON.stringify({ at: new Date().toISOString(), durationMs: Math.round(performance.now() - started), runtime, scope: 'Actual affected renderer/controller with explicit mock session/HTTP. No authenticated tenant, native MariaDB connection, SQL grant, crash recovery, credential provisioning or full reference/font-parity proof. Grant ADD/EDIT compares expectedPrivileges current values; soft Trash/Restore compares captured expectedTrashedAt and the named record. Database/user creation has no workspace CAS; permanent purge and native database effects are not exercised.', sourceUnchanged, before, after, cases }, null, 2))
  console.log(JSON.stringify({ status: process.exitCode ? 'failed' : 'passed', cases: cases.length, output }))
}
