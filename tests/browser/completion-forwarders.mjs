// Real browser UI with explicitly mocked configuration transport; no mail delivery proof.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createVisualFixture } from './visual-fixture.mjs'

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.tools/playwright-browsers')
const { chromium } = await import('@playwright/test')
const out = resolve(process.env.XPANEL_FORWARDERS_OUTPUT || 'test-results/completion-forwarders')
mkdirSync(out, { recursive: true })
const paths = ['apps/web/src/board-port/extensions/account-forwarders.ts', 'apps/web/src/account-forwarders-client.ts', 'apps/web/src/board-port/extensions/account-pages.ts', 'apps/web/src/surfaces/xpanel.ts', 'apps/web/src/ws-client.ts', 'tests/browser/visual-fixture.mjs', 'tests/browser/completion-forwarders.mjs']
const snapshot = () => paths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
const before = snapshot()
const fixture = await createVisualFixture({ qualifiedCatalog: true })
const browser = await chromium.launch({ headless: true })
const runtime = { node:process.version, chromium:browser.version(), playwright:JSON.parse(readFileSync(resolve('node_modules/@playwright/test/package.json'),'utf8')).version }
const cases = []
let checkpoint = 'start', diagnosticPage, diagnosticGeometry
try {
  for (const lang of ['en', 'ar']) for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } })
    const page = await context.newPage()
    diagnosticPage = page
    checkpoint = `${lang}-${width}:load`
    // This read-only fixture has no authenticated session transport.
    await page.addInitScript(() => {
      const transport = async (method, path, body) => {
        const response = await fetch(path, { method, headers:{'content-type':'application/json'}, ...(body === undefined ? {} : { body:JSON.stringify(body) }) })
        const data = await response.json()
        if (!response.ok) throw Object.assign(new Error(data.error || 'mock_request_failed'), { status:response.status, details:data })
        return data
      }
      Object.defineProperty(window, 'xpanelSessionRequest', { get:()=>transport, set:()=>{}, configurable:false })
    })
    page.on('dialog', dialog => dialog.accept())
    let rows = [], failure = null
    const calls = []
    await page.route('**/api/mail/forwarders**', async route => {
      const req = route.request(), method = req.method()
      calls.push({ method, path: new URL(req.url()).pathname })
      const application = { status: 'configuration_only', nativeApplied: false }
      if (method === 'GET') return route.fulfill({ json: { forwarders: rows, application } })
      if (failure) return route.fulfill({ status: failure, json: failure === 500 ? { error: 'write_outcome_unknown', unknownOutcome: true, verificationRequired: true } : { error: 'forbidden' } })
      if (method === 'POST') {
        const body = req.postDataJSON()
        rows = [{ id: 'synthetic-forwarder', accountId: 'visual-account', sourceAddress: body.sourceAddress, destinations: body.destinations, createdAt:'2026-10-25T00:00:00Z' }]
        return route.fulfill({ status: 201, json: { forwarder: rows[0], application } })
      }
      if (method === 'DELETE') { rows = []; return route.fulfill({ json: { ok: true, application } }) }
      return route.fulfill({ status: 405, json: { error: 'method_not_allowed' } })
    })
    await page.goto(`${fixture.baseUrl}/email/forwarders?lang=${lang}&theme=light`, { waitUntil: 'load' })
    const workspace = page.locator('[data-forwarder-workspace]')
    await workspace.waitFor()
    const source = workspace.locator('[name="source"]'), destinations = workspace.locator('[name="destinations"]')
    const submit = workspace.locator('[data-forwarder-create] button[type="submit"]')
    await submit.waitFor({ state: 'visible' })
    checkpoint = `${lang}-${width}:initial-read`
    await page.waitForFunction(() => !document.querySelector('[data-forwarder-create] button[type="submit"]').disabled)
    await source.fill('info@preview.example.test')
    await destinations.fill('recipient@example.test')
    await submit.click()
    checkpoint = `${lang}-${width}:create-readback`
    await workspace.locator('[data-forwarder-delete="synthetic-forwarder"]').waitFor()
    assert.equal(rows[0].sourceAddress, 'info@preview.example.test')
    assert.deepEqual(rows[0].destinations, ['recipient@example.test'])
    await page.evaluate(()=>document.fonts.ready)
    const geometry = await workspace.evaluate(element => {
      const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom } }
      const fields = [...element.querySelectorAll('label[for]')].map(label => {
        const control = document.getElementById(label.htmlFor)
        if (!control) return null
        const range = document.createRange(); range.selectNodeContents(label)
        const text = range.getBoundingClientRect(), bounds = control.getBoundingClientRect(), style=getComputedStyle(control)
        const rtl = getComputedStyle(element).direction === 'rtl'
        return { label: label.textContent.trim(), gap: rect(control).y - rect(label).bottom, labelBoxHeight:rect(label).height, labelTextHeight:text.height, textGap:bounds.top-text.bottom, textAlignment:rtl ? Math.abs(text.right-(bounds.right-parseFloat(style.paddingRight)-parseFloat(style.borderRightWidth))) : Math.abs(text.left-(bounds.left+parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth))), alignment: Math.abs(rect(control).x - rect(label).x), control:rect(control) }
      }).filter(Boolean)
      const form = element.querySelector('[data-forwarder-create]'), fieldNodes=[...form.querySelectorAll('.xp-field')]
      const siblings = fieldNodes.slice(1).map((node,index)=>rect(node).y-rect(fieldNodes[index]).bottom)
      const children=[...form.children], groups=children.slice(1).map((node,index)=>rect(node).y-rect(children[index]).bottom)
      const extension=element.closest('.xp-extension'), sections=[...extension.children].filter(node=>node.tagName !== 'STYLE'), sectionGaps=sections.slice(1).map((node,index)=>rect(node).y-rect(sections[index]).bottom)
      const cards=[...extension.querySelectorAll('.xp-extension__card')].map(card=>{ const content=[...card.children].filter(node=>node.tagName!=='STYLE'), style=getComputedStyle(card), first=content[0], last=content.at(-1), bounds=rect(card);return { paddingLeft:rect(first).x-bounds.x-parseFloat(style.borderLeftWidth), paddingRight:bounds.right-rect(first).right-parseFloat(style.borderRightWidth), paddingTop:rect(first).y-bounds.y-parseFloat(style.borderTopWidth), paddingBottom:bounds.bottom-rect(last).bottom-parseFloat(style.borderBottomWidth) } })
      const targets=[...element.querySelectorAll('button,input[type=radio]')].map(node=>{ const native=rect(node), label=node.closest('label'), actual=label ? rect(label):native;return {type:node.type,native,associated:label ? actual:null,passes:(native.width>=43.5&&native.height>=43.5)||(actual.width>=43.5&&actual.height>=43.5)} })
      const table=element.querySelector('table'), wrap=element.querySelector('.xp-forwarder-table')
      const technical=[...table.querySelectorAll('bdi')].map(node=>{const range=document.createRange();range.selectNodeContents(node);return {lines:new Set([...range.getClientRects()].map(r=>Math.round(r.y))).size,whiteSpace:getComputedStyle(node).whiteSpace}})
      return { direction:getComputedStyle(element).direction, viewport:innerWidth, scrollWidth:document.documentElement.scrollWidth, fonts:{status:document.fonts.status,faces:[...document.fonts].map(face=>({family:face.family,status:face.status}))}, workspace:rect(element), fields, siblings, groups, sectionGaps, cards, targets, table:{width:rect(table).width,minimum:getComputedStyle(table).minInlineSize,wrapper:rect(wrap).width,scrollWidth:wrap.scrollWidth,technical} }
    })
    diagnosticGeometry = geometry
    checkpoint = `${lang}-${width}:geometry`
    await page.evaluate(()=>scrollTo(0,0))
    await page.screenshot({ path: `${out}/${lang}-${width}.png`, fullPage: true })
    assert.ok(geometry.scrollWidth <= width + 1, 'No horizontal page overflow')
    for (const field of geometry.fields) {
      assert.ok(Math.abs(field.textGap - 8) <= 1, `Label text/control gap ${field.textGap}`)
      assert.ok(field.control.height >= 43.5, 'Control touch target')
      assert.ok(field.alignment <= 1, 'Label/control same edge')
      assert.ok(field.textAlignment <= 1, `Label/control text alignment ${field.textAlignment}`)
    }
    for (const gap of geometry.siblings) assert.ok(Math.abs(gap-16)<=1, `Sibling field gap ${gap}`)
    for (const gap of geometry.groups) assert.ok(Math.abs(gap-24)<=1, `Form group gap ${gap}`)
    for (const gap of geometry.sectionGaps) assert.ok(Math.abs(gap-32)<=1, `Section gap ${gap}`)
    for (const card of geometry.cards) for(const value of Object.values(card)) assert.ok(Math.abs(value-(width<600?16:24))<=1, `Card content padding ${value}`)
    for (const target of geometry.targets) assert.equal(target.passes,true,'Native or associated label touch target')
    assert.ok(geometry.table.width>=699,'Readable native table minimum width')
    for(const value of geometry.table.technical) assert.ok(value.lines<=1,'Technical table values remain on one line')
    assert.equal(geometry.direction, lang === 'ar' ? 'rtl' : 'ltr')
    checkpoint = `${lang}-${width}:screenshot`
    await workspace.locator('[data-forwarder-delete="synthetic-forwarder"]').click()
    checkpoint = `${lang}-${width}:delete-confirm`
    await page.waitForFunction(() => !document.querySelector('[data-forwarder-delete="synthetic-forwarder"]') || Boolean(document.querySelector('[data-xp-prompt-confirm]')?.getBoundingClientRect().width))
    const confirm = page.locator('[data-xp-prompt-confirm]')
    if (await confirm.isVisible()) await confirm.click()
    await page.waitForFunction(() => !document.querySelector('[data-forwarder-delete="synthetic-forwarder"]'))
    assert.equal(rows.length, 0)
    checkpoint = `${lang}-${width}:forbidden`
    failure = 403
    await source.fill('denied@preview.example.test'); await destinations.fill('recipient@example.test'); await submit.click()
    await page.waitForFunction(() => document.querySelector('[data-forwarder-status]')?.dataset.state === 'failed')
    assert.equal(await source.inputValue(), 'denied@preview.example.test')
    assert.equal(rows.length, 0)
    failure = 500
    checkpoint = `${lang}-${width}:unknown`
    await submit.click()
    await page.waitForFunction(() => document.querySelector('[data-forwarder-status]')?.dataset.state === 'uncertain')
    assert.equal(await submit.isDisabled(), true)
    failure = null
    checkpoint = `${lang}-${width}:refresh`
    await workspace.locator('[data-forwarder-refresh]').click()
    await page.waitForFunction(() => !document.querySelector('[data-forwarder-create] button[type="submit"]').disabled)
    cases.push({ lang, width, status:'passed', geometry, calls, checks:['create/readback','delete/readback','403 preserves draft','unknown write blocks retry until refresh'] })
    await context.close()
  }
  const unqualified = await createVisualFixture({ qualifiedCatalog:false })
  try {
    const page = await browser.newPage()
    let requests = 0
    await page.route('**/api/mail/forwarders**', route => { requests++; return route.fulfill({ status:503, json:{ error:'unexpected_request' } }) })
    await page.goto(`${unqualified.baseUrl}/email/forwarders?lang=en`, { waitUntil:'load' })
    assert.equal(await page.locator('[data-forwarder-create]').count(), 0)
    assert.equal(requests, 0)
    cases.push({ status:'passed', scope:'unqualified fixture', checks:['no create form','no forwarder API request'] })
    await page.close()
  } finally { await unqualified.close() }
} catch (error) {
  const diagnostic = diagnosticPage && !diagnosticPage.isClosed() ? await diagnosticPage.evaluate(() => ({ transport:typeof window.xpanelSessionRequest, bound:document.querySelector('[data-forwarder-workspace]')?.getAttribute('data-forwarder-bound'), manage:document.querySelector('[data-forwarder-workspace]')?.getAttribute('data-forwarder-manage'), status:document.querySelector('[data-forwarder-status]')?.textContent, state:document.querySelector('[data-forwarder-status]')?.getAttribute('data-state') })) : undefined
  cases.push({ status:'failed', checkpoint, error: String(error), diagnostic, geometry:diagnosticGeometry })
  process.exitCode = 1
} finally {
  await browser.close(); await fixture.close()
  const after = snapshot()
  const result = { at:new Date().toISOString(), runtime, scope:'Real rendered route and browser client; mocked session bridge and forwarder configuration HTTP. No native mail delivery, actual authentication, or tenant authorization claim.', sourceUnchanged:JSON.stringify(before) === JSON.stringify(after), before, after, cases }
  if (!result.sourceUnchanged) process.exitCode = 1
  writeFileSync(`${out}/results.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ cases:cases.length, status:process.exitCode ? 'failed' : 'passed', output:out }))
}
