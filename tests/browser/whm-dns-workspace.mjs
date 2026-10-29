// Real Chromium over rendered pages, with explicit synthetic session/DNS HTTP transport.
// Fixture identifiers alone are normalized to UUIDs. No native DNS, auth or propagation proof.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createVisualFixture } from './visual-fixture.mjs'

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.tools/playwright-browsers')
const { chromium } = await import('@playwright/test')
const output = resolve(process.env.XPANEL_DNS_OUTPUT || 'test-results/whm-dns-workspace')
mkdirSync(output, { recursive: true })
const paths = ['apps/web/src/whm-dns-client.ts', 'apps/web/src/board-port/whm-dns-workspace.ts', 'apps/web/src/zone-editor-client.ts', 'apps/web/src/surfaces/xwhm.ts', 'apps/web/src/ws-client.ts', 'apps/web/src/tokens.ts', 'apps/web/src/shell.ts', 'apps/web/src/board-port/approved-xwhm.ts', 'apps/web/src/board-port/approved-xpanel-bindings.ts', 'apps/api/src/dns-workspace.ts', 'apps/api/src/server.ts', 'packages/state/src/store.ts', 'packages/state/src/types.ts', 'tests/browser/visual-fixture.mjs', 'tests/browser/whm-dns-workspace.mjs']
const snapshot = () => paths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const zoneId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const recordId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const initial = { id: zoneId, accountId, name: 'preview.example.test', serial: 2026102601, records: [{ id: recordId, name: '@', type: 'A', ttl: 0, content: '192.0.2.42', priority: null }] }
const revision = zone => createHash('sha256').update(JSON.stringify(zone)).digest('hex')
const before = snapshot(), results = []
const fixture = await createVisualFixture()
const browser = await chromium.launch({ headless: true })
const close = async () => { await browser.close(); await fixture.close() }
const near = (value, expected, label) => assert.ok(Math.abs(value - expected) < 1.1, label + ': ' + value + ' expected ' + expected)

async function geometry(page, mobile, ar) {
  const result = await page.locator('.xp-whm-dns').evaluate(root => {
    const rect = element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height } }
    const fields = [...root.querySelectorAll('.xp-whm-dns__fields>.xp-field')].map(field => {
      const label = field.querySelector('label'), control = field.querySelector('input,select')
      return { field: rect(field), label: rect(label), control: rect(control), direction: getComputedStyle(control).direction }
    })
    const groups = [...root.children].filter(element => element.tagName !== 'STYLE' && element.getBoundingClientRect().height > 0).map(rect)
    const rows = [...root.querySelectorAll('[data-dns-records] tr')].map(row => ({ box: rect(row), cells: [...row.querySelectorAll('td')].filter(cell => cell.querySelector('label')).map(cell => ({ box: rect(cell), label: rect(cell.querySelector('label')), control: rect(cell.querySelector('input,select')) })) }))
    const style = getComputedStyle(root), title = root.querySelector('h1')
    const supplement = document.querySelector('[data-approved-whm-dns-supplement]')
    return { root: rect(root), title: rect(title), fields, groups, rows,
      borders: { left: parseFloat(style.borderLeftWidth), right: parseFloat(style.borderRightWidth) },
      documentWidth: document.documentElement.scrollWidth, viewport: innerWidth,
      supplement: supplement ? rect(supplement) : null,
      buttons: [...root.querySelectorAll('button')].filter(button => !button.hidden).map(rect),
      serial: document.querySelector('[data-whm-dns-soa-serial]')?.textContent }
  })
  assert.ok(result.documentWidth <= result.viewport + 1, 'No horizontal page overflow')
  const padding = mobile ? 16 : 24
  near(ar ? result.root.right - result.borders.right - result.title.right : result.title.x - result.root.x - result.borders.left, padding, 'Panel content padding')
  for (const field of result.fields) {
    near(field.control.y - field.label.bottom, 8, 'Actual label/control gap')
    near(ar ? field.control.right - field.label.right : field.control.x - field.label.x, 0, 'Label/value alignment edge')
    assert.ok(field.control.height >= 44, 'Control target height')
  }
  for (let index = 1; index < result.groups.length; index++) near(result.groups[index].y - result.groups[index - 1].bottom, 24, 'Sibling group gap')
  for (let index = 1; index < result.fields.length; index++) {
    const current = result.fields[index].field, previous = result.fields[index - 1].field
    near(mobile ? current.y - previous.bottom : ar ? previous.x - current.right : current.x - previous.right, 16, 'Sibling field gap')
  }
  if (mobile) for (const row of result.rows) {
    for (const cell of row.cells) {
      near(cell.control.y - cell.label.bottom, 8, 'Record label/control gap')
      near(ar ? cell.control.right - cell.label.right : cell.control.x - cell.label.x, 0, 'Record label/value edge')
    }
    for (const cell of row.cells) assert.ok(cell.control.bottom <= cell.box.bottom + 1, 'The control must fit inside its actual cell')
    for (let index = 1; index < row.cells.length; index++) near(row.cells[index].label.y - row.cells[index - 1].control.bottom, 16, 'Actual sibling record content edges')
  }
  for (const button of result.buttons) assert.ok(button.height >= 44, 'Action target height')
  assert.ok(result.fields.length === 3 && result.rows[0].cells.length === 5, 'Geometry checks are non-vacuous')
  if (result.supplement) near(result.supplement.y - result.root.bottom, 32, 'Editor/supplement major sections')
  assert.ok(!/[\u0660-\u0669\u06f0-\u06f9]/.test(result.serial), 'ASCII serial')
  return result
}

try {
  for (const routePath of ['/whm/dns', '/domains/zone-editor']) for (const lang of ['en', 'ar']) for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    const page = await context.newPage(), errors = [], calls = []
    page.on('pageerror', error => errors.push(String(error)))
    let zones = [structuredClone(initial)], mode = 'normal'
    await page.addInitScript(() => {
      const transport = async (method, path, body) => {
        const response = await fetch(path, { method, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
        const value = await response.json()
        if (!response.ok) throw Object.assign(new Error(value.detail || 'Synthetic DNS failure'), { status: response.status, details: value.details || {} })
        return value
      }
      Object.defineProperty(window, 'xpanelSessionRequest', { get: () => transport, set: () => {}, configurable: false })
    })
    await page.route('**/api/dns/zones**', async intercepted => {
      const request = intercepted.request(), method = request.method(), path = new URL(request.url()).pathname
      const body = method === 'GET' ? undefined : request.postDataJSON()
      calls.push({ method, path, ...(body === undefined ? {} : { body }) })
      if (method === 'GET') return intercepted.fulfill({ json: { zones: zones.map(zone => ({ ...zone, revision: revision(zone) })) } })
      if (mode === 'uncertain') return intercepted.fulfill({ status: 503, json: { detail: 'Synthetic unknown outcome', details: { stateChanged: true, unknownOutcome: true } } })
      const name = decodeURIComponent(path.split('/').at(-1)), current = zones.find(zone => zone.name === name)
      if (routePath === '/whm/dns') {
        assert.equal(body.expectedZoneRevision, current ? revision(current) : null)
        assert.ok(!Object.hasOwn(body, 'serial') && !Object.hasOwn(body, 'id'), 'No UI-issued serial or zone identity')
      }
      if (method === 'DELETE') { zones = zones.filter(zone => zone.name !== name); return intercepted.fulfill({ json: { ok: true } }) }
      const saved = { id: current?.id ?? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', accountId: current?.accountId ?? body.accountId ?? accountId, name, serial: (current?.serial ?? 2026102601) + 1,
        records: body.records.map(record => ({ ...record, priority: record.priority ?? null })) }
      zones = [...zones.filter(zone => zone.name !== name), saved]
      return intercepted.fulfill({ json: { zone: saved, revision: revision(saved), reconcile: null } })
    })
    await page.route('**' + routePath + '?*', async intercepted => {
      const response = await intercepted.fetch()
      const body = (await response.text()).replaceAll('visual-account', accountId)
      return intercepted.fulfill({ response, body })
    })
    const root = page.locator('[data-dns-editor]'), status = root.locator('[data-dns-status]')
    const state = async wanted => page.waitForFunction(wanted => document.querySelector('[data-dns-status]')?.dataset.state === wanted && document.querySelector('[data-dns-editor]')?.getAttribute('aria-busy') !== 'true', wanted)
    const action = key => root.locator('[data-dns-' + key + ']')
    const prompt = async confirm => {
      await page.locator('[data-xp-prompt]').waitFor({ state: 'visible' })
      await page.locator(confirm ? '[data-xp-prompt-confirm]' : '[data-xp-prompt-cancel]').click()
      await page.locator('[data-xp-prompt]').waitFor({ state: 'hidden' })
    }
    await page.goto(fixture.baseUrl + routePath + '?lang=' + lang + '&theme=light', { waitUntil: 'load' })
    await state('read')
    const whm = routePath === '/whm/dns'
    const field = root.locator(whm ? '[data-field="content"]' : '[data-zone-field="content"]')
    await field.fill('192.0.2.99')
    if (whm) {
      const writes = calls.filter(call => call.method !== 'GET').length
      await action('save').click(); await prompt(false)
      assert.equal(calls.filter(call => call.method !== 'GET').length, writes, 'Cancel sends no mutation')
    }
    await action('save').click()
    if (whm) await prompt(true)
    await state('saved')
    assert.equal(zones[0].records[0].content, '192.0.2.99')
    assert.equal(zones[0].records[0].ttl, 0)
    assert.ok((await status.textContent()).includes(lang === 'ar' ? 'غير متحقق' : whm ? 'unverified' : 'not verified'), 'No serving/propagation claim')
    let measured = null
    if (whm) {
      measured = await geometry(page, width === 390, lang === 'ar')
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: resolve(output, `${lang}-${width}.png`), fullPage: true })
      await field.fill('192.0.2.88'); mode = 'uncertain'
      await action('save').click(); await prompt(true); await state('uncertain')
      assert.equal(await action('save').isDisabled(), true)
      assert.equal(await field.inputValue(), '192.0.2.88', 'Unknown outcome keeps the draft')
    } else {
      const data = await root.evaluate(element => ({ width: element.getBoundingClientRect().width, fields: [...element.querySelectorAll('.xp-field')].map(field => ({ label: field.querySelector('label')?.getBoundingClientRect().bottom, control: field.querySelector('input,select')?.getBoundingClientRect().top })), overflow: document.documentElement.scrollWidth > innerWidth + 1 }))
      assert.equal(data.overflow, false, 'Affected account editor has no page overflow')
      assert.equal(data.fields.length, 3)
      for (const field of data.fields) near(field.control - field.label, 8, 'Existing account label/control gap')
      measured = data
    }
    assert.deepEqual(errors, [], 'No page errors')
    results.push({ route: routePath, lang, width, status: 'passed', calls, geometry: measured, pageErrors: errors })
    await context.close()
  }
  assert.deepEqual(snapshot(), before, 'Source hashes unchanged during browser run')
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ at: new Date().toISOString(), syntheticTransport: true, nativeProof: false, source: before, results }, null, 2))
  process.stdout.write(JSON.stringify({ status: 'passed', contexts: results.length, nativeProof: false }) + '\n')
} catch (error) {
  writeFileSync(resolve(output, 'failed.json'), JSON.stringify({ at: new Date().toISOString(), source: before, results, error: String(error?.stack ?? error) }, null, 2))
  throw error
} finally { await close() }
