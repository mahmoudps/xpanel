import { requireBrowserDiskHeadroom } from './resource-guard.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveWebUi } from '../../apps/web/src/index.ts'
import { collectSnapshotFiles } from '../../scripts/vm/source-snapshot.mjs'
import { assertAppliedFont } from './applied-font-contract.mjs'
import { inspectNativeInputEdges } from './login-surface-acceptance.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const syntheticPassword = 'SyntheticPassword123!'
const matrix = ['en', 'ar'].flatMap(locale => [360, 1440].flatMap(width => ['login', 'security'].map(screen => ({
  id: [screen, locale, width].join('-'), locale, width, screen, height: width === 360 ? 800 : 900,
}))))
const representativePriority = ['login-ar-360', 'security-ar-360', 'login-en-360', 'security-en-360', 'login-ar-1440', 'security-ar-1440', 'login-en-1440', 'security-en-1440']
const explicitInputs = ['tests/browser/resource-guard.mjs', 'tests/browser/mfa-runtime-acceptance.mjs', 'tests/browser/login-surface-acceptance.mjs', 'tests/browser/applied-font-contract.mjs']

const fingerprint = () => {
  const files = [...new Set([...collectSnapshotFiles(root), ...explicitInputs])].sort().map(path => {
    const bytes = readFileSync(join(root, path))
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files }
}
const sourceDrift = (before, after) => {
  const left = new Map(before.files.map(file => [file.path, file.sha256]))
  const right = new Map(after.files.map(file => [file.path, file.sha256]))
  return [...new Set([...left.keys(), ...right.keys()])].sort().filter(path => left.get(path) !== right.get(path))
}
const failure = error => ({ name: error.name, message: String(error.message).split('\n')[0].slice(0, 1000) })
const markSynthetic = html => html
  .replace('<html ', '<html data-mfa-fixture="synthetic" ')
  .replace('<body>', '<body><div data-mfa-fixture-watermark role="note" dir="ltr" style="position:sticky;inset-block-start:0;z-index:2000;padding:4px 12px;text-align:center;background:#f4f6f8;color:#344054;border-block-end:1px solid #d0d5dd;font:12px/1.4 system-ui,sans-serif">Synthetic MFA UI fixture</div>')

async function createMfaFixture() {
  const observations = { login_body_keys: [], unexpected_mutations: [] }
  const principal = { kind: 'root', id: 'synthetic-mfa-root', username: 'root' }
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, 'http://127.0.0.1:' + server.address().port)
      const method = incoming.method ?? 'GET'
      outgoing.setHeader('cache-control', 'no-store')
      if (method === 'POST' && url.pathname === '/api/auth/login') {
        let body = '', bytes = 0
        for await (const chunk of incoming) {
          bytes += Buffer.byteLength(chunk)
          if (bytes > 4096) { outgoing.writeHead(413); outgoing.end(); return }
          body += chunk
        }
        const supplied = JSON.parse(body), keys = Object.keys(supplied).sort()
        observations.login_body_keys.push(keys)
        // These are fixed synthetic values; this fixture never authenticates a real identity.
        if (keys.join(',') !== 'password,username' || supplied.username !== 'root' || supplied.password !== syntheticPassword) {
          outgoing.writeHead(400, { 'content-type': 'application/json' })
          outgoing.end(JSON.stringify({ error: { message: 'Unexpected synthetic sign-in payload.' } }))
          return
        }
        outgoing.writeHead(200, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({ principal, csrfToken: 'synthetic-mfa-ui-csrf', passwordChangeRequired: false, mfaEnrollmentRequired: false, mfaMode: 'disabled', session: { mfaVerified: false } }))
        return
      }
      if (!['GET', 'HEAD'].includes(method)) {
        incoming.resume()
        observations.unexpected_mutations.push({ method, path: url.pathname })
        outgoing.writeHead(405); outgoing.end(); return
      }
      if (url.pathname === '/api/auth/me') {
        outgoing.writeHead(401, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({ error: { message: 'No real session exists in this synthetic fixture.' } }))
        return
      }
      const isAsset = url.pathname.startsWith('/assets/') || url.pathname === '/favicon.ico'
      if (!isAsset && !['/login', '/whm', '/whm/security/sign-in'].includes(url.pathname)) {
        outgoing.writeHead(404); outgoing.end(); return
      }
      const response = await serveWebUi(new Request(url, { method }), () => {
        const locale = url.searchParams.get('lang') === 'ar' ? 'ar' : 'en'
        // This is presentation data, not a process-policy or request-controlled authentication override.
        return url.pathname === '/login'
          ? { surface: 'login', locale, theme: 'light', realtimeEnabled: false, mfaRuntimeMode: 'disabled', login: { audience: 'xwhm' } }
          : { surface: 'xwhm', locale, theme: 'light', activeRoute: url.pathname, realtimeEnabled: false, mfaRuntimeMode: 'disabled', visibility: { principal }, security: { totpEnabled: true } }
      })
      const contentType = response.headers.get('content-type') ?? ''
      const body = await response.text()
      const headers = new Headers(response.headers)
      if (contentType.startsWith('text/html')) headers.delete('content-length')
      outgoing.writeHead(response.status, Object.fromEntries(headers))
      outgoing.end(method === 'HEAD' ? undefined : contentType.startsWith('text/html') ? markSynthetic(body) : body)
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'text/plain' })
      outgoing.end('Synthetic MFA fixture failed.')
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  return {
    baseUrl: 'http://127.0.0.1:' + server.address().port,
    observations,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }),
  }
}

async function geometry(page) {
  return page.evaluate(() => {
    const visible = element => element.checkVisibility() && !element.closest('[hidden],[inert]')
    const controls = [...document.querySelectorAll('button,a.xp-btn,a.xp-nav-item,summary,input:not([type="hidden"]),select,textarea')].filter(visible).map(element => {
      const rect = element.getBoundingClientRect()
      return { tag: element.tagName, id: element.id || null, width: rect.width, height: rect.height }
    })
    const fields = [...document.querySelectorAll('[data-login-form] .xp-field,.xp-account-security .xp-field')].filter(visible).flatMap(element => {
      const label = element.querySelector('label'), control = element.querySelector('input,select,textarea')
      if (!label || !control || !visible(control)) return []
      const a = label.getBoundingClientRect(), b = control.getBoundingClientRect()
      return [{ gap: b.top - a.bottom, height: b.height, label_text: label.textContent.trim() }]
    })
    const card = document.querySelector('.xp-login-card,.xp-account-security'), style = getComputedStyle(card)
    const security = document.querySelector('[data-security-page] > .xp-account-security[data-auth-state="development-disabled"]')
    let security_layout = null
    if (security) {
      const wrapper = security.parentElement
      const title = wrapper.querySelector(':scope > h1')
      const heading = security.querySelector(':scope > h2')
      const status = security.querySelector(':scope > p[role="status"]')
      if (title && heading && status) {
        const rtl = document.dir === 'rtl', edge = rect => rtl ? rect.right : rect.left
        const range = element => { const value = document.createRange(); value.selectNodeContents(element); return value.getBoundingClientRect() }
        const c = security.getBoundingClientRect(), h = heading.getBoundingClientRect(), p = status.getBoundingClientRect()
        const cardStyle = getComputedStyle(security), headingStyle = getComputedStyle(heading)
        const innerEdge = rtl ? c.right - parseFloat(cardStyle.borderRightWidth) - parseFloat(cardStyle.paddingRight) : c.left + parseFloat(cardStyle.borderLeftWidth) + parseFloat(cardStyle.paddingLeft)
        const headingGlyph = edge(range(heading)), statusGlyph = edge(range(status))
        security_layout = {
          page_to_card: c.top - title.getBoundingClientRect().bottom,
          heading_to_status: p.top - h.bottom,
          heading_status_glyph_delta: Math.abs(headingGlyph - statusGlyph),
          heading_content_glyph_delta: Math.abs(headingGlyph - innerEdge),
          status_content_glyph_delta: Math.abs(statusGlyph - innerEdge),
          heading_padding_inline_start: parseFloat(headingStyle.paddingInlineStart), heading_padding_inline_end: parseFloat(headingStyle.paddingInlineEnd),
          wrapper_row_gap: parseFloat(getComputedStyle(wrapper).rowGap), status_text_length: status.textContent.trim().length,
        }
      }
    }
    return {
      viewport: innerWidth, scroll_width: document.documentElement.scrollWidth, ascii: !/[\u0660-\u0669\u06f0-\u06f9]/.test(document.body.innerText),
      controls, fields, padding_top: parseFloat(style.paddingTop), padding_inline: parseFloat(style.paddingInlineStart), row_gap: parseFloat(style.rowGap),
      security_layout,
      submit_bottom: document.querySelector('[data-auth-submit]')?.getBoundingClientRect().bottom ?? null, height: innerHeight,
    }
  })
}

export async function runMfaRuntimeAcceptance({ output, screenshotBudget = 8 } = {}) {
  assert.equal(process.versions.node, readFileSync(join(root, '.node-version'), 'utf8').trim(), 'Use the pinned workspace runtime.')
  assert.ok(Number.isInteger(screenshotBudget) && screenshotBudget >= 0 && screenshotBudget <= 8, 'Screenshot budget must be an integer from 0 through 8.')
  requireBrowserDiskHeadroom(root, 384)
  const destination = resolve(output ?? join(root, 'test-results/mfa-runtime', 'run-' + Date.now()))
  if (existsSync(destination)) throw new Error('Refusing to overwrite browser evidence.')
  mkdirSync(join(destination, 'screenshots'), { recursive: true })
  const before = fingerprint(), started = Date.now(), outcomes = []
  const representatives = new Set(representativePriority.slice(0, screenshotBudget))
  let screenshots = 0, fixture, browser, version = null, fatal = null
  const capture = async (page, row, stage) => {
    if (!page || row.screenshot_attempted || screenshots >= screenshotBudget || (row.status !== 'failed' && !representatives.has(row.id))) return
    // Representative and failure evidence share this one run-wide budget and one attempt per state.
    screenshots++
    row.screenshot_attempted = true
    const filename = row.id + (row.status === 'failed' ? '-failure' : '') + '.png'
    try {
      await page.screenshot({ path: join(destination, 'screenshots', filename), fullPage: true, timeout: 10000 })
      row.screenshot = 'screenshots/' + filename
      row.screenshot_stage = stage
    } catch (error) {
      row.screenshot_failure = failure(error)
      if (row.status !== 'failed') { row.status = 'failed'; row.failure = failure(error) }
    }
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(root, '.tools/playwright-browsers')
  try {
    const { chromium, expect } = await import('@playwright/test')
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? chromium.executablePath() })
    version = browser.version()
    fixture = await createMfaFixture()
    for (const state of matrix) {
        requireBrowserDiskHeadroom(root, 256, destination)
      const row = { ...state, synthetic: true, status: 'running', page_errors: [], console_errors: [], failed_requests: [], websockets: [] }
      let context, page
      const initialPosts = fixture.observations.login_body_keys.length
      try {
        context = await browser.newContext({ viewport: { width: state.width, height: state.height }, colorScheme: 'light', reducedMotion: 'reduce' })
        page = await context.newPage()
        page.setDefaultTimeout(8000)
        page.on('pageerror', error => row.page_errors.push(String(error.message).slice(0, 240)))
        page.on('console', message => { if (message.type() === 'error') row.console_errors.push({ text: message.text().slice(0, 240), url: message.location().url }) })
        page.on('requestfailed', request => row.failed_requests.push({ url: request.url(), error: request.failure()?.errorText ?? null }))
        page.on('websocket', () => row.websockets.push('attempted'))
        const url = fixture.baseUrl + (state.screen === 'login' ? '/login' : '/whm/security/sign-in') + '?lang=' + state.locale
        assert.equal((await page.goto(url, { waitUntil: 'networkidle' })).status(), 200)
        await expect(page.locator('html')).toHaveAttribute('data-mfa-fixture', 'synthetic')
        await expect(page.locator('[data-mfa-fixture-watermark]')).toBeVisible()
        await expect(page.locator('html')).toHaveAttribute('lang', state.locale)
        await expect(page.locator('html')).toHaveAttribute('dir', state.locale === 'ar' ? 'rtl' : 'ltr')
        await expect(page.locator('html')).toHaveAttribute('data-mfa-mode', 'disabled')
        await expect(page.locator('html')).toHaveAttribute('data-realtime-enabled', 'false')
        assert.equal(await page.locator('h1').count(), 1)
        assert.equal(await page.locator('[data-mfa-disabled]').count(), 1)
        assert.equal(await page.locator('[data-auth-setup-form],[data-auth-enroll-form],[data-auth-mfa-fields],[data-mfa-recommendation]').count(), 0)
        const fonts = await page.evaluate(async () => {
          let ready = false
          await Promise.race([document.fonts.ready.then(() => { ready = true }), new Promise(resolve => setTimeout(resolve, 5000))])
          return { ready, failed_faces: [...document.fonts].filter(face => face.status === 'error').map(face => face.family) }
        })
        assert.equal(fonts.ready, true, 'Fonts must settle within 5 seconds.')
        assert.deepEqual(fonts.failed_faces, [])
        row.fonts = fonts
        row.fonts.heading = await assertAppliedFont(page, state.screen === 'login' ? '.xp-login-shell h1' : '[data-security-page] > h1', state.locale === 'ar' ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans')
        if (state.screen === 'login') {
          row.fonts.wordmark = await assertAppliedFont(page, '.xp-brand__name', 'IBM Plex Mono', { role: 'login-wordmark' })
          await page.locator('#login-username').fill('root')
          await page.locator('#login-password').fill(syntheticPassword)
          await page.locator('#login-password').evaluate(input => input.setSelectionRange(2, 8, 'backward'))
          await page.locator('[data-action="toggle-password"]').click()
          const partial = await page.locator('#login-password').evaluate((input, expected) => ({ start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, value_unchanged: input.value === expected }), syntheticPassword)
          assert.deepEqual(partial, { start: 2, end: 8, direction: 'backward', value_unchanged: true })
          row.partial_selection = partial
          await page.locator('[data-action="toggle-password"]').click()
          await page.locator('#login-password').evaluate(input => input.setSelectionRange(input.value.length, input.value.length, 'forward'))
          await page.locator('[data-action="toggle-password"]').click()
          await expect(page.locator('#login-password')).toHaveAttribute('type', 'text')
          row.native_value_edges = await inspectNativeInputEdges(page, ['login-username', 'login-password'])
          assert.equal(row.native_value_edges.length, 2)
          assert.equal(row.native_value_edges[1].value_range.length, 21, 'The durable reveal regression must use the full long value.')
          await page.locator('#login-username').focus()
          await page.keyboard.press('Tab')
          await expect(page.locator('#login-password')).toBeFocused()
        } else {
          await expect(page.locator('[data-security-page]')).toHaveAttribute('data-tool-availability', 'unverified')
          await expect(page.locator('[data-account-security]')).toHaveAttribute('data-auth-state', 'development-disabled')
          await expect(page.locator('[data-account-security]')).toHaveAttribute('data-mfa-configured', 'true')
          assert.equal(await page.locator('[data-mfa-enabled="true"],[data-auth-recovery]').count(), 0)
        }
        row.geometry = await geometry(page)
        const metrics = row.geometry
        assert.ok(metrics.scroll_width <= state.width + 1, 'No document horizontal overflow.')
        assert.equal(metrics.ascii, true, 'Visible digits must remain ASCII.')
        assert.ok(metrics.controls.every(control => control.width >= 43.5 && control.height >= 43.5), 'Visible controls retain 44px targets.')
        const cardPadding = state.width === 360 ? 16 : 24
        assert.equal(metrics.padding_top, cardPadding)
        assert.equal(metrics.padding_inline, cardPadding)
        assert.equal(metrics.row_gap, 24, 'Card content groups retain the 24px role.')
        if (state.screen === 'security') {
          const layout = metrics.security_layout
          assert.ok(layout, 'The development-disabled security card has a real title, heading and status paragraph.')
          assert.equal(layout.wrapper_row_gap, 32)
          assert.ok(Math.abs(layout.page_to_card - 32) < 0.6, 'Actual page-title to security-section gap is 32px.')
          assert.ok(Math.abs(layout.heading_to_status - 24) < 0.6, 'Actual heading to status-content gap is 24px.')
          assert.ok(layout.status_text_length > 0)
          assert.ok(layout.heading_status_glyph_delta < 1, 'Actual heading and status text share their logical glyph edge.')
          assert.ok(layout.heading_content_glyph_delta < 1 && layout.status_content_glyph_delta < 1, 'Security text uses the card content edge without a second inset.')
          assert.equal(metrics.fields.length, 0, 'Development-disabled security does not render enrollment fields.')
        }
        if (state.screen === 'login') {
          assert.equal(metrics.fields.length, 2)
          assert.ok(metrics.fields.every(field => field.label_text && Math.abs(field.gap - 8) <= 1 && field.height >= 48), 'Two labeled 48px inputs retain 8px label gaps.')
          assert.ok(metrics.submit_bottom <= metrics.height, 'The essential sign-in form fits the first viewport.')
          await capture(page, row, 'filled-login-before-synthetic-submission')
          if (row.screenshot_failure) throw new Error('The representative sign-in screenshot could not be written.')
          await page.locator('[data-auth-submit]').click()
          await page.waitForURL(url => url.pathname === '/whm')
          assert.equal(fixture.observations.login_body_keys.length, initialPosts + 1)
          assert.deepEqual(fixture.observations.login_body_keys.at(-1), ['password', 'username'], 'Disabled-mode UI submits no factor or recovery code.')
          row.password_only_submission = true
        } else assert.equal(fixture.observations.login_body_keys.length, initialPosts)
        row.console_classification = {
          expected_unauthenticated_lookup: row.console_errors.filter(error => /\/api\/auth\/me$/.test(error.url)),
          external_fonts: row.console_errors.filter(error => /fonts\.(?:googleapis|gstatic)\.com/.test(error.url) || /fonts\.(?:googleapis|gstatic)\.com/.test(error.text)),
          unexpected: row.console_errors.filter(error => !/\/api\/auth\/me$/.test(error.url) && !/fonts\.(?:googleapis|gstatic)\.com/.test(error.url) && !/fonts\.(?:googleapis|gstatic)\.com/.test(error.text)),
        }
        assert.deepEqual(row.console_classification.unexpected, [])
        assert.deepEqual(row.page_errors, [])
        assert.deepEqual(row.websockets, [], 'An unqualified synthetic document must not open a realtime connection.')
        assert.deepEqual(fixture.observations.unexpected_mutations, [])
        row.status = 'passed'
      } catch (error) {
        row.status = 'failed'
        row.failure = failure(error)
        if (error.appliedFontObservation) row.applied_font_failure = error.appliedFontObservation
      }
      finally {
        await capture(page, row, row.status === 'failed' ? 'failure' : 'rendered-security')
        try { await context?.close() } catch (error) { row.status = 'failed'; row.cleanup_failure = failure(error) }
        outcomes.push(row)
        writeFileSync(join(destination, 'results.partial.json'), JSON.stringify(outcomes, null, 2) + '\n')
        process.stdout.write(JSON.stringify({ id: state.id, status: row.status, failure: row.failure }) + '\n')
      }
    }
  } catch (error) { fatal = failure(error) }
  finally {
    const cleanup = await Promise.allSettled([Promise.resolve().then(() => browser?.close()), Promise.resolve().then(() => fixture?.close())])
    const rejected = cleanup.find(result => result.status === 'rejected')
    if (!fatal && rejected) fatal = failure(rejected.reason)
  }
  const after = fingerprint(), drift = sourceDrift(before, after)
  const report = {
    schema_version: 1, at: new Date().toISOString(), runtime: process.version, browser: { name: 'Chromium', version, headless: true },
    status: !fatal && outcomes.length === matrix.length && outcomes.every(row => row.status === 'passed') && drift.length === 0 ? 'passed' : 'failed',
    duration_ms: Date.now() - started, fatal,
    scope: '8 synthetic development-disabled UI states: EN/AR, 360/1440, sign-in and unqualified account-security documents. Native 21-character reveal and backward partial selection, strict applied fonts, keyboard, layout and password-only synthetic submission.',
    fixture: { synthetic: true, loopback_only: true, runtime_factors_read: 0, real_authentication: false, real_api_mutations: 0, authentication_provider_calls: 0, mail_provider_calls: 0, external_public_fonts: true, tls_qualification: false, production_ports_qualification: false },
    tests: { expected: matrix.length, total: outcomes.length, passed: outcomes.filter(row => row.status === 'passed').length, failed: outcomes.filter(row => row.status === 'failed').length },
    screenshots: { budget: screenshotBudget, attempts: screenshots, written: outcomes.filter(row => row.screenshot).length, maximum: 8, shared_representative_and_failure_counter: true },
    source: { before, after, drift, explicit_test_inputs: explicitInputs },
    limitations: ['Presentation fixture only; runtime policy, password, session, CSRF, factor persistence and real WebSocket authority require independent API tests.', 'No factors, recovery material, provider, authenticated mailbox, native hosting or production service are accessed.', 'The existing 60-state optional login gate remains separate and is not repeated here.', 'A coordinator may lower --screenshot-budget to allocate a shared evidence budget; failed geometry or font assertions are never waived.'],
    outcomes,
  }
  writeFileSync(join(destination, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ status: report.status, tests: report.tests, source_drift: drift, screenshots: report.screenshots, evidence: destination }) + '\n')
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  assert.ok(args.every(arg => arg.startsWith('--output=') || arg.startsWith('--screenshot-budget=')), 'Unknown MFA runner argument.')
  const outputs = args.filter(arg => arg.startsWith('--output=')), budgets = args.filter(arg => arg.startsWith('--screenshot-budget='))
  assert.ok(outputs.length <= 1 && budgets.length <= 1, 'Output and screenshot budget must each be specified at most once.')
  const budget = budgets[0]?.slice('--screenshot-budget='.length) ?? '8'
  assert.match(budget, /^[0-8]$/, 'Screenshot budget must be 0 through 8.')
  const report = await runMfaRuntimeAcceptance({ output: outputs[0]?.slice('--output='.length), screenshotBudget: Number(budget) })
  process.exitCode = report.status === 'passed' ? 0 : 1
}
