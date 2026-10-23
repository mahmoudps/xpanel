import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSnapshotFiles, computeSourceDigest } from '../../scripts/vm/source-snapshot.mjs'
import { createVisualFixture } from './visual-fixture.mjs'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const focusable = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]'
const routes = [
  { path: '/home', to: '/domains', marker: '[data-section="slice-resources"]', target: '[data-domains-table]' },
  { path: '/whm', to: '/whm/accounts', marker: '[data-section="overview-attention"]', target: '[data-section="accounts-isolation"]' },
  { path: '/mail/inbox', to: '/mail/compose', marker: '[data-mail-pane="message-list"]', target: '[data-compose-form]' },
  { path: '/files/manager', to: '/home', marker: '[data-file-manager-table]', target: '[data-section="slice-resources"]' },
]
const states = routes.flatMap(route => [360, 768, 1280, 1440].flatMap(width => ['en', 'ar'].map(locale => ({
  id: `navigate-${route.path.replaceAll('/', '-').replace(/^-/, '')}-${locale}-${width}`, kind: 'navigation', ...route, width, locale,
}))))
for (const locale of ['en', 'ar']) {
  for (const boundary of ['sheet-close', 'toolbar-summary', 'palette-return']) states.push({ id: `boundary-${boundary}-${locale}`, kind: boundary, path: '/home', width: boundary === 'palette-return' ? 960 : 959, locale })
  for (const [path, fields] of [
    ['/login', ['login-username', 'login-password']],
    ['/whm/accounts/new', ['new-acc-username', 'new-acc-domain', 'new-acc-plan', 'new-acc-ipv4', 'new-acc-ipv6']],
    ['/mail/compose', ['compose-from', 'compose-to', 'compose-subject', 'compose-body']],
  ]) states.push({ id: `fields-${path.replaceAll('/', '-').replace(/^-/, '')}-${locale}`, kind: 'fields', path, fields, width: 360, locale })
  states.push({ id: `reduced-motion-${locale}`, kind: 'motion', path: '/home', width: 390, locale })
  states.push({ id: `long-form-scroll-${locale}`, kind: 'scroll', path: '/whm/accounts/new', width: 390, height: 600, locale })
  states.push({ id: `unknown-and-owner-navigation-${locale}`, kind: 'unavailable', path: '/home', width: 1440, locale })
  states.push({ id: `shortcut-palette-${locale}`, kind: 'shortcut', path: '/home', width: 1440, locale })
  for (const width of [360, 768, 1440]) states.push({ id: `unqualified-summary-${locale}-${width}`, kind: 'summary', path: '/home', width, locale })
  for (const kind of ['palette-filter', 'palette-owner', 'palette-unqualified']) states.push({ id: `${kind}-${locale}`, kind, path: '/home', width: 1440, locale })
  for (const width of [320, 1440]) states.push({ id: `palette-scroll-${locale}-${width}`, kind: 'palette-scroll', path: '/whm/accounts/new', width, locale })
  states.push({ id: `palette-native-input-${locale}`, kind: 'palette-native-input', path: '/mail/compose', width: 390, locale })
  for (const [surface, path] of [['panel', '/home'], ['whm', '/whm/accounts/new'], ['mail', '/mail/compose']]) states.push({ id: `shortcut-context-${surface}-${locale}`, kind: 'shortcut-context', surface, path, width: 1440, locale })
}

function fingerprint(output, phase) {
  const paths = [...new Set([...collectSnapshotFiles(root), 'tests/browser/navigation-acceptance.mjs', 'tests/browser/visual-fixture.mjs'])].sort()
  const files = paths.map(path => { const bytes = readFileSync(join(root, path)); return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } })
  const result = { sha256: computeSourceDigest(files), files }
  writeFileSync(join(output, `source-${phase}.json`), `${JSON.stringify(result, null, 2)}\n`)
  return result
}

function assertContext(href, state, { path = state.path, locale = state.locale, theme = 'light' } = {}) {
  const url = new URL(href)
  assert.equal(url.pathname, path)
  for (const [key, value] of Object.entries({ lang: locale, theme, density: 'compact', accountId: 'visual-account' })) assert.equal(url.searchParams.get(key), value, `Preserve ${key}`)
}

async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }

async function currentPage(page, path, expect) {
  const active = page.locator('[data-xp-sidebar] a[aria-current="page"]')
  await expect(active).toHaveCount(1)
  await expect(page.locator('a[aria-current="page"]')).toHaveCount(1)
  assert.equal(await active.getAttribute('data-nav-route'), path, 'The sole current navigation item must match the actual document')
}

async function fontGate(page, locale) {
  const result = await page.evaluate(async locale => {
    const family = locale === 'ar' ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans'
    const text = locale === 'ar' ? 'الحساب 0123456789' : 'Account 0123456789'
    let ready = false
    await Promise.race([document.fonts.ready.then(() => { ready = true }), new Promise(resolve => setTimeout(resolve, 10000))])
    const faces = [...document.fonts].map(face => ({ family: face.family.replaceAll('"', '').replaceAll("'", ''), status: face.status }))
    return { ready, status: document.fonts.status, family, glyph_check: document.fonts.check(`14px "${family}"`, text), body_family: getComputedStyle(document.body).fontFamily, faces }
  }, locale)
  assert.equal(result.ready, true, 'Font loading must finish within the recorded observation window')
  assert.equal(result.status, 'loaded')
  assert.ok(result.faces.some(face => face.family === result.family && face.status === 'loaded'), 'The expected downloadable locale face must actually load')
  assert.equal(result.glyph_check, true)
  assert.ok(result.body_family.includes(result.family), 'The locale body must select its intended family')
  assert.deepEqual(result.faces.filter(face => face.status === 'error'), [])
  return result
}

async function usableFocus(page) {
  return page.evaluate(() => {
    const target = document.activeElement
    return { tag: target?.tagName, action: target?.getAttribute('data-action'), id: target?.id, visible: !!target && target !== document.body && target.checkVisibility({ checkVisibilityCSS: true }) && !target.closest('[hidden],[inert]') }
  })
}

async function openToolbar(page) {
  const toolbar = page.locator('[data-xp-toolbar-options]')
  if (!await toolbar.evaluate(element => element.open)) await toolbar.locator(':scope > summary').click()
}

async function observeAction(page, action, eventType = 'click') {
  await page.evaluate(eventType => {
    window.__navigationAction = { started: performance.now(), shifts: [], event_to_second_frame_ms: null, event_scroll_y: null }
    document.addEventListener(eventType, () => {
      const started = performance.now()
      window.__navigationAction.event_scroll_y = scrollY
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__navigationAction.event_to_second_frame_ms = performance.now() - started }))
    }, { capture: true, once: true })
    window.__navigationShiftObserver = new PerformanceObserver(list => { window.__navigationAction.shifts.push(...list.getEntries().map(entry => ({ value: entry.value, recent_input: entry.hadRecentInput }))) })
    window.__navigationShiftObserver.observe({ type: 'layout-shift', buffered: false })
  }, eventType)
  await action()
  const result = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
    window.__navigationShiftObserver.disconnect()
    resolve({ action_to_second_frame_ms: performance.now() - window.__navigationAction.started, event_to_second_frame_ms: window.__navigationAction.event_to_second_frame_ms, event_scroll_y: window.__navigationAction.event_scroll_y, shifts: window.__navigationAction.shifts, scroll_y: scrollY, scroll_height: document.documentElement.scrollHeight, client_height: document.documentElement.clientHeight, body_height: document.body.getBoundingClientRect().height, document_overflow: getComputedStyle(document.documentElement).overflow, body_overflow: getComputedStyle(document.body).overflow })
  }))))
  assert.ok(Number.isFinite(result.action_to_second_frame_ms) && result.action_to_second_frame_ms >= 0)
  assert.ok(Number.isFinite(result.event_to_second_frame_ms) && result.event_to_second_frame_ms >= 0)
  return result
}

async function mobileOverlay(page, expect, observations, { requireLongScroll = false } = {}) {
  const toggle = page.locator('[data-action="toggle-mobile-nav"]'), sidebar = page.locator('[data-xp-sidebar]')
  // Short overviews can overflow only by the synthetic watermark. Dedicated long-form cases
  // require actual content scrolling before asserting that the menu preserves its position.
  await page.evaluate(long => window.scrollTo(0, long ? Math.min(180, document.documentElement.scrollHeight - innerHeight) : 0), requireLongScroll)
  await frames(page)
  const before = await page.evaluate(() => ({ y: scrollY, maximum: document.documentElement.scrollHeight - innerHeight, scroll_height: document.documentElement.scrollHeight, client_height: document.documentElement.clientHeight, body_height: document.body.getBoundingClientRect().height }))
  if (requireLongScroll) assert.ok(before.maximum > 100 && before.y > 100, 'Long-form scroll preservation must observe more than fixture-watermark overflow')
  const opening = await observeAction(page, () => toggle.click())
  await expect(sidebar).toHaveAttribute('role', 'dialog')
  await expect(sidebar).toHaveAttribute('aria-modal', 'true')
  assert.equal(await page.locator('[data-xp-shell-content]').evaluate(element => element.inert), true)
  assert.equal(await sidebar.evaluate(element => element.contains(document.activeElement)), true)
  const trace = []
  observations.push({ check: 'focus-scroll-stages', trace })
  const record = async step => { await frames(page); trace.push(await page.evaluate(step => ({ step, y: scrollY, focus_tag: document.activeElement?.tagName, focus_action: document.activeElement?.getAttribute('data-action'), sidebar_y: document.querySelector('[data-xp-sidebar]').scrollTop }), step)) }
  await record('open')
  const endpoints = await sidebar.evaluate((element, selector) => {
    const targets = [...element.querySelectorAll(selector)].filter(target => target.tabIndex >= 0 && target.checkVisibility({ checkVisibilityCSS: true }) && !target.closest('[hidden],[inert]'))
    targets.at(-1)?.focus({ preventScroll: true })
    return { count: targets.length, final_focused: document.activeElement === targets.at(-1) }
  }, focusable)
  assert.ok(endpoints.count > 1)
  assert.equal(endpoints.final_focused, true)
  await record('last-focus')
  await page.keyboard.press('Tab')
  assert.equal(await sidebar.evaluate((element, selector) => document.activeElement === [...element.querySelectorAll(selector)].filter(target => target.tabIndex >= 0 && target.checkVisibility({ checkVisibilityCSS: true }) && !target.closest('[hidden],[inert]'))[0], focusable), true)
  await record('tab-wrap')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await sidebar.evaluate((element, selector) => document.activeElement === [...element.querySelectorAll(selector)].filter(target => target.tabIndex >= 0 && target.checkVisibility({ checkVisibilityCSS: true }) && !target.closest('[hidden],[inert]')).at(-1), focusable), true)
  await record('shift-tab-wrap')
  const beforeClosing = await page.evaluate(() => scrollY)
  const closing = await observeAction(page, () => page.keyboard.press('Escape'), 'keydown')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toBeFocused()
  assert.equal(await page.locator('[data-xp-shell-content]').evaluate(element => element.inert), false)
  const after = await page.evaluate(() => scrollY)
  observations.push({ check: 'mobile-overlay', focus_destinations: endpoints.count, long_form_scroll: requireLongScroll, scroll_maximum: before.maximum, scroll_before: before.y, scroll_before_escape: beforeClosing, scroll_after: after, opening, closing })
  assert.ok(Math.abs(after - before.y) <= 1, `Escape must preserve the real document scroll position (${before.y} to ${after})`)
}

async function navigate(page, state, expect, observations) {
  await currentPage(page, state.path, expect)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await currentPage(page, state.path, expect)
  assertContext(page.url(), state)
  if (state.width < 960) {
    await mobileOverlay(page, expect, observations)
    await page.locator('[data-action="toggle-mobile-nav"]').click()
  }
  const link = page.locator(`[data-xp-sidebar] a[data-nav-route="${state.to}"]`)
  await expect(link).toHaveCount(1)
  // A real native details summary exposes the destination; no DOM force-click bypass.
  const section = link.locator('xpath=ancestor::details[1]')
  if (await section.count() && !await section.evaluate(element => element.open)) await section.locator(':scope > summary').click()
  await link.click()
  await page.waitForURL(url => url.pathname === state.to)
  await expect(page.locator(state.target)).toBeVisible()
  await currentPage(page, state.to, expect)
  assertContext(page.url(), state, { path: state.to })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await currentPage(page, state.to, expect)
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await currentPage(page, state.path, expect)
  await expect(page.locator(state.marker)).toBeVisible()
  assertContext(page.url(), state)
  await page.goForward({ waitUntil: 'domcontentloaded' })
  await currentPage(page, state.to, expect)
  await expect(page.locator(state.target)).toBeVisible()
  assertContext(page.url(), state, { path: state.to })
  await openToolbar(page)
  const theme = page.locator('[data-theme-toggle]').first()
  await theme.click()
  await page.waitForURL(url => url.searchParams.get('theme') === 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  assertContext(page.url(), state, { path: state.to, theme: 'dark' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await openToolbar(page)
  const nextLocale = state.locale === 'en' ? 'ar' : 'en'
  await page.locator('[data-lang-switch]').first().click()
  await page.waitForURL(url => url.searchParams.get('lang') === nextLocale)
  await expect(page.locator('html')).toHaveAttribute('lang', nextLocale)
  assertContext(page.url(), state, { path: state.to, theme: 'dark', locale: nextLocale })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await currentPage(page, state.to, expect)
  assertContext(page.url(), state, { path: state.to, theme: 'dark', locale: nextLocale })
  const finalFonts = await fontGate(page, nextLocale)
  observations.push({ check: 'document-history-theme-language', source: state.path, destination: state.to, reload: true, back: true, forward: true, actual_theme_click: true, actual_language_click: true, context_persisted: true, final_fonts: finalFonts })
}

async function boundary(page, state, expect, observations) {
  const sidebar = page.locator('[data-xp-sidebar]'), toggle = page.locator('[data-action="toggle-mobile-nav"]')
  if (state.kind === 'palette-return') {
    await expect(toggle).toBeHidden()
    await expect(sidebar).toBeVisible()
    await page.locator('[data-action="open-cmdk"]').first().click()
    await expect(page.locator('#xp-cmdk-input')).toBeFocused()
    await page.setViewportSize({ width: 959, height: 900 })
    await frames(page)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-xp-cmdk]')).toBeHidden()
  } else {
    await expect(toggle).toBeVisible()
    if (state.kind === 'sheet-close') {
      await toggle.click()
      await sidebar.locator('.xp-mobile-nav-close').focus()
      await expect(sidebar.locator('.xp-mobile-nav-close')).toBeFocused()
    } else {
      await page.locator('[data-xp-toolbar-options] > summary').focus()
      await expect(page.locator('[data-xp-toolbar-options] > summary')).toBeFocused()
    }
    await page.setViewportSize({ width: 960, height: 900 })
    await frames(page)
    await expect(toggle).toBeHidden()
    await expect(sidebar).toBeVisible()
    assert.equal(await page.locator('[data-xp-shell-content]').evaluate(element => element.inert), false)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  }
  const focus = await usableFocus(page)
  observations.push({ check: 'boundary-focus', direction: state.kind === 'palette-return' ? '960-to-959' : '959-to-960', scenario: state.kind, focus })
  assert.equal(focus.visible, true, 'A breakpoint transition must leave keyboard focus on a visible usable destination')
  await page.keyboard.press(state.kind === 'palette-return' ? 'Shift+Tab' : 'Tab')
  assert.equal((await usableFocus(page)).visible, true)
}

async function fields(page, state, expect, observations) {
  if (state.path === '/login') {
    await page.locator('#login-username').fill('synthetic_123')
    await page.locator('#login-password').fill('Synthetic123!')
    await page.locator('[data-action="toggle-password"]').click()
    await expect(page.locator('#login-password')).toHaveAttribute('type', 'text')
  }
  const values = await page.evaluate(({ ids, legacyLogin }) => ids.map(id => {
    const control = document.getElementById(id), label = document.querySelector(`label[for="${id}"]`)
    if (!control || !label || !label.textContent.trim() || !label.checkVisibility() || !control.checkVisibility()) return { id, missing: true }
    const range = document.createRange(); range.selectNodeContents(label)
    const a = range.getBoundingClientRect(), b = control.getBoundingClientRect(), style = getComputedStyle(control), rtl = document.dir === 'rtl'
    const labelEdge = rtl ? a.right : a.left
    const valueEdge = legacyLogin ? (rtl ? b.right : b.left) : (rtl ? b.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) : b.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth))
    return { id, missing: false, label_bottom: a.bottom, label_edge: labelEdge, value_top: b.top, value_edge: valueEdge, edge_basis: legacyLogin ? 'pending-native-input-range' : 'native-control-text-content-box', edge_delta: Math.abs(labelEdge - valueEdge), width: b.width, height: b.height, direction: style.direction, align: style.textAlign, native_select: control.tagName === 'SELECT' }
  }), { ids: state.fields, legacyLogin: state.path === '/login' })
  if (state.path === '/login') {
    const cdp = await page.context().newCDPSession(page)
    try {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
      const descend = node => [node, ...(node.children ?? []).flatMap(descend), ...(node.shadowRoots ?? []).flatMap(descend)]
      const nodes = descend(root)
      for (const value of values) {
        const inputs = nodes.filter(node => node.nodeName === 'INPUT' && node.attributes?.some((item, index, attrs) => item === 'id' && attrs[index + 1] === value.id))
        assert.equal(inputs.length, 1, 'Resolve exactly one login input for actual text measurement')
        const text = (inputs[0].shadowRoots ?? []).flatMap(descend).filter(node => node.nodeType === 3 && node.nodeValue.length > 0)
        assert.equal(text.length, 1, 'A nonempty native login value must be observable; a mirrored field cannot pass')
        const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: text[0].backendNodeId })
        const measured = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { const range = document.createRange(); range.selectNodeContents(this); const box = range.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, width: box.width, length: this.textContent.length } }', returnByValue: true })
        assert.ok(!measured.exceptionDetails && measured.result.value?.width > 0 && measured.result.value.length > 0)
        value.rendered_value = measured.result.value
        value.value_edge = state.locale === 'ar' ? value.rendered_value.right : value.rendered_value.left
        value.edge_basis = 'actual-native-input-text-range'
        value.edge_delta = Math.abs(value.label_edge - value.value_edge)
      }
    } finally { await cdp.detach() }
  }
  // The closed native SELECT text lives in Chromium's UA shadow tree, not the OPTION box.
  // Measure that actual rendered text Range so an extra native inner inset cannot pass.
  if (values.some(value => value.native_select)) {
    const cdp = await page.context().newCDPSession(page)
    try {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
      const find = (node, id) => node.nodeName === 'SELECT' && node.attributes?.some((value, index, attrs) => value === 'id' && attrs[index + 1] === id) ? node : [...(node.children ?? []), ...(node.shadowRoots ?? [])].map(child => find(child, id)).find(Boolean)
      for (const value of values.filter(value => value.native_select)) {
        const select = find(root, value.id)
        const inner = select?.shadowRoots?.flatMap(node => node.children ?? []).find(node => node.attributes?.includes('-internal-select-inner-element'))
        assert.ok(inner, 'The actual native SELECT value element must be observable')
        const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: inner.backendNodeId })
        const measured = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { const range = document.createRange(); range.selectNodeContents(this); const box = range.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width, text: this.textContent } }', returnByValue: true })
        assert.ok(measured.result.value.width > 0)
        value.rendered_value = measured.result.value
        value.value_edge = state.locale === 'ar' ? value.rendered_value.right : value.rendered_value.left
        value.edge_basis = 'actual-native-select-text-range'
        value.edge_delta = Math.abs(value.label_edge - value.value_edge)
      }
    } finally { await cdp.detach() }
  }
  assert.equal(values.length, state.fields.length)
  assert.ok(values.length >= 2)
  for (const value of values) {
    assert.equal(value.missing, false, `Explicit field contract ${value.id} must exist and be visible`)
    assert.ok(value.edge_delta <= 1, `Field ${value.id} shares its label's logical content edge`)
    assert.ok(value.value_top >= value.label_bottom - 1, `Field ${value.id} lies below its label`)
    assert.ok(value.width >= 44 && value.height >= 44)
    if (state.locale === 'ar' && value.direction === 'ltr') assert.equal(value.align, 'right')
  }
  if (state.path !== '/login') await currentPage(page, state.path, expect)
  observations.push({ check: 'explicit-field-alignment', expected: state.fields.length, measured: values.length, values })
}

async function summary(page, state, expect, observations) {
  await expect(page.locator('[data-workspace-identity]')).toBeVisible()
  await expect(page.locator('[data-workspace-account-overview]')).toBeVisible()
  await expect(page.locator('[data-workspace-field]')).toHaveCount(5)
  await expect(page.locator('[data-navigation-empty]')).toHaveCount(0)
  await expect(page.locator('[data-nav-wiring="soon"]').first()).toBeAttached()
  if (state.width < 960) {
    await page.locator('[data-action="toggle-mobile-nav"]').click()
    await expect(page.locator('[data-xp-sidebar] a[data-nav-route="/home"]')).toBeVisible()
    await page.keyboard.press('Escape')
  } else await expect(page.locator('[data-xp-sidebar] a[data-nav-route="/home"]')).toBeVisible()
  await expect(page.locator('[data-xp-sidebar] a[data-nav-route]')).not.toHaveCount(0)
  await expect(page.locator('[data-tool-availability="unverified"]')).toBeVisible()
  await expect(page.locator('[data-workspace-field="username"] .xp-field-value')).toHaveText('preview')
  await expect(page.locator('[data-workspace-field="primary-domain"] .xp-field-value')).toHaveText('preview.example.test')
  await expect(page.locator('[data-workspace-field="plan"] .xp-field-value')).toHaveText('Synthetic Standard')
  assert.equal(await page.locator('h1').count(), 1)
  const values = await page.locator('[data-workspace-field]').evaluateAll(elements => elements.map(element => {
    const label = element.querySelector('.xp-label'), value = element.querySelector('.xp-field-value')
    if (!label || !value || !label.textContent.trim() || !value.textContent.trim()) return { field: element.dataset.workspaceField, missing: true }
    // Selecting an element's contents can include full-width descendant block boxes.
    // Text-node ranges measure the painted inline text, including text inside a block bdi.
    const textRects = node => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), rects = []
      let text
      while ((text = walker.nextNode())) {
        if (!text.textContent.trim()) continue
        const range = document.createRange(); range.selectNodeContents(text)
        for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) rects.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height })
      }
      return rects
    }
    const labelRects = textRects(label), valueRects = textRects(value), rtl = document.dir === 'rtl'
    if (!labelRects.length || !valueRects.length) return { field: element.dataset.workspaceField, missing: true, label_text_rects: labelRects.length, value_text_rects: valueRects.length }
    const labelEdge = rtl ? Math.max(...labelRects.map(rect => rect.right)) : Math.min(...labelRects.map(rect => rect.left))
    return { field: element.dataset.workspaceField, missing: false, edge_delta: Math.max(...valueRects.map(rect => Math.abs(labelEdge - (rtl ? rect.right : rect.left)))), label_bottom: Math.max(...labelRects.map(rect => rect.bottom)), value_top: Math.min(...valueRects.map(rect => rect.top)), label_text_rects: labelRects, value_text_rects: valueRects, bdi: [...value.querySelectorAll('bdi')].map(node => ({ direction: getComputedStyle(node).direction, isolate: getComputedStyle(node).unicodeBidi.includes('isolate') })) }
  }))
  assert.equal(values.length, 5)
  assert.deepEqual(values.map(value => value.field).sort(), ['plan', 'primary-domain', 'role', 'status', 'username'])
  observations.push({ check: 'unqualified-workspace-summary', catalog_qualification_override: false, alignment_measurement: 'nonempty_text_node_ranges_per_line', expected_fields: 5, measured_fields: values.length, values, authorization_proof: false, escaping_proof: 'Exact rendered synthetic text and no script nodes; adversarial escaping belongs to separate renderer tests.' })
  for (const value of values) {
    assert.equal(value.missing, false)
    assert.ok(value.edge_delta <= 1, `Summary field ${value.field} must share its label's logical edge`)
    assert.ok(value.value_top >= value.label_bottom - 1)
    for (const bdi of value.bdi) { assert.equal(bdi.direction, 'ltr'); assert.equal(bdi.isolate, true) }
  }
  assert.equal(values.flatMap(value => value.bdi).length, 2, 'Domain and session username must expose actual isolated values')
  assert.equal(await page.locator('[data-workspace-identity] script,[data-workspace-account-overview] script').count(), 0)
}

const paletteRows = '[data-cmdk-row]:not([hidden])'
const paletteOptions = `${paletteRows} a[data-cmdk-item]`

async function openPalette(page, expect) {
  await page.locator('#main-content').evaluate(element => element.focus({ preventScroll: true }))
  await page.keyboard.press('Control+k')
  await expect(page.locator('[data-xp-cmdk]')).toBeVisible()
  await expect(page.locator('[data-cmdk-search]')).toBeFocused()
  await expect(page.locator('[data-cmdk-search]')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('[data-cmdk-results]')).toHaveAttribute('role', 'listbox')
}

async function selectedPaletteOption(page, expect, index) {
  const options = page.locator(paletteOptions), selected = options.nth(index)
  await expect(selected).toHaveAttribute('role', 'option')
  await expect(selected).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-cmdk-search]')).toBeFocused()
  await expect(page.locator('[data-cmdk-search]')).toHaveAttribute('aria-activedescendant', await selected.getAttribute('id'))
  await expect(page.locator('[data-cmdk-item][aria-selected="true"]')).toHaveCount(1)
  return selected
}

async function paletteFilter(page, state, expect, observations) {
  await openPalette(page, expect)
  const input = page.locator('[data-cmdk-search]'), options = page.locator(paletteOptions)
  const routes = await options.evaluateAll(elements => elements.map(element => element.dataset.cmdkItem))
  const fileIndex = routes.indexOf('/files/manager'), label = state.locale === 'ar' ? 'مدير الملفات' : 'File manager'
  assert.ok(fileIndex >= 8, 'Search must find a real destination beyond the former first-eight truncation')
  await expect(page.locator('[data-cmdk-item="/files/manager"] strong')).toHaveText(label)
  const href = await page.locator('[data-cmdk-item="/files/manager"]').getAttribute('href')
  assertContext(new URL(href, page.url()).href, state, { path: '/files/manager' })
  await input.fill(label)
  await expect(options).toHaveCount(1)
  await expect(page.locator('[data-cmdk-empty]')).toBeHidden()
  await selectedPaletteOption(page, expect, 0)
  await expect(page.locator('[data-cmdk-status]')).toHaveText(state.locale === 'ar' ? 'النتائج: 1' : 'Results: 1')
  await input.fill('unmatched-navigation-result-xyz')
  await expect(options).toHaveCount(0)
  await expect(page.locator('[data-cmdk-empty]')).toBeVisible()
  assert.equal(await input.getAttribute('aria-activedescendant'), null)
  await expect(page.locator('[data-cmdk-item][aria-selected="true"]')).toHaveCount(0)
  await expect(page.locator('[data-cmdk-status]')).toHaveText('')
  await page.keyboard.press('Enter')
  assertContext(page.url(), state)
  await expect(input).toBeFocused()
  await input.fill('')
  await expect(options).toHaveCount(routes.length)
  await expect(page.locator('[data-cmdk-empty]')).toBeHidden()
  await selectedPaletteOption(page, expect, 0)
  await page.keyboard.press('ArrowUp')
  await selectedPaletteOption(page, expect, routes.length - 1)
  await page.keyboard.press('ArrowDown')
  await selectedPaletteOption(page, expect, 0)
  await page.keyboard.press('ArrowDown')
  await selectedPaletteOption(page, expect, 1)
  await input.fill(label)
  await selectedPaletteOption(page, expect, 0)
  await page.keyboard.press('Enter')
  await page.waitForURL(url => url.pathname === '/files/manager')
  await expect(page.locator('[data-file-manager-table]')).toBeVisible()
  await currentPage(page, '/files/manager', expect)
  assertContext(page.url(), state, { path: '/files/manager' })
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await currentPage(page, state.path, expect)
  assertContext(page.url(), state)
  observations.push({ check: 'palette-localized-filter-and-navigation', destination: '/files/manager', original_index: fileIndex, full_result_count: routes.length, localized_label: label, zero_results: true, clear_recovery: true, arrow_wrap: true, actual_enter_navigation: true, back_context: true })
}

async function paletteScroll(page, state, expect, observations, capture) {
  await page.locator('#main-content').evaluate(element => element.focus({ preventScroll: true }))
  await page.evaluate(() => scrollTo(0, Math.min(180, Math.max(0, document.documentElement.scrollHeight - innerHeight))))
  await frames(page)
  const before = await page.evaluate(() => scrollY)
  await page.keyboard.press('Control+k')
  await expect(page.locator('[data-cmdk-search]')).toBeFocused()
  const options = page.locator(paletteOptions), count = await options.count()
  assert.ok(count > 8)
  const initial = await page.locator('[data-cmdk-results]').evaluate(element => ({ top: element.scrollTop, maximum: element.scrollHeight - element.clientHeight }))
  assert.equal(initial.top, 0)
  assert.ok(initial.maximum > 100, 'The palette scroll check must contain a genuinely overflowing list')
  await page.keyboard.press('ArrowUp')
  await selectedPaletteOption(page, expect, count - 1)
  await expect.poll(async () => page.locator('[data-cmdk-results]').evaluate(element => element.scrollTop), { timeout: 2000 }).toBeGreaterThan(100)
  const final = await page.locator('[data-cmdk-results]').evaluate(element => {
    const list = element.getBoundingClientRect(), selected = element.querySelector('[aria-selected="true"]').getBoundingClientRect()
    return { scroll_top: element.scrollTop, document_y: scrollY, selected_top: selected.top, selected_bottom: selected.bottom, list_top: list.top, list_bottom: list.bottom, document_width: document.documentElement.scrollWidth, viewport_width: innerWidth }
  })
  assert.ok(final.scroll_top > 100, 'Arrow navigation must scroll the result list')
  assert.ok(final.selected_top >= final.list_top - 1 && final.selected_bottom <= final.list_bottom + 1, 'The selected result must remain inside the list viewport')
  assert.ok(Math.abs(final.document_y - before) <= 1, 'Scrolling the result list must preserve the background document position')
  assert.ok(final.document_width <= final.viewport_width + 1, 'The palette must fit the actual viewport')
  const screenshot = await capture('open-palette')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-xp-cmdk]')).toBeHidden()
  await expect(page.locator('#main-content')).toBeFocused()
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - before) <= 1)
  observations.push({ check: 'palette-internal-scroll-and-focus-return', result_count: count, scroll_before: before, initial, final, screenshot, escape_return: 'main-content' })
}

async function paletteNativeInput(page, state, expect, observations) {
  const subject = page.locator('#compose-subject')
  await subject.fill('Native input')
  await page.keyboard.type('/gd')
  await expect(subject).toHaveValue('Native input/gd')
  await expect(subject).toBeFocused()
  await expect(page.locator('[data-xp-cmdk]')).toBeHidden()
  assertContext(page.url(), state)
  const body = page.locator('#compose-body')
  await body.fill('Native textarea')
  await page.keyboard.type('/ga')
  await expect(body).toHaveValue('Native textarea/ga')
  await expect(body).toBeFocused()
  assertContext(page.url(), state)
  await page.locator('#main-content').evaluate(element => element.focus({ preventScroll: true }))
  await page.keyboard.press('/')
  await expect(page.locator('[data-cmdk-search]')).toBeFocused()
  await page.keyboard.type('/')
  await expect(page.locator('[data-cmdk-search]')).toHaveValue('/')
  await page.keyboard.press('Escape')
  await expect(page.locator('#main-content')).toBeFocused()
  observations.push({ check: 'native-slash-and-chord-text-preserved', controls: ['compose-subject', 'compose-body'], text_values: ['Native input/gd', 'Native textarea/ga'], palette_query_slash_preserved: true })
}

async function paletteVisibility(page, state, expect, observations) {
  if (state.kind === 'palette-unqualified') {
    await expect(page.locator('[data-xp-cmdk],[data-action="open-cmdk"],[data-cmdk-item]')).toHaveCount(0)
    await expect(page.locator('[data-xp-sidebar] a[data-nav-route]')).not.toHaveCount(0)
    await page.locator('#main-content').focus()
    for (const key of ['Control+k', '/', 'g', 'a', 'g', 'f']) await page.keyboard.press(key)
    assertContext(page.url(), state)
    await expect(page.locator('[data-xp-cmdk],[data-cmdk-item]')).toHaveCount(0)
    observations.push({ check: 'unqualified-palette-absence', synthetic_original_catalog: true, palette_count: 0, enabled_shortcut_destinations: 0, production_authorization_proof: false })
    return
  }
  await openPalette(page, expect)
  const actual = await page.locator('[data-cmdk-item]').evaluateAll(elements => elements.map(element => element.dataset.cmdkItem).sort())
  const sidebar = await page.locator('[data-xp-sidebar] a[data-nav-route]').evaluateAll(elements => elements.map(element => element.dataset.navRoute).sort())
  assert.ok(actual.length > 8)
  assert.ok(sidebar.includes('/home') && sidebar.includes('/design/system'), 'The design sidebar lists the board pages')
  assert.ok(!actual.includes('/design/system'), 'The command palette stays on qualified catalog pages')
  assert.ok(actual.every(path => path !== '/whm' && !path.startsWith('/whm/')), 'The account-owner palette must omit administrator destinations')
  await page.locator('[data-cmdk-search]').fill('/whm')
  await expect(page.locator(paletteOptions)).toHaveCount(0)
  await expect(page.locator('[data-cmdk-empty]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#main-content')).toBeFocused()
  observations.push({ check: 'synthetic-owner-palette-visibility', owner_result_count: actual.length, exact_sidebar_match: true, enabled_admin_destinations: 0, production_authorization_proof: false })
}

async function contextualShortcuts(page, state, expect, observations) {
  const checks = state.surface === 'panel' ? [['f', '/files/manager'], ['d', '/home'], ['a', '/home']]
    : state.surface === 'whm' ? [['a', '/whm/accounts'], ['d', '/whm'], ['f', '/whm']]
    : [['d', '/mail/inbox'], ['a', '/mail/inbox'], ['f', '/mail/inbox']]
  const completed = []
  for (const [key, path] of checks) {
    const before = page.url()
    await page.locator('#main-content').evaluate(element => element.focus({ preventScroll: true }))
    await page.keyboard.press('g')
    await page.keyboard.press(key)
    if (new URL(before).pathname !== path) await page.waitForURL(url => url.pathname === path)
    assertContext(page.url(), state, { path })
    await currentPage(page, path, expect)
    completed.push({ chord: `g ${key}`, path, navigated: before !== page.url() })
  }
  observations.push({ check: 'contextual-chord-shortcuts', surface: state.surface, checks: completed })
}

export async function runNavigationAcceptance({ output, filter } = {}) {
  assert.equal(process.versions.node, readFileSync(join(root, '.node-version'), 'utf8').trim(), 'Use the pinned workspace launcher')
  const destination = resolve(output ?? join(root, 'test-results/navigation', `run-${new Date().toISOString().replaceAll(/[-:.]/g, '')}`))
  if (existsSync(destination)) throw new Error('Refusing to overwrite navigation acceptance evidence')
  mkdirSync(join(destination, 'screenshots'), { recursive: true })
  const before = fingerprint(destination, 'before')
  const selected = states.filter(state => !filter || state.id.includes(filter))
  assert.ok(selected.length > 0, 'The requested case filter must select actual cases')
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(root, '.tools/playwright-browsers')
  const { chromium, expect } = await import('@playwright/test')
  const fixture = await createVisualFixture()
  const unqualifiedFixture = await createVisualFixture({ qualifiedCatalog: false })
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), timeout: 20000 })
  const outcomes = [], started = Date.now()
  try {
    for (const state of selected) {
      const outcome = { ...state, status: 'running', observations: [], page_errors: [], console_errors: [], mutations: [], websockets: [] }
      const context = await browser.newContext({ viewport: { width: state.width, height: state.height ?? (state.width < 960 ? 800 : 900) }, colorScheme: 'light', reducedMotion: state.kind === 'motion' ? 'reduce' : 'no-preference' })
      const page = await context.newPage()
      page.setDefaultTimeout(8000)
      await context.route('**/*', async route => {
        if (!['GET', 'HEAD'].includes(route.request().method())) { outcome.mutations.push({ method: route.request().method() }); await route.abort(); return }
        await route.continue()
      })
      page.on('pageerror', error => outcome.page_errors.push(String(error.message).slice(0, 200)))
      page.on('console', message => { if (message.type() === 'error') outcome.console_errors.push({ text: message.text().slice(0, 200), url: message.location().url }) })
      page.on('websocket', () => outcome.websockets.push('attempted'))
      try {
        const url = new URL(state.path, ['summary', 'palette-unqualified'].includes(state.kind) ? unqualifiedFixture.baseUrl : fixture.baseUrl)
        for (const [key, value] of Object.entries({ lang: state.locale, theme: 'light', density: 'compact', accountId: 'visual-account' })) url.searchParams.set(key, value)
        assert.equal((await page.goto(url.href, { waitUntil: 'domcontentloaded' })).status(), 200)
        await expect(page.locator('html')).toHaveAttribute('data-visual-fixture', 'synthetic')
        await expect(page.locator('[data-visual-fixture-watermark]')).toBeVisible()
        outcome.fonts = await fontGate(page, state.locale)
        const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scroll_width: document.documentElement.scrollWidth, ascii_digits: !/[\u0660-\u0669\u06f0-\u06f9]/.test(document.body.innerText) }))
        assert.ok(geometry.scroll_width <= geometry.width + 1)
        assert.equal(geometry.ascii_digits, true)
        outcome.geometry = geometry
        if (state.kind === 'navigation') await navigate(page, state, expect, outcome.observations)
        else if (state.kind === 'fields') await fields(page, state, expect, outcome.observations)
        else if (state.kind === 'summary') await summary(page, state, expect, outcome.observations)
        else if (state.kind === 'palette-filter') await paletteFilter(page, state, expect, outcome.observations)
        else if (state.kind === 'palette-scroll') await paletteScroll(page, state, expect, outcome.observations, async suffix => {
          const screenshot = `screenshots/${state.id}-${suffix}.png`
          await page.screenshot({ path: join(destination, screenshot), fullPage: true })
          return screenshot
        })
        else if (state.kind === 'palette-native-input') await paletteNativeInput(page, state, expect, outcome.observations)
        else if (['palette-owner', 'palette-unqualified'].includes(state.kind)) await paletteVisibility(page, state, expect, outcome.observations)
        else if (state.kind === 'shortcut-context') await contextualShortcuts(page, state, expect, outcome.observations)
        else if (state.kind === 'shortcut') {
          await page.locator('#main-content').focus()
          await page.keyboard.press('/')
          await expect(page.locator('[data-xp-cmdk]')).toBeVisible()
          await expect(page.locator('#xp-cmdk-input')).toBeFocused()
          await page.keyboard.press('Escape')
          await expect(page.locator('[data-xp-cmdk]')).toBeHidden()
          await expect(page.locator('#main-content')).toBeFocused()
          outcome.observations.push({ check: 'slash-search', destination: 'palette' })
        }
        else if (state.kind === 'unavailable') {
          const links = await page.locator('[data-xp-sidebar] a[data-nav-route]').evaluateAll(elements => elements.map(element => element.getAttribute('href')))
          assert.ok(links.length > 1, 'Owner navigation assertion requires actual available destinations')
          assert.ok(links.every(href => { const path = new URL(href, page.url()).pathname; return path !== '/whm' && !path.startsWith('/whm/') }), 'Owner navigation must not enable administrator tools')
          const unknown = await page.goto(new URL('/no-such-navigation-document', fixture.baseUrl).href, { waitUntil: 'domcontentloaded' })
          assert.equal(unknown.status(), 404)
          assert.equal(await page.locator('a[data-nav-route],button[data-action]').count(), 0)
          outcome.observations.push({ check: 'synthetic-owner-and-unknown', owner_destinations: links.length, enabled_admin_destinations: 0, unknown_status: 404 })
        } else if (state.kind === 'scroll') {
          // A usable shorter phone viewport supplies real overflow after compact styling.
          // Verify actual form content rather than adding fixture padding or counting its watermark.
          const form = page.locator('[data-create-account-form]')
          await expect(form).toHaveCount(1)
          await expect(form).toBeVisible()
          const controlIds = ['new-acc-username', 'new-acc-domain', 'new-acc-plan', 'new-acc-ipv4', 'new-acc-ipv6']
          for (const id of controlIds) await expect(page.locator(`#${id}`)).toBeVisible()
          await expect(form.locator('button[type="submit"]')).toBeVisible()
          const content = await form.evaluate((element, ids) => {
            const rect = element.getBoundingClientRect(), submission = element.querySelector('button[type="submit"]'), submissionRect = submission.getBoundingClientRect()
            return { viewport_height: innerHeight, form_height: rect.height, form_content_scroll_maximum: rect.bottom + scrollY - innerHeight, controls: ids.map(id => { const control = document.getElementById(id), bounds = control.getBoundingClientRect(); return { id, visible: control.checkVisibility({ checkVisibilityCSS: true }), width: bounds.width, height: bounds.height } }), submission: { visible: submission.checkVisibility({ checkVisibilityCSS: true }), width: submissionRect.width, height: submissionRect.height } }
          }, controlIds)
          assert.equal(content.viewport_height, state.height)
          assert.equal(content.controls.length, 5)
          for (const control of [...content.controls, content.submission]) { assert.equal(control.visible, true); assert.ok(control.width >= 44 && control.height >= 44) }
          assert.ok(content.form_content_scroll_maximum > 100, 'Actual visible form content must extend more than 100px beyond the viewport')
          outcome.observations.push({ check: 'real-form-scroll-precondition', ...content })
          await mobileOverlay(page, expect, outcome.observations, { requireLongScroll: true })
          assertContext(page.url(), state)
        } else if (state.kind === 'motion') {
          await mobileOverlay(page, expect, outcome.observations)
          const motion = await page.evaluate(() => ({ preference: matchMedia('(prefers-reduced-motion: reduce)').matches, transitions: [...document.querySelectorAll('[data-xp-sidebar],[data-xp-nav-backdrop]')].map(element => ({ transition: getComputedStyle(element).transitionDuration, animation: getComputedStyle(element).animationDuration })) }))
          assert.equal(motion.preference, true)
          assert.equal(motion.transitions.length, 2)
          for (const values of motion.transitions) for (const duration of [values.transition, values.animation]) assert.ok(duration.split(',').every(value => Number.parseFloat(value) <= 0.001), 'Reduced motion must remove sheet/backdrop movement')
          outcome.observations.push({ check: 'reduced-motion', ...motion })
        } else await boundary(page, state, expect, outcome.observations)
        const unexpected = outcome.console_errors.filter(error => !/fonts\.(?:googleapis|gstatic)\.com/.test(`${error.url} ${error.text}`) && !/\/api\/auth\/me(?:\?|$)/.test(error.url) && !(state.kind === 'unavailable' && /\/no-such-navigation-document$/.test(error.url)))
        assert.deepEqual(unexpected, [], 'No unexpected application console errors')
        assert.deepEqual(outcome.page_errors, [])
        assert.deepEqual(outcome.mutations, [])
        assert.deepEqual(outcome.websockets, [])
        outcome.status = 'passed'
      } catch (error) {
        outcome.status = 'failed'
        outcome.failure = { name: error.name, message: String(error.message).slice(0, 1000), stack: String(error.stack).split('\n').slice(0, 10) }
      } finally {
        outcome.screenshot = `screenshots/${state.id}.png`
        await page.screenshot({ path: join(destination, outcome.screenshot), fullPage: true }).catch(error => { outcome.screenshot_error = String(error.message).slice(0, 200) })
        await context.close()
        outcomes.push(outcome)
        process.stdout.write(`${JSON.stringify({ id: state.id, status: outcome.status, failure: outcome.failure?.message })}\n`)
      }
    }
  } finally { await browser.close(); await fixture.close(); await unqualifiedFixture.close() }
  const after = fingerprint(destination, 'after'), initial = new Map(before.files.map(file => [file.path, file.sha256])), final = new Map(after.files.map(file => [file.path, file.sha256]))
  const drift = [...new Set([...initial.keys(), ...final.keys()])].filter(path => initial.get(path) !== final.get(path)).sort()
  const actions = outcomes.flatMap(outcome => outcome.observations.flatMap(observation => observation.check === 'mobile-overlay' ? [observation.opening, observation.closing] : []))
  const times = actions.map(action => action.event_to_second_frame_ms).filter(Number.isFinite).sort((a, b) => a - b)
  const observations = outcomes.flatMap(outcome => outcome.observations)
  const measurements = { local_input_events: times.length, event_to_second_frame_ms: { minimum: times[0] ?? null, median: times.length ? times[Math.floor(times.length / 2)] : null, p95: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null, maximum: times.at(-1) ?? null }, observed_layout_shift_entries: actions.reduce((sum, action) => sum + action.shifts.length, 0), layout_shift_value_sum_including_recent_input: actions.reduce((sum, action) => sum + action.shifts.reduce((total, shift) => total + shift.value, 0), 0), fonts_ready: outcomes.filter(outcome => outcome.fonts?.ready).length, actual_locale_font_loaded: outcomes.filter(outcome => outcome.fonts?.faces.some(face => face.family === outcome.fonts.family && face.status === 'loaded')).length, explicit_control_fields: observations.filter(value => value.check === 'explicit-field-alignment').reduce((sum, value) => sum + value.measured, 0), workspace_summary_fields: observations.filter(value => value.check === 'unqualified-workspace-summary').reduce((sum, value) => sum + value.measured_fields, 0) }
  const report = { schema_version: 1, captured_at: new Date().toISOString(), status: outcomes.every(outcome => outcome.status === 'passed') && drift.length === 0 ? 'passed' : 'failed', runtime: process.version, environment: { platform: process.platform, browser: browser.version(), headless: true, loopback: true, cpu_throttling: 'none', network_throttling: 'none', external_fonts: true, viewport_emulation_only: true, physical_touch_device: false }, scope: { filter: filter ?? null, full_suite_case_count: states.length, executed_case_count: selected.length, initial_widths: [...new Set(selected.map(state => state.width))].sort((a, b) => a - b), initial_heights: [...new Set(selected.map(state => state.height ?? (state.width < 960 ? 800 : 900)))].sort((a, b) => a - b), boundary_widths: selected.some(state => ['sheet-close', 'toolbar-summary', 'palette-return'].includes(state.kind)) ? [959, 960] : [], locales: [...new Set(selected.map(state => state.locale))], qualified_catalog_test_states: selected.filter(state => !['summary', 'palette-unqualified'].includes(state.kind)).length, original_unqualified_catalog_states: selected.filter(state => ['summary', 'palette-unqualified'].includes(state.kind)).length }, tests: { total: outcomes.length, passed: outcomes.filter(outcome => outcome.status === 'passed').length, failed: outcomes.filter(outcome => outcome.status === 'failed').length }, measurements, duration_ms: Date.now() - started, source: { before_sha256: before.sha256, after_sha256: after.sha256, files: before.files.length, drift }, limits: ['Synthetic catalog and principals are test-only; no authentication, authorization enforcement, host command, hosting service or production qualification.', 'Theme persistence means selected URL context survives document navigation and reload; this suite does not require a browser storage preference absent from the product contract.', 'Input-event-to-second-frame measurements use browser performance.now and requestAnimationFrame. Action-to-second-frame durations also include automation dispatch. Neither is INP. Layout-shift entries include recent-input flags and are not a page CLS qualification.', 'Sampled shell routes, explicit field contracts, two locales and selected breakpoints do not certify every screen or accessibility requirement.', 'No mounted page currently exposes a visible page-filter input outside the command palette; that visible-filter preservation branch remains covered by separate unit DOM tests. Browser cases exercise native input/textarea slash typing and the palette search input without inventing a production page filter.'], outcomes }
  writeFileSync(join(destination, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(destination, 'README.md'), `# Synthetic navigation acceptance\n\n${report.tests.passed}/${report.tests.total} cases passed; source drift: ${drift.length}.\n\nSee [results](results.json). Font faces, field counts, focus observations, action-to-second-frame timings and layout-shift entries are recorded per case.\n\n${report.limits.map(value => `- ${value}`).join('\n')}\n`)
  process.stdout.write(`${JSON.stringify({ status: report.status, tests: report.tests, drift: drift.length })}\n`)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runNavigationAcceptance({ output: process.argv.find(argument => argument.startsWith('--output='))?.slice(9), filter: process.argv.find(argument => argument.startsWith('--filter='))?.slice(9) })
  process.exitCode = report.status === 'passed' ? 0 : 1
}
