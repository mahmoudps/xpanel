import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSnapshotFiles, computeSourceDigest } from '../../scripts/vm/source-snapshot.mjs'
import { createVisualFixture } from './visual-fixture.mjs'
import { assertAppliedFont } from './applied-font-contract.mjs'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const states = ['en', 'ar'].flatMap(locale => ['light', 'dark'].flatMap(theme => [360, 768, 1440].flatMap(width => ['inbox', 'compose'].map(screen => ({
  id: screen + '-' + locale + '-' + theme + '-' + width, locale, theme, width, screen,
})))))

function fingerprint(destination, phase) {
  const paths = [...new Set([...collectSnapshotFiles(root), 'tests/browser/mail-layout-acceptance.mjs', 'tests/browser/visual-fixture.mjs'])].sort()
  const files = paths.map(path => { const bytes = readFileSync(join(root, path)); return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } })
  const result = { sha256: computeSourceDigest(files), files }
  writeFileSync(join(destination, 'source-' + phase + '.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

async function fontGate(page, locale) {
  const result = await page.evaluate(async locale => {
    let ready = false
    await Promise.race([document.fonts.ready.then(() => { ready = true }), new Promise(resolve => setTimeout(resolve, 10000))])
    const family = locale === 'ar' ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans'
    const faces = [...document.fonts].map(face => ({ family: face.family.replaceAll('"', '').replaceAll("'", ''), status: face.status }))
    return { ready, family, faces, body_family: getComputedStyle(document.body).fontFamily, glyph_check: document.fonts.check('14px "' + family + '"', locale === 'ar' ? 'الحساب 0123456789' : 'Account 0123456789') }
  }, locale)
  assert.equal(result.ready, true, 'Font loading must settle within the observation window')
  assert.equal(result.glyph_check, true)
  assert.ok(result.body_family.includes(result.family))
  for (const family of [result.family, 'IBM Plex Mono']) assert.ok(result.faces.some(face => face.family === family && face.status === 'loaded'), 'The actual downloadable font must load: ' + family)
  assert.deepEqual(result.faces.filter(face => face.status === 'error'), [])
  return result
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const element = document.querySelector(selector)
      if (!element) return null
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height, visible: element.checkVisibility({ checkVisibilityCSS: true }) }
    }
    const fields = [...document.querySelectorAll('.xp-mail-field')].map(element => {
      const label = element.querySelector('dt,label'), value = element.querySelector('dd>bdi,input,textarea')
      if (!label || !value) return null
      const labelBox = label.getBoundingClientRect(), valueBox = value.getBoundingClientRect()
      let glyphEdgeDelta = null
      if (value.tagName === 'BDI') {
        const labelRange = document.createRange(), valueRange = document.createRange()
        labelRange.selectNodeContents(label); valueRange.selectNodeContents(value)
        const labelGlyphs = labelRange.getBoundingClientRect(), valueGlyphs = valueRange.getBoundingClientRect()
        glyphEdgeDelta = document.documentElement.dir === 'rtl' ? Math.abs(labelGlyphs.right - valueGlyphs.right) : Math.abs(labelGlyphs.left - valueGlyphs.left)
      }
      return { label: label.textContent.trim(), edge_delta: Math.abs(labelBox.left - valueBox.left), glyph_edge_delta: glyphEdgeDelta, below: valueBox.top >= labelBox.bottom - 1 }
    }).filter(Boolean)
    const targets = [...document.querySelectorAll('a[href],button,input,textarea,summary')]
      .filter(element => element.checkVisibility({ checkVisibilityCSS: true }) && (!element.classList.contains('xp-skip-link') || document.activeElement === element))
      .map(element => { const box = element.getBoundingClientRect(); return { tag: element.tagName, label: (element.getAttribute('aria-label') || element.textContent || element.id).trim().slice(0, 80), width: box.width, height: box.height } })
    return {
      header: rect('.xp-mail-topbar'), folder: rect('[data-mail-pane="folders"]'), list: rect('[data-mail-pane="message-list"]'), reader: rect('[data-mail-pane="reading-pane"]'),
      fields, targets, scroll_width: document.documentElement.scrollWidth, viewport_width: innerWidth,
      ascii_digits: !/[\u0660-\u0669\u06f0-\u06f9]/.test(document.body.innerText),
    }
  })
}

async function quotaGate(page) {
  const observations = await page.evaluate(() => [...document.querySelectorAll('.xp-meter__values > bdi[dir="ltr"]')]
    .filter(value => value.checkVisibility({ checkVisibilityCSS: true }))
    .map(value => {
      const parent = value.closest('.xp-mail-sidebar-quota') ?? value.closest('.xp-card')
      const label = parent?.querySelector('.xp-label,h2')
      if (!label) return null
      const labelRange = document.createRange(), valueRange = document.createRange()
      labelRange.selectNodeContents(label); valueRange.selectNodeContents(value)
      const labelBox = labelRange.getBoundingClientRect(), valueBox = valueRange.getBoundingClientRect()
      const firstText = document.createTreeWalker(value, NodeFilter.SHOW_TEXT).nextNode()
      const char = index => {
        const range = document.createRange()
        range.setStart(firstText, index); range.setEnd(firstText, index + 1)
        const box = range.getBoundingClientRect()
        return { left: box.left, right: box.right, top: box.top }
      }
      return {
        label: label.textContent, phrase: value.textContent.replace(/\s+/g, ' ').trim(), direction: getComputedStyle(value).direction,
        edge_delta: document.documentElement.dir === 'rtl' ? Math.abs(labelBox.right - valueBox.right) : Math.abs(labelBox.left - valueBox.left),
        label_bottom: labelBox.bottom, value_top: valueBox.top,
        first: char(0), slash: char(firstText.textContent.indexOf('/')), limit: char(firstText.textContent.indexOf('1024')),
      }
    }).filter(Boolean))
  for (const observation of observations) {
    assert.equal(observation.phrase, '160 / 1024 MB (15.6%)', 'The synthetic quota values must not change')
    assert.equal(observation.direction, 'ltr')
    assert.ok(observation.edge_delta < 1, 'Actual quota glyphs share the heading edge: ' + observation.label)
    assert.ok(observation.value_top >= observation.label_bottom - 1, 'Quota values sit directly below the heading')
    assert.ok(observation.first.left < observation.slash.left && observation.slash.left < observation.limit.left, 'The actual quota glyphs keep 160 / 1024 ordering')
  }
  return observations
}

async function currentNavigation(page, state) {
  const current = page.locator('[data-xp-sidebar] a[aria-current="page"]')
  assert.equal(await current.count(), 1)
  assert.equal(await current.getAttribute('data-nav-route'), '/mail/' + state.screen)
  assert.equal(await page.locator('a[aria-current="page"]').count(), 1)
}

async function keyboardGate(page) {
  const skip = page.locator('.xp-skip-link')
  await skip.focus()
  const focus = await skip.evaluate(element => { const box = element.getBoundingClientRect(), style = getComputedStyle(element); return { focused: document.activeElement === element, width: box.width, height: box.height, outline: parseFloat(style.outlineWidth), style: style.outlineStyle } })
  assert.equal(focus.focused, true)
  assert.ok(focus.width >= 44 && focus.height >= 44 && focus.outline >= 2 && focus.style !== 'none')
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#main-content').evaluate(element => document.activeElement === element), true, 'The skip link must reach the main landmark')
  const content = await page.evaluate(() => ({ heading_top: document.querySelector('h1').getBoundingClientRect().top, header_bottom: document.querySelector('.xp-mail-topbar').getBoundingClientRect().bottom }))
  assert.ok(content.heading_top >= content.header_bottom - 1, 'The focused main heading must remain below the sticky header')
  return { ...focus, ...content }
}

async function composerGate(page, state) {
  assert.equal(await page.locator('form').count(), 0, 'An unavailable composer must have no native submission path')
  const send = page.locator('[data-compose-form] button')
  assert.equal(await send.count(), 1)
  assert.equal(await send.isDisabled(), true)
  assert.equal(await send.getAttribute('type'), 'button')
  await page.locator('#compose-to').fill('recipient@example.test')
  const directions = async () => page.locator('[data-compose-form]').evaluate(element => ['compose-subject', 'compose-body'].map(id => {
    const input = element.querySelector('#' + id), style = getComputedStyle(input)
    return { id, value: input.value, dir: input.getAttribute('dir'), direction: style.direction, alignment: style.textAlign }
  }))
  await page.locator('#compose-subject').fill('رسالة تجريبية. الاختبار رقم 1.')
  await page.locator('#compose-body').fill('نص عربي مع test@example.test. السطر التالي.')
  const arabic = await directions()
  for (const input of arabic) { assert.equal(input.dir, 'auto'); assert.equal(input.direction, 'rtl'); assert.equal(input.alignment, state.locale === 'ar' ? 'right' : 'left') }
  await page.locator('#compose-subject').fill('Synthetic unsent input')
  await page.locator('#compose-body').fill('Synthetic preview. This must never send.')
  const english = await directions()
  for (const input of english) { assert.equal(input.dir, 'auto'); assert.equal(input.direction, 'ltr'); assert.equal(input.alignment, state.locale === 'ar' ? 'right' : 'left') }
  await page.locator('#compose-subject').press('Enter')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.locator('#compose-subject').inputValue(), 'Synthetic unsent input')
  assert.equal(await page.locator('#compose-body').inputValue(), 'Synthetic preview. This must never send.')
  assert.equal(new URL(page.url()).pathname, '/mail/compose')
  return { unavailable_send: true, arabic, english, input_preserved_after_enter: true }
}

async function mobileGate(page, state) {
  await page.locator('[data-action="toggle-mobile-nav"]').click()
  const sidebar = page.locator('[data-xp-sidebar]')
  assert.equal(await sidebar.getAttribute('aria-modal'), 'true')
  assert.equal(await sidebar.getAttribute('role'), 'dialog')
  const quota = await quotaGate(page)
  if (state.screen === 'inbox') assert.ok(quota.length > 0, 'The open navigation sheet quota is actually measured')
  await page.keyboard.press('Escape')
  const toggle = page.locator('[data-action="toggle-mobile-nav"]')
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(await toggle.evaluate(element => document.activeElement === element), true)
  return { modal_navigation: true, escape_returns_focus: true, quota }
}

/** Synthetic, loopback-only mail geometry and non-submission checks. No mailbox authentication or SMTP/IMAP service is exercised. */
export async function runMailLayoutAcceptance({ output, filter } = {}) {
  assert.equal(process.versions.node, readFileSync(join(root, '.node-version'), 'utf8').trim(), 'Use the pinned workspace launcher')
  const requested = output ?? 'test-results/mail-layout/run-' + new Date().toISOString().replaceAll(/[-:.]/g, '')
  if (isAbsolute(requested)) throw new Error('Mail acceptance output must be a new repository-relative directory')
  const destination = resolve(root, requested), outputRelative = relative(root, destination)
  if (!outputRelative || outputRelative === '..' || outputRelative.startsWith('..' + sep) || isAbsolute(outputRelative)) throw new Error('Mail acceptance output must stay inside the repository')
  if (existsSync(destination)) throw new Error('Refusing to overwrite mail acceptance evidence')
  const selected = states.filter(state => !filter || state.id.includes(filter))
  assert.ok(selected.length > 0, 'The case filter must select actual mail states')
  mkdirSync(join(destination, 'screenshots'), { recursive: true })
  const before = fingerprint(destination, 'before')
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(root, '.tools/playwright-browsers')
  const { chromium } = await import('@playwright/test')
  const fixture = await createVisualFixture()
  let browser
  const outcomes = [], started = Date.now()
  try {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), timeout: 20000 })
    for (const state of selected) {
      const outcome = { ...state, status: 'running', page_errors: [], console_errors: [], mutations: [], websockets: [] }
      const context = await browser.newContext({ viewport: { width: state.width, height: 900 }, colorScheme: state.theme, locale: state.locale, reducedMotion: 'reduce' })
      const page = await context.newPage()
      page.setDefaultTimeout(8000)
      await context.route('**/*', async route => {
        const method = route.request().method()
        if (!['GET', 'HEAD'].includes(method)) { outcome.mutations.push({ method }); await route.abort(); return }
        await route.continue()
      })
      page.on('pageerror', error => outcome.page_errors.push(String(error.message).slice(0, 200)))
      page.on('console', message => { if (message.type() === 'error') outcome.console_errors.push({ text: message.text().slice(0, 200), url: message.location().url }) })
      page.on('websocket', () => outcome.websockets.push('attempted'))
      try {
        const url = new URL('/mail/' + state.screen, fixture.baseUrl)
        for (const [key, value] of Object.entries({ lang: state.locale, theme: state.theme, density: 'compact', accountId: 'visual-account' })) url.searchParams.set(key, value)
        assert.equal((await page.goto(url.href, { waitUntil: 'domcontentloaded' })).status(), 200)
        assert.equal(await page.locator('html').getAttribute('data-visual-fixture'), 'synthetic')
        assert.equal(await page.locator('[data-mail-layout="reference"]').count(), 1)
        assert.equal(await page.locator('main').count(), 1)
        assert.equal(await page.locator('h1').count(), 1)
        assert.equal(await page.locator('html').getAttribute('data-realtime-enabled'), 'false')
        assert.equal(await page.locator('[data-ws-indicator="unavailable"]').count(), 1, 'The fixture must retain the unavailable transport state')
        await currentNavigation(page, state)
        outcome.fonts = await fontGate(page, state.locale)
        outcome.applied_fonts = {}
        for (const [role, selector, family] of [['brand', '.xp-mail-brand strong', 'IBM Plex Sans'], ['heading', 'h1', state.locale === 'ar' ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans']]) {
          try { outcome.applied_fonts[role] = await assertAppliedFont(page, selector, family) }
          catch (error) { if (error.appliedFontObservation) outcome.applied_fonts[role] = error.appliedFontObservation; throw error }
        }
        outcome.geometry = await geometry(page)
        const observed = outcome.geometry
        assert.ok(observed.scroll_width <= state.width + 1, 'The document must not overflow horizontally')
        assert.ok(Math.abs(observed.header.width - state.width) < 1, 'The mail header spans the full workspace')
        assert.equal(observed.ascii_digits, true)
        assert.ok(observed.targets.length > 0 && observed.targets.every(target => target.width >= 43.9 && target.height >= 43.9), 'Rendered interactive controls meet the approved 44px target')
        assert.ok(observed.fields.length >= 3, 'Actual labeled fields are measured non-vacuously')
        for (const field of observed.fields) {
          assert.ok(field.label && field.edge_delta < 1 && field.below, 'Nonempty labels sit directly above their values: ' + field.label)
          if (field.glyph_edge_delta !== null) assert.ok(field.glyph_edge_delta < 1, 'The actual value glyphs share the locale edge: ' + field.label)
        }
        if (state.screen === 'inbox') {
          if (state.width >= 960) { assert.equal(observed.folder.visible, true); assert.ok(Math.abs(observed.folder.width - 200) < 1); assert.ok(observed.list.height >= 700, 'The continuous inbox fills the desktop workspace') }
          else assert.equal(observed.folder.visible, false)
          if (state.width >= 640) assert.ok(Math.abs(observed.list.y - observed.reader.y) < 1, 'Tablet and desktop keep list and reader side by side')
          else assert.ok(observed.reader.y >= observed.list.y + observed.list.height - 1, 'Phone panes stack in reading order')
        }
        outcome.keyboard = await keyboardGate(page)
        if (state.screen === 'compose') outcome.composer = await composerGate(page, state)
        if (state.width < 960) outcome.mobile = await mobileGate(page, state)
        outcome.quota = await quotaGate(page)
        if (state.screen === 'compose' || state.width >= 960) assert.ok(outcome.quota.length > 0, 'Visible mailbox quota glyphs are measured')
        outcome.unexpected_console = outcome.console_errors.filter(error => !/fonts\.(?:googleapis|gstatic)\.com/.test(error.url + ' ' + error.text) && !/\/api\/auth\/me(?:\?|$)/.test(error.url))
        assert.deepEqual(outcome.unexpected_console, [])
        assert.deepEqual(outcome.page_errors, [])
        assert.deepEqual(outcome.mutations, [], 'No delivery or other mutation request is attempted')
        assert.deepEqual(outcome.websockets, [])
        outcome.status = 'passed'
      } catch (error) {
        outcome.status = 'failed'
        outcome.failure = { name: error.name, message: String(error.message).slice(0, 1200) }
      } finally {
        if (outcome.status === 'passed') {
          // Capture the complete layout after keyboard checks, rather than a scrolled sticky-header state.
          await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0) })
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        }
        outcome.screenshot = 'screenshots/' + state.id + '.png'
        await page.screenshot({ path: join(destination, outcome.screenshot), fullPage: true }).catch(error => { outcome.screenshot_error = String(error.message).slice(0, 200) })
        await context.close()
        outcomes.push(outcome)
        process.stdout.write(JSON.stringify({ id: state.id, status: outcome.status, failure: outcome.failure?.message }) + '\n')
      }
    }
  } finally { await browser?.close(); await fixture.close() }
  const after = fingerprint(destination, 'after'), initial = new Map(before.files.map(file => [file.path, file.sha256])), final = new Map(after.files.map(file => [file.path, file.sha256]))
  const drift = [...new Set([...initial.keys(), ...final.keys()])].filter(path => initial.get(path) !== final.get(path)).sort()
  const report = {
    schema_version: 1, captured_at: new Date().toISOString(), status: outcomes.every(outcome => outcome.status === 'passed') && drift.length === 0 ? 'passed' : 'failed',
    runtime: process.version, browser: { name: 'Chromium', version: browser.version(), headless: true }, duration_ms: Date.now() - started,
    scope: { full_suite_case_count: states.length, executed_case_count: selected.length, filter: filter ?? null, widths: [360, 768, 1440], locales: ['en', 'ar'], themes: ['light', 'dark'], screens: ['inbox', 'compose'] },
    fixture: { synthetic: true, loopback_only: true, read_only: true, authentication: false, smtp_imap: false, service_qualification: false },
    tests: { total: outcomes.length, passed: outcomes.filter(outcome => outcome.status === 'passed').length, failed: outcomes.filter(outcome => outcome.status === 'failed').length },
    source: { before_sha256: before.sha256, after_sha256: after.sha256, files: before.files.length, drift },
    limits: ['Synthetic catalog and mailbox data validate the rendered layout only; they do not authenticate a mailbox or prove SMTP/IMAP, message selection, drafts, attachments or delivery.', 'The non-submitting composer is intentionally unavailable until real mailbox authority and delivery are wired. Enter must never send.', 'Font, keyboard, target and selected geometry checks are scoped accessibility evidence, not complete WCAG certification.', 'Viewport emulation and screenshots do not certify physical devices, every message shape, external design parity or production performance.'],
    outcomes,
  }
  writeFileSync(join(destination, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ status: report.status, tests: report.tests, source_drift: drift, evidence: outputRelative }) + '\n')
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runMailLayoutAcceptance({ output: process.argv.find(value => value.startsWith('--output='))?.slice(9), filter: process.argv.find(value => value.startsWith('--filter='))?.slice(9) })
  process.exitCode = report.status === 'passed' ? 0 : 1
}
