import { requireBrowserDiskHeadroom } from './resource-guard.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tools, navigation, canonicalNavigationRoute } from '../../packages/catalog/src/index.ts'
import { defaultPlan } from '../../packages/core/src/index.ts'
import { renderWebApp } from '../../apps/web/src/app.ts'
import { resolveWebDocumentRoute } from '../../apps/web/src/document-routes.ts'
import { emailAccountsRouteSpec } from '../../apps/web/src/board-port/extensions/email-accounts.ts'
import { accountPageRouteSpecs } from '../../apps/web/src/board-port/extensions/account-pages.ts'
import { storeRouteSpecs } from '../../apps/web/src/board-port/extensions/store.ts'
import { assertAppliedFont } from './applied-font-contract.mjs'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const ownPath = 'tests/browser/extensions-acceptance.mjs'
const routes = [
  { ...emailAccountsRouteSpec, family: 'email' },
  ...accountPageRouteSpecs.map(spec => ({ ...spec, family: 'account' })),
  ...storeRouteSpecs.map(spec => ({ ...spec, family: 'store' })),
  { route: '/software/installer', surface: 'xpanel', family: 'store' },
  { route: '/whm/software/site-software', surface: 'xwhm', family: 'store' },
  { route: '/resources', surface: 'xpanel', family: 'resources' },
]
assert.equal(routes.length, 28, 'The extension route matrix must remain explicit')
assert.equal(new Set(routes.map(spec => spec.route)).size, 28)

// These routes have an unread collection, not a fabricated row of facts.
const unreadCollectionOnlyRoutes = new Set(['/email/filters', '/email/spam-filters', '/email/spam-quarantine', '/email/archive', '/email/encryption', '/email/calendars-contacts', '/preferences/team'])
const typographyRoles = {
  caption: { size: 13, en: 20, ar: 22 }, label: { size: 14, en: 22, ar: 24 },
  body: { size: 16, en: 24, ar: 26 }, card: { size: 18, en: 28, ar: 30 },
  page: { size: 26, en: 34, ar: 36 },
}

const plan = defaultPlan({ id: 'synthetic-extension-plan', name: 'Standard', featureListId: 'synthetic-extension-features' })
const account = { id: 'synthetic-extension-account', username: 'alpha', uid: 20001, gid: 20001, home: '/home/alpha', primaryDomain: 'alpha.example.test', planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'contact@alpha.example.test', ipv4: '192.0.2.1', shell: 'none', createdAt: '2026-10-24T00:00:00Z' }
const owner = { kind: 'user', id: 'synthetic-extension-owner', username: account.username, accountId: account.id }
const administrator = { kind: 'root', id: 'synthetic-extension-root', username: 'synthetic-root' }
const domain = { id: 'synthetic-extension-domain', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: account.home + '/public_html', siteType: 'static', upstream: null, redirect: null, php: null, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }
const serviceUser = { id: 'synthetic-extension-service', accountId: account.id, login: 'mail@alpha.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 64, ftpDir: '' }

// Presentation qualification is confined to this synthetic fixture. It does not
// authenticate, mutate the real catalog or qualify any hosting/installer action.
const syntheticCatalog = tools.map(tool => ({ ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Synthetic extension presentation fixture only.', evidence: [] } }))
const registeredPages = new Map(navigation.flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => [page.route, { ...page, surface: surface.surface }]))))
for (const spec of routes) {
  const document = resolveWebDocumentRoute(spec.route)
  assert.equal(document?.surface, spec.surface, `Actual document registration: ${spec.route}`)
  const parent = registeredPages.get(canonicalNavigationRoute(spec.route))
  assert.equal(parent?.surface, spec.surface, `Actual navigation parent: ${spec.route}`)
  assert.ok(parent.tools.length > 0)
  if (spec.tools) assert.deepEqual([...spec.tools].sort(), [...parent.tools].sort(), `Inherited catalog tools: ${spec.route}`)
}

const sourceMetadata = ['.node-version', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'docs/STANDARDS.md']
const packageRoots = { '@xpanel/core': 'packages/core', '@xpanel/catalog': 'packages/catalog', '@xpanel/web': 'apps/web' }

/** Follow runtime imports/barrel exports, not unrelated agent/lifecycle trees. */
function fingerprint() {
  const visited = new Set(sourceMetadata)
  const pending = [ownPath]
  const localPath = (specifier, importer) => {
    let path
    if (specifier.startsWith('.')) path = resolve(root, dirname(importer), specifier)
    else if (Object.hasOwn(packageRoots, specifier)) {
      const directory = packageRoots[specifier]
      const metadataPath = join(directory, 'package.json').replaceAll('\\', '/')
      visited.add(metadataPath)
      const metadata = JSON.parse(readFileSync(join(root, metadataPath), 'utf8'))
      assert.equal(typeof metadata.exports['.'], 'string', 'Workspace export must be explicit')
      path = resolve(root, directory, metadata.exports['.'])
    } else {
      assert.ok(!specifier.startsWith('@xpanel/'), `Unmapped workspace dependency: ${specifier}`)
      return null
    }
    const projectPath = relative(root, path)
    assert.ok(projectPath && projectPath !== '..' && !projectPath.startsWith('..' + sep) && !isAbsolute(projectPath), 'Source import stays within repository')
    assert.ok(existsSync(path), `Missing source dependency ${projectPath}`)
    return projectPath.replaceAll('\\', '/')
  }
  while (pending.length) {
    const path = pending.pop()
    if (visited.has(path)) continue
    visited.add(path)
    if (!/\.[cm]?[jt]s$/.test(path)) continue
    const text = readFileSync(join(root, path), 'utf8')
    const imports = /\b(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g
    for (const match of text.matchAll(imports)) {
      if (match[2]) continue
      const dependency = localPath(match[3], path)
      if (dependency && !visited.has(dependency)) pending.push(dependency)
    }
  }
  const files = [...visited].sort().map(path => {
    const bytes = readFileSync(join(root, path))
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  const sha256 = createHash('sha256').update(files.map(file => `${file.path}\0${file.sha256}\n`).join('')).digest('hex')
  return { sha256, scope: 'Runtime import/export closure of the integrated presentation runner plus pinned runtime/dependency metadata; not a production/service qualification snapshot.', files }
}

async function fixture() {
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname.startsWith('/api/')) {
      requests.push({ method: request.method, path: url.pathname })
      response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"code":"SYNTHETIC_PRESENTATION_ONLY"}'); return
    }
    const spec = routes.find(row => row.route === url.pathname)
    if (request.method !== 'GET' || !spec) { response.writeHead(404); response.end(); return }
    const locale = url.searchParams.get('lang') === 'ar' ? 'ar' : 'en'
    const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark'
    const html = renderWebApp({
      surface: spec.surface, activeRoute: spec.route, locale, theme, catalog: syntheticCatalog,
      accountId: account.id, realtimeEnabled: false, security: { totpEnabled: true },
      visibility: { principal: spec.surface === 'xwhm' ? administrator : owner, disabledFeatures: new Set() },
      panel: { account, plan, domains: [domain], serviceUsers: [serviceUser] },
      whm: { principal: administrator, plans: [plan] },
    }).replace('<html ', '<html data-extensions-fixture="synthetic-qualified-presentation" ')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(html)
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => { server.closeIdleConnections(); server.close(done) }) }
}

async function measure(page, selector) {
  return page.evaluate(selector => {
    const parent = document.querySelector(selector)
    const canvas = document.querySelector('[data-section="slice-resources"][data-board-layout="/resources"]')
    const roots = canvas ? [canvas, parent] : [parent]
    const rtl = document.documentElement.dir === 'rtl'
    const visible = element => element.checkVisibility() && !element.closest('[hidden],[inert]') && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0
    const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
    const glyph = element => { const range = document.createRange(); range.selectNodeContents(element); return rect(range) }
    const edge = bounds => rtl ? bounds.right : bounds.left
    const children = element => [...element.children].filter(visible)
    const verticalGaps = element => { const list = children(element); return list.slice(1).map((element, index) => rect(element).top - rect(list[index]).bottom) }
    const gridGaps = element => {
      const boxes = children(element).map(rect).sort((a, b) => a.top - b.top || a.left - b.left)
      const rows = []
      for (const box of boxes) {
        let row = rows.find(row => box.top < row.bottom - 0.5 && box.bottom > row.top + 0.5)
        if (!row) { row = { top: box.top, bottom: box.bottom, boxes: [] }; rows.push(row) }
        row.top = Math.min(row.top, box.top); row.bottom = Math.max(row.bottom, box.bottom); row.boxes.push(box)
      }
      rows.sort((a, b) => a.top - b.top)
      return { inline: rows.flatMap(row => { row.boxes.sort((a, b) => a.left - b.left); return row.boxes.slice(1).map((box, index) => box.left - row.boxes[index].right) }), block: rows.slice(1).map((row, index) => row.top - rows[index].bottom) }
    }
    const facts = [...parent.querySelectorAll('.xp-extension__fact,.xp-resource-board__field')].filter(visible).map(row => {
      const label = row.querySelector('dt'), value = row.querySelector('dd')
      const l = rect(label), v = rect(value), vg = glyph(value)
      return { label: label.textContent.trim(), value: value.textContent.trim(), label_bounds: l, value_bounds: v, gap: v.top - l.bottom, edge_delta: Math.abs(edge(l) - edge(v)), glyph_edge_delta: Math.abs(edge(v) - edge(vg)) }
    })
    const fields = [...parent.querySelectorAll('.xp-field')].filter(visible).flatMap(row => {
      const label = row.querySelector('label[for]'), control = label && document.getElementById(label.htmlFor)
      if (!control || !visible(control)) return []
      const l = rect(label), c = rect(control), style = getComputedStyle(control), lg = glyph(label)
      const paintedEdge = rtl ? c.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight) : c.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
      return [{ id: control.id, tag: control.tagName, type: control.getAttribute('type'), multiple: control.multiple === true, size: control.getAttribute('size'), gap: c.top - l.bottom, label_bounds: l, control_bounds: c, label_glyph_edge: edge(lg), painted_edge: paintedEdge, painted_edge_delta: Math.abs(edge(lg) - paintedEdge), direction: style.direction, text_align: style.textAlign, font_family: style.fontFamily, font_size: style.fontSize, font_weight: style.fontWeight, line_height: style.lineHeight, appearance: style.appearance, color: style.color, background_color: style.backgroundColor, box_sizing: style.boxSizing, min_block_size: style.minBlockSize, padding: { inline_start: style.paddingInlineStart, inline_end: style.paddingInlineEnd, block_start: style.paddingBlockStart, block_end: style.paddingBlockEnd }, borders: { inline_start: style.borderInlineStartWidth, inline_end: style.borderInlineEndWidth, block_start: style.borderBlockStartWidth, block_end: style.borderBlockEndWidth } }]
    })
    const cards = [...parent.querySelectorAll('.xp-extension__card,.xp-resource-board__card')].filter(visible).map(card => {
      const style = getComputedStyle(card), box = rect(card), first = rect(children(card)[0])
      return { bounds: box, padding: { inline_start: style.paddingInlineStart, inline_end: style.paddingInlineEnd, block_start: style.paddingBlockStart, block_end: style.paddingBlockEnd }, actual_content_start: first.left - box.left - parseFloat(style.borderLeftWidth), actual_content_end: box.right - first.right - parseFloat(style.borderRightWidth), actual_content_top: first.top - box.top - parseFloat(style.borderTopWidth), group_gaps: verticalGaps(card) }
    })
    const targets = roots.flatMap(region => [...region.querySelectorAll('a[href],button,input:not([type="hidden"]),select,textarea,summary')]).filter(visible).map(element => ({ tag: element.tagName, text: element.textContent.trim(), disabled: element.disabled === true, bounds: rect(element) }))
    const human = roots.flatMap(region => [...region.querySelectorAll('h1,h2,h3,dt,label,button,a,p,dd,th,td')]).filter(element => visible(element) && element.textContent.trim() && !element.closest('bdi,.xp-mono,code') && !element.querySelector('bdi,.xp-mono,code')).map((element, index) => {
      const key = `font-${index}`; element.setAttribute('data-extension-font-probe', key)
      const style = getComputedStyle(element)
      const captionSelector = '[data-section="slice-resources"] > .xp-board-head > p.xp-help[data-wiring-hint="soon"]'
      const newComponent = parent.contains(element)
      let role = null
      if (element.matches(captionSelector)) role = 'caption'
      else if (newComponent) {
        if (element.tagName === 'H1') role = 'page'
        else if (element.tagName === 'H2') role = 'card'
        else if (element.tagName === 'DT' || element.matches('.xp-field > label[for]')) role = 'label'
        else if (['P', 'DD', 'BUTTON', 'A'].includes(element.tagName)) role = 'body'
      } else if (canvas?.contains(element)) {
        if (element.id === 'xpanel-resources-heading') role = 'page'
        else if (element.tagName === 'P') role = 'body'
      }
      return { selector: `[data-extension-font-probe="${key}"]`, text: element.textContent.trim(), tag: element.tagName, role, new_component: newComponent, caption_context: element.matches(captionSelector), size: style.fontSize, line_height: style.lineHeight, letter_spacing: style.letterSpacing }
    })
    return {
      page: rect(parent), document_width: document.documentElement.clientWidth, document_scroll: document.documentElement.scrollWidth,
      region_width: parent.clientWidth, region_scroll: parent.scrollWidth, major_gaps: verticalGaps(parent), cards, facts, fields, targets, human,
      sibling_layouts: [...parent.querySelectorAll('.xp-extension__facts,.xp-resource-board__facts,.xp-extension .xp-form-group,.xp-extension__actions,.xp-resource-board__groups,.xp-extension__list')].filter(visible).map(element => ({ class_name: element.className, gaps: gridGaps(element) })),
      ascii_digits: !/[\u0660-\u0669\u06f0-\u06f9]/.test(roots.map(region => region.textContent).join(' ')),
      collection_states: [...parent.querySelectorAll('[data-collection-state]')].map(element => element.dataset.collectionState),
      collection_rows: parent.querySelectorAll('.xp-extension__list > li').length,
      check_states: [...parent.querySelectorAll('[data-check-state]')].map(element => element.dataset.checkState),
      installer_states: [...parent.querySelectorAll('[data-installer-state]')].map(element => element.dataset.installerState),
      installer_progress: [...parent.querySelectorAll('[data-installer-progress]')].map(element => element.dataset.installerProgress),
      buttons: [...parent.querySelectorAll('button')].filter(visible).map(element => ({ disabled: element.disabled, type: element.type })),
      view_links: [...parent.querySelectorAll('nav a[data-nav-route]')].map(element => ({ route: element.dataset.navRoute, href: element.getAttribute('href'), current: element.getAttribute('aria-current') })),
      native_canvas: canvas ? { bounds: rect(canvas), title: canvas.querySelector('#xpanel-resources-heading')?.textContent, rows: canvas.querySelectorAll('tbody tr').length, slice_identity: canvas.textContent.includes('xpanel-20001.slice'), addon_gap: rect(parent).top - rect(canvas).bottom } : null,
      resource_state: parent.dataset.resourceReading ?? null,
      resource_metrics: [...parent.querySelectorAll('[data-resource-metric]')].map(element => ({ metric: element.dataset.resourceMetric, state: element.dataset.resourceState, values: [...element.querySelectorAll('[data-resource-value]')].map(value => value.textContent.trim()) })),
      mutation_forms: parent.querySelectorAll('form:not([method="dialog"])').length,
    }
  }, selector)
}

const near = (value, expected, message) => assert.ok(Number.isFinite(value) && Math.abs(value - expected) < 0.6, `${message}: expected ${expected}, observed ${value}`)

function validateGeometry(observation, spec, width, locale, theme) {
  assert.ok(observation.document_scroll <= observation.document_width, 'No document overflow')
  assert.ok(observation.region_scroll <= observation.region_width, 'No clipped extension overflow')
  assert.ok(observation.page.left >= -0.5 && observation.page.right <= width + 0.5, 'Extension remains within viewport')
  assert.equal(observation.ascii_digits, true, 'Displayed digits remain ASCII')
  assert.ok(observation.cards.length > 0)
  for (const gap of observation.major_gaps) near(gap, 32, 'Actual major section gap')
  for (const card of observation.cards) {
    for (const padding of Object.values(card.padding)) assert.equal(padding, width <= 800 ? '16px' : '24px')
    for (const value of [card.actual_content_start, card.actual_content_end, card.actual_content_top]) near(value, width <= 800 ? 16 : 24, 'Actual card content padding')
    for (const gap of card.group_gaps) near(gap, 24, 'Actual card content-group gap')
  }
  if (unreadCollectionOnlyRoutes.has(spec.route)) {
    assert.equal(observation.facts.length, 0, 'An unread collection must not manufacture fact rows')
    assert.deepEqual(observation.collection_states, ['unread'], 'The collection-only view must explicitly report its unread state')
    assert.equal(observation.collection_rows, 0, 'An unread collection must not fabricate records')
  } else assert.ok(observation.facts.length > 0, 'A fact-bearing view must retain its actual fields')
  for (const fact of observation.facts) {
    near(fact.gap, 8, 'Actual fact label/value gap')
    assert.ok(fact.edge_delta < 0.6, 'Fact label/value share the logical edge')
    assert.ok(fact.glyph_edge_delta < 1, 'Fact value glyphs remain at the same logical edge')
  }
  for (const field of observation.fields) {
    near(field.gap, 8, 'Native field label/control gap'); assert.ok(field.painted_edge_delta < 1, 'Label glyphs align with native painted text edge')
    assert.equal(parseFloat(field.font_size), 16, 'Native input type size')
    assert.equal(parseFloat(field.line_height), width <= 959 ? 24 : typographyRoles.body[locale], 'Exact mobile native-input line height or desktop body role')
  }
  for (const layout of observation.sibling_layouts) {
    const expected = /__groups|__list/.test(layout.class_name) ? 24 : 16
    for (const gap of [...layout.gaps.inline, ...layout.gaps.block]) near(gap, expected, 'Actual sibling/group gap')
  }
  for (const target of observation.targets) assert.ok(target.bounds.width >= 44 && target.bounds.height >= 44, 'Interactive targets are at least44px')
  if (spec.family !== 'email') assert.equal(observation.mutation_forms, 0, 'Read-only views contain no mutation form')
  if (spec.family === 'store') {
    assert.deepEqual(observation.installer_states, ['unavailable'])
    assert.ok(observation.installer_progress.every(state => state === 'unread'))
    assert.ok(observation.buttons.every(button => button.disabled && button.type === 'button'))
    const expected = storeRouteSpecs.filter(row => row.surface === spec.surface).map(row => row.route)
    assert.deepEqual(observation.view_links.map(link => link.route), expected)
    assert.equal(observation.view_links.filter(link => link.current === 'page').length, 1)
    for (const link of observation.view_links) {
      const destination = new URL(link.href, 'http://xpanel.invalid')
      assert.equal(destination.pathname, link.route)
      assert.equal(destination.searchParams.get('lang'), locale)
      assert.equal(destination.searchParams.get('theme'), theme)
      assert.ok([...destination.searchParams.keys()].every(key => ['lang', 'theme', 'density', 'accountId'].includes(key)))
    }
  }
  if (spec.route === '/email/deliverability' || spec.route === '/health') assert.deepEqual(observation.check_states, ['unread'])
  if (['/email/forwarders', '/email/filters', '/email/spam-filters', '/email/spam-quarantine', '/email/mailing-lists', '/email/archive', '/email/encryption', '/email/calendars-contacts', '/preferences/team'].includes(spec.route)) assert.deepEqual(observation.collection_states, ['unread'])
  if (spec.family === 'resources') {
    assert.ok(observation.native_canvas?.slice_identity && observation.native_canvas.rows > 0, 'Existing native resource canvas remains present')
    near(observation.native_canvas.addon_gap, 32, 'Native canvas/additive detail gap')
    assert.equal(observation.resource_state, 'unread', 'No usage read was injected')
    assert.equal(observation.resource_metrics.length, 8)
    for (const metric of observation.resource_metrics) assert.equal(metric.state, ['bandwidth', 'io-await'].includes(metric.metric) ? 'unmeasured' : 'unread')
  }
}

export async function runExtensionsAcceptance({ output, filter } = {}) {
  assert.equal(process.versions.node, readFileSync(join(root, '.node-version'), 'utf8').trim())
  const selected = routes.filter(spec => !filter || spec.route.includes(filter))
  assert.ok(selected.length > 0, 'Route filter must select actual extension views')
  requireBrowserDiskHeadroom(root, 384)
  const destination = resolve(root, output || 'test-results/extensions-' + new Date().toISOString().replaceAll(':', '-'))
  const projectPath = relative(root, destination)
  if (!projectPath || projectPath === '..' || projectPath.startsWith('..' + sep) || isAbsolute(projectPath) || existsSync(destination)) throw new Error('Choose a fresh repository-relative output directory')
  mkdirSync(join(destination, 'screenshots'), { recursive: true })
  const before = fingerprint()
  writeFileSync(join(destination, 'source-before.json'), JSON.stringify(before, null, 2) + '\n')
  const { chromium } = await import('@playwright/test')
  const axeSource = readFileSync(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8')
  const results = [], failures = []
  let browser, host, screenshots = 0, failureScreenshots = 0
  try {
    host = await fixture()
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true })
    for (const locale of ['en', 'ar']) for (const width of [360, 1440]) {
      const theme = width === 360 ? 'dark' : 'light'
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: locale === 'ar' ? 'ar-EG' : 'en-US', reducedMotion: 'reduce' })
      const page = await context.newPage()
      await page.route('**/*', route => {
        const url = new URL(route.request().url())
        if (url.origin === host.baseUrl || ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return route.continue()
        failures.push({ type: 'unexpected_external_request', origin: url.origin, path: url.pathname }); return route.abort()
      })
      for (const spec of selected) {
        requireBrowserDiskHeadroom(root, 256, destination)
        const result = { route: spec.route, surface: spec.surface, family: spec.family, locale, width, theme, synthetic_presentation_only: true }
        try {
          const response = await page.goto(host.baseUrl + spec.route + '?lang=' + locale + '&theme=' + theme, { waitUntil: 'networkidle' })
          assert.equal(response.status(), 200)
          const selector = spec.family === 'resources' ? '.xp-resource-board' : '[data-extension-view]'
          assert.equal(await page.locator(selector).count(), 1, 'Actual integrated extension body occurs once')
          await page.locator(selector).waitFor({ state: 'visible' })
          await page.evaluate(() => document.fonts.ready)
          assert.equal(await page.locator('html').getAttribute('data-extensions-fixture'), 'synthetic-qualified-presentation')
          result.geometry = await measure(page, selector)
          validateGeometry(result.geometry, spec, width, locale, theme)
          result.applied_fonts = []
          for (const human of result.geometry.human) {
            const font = await assertAppliedFont(page, human.selector, locale === 'ar' ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans')
            if (human.new_component) assert.ok(human.role, 'Every new ordinary text element must have an explicit semantic typography role')
            if (human.role === 'caption') {
              assert.equal(spec.family, 'resources')
              assert.equal(human.caption_context, true, 'Caption scope is the existing resource refresh hint only')
              assert.equal(human.text, locale === 'ar' ? 'قيد التفعيل' : 'Coming soon')
            }
            if (human.role) {
              const expected = typographyRoles[human.role]
              assert.equal(parseFloat(human.size), expected.size, `${human.role} type size`)
              assert.equal(parseFloat(human.line_height), expected[locale], `${human.role} line height`)
            }
            // Existing native canvas labels/table headings keep their source and
            // strict applied Sans observation; this extension does not restyle them.
            result.applied_fonts.push({ ...font, semantic_role: human.role, exact_role_checked: human.role !== null })
          }
          assert.ok(result.applied_fonts.length > 0, 'Actual human glyph fonts must be observed')
          await page.addScriptTag({ content: axeSource })
          result.accessibility = await page.evaluate(async () => {
            const checks = list => list.map(check => ({ id: check.id, impact: check.impact, message: check.message, data: check.data, related_nodes: (check.relatedNodes ?? []).map(node => ({ target: node.target, html: node.html })) }))
            const computed = element => {
              if (!element) return null
              const style = getComputedStyle(element), bounds = element.getBoundingClientRect()
              const backgrounds = []
              for (let parent = element; parent && backgrounds.length < 12; parent = parent.parentElement) {
                const ancestor = getComputedStyle(parent)
                backgrounds.push({ tag: parent.tagName, id: parent.id, class_name: parent.className, color: ancestor.color, background_color: ancestor.backgroundColor, background_image: ancestor.backgroundImage, opacity: ancestor.opacity })
              }
              return { color: style.color, background_color: style.backgroundColor, font_family: style.fontFamily, font_size: style.fontSize, font_weight: style.fontWeight, line_height: style.lineHeight, opacity: style.opacity, bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height }, background_ancestors: backgrounds }
            }
            return (await axe.run('main.xp-main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } })).violations.map(violation => ({ id: violation.id, impact: violation.impact, help: violation.help, help_url: violation.helpUrl, targets: violation.nodes.map(node => node.target), nodes: violation.nodes.map(node => ({ target: node.target, html: node.html, impact: node.impact, failure_summary: node.failureSummary, any: checks(node.any), all: checks(node.all), none: checks(node.none), computed: computed(typeof node.target[0] === 'string' ? document.querySelector(node.target[0]) : null) })) }))
          })
          assert.deepEqual(result.accessibility, [])
          const first = page.locator(selector).locator('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled])').first()
          if (await first.count()) {
            await first.focus(); assert.equal(await first.evaluate(element => document.activeElement === element), true)
            await page.keyboard.press('Tab'); result.keyboard_tab = await page.evaluate(() => ({ tag: document.activeElement.tagName, id: document.activeElement.id }))
            await page.keyboard.press('Shift+Tab'); assert.equal(await first.evaluate(element => document.activeElement === element), true, 'Reverse Tab returns to the same visible control')
          }
          if (spec.family === 'email') {
            result.native_domain_select = await page.locator('#mailbox-domain').evaluate(element => ({ tag: element.tagName, required: element.required, disabled: element.disabled, options: [...element.options].map(option => option.text) }))
            assert.equal(result.native_domain_select.tag, 'SELECT'); assert.equal(result.native_domain_select.required, true); assert.equal(result.native_domain_select.disabled, false)
            assert.deepEqual(result.native_domain_select.options, [domain.name])
          }
          if (screenshots < 8 && (spec.family === 'resources' || spec.route === '/email/accounts')) {
            const name = `representative-${screenshots++}-${locale}-${width}.png`
            await page.screenshot({ path: join(destination, 'screenshots', name), fullPage: false }); result.screenshot = name
          }
          result.passed = true
        } catch (error) {
          result.passed = false; result.error = String(error.stack || error)
          if (error.appliedFontObservation) result.failed_font_observation = error.appliedFontObservation
          if (failureScreenshots < 8) { const name = `failure-${failureScreenshots++}-${locale}-${width}.png`; await page.screenshot({ path: join(destination, 'screenshots', name), fullPage: false }).catch(() => {}); result.screenshot = name }
        }
        results.push(result)
        writeFileSync(join(destination, 'results.json'), JSON.stringify({ complete: false, synthetic_presentation_only: true, results }, null, 2) + '\n')
      }
      await context.close()
    }
  } catch (error) {
    failures.push({ type: 'infrastructure', error: String(error.stack || error) })
  } finally { if (browser) await browser.close(); if (host) await host.close() }
  const after = fingerprint()
  writeFileSync(join(destination, 'source-after.json'), JSON.stringify(after, null, 2) + '\n')
  const summary = { complete: results.length === selected.length * 4, synthetic_presentation_only: true, limitations: ['Synthetic catalog qualification only; no authentication, API authorization, native hosting, mail or installer qualification.', 'Resource usage is deliberately unread; no global IO snapshot is supplied.', 'Dark360 phone and light1440 desktop in English/Arabic; inverse pairs are not covered here.', 'Interactive layout and focus are exercised without clicking mutation controls.'], source_before: before.sha256, source_after: after.sha256, source_drift: before.sha256 !== after.sha256, registered_views: routes.length, selected_views: selected.length, expected_cases: selected.length * 4, passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, infrastructure_failures: failures, api_requests: host?.requests ?? [], screenshots, failure_screenshots: failureScreenshots, results }
  writeFileSync(join(destination, 'results.json'), JSON.stringify(summary, null, 2) + '\n')
  assert.equal(summary.source_drift, false, 'Presentation source must remain frozen')
  assert.equal(results.length, summary.expected_cases, 'Every selected matrix case must run')
  assert.deepEqual(failures, [], 'Unexpected network dependencies fail the run')
  assert.equal(summary.api_requests.some(request => !['GET', 'HEAD'].includes(request.method)), false, 'No mutation requests')
  assert.equal(summary.failed, 0, 'Every selected extension case must pass')
  return { output: destination, cases: results.length, passed: summary.passed, source_drift: summary.source_drift }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => process.argv.find(argument => argument.startsWith('--' + name + '='))?.split('=').slice(1).join('=')
  runExtensionsAcceptance({ output: option('output'), filter: option('filter') }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1 })
}
