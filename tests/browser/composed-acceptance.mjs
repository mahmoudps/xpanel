import { requireBrowserDiskHeadroom } from './resource-guard.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canOpenRegisteredRoute, navigation, tools, visibleNavigation, visibleTools } from '../../packages/catalog/src/index.ts'
import { defaultPlan } from '../../packages/core/src/index.ts'
import { renderWebApp } from '../../apps/web/src/app.ts'
import { composedXpanelRoutes, composedXwhmRoutes } from '../../apps/web/src/board-port/composed/all.ts'
import { collectSnapshotFiles, computeSourceDigest } from '../../scripts/vm/source-snapshot.mjs'
import { assertAppliedFont } from './applied-font-contract.mjs'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const routes = [...composedXpanelRoutes, ...composedXwhmRoutes]
const plan = defaultPlan({ id: 'synthetic-plan', name: 'Standard', featureListId: 'synthetic-features' })
const account = { id: 'synthetic-account', username: 'alpha', uid: 20001, gid: 20001, home: '/home/alpha', primaryDomain: 'alpha.example.test', planId: plan.id, ownerId: null, status: 'terminating', suspendReason: null, contactEmail: '', ipv4: '192.0.2.1', shell: 'none', createdAt: '2026-10-24T00:00:00Z' }
const principal = { kind: 'root', id: 'synthetic-root', username: 'synthetic-root' }
const owner = { kind: 'user', id: 'synthetic-owner', username: account.username, accountId: account.id }
// This fixture supplies qualified presentation states only. It does not authenticate,
// change the real catalog, execute operations or prove a host/service capability.
const catalog = tools.map(tool => ({ ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Synthetic composed presentation fixture only.', evidence: [] } }))
const reseller = { id: 'synthetic-reseller', username: 'reseller.example.test', acl: ['list-accounts'], maxAccounts: 12, totalDiskMb: 2048, totalBandwidthMb: 4096, oversell: false, nameservers: ['ns1.example.test', 'ns2.example.test'], delegatedIps: [] }
const domain = { id: 'synthetic-domain', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: account.home + '/public_html', siteType: 'static', upstream: null, redirect: null, php: null, wildcard: false, certificateId: 'synthetic-certificate', suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }

const fingerprint = () => {
  const files = [...new Set([...collectSnapshotFiles(root), 'tests/browser/composed-acceptance.mjs', 'tests/browser/resource-guard.mjs', 'tests/browser/applied-font-contract.mjs'])].sort().map(path => {
    const bytes = readFileSync(join(root, path))
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  return { sha256: computeSourceDigest(files), files }
}

async function fixture() {
  const requests = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname.startsWith('/api/')) {
      requests.push({ method: request.method, path: url.pathname })
      response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"code":"SYNTHETIC_READ_ONLY"}'); return
    }
    const spec = routes.find(spec => spec.route === url.pathname)
    if (!spec || request.method !== 'GET') { response.writeHead(404); response.end(); return }
    const locale = url.searchParams.get('lang') === 'ar' ? 'ar' : 'en'
    const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark'
    const html = renderWebApp({
      surface: spec.surface, activeRoute: spec.route, locale, theme, catalog, accountId: account.id,
      visibility: { principal: spec.surface === 'xpanel' ? owner : principal, disabledFeatures: new Set() },
      realtimeEnabled: false, security: { totpEnabled: true },
      panel: { account, plan, domains: [domain], serviceUsers: [{ id: 'synthetic-membership', accountId: account.id, login: 'disk@alpha.example.test', services: { email: false, ftp: true, webdisk: true }, mailboxQuotaMb: 999999, ftpDir: 'public_html' }] },
      whm: { principal, accounts: [account], resellers: [reseller], plans: [plan] },
    }).replace('<html ', '<html data-composed-fixture="synthetic-qualified-presentation" ')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(html)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve) }) }
}

async function verifyReverseProxyFallback(page, result, locale, width, host, requestStart, axeSource) {
  const route = '/domains/reverse-proxy'
  const visibility = { principal: owner, disabledFeatures: new Set() }
  const pageSpec = navigation.flatMap(surface => surface.sections.flatMap(section => section.pages)).find(page => page.route === route)
  const requiredIds = ['aapanel-site-reverse-proxy', 'aapanel-proxy-project']
  assert.deepEqual([...pageSpec.tools].sort(), [...requiredIds].sort())
  const required = requiredIds.map(id => catalog.find(tool => tool.id === id))
  assert.ok(required.every(tool => tool && tool.surface === 'aapanel' && tool.rootOnly === true && tool.status === 'verified' && tool.delivery.status === 'verified'))
  assert.equal(canOpenRegisteredRoute(route, visibility), true, 'The owner may open the registered document')
  const visible = new Set(visibleTools(catalog, visibility).map(tool => tool.id))
  assert.ok(requiredIds.every(id => !visible.has(id)), 'Verified flags do not grant an owner root-only aaPanel capabilities')
  assert.equal(visibleNavigation(visibility, catalog).some(surface => surface.sections.some(section => section.pages.some(page => page.route === route))), false)
  result.catalog_boundary = { registered_owner_admission: true, qualified_route: false, required_tools: required.map(tool => ({ id: tool.id, surface: tool.surface, rootOnly: tool.rootOnly, status: tool.status, delivery: tool.delivery.status })), capability_grant_override: false }

  const scopeSelector = '[data-tool-availability="unverified"]'
  const scope = page.locator(scopeSelector)
  await scope.waitFor({ state: 'visible' })
  await page.evaluate(() => document.fonts.ready)
  assert.equal(await page.locator('h1:visible').count(), 1, 'There is one visible page heading')
  assert.equal((await scope.locator('h1:visible').innerText()).trim(), locale === 'ar' ? 'الوكيل العكسي' : 'Reverse proxy')
  assert.equal(await page.locator('html').getAttribute('lang'), locale)
  assert.equal(await page.locator('html').getAttribute('dir'), locale === 'ar' ? 'rtl' : 'ltr')
  assert.equal(await page.locator('html').getAttribute('data-realtime-enabled'), 'false')
  const disabledPage = scope.locator('[data-catalog-screen="true"][data-wiring="soon"]')
  assert.equal(await disabledPage.isVisible(), true)
  const unread = locale === 'ar' ? 'هذه الشاشة على الخادم. تبقى فارغة إلى أن تُوصل أداتها.' : 'This screen is on the server. It stays empty until its tool is connected.'
  assert.equal((await disabledPage.locator('.xp-design-page__lede').innerText()).trim(), unread)
  assert.equal((await disabledPage.locator('.xp-design-empty h2').innerText()).trim(), locale === 'ar' ? 'قيد التفعيل' : 'Coming soon')
  assert.ok((await disabledPage.locator('.xp-design-empty').innerText()).includes(unread))
  const actions = disabledPage.locator('button:visible')
  assert.ok(await actions.count() > 0, 'The unavailable operation retains a visible disabled action')
  for (const action of await actions.all()) assert.equal(await action.isDisabled(), true)

  result.geometry = await page.evaluate(() => {
    const parent = document.querySelector('[data-tool-availability="unverified"]')
    const design = parent.querySelector('[data-catalog-screen="true"]')
    const header = design.querySelector('.xp-board-head')
    const empty = design.querySelector('.xp-design-empty')
    const identity = parent.querySelector('[data-workspace-identity]')
    const grid = identity.querySelector('.xp-kpi-grid')
    const rtl = document.documentElement.dir === 'rtl'
    const rectangle = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
    const edge = rect => rtl ? rect.right : rect.left
    const textRects = node => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), rects = []
      let text
      while ((text = walker.nextNode())) {
        if (!text.textContent.trim()) continue
        const range = document.createRange(); range.selectNodeContents(text)
        for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) rects.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
      }
      return rects
    }
    const facts = [...identity.querySelectorAll('[data-workspace-field]')].map(field => {
      const label = field.querySelector('.xp-label'), value = field.querySelector('.xp-field-value')
      const l = rectangle(label), v = rectangle(value), labels = textRects(label), values = textRects(value)
      const labelEdge = labels.length ? (rtl ? Math.max(...labels.map(rect => rect.right)) : Math.min(...labels.map(rect => rect.left))) : null
      return { field: field.dataset.workspaceField, text: value.textContent.trim(), visible: field.checkVisibility() && label.checkVisibility() && value.checkVisibility(), gap: v.top - l.bottom, edge_delta: Math.abs(edge(l) - edge(v)), glyph_edge_delta: labels.length && values.length ? Math.max(...values.map(rect => Math.abs(labelEdge - edge(rect)))) : null, label_text_rects: labels, value_text_rects: values, isolation: [...value.querySelectorAll('bdi')].map(node => ({ direction: getComputedStyle(node).direction, isolate: getComputedStyle(node).unicodeBidi.includes('isolate') })) }
    })
    const h1 = header.querySelector('h1'), lede = header.querySelector('.xp-design-page__lede')
    const emptyChildren = [...empty.children]
    return { state: 'unqualified-unread', page: rectangle(parent), document_width: document.documentElement.clientWidth, document_scroll: document.documentElement.scrollWidth,
      actual_heading_lede_gap: rectangle(lede).top - rectangle(h1).bottom,
      design_major_gap: rectangle(empty).top - rectangle(header).bottom,
      workspace_major_gap: rectangle(identity).top - rectangle(design).bottom,
      empty_group_gaps: emptyChildren.slice(1).map((child, index) => rectangle(child).top - rectangle(emptyChildren[index]).bottom),
      empty_card_padding: getComputedStyle(empty).paddingInlineStart, identity_card_padding: getComputedStyle(identity).paddingInlineStart,
      identity_group_gap: rectangle(grid).top - rectangle(identity.querySelector('h2')).bottom,
      fields_gap: getComputedStyle(grid).gap, facts,
      interactive: [...parent.querySelectorAll('button,a,input,select,textarea')].filter(element => element.checkVisibility()).map(rectangle),
      ascii_digits: !/[\u0660-\u0669\u06f0-\u06f9]/.test(parent.innerText), text: parent.innerText,
      mutations: parent.querySelectorAll('form,[data-terminal-form],[data-file-manager],[data-custom-config-form],[data-certificate-form]').length,
      fabricated_result_markers: parent.querySelectorAll('[data-read-state="loaded"],[data-read-state="empty"],[data-collection-state="empty"],[data-composed-route],[role="progressbar"]').length }
  })
  const geometry = result.geometry
  assert.deepEqual(Object.fromEntries(geometry.facts.map(fact => [fact.field, fact.text])), {
    username: owner.username, role: locale === 'ar' ? 'مالك الحساب' : 'Account owner',
    'primary-domain': account.primaryDomain, plan: plan.name, status: locale === 'ar' ? 'قيد الإنهاء' : 'Terminating',
  }, 'The disabled workspace renders exactly the 5 persisted identity facts')
  assert.equal(geometry.facts.length, 5)
  assert.ok(geometry.document_scroll <= geometry.document_width, 'No document overflow')
  assert.ok(geometry.page.left >= -0.5 && geometry.page.right <= width + 0.5, 'The fallback stays within the viewport')
  assert.ok(Math.abs(geometry.actual_heading_lede_gap - 8) < 0.6, 'Actual heading/lede gap stays 8px')
  assert.ok(Math.abs(geometry.design_major_gap - 32) < 0.6, 'Actual disabled header/body section gap stays 32px')
  assert.ok(Math.abs(geometry.workspace_major_gap - 32) < 0.6, 'Actual workspace major sections stay 32px apart')
  for (const gap of geometry.empty_group_gaps) assert.ok(Math.abs(gap - 24) < 0.6, 'Actual disabled card content groups stay 24px apart')
  assert.ok(Math.abs(geometry.identity_group_gap - 24) < 0.6, 'Actual identity heading/field group gap stays 24px')
  assert.equal(geometry.empty_card_padding, width > 800 ? '24px' : '16px')
  assert.equal(geometry.identity_card_padding, width > 800 ? '24px' : '16px')
  assert.equal(geometry.fields_gap, '16px')
  for (const fact of geometry.facts) {
    assert.equal(fact.visible, true)
    assert.ok(Math.abs(fact.gap - 8) < 0.6, 'Actual identity label/value gap stays 8px')
    assert.ok(fact.edge_delta < 0.6, 'Identity field label/value boxes share an alignment edge')
    assert.ok(fact.glyph_edge_delta !== null && fact.glyph_edge_delta < 1, 'Actual identity glyphs share their label edge on every line')
    for (const bdi of fact.isolation) { assert.equal(bdi.direction, 'ltr'); assert.equal(bdi.isolate, true) }
  }
  assert.equal(geometry.facts.flatMap(fact => fact.isolation).length, 2, 'Username and domain retain actual inline LTR isolation')
  for (const target of geometry.interactive) assert.ok(target.width >= 44 && target.height >= 44, 'Actual fallback control targets stay at least 44px')
  assert.equal(geometry.ascii_digits, true)
  assert.equal(geometry.mutations, 0)
  assert.equal(geometry.fabricated_result_markers, 0)
  for (const value of [account.id, account.home, account.ipv4, plan.id, plan.featureListId, domain.id, domain.docRoot, 'disk@alpha.example.test', '999999']) assert.ok(!geometry.text.includes(value), 'The disabled summary does not expose full hosting data')
  result.applied_font = await assertAppliedFont(page, scopeSelector + ' h1', locale === 'ar' ? 'sans-serif' : 'IBM Plex Sans')
  result.applied_label_fonts = []
  for (const fact of geometry.facts) result.applied_label_fonts.push(await assertAppliedFont(page, `[data-workspace-field="${fact.field}"] .xp-label`, locale === 'ar' ? 'sans-serif' : 'IBM Plex Sans'))
  await page.addScriptTag({ content: axeSource })
  result.accessibility = await page.evaluate(async selector => (await axe.run(selector, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } })).violations.map(violation => ({ id: violation.id, impact: violation.impact, targets: violation.nodes.map(node => node.target) })), scopeSelector)
  assert.deepEqual(result.accessibility, [])
  assert.deepEqual(host.requests.slice(requestStart), [], 'The disabled fallback performs no API/provider reads or mutations')
  result.expected_disabled_fallback = true
}

export async function runComposedAcceptance({ output, filter } = {}) {
  assert.equal(process.versions.node, readFileSync(join(root, '.node-version'), 'utf8').trim())
  requireBrowserDiskHeadroom(root, 384)
  const destination = resolve(root, output || 'test-results/composed-' + new Date().toISOString().replaceAll(':', '-'))
  const path = relative(root, destination)
  if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path) || existsSync(destination)) throw new Error('Choose a fresh repository-relative output directory')
  mkdirSync(join(destination, 'screenshots'), { recursive: true })
  const before = fingerprint()
  writeFileSync(join(destination, 'source-before.json'), JSON.stringify(before, null, 2) + '\n')
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true })
  const host = await fixture()
  const results = []
  let screenshots = 0, failureScreenshots = 0
  const axeSource = readFileSync(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8')
  try {
    for (const locale of ['en', 'ar']) for (const width of [360, 1440]) {
      const theme = width === 360 ? 'dark' : 'light'
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: locale === 'ar' ? 'ar-EG' : 'en-US', reducedMotion: 'reduce' })
      const page = await context.newPage()
      for (const spec of routes.filter(spec => !filter || spec.route.includes(filter))) {
        requireBrowserDiskHeadroom(root, 256, destination)
        const result = { route: spec.route, surface: spec.surface, locale, width, theme, synthetic_presentation_only: true }
        try {
          const requestStart = host.requests.length
          const response = await page.goto(host.baseUrl + spec.route + '?lang=' + locale + '&theme=' + theme, { waitUntil: 'networkidle' })
          assert.equal(response.status(), 200)
          if (spec.route === '/domains/reverse-proxy') {
            await verifyReverseProxyFallback(page, result, locale, width, host, requestStart, axeSource)
          } else {
          await page.locator('[data-composed-route]').waitFor({ state: 'visible' })
          await page.evaluate(() => document.fonts.ready)
          result.geometry = await page.evaluate(() => {
            const parent = document.querySelector('[data-composed-route]')
            const rectangle = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
            const rtl = document.documentElement.dir === 'rtl'
            const glyphEdge = element => {
              const range = document.createRange(); range.selectNodeContents(element)
              const bounds = range.getBoundingClientRect()
              return rtl ? bounds.right : bounds.left
            }
            const field = (label, value) => {
              if (!label || !value) throw new Error('Composed field lacks its semantic label/value pair')
              const l = rectangle(label), v = rectangle(value)
              const control = ['INPUT', 'SELECT', 'TEXTAREA'].includes(value.tagName)
              const text = control ? value.value : value.textContent.trim()
              const style = getComputedStyle(value)
              const contentEdge = rtl ? v.right - parseFloat(style.borderRightWidth || 0) - parseFloat(style.paddingRight || 0) : v.left + parseFloat(style.borderLeftWidth || 0) + parseFloat(style.paddingLeft || 0)
              return { kind: control ? 'control' : 'fact', tag: value.tagName, id: value.id, text, label: l, value: v, gap: v.top - l.bottom, edge_delta: Math.abs((rtl ? l.right : l.left) - (rtl ? v.right : v.left)), label_glyph_edge_delta: Math.abs(glyphEdge(label) - (rtl ? l.right : l.left)), value_glyph_edge_delta: control ? null : text.length ? Math.abs((rtl ? v.right : v.left) - glyphEdge(value)) : null, control_content_edge: control ? contentEdge : null, disabled: control ? value.matches(':disabled') : null, readonly: control ? value.readOnly === true : null, associated: control ? value.labels?.length === 1 && value.labels[0] === label : null }
            }
            const mobileLabels = [...parent.querySelectorAll('.xp-composed-cell-label')].filter(label => label.checkVisibility())
            const fields = [...parent.querySelectorAll('.xp-composed-field')].map(row => field(row.querySelector(':scope > dt, :scope > label'), row.querySelector(':scope > dd, :scope > input, :scope > select, :scope > textarea')))
            const facts = fields.filter(observation => observation.kind === 'fact')
            const mobileCells = mobileLabels.map(label => field(label, label.nextElementSibling))
            const tables = [...parent.querySelectorAll('table')].map(table => {
              const headers = [...table.querySelectorAll('th[scope="col"]')]
              const rows = [...table.querySelectorAll('tbody tr')].map(row => {
                const cells = [...row.children]
                const status = cells.length === 1 && cells[0].classList.contains('xp-composed-empty-cell') && cells[0].colSpan === headers.length
                return { kind: status ? 'read-status' : 'data', widths: cells.length, column_span: cells.reduce((count, cell) => count + cell.colSpan, 0), cells: cells.map(td => ({ label: td.querySelector('.xp-composed-cell-label')?.textContent, value: td.querySelector('.xp-composed-cell-value')?.textContent, text: td.textContent.trim(), ...rectangle(td) })), header_value_edge_deltas: innerWidth > 600 && !status ? cells.map((td, index) => {
                  const value = td.querySelector('.xp-composed-cell-value')
                  if (!headers[index] || !value) throw new Error('Data table cell lacks its header/value pair')
                  return Math.abs(glyphEdge(headers[index]) - glyphEdge(value))
                }) : [], status_header_edge_delta: innerWidth > 600 && status ? Math.abs(glyphEdge(headers[0]) - glyphEdge(cells[0])) : null }
              })
              return { columns: headers.length, rows }
            })
            const interactive = [...parent.querySelectorAll('button,a,input,select,textarea')].filter(element => element.checkVisibility()).map(rectangle)
            const majorChildren = [...parent.children]
            const actualSectionGaps = majorChildren.slice(1).map((child, index) => rectangle(child).top - rectangle(majorChildren[index]).bottom)
            const cards = [...parent.querySelectorAll('.xp-composed-card')].map(card => {
              const children = [...card.children]
              return { ...rectangle(card), padding: getComputedStyle(card).paddingInlineStart, gap: getComputedStyle(card).rowGap, actual_group_gaps: children.slice(1).map((child, index) => rectangle(child).top - rectangle(children[index]).bottom) }
            })
            const stateGroups = [...parent.querySelectorAll('.xp-composed-state-group')].map(group => {
              const children = [...group.children]
              return children.slice(1).map((child, index) => rectangle(child).top - rectangle(children[index]).bottom)
            })
            const fieldGroups = [...parent.querySelectorAll('.xp-composed-fields, .xp-composed-facts')].map(group => getComputedStyle(group).gap)
            return { route: parent.dataset.composedRoute, state: parent.dataset.readState, document_width: document.documentElement.clientWidth, document_scroll: document.documentElement.scrollWidth, page: rectangle(parent), page_gap: getComputedStyle(parent).rowGap, actual_section_gap: actualSectionGaps[0], actual_section_gaps: actualSectionGaps, cards, state_groups: stateGroups, field_groups: fieldGroups, fields, facts, mobileCells, tables, interactive, ascii_digits: !/[\u0660-\u0669\u06f0-\u06f9]/.test(parent.textContent), mutations: parent.querySelectorAll('form,[data-terminal-form],[data-custom-config-form]').length }
          })
          const geometry = result.geometry
          assert.equal(geometry.route, spec.route)
          assert.ok(geometry.document_scroll <= geometry.document_width, 'No document overflow')
          assert.ok(geometry.page.left >= -0.5 && geometry.page.right <= width + 0.5, 'Page stays within viewport')
          assert.equal(geometry.page_gap, '32px')
          assert.ok(Math.abs(geometry.actual_section_gap - 32) < 0.6, 'Actual major section gap is 32px')
          assert.ok(geometry.actual_section_gaps.length > 0)
          for (const gap of geometry.actual_section_gaps) assert.ok(Math.abs(gap - 32) < 0.6, 'Every direct major section gap is 32px')
          assert.ok(geometry.cards.length > 0)
          for (const card of geometry.cards) {
            assert.equal(card.gap, '24px')
            for (const gap of card.actual_group_gaps) assert.ok(Math.abs(gap - 24) < 0.6, 'Actual content group gap is 24px')
            assert.equal(card.padding, width > 800 ? '24px' : '16px')
          }
          for (const gaps of geometry.state_groups) for (const gap of gaps) assert.ok(Math.abs(gap - 8) < 0.6, 'Status and explanation retain their 8px child gap')
          for (const gap of geometry.field_groups) assert.equal(gap, '16px')
          for (const observation of [...geometry.fields, ...geometry.mobileCells]) {
            assert.ok(Math.abs(observation.gap - 8) < 0.6, 'Label/value or label/control gap is 8px')
            assert.ok(observation.edge_delta < 0.6, 'Label and value/control share the same alignment edge')
            assert.ok(observation.label_glyph_edge_delta < 1, 'Actual label glyphs remain at the field alignment edge')
            if (observation.kind === 'control') {
              assert.equal(observation.associated, true, 'The control is associated with its own visible label')
              assert.equal(observation.disabled, true, 'Unavailable layout controls remain disabled')
              assert.equal(observation.text, '', 'Unread controls do not contain invented file content or commands')
              if (observation.tag === 'TEXTAREA') assert.equal(observation.readonly, true, 'The unread editor also remains readonly')
              // An empty native control has no value glyph to measure. Its actual
              // label, control box/content edge and empty/disabled state are retained above.
              assert.equal(observation.value_glyph_edge_delta, null)
              assert.ok(Number.isFinite(observation.control_content_edge))
            } else {
              assert.ok(observation.value_glyph_edge_delta !== null && observation.value_glyph_edge_delta < 1, 'LTR glyphs remain at the field alignment edge')
            }
          }
          for (const table of geometry.tables) {
            assert.ok(table.columns > 0 && table.rows.length > 0, 'Every table retains headers and actual body rows')
            for (const row of table.rows) {
              assert.equal(row.column_span, table.columns, 'Actual table headers match every logical row span')
              if (row.kind === 'data') {
                assert.equal(row.widths, table.columns, 'Every data row retains one cell per header')
                for (const delta of row.header_value_edge_deltas) assert.ok(delta < 1, 'Desktop table header and value glyphs share the same alignment edge')
              } else {
                assert.equal(row.widths, 1, 'An explicit full-width read status is not a fabricated data row')
                assert.ok(row.cells[0].text.length > 0, 'Read-status rows remain visible and descriptive')
                if (row.status_header_edge_delta !== null) assert.ok(row.status_header_edge_delta < 1, 'Read-status text shares the first header alignment edge')
              }
            }
          }
          for (const target of geometry.interactive) assert.ok(target.width >= 44 && target.height >= 44, 'Interactive targets are at least 44px')
          assert.equal(geometry.ascii_digits, true)
          assert.equal(geometry.mutations, 0)
          result.applied_font = await assertAppliedFont(page, '[data-composed-route] h1', locale === 'ar' ? 'sans-serif' : 'IBM Plex Sans')
          await page.addScriptTag({ content: axeSource })
          result.accessibility = await page.evaluate(async () => (await axe.run('[data-composed-route]', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } })).violations.map(violation => ({ id: violation.id, impact: violation.impact, targets: violation.nodes.map(node => node.target) })))
          assert.deepEqual(result.accessibility, [])
          const region = page.locator('.xp-composed-scroll')
          if (await region.count()) { for (const table of await region.all()) { await table.focus(); assert.equal(await table.evaluate(element => document.activeElement === element), true) }; result.table_keyboard_focus = true }
          }
          if (screenshots < 8 && (spec.bind !== 'soon' || screenshots < 2)) {
            const name = `representative-${screenshots}-${locale}-${width}.png`
            await page.screenshot({ path: join(destination, 'screenshots', name), fullPage: false }); result.screenshot = name; screenshots++
          }
          result.passed = true
        } catch (error) {
          result.passed = false; result.error = String(error.stack || error)
          if (failureScreenshots < 8) { const name = `failure-${failureScreenshots++}-${locale}-${width}.png`; await page.screenshot({ path: join(destination, 'screenshots', name), fullPage: false }).catch(() => {}); result.screenshot = name }
        }
        results.push(result)
        writeFileSync(join(destination, 'results.json'), JSON.stringify({ complete: false, results }, null, 2) + '\n')
      }
      await context.close()
    }
  } finally { await browser.close(); await host.close() }
  const after = fingerprint()
  writeFileSync(join(destination, 'source-after.json'), JSON.stringify(after, null, 2) + '\n')
  const summary = { complete: true, synthetic_presentation_only: true, limitations: ['No authentication or API authorization qualification.', 'No host operation, mail, backup, terminal or service execution.', 'Dark phone and light desktop states; no claim for the inverse theme/viewport pairs.'], source_before: before.sha256, source_after: after.sha256, source_drift: before.sha256 !== after.sha256, registered_routes: routes.length, selected_routes: routes.filter(spec => !filter || spec.route.includes(filter)).length, expected_cases: routes.filter(spec => !filter || spec.route.includes(filter)).length * 4, passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, api_requests: host.requests, screenshots, failure_screenshots: failureScreenshots, results }
  writeFileSync(join(destination, 'results.json'), JSON.stringify(summary, null, 2) + '\n')
  assert.equal(summary.source_drift, false, 'Candidate source must remain frozen throughout browser acceptance')
  assert.equal(host.requests.some(request => request.method !== 'GET' && request.method !== 'HEAD'), false, 'No mutating API requests')
  assert.equal(summary.failed, 0, 'All selected composed browser cases must pass')
  return { output: destination, cases: results.length, passed: summary.passed, source_drift: summary.source_drift }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => process.argv.find(argument => argument.startsWith('--' + name + '='))?.split('=').slice(1).join('=')
  runComposedAcceptance({ output: option('output'), filter: option('filter') }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1 })
}
