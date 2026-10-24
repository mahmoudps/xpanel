import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSnapshotFiles, computeSourceDigest, EXCLUDED_NAMES } from '../../scripts/vm/source-snapshot.mjs'
import { createVisualFixture } from './visual-fixture.mjs'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const matrix = [
  ['login-en-desktop', '/login', 'en', 'light', 1440], ['login-ar-phone', '/login', 'ar', 'dark', 360],
  ['whm-en-desktop-light', '/whm', 'en', 'light', 1440, true], ['whm-en-desktop-dark', '/whm', 'en', 'dark', 1440],
  ['accounts-ar-tablet', '/whm/accounts', 'ar', 'light', 768, true], ['accounts-en-phone', '/whm/accounts', 'en', 'dark', 360],
  ['create-en-tablet', '/whm/accounts/new', 'en', 'light', 768], ['create-ar-phone', '/whm/accounts/new', 'ar', 'light', 360],
  ['home-ar-phone', '/home', 'ar', 'light', 360, true], ['home-ar-tablet', '/home', 'ar', 'dark', 768],
  ['domains-ar-desktop', '/domains', 'ar', 'dark', 1440], ['domains-en-tablet', '/domains', 'en', 'light', 768],
  ['files-en-desktop', '/files/manager', 'en', 'light', 1440], ['files-ar-phone', '/files/manager', 'ar', 'dark', 360],
  ['inbox-ar-tablet', '/mail/inbox', 'ar', 'light', 768], ['inbox-en-desktop', '/mail/inbox', 'en', 'dark', 1440],
  ['compose-en-tablet', '/mail/compose', 'en', 'light', 768], ['compose-ar-phone', '/mail/compose', 'ar', 'dark', 360],
].map(([id, path, locale, theme, width, interactions = false]) => ({ id, path, locale, theme, width, height: width === 1440 ? 900 : width === 768 ? 1024 : 800, interactions }))
const screenMarkers = {
  '/login': '[data-login-form]', '/whm': '[data-section="overview-attention"]',
  '/whm/accounts': '[data-section="accounts-isolation"]', '/whm/accounts/new': '[data-create-account-form]',
  '/home': '[data-board-port="xpanel-home"]', '/domains': '[data-domains-table]',
  '/files/manager': '[data-file-manager-table]', '/mail/inbox': '[data-mail-pane="message-list"]', '/mail/compose': '[data-compose-form]',
}
const focusSelector = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),details > summary:first-of-type,[tabindex]'
const shortUrl = value => { try { const url = new URL(value); return `${url.origin}${url.pathname}` } catch { return String(value).slice(0, 160) } }
const isFontUrl = value => /fonts\.(?:googleapis|gstatic)\.com/.test(value)

function fingerprint(output, phase) {
  const paths = new Set(collectSnapshotFiles(root))
  const excluded = new Set([...EXCLUDED_NAMES, '.pnpm-store'])
  function collect(relative) {
    const directory = resolve(root, relative)
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name) || entry.name.startsWith('.env') || /\.(?:pem|key|log)$/i.test(entry.name)) continue
      const path = `${relative}/${entry.name}`
      if (entry.isDirectory()) collect(path)
      else if (entry.isFile()) paths.add(path)
    }
  }
  for (const directory of ['tests', 'deploy', 'docs/planning', 'docs/operations', 'docs/decisions']) collect(directory)
  const files = [...paths].sort().map(path => {
    const bytes = readFileSync(resolve(root, path))
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  const result = { schema_version: 1, phase, captured_at: new Date().toISOString(), source_sha256: computeSourceDigest(files), file_count: files.length,
    scope: 'Existing explicit source collector plus tests, deploy, docs/planning, docs/operations and docs/decisions. Secrets, symlinks, caches, dependencies, reports and docs/execution evidence excluded.', files }
  writeFileSync(join(output, `source-${phase}.json`), `${JSON.stringify(result, null, 2)}\n`)
  return result
}

async function waitForFonts(page) {
  return page.evaluate(async () => {
    let ready = false
    await Promise.race([document.fonts.ready.then(() => { ready = true }), new Promise(resolve => setTimeout(resolve, 5000))])
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const faces = [...document.fonts].map(face => ({ family: face.family, status: face.status }))
    return { ready_within_5s: ready, status: document.fonts.status, body_family: getComputedStyle(document.body).fontFamily,
      declared_face_count: faces.length, loaded_faces: faces.filter(face => face.status === 'loaded'), failed_faces: faces.filter(face => face.status === 'error'), faces }
  })
}

async function geometry(page) {
  return page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && !element.closest('[hidden],[inert]')
    }
    const targets = [...document.querySelectorAll('button,a.xp-btn,a.xp-nav-item,a[data-nav-route],a[data-theme-toggle],a[data-lang-switch],[data-tool] a[href],a[data-usage-link],summary,input:not([type="hidden"]),select,textarea')]
      .filter(visible).map(element => {
        const rect = element.getBoundingClientRect()
        return { tag: element.tagName, id: element.id || null, action: element.getAttribute('data-action'), width: rect.width, height: rect.height }
      })
    const fields = [...document.querySelectorAll('label[for],.xp-form-group > .xp-label')].filter(label => !label.classList.contains('xp-sr-only') && !/^rect\(\s*0px(?:,\s*0px){3}\s*\)$/.test(getComputedStyle(label).clip) && visible(label)).flatMap(label => {
      const value = label.htmlFor ? document.getElementById(label.htmlFor) : label.nextElementSibling
      if (!value || !visible(value)) return []
      const range = document.createRange(); range.selectNodeContents(label)
      const labelRect = range.getBoundingClientRect(), box = value.getBoundingClientRect(), style = getComputedStyle(value)
      const isControl = /^(INPUT|SELECT|TEXTAREA)$/.test(value.tagName)
      const isBadge = value.classList.contains('xp-badge')
      const valueRange = document.createRange(); valueRange.selectNodeContents(value)
      const valueRect = isControl ? { left: box.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth), right: box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) } : isBadge ? box : valueRange.getBoundingClientRect()
      return [{ id: value.id || null, tag: value.tagName, right_delta: Math.abs(labelRect.right - valueRect.right), left_delta: Math.abs(labelRect.left - valueRect.left),
        label_bottom: labelRect.bottom, value_top: box.top, direction: style.direction, text_align: style.textAlign, explicit_ltr: value.getAttribute('dir') === 'ltr', control: isControl, value_kind: isBadge ? 'badge_outer_box' : isControl ? 'control_outer_box' : 'plain_value_text' }]
    })
    const phone = [...document.querySelectorAll('[data-home-phone]')].find(visible)
    const board = [...document.querySelectorAll('[data-home-desktop],[data-board-port="xwhm-dashboard"],[data-board-port="xmail-inbox"],[data-board-port="xmail-compose"]')].find(visible)
    const sidebar = phone ? phone.querySelector('#m-drawer') : board?.querySelector('[data-xp-sidebar]') ?? document.querySelector('[data-xp-sidebar]')
    const header = phone?.querySelector(':scope > header') ?? board?.querySelector(':scope > header') ?? board?.querySelector('main > header') ?? document.querySelector('.xp-topbar')
    const navigationMode = phone ? 'home-drawer' : board ? 'inline' : 'shared'
    const rect = element => { const r = element?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height } : null }
    const bdis = [...document.querySelectorAll('bdi[dir="ltr"]')].filter(visible)
    return { viewport: innerWidth, scroll_width: document.documentElement.scrollWidth, dir: document.documentElement.dir,
      eastern_digits: /[\u0660-\u0669\u06f0-\u06f9]/.test(document.body.innerText), targets, fields,
      target_violations: targets.filter(target => target.width < 43.5 || target.height < 43.5),
      navigation_mode: navigationMode, header: rect(header), sidebar: rect(sidebar), sidebar_visibility: sidebar ? getComputedStyle(sidebar).visibility : null,
      bdi_count: bdis.length, bdi_all_ltr_isolated: bdis.every(element => getComputedStyle(element).direction === 'ltr' && getComputedStyle(element).unicodeBidi.includes('isolate')) }
  })
}

async function assertFocusLoop(page, container) {
  const endpoints = await container.evaluate((element, selector) => {
    const targets = [...element.querySelectorAll(selector)].filter(target => target.tabIndex >= 0 && target.checkVisibility() && getComputedStyle(target).visibility === 'visible' && !target.closest('[hidden],[inert]'))
    if (targets.length === 0) return { count: 0 }
    targets.at(-1).focus()
    return { count: targets.length, summaries: targets.filter(target => target.tagName === 'SUMMARY').length, last_focused: document.activeElement === targets.at(-1) }
  }, focusSelector)
  assert.ok(endpoints.count > 1, 'Overlay must contain keyboard destinations')
  assert.equal(endpoints.last_focused, true, 'The selected visible final overlay destination must accept focus')
  await page.keyboard.press('Tab')
  assert.equal(await container.evaluate((element, selector) => {
    const targets = [...element.querySelectorAll(selector)].filter(target => target.tabIndex >= 0 && target.checkVisibility() && getComputedStyle(target).visibility === 'visible' && !target.closest('[hidden],[inert]'))
    return document.activeElement === targets[0]
  }, focusSelector), true, 'Tab must wrap from last to first overlay destination')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await container.evaluate((element, selector) => {
    const targets = [...element.querySelectorAll(selector)].filter(target => target.tabIndex >= 0 && target.checkVisibility() && getComputedStyle(target).visibility === 'visible' && !target.closest('[hidden],[inert]'))
    return document.activeElement === targets.at(-1)
  }, focusSelector), true, 'Shift+Tab must wrap to the final overlay destination')
  return endpoints
}

function assertContext(href, state, base, { locale = state.locale, theme = state.theme } = {}) {
  const url = new URL(href, base)
  assert.equal(url.searchParams.get('lang'), locale, 'Navigation locale must be preserved')
  assert.equal(url.searchParams.get('theme'), theme, 'Navigation theme must be preserved')
  assert.equal(url.searchParams.get('density'), 'compact', 'Navigation density must be preserved')
  assert.equal(url.searchParams.get('accountId'), 'visual-account', 'Navigation account context must be preserved')
  return url
}

async function interactions(page, state, base, expect, observations, breadcrumb) {
  const home = state.path === '/home'
  const mobile = home ? state.width <= 800 : state.width < 960
  const toolbar = page.locator('[data-xp-toolbar-options]'), summary = toolbar.locator(':scope > summary')
  const hasToolbar = await toolbar.count() > 0
  const prepareToolbar = async () => {
    if (hasToolbar && !await toolbar.evaluate(element => element.open)) await summary.click()
  }
  const original = page.url()
  if (mobile) {
    breadcrumb('mobile_navigation_open')
    const toggle = page.locator(home ? '#xpanel-home-menu' : '[data-action="toggle-mobile-nav"]')
    await toggle.click()
    const sidebar = page.locator(home ? '#m-drawer' : '[data-xp-sidebar]')
    const background = page.locator(home ? '[data-home-phone] > main' : '[data-xp-shell-content]')
    await expect(sidebar).toHaveAttribute('role', 'dialog')
    await expect(sidebar).toHaveAttribute('aria-modal', 'true')
    assert.equal(await background.evaluate(element => element.inert), true, 'Background must be inert')
    if (home) assert.equal(await page.locator('[data-home-phone] > header').evaluate(element => element.inert), true)
    assert.equal(await sidebar.evaluate(element => element.contains(document.activeElement)), true, 'Opening navigation must move focus inside')
    const details = sidebar.locator('details')
    if (await details.count()) {
      breadcrumb('native_navigation_summary')
      const foldedIndex = await details.evaluateAll(elements => elements.findIndex(element => !element.open))
      assert.ok(foldedIndex >= 0, 'Native accordion navigation must expose a closed group')
      const folded = details.nth(foldedIndex)
      await folded.locator(':scope > summary').click()
      assert.equal(await folded.evaluate(element => element.open), true)
      await page.keyboard.press('Tab')
      assert.equal(await folded.evaluate(element => element.contains(document.activeElement) && document.activeElement.tagName === 'A'), true, 'Native summary must lead to its link with Tab')
    } else {
      breadcrumb('flat_navigation_links')
      assert.ok(await sidebar.locator('a[data-nav-route]').count() > 1, 'Flat navigation must expose real route destinations')
      if (!home) assert.ok(await sidebar.locator('.xp-nav-group').count() > 0, 'The current shared navigation must retain its labeled flat groups')
    }
    breadcrumb('mobile_navigation_tab_wrap')
    const loop = await assertFocusLoop(page, sidebar)
    if (await details.count()) assert.ok(loop.summaries > 0, 'Native summaries must participate in the focus loop')
    await expect.poll(async () => {
      const panelRect = await sidebar.boundingBox()
      return Math.abs(state.locale === 'ar' ? panelRect.x + panelRect.width - state.width : panelRect.x)
    }, { timeout: 2000, message: 'The settled sheet must open from logical start' }).toBeLessThanOrEqual(1.5)
    const panelRect = await sidebar.boundingBox()
    assert.ok(panelRect.width <= state.width - 16, 'Sheet must fit within the viewport')
    breadcrumb('mobile_navigation_escape_focus_return')
    await page.keyboard.press('Escape')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeFocused()
    assert.equal(await background.evaluate(element => element.inert), false)
    if (home) assert.equal(await page.locator('[data-home-phone] > header').evaluate(element => element.inert), false)
    observations.push({ step: 'mobile_navigation_modality', focus_destinations: loop.count, native_summaries: loop.summaries, tab_wrap: true, shift_tab_wrap: true, escape_focus_return: true })
    if (hasToolbar) {
      breadcrumb('toolbar_disclosure_toggle_escape')
      await prepareToolbar()
      await summary.focus()
      await page.keyboard.press('Escape')
      assert.equal(await toolbar.evaluate(element => element.open), false)
      await expect(summary).toBeFocused()
    }
    if (home) {
      breadcrumb('home_tool_accordion_and_filter')
      const phone = page.locator('[data-home-phone]')
      const closed = phone.locator('button[data-home-action="toggle-group"][aria-expanded="false"]').first()
      await expect(closed).toHaveCount(1)
      const panelId = await closed.getAttribute('aria-controls')
      const group = phone.locator(`button[data-home-action="toggle-group"][aria-controls="${panelId}"]`)
      const panel = page.locator(`#${panelId}`)
      await group.click()
      await expect(group).toHaveAttribute('aria-expanded', 'true')
      await expect(panel).toBeVisible()
      await page.keyboard.press('Tab')
      assert.equal(await panel.evaluate(element => element.contains(document.activeElement) && document.activeElement.tagName === 'A'), true, 'Expanded tool group must expose its first real destination to Tab')
      const count = await phone.locator('[data-tool] a:visible').count()
      assert.ok(count > 0)
      await phone.locator('#m-filter').fill('no-matching-tool-query-xyz')
      await expect(phone.locator('[data-tool] a:visible')).toHaveCount(0)
      await phone.locator('#m-filter').fill('')
      await expect(phone.locator('[data-tool] a:visible')).toHaveCount(count)
      observations.push({ step: 'home_tool_accordion_and_filter', real_destinations: count, button_aria_controls: true, zero_results: true, clear_restores_groups: true })
    }
  }
  await prepareToolbar()
  const trigger = page.locator('[data-action="open-cmdk"]:visible').first()
  breadcrumb('palette_open')
  await trigger.click()
  const palette = page.locator('[data-xp-cmdk]')
  await expect(palette).toBeVisible()
  await expect(page.locator('#xp-cmdk-input')).toBeFocused()
  breadcrumb('palette_tab_wrap')
  const paletteLoop = await assertFocusLoop(page, palette)
  const links = await palette.locator('a[data-cmdk-item]').evaluateAll(elements => elements.map(element => ({ href: element.getAttribute('href'), route: element.getAttribute('data-cmdk-item') })))
  assert.ok(links.length > 1)
  breadcrumb('palette_link_context')
  for (const link of links) assertContext(link.href, state, base)
  breadcrumb('palette_escape_focus_return')
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  await expect(hasToolbar && mobile ? summary : trigger).toBeFocused()
  observations.push({ step: 'palette_modality_and_context', destinations: links.length, focus_destinations: paletteLoop.count, tab_wrap: true, shift_tab_wrap: true, escape_focus_return: true })
  await prepareToolbar()
  breadcrumb('language_theme_link_context')
  const language = page.locator('[data-lang-switch]:visible').first(), nextLocale = state.locale === 'ar' ? 'en' : 'ar'
  assert.equal(assertContext(await language.getAttribute('href'), state, base, { locale: nextLocale }).pathname, state.path)
  const theme = page.locator('[data-theme-toggle]:visible').first()
  assert.equal(assertContext(await theme.getAttribute('href'), state, base, { theme: state.theme === 'dark' ? 'light' : 'dark' }).pathname, state.path)
  breadcrumb('language_reload_back')
  await language.click()
  await page.waitForURL(url => url.pathname === state.path && url.searchParams.get('lang') === nextLocale)
  await expect(page.locator('html')).toHaveAttribute('lang', nextLocale)
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('lang', state.locale)
  await page.reload({ waitUntil: 'domcontentloaded' })
  assert.equal(page.url(), original, 'Deep link and context must survive reload and Back')
  const destination = links.find(link => link.route !== state.path)
  breadcrumb('palette_destination_reload_back')
  await prepareToolbar()
  await page.locator('[data-action="open-cmdk"]:visible').first().click()
  await page.locator(`[data-cmdk-item="${destination.route}"]`).click()
  await page.waitForURL(url => url.pathname === destination.route)
  assertContext(page.url(), state, base)
  await page.reload({ waitUntil: 'domcontentloaded' })
  assertContext(page.url(), state, base)
  await page.goBack({ waitUntil: 'domcontentloaded' })
  assertContext(page.url(), state, base)
  observations.push({ step: 'language_link_palette_navigation_reload_back', language_changed: true, destination: destination.route, context_preserved: true })
}

export async function runPhase1Acceptance({ output } = {}) {
  if (process.versions.node !== readFileSync(join(root, '.node-version'), 'utf8').trim()) throw new Error('Use the pinned workspace launcher.')
  const destination = resolve(output ?? process.env.XPANEL_PHASE1_OUTPUT ?? join(root, 'test-results/phase1-ui', `run-${new Date().toISOString().replace(/[-:.]/g, '')}`))
  if (existsSync(destination)) throw new Error('Refusing to overwrite browser acceptance evidence.')
  mkdirSync(join(destination, 'screenshots'), { recursive: true })
  const before = fingerprint(destination, 'before')
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(root, '.tools/playwright-browsers')
  const { chromium, expect } = await import('@playwright/test')
  const fixture = await createVisualFixture()
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), timeout: 20000 })
  const outcomes = [], started = Date.now()
  try {
    for (const state of matrix) {
      const outcome = { ...state, status: 'running', observations: [], breadcrumbs: ['load'], page_errors: [], console_errors: [], failed_requests: [], error_responses: [], font_responses: [], mutations: [], websockets: [] }
      const context = await browser.newContext({ viewport: { width: state.width, height: state.height }, colorScheme: state.theme })
      const page = await context.newPage()
      page.setDefaultTimeout(8000)
      page.setDefaultNavigationTimeout(15000)
      let step = 'load'
      const breadcrumb = value => { step = value; outcome.breadcrumbs.push(value) }
      await context.route('**/*', async route => {
        if (!['GET', 'HEAD'].includes(route.request().method())) { outcome.mutations.push({ method: route.request().method(), url: shortUrl(route.request().url()) }); await route.abort(); return }
        await route.continue()
      })
      page.on('pageerror', error => outcome.page_errors.push({ name: error.name, message: error.message.slice(0, 200) }))
      page.on('console', message => { if (message.type() === 'error') outcome.console_errors.push({ text: message.text().slice(0, 200), url: shortUrl(message.location().url) }) })
      page.on('requestfailed', request => outcome.failed_requests.push({ url: shortUrl(request.url()), error: request.failure()?.errorText }))
      page.on('response', response => { if (response.status() >= 400) outcome.error_responses.push({ url: shortUrl(response.url()), status: response.status() }); if (isFontUrl(response.url())) outcome.font_responses.push({ url: shortUrl(response.url()), status: response.status() }) })
      page.on('websocket', socket => outcome.websockets.push(shortUrl(socket.url())))
      try {
        const url = new URL(state.path, fixture.baseUrl)
        for (const [key, value] of Object.entries({ lang: state.locale, theme: state.theme, density: 'compact', accountId: 'visual-account' })) url.searchParams.set(key, value)
        const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' })
        assert.equal(response.status(), 200)
        await expect(page.locator('html')).toHaveAttribute('data-visual-fixture', 'synthetic')
        await expect(page.locator('[data-visual-fixture-watermark]')).toBeVisible()
        await expect(page.locator('html')).toHaveAttribute('lang', state.locale)
        await expect(page.locator('html')).toHaveAttribute('data-theme', state.theme)
        await expect(page.locator(screenMarkers[state.path])).toBeVisible()
        outcome.fonts = await waitForFonts(page)
        outcome.geometry = await geometry(page)
        outcome.screenshot = `screenshots/${state.id}.png`
        await page.screenshot({ path: join(destination, outcome.screenshot), fullPage: true, timeout: 15000 })
        breadcrumb('geometry')
        const metrics = outcome.geometry
        assert.ok(metrics.scroll_width <= metrics.viewport + 1, 'Document must have no horizontal overflow')
        assert.equal(metrics.eastern_digits, false, 'Visible digits must be ASCII')
        assert.equal(metrics.target_violations.length, 0, 'Primary controls/navigation/summaries must be at least 44px in each dimension')
        assert.ok(metrics.bdi_count + metrics.fields.filter(field => field.explicit_ltr).length > 0, 'Isolation must observe actual technical bdi tokens or explicit LTR form controls')
        assert.equal(metrics.bdi_all_ltr_isolated, true)
        assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1, 'Each document must expose one accessible task heading')
        if (state.locale === 'ar') {
          assert.equal(metrics.dir, 'rtl')
          for (const field of metrics.fields) {
            assert.ok(field.right_delta <= 1, `RTL label/value edges differ for ${field.id ?? field.tag}`)
            assert.ok(field.value_top >= field.label_bottom - 1, `Value must be below its label for ${field.id ?? field.tag}`)
            if (field.explicit_ltr) { assert.equal(field.direction, 'ltr'); assert.equal(field.text_align, 'right') }
          }
        }
        if (state.path !== '/login') {
          const expectedNavigation = state.path === '/home' ? (state.width <= 800 ? 'home-drawer' : 'inline') : ['/whm', '/mail/inbox', '/mail/compose'].includes(state.path) ? 'inline' : 'shared'
          assert.equal(metrics.navigation_mode, expectedNavigation, 'Each route must expose its expected current navigation primitive')
          await expect(page.locator('html')).toHaveAttribute('data-realtime-enabled', 'false')
          assert.ok(await page.locator('[data-ws-indicator="unavailable"]').count(), 'Synthetic transport must say unavailable')
          if (metrics.navigation_mode === 'home-drawer') {
            assert.ok(Math.abs(metrics.header.height - 64) <= 1, 'Home phone header must be 64px')
            await expect(page.locator('#xpanel-home-menu')).toBeVisible()
            await expect(page.locator('#xpanel-home-menu')).toHaveAttribute('aria-expanded', 'false')
            await expect(page.locator('#m-drawer')).toBeHidden()
          } else if (metrics.navigation_mode === 'shared' && state.width < 960) {
            assert.ok(Math.abs(metrics.header.height - 64) <= 1, 'Shared mobile/tablet header must be 64px')
            assert.equal(metrics.sidebar_visibility, 'hidden', 'Shared mobile navigation must begin offcanvas')
            await expect(page.locator('[data-action="toggle-mobile-nav"]')).toBeVisible()
          } else {
            assert.ok(metrics.header && metrics.header.width <= state.width + 1 && metrics.header.height >= 44, 'The actual header must remain usable within the viewport')
            assert.ok(metrics.sidebar && metrics.sidebar.width <= state.width + 1, 'The actual navigation must fit the viewport')
            if (state.width >= 960) {
              const expectedRail = state.path.startsWith('/mail/') ? 200 : 248
              assert.ok(Math.abs(metrics.sidebar.width - expectedRail) <= 1, `Desktop rail must be ${expectedRail}px for the current surface`)
            }
          }
        }
        breadcrumb('interactions')
        if (state.interactions) await interactions(page, state, fixture.baseUrl, expect, outcome.observations, breadcrumb)
        outcome.console_error_classification = {
          external_fonts: outcome.console_errors.filter(error => isFontUrl(error.url) || isFontUrl(error.text)),
          fixture_auth_lookup: outcome.console_errors.filter(error => /\/api\/auth\/me$/.test(error.url)),
          unexpected_application: outcome.console_errors.filter(error => !isFontUrl(error.url) && !isFontUrl(error.text) && !/\/api\/auth\/me$/.test(error.url)),
        }
        assert.deepEqual(outcome.console_error_classification.unexpected_application, [], 'No unexpected application console errors')
        assert.deepEqual(outcome.page_errors, [], 'No JavaScript page exceptions')
        assert.deepEqual(outcome.mutations, [], 'Visual acceptance must not submit mutations')
        assert.deepEqual(outcome.websockets, [], 'Disabled synthetic transport must not connect')
        outcome.status = 'passed'
      } catch (error) {
        outcome.status = 'failed'
        const primitive = value => ['string', 'number', 'boolean'].includes(typeof value) ? String(value).slice(0, 160) : undefined
        outcome.failure = { step, name: error.name, message: String(error.message).split('\n')[0].slice(0, 240), actual: primitive(error.actual), expected: primitive(error.expected), stack: String(error.stack ?? '').split('\n').slice(0, 12) }
      } finally { await context.close(); outcomes.push(outcome); process.stdout.write(`${JSON.stringify({ id: state.id, status: outcome.status, ...(outcome.failure ? { failure: outcome.failure } : {}) })}\n`) }
    }
  } finally { await browser.close(); await fixture.close() }
  const after = fingerprint(destination, 'after')
  const beforeMap = new Map(before.files.map(file => [file.path, file.sha256])), afterMap = new Map(after.files.map(file => [file.path, file.sha256]))
  const drift = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort().filter(path => beforeMap.get(path) !== afterMap.get(path))
  const fontSummary = { observed_states: outcomes.filter(outcome => outcome.fonts).length, ready_states: outcomes.filter(outcome => outcome.fonts?.ready_within_5s).length,
    states_with_loaded_faces: outcomes.filter(outcome => outcome.fonts?.loaded_faces.length > 0).length,
    loaded_families: [...new Set(outcomes.flatMap(outcome => outcome.fonts?.loaded_faces.map(face => face.family) ?? []))],
    failed_font_requests: outcomes.flatMap(outcome => outcome.failed_requests.filter(request => isFontUrl(request.url))),
    failed_font_faces: outcomes.flatMap(outcome => outcome.fonts?.failed_faces ?? []) }
  const report = { schema_version: 1, captured_at: new Date().toISOString(), status: outcomes.every(outcome => outcome.status === 'passed') && drift.length === 0 ? 'passed' : 'failed', runtime: process.version, browser: { name: 'isolated project Chromium', version: browser.version(), headless: true },
    fixture: { synthetic: true, loopback_only: true, catalog: 'Private test-only qualification override; no production promotion or API authentication bypass.', mutation_attempts: outcomes.reduce((sum, outcome) => sum + outcome.mutations.length, 0), mutations_submitted: 0, real_host_actions: 0 },
    scope: '18 balanced states: 6 at each width 360/768/1440, 9 EN and 9 AR; light/dark sampled. All 9 promised routes are represented. This is not all route/locale/theme/viewport combinations. Keyboard/history interactions are sampled on 3 named states.',
    tests: { total: outcomes.length, passed: outcomes.filter(outcome => outcome.status === 'passed').length, failed: outcomes.filter(outcome => outcome.status === 'failed').length }, duration_ms: Date.now() - started,
    fonts: fontSummary,
    source: { before: 'source-before.json', after: 'source-after.json', before_sha256: before.source_sha256, after_sha256: after.source_sha256, file_count: before.file_count, drift },
    limits: ['Synthetic read-only visual fixture; no credential submission, real API workflow, host commands, live hosting service, TLS or isolation qualification.', 'Font readiness, loaded faces, external font responses/failures and console/page errors are recorded per state; computed font family alone is not proof that a downloadable font loaded.', 'Screenshots and geometry are functional observations, not INP, CLS, load-capacity, security or complete accessibility certification.', 'Native project Chromium only; no user browser/profile control.'], outcomes }
  writeFileSync(join(destination, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(destination, 'README.md'), `# Phase 1 synthetic browser acceptance\n\n${report.tests.passed}/${report.tests.total} states passed. Status: ${report.status}.\n\n${report.scope}\n\nSource drift: ${drift.length} paths. See [results](results.json), [before](source-before.json) and [after](source-after.json).\n\nFonts ready: ${fontSummary.ready_states}/${fontSummary.observed_states} observed states; actual loaded faces observed in ${fontSummary.states_with_loaded_faces} states. Loaded families: ${fontSummary.loaded_families.join(', ') || 'none observed'}. Failed font requests: ${fontSummary.failed_font_requests.length}; failed font faces: ${fontSummary.failed_font_faces.length}.\n\nAlignment compares actual plain-value text edges within 1px. Composite status badges and inputs use their visible outer value/control box, including their designed internal padding.\n\n| State | Route | Locale/theme | Width | Result | Screenshot |\n|---|---|---|---|---|---|\n${outcomes.map(outcome => `| ${outcome.id} | ${outcome.path} | ${outcome.locale}/${outcome.theme} | ${outcome.width} | ${outcome.status} | ${outcome.screenshot ? `[image](${outcome.screenshot})` : 'not captured (failure before screenshot)'} |`).join('\n')}\n\n${report.limits.map(limit => `- ${limit}`).join('\n')}\n`)
  process.stdout.write(`${JSON.stringify({ status: report.status, tests: report.tests, source_drift: drift.length, evidence: destination })}\n`)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv.find(argument => argument.startsWith('--output='))?.slice('--output='.length)
  const report = await runPhase1Acceptance({ output })
  process.exitCode = report.status === 'passed' ? 0 : 1
}
