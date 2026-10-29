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
    const family = locale === 'ar' ? 'sans-serif' : 'IBM Plex Sans'
    const faces = [...document.fonts].map(face => ({ family: face.family.replaceAll('"', '').replaceAll("'", ''), status: face.status }))
    return { ready, family, faces, body_family: getComputedStyle(document.body).fontFamily, glyph_check: document.fonts.check(family === 'sans-serif' ? '14px sans-serif' : '14px "' + family + '"', locale === 'ar' ? 'الحساب 0123456789' : 'Account 0123456789') }
  }, locale)
  assert.equal(result.ready, true, 'Font loading must settle within the observation window')
  assert.equal(result.glyph_check, true)
  if (locale === 'ar') assert.equal(result.body_family, 'sans-serif')
  else assert.ok(result.body_family.includes(result.family))
  for (const family of locale === 'ar' ? ['IBM Plex Mono'] : [result.family, 'IBM Plex Mono']) assert.ok(result.faces.some(face => face.family === family && face.status === 'loaded'), 'The actual downloadable font must load: ' + family)
  assert.deepEqual(result.faces.filter(face => face.status === 'error'), [])
  return result
}

async function geometry(page) {
  return page.evaluate(() => {
    const visible = element => element?.checkVisibility({ checkVisibilityCSS: true }) && !element.closest('[hidden],[inert]')
    const rect = selector => {
      const element = document.querySelector(selector)
      if (!element) return null
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height, visible: Boolean(visible(element)) }
    }
    const pairs = [
      ...[...document.querySelectorAll('[data-mail-layout] label[for]')].map(label => ({ label, value: document.getElementById(label.htmlFor) })),
      ...[...document.querySelectorAll('[data-mail-layout] dl > div')].map(field => ({ label: field.querySelector('dt'), value: field.querySelector('dd') })),
    ]
    const fields = pairs.filter(({ label, value }) => visible(label) && visible(value)).map(({ label, value }) => {
      const labelRange = document.createRange(), valueRange = document.createRange()
      labelRange.selectNodeContents(label); valueRange.selectNodeContents(value)
      const labelBox = labelRange.getBoundingClientRect(), box = value.getBoundingClientRect(), style = getComputedStyle(value)
      const control = /^(INPUT|SELECT|TEXTAREA)$/.test(value.tagName) || value.isContentEditable
      const valueBox = control
        ? { left: box.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth), right: box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) }
        : valueRange.getBoundingClientRect()
      const edge = document.documentElement.dir === 'rtl' ? 'right' : 'left'
      return { label: label.textContent.trim(), id: value.id || null, control, edge_delta: Math.abs(labelBox[edge] - valueBox[edge]), glyph_edge_delta: control ? null : Math.abs(labelBox[edge] - valueBox[edge]), below: box.top >= labelBox.bottom - 1 }
    })
    const targets = [...document.querySelectorAll('a[href],button,input,select,textarea,summary,[contenteditable="true"]')]
      .filter(element => visible(element) && (!element.classList.contains('xp-skip-link') || document.activeElement === element))
      .map(element => { const box = element.getBoundingClientRect(); return { tag: element.tagName, label: (element.getAttribute('aria-label') || element.textContent || element.id).trim().slice(0, 80), width: box.width, height: box.height } })
    return {
      header: rect('[data-mail-layout="reference"] > header'), folder: rect('[data-mail-pane="folders"]'), list: rect('[data-mail-pane="message-list"]'), reader: rect('[data-mail-pane="reading-pane"]'),
      fields, targets, scroll_width: document.documentElement.scrollWidth, viewport_width: innerWidth,
      ascii_digits: !/[\u0660-\u0669\u06f0-\u06f9]/.test(document.body.innerText),
    }
  })
}

function inspectQuotaNodes({ controls = false } = {}) {
  const observe = (value, label) => {
    if (!label) throw new Error('Quota probe requires a nonempty heading')
    const walker = document.createTreeWalker(value, NodeFilter.SHOW_TEXT), nodes = []
    let fullText = '', node
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? ''
      if (text.length) { nodes.push({ node, start: fullText.length, end: fullText.length + text.length }); fullText += text }
    }
    const token = text => {
      const start = fullText.indexOf(text)
      if (start < 0) throw new Error('Quota probe missing token: ' + text)
      if (fullText.indexOf(text, start + text.length) >= 0) throw new Error('Quota probe ambiguous token: ' + text)
      const end = start + text.length
      const first = nodes.findIndex(part => start >= part.start && start < part.end)
      const last = nodes.findIndex(part => end > part.start && end <= part.end)
      if (first < 0 || last < 0) throw new Error('Quota probe cannot map token: ' + text)
      const range = document.createRange()
      range.setStart(nodes[first].node, start - nodes[first].start)
      range.setEnd(nodes[last].node, end - nodes[last].start)
      if (range.toString() !== text) throw new Error('Quota probe mapped different text: ' + text)
      const box = range.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0) throw new Error('Quota probe token has no glyph geometry: ' + text)
      return { text: range.toString(), left: box.left, right: box.right, top: box.top, bottom: box.bottom, start_node: first, end_node: last }
    }
    // Resolve the complete phrase, not the first descendant text node. Numeric
    // tokens may span several nested used/limit elements in the rendered meter.
    const first = token('160'), slash = token('/'), limit = token('1024')
    token('MiB')
    const labelRange = document.createRange(), valueRange = document.createRange()
    labelRange.selectNodeContents(label); valueRange.selectNodeContents(value)
    const labelBox = labelRange.getBoundingClientRect(), valueBox = valueRange.getBoundingClientRect()
    return {
      label: label.textContent, phrase: fullText.replace(/\s+/g, ' ').trim(), direction: getComputedStyle(value).direction,
      edge_delta: document.documentElement.dir === 'rtl' ? Math.abs(labelBox.right - valueBox.right) : Math.abs(labelBox.left - valueBox.left),
      label_bottom: labelBox.bottom, value_top: valueBox.top, text_node_count: nodes.length,
      first, slash, limit,
    }
  }
  if (controls) {
    const fixture = document.createElement('div')
    fixture.setAttribute('data-quota-probe-control', '')
    fixture.dir = 'ltr'
    fixture.style.cssText = 'position:fixed;left:-10000px;top:0;width:360px;font:14px "IBM Plex Mono",monospace;'
    const label = document.createElement('span'), value = document.createElement('bdi')
    label.textContent = 'Quota probe'; label.style.display = 'block'
    value.dir = 'ltr'; value.style.display = 'block'
    fixture.append(label, value); document.body.append(fixture)
    try {
      value.innerHTML = '<strong><span>1</span><span>60</span></strong> / <strong><span>10</span><span>24</span></strong> MiB'
      const split = observe(value, label)
      const rejected = []
      for (const [name, html, expected] of [
        ['missing-limit', '<strong>160</strong> / <strong>999</strong> MiB', 'Quota probe missing token: 1024'],
        ['missing-slash', '<strong>160</strong> <strong>1024</strong> MiB', 'Quota probe missing token: /'],
        ['grouped-limit', '<strong>160</strong> / <strong>1,024</strong> MiB', 'Quota probe missing token: 1024'],
        ['malformed-grouping', '<strong>160</strong> / <strong>10,24</strong> MiB', 'Quota probe missing token: 1024'],
        ['ambiguous-used', '<strong>160</strong> / <strong>1024</strong> MiB 160', 'Quota probe ambiguous token: 160'],
      ]) {
        value.innerHTML = html
        let error = null
        try { observe(value, label) } catch (caught) { error = { name: caught.name, message: caught.message } }
        rejected.push({ name, expected, error })
      }
      return { split, rejected }
    } finally { fixture.remove() }
  }
  return [...document.querySelectorAll('[data-mail-quota-value]')]
    .filter(value => value.checkVisibility({ checkVisibilityCSS: true }))
    .map(value => {
      const parent = value.closest('[data-mail-quota]'), isolated = value.querySelector(':scope > bdi[dir="ltr"]')
      if (isolated && value.textContent.trim() !== isolated.textContent.trim()) throw new Error('The isolated quota must contain the complete visible value')
      return observe(isolated ?? value, parent?.querySelector('[data-mail-quota-label]'))
    })
}

async function quotaProbeControls(page) {
  const controls = await page.evaluate(inspectQuotaNodes, { controls: true })
  assert.equal(controls.split.phrase, '160 / 1024 MiB')
  assert.ok(controls.split.text_node_count > 3)
  assert.ok(controls.split.first.start_node !== controls.split.first.end_node, 'The used token actually spans text nodes')
  assert.ok(controls.split.limit.start_node !== controls.split.limit.end_node, 'The limit token actually spans text nodes')
  assert.equal(controls.split.first.text, '160')
  assert.equal(controls.split.limit.text, '1024')
  assert.ok(controls.split.first.right <= controls.split.slash.left && controls.split.slash.right <= controls.split.limit.left, 'Split tokens retain nonoverlapping LTR glyph order')
  assert.equal(controls.rejected.length, 5)
  for (const rejected of controls.rejected) {
    assert.equal(rejected.error?.name, 'Error', 'Invalid token controls must fail explicitly, not with a DOM Range exception')
    assert.equal(rejected.error.message, rejected.expected)
  }
  return controls
}

async function quotaGate(page) {
  const observations = await page.evaluate(inspectQuotaNodes)
  for (const observation of observations) {
    assert.equal(observation.phrase, '160 / 1024 MiB', 'The synthetic quota values and precise binary unit must not change')
    assert.equal(observation.direction, 'ltr')
    assert.ok(observation.edge_delta < 1, 'Actual quota glyphs share the heading edge: ' + observation.label)
    assert.ok(observation.value_top >= observation.label_bottom - 1, 'Quota values sit directly below the heading')
    assert.equal(observation.first.text, '160')
    assert.equal(observation.slash.text, '/')
    assert.equal(observation.limit.text, '1024')
    assert.ok(observation.first.left < observation.slash.left && observation.slash.left < observation.limit.left, 'The actual quota glyphs keep 160 / 1024 ordering')
    assert.ok(observation.first.right <= observation.slash.left && observation.slash.right <= observation.limit.left, 'Numeric tokens and slash must not overlap or reverse')
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
  const content = await page.evaluate(() => ({ heading_top: document.querySelector('h1').getBoundingClientRect().top, header_bottom: document.querySelector('[data-mail-layout="reference"] > header').getBoundingClientRect().bottom }))
  assert.ok(content.heading_top >= content.header_bottom - 1, 'The focused main heading must remain below the header')
  return { ...focus, ...content }
}

async function composerGate(page, state) {
  const nativeBoundary = await page.evaluate(() => {
    const composer = document.querySelector('[data-compose-form]'), send = composer?.querySelector('[data-mail-send="true"]')
    return {
      forms: [...document.forms].map(form => ({
        role: form.getAttribute('role'), action: form.getAttribute('action'), method: form.getAttribute('method'),
        fields: [...form.elements].map(control => ({ tag: control.tagName, name: control.getAttribute('name'), type: control.type })),
        locale: form.querySelector('[name="lang"]')?.value, theme: form.querySelector('[name="theme"]')?.value,
        contains_compose: Boolean(form.querySelector('[data-compose-form], [data-mail-send], [id^="compose-"]')),
      })),
      action_owners: [...document.querySelectorAll('[action]')].map(element => element.tagName),
      form_overrides: document.querySelectorAll('[form], [formaction], [formmethod], [formenctype], [formtarget], [onsubmit]').length,
      composer_tag: composer?.tagName, composer_role: composer?.getAttribute('role'),
      composer_form: Boolean(composer?.closest('form')), nested_composer_form: Boolean(composer?.querySelector('form')),
      send_form: Boolean(send?.form),
      submit_controls: [...document.querySelectorAll('button, input')].filter(control => ['submit', 'image'].includes(control.type)).length,
    }
  })
  assert.deepEqual(nativeBoundary.forms, [{
    role: 'search', action: '/mail/inbox', method: 'get',
    fields: [
      { tag: 'INPUT', name: 'lang', type: 'hidden' },
      { tag: 'INPUT', name: 'theme', type: 'hidden' },
      { tag: 'INPUT', name: 'q', type: 'search' },
    ],
    locale: state.locale, theme: state.theme, contains_compose: false,
  }], 'The sole native form is the exact local read-only GET inbox search')
  assert.deepEqual(nativeBoundary.action_owners, ['FORM'], 'Only that search form owns a native action')
  assert.equal(nativeBoundary.form_overrides, 0, 'Controls cannot override or associate with a native form')
  assert.equal(nativeBoundary.composer_tag, 'DIV')
  assert.equal(nativeBoundary.composer_role, 'group')
  assert.equal(nativeBoundary.composer_form, false, 'Compose fields have no native submission ancestor')
  assert.equal(nativeBoundary.nested_composer_form, false, 'Compose contains no nested native form')
  assert.equal(nativeBoundary.send_form, false, 'Send has no native form owner')
  assert.equal(nativeBoundary.submit_controls, 0, 'There is no native submit control')
  const composer = page.locator('[data-compose-form]'), send = composer.locator('[data-mail-send="true"]')
  assert.equal(await composer.getAttribute('data-mail-send-availability'), 'available')
  assert.equal(await send.count(), 1)
  assert.equal(await send.isDisabled(), false)
  assert.equal(await send.getAttribute('type'), 'button')
  const from = page.locator('#compose-from'), mailbox = await page.locator('[data-mail-layout="reference"]').getAttribute('data-mailbox')
  assert.equal(await from.evaluate(element => element.tagName), 'SELECT')
  assert.deepEqual(await from.locator('option').evaluateAll(options => options.map(option => ({ value: option.value, selected: option.selected }))), [{ value: mailbox, selected: true }])
  await from.selectOption(mailbox)
  assert.equal(await from.inputValue(), mailbox, 'The configured sender remains the sole native option')
  assert.equal(await composer.locator('[data-mail-action="save-draft"][disabled]').count(), 1)
  await page.locator('#compose-to').fill('recipient@example.test')
  const directions = async () => composer.evaluate(element => ['compose-subject', 'compose-body'].map(id => {
    const input = element.querySelector('#' + id), style = getComputedStyle(input)
    return { id, value: input.isContentEditable ? input.innerText : input.value, dir: input.getAttribute('dir'), direction: style.direction, alignment: style.textAlign }
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
  assert.equal(await page.locator('#compose-body').innerText(), 'Synthetic preview. This must never send.')
  assert.equal(new URL(page.url()).pathname, '/mail/compose')
  return { explicit_send_available: true, send_clicked: false, native_form: false, search_form: nativeBoundary.forms[0], configured_sender_option: mailbox, arabic, english, input_preserved_after_enter: true }
}

async function mobileGate(page, state) {
  const sidebar = page.locator('[data-xp-sidebar]'), toggle = page.locator('[data-action="toggle-mobile-nav"]:visible')
  if (await toggle.count()) {
    await toggle.click()
    assert.equal(await sidebar.getAttribute('aria-modal'), 'true')
    assert.equal(await sidebar.getAttribute('role'), 'dialog')
    const quota = await quotaGate(page)
    assert.ok(quota.length > 0, 'Actual quota text remains measurable while navigation is open')
    await page.keyboard.press('Escape')
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(await toggle.evaluate(element => document.activeElement === element), true)
    return { navigation: 'modal', escape_returns_focus: true, quota }
  }
  assert.equal(await page.locator('[data-mail-layout="reference"]').getAttribute('data-board-port'), 'xmail-' + state.screen, 'Inline navigation is limited to the actual current mail board')
  assert.equal(await sidebar.evaluate(element => element.tagName), 'NAV')
  assert.equal(await sidebar.isVisible(), true, 'The current inline folder navigation remains visible')
  assert.notEqual(await sidebar.getAttribute('role'), 'dialog')
  assert.notEqual(await sidebar.getAttribute('aria-modal'), 'true')
  const links = sidebar.locator('a[href]')
  assert.ok(await links.count() > 1, 'Inline navigation exposes real keyboard destinations')
  await links.first().focus()
  const focused = await links.first().evaluate(element => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element)
    return { focused: document.activeElement === element, width: box.width, height: box.height, outline: parseFloat(style.outlineWidth), outline_style: style.outlineStyle }
  })
  assert.ok(focused.focused && focused.width >= 44 && focused.height >= 44 && focused.outline >= 2 && focused.outline_style !== 'none')
  await page.keyboard.press('Tab')
  assert.equal(await sidebar.evaluate(element => element.contains(document.activeElement) && document.activeElement.tagName === 'A'), true, 'Tab visits the next actual folder destination')
  assert.equal(await page.locator('[data-xp-shell-content]').evaluate(element => element.inert), false)
  const quota = await quotaGate(page)
  assert.ok(quota.length > 0, 'Visible header quota is measured in the inline layout')
  return { navigation: 'inline', visible: true, native_tab_order: true, modal: false, quota }
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
  let browser, probeControls
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
        if (!probeControls) probeControls = await quotaProbeControls(page)
        outcome.applied_fonts = {}
        for (const [role, selector, family, typographyRole] of [['brand', '[data-mail-layout="reference"] > header > a:first-child > span:last-child', 'IBM Plex Mono', 'mail-wordmark'], ['heading', state.screen === 'inbox' ? '#list-title' : '#compose-title', state.locale === 'ar' ? 'sans-serif' : 'IBM Plex Sans', 'ordinary']]) {
          try { outcome.applied_fonts[role] = await assertAppliedFont(page, selector, family, { role: typographyRole }) }
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
          else { assert.equal(observed.folder.visible, true); assert.ok(observed.folder.width <= state.width + 1, 'Inline folder navigation fits the narrow viewport') }
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
    limits: ['Synthetic catalog and mailbox data validate the rendered layout only; they do not authenticate a mailbox or prove SMTP/IMAP, message selection, drafts, attachments or delivery.', 'The current composer uses an explicit send button and no native sending form; its sole native form is the exact read-only GET inbox search. This suite never clicks Send; Enter in compose must not submit, and no mailbox authority or delivery qualification is implied.', 'Font, keyboard, target and selected geometry checks are scoped accessibility evidence, not complete WCAG certification.', 'Viewport emulation and screenshots do not certify physical devices, every message shape, external design parity or production performance.'],
    probe_controls: probeControls ?? null,
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
