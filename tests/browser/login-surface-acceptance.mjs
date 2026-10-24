import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveWebUi } from '../../apps/web/src/index.ts'
import { assertAppliedFont } from './applied-font-contract.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const audiences = { xpanel: 'xPanel', xwhm: 'xWHM', xmail: 'xMail' }
const headings = { xpanel: { en: 'Account sign in', ar: 'دخول الحساب' }, xwhm: { en: 'Server sign in', ar: 'دخول إدارة الخادم' }, xmail: { en: 'Mail sign in', ar: 'دخول البريد' } }
const widths = [320, 360, 390, 768, 1440]
const matrix = Object.keys(audiences).flatMap(audience => ['en', 'ar'].flatMap(locale => ['light', 'dark'].flatMap(theme => widths.map(width => ({ audience, locale, theme, width, id: `${audience}-${locale}-${theme}-${width}` })))))
const inputs = ['apps/web/src/app.ts', 'apps/web/src/tokens.ts', 'apps/web/src/surfaces/login.ts', 'apps/web/src/login-client.ts', 'apps/web/src/document-routes.ts', 'tests/browser/login-surface-acceptance.mjs', 'tests/browser/applied-font-contract.mjs']
const fingerprint = () => inputs.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') }))

async function createLoginFixture(audience) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (!['GET', 'HEAD'].includes(incoming.method)) { incoming.resume(); outgoing.writeHead(405, { allow: 'GET, HEAD' }); outgoing.end(); return }
      const url = new URL(incoming.url, `http://127.0.0.1:${server.address().port}`)
      if (url.pathname === '/api/auth/me') { outgoing.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' }); outgoing.end(JSON.stringify({ error: { message: 'No session exists in this synthetic visual fixture.' } })); return }
      const isAsset = url.pathname.startsWith('/assets/') || url.pathname === '/favicon.ico'
      if (url.pathname !== '/login' && !isAsset) { outgoing.writeHead(404); outgoing.end(); return }
      const longError = url.searchParams.get('sample') === 'error'
      const response = await serveWebUi(new Request(url, { method: incoming.method }), () => ({
        surface: 'login', realtimeEnabled: false,
        login: { audience, targetSurface: audience, username: longError ? 'synthetic-account-with-a-long-name' : '', errorMessage: longError ? (url.searchParams.get('lang') === 'ar' ? 'هذه رسالة خطأ مصطنعة طويلة لاختبار التفاف النص والمحاذاة. تعذر إكمال تسجيل الدخول، تواصل مع مدير الاستضافة إذا استمرت المشكلة.' : 'This is a long synthetic error message to exercise wrapping and alignment. Sign-in could not be completed. Contact your hosting administrator if this continues.') : undefined },
      }))
      let body = await response.text()
      if (response.headers.get('content-type')?.startsWith('text/html')) body = body.replace('<html ', '<html data-login-visual-fixture="synthetic" ').replace('<body>', '<body><div data-synthetic-watermark role="note" style="padding:6px 12px;background:#f1f3f5;color:#25313f;text-align:center;font:12px/1.5 sans-serif" dir="ltr">Synthetic login visual fixture</div>')
      outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), 'cache-control': 'no-store', 'x-visual-fixture': 'synthetic' })
      outgoing.end(incoming.method === 'HEAD' ? undefined : body)
    } catch { outgoing.writeHead(500); outgoing.end('Synthetic login fixture failed.'); }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { audience, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => { server.closeIdleConnections(); server.close(error => error ? reject(error) : resolve()) }) }
}

async function inspect(page) {
  return page.evaluate(async () => {
    let fontsReady = false
    await Promise.race([document.fonts.ready.then(() => { fontsReady = true }), new Promise(resolve => setTimeout(resolve, 5000))])
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const visible = element => element.checkVisibility() && !element.closest('[hidden],[inert]')
    const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
    const targets = [...document.querySelectorAll('.xp-login-shell a,.xp-login-shell button,.xp-login-shell input,.xp-login-shell summary')].filter(visible).map(element => ({ tag: element.tagName, id: element.id, text: element.tagName === 'INPUT' ? null : element.textContent.trim().slice(0, 70), ...box(element) }))
    const fields = [...document.querySelectorAll('label[for]')].filter(visible).map(label => {
      const control = document.getElementById(label.htmlFor), range = document.createRange(); range.selectNodeContents(label)
      const labelBox = range.getBoundingClientRect(), controlBox = box(control), rtl = document.documentElement.dir === 'rtl'
      return { id: label.htmlFor, label_text: label.textContent.trim(), edge_delta: Math.abs(rtl ? labelBox.right - controlBox.right : labelBox.left - controlBox.left), label_bottom: labelBox.bottom, control: controlBox, direction: getComputedStyle(control).direction, text_align: getComputedStyle(control).textAlign }
    })
    // Chromium may serialize computed colors as OKLCH. Sample its own sRGB
    // conversion rather than interpreting color-space coordinates as RGB.
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const painter = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
    const rgb = value => { painter.clearRect(0, 0, 1, 1); painter.fillStyle = value; painter.fillRect(0, 0, 1, 1); const result = [...painter.getImageData(0, 0, 1, 1).data]; return [...result.slice(0, 3), result[3] / 255] }
    const blend = (front, back) => { const alpha = front.length > 3 ? front[3] : 1; return front.slice(0, 3).map((v, i) => v * alpha + back[i] * (1 - alpha)) }
    const background = element => { const ancestry = []; for (let node = element; node; node = node.parentElement) ancestry.unshift(node); return ancestry.reduce((value, node) => blend(rgb(getComputedStyle(node).backgroundColor), value), [255, 255, 255]) }
    const luminance = values => values.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
    const contrasts = [...document.querySelectorAll('.xp-login-shell h1,.xp-login-shell h2,.xp-login-shell label,.xp-login-shell .xp-subtitle,.xp-login-shell .xp-help,.xp-login-shell .xp-login-step,.xp-login-shell .xp-brand__name,.xp-login-shell .xp-brand__sub,.xp-login-shell button,.xp-login-shell a,.xp-login-shell dt,.xp-login-shell dd,.xp-login-shell footer span,.xp-login-shell [data-auth-error]')].filter(element => visible(element) && element.textContent.trim() && !element.disabled).map(element => {
      const style = getComputedStyle(element), bg = background(element), fg = blend(rgb(style.color), bg), a = luminance(bg), b = luminance(fg), size = parseFloat(style.fontSize), large = size >= 24 || size >= 18.66 && Number(style.fontWeight) >= 700
      return { selector: element.id || element.className || element.tagName, text: element.textContent.trim().slice(0, 70), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), required: large ? 3 : 4.5, foreground: style.color, background: bg }
    })
    const faces = [...document.fonts].map(face => ({ family: face.family, status: face.status }))
    const definitions = [...document.querySelectorAll('.xp-login-dl dt')].filter(visible).map(label => { const value = label.nextElementSibling, lr = document.createRange(), vr = document.createRange(); lr.selectNodeContents(label); vr.selectNodeContents(value); const a = lr.getBoundingClientRect(), b = vr.getBoundingClientRect(); return { label: label.textContent.trim(), edge_delta: Math.abs(document.documentElement.dir === 'rtl' ? a.right - b.right : a.left - b.left), below: b.top >= a.bottom - 1 } })
    const submit = document.querySelector('[data-auth-submit]'), submitBox = box(submit)
    return { width: innerWidth, viewport_height: innerHeight, submit: { ...submitBox, fits_first_viewport: submitBox.bottom <= innerHeight }, scroll_width: document.documentElement.scrollWidth, direction: document.documentElement.dir, eastern_digits: /[\u0660-\u0669\u06f0-\u06f9]/.test(document.body.innerText), targets, fields, definitions, contrasts,
      fonts: { ready: fontsReady, status: document.fonts.status, body_family: getComputedStyle(document.body).fontFamily, faces, loaded_faces: faces.filter(face => face.status === 'loaded'), failed_faces: faces.filter(face => face.status === 'error') } }
  })
}

async function inspectNativeInputEdges(page, ids) {
  const labels = await page.evaluate(ids => ids.map(id => {
    const input = document.getElementById(id), label = document.querySelector('label[for="' + id + '"]')
    if (!input || !label || !input.value || !input.checkVisibility() || !label.checkVisibility() || !label.textContent.trim()) return { id, missing: true }
    const range = document.createRange(); range.selectNodeContents(label)
    const labelBox = range.getBoundingClientRect(), control = input.getBoundingClientRect(), rtl = document.documentElement.dir === 'rtl'
    return { id, missing: false, label_edge: rtl ? labelBox.right : labelBox.left, label_bottom: labelBox.bottom, control_top: control.top, rtl }
  }), ids)
  const cdp = await page.context().newCDPSession(page)
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
    const descend = node => [node, ...(node.children ?? []).flatMap(descend), ...(node.shadowRoots ?? []).flatMap(descend)]
    const nodes = descend(root)
    for (const field of labels) {
      assert.equal(field.missing, false, 'A native input measurement requires a nonempty visible value and label')
      const inputs = nodes.filter(node => node.nodeName === 'INPUT' && node.attributes?.some((value, index, attrs) => value === 'id' && attrs[index + 1] === field.id))
      assert.equal(inputs.length, 1, 'Resolve exactly one native input by its explicit ID')
      const text = (inputs[0].shadowRoots ?? []).flatMap(descend).filter(node => node.nodeType === 3 && node.nodeValue.length > 0)
      assert.equal(text.length, 1, 'Measure the actual native input value text, never a mirrored element')
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: text[0].backendNodeId })
      const measured = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { const range = document.createRange(); range.selectNodeContents(this); const box = range.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, length: this.textContent.length } }', returnByValue: true })
      assert.ok(!measured.exceptionDetails && measured.result.value?.width > 0 && measured.result.value.length > 0, 'Chromium must expose a nonempty native rendered value Range')
      field.value_range = measured.result.value
      field.value_edge = field.rtl ? field.value_range.right : field.value_range.left
      field.edge_delta = Math.abs(field.label_edge - field.value_edge)
      field.edge_basis = 'actual-native-input-text-range'
      assert.ok(field.edge_delta <= 1, 'The actual filled native input value shares its label text edge within 1px')
      assert.ok(field.value_range.top >= field.label_bottom - 1, 'The actual value lies below its label')
    }
  } finally { await cdp.detach() }
  return labels
}

export async function runLoginSurfaceAcceptance({ output } = {}) {
  assert.equal(process.versions.node, readFileSync(join(root, '.node-version'), 'utf8').trim(), 'Use the pinned workspace runtime.')
  const destination = resolve(output ?? join(root, 'test-results/login-surfaces', `run-${Date.now()}`))
  if (existsSync(destination)) throw new Error('Refusing to overwrite visual evidence.')
  mkdirSync(join(destination, 'screenshots'), { recursive: true })
  const before = fingerprint(), outcomes = [], started = Date.now()
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(root, '.tools/playwright-browsers')
  const { chromium, expect } = await import('@playwright/test')
  const fixtures = await Promise.all(Object.keys(audiences).map(createLoginFixture))
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() })
  try {
    for (const state of matrix) {
      const outcome = { ...state, synthetic: true, status: 'running', page_errors: [], console_errors: [], failed_requests: [], mutations: [], observations: [] }
      const context = await browser.newContext({ viewport: { width: state.width, height: state.width === 1440 ? 900 : state.width === 768 ? 1024 : state.width === 320 ? 740 : 800 }, colorScheme: state.theme, reducedMotion: 'reduce' })
      const page = await context.newPage(); page.setDefaultTimeout(6000)
      page.on('pageerror', error => outcome.page_errors.push(String(error.message)))
      page.on('console', message => { if (message.type() === 'error') outcome.console_errors.push({ text: message.text(), url: message.location().url }) })
      page.on('requestfailed', request => outcome.failed_requests.push({ url: request.url(), error: request.failure()?.errorText }))
      await context.route('**/*', route => { if (!['GET', 'HEAD'].includes(route.request().method())) { outcome.mutations.push(route.request().method()); return route.abort() } return route.continue() })
      try {
        const fixture = fixtures.find(value => value.audience === state.audience)
        const url = `${fixture.baseUrl}/login?lang=${state.locale}&theme=${state.theme}&target=${state.audience === 'xwhm' ? 'xmail' : 'xwhm'}`
        assert.equal((await page.goto(url, { waitUntil: 'domcontentloaded' })).status(), 200)
        await expect(page.locator('[data-login-audience]')).toHaveAttribute('data-login-audience', state.audience)
        await expect(page.locator('html')).toHaveAttribute('data-login-visual-fixture', 'synthetic')
        assert.equal(await page.locator('h1').count(), 1)
        await expect(page.locator('h1')).toHaveText(headings[state.audience][state.locale])
        await expect(page).toHaveTitle(audiences[state.audience] + ' — ' + headings[state.audience][state.locale])
        await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/assets/favicon-' + state.audience + '.svg')
        assert.equal(await page.getByRole('main').count(), 1)
        await expect(page.getByRole('main')).toHaveAccessibleName(headings[state.audience][state.locale])
        await expect(page.getByRole('form')).toHaveAccessibleName(headings[state.audience][state.locale])
        await expect(page.locator('.xp-brand__name')).toHaveText(audiences[state.audience])
        assert.equal(await page.locator('.xp-login-aside,.xp-login-context,.xp-login-footer').count(), 0, 'Dedicated sign-in must stay a functional form without marketing panels or footer prose')
        await expect(page.locator('[data-auth-submit]')).toBeEnabled()
        outcome.metrics = await inspect(page)
        outcome.screenshot = `screenshots/${state.id}.png`
        await page.screenshot({ path: join(destination, outcome.screenshot), fullPage: true })
        const metrics = outcome.metrics
        assert.ok(metrics.scroll_width <= state.width + 1, 'No horizontal overflow')
        assert.ok(metrics.submit.fits_first_viewport, 'Essential sign-in form must fit the first viewport')
        assert.equal(metrics.eastern_digits, false, 'Visible digits must be ASCII')
        assert.ok(metrics.targets.every(target => target.width >= 43.5 && target.height >= 43.5), 'All visible controls need 44px targets')
        assert.ok(metrics.fields.length >= 2 && metrics.fields.every(field => field.label_text && field.control.top >= field.label_bottom - 1 && field.control.height >= 48), 'Nonempty labels remain directly above 48px inputs; filled text edges are measured independently')
        assert.ok(metrics.definitions.every(field => field.edge_delta <= 1 && field.below), 'Context values must align directly below their labels')
        assert.ok(metrics.contrasts.every(item => item.ratio + 0.02 >= item.required), 'Semantic text contrast must meet AA ratios')
        assert.equal(metrics.fonts.ready, true, 'Fonts must settle within 5 seconds')
        assert.ok(metrics.fonts.loaded_faces.length > 0, 'Downloadable font faces must actually load')
        assert.equal(metrics.fonts.failed_faces.length, 0)
        assert.ok(metrics.fonts.loaded_faces.some(face => face.family.includes(state.locale === 'ar' ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans')), 'The locale font must actually load')
        metrics.fonts.applied_roles = {}
        for (const [role, selector, family, typographyRole] of [['brand', '.xp-brand__name', 'IBM Plex Mono', 'login-wordmark'], ['heading', '.xp-login-shell h1', state.locale === 'ar' ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans', 'ordinary']]) {
          try { metrics.fonts.applied_roles[role] = await assertAppliedFont(page, selector, family, { role: typographyRole }) }
          catch (error) { if (error.appliedFontObservation) metrics.fonts.applied_roles[role] = error.appliedFontObservation; throw error }
        }
        const password = page.locator('#login-password')
        await page.locator('#login-username').fill('synthetic_123')
        await password.fill('Synthetic123!')
        await page.locator('[data-action="toggle-password"]').click()
        await expect(password).toHaveAttribute('type', 'text')
        outcome.metrics.native_value_edges = await inspectNativeInputEdges(page, ['login-username', 'login-password'])
        assert.equal(outcome.metrics.native_value_edges.length, 2)
        outcome.filled_screenshot = `screenshots/${state.id}-filled.png`
        await page.screenshot({ path: join(destination, outcome.filled_screenshot), fullPage: true })
        await page.locator('[data-action="toggle-password"]').click()
        await expect(password).toHaveAttribute('type', 'password')
        const syntheticValue = 'Synthetic visual password 123!'
        await password.fill(syntheticValue)
        await page.locator('#login-username').focus(); await page.keyboard.press('Tab'); await expect(password).toBeFocused()
        await password.evaluate(input => input.setSelectionRange(2, 8, 'forward'))
        await page.keyboard.press('Tab'); const toggle = page.locator('[data-action="toggle-password"]'); await expect(toggle).toBeFocused()
        const eyeGeometry = await toggle.evaluate(button => {
          const input = document.getElementById(button.getAttribute('aria-controls')), ir = input.getBoundingClientRect(), br = button.getBoundingClientRect(), style = getComputedStyle(input)
          return { input: { left: ir.left, right: ir.right, top: ir.top, bottom: ir.bottom }, eye: { left: br.left, right: br.right, top: br.top, bottom: br.bottom, width: br.width, height: br.height }, padding_left: parseFloat(style.paddingLeft), padding_right: parseFloat(style.paddingRight), text_align: style.textAlign, resolved_text_align: style.textAlign === 'start' ? (style.direction === 'rtl' ? 'right' : 'left') : style.textAlign === 'end' ? (style.direction === 'rtl' ? 'left' : 'right') : style.textAlign, direction: style.direction }
        })
        assert.ok(eyeGeometry.eye.width >= 44 && eyeGeometry.eye.height >= 44)
        assert.ok(eyeGeometry.eye.left >= eyeGeometry.input.left && eyeGeometry.eye.right <= eyeGeometry.input.right && eyeGeometry.eye.top >= eyeGeometry.input.top && eyeGeometry.eye.bottom <= eyeGeometry.input.bottom, 'The eye target remains inside the password field')
        assert.equal(eyeGeometry.direction, 'ltr')
        assert.equal(eyeGeometry.resolved_text_align, state.locale === 'ar' ? 'right' : 'left')
        assert.ok((state.locale === 'ar' ? eyeGeometry.padding_left : eyeGeometry.padding_right) >= eyeGeometry.eye.width + 8, 'Credential text reserves the physical space occupied by the eye in either locale')
        await page.keyboard.press('Space'); await expect(password).toHaveAttribute('type', 'text'); await expect(toggle).toHaveAttribute('aria-pressed', 'true')
        await expect(toggle).toHaveAttribute('aria-label', state.locale === 'ar' ? 'إخفاء كلمة المرور' : 'Hide password')
        assert.equal(await page.locator('[data-password-show]').getAttribute('hidden'), '')
        assert.equal(await page.locator('[data-password-hide]').getAttribute('hidden'), null)
        await expect(toggle).toBeFocused()
        assert.deepEqual(await password.evaluate(input => [input.value, input.selectionStart, input.selectionEnd]), [syntheticValue, 2, 8], 'Revealing preserves the exact unsent value and caret selection')
        await page.keyboard.press('Enter'); await expect(password).toHaveAttribute('type', 'password')
        await expect(toggle).toHaveAttribute('aria-label', state.locale === 'ar' ? 'إظهار كلمة المرور' : 'Show password')
        await expect(toggle).toHaveAttribute('aria-pressed', 'false')
        assert.equal(await page.locator('[data-password-show]').getAttribute('hidden'), null)
        assert.equal(await page.locator('[data-password-hide]').getAttribute('hidden'), '')
        assert.deepEqual(await password.evaluate(input => [input.value, input.selectionStart, input.selectionEnd]), [syntheticValue, 2, 8], 'Hiding preserves the value and caret selection without submitting')
        assert.equal(await page.locator('[data-auth-status]').boundingBox(), null, 'An empty status message reserves no visual space')
        const focus = await toggle.evaluate(element => { const style = getComputedStyle(element); return { outline_width: style.outlineWidth, outline_style: style.outlineStyle } })
        assert.ok(parseFloat(focus.outline_width) >= 2 && focus.outline_style !== 'none', 'Keyboard focus must have a visible outline')
        assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true)
        const motion = await toggle.evaluate(element => { const style = getComputedStyle(element); return { transition_duration: style.transitionDuration, animation_duration: style.animationDuration } })
        assert.ok([motion.transition_duration, motion.animation_duration].every(value => value.split(',').every(duration => parseFloat(duration) <= 0.00001)), 'Reduced motion must suppress control animation and transitions')
        outcome.observations.push({ keyboard_order: true, password_toggle: true, in_field_eye: eyeGeometry, preserved_selection: true, focus, reduced_motion: true, motion, server_audience_ignores_query_target: true })
        if (state.width === 320) {
          await page.goto(`${url}&sample=error`, { waitUntil: 'domcontentloaded' })
          await expect(page.locator('[data-auth-error]')).toBeVisible()
          const errorGeometry = await page.locator('[data-auth-error]').evaluate(element => { const r = element.getBoundingClientRect(), form = document.querySelector('[data-login-form]').getBoundingClientRect(); return { bottom: r.bottom, form_top: form.top, scroll: document.documentElement.scrollWidth, viewport: innerWidth } })
          assert.ok(errorGeometry.bottom <= errorGeometry.form_top + 1 && errorGeometry.scroll <= errorGeometry.viewport + 1, 'Long error must wrap above form without horizontal overflow')
          outcome.error_screenshot = `screenshots/${state.id}-error.png`
          await page.screenshot({ path: join(destination, outcome.error_screenshot), fullPage: true })
          outcome.error_metrics = await inspect(page)
          assert.ok(outcome.error_metrics.contrasts.every(item => item.ratio + 0.02 >= item.required), 'Long error text contrast must meet AA ratios')
          outcome.observations.push({ long_error_geometry: errorGeometry })
        }
        if (state.width === 1440) {
          const language = page.locator('.xp-topbar-actions a').first(), theme = page.locator('.xp-topbar-actions a').last()
          await language.click(); await expect(page.locator('html')).toHaveAttribute('lang', state.locale === 'en' ? 'ar' : 'en'); await expect(page.locator('[data-login-audience]')).toHaveAttribute('data-login-audience', state.audience)
          await page.goBack({ waitUntil: 'domcontentloaded' }); await expect(page.locator('html')).toHaveAttribute('lang', state.locale)
          await theme.click(); await expect(page.locator('html')).toHaveAttribute('data-theme', state.theme === 'dark' ? 'light' : 'dark'); await expect(page.locator('[data-login-audience]')).toHaveAttribute('data-login-audience', state.audience)
          await page.goBack({ waitUntil: 'domcontentloaded' }); await expect(page.locator('html')).toHaveAttribute('data-theme', state.theme)
          outcome.observations.push({ language_navigation: true, theme_navigation: true, history_back_restores_context: true, listener_audience_preserved: true })
        }
        outcome.console_classification = { expected_unauthenticated_lookup: outcome.console_errors.filter(error => /\/api\/auth\/me$/.test(error.url)), external_fonts: outcome.console_errors.filter(error => /fonts\.(?:googleapis|gstatic)\.com/.test(error.url)), unexpected: outcome.console_errors.filter(error => !/\/api\/auth\/me$/.test(error.url) && !/fonts\.(?:googleapis|gstatic)\.com/.test(error.url)) }
        assert.deepEqual(outcome.console_classification.unexpected, [], 'No unexpected application console errors')
        assert.deepEqual(outcome.page_errors, [])
        assert.deepEqual(outcome.mutations, [])
        outcome.status = 'passed'
      } catch (error) { outcome.status = 'failed'; outcome.failure = { name: error.name, message: String(error.message).split('\n')[0] } }
      finally { await context.close(); outcomes.push(outcome); process.stdout.write(`${JSON.stringify({ id: state.id, status: outcome.status, failure: outcome.failure })}\n`) }
    }
  } finally { await browser.close(); await Promise.all(fixtures.map(fixture => fixture.close())) }
  const after = fingerprint(), drift = before.filter((file, index) => file.sha256 !== after[index].sha256).map(file => file.path)
  const report = { schema_version: 1, at: new Date().toISOString(), status: outcomes.every(value => value.status === 'passed') && drift.length === 0 ? 'passed' : 'failed', runtime: process.version, browser: { name: 'Chromium', version: browser.version(), headless: true }, environment: { platform: process.platform, architecture: process.arch }, duration_ms: Date.now() - started,
    scope: '60 synthetic login states: 3 server-selected audiences, 2 locales, 2 themes, 5 widths (320/360/390/768/1440). Keyboard, toggle, focus, reduced motion, geometry and actual applied custom IBM Plex Mono wordmark and proportional IBM Plex Sans/IBM Plex Sans Arabic heading glyph faces on all states; long error wrapping on all 12 narrow states.',
    fixture: { synthetic: true, listeners: 3, loopback_only: true, read_only: true, credentials_submitted: 0, live_authentication: false, tls_qualification: false, production_ports_qualification: false },
    tests: { total: outcomes.length, passed: outcomes.filter(value => value.status === 'passed').length, failed: outcomes.filter(value => value.status === 'failed').length },
    source: { before, after, drift },
    limitations: ['Loopback HTTP visual fixture; no authentication bypass, credentials, real API mutation, actual TLS or production-port isolation proof.', 'Text contrast uses actual computed flat semantic foreground/background colors; this is scoped evidence, not complete WCAG certification.', 'Screenshots do not prove parity against an unversioned design reference or performance under load.', 'External font failures are recorded and missing loaded faces fail the visual test.'], outcomes }
  writeFileSync(join(destination, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ status: report.status, tests: report.tests, source_drift: drift, evidence: destination })}\n`)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runLoginSurfaceAcceptance({ output: process.argv.find(value => value.startsWith('--output='))?.slice(9) })
  process.exitCode = report.status === 'passed' ? 0 : 1
}
