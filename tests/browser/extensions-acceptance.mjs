import { requireBrowserDiskHeadroom } from './resource-guard.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tools, navigation, canonicalNavigationRoute } from '../../packages/catalog/src/index.ts'
import { defaultPlan } from '../../packages/core/src/index.ts'
import { renderWebApp, serveStaticAsset } from '../../apps/web/src/app.ts'
import { resolveWebDocumentRoute } from '../../apps/web/src/document-routes.ts'
import { assertAppliedFont } from './applied-font-contract.mjs'
import { injectTestScript, recordCspViolations } from './csp-violations.mjs'
import { documentSecurityHeaders } from '../../apps/web/src/content-security-policy.ts'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const ownPath = 'tests/browser/extensions-acceptance.mjs'
const storeRouteSpecs = [
  { route: '/software/store', surface: 'xpanel' },
  { route: '/software/store/app', surface: 'xpanel' },
  { route: '/software/store/install', surface: 'xpanel' },
  { route: '/software/store/progress', surface: 'xpanel' },
  { route: '/software/store/installed', surface: 'xpanel' },
  { route: '/software/store/updates', surface: 'xpanel' },
  { route: '/software/store/error', surface: 'xpanel' },
  { route: '/whm/software/store', surface: 'xwhm' },
  { route: '/whm/software/store/extensions', surface: 'xwhm' },
  { route: '/whm/software/store/activity', surface: 'xwhm' },
]
const accountRoutes = [
  '/email/forwarders', '/email/deliverability', '/email/filters', '/email/spam-filters',
  '/email/spam-quarantine', '/email/mailing-lists', '/email/archive', '/email/encryption',
  '/email/calendars-contacts', '/preferences', '/preferences/language', '/preferences/users',
  '/preferences/team', '/health',
]
const routes = [
  { route: '/email/accounts', surface: 'xpanel', family: 'email' },
  ...accountRoutes.map(route => ({ route, surface: 'xpanel', family: 'account' })),
  ...storeRouteSpecs.map(spec => ({ ...spec, family: 'store' })),
  { route: '/software/installer', surface: 'xpanel', family: 'store' },
  { route: '/whm/software/site-software', surface: 'xwhm', family: 'store' },
  { route: '/resources', surface: 'xpanel', family: 'resources' },
]
assert.equal(routes.length, 28, 'The extension route matrix must remain explicit')
assert.equal(new Set(routes.map(spec => spec.route)).size, 28)

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
}

const sourceMetadata = ['.node-version', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'docs/STANDARDS.md']
const packageRoots = { '@xpanel/core': 'packages/core', '@xpanel/catalog': 'packages/catalog', '@xpanel/render': 'packages/render', '@xpanel/web': 'apps/web' }

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
    // Pages load their client runtime from /assets; serve the product's own immutable assets.
    const asset = serveStaticAsset(url.pathname)
    if (asset) { response.writeHead(asset.status, Object.fromEntries(asset.headers)); asset.arrayBuffer().then(body => response.end(Buffer.from(body))); return }
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
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...documentSecurityHeaders(html) }); response.end(html)
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => { server.closeIdleConnections(); server.close(done) }) }
}

async function measure(page, selector) {
  return page.evaluate(selector => {
    const parent = document.querySelector(selector)
    const rtl = document.documentElement.dir === 'rtl'
    const visible = element => element.checkVisibility() && !element.closest('[hidden],[inert]') && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0
    const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
    const glyph = element => { const range = document.createRange(); range.selectNodeContents(element); return rect(range) }
    const edge = bounds => rtl ? bounds.right : bounds.left
    const children = element => [...element.children].filter(visible)
    const verticalGaps = element => { const list = children(element); return list.slice(1).map((element, index) => rect(element).top - rect(list[index]).bottom) }
    const fields = [...parent.querySelectorAll('.v2-field, .v2-panel-settings__field, .v2-panel-extra__field, .v2-whm-data__field')].filter(visible).flatMap(row => {
      const label = row.querySelector('label[for]'), control = label && document.getElementById(label.htmlFor)
      if (!control || !visible(control) || (control instanceof HTMLInputElement && ['checkbox', 'radio', 'file'].includes(control.type))) return []
      const l = rect(label), c = rect(control), style = getComputedStyle(control), lg = glyph(label)
      const paintedEdge = rtl ? c.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight) : c.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
      return [{ id: control.id, tag: control.tagName, type: control.getAttribute('type'), gap: c.top - lg.bottom, label_bounds: l, control_bounds: c, label_glyph_edge: edge(lg), painted_edge: paintedEdge, painted_edge_delta: Math.abs(edge(lg) - paintedEdge), direction: style.direction, text_align: style.textAlign, font_family: style.fontFamily, font_size: style.fontSize, line_height: style.lineHeight }]
    })
    const cards = [...parent.querySelectorAll('.v2-card:not(.v2-card--flush)')].filter(visible).map(card => {
      const style = getComputedStyle(card), box = rect(card), first = rect(children(card)[0])
      return { bounds: box, padding: { inline_start: style.paddingInlineStart, inline_end: style.paddingInlineEnd, block_start: style.paddingBlockStart, block_end: style.paddingBlockEnd }, actual_content_top: first.top - box.top - parseFloat(style.borderTopWidth) }
    })
    const targets = [...parent.querySelectorAll('a[href],button,input:not([type="hidden"]),select,textarea,summary')].filter(visible).map(element => {
      const labels = element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? [...(element.labels ?? []), element.closest('label')].filter(Boolean).filter(visible) : []
      const label = labels.find(candidate => { const box = candidate.getBoundingClientRect(); return box.width >= 43.5 && box.height >= 43.5 }) ?? labels[0]
      return { tag: element.tagName, text: element.textContent.trim(), disabled: element.disabled === true, bounds: rect(element), ...(label ? { label_bounds: rect(label) } : {}) }
    })
    const human = [...parent.querySelectorAll('h1,h2,p')].filter(element => visible(element) && element.textContent.trim() && !element.closest('bdi,.v2-mono,code') && !element.querySelector('bdi,.v2-mono,code')).slice(0, 6).map((element, index) => {
      const key = `font-${index}`; element.setAttribute('data-extension-font-probe', key)
      return { selector: `[data-extension-font-probe="${key}"]`, text: element.textContent.trim(), tag: element.tagName }
    })
    return {
      headings: [...parent.querySelectorAll('h1')].filter(visible).length,
      page: rect(parent), document_width: document.documentElement.clientWidth, document_scroll: document.documentElement.scrollWidth,
      region_width: parent.clientWidth, region_scroll: parent.scrollWidth, major_gaps: verticalGaps(parent), cards, fields, targets, human,
      ascii_digits: !/[\u0660-\u0669\u06f0-\u06f9]/.test(parent.textContent),
      check_states: [...parent.querySelectorAll('[data-check-state],[data-mail-card-status]')].map(element => element.dataset.checkState ?? element.dataset.state),
      installer_states: [...parent.querySelectorAll('[data-installer-state]')].map(element => element.dataset.installerState),
      installer_progress: [...parent.querySelectorAll('[data-installer-progress]')].map(element => element.dataset.installerProgress),
      buttons: [...parent.querySelectorAll('button')].filter(visible).map(element => ({ disabled: element.disabled, type: element.type, read_only: [element.dataset.siteSoftwareAction, element.dataset.siteInstancesAction].includes('refresh') })),
      view_links: [...parent.querySelectorAll('nav a[data-nav-route]')].map(element => ({ route: element.dataset.navRoute, href: element.getAttribute('href'), current: element.getAttribute('aria-current') })),
      resource_state: parent.dataset.resourceReading ?? parent.querySelector('[data-resource-reading]')?.dataset.resourceReading ?? null,
      slice_identity: parent.textContent.includes('xpanel-20001.slice'),
      resource_rows: [...parent.querySelectorAll('tr[data-resource-state]')].map(row => row.dataset.resourceState),
    }
  }, selector)
}

const near = (value, expected, message) => assert.ok(Number.isFinite(value) && Math.abs(value - expected) < 0.8, `${message}: expected ${expected}, observed ${value}`)

function validateGeometry(observation, spec, width, locale, theme) {
  assert.equal(observation.headings, 1, 'One visible page h1')
  assert.ok(observation.document_scroll <= observation.document_width + 1, 'No document overflow')
  assert.ok(observation.region_scroll <= observation.region_width + 1, 'No clipped page overflow')
  assert.ok(observation.page.left >= -0.5 && observation.page.right <= width + 0.5, 'Page remains within viewport')
  assert.equal(observation.ascii_digits, true, 'Displayed digits remain ASCII')
  assert.ok(observation.cards.length + observation.fields.length > 0, 'Workspace renders actual structured content')
  for (const card of observation.cards) {
    const expectedPadding = width <= 600 ? 16 : 24
    for (const padding of Object.values(card.padding)) assert.equal(padding, `${expectedPadding}px`)
    near(card.actual_content_top, expectedPadding, 'Actual card content top padding')
  }
  for (const field of observation.fields) {
    near(field.gap, 8, 'Native field label/control gap: ' + field.id)
    assert.ok(field.painted_edge_delta < 1, 'Label glyphs align with native painted text edge: ' + field.id)
    assert.ok(parseFloat(field.font_size) >= (width <= 959 ? 16 : 14), 'Native input type size: ' + field.id)
  }
  for (const target of observation.targets) {
    const hit = target.label_bounds && (target.bounds.width < 43.5 || target.bounds.height < 43.5) ? target.label_bounds : target.bounds
    assert.ok(hit.width >= 43.5 && hit.height >= 43.5, `Interactive targets are at least 44px (${target.tag}: ${target.text})`)
  }
  if (spec.family === 'store') {
    assert.deepEqual(observation.installer_states, ['unavailable'])
    assert.ok(observation.installer_progress.every(state => state === 'unread'))
    assert.ok(observation.buttons.every(button => (button.disabled || button.read_only) && button.type === 'button'), 'Only a read stays enabled before anything was read')
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
  // This fixture answers every API read with 404, so both cards must report the refused read and show no result.
  if (spec.route === '/email/deliverability') assert.deepEqual(observation.check_states, ['failed', 'failed'], 'Neither mail card claims a read')
  if (spec.family === 'resources') {
    assert.equal(observation.slice_identity, true, 'Account slice identity remains present')
    assert.equal(observation.resource_state, 'unread', 'No usage read was injected')
    assert.equal(observation.resource_rows.length, 12)
    assert.ok(observation.resource_rows.includes('unmeasured') && observation.resource_rows.includes('unread'))
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
      const cspViolations = []
      await recordCspViolations(page, cspViolations)
      await page.route('**/*', route => {
        const url = new URL(route.request().url())
        if (url.origin === host.baseUrl) return route.continue()
        failures.push({ type: 'unexpected_external_request', origin: url.origin, path: url.pathname }); return route.abort()
      })
      for (const spec of selected) {
        requireBrowserDiskHeadroom(root, 256, destination)
        const result = { route: spec.route, surface: spec.surface, family: spec.family, locale, width, theme, synthetic_presentation_only: true }
        const cspBefore = cspViolations.length
        try {
          const response = await page.goto(host.baseUrl + spec.route + '?lang=' + locale + '&theme=' + theme, { waitUntil: 'networkidle' })
          assert.equal(response.status(), 200)
          const selector = 'main#main-content .v2-page > :first-child'
          assert.equal(await page.locator(selector).count(), 1, 'Actual v2 workspace root occurs once')
          await page.locator(selector).waitFor({ state: 'visible' })
          await page.evaluate(() => document.fonts.ready)
          assert.equal(await page.locator('html').getAttribute('data-extensions-fixture'), 'synthetic-qualified-presentation')
          result.geometry = await measure(page, selector)
          validateGeometry(result.geometry, spec, width, locale, theme)
          result.applied_fonts = []
          for (const human of result.geometry.human) {
            const font = await assertAppliedFont(page, human.selector, locale === 'ar' ? 'sans-serif' : 'IBM Plex Sans')
            result.applied_fonts.push(font)
          }
          assert.ok(result.applied_fonts.length > 0, 'Actual human glyph fonts must be observed')
          await injectTestScript(page, axeSource)
          result.accessibility = await page.evaluate(async () => {
            const checks = list => list.map(check => ({ id: check.id, impact: check.impact, message: check.message, data: check.data, related_nodes: (check.relatedNodes ?? []).map(node => ({ target: node.target, html: node.html })) }))
            return (await axe.run('main#main-content', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } })).violations.map(violation => ({ id: violation.id, impact: violation.impact, help: violation.help, targets: violation.nodes.map(node => node.target), nodes: violation.nodes.map(node => ({ target: node.target, html: node.html, any: checks(node.any), all: checks(node.all), none: checks(node.none) })) }))
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
          assert.deepEqual(cspViolations.slice(cspBefore), [], 'No Content-Security-Policy violation')
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
